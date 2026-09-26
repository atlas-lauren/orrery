"""Tests for the analytic base rate (duty cycle) and the binomial bridge that
connects the reverse search to it."""

from datetime import timezone

import pytest

from orrery import (
    AstroEngine,
    AspectEngine,
    event_from_row,
    aspect_duty_cycle,
    binomial_significance,
    assess_shared_aspects,
)

UTC = timezone.utc


@pytest.fixture(scope="module")
def aspects():
    return AspectEngine(AstroEngine(ephemeris="de440s.bsp"))


# -- duty cycle --------------------------------------------------------------


def test_duty_cycle_in_unit_interval(aspects):
    dc = aspect_duty_cycle(
        aspects.astro, "mars", "saturn", angle=60.0, max_orb=5.0,
        start=1950, end=2000,
    )
    assert 0.0 < dc.fraction < 1.0
    assert dc.n_hits > 0
    assert dc.n_samples > 0


def test_wider_orb_has_higher_duty_cycle(aspects):
    """A wider orb is in force a larger fraction of the time."""
    narrow = aspect_duty_cycle(aspects.astro, "mars", "saturn", 0.0, 1.0,
                               start=1950, end=2000)
    wide = aspect_duty_cycle(aspects.astro, "mars", "saturn", 0.0, 8.0,
                             start=1950, end=2000)
    assert wide.fraction > narrow.fraction


def test_duty_cycle_deterministic(aspects):
    """No sampling noise: identical inputs give identical output."""
    a = aspect_duty_cycle(aspects.astro, "venus", "jupiter", 120.0, 7.0,
                          start=1980, end=1990)
    b = aspect_duty_cycle(aspects.astro, "venus", "jupiter", 120.0, 7.0,
                          start=1980, end=1990)
    assert a.fraction == b.fraction
    assert a.n_hits == b.n_hits


# -- binomial bridge ---------------------------------------------------------


def test_binomial_significance_known_values():
    # P(X >= 3 | n=3, p=0.1) = 0.1^3 = 0.001
    assert binomial_significance(3, 3, 0.1) == pytest.approx(0.001, rel=1e-6)
    # P(X >= 1 | n=5, p=0) = 0
    assert binomial_significance(1, 5, 0.0) == 0.0
    # P(X >= 0) is always 1
    assert binomial_significance(0, 4, 0.3) == pytest.approx(1.0)


def test_binomial_low_base_rate_more_surprising():
    # sharing a rare aspect (low base rate) is more surprising than a common one
    rare = binomial_significance(3, 3, 0.02)
    common = binomial_significance(3, 3, 0.40)
    assert rare < common


# -- the full bridge ---------------------------------------------------------


def _ev(ts, name, iso, precision="exact"):
    return event_from_row(
        {"name": name, "category": "t", "time_precision": precision,
         "datetime_utc": iso},
        ts=ts,
    )


def test_assess_shared_aspects_structure(aspects):
    ts = aspects.astro.ts
    # two events at the same instant share many aspects
    events = [_ev(ts, "a", "1985-03-10T00:00:00Z"),
              _ev(ts, "b", "1985-03-10T00:00:00Z")]
    results = assess_shared_aspects(
        aspects, events, start=1950, end=2000, min_events=2,
    )
    assert len(results) > 0
    for r in results:
        assert 0.0 <= r.p_value <= 1.0
        assert 0.0 < r.base_rate <= 1.0
        assert r.n_events == 2 and r.n_eligible == 2
        # comparison count reflects the whole realized family, not just winners
        assert r.n_comparisons >= len(results)
        assert r.bonferroni_p >= r.p_value
    # sorted ascending by p-value
    ps = [r.p_value for r in results]
    assert ps == sorted(ps)


def test_assess_rarer_aspect_ranks_first(aspects):
    """Among aspects shared by both events, the rarest (lowest base rate) is
    the most significant."""
    ts = aspects.astro.ts
    events = [_ev(ts, "a", "1985-03-10T00:00:00Z"),
              _ev(ts, "b", "1985-03-10T00:00:00Z")]
    results = assess_shared_aspects(aspects, events, start=1950, end=2000)
    # the top (smallest p) result has the smallest base rate among results
    assert results[0].base_rate == min(r.base_rate for r in results)
