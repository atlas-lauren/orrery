"""Tests for the statistics module: Monte-Carlo controls, Schuster's test, and
multiple-comparison accounting. Most tests use synthetic vectorized patterns so
they are deterministic and don't depend on the ephemeris."""

from datetime import datetime, timezone

import numpy as np
import pytest

from orrery import (
    AstroEngine,
    aspect_pattern,
    monte_carlo_test,
    schuster_test,
    MultipleComparisons,
)

UTC = timezone.utc


@pytest.fixture(scope="module")
def astro():
    return AstroEngine(ephemeris="de440s.bsp")


# -- Schuster's test ---------------------------------------------------------


def test_schuster_clustered_is_significant():
    rng = np.random.default_rng(0)
    phases = 10.0 + rng.normal(0, 5, size=200)  # tightly clustered near 10°
    res = schuster_test(phases)
    assert res.p_value < 0.001
    assert abs(res.mean_angle - 10.0) < 5.0
    assert res.mean_resultant > 0.9


def test_schuster_uniform_is_not_significant():
    phases = np.linspace(0, 360, 360, endpoint=False)  # perfectly uniform
    res = schuster_test(phases)
    assert res.p_value > 0.5
    assert res.mean_resultant < 0.05


# -- Monte-Carlo control test (synthetic, deterministic) ---------------------


def test_monte_carlo_enriched_events_significant(astro):
    """Pattern true on ~10% of the timeline; events all satisfy it -> small p."""
    def pattern(times):
        frac = np.asarray(times.tt) % 1.0
        return np.atleast_1d(frac < 0.10)

    # events placed squarely inside the "hit" band (JD fractional part .05)
    base = float(np.floor(astro.ts.utc(2000, 1, 1).tt))
    event_times = [astro.ts.tt_jd(base + d + 0.05) for d in range(0, 4000, 80)]
    res = monte_carlo_test(pattern, event_times, astro, n_controls=2000, seed=1,
                           label="band")
    assert res.observed_freq == 1.0
    assert res.control_freq_mean < 0.2  # base rate ~10%
    assert res.p_value < 0.01


def test_monte_carlo_random_events_not_significant(astro):
    def pattern(times):
        frac = np.asarray(times.tt) % 1.0
        return np.atleast_1d(frac < 0.10)

    base = astro.ts.utc(2000, 1, 1).tt
    rng = np.random.default_rng(7)
    # events at random fractional offsets -> observed ~ base rate
    event_times = [astro.ts.tt_jd(base + d + rng.random()) for d in range(0, 4000, 80)]
    res = monte_carlo_test(pattern, event_times, astro, n_controls=2000, seed=2,
                           label="random")
    assert res.p_value > 0.05


def test_monte_carlo_p_in_unit_interval(astro):
    def pattern(times):
        return np.atleast_1d(np.asarray(times.tt) % 1.0 < 0.5)
    base = astro.ts.utc(2010, 1, 1).tt
    events = [astro.ts.tt_jd(base + d) for d in range(0, 100, 10)]
    res = monte_carlo_test(pattern, events, astro, n_controls=500, seed=3)
    assert 0.0 <= res.p_value <= 1.0
    assert len(res.null_distribution) == 500


# -- aspect_pattern (uses the ephemeris) -------------------------------------


def test_aspect_pattern_detects_great_conjunction(astro):
    pat = aspect_pattern(astro, "jupiter", "saturn", angle=0.0, max_orb=8.0)
    on = astro.ts.utc(2020, 12, 21, 18)
    off = astro.ts.utc(2010, 6, 1)
    assert bool(pat(on)[0]) is True
    assert bool(pat(off)[0]) is False


# -- multiple comparisons ----------------------------------------------------


def test_multiple_comparisons_math():
    mc = MultipleComparisons(alpha=0.05)
    mc.add("a", 0.001).add("b", 0.04).add("c", 0.30)
    results = {r.label: r for r in mc.results()}
    # Bonferroni: significant iff p < 0.05/3 = 0.01667
    assert results["a"].bonferroni_significant is True
    assert results["b"].bonferroni_significant is False
    assert abs(results["b"].bonferroni_p - 0.12) < 1e-9
    # Benjamini-Hochberg q-values
    assert abs(results["a"].fdr_q - 0.003) < 1e-9
    assert abs(results["b"].fdr_q - 0.06) < 1e-9
    assert results["a"].fdr_significant is True
    assert results["b"].fdr_significant is False


def test_uncorrected_result_warns(astro):
    def pattern(times):
        return np.atleast_1d(np.asarray(times.tt) % 1.0 < 0.5)
    base = astro.ts.utc(2010, 1, 1).tt
    events = [astro.ts.tt_jd(base + d) for d in range(0, 50, 10)]
    res = monte_carlo_test(pattern, events, astro, n_controls=200, seed=4,
                           label="solo")
    assert "UNCORRECTED" in str(res)
    mc = MultipleComparisons()
    mc.register(res)
    mc.results()  # back-fills correction info
    assert res.n_comparisons == 1
    assert "UNCORRECTED" not in str(res)
