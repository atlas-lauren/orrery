"""Tests for the background-overlap baseline: how many aspects random date-pairs
share, and whether an event-pair shares more."""

from datetime import timezone

import numpy as np
import pytest

from orrery import (
    AstroEngine,
    AspectEngine,
    event_from_row,
    background_overlap_distribution,
    assess_overlap,
)

UTC = timezone.utc


@pytest.fixture(scope="module")
def aspects():
    return AspectEngine(AstroEngine(ephemeris="de440s.bsp"))


def _ev(ts, name, iso, precision="exact"):
    return event_from_row(
        {"name": name, "category": "t", "time_precision": precision,
         "datetime_utc": iso},
        ts=ts,
    )


# -- the null distribution ---------------------------------------------------


def test_null_distribution_shape_and_baseline(aspects):
    null = background_overlap_distribution(
        aspects, start=1950, end=2050, n_pairs=2000, seed=1
    )
    assert null.counts.size == 2000
    assert null.scores.size == 2000
    assert np.all(null.counts >= 0)
    assert np.all(null.scores >= 0)
    # random dates DO share several aspects on average (the whole point)
    assert null.mean > 0
    assert null.weighted_mean > 0
    assert null.n_slots > 0
    # base rates and weights are per-slot and aligned
    assert null.base_rates.size == null.n_slots
    assert null.weights.size == null.n_slots


def test_rarer_aspects_get_higher_weight(aspects):
    """A rare (slow-planet) aspect must carry more weight than a common one."""
    null = background_overlap_distribution(
        aspects, start=1900, end=2100, n_pairs=4000, seed=11
    )
    rates = dict(
        zip([(s[0], s[1], s[2]) for s in null.specs], null.base_rates)
    )
    weights = dict(zip([(s[0], s[1], s[2]) for s in null.specs], null.weights))
    # find a fast-pair and a slow-pair aspect both observed in the sample
    fast = [k for k, r in rates.items() if "mercury" in k[:2] and r > 0]
    slow = [k for k, r in rates.items()
            if {"neptune", "pluto"} <= set(k[:2]) and r > 0]
    if fast and slow:
        # the rarer slot has the larger weight
        f = min(fast, key=lambda k: rates[k])  # pick some fast slot
        s = min(slow, key=lambda k: rates[k])
        if rates[s] < rates[f]:
            assert weights[s] > weights[f]


def test_null_deterministic_with_seed(aspects):
    a = background_overlap_distribution(aspects, 1950, 2050, n_pairs=1000, seed=7)
    b = background_overlap_distribution(aspects, 1950, 2050, n_pairs=1000, seed=7)
    assert np.array_equal(a.counts, b.counts)


# -- assessing an event-pair -------------------------------------------------


def test_identical_dates_share_more_than_random(aspects):
    """Two events at the same instant share every aspect -> top of the null."""
    ts = aspects.astro.ts
    a = _ev(ts, "a", "1985-03-10T00:00:00Z")
    b = _ev(ts, "b", "1985-03-10T00:00:00Z")
    res = assess_overlap(aspects, a, b, start=1950, end=2050, n_pairs=2000, seed=2)
    assert res.observed_count > res.null.mean
    assert res.percentile_of_observed > 95
    assert res.p_value < 0.05
    # the rarity-weighted statistic agrees: extreme and significant
    assert res.observed_score > res.null.weighted_mean
    assert res.score_percentile > 95
    assert res.score_p_value < 0.05
    # shared aspects are reported, each with its base rate
    assert len(res.shared) == res.observed_count
    assert len(res.shared_base_rates) == res.observed_count
    assert all(0.0 < br <= 1.0 for br in res.shared_base_rates)


def test_observed_count_matches_shared_list(aspects):
    ts = aspects.astro.ts
    a = _ev(ts, "a", "2001-01-01T00:00:00Z")
    b = _ev(ts, "b", "1975-08-20T00:00:00Z")
    res = assess_overlap(aspects, a, b, start=1950, end=2050, n_pairs=1500, seed=3)
    assert res.observed_count == len(res.shared)
    assert 0.0 <= res.p_value <= 1.0
    assert 0.0 <= res.percentile_of_observed <= 100.0


def test_accepts_bare_times(aspects):
    ts = aspects.astro.ts
    res = assess_overlap(
        aspects, ts.utc(2000, 6, 1), ts.utc(2000, 6, 1),
        start=1980, end=2020, n_pairs=1000, seed=4,
    )
    # identical bare times: share everything, extreme percentile
    assert res.percentile_of_observed > 90


def test_guardrail_blocks_moon_for_day_event(aspects):
    """A day-precision event cannot contribute a Moon aspect to the overlap."""
    ts = aspects.astro.ts
    exact = _ev(ts, "exact", "1985-03-10T00:00:00Z", precision="exact")
    day = _ev(ts, "day", "1985-03-10T00:00:00Z", precision="day")
    res = assess_overlap(
        aspects, exact, day, start=1950, end=2050, n_pairs=500,
        exclude=(), seed=5,  # moon allowed in principle...
    )
    # ...but the day event refuses the Moon, so no shared aspect involves it
    assert all("moon" not in (s.body_a, s.body_b) for s in res.shared)
