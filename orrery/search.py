"""orrery.search — configuration similarity search across history.

Given a *reference configuration* — the angular separations of a chosen set of
"priority" body pairs at some moment — this module scans a span of history and
returns the times whose configuration most closely matches.

This is the engine behind the default view's "top-10 closest historical
recurrences" feature. The orrery *rendering* of those matches is the deferred
web layer (Part 6); here we produce the data.

Notes
-----
* Matching is done on pairwise ecliptic-longitude separations, which are
  zodiac-independent — so the zodiac/ayanamsha never enter here.
* Separation space is *linear* on [0, 180], not circular: a 1° separation
  (near conjunction) and a 179° separation (near opposition) are far apart, as
  they should be. So the per-pair deviation is just ``|sep_a - sep_b|``.
* Distance between two configurations is the RMS of per-pair deviations
  (degrees): ``sqrt(mean(deviation_i**2))``. "Closest" means smallest RMS.
* Scanning is vectorized over a Skyfield ``Time`` array via
  :meth:`AstroEngine.longitudes`, so multi-century scans are fast.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from itertools import combinations

import numpy as np
from skyfield.timelib import Time

from orrery.astro import AstroEngine, ALL_BODIES, NODE_ALIASES, TRIVIAL_PAIRS
from orrery.events import Event, reliable_bodies


@dataclass(frozen=True)
class SharedAspect:
    """One aspect (body_a <aspect> body_b), optionally with its orb in degrees."""

    body_a: str
    body_b: str
    aspect: str
    orb: float | None = None

    def __str__(self) -> str:
        tail = f" (orb {self.orb:.1f}°)" if self.orb is not None else ""
        return f"{self.body_a} {self.aspect} {self.body_b}{tail}"


@dataclass(frozen=True)
class ConfigMatch:
    """One matching moment found by :func:`find_similar_configurations`."""

    time: Time
    tt: float  # Terrestrial Time Julian date
    distance: float  # RMS angular deviation from the target, degrees
    label: str  # human-readable UTC time
    separations: dict  # {(body_a, body_b): separation_degrees} at this moment


def _unique_bodies(pairs):
    seen = []
    for a, b in pairs:
        for x in (a, b):
            if x not in seen:
                seen.append(x)
    return seen


def _separation_arrays(astro, times, pairs, vertex):
    """{pair: separation array in [0,180]} for `times` (scalar or array Time)."""
    lons = {b: astro.longitudes(b, times, vertex) for b in _unique_bodies(pairs)}
    seps = {}
    for (a, b) in pairs:
        d = np.abs(lons[a] - lons[b]) % 360.0
        seps[(a, b)] = np.where(d <= 180.0, d, 360.0 - d)
    return seps


def _rms_distance(seps, target):
    """RMS over pairs of |sep - target_sep|. Broadcasts over the time axis."""
    devs = [np.atleast_1d(np.abs(seps[p] - target[p])) for p in target]
    stack = np.vstack(devs)
    return np.sqrt(np.mean(stack**2, axis=0))


def _coerce_tt(astro: AstroEngine, x) -> float:
    """Accept an int year, datetime, or Skyfield Time -> TT Julian date."""
    if isinstance(x, (int, np.integer)) and not isinstance(x, bool):
        return float(astro.ts.utc(int(x), 1, 1).tt)
    return float(astro.time(x).tt)


def configuration_vector(astro: AstroEngine, when, pairs, vertex: str = "earth") -> dict:
    """The separation of each priority pair at `when`: {(a, b): degrees}."""
    t = astro.time(when)
    seps = _separation_arrays(astro, t, pairs, vertex)
    return {p: float(np.atleast_1d(v)[0]) for p, v in seps.items()}


def find_similar_configurations(
    astro: AstroEngine,
    reference,
    pairs,
    start,
    end,
    vertex: str = "earth",
    step_days: float = 1.0,
    top_n: int = 10,
    exclude_within_days: float = 2.0,
    min_separation_days: float | None = None,
    refine: bool = True,
    refine_window_days: float | None = None,
    refine_points: int = 49,
) -> list[ConfigMatch]:
    """Find the `top_n` times in [start, end] whose configuration of `pairs`
    most closely matches the configuration at `reference`.

    `reference`, `start`, `end` may each be an int year, a datetime, or a
    Skyfield Time. `pairs` is a list of (body_a, body_b) tuples — the priority
    aspects. A coarse scan at `step_days` locates well-separated minima
    (≥ `min_separation_days` apart), each then refined to sub-step precision.
    Times within `exclude_within_days` of `reference` are excluded so the
    reference moment doesn't match itself (set to 0 to disable).
    """
    if not pairs:
        raise ValueError("at least one priority pair is required")
    ts = astro.ts
    ref_t = astro.time(reference)
    target = configuration_vector(astro, ref_t, pairs, vertex)

    tt0, tt1 = _coerce_tt(astro, start), _coerce_tt(astro, end)
    if tt1 <= tt0:
        raise ValueError("end must be after start")
    if min_separation_days is None:
        # Default to a year so the "top N" are distinct historical epochs rather
        # than many samples of the same multi-week dip. Override for fast
        # configurations that genuinely recur within a year.
        min_separation_days = 365.0
    if refine_window_days is None:
        refine_window_days = step_days

    grid = np.arange(tt0, tt1 + step_days, step_days)
    dist = _rms_distance(_separation_arrays(astro, ts.tt_jd(grid), pairs, vertex), target)
    if exclude_within_days > 0:
        dist = np.where(np.abs(grid - ref_t.tt) <= exclude_within_days, np.inf, dist)

    # Greedily pick well-separated local minima (cheap, robust dedup).
    picks: list[int] = []
    for idx in np.argsort(dist):
        if not np.isfinite(dist[idx]):
            break
        if all(abs(grid[idx] - grid[j]) >= min_separation_days for j in picks):
            picks.append(int(idx))
        if len(picks) >= top_n:
            break

    matches: list[ConfigMatch] = []
    for idx in picks:
        best_tt, best_d = float(grid[idx]), float(dist[idx])
        if refine:
            sub = np.linspace(
                grid[idx] - refine_window_days,
                grid[idx] + refine_window_days,
                refine_points,
            )
            sub = sub[(sub >= tt0) & (sub <= tt1)]
            sdist = _rms_distance(
                _separation_arrays(astro, ts.tt_jd(sub), pairs, vertex), target
            )
            if exclude_within_days > 0:
                sdist = np.where(
                    np.abs(sub - ref_t.tt) <= exclude_within_days, np.inf, sdist
                )
            k = int(np.argmin(sdist))
            best_tt, best_d = float(sub[k]), float(sdist[k])
        t_best = ts.tt_jd(best_tt)
        matches.append(
            ConfigMatch(
                time=t_best,
                tt=best_tt,
                distance=best_d,
                label=t_best.utc_strftime("%Y-%m-%d %H:%MZ"),
                separations=configuration_vector(astro, t_best, pairs, vertex),
            )
        )

    matches.sort(key=lambda m: m.distance)
    deduped: list[ConfigMatch] = []
    for m in matches:
        if all(abs(m.tt - f.tt) >= min_separation_days for f in deduped):
            deduped.append(m)
    return deduped[:top_n]


@dataclass(frozen=True)
class AspectOverlapMatch:
    """One historical moment that reproduces some of the reference aspects.

    ``matched`` is a tuple of :class:`SharedAspect` (with orb) for the reference
    aspects present here; ``missing`` is a tuple of :class:`SharedAspect` (orb
    ``None``) for those that are not.
    """

    time: Time
    tt: float
    label: str
    n_matched: int
    n_reference: int
    matched: tuple  # tuple[SharedAspect]
    missing: tuple  # tuple[SharedAspect]
    mean_orb: float  # mean orb across matched aspects (NaN if none)

    @property
    def shared_aspects(self) -> tuple:
        """The reference aspects this moment reproduces (alias of ``matched``)."""
        return self.matched

    def __str__(self) -> str:
        ms = ", ".join(str(s) for s in self.matched)
        return f"{self.label}: {self.n_matched}/{self.n_reference} aspects [{ms}]"


def reference_aspect_set(
    aspect_engine,
    when,
    vertex: str = "earth",
    bodies=None,
    exclude=("moon",),
) -> list[tuple]:
    """The aspects in play at `when`, as (body_a, body_b, aspect_name, angle).

    This is the configuration whose recurrences :func:`find_aspect_overlap`
    counts. Defaults to every aspect currently in force (Moon excluded).
    """
    kwargs = {"bodies": bodies} if bodies is not None else {}
    out = []
    for a in aspect_engine.aspects_at(when, vertex, **kwargs):
        if a.body_a in exclude or a.body_b in exclude:
            continue
        out.append((a.body_a, a.body_b, a.aspect, a.angle))
    return out


def find_aspect_overlap(
    astro: AstroEngine,
    aspect_engine,
    reference,
    start,
    end,
    vertex: str = "earth",
    bodies=None,
    exclude=("moon",),
    reference_aspects=None,
    step_days: float = 1.0,
    top_n: int = 10,
    exclude_within_days: float = 2.0,
    min_separation_days: float = 365.0,
    refine: bool = True,
    refine_window_days: float | None = None,
    refine_points: int = 49,
) -> list[AspectOverlapMatch]:
    """Find the times in [start, end] that reproduce the *most* of the
    reference aspects (same body pair, same aspect type, within the configured
    orb), ranked by match count then tightness.

    Unlike :func:`find_similar_configurations` (continuous RMS distance), this
    is the exploratory "how many of the current aspects line up here?" search:
    if no moment reproduces all of them, the best match might share 5, the next
    4, and so on down the line.
    """
    ts = astro.ts
    ref_t = astro.time(reference)
    if reference_aspects is None:
        reference_aspects = reference_aspect_set(
            aspect_engine, ref_t, vertex, bodies, exclude
        )
    if not reference_aspects:
        raise ValueError(
            "no reference aspects to match (reference sky has none, or all "
            "were excluded)"
        )
    orb_map = {at.name: at.orb for at in aspect_engine.aspects}
    n_ref = len(reference_aspects)
    body_set = _unique_bodies([(a, b) for (a, b, _n, _ang) in reference_aspects])

    tt0, tt1 = _coerce_tt(astro, start), _coerce_tt(astro, end)
    if tt1 <= tt0:
        raise ValueError("end must be after start")
    if refine_window_days is None:
        refine_window_days = step_days

    def score(times_array, tt_values):
        """(match_count, total_orb_of_matched) over a Time array."""
        lons = {b: astro.longitudes(b, times_array, vertex) for b in body_set}
        present = np.zeros((n_ref, np.size(tt_values)), dtype=bool)
        devs = np.zeros((n_ref, np.size(tt_values)))
        for i, (a, b, name, ang) in enumerate(reference_aspects):
            d = np.abs(lons[a] - lons[b]) % 360.0
            sep = np.where(d <= 180.0, d, 360.0 - d)
            dv = np.abs(sep - ang)
            present[i] = dv <= orb_map[name]
            devs[i] = dv
        count = present.sum(axis=0)
        total = np.where(present, devs, 0.0).sum(axis=0)
        if exclude_within_days > 0:
            count = count.copy()
            count[np.abs(tt_values - ref_t.tt) <= exclude_within_days] = -1
        return count, total

    grid = np.arange(tt0, tt1 + step_days, step_days)
    count, total = score(ts.tt_jd(grid), grid)

    # rank: most matches first, ties broken by tightest total orb
    order = np.lexsort((total, -count))
    picks: list[int] = []
    for idx in order:
        if count[idx] <= 0:
            break
        if all(abs(grid[idx] - grid[j]) >= min_separation_days for j in picks):
            picks.append(int(idx))
        if len(picks) >= top_n:
            break

    def detail(t_best):
        matched, missing, orbs = [], [], []
        for (a, b, name, ang) in reference_aspects:
            la = float(np.atleast_1d(astro.longitudes(a, t_best, vertex))[0])
            lb = float(np.atleast_1d(astro.longitudes(b, t_best, vertex))[0])
            d = abs(la - lb) % 360.0
            sep = d if d <= 180.0 else 360.0 - d
            dv = abs(sep - ang)
            if dv <= orb_map[name]:
                matched.append(SharedAspect(a, b, name, dv))
                orbs.append(dv)
            else:
                missing.append(SharedAspect(a, b, name))
        return matched, missing, orbs

    matches: list[AspectOverlapMatch] = []
    for idx in picks:
        best_tt = float(grid[idx])
        if refine:
            sub = np.linspace(
                grid[idx] - refine_window_days,
                grid[idx] + refine_window_days,
                refine_points,
            )
            sub = sub[(sub >= tt0) & (sub <= tt1)]
            scount, stotal = score(ts.tt_jd(sub), sub)
            best_tt = float(sub[int(np.lexsort((stotal, -scount))[0])])
        t_best = ts.tt_jd(best_tt)
        matched, missing, orbs = detail(t_best)
        matches.append(
            AspectOverlapMatch(
                time=t_best,
                tt=best_tt,
                label=t_best.utc_strftime("%Y-%m-%d %H:%MZ"),
                n_matched=len(matched),
                n_reference=n_ref,
                matched=tuple(matched),
                missing=tuple(missing),
                mean_orb=float(np.mean(orbs)) if orbs else float("nan"),
            )
        )

    matches.sort(key=lambda m: (-m.n_matched, m.mean_orb if m.n_matched else 1e9))
    deduped: list[AspectOverlapMatch] = []
    for m in matches:
        if all(abs(m.tt - f.tt) >= min_separation_days for f in deduped):
            deduped.append(m)
    return deduped[:top_n]


@dataclass(frozen=True)
class SharedAspectTally:
    """How often one aspect recurs across an event set (reverse search)."""

    body_a: str
    body_b: str
    aspect: str
    n_events: int  # events exhibiting this aspect
    n_eligible: int  # events where both bodies were usable (guardrail-aware)
    fraction: float  # n_events / n_eligible
    mean_orb: float  # mean orb across the exhibiting events
    events: tuple  # labels of the exhibiting events

    def __str__(self) -> str:
        return (
            f"{self.body_a} {self.aspect} {self.body_b}: "
            f"{self.n_events}/{self.n_eligible} events ({self.fraction:.0%}), "
            f"mean orb {self.mean_orb:.1f}°"
        )


def shared_aspects_across_events(
    aspect_engine,
    events,
    vertex: str = "earth",
    bodies=None,
    exclude=("moon",),
    min_events: int = 2,
) -> list[SharedAspectTally]:
    """Reverse search: tally which aspects recur across a set of events.

    For each event the aspects in force (from `vertex`) are detected and tallied
    by (body_a, body_b, aspect_type). The result is ranked by how many events
    share each aspect, then by tightness — a discovery aid for spotting what a
    class of events has in common.

    `events` may be :class:`~orrery.events.Event` objects (the time-precision
    guardrail is applied — e.g. the Moon is dropped for day/unknown events) or
    bare datetimes / Skyfield Times (all bodies used). `n_eligible` reports how
    many events a given aspect *could* have appeared in, so `fraction` is fair
    even when the guardrail removed a body from some events.
    """
    astro = aspect_engine.astro
    base = list(bodies) if bodies is not None else list(ALL_BODIES)
    excl = set(exclude)

    tally: dict[tuple, dict] = {}
    eligible: dict[tuple, int] = {}

    for ev in events:
        if isinstance(ev, Event):
            label, when = ev.name, ev.time
            usable = set(reliable_bodies(ev, base))
        else:
            label, when = str(ev), ev
            usable = set(base)
        usable -= excl
        body_list = [b for b in base if b in usable and b != vertex]
        if vertex != "earth":
            body_list = [b for b in body_list if b not in NODE_ALIASES]

        for a, b in combinations(body_list, 2):
            if frozenset({a, b}) in TRIVIAL_PAIRS:
                continue
            eligible[tuple(sorted((a, b)))] = (
                eligible.get(tuple(sorted((a, b))), 0) + 1
            )

        for asp in aspect_engine.aspects_at(when, vertex, bodies=tuple(body_list)):
            a, b = sorted((asp.body_a, asp.body_b))
            key = (a, b, asp.aspect)
            rec = tally.setdefault(key, {"orbs": [], "events": []})
            rec["orbs"].append(asp.orb)
            rec["events"].append(label)

    out: list[SharedAspectTally] = []
    for (a, b, name), rec in tally.items():
        n = len(rec["events"])
        if n < min_events:
            continue
        elig = eligible.get((a, b), n)
        out.append(
            SharedAspectTally(
                body_a=a,
                body_b=b,
                aspect=name,
                n_events=n,
                n_eligible=elig,
                fraction=n / elig if elig else 0.0,
                mean_orb=float(np.mean(rec["orbs"])),
                events=tuple(rec["events"]),
            )
        )
    out.sort(key=lambda r: (-r.n_events, r.mean_orb))
    return out


def aspect_pairs(
    aspect_engine,
    when,
    vertex: str = "earth",
    bodies=None,
    exclude=("moon",),
) -> list[tuple[str, str]]:
    """Derive priority pairs from whatever is currently *in aspect* at `when`.

    The default set of priority aspects for the default view. `exclude` drops
    fast bodies (the Moon by default) whose configurations recur too often to
    make a historical match meaningful.
    """
    kwargs = {"bodies": bodies} if bodies is not None else {}
    pairs: list[tuple[str, str]] = []
    for a in aspect_engine.aspects_at(when, vertex, **kwargs):
        if a.body_a in exclude or a.body_b in exclude:
            continue
        pair = (a.body_a, a.body_b)
        if pair not in pairs:
            pairs.append(pair)
    return pairs


# ---------------------------------------------------------------------------
# Background overlap: how alike are two skies vs. how alike any two skies are?
# ---------------------------------------------------------------------------
#
# Two random dates always share several aspects, because every date has many
# aspects in force and they are drawn from the same slow-moving planets. So the
# meaningful question is not "do these events share aspects" (they will) but
# "do they share MORE than two random dates would". This builds the empirical
# distribution of shared-aspect counts for random date-pairs and places an
# observed event-pair against it.


@dataclass
class OverlapNull:
    """Distribution of shared-aspect overlap over random date-pairs.

    Two statistics per pair:
    * ``counts`` — raw number of shared aspects (every aspect worth 1).
    * ``scores`` — rarity-weighted: each shared aspect contributes
      ``-log10(base_rate)``, so sharing a rare slow-planet aspect counts far
      more than a common fast one. This is the statistic that respects your
      point that aspects are not equally likely.

    ``base_rates``/``weights``/``specs`` are per aspect-slot, aligned, and reused
    to score the observed pair on the same footing.
    """

    counts: np.ndarray  # shared count per random pair
    scores: np.ndarray  # rarity-weighted shared score per random pair
    base_rates: np.ndarray  # per slot: fraction of sampled dates in this aspect
    weights: np.ndarray  # per slot: -log10(base_rate)
    specs: list  # per slot: (body_a, body_b, aspect_name, angle, orb)
    n_pairs: int
    span_years: float

    @property
    def n_slots(self) -> int:
        return len(self.specs)

    # -- raw count statistic --------------------------------------------------
    @property
    def mean(self) -> float:
        return float(self.counts.mean())

    @property
    def std(self) -> float:
        return float(self.counts.std())

    def percentile(self, q) -> float:
        return float(np.percentile(self.counts, q))

    def p_value(self, observed: float) -> float:
        """Fraction of random pairs sharing >= `observed` aspects (+1 smoothed)."""
        return float((np.sum(self.counts >= observed) + 1) / (self.counts.size + 1))

    # -- rarity-weighted statistic --------------------------------------------
    @property
    def weighted_mean(self) -> float:
        return float(self.scores.mean())

    @property
    def weighted_std(self) -> float:
        return float(self.scores.std())

    def weighted_percentile(self, q) -> float:
        return float(np.percentile(self.scores, q))

    def weighted_p_value(self, observed: float) -> float:
        return float((np.sum(self.scores >= observed) + 1) / (self.scores.size + 1))

    def __str__(self) -> str:
        return (
            f"random date-pairs: count {self.mean:.2f} ± {self.std:.2f} "
            f"(95th pct {self.percentile(95):.0f}); rarity-score "
            f"{self.weighted_mean:.2f} ± {self.weighted_std:.2f} "
            f"(95th pct {self.weighted_percentile(95):.2f}); "
            f"{self.n_pairs} pairs over {self.span_years:.0f} yr, "
            f"{self.n_slots} aspect slots"
        )


def _overlap_specs(aspect_engine, bodies, exclude, vertex):
    """All (body_a, body_b, aspect_name, angle, orb) slots for the body set."""
    base = [
        b
        for b in (list(bodies) if bodies is not None else list(ALL_BODIES))
        if b not in exclude and b != vertex
    ]
    if vertex != "earth":
        base = [b for b in base if b not in NODE_ALIASES]
    specs = []
    for a, b in combinations(base, 2):
        if frozenset({a, b}) in TRIVIAL_PAIRS:
            continue
        for at in aspect_engine.aspects:
            specs.append((a, b, at.name, float(at.angle), float(at.orb)))
    return specs, base


def _present_matrix(astro, specs, times, vertex):
    """Boolean (n_slots, n_times): is each aspect slot in force at each time?"""
    bodies = sorted({a for (a, b, *_r) in specs} | {b for (a, b, *_r) in specs})
    lons = {b: np.atleast_1d(astro.longitudes(b, times, vertex)) for b in bodies}
    m = len(next(iter(lons.values())))
    out = np.zeros((len(specs), m), dtype=bool)
    for i, (a, b, _name, angle, orb) in enumerate(specs):
        d = np.abs(lons[a] - lons[b]) % 360.0
        sep = np.where(d <= 180.0, d, 360.0 - d)
        out[i] = np.abs(sep - angle) <= orb
    return out


def background_overlap_distribution(
    aspect_engine,
    start,
    end,
    n_pairs: int = 20_000,
    vertex: str = "earth",
    bodies=None,
    exclude=("moon",),
    seed: int | None = None,
) -> OverlapNull:
    """Empirical distribution of how much two random dates' skies overlap.

    Draws `n_pairs` independent pairs of uniform-random dates in [start, end].
    For each pair it records both the raw shared-aspect count and a
    rarity-weighted score (each shared aspect weighted by ``-log10`` of its base
    rate, estimated from the same random sample — so fast common aspects barely
    move the score while rare slow-planet aspects move it a lot). This is the
    baseline the observed event-pair is judged against, on both statistics.
    """
    astro = aspect_engine.astro
    ts = astro.ts
    specs, _base = _overlap_specs(aspect_engine, bodies, exclude, vertex)
    tt0, tt1 = _coerce_tt(astro, start), _coerce_tt(astro, end)
    if tt1 <= tt0:
        raise ValueError("end must be after start")
    rng = np.random.default_rng(seed)

    dates = rng.uniform(tt0, tt1, size=2 * n_pairs)
    present = _present_matrix(astro, specs, ts.tt_jd(dates), vertex)
    # base rate of each aspect slot = fraction of sampled instants in force
    base_rates = present.mean(axis=1)
    floor = 1.0 / (2 * n_pairs)  # avoid log(0) for slots unseen in the sample
    weights = -np.log10(np.clip(base_rates, floor, 1.0))

    shared = present[:, 0::2] & present[:, 1::2]  # (n_slots, n_pairs)
    counts = shared.sum(axis=0)
    scores = weights @ shared
    return OverlapNull(
        counts=counts,
        scores=scores,
        base_rates=base_rates,
        weights=weights,
        specs=specs,
        n_pairs=n_pairs,
        span_years=(tt1 - tt0) / 365.25,
    )


@dataclass
class OverlapAssessment:
    """An event-pair's shared-aspect overlap vs the random-pair baseline.

    Reports both the raw count and the rarity-weighted score. The weighted
    score (and ``score_p_value``) is the headline: it credits rare shared
    aspects and discounts common ones. ``shared`` pairs each SharedAspect with
    its base rate in ``shared_base_rates`` (same order).
    """

    label_a: str
    label_b: str
    observed_count: int
    observed_score: float
    shared: tuple  # tuple[SharedAspect]
    shared_base_rates: tuple  # base rate of each shared aspect (same order)
    null: OverlapNull
    p_value: float  # raw-count p-value (kept for reference)
    percentile_of_observed: float  # raw-count percentile
    score_p_value: float  # rarity-weighted p-value (headline)
    score_percentile: float  # rarity-weighted percentile

    def __str__(self) -> str:
        verdict = (
            "MORE alike than chance"
            if self.score_percentile >= 95
            else "about as alike as random dates"
            if self.score_percentile >= 5
            else "LESS alike than random dates"
        )
        rare = ", ".join(
            f"{s.body_a} {s.aspect} {s.body_b} ({br:.1%})"
            for s, br in sorted(
                zip(self.shared, self.shared_base_rates), key=lambda x: x[1]
            )
        )
        return (
            f"{self.label_a}  ×  {self.label_b}\n"
            f"  Shared: {self.observed_count} aspects; rarity-score "
            f"{self.observed_score:.2f}.\n"
            f"  Baseline: {self.null}\n"
            f"  Rarity-weighted: {self.score_percentile:.0f}th percentile "
            f"(p={self.score_p_value:.3g}) — {verdict}.\n"
            f"  Raw count: {self.percentile_of_observed:.0f}th percentile "
            f"(p={self.p_value:.3g}).\n"
            f"  Shared aspects (rarest first): {rare}"
        )


def assess_overlap(
    aspect_engine,
    event_a,
    event_b,
    start,
    end,
    n_pairs: int = 20_000,
    vertex: str = "earth",
    bodies=None,
    exclude=("moon",),
    seed: int | None = None,
) -> OverlapAssessment:
    """Compare one event-pair's shared-aspect count to the random-pair baseline.

    `event_a`/`event_b` may be Event objects (guardrail applied: a coarse-time
    event contributes no aspects involving a refused body) or bare
    datetimes/Times. Returns the observed shared count, the null distribution,
    and where the observation falls within it.
    """
    astro = aspect_engine.astro
    ts = astro.ts

    def _time_and_reliable(ev):
        if isinstance(ev, Event):
            rb = set(reliable_bodies(ev))
            return astro.time(ev.time), ev.name, rb
        return astro.time(ev), str(ev), None

    ta, label_a, rb_a = _time_and_reliable(event_a)
    tb, label_b, rb_b = _time_and_reliable(event_b)

    # Build the null first; its per-slot base rates / weights are then reused to
    # score the observed pair on identical footing.
    null = background_overlap_distribution(
        aspect_engine, start, end, n_pairs, vertex, bodies, exclude, seed
    )

    present = _present_matrix(astro, null.specs, ts.tt_jd([ta.tt, tb.tt]), vertex)
    shared, shared_rates = [], []
    observed_score = 0.0
    for i, (a, b, name, _ang, _orb) in enumerate(null.specs):
        if not (present[i, 0] and present[i, 1]):
            continue
        # guardrail: both bodies must be reliable for each event that has a flag
        if rb_a is not None and (a not in rb_a or b not in rb_a):
            continue
        if rb_b is not None and (a not in rb_b or b not in rb_b):
            continue
        shared.append(SharedAspect(a, b, name))
        shared_rates.append(float(null.base_rates[i]))
        observed_score += float(null.weights[i])
    observed = len(shared)

    return OverlapAssessment(
        label_a=label_a,
        label_b=label_b,
        observed_count=observed,
        observed_score=observed_score,
        shared=tuple(shared),
        shared_base_rates=tuple(shared_rates),
        null=null,
        p_value=null.p_value(observed),
        percentile_of_observed=float((null.counts < observed).mean() * 100.0),
        score_p_value=null.weighted_p_value(observed_score),
        score_percentile=float((null.scores < observed_score).mean() * 100.0),
    )
