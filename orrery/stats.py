"""orrery.stats — statistical testing. The methodological heart of the project.

A pattern is only interesting if it occurs at the events *more than it would by
chance*. This module makes the "by chance" half a first-class citizen:

* :func:`monte_carlo_test` — compares a pattern's frequency at an event set
  against its frequency across N random control date sets matched to the same
  time span, returning an empirical p-value and the full null distribution.
* :func:`schuster_test` — the classic test for clustering of circular phase
  data (e.g. "do events cluster at one phase of a cycle?").
* :class:`MultipleComparisons` — tracks how many tests were run and reports
  Bonferroni- and FDR-corrected significance. Every result carries the
  comparison count so an uncorrected p-value is hard to quote by accident.
* :func:`aspect_duty_cycle` / :func:`assess_shared_aspects` — the *analytic*
  base rate. Planetary motion is deterministic, so the fraction of time an
  aspect holds over a span is computable exactly by a dense ephemeris scan (no
  sampling). That duty cycle is the uniform-null Monte-Carlo answer in the
  infinite-sample limit; feeding it to an exact binomial test tells you how
  surprising it is that *k of n* events share the aspect.

Patterns are **vectorized**: a pattern is a callable taking a Skyfield ``Time``
array and returning a boolean numpy array. This lets the Monte-Carlo evaluate
millions of control dates quickly. :func:`aspect_pattern` builds one from the
aspect engine.

When to use which base rate: the **duty cycle** (analytic) is exact for the
plain uniform null and should be preferred there. **Monte-Carlo** is for nulls
the duty cycle can't express — controls matched on season, solar-cycle phase,
or other confounds.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from orrery.astro import AstroEngine


# ---------------------------------------------------------------------------
# Pattern builders (vectorized: Time array -> bool array)
# ---------------------------------------------------------------------------


def aspect_pattern(
    astro: AstroEngine,
    body_a: str,
    body_b: str,
    angle: float,
    max_orb: float,
    vertices=("earth",),
):
    """A pattern: True when `body_a`/`body_b` are within `max_orb` of `angle`.

    If several `vertices` are given the pattern is True when it holds at *any*
    of them (the multi-vertex "at any corner" reading). Returns a vectorized
    callable ``f(times) -> bool array``.
    """
    folded = abs(angle) % 360.0
    folded = folded if folded <= 180.0 else 360.0 - folded

    def pattern(times):
        hit = None
        for v in vertices:
            la = astro.longitudes(body_a, times, v)
            lb = astro.longitudes(body_b, times, v)
            d = np.abs(la - lb) % 360.0
            sep = np.where(d <= 180.0, d, 360.0 - d)
            within = np.abs(sep - folded) <= max_orb
            hit = within if hit is None else (hit | within)
        return np.atleast_1d(hit)

    return pattern


# ---------------------------------------------------------------------------
# Monte-Carlo control test
# ---------------------------------------------------------------------------


@dataclass
class MonteCarloResult:
    label: str
    n_events: int
    observed_count: int
    observed_freq: float
    n_controls: int
    control_freq_mean: float
    control_freq_std: float
    p_value: float
    null_distribution: np.ndarray = field(repr=False)
    strategy: str = "uniform"
    # filled in when registered with a MultipleComparisons accumulator:
    n_comparisons: int | None = None
    p_corrected: float | None = None
    correction: str | None = None

    def __str__(self) -> str:
        base = (
            f"[{self.label}] observed {self.observed_count}/{self.n_events} "
            f"({self.observed_freq:.3f}) vs control mean "
            f"{self.control_freq_mean:.3f} | p={self.p_value:.4g} "
            f"(empirical, {self.n_controls} controls, {self.strategy})"
        )
        if self.n_comparisons is None:
            return (
                base
                + "  ⚠ UNCORRECTED — this p-value ignores how many patterns you "
                "tested. Register results with MultipleComparisons before "
                "reporting."
            )
        return (
            base
            + f"  | {self.correction}-corrected p={self.p_corrected:.4g} "
            f"across {self.n_comparisons} comparisons"
        )


def _control_tts(rng, event_tt, n_controls, strategy, astro):
    """Return an (n_controls, k) array of control TT Julian dates."""
    k = event_tt.size
    lo, hi = float(event_tt.min()), float(event_tt.max())
    if strategy == "uniform":
        return rng.uniform(lo, hi, size=(n_controls, k))
    if strategy == "matched_doy":
        # Keep each event's day-of-year; randomize the year within the span.
        ts = astro.ts
        cal = ts.tt_jd(event_tt).utc  # (year, month, day, hour, minute, second)
        years = np.array(cal[0])
        if years.min() < 1:
            raise ValueError("matched_doy is only supported for CE (year >= 1) events")
        yr_lo, yr_hi = int(years.min()), int(years.max())
        out = np.empty((n_controls, k))
        for j in range(k):
            ys = rng.integers(yr_lo, yr_hi + 1, size=n_controls)
            out[:, j] = ts.utc(
                ys, int(cal[1][j]), int(cal[2][j]), int(cal[3][j]), int(cal[4][j])
            ).tt
        return out
    raise ValueError(f"unknown strategy {strategy!r}")


def monte_carlo_test(
    pattern,
    event_times,
    astro: AstroEngine,
    n_controls: int = 10_000,
    strategy: str = "uniform",
    seed: int | None = None,
    label: str = "pattern",
) -> MonteCarloResult:
    """Empirical test of a pattern's frequency at events vs random controls.

    `pattern` is a vectorized callable (Time array -> bool array). `event_times`
    is a list of datetimes / Skyfield Times. Each of `n_controls` trials draws a
    control set the same size as the events, matched to the event span; the
    null distribution is the per-trial pattern frequency. The one-sided p-value
    is ``(#controls with freq >= observed + 1) / (n_controls + 1)``.
    """
    ts = astro.ts
    event_tt = np.array([astro.time(t).tt for t in event_times], dtype=float)
    k = event_tt.size
    if k == 0:
        raise ValueError("need at least one event")

    observed_hits = np.asarray(pattern(ts.tt_jd(event_tt)), dtype=bool)
    observed_count = int(observed_hits.sum())
    observed_freq = observed_count / k

    rng = np.random.default_rng(seed)
    control_tt = _control_tts(rng, event_tt, n_controls, strategy, astro)
    flat_hits = np.asarray(pattern(ts.tt_jd(control_tt.ravel())), dtype=bool)
    null = flat_hits.reshape(n_controls, k).mean(axis=1)

    p_value = (np.sum(null >= observed_freq) + 1) / (n_controls + 1)
    return MonteCarloResult(
        label=label,
        n_events=k,
        observed_count=observed_count,
        observed_freq=observed_freq,
        n_controls=n_controls,
        control_freq_mean=float(null.mean()),
        control_freq_std=float(null.std()),
        p_value=float(p_value),
        null_distribution=null,
        strategy=strategy,
    )


# ---------------------------------------------------------------------------
# Schuster's test (clustering of circular phase data)
# ---------------------------------------------------------------------------


@dataclass
class SchusterResult:
    n: int
    resultant_length: float  # R = |sum of unit vectors|
    mean_resultant: float  # R / n, in [0, 1]
    mean_angle: float  # degrees
    p_value: float

    def __str__(self) -> str:
        return (
            f"Schuster: n={self.n}, mean angle {self.mean_angle:.1f}°, "
            f"R̄={self.mean_resultant:.3f}, p={self.p_value:.4g}"
        )


def schuster_test(phases_deg) -> SchusterResult:
    """Test whether circular phases cluster (vs uniform around the circle).

    Schuster's test: for n unit vectors at the given phase angles, the
    probability under uniformity of a resultant length ≥ R is ``exp(-R²/n)``.
    Small p ⇒ significant clustering near ``mean_angle``.
    """
    a = np.radians(np.asarray(phases_deg, dtype=float))
    n = a.size
    if n == 0:
        raise ValueError("need at least one phase")
    C, S = np.cos(a).sum(), np.sin(a).sum()
    R = float(np.hypot(C, S))
    p = float(np.exp(-(R**2) / n))
    mean_angle = float(np.degrees(np.arctan2(S, C)) % 360.0)
    return SchusterResult(
        n=int(n),
        resultant_length=R,
        mean_resultant=R / n,
        mean_angle=mean_angle,
        p_value=p,
    )


# ---------------------------------------------------------------------------
# Multiple-comparison accounting
# ---------------------------------------------------------------------------


@dataclass
class CorrectedResult:
    label: str
    p_value: float
    bonferroni_p: float
    bonferroni_significant: bool
    fdr_q: float
    fdr_significant: bool


class MultipleComparisons:
    """Accumulates every test run, then reports corrected significance.

    The point is to make the comparison count impossible to ignore: scanning
    many patterns and quoting the one raw p-value that came out small is exactly
    the error this guards against.
    """

    def __init__(self, alpha: float = 0.05):
        self.alpha = alpha
        self._labels: list[str] = []
        self._pvalues: list[float] = []
        self._results: list[object] = []

    def add(self, label: str, p_value: float):
        self._labels.append(label)
        self._pvalues.append(float(p_value))
        return self

    def register(self, result: MonteCarloResult):
        """Register a MonteCarloResult; its label and p-value are tracked."""
        self.add(result.label, result.p_value)
        self._results.append(result)
        return self

    @property
    def n(self) -> int:
        return len(self._pvalues)

    def results(self) -> list[CorrectedResult]:
        """Bonferroni and Benjamini-Hochberg (FDR) corrected results."""
        m = self.n
        if m == 0:
            return []
        p = np.array(self._pvalues)
        # Bonferroni
        bonf_p = np.minimum(p * m, 1.0)
        bonf_sig = p < (self.alpha / m)
        # Benjamini-Hochberg FDR
        order = np.argsort(p)
        ranks = np.empty(m, dtype=int)
        ranks[order] = np.arange(1, m + 1)
        q_raw = p * m / ranks
        # enforce monotonic q over increasing p, then clip to 1
        q_sorted = q_raw[order]
        q_mono = np.minimum.accumulate(q_sorted[::-1])[::-1]
        q = np.empty(m)
        q[order] = np.minimum(q_mono, 1.0)
        fdr_sig = q <= self.alpha

        out = []
        for i in range(m):
            out.append(
                CorrectedResult(
                    label=self._labels[i],
                    p_value=float(p[i]),
                    bonferroni_p=float(bonf_p[i]),
                    bonferroni_significant=bool(bonf_sig[i]),
                    fdr_q=float(q[i]),
                    fdr_significant=bool(fdr_sig[i]),
                )
            )
        # back-fill correction info onto any registered MonteCarloResults
        by_label = {r.label: r for r in out}
        for res in self._results:
            cr = by_label.get(res.label)
            if cr is not None:
                res.n_comparisons = m
                res.p_corrected = cr.fdr_q
                res.correction = "FDR"
        return out

    def summary(self) -> str:
        m = self.n
        lines = [
            f"Multiple-comparison report — {m} comparison(s) run, α={self.alpha}",
            "(Bonferroni controls any false positive; FDR controls the false "
            "discovery rate.)",
        ]
        for r in sorted(self.results(), key=lambda x: x.p_value):
            flag = (
                "FDR+BONF" if r.bonferroni_significant
                else "FDR" if r.fdr_significant
                else "—"
            )
            lines.append(
                f"  {r.label:<32} p={r.p_value:.4g}  "
                f"bonf={r.bonferroni_p:.4g}  fdr_q={r.fdr_q:.4g}  [{flag}]"
            )
        return "\n".join(lines)


# ---------------------------------------------------------------------------
# Analytic base rate: duty cycle + exact binomial bridge
# ---------------------------------------------------------------------------

# Scan step (days) coarse enough to be fast yet fine enough to resolve the
# fastest body's transits through an orb window. Used when none is given.
_BODY_STEP_DAYS = {
    "moon": 0.02, "mercury": 0.2, "venus": 0.2, "sun": 0.2, "mars": 0.2,
    "earth": 0.2, "jupiter": 1.0, "saturn": 1.0, "uranus": 2.0,
    "neptune": 2.0, "pluto": 2.0,
    "north_node": 1.0, "south_node": 1.0, "mean_node": 1.0,
}


def _recommend_step(bodies) -> float:
    return min(_BODY_STEP_DAYS.get(b, 1.0) for b in bodies)


def _tt(astro: AstroEngine, x) -> float:
    if isinstance(x, (int, np.integer)) and not isinstance(x, bool):
        return float(astro.ts.utc(int(x), 1, 1).tt)
    return float(astro.time(x).tt)


@dataclass
class DutyCycle:
    """The fraction of time an aspect (or pattern) holds over a span."""

    fraction: float  # base rate: P(a uniformly random instant satisfies it)
    n_samples: int
    n_hits: int
    step_days: float
    span_days: float

    def __str__(self) -> str:
        return (
            f"duty cycle {self.fraction:.4%} "
            f"({self.n_hits}/{self.n_samples} samples @ {self.step_days}d over "
            f"{self.span_days / 365.25:.0f} yr)"
        )


def aspect_duty_cycles(
    astro: AstroEngine,
    specs,
    start,
    end,
    vertex: str = "earth",
    step_days: float | None = None,
    chunk_size: int = 1_000_000,
) -> dict:
    """Duty cycle of each aspect in `specs` over [start, end], in one scan.

    `specs` is a list of (body_a, body_b, aspect_name, angle, orb). All aspects
    are evaluated in the same chunked pass, so cost scales with the number of
    distinct bodies, not the number of aspects. Returns {spec: DutyCycle}.
    """
    ts = astro.ts
    specs = list(specs)
    bodies = sorted({b for (a, b, *_r) in specs} | {a for (a, b, *_r) in specs})
    if step_days is None:
        step_days = _recommend_step(bodies)
    tt0, tt1 = _tt(astro, start), _tt(astro, end)
    if tt1 <= tt0:
        raise ValueError("end must be after start")
    grid = np.arange(tt0, tt1, step_days)
    n = int(grid.size)
    hits = {spec: 0 for spec in specs}
    for i in range(0, n, chunk_size):
        chunk = grid[i : i + chunk_size]
        T = ts.tt_jd(chunk)
        lons = {b: astro.longitudes(b, T, vertex) for b in bodies}
        for spec in specs:
            a, b, _name, angle, orb = spec
            d = np.abs(lons[a] - lons[b]) % 360.0
            sep = np.where(d <= 180.0, d, 360.0 - d)
            hits[spec] += int((np.abs(sep - angle) <= orb).sum())
    return {
        spec: DutyCycle(
            fraction=hits[spec] / n if n else 0.0,
            n_samples=n,
            n_hits=hits[spec],
            step_days=step_days,
            span_days=tt1 - tt0,
        )
        for spec in specs
    }


def aspect_duty_cycle(
    astro: AstroEngine,
    body_a: str,
    body_b: str,
    angle: float,
    max_orb: float,
    start,
    end,
    vertex: str = "earth",
    step_days: float | None = None,
) -> DutyCycle:
    """The base rate of one aspect: the fraction of time it holds over a span."""
    spec = (body_a, body_b, "aspect", float(angle), float(max_orb))
    return aspect_duty_cycles(astro, [spec], start, end, vertex, step_days)[spec]


def binomial_significance(observed_count: int, n_trials: int, p: float) -> float:
    """P(X >= observed_count) for X ~ Binomial(n_trials, p). Exact, one-sided."""
    from scipy.stats import binom

    if n_trials <= 0:
        return 1.0
    p = min(max(p, 0.0), 1.0)
    return float(binom.sf(observed_count - 1, n_trials, p))


@dataclass
class SharedAspectSignificance:
    """An event-set's shared aspect, tested against its analytic base rate."""

    body_a: str
    body_b: str
    aspect: str
    n_events: int  # events that share it
    n_eligible: int  # events where it could appear (guardrail-aware)
    base_rate: float  # duty cycle (analytic P at a random instant)
    expected_events: float  # n_eligible * base_rate
    p_value: float  # binomial: P(>= n_events share it by chance)
    n_comparisons: int  # size of the realized aspect family (look-elsewhere)
    bonferroni_p: float
    fdr_q: float
    fdr_significant: bool

    def __str__(self) -> str:
        star = "  *FDR-significant" if self.fdr_significant else ""
        return (
            f"{self.body_a} {self.aspect} {self.body_b}: "
            f"{self.n_events}/{self.n_eligible} events vs base rate "
            f"{self.base_rate:.2%} (expected {self.expected_events:.2f}) | "
            f"p={self.p_value:.3g}, fdr_q={self.fdr_q:.3g} "
            f"[{self.n_comparisons} comparisons]{star}"
        )


def assess_shared_aspects(
    aspect_engine,
    events,
    start,
    end,
    vertex: str = "earth",
    bodies=None,
    exclude=("moon",),
    min_events: int = 2,
    step_days: float | None = None,
    alpha: float = 0.05,
) -> list[SharedAspectSignificance]:
    """Bridge the reverse search to its analytic base rate.

    For every aspect that appears across `events`, compute its duty cycle over
    [start, end] (the deterministic base rate) and an exact binomial p-value for
    "this many events share it by chance". The comparison count is the full
    realized aspect family (every aspect observed at least once) — the honest
    look-elsewhere denominator — and Bonferroni/FDR corrections are applied over
    it. Only aspects shared by >= `min_events` events are returned, sorted by
    p-value; the correction still reflects the whole family.
    """
    from orrery.search import shared_aspects_across_events

    astro = aspect_engine.astro
    angle_map = {at.name: at.angle for at in aspect_engine.aspects}
    orb_map = {at.name: at.orb for at in aspect_engine.aspects}

    # The realized family: every aspect that occurred in at least one event.
    family = shared_aspects_across_events(
        aspect_engine, events, vertex, bodies, exclude, min_events=1
    )
    if not family:
        return []

    specs = {
        (s.body_a, s.body_b, s.aspect): (
            s.body_a, s.body_b, s.aspect, angle_map[s.aspect], orb_map[s.aspect]
        )
        for s in family
    }
    duty = aspect_duty_cycles(astro, specs.values(), start, end, vertex, step_days)

    mc = MultipleComparisons(alpha)
    rows = []
    for s in family:
        spec = specs[(s.body_a, s.body_b, s.aspect)]
        dc = duty[spec]
        # floor a zero/under-resolved base rate so we never report p=0 from a
        # too-coarse scan; events themselves prove the aspect occurs in-span.
        p_base = dc.fraction if dc.fraction > 0 else 1.0 / max(dc.n_samples, 1)
        pval = binomial_significance(s.n_events, s.n_eligible, p_base)
        label = f"{s.body_a} {s.aspect} {s.body_b}"
        mc.add(label, pval)
        rows.append((s, dc, pval, label))

    corrected = {c.label: c for c in mc.results()}
    out = []
    for s, dc, pval, label in rows:
        if s.n_events < min_events:
            continue
        c = corrected[label]
        out.append(
            SharedAspectSignificance(
                body_a=s.body_a,
                body_b=s.body_b,
                aspect=s.aspect,
                n_events=s.n_events,
                n_eligible=s.n_eligible,
                base_rate=dc.fraction,
                expected_events=s.n_eligible * dc.fraction,
                p_value=pval,
                n_comparisons=mc.n,
                bonferroni_p=c.bonferroni_p,
                fdr_q=c.fdr_q,
                fdr_significant=c.fdr_significant,
            )
        )
    out.sort(key=lambda r: r.p_value)
    return out
