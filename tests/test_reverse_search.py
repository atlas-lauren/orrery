"""Tests for the reverse search: which aspects an event set shares."""

from datetime import datetime, timezone

import pytest

from orrery import (
    AstroEngine,
    AspectEngine,
    event_from_row,
    shared_aspects_across_events,
)

UTC = timezone.utc


@pytest.fixture(scope="module")
def aspects():
    return AspectEngine(AstroEngine(ephemeris="de440s.bsp"))


def _ev(ts, name, iso, precision="exact"):
    return event_from_row(
        {"name": name, "category": "test", "time_precision": precision,
         "datetime_utc": iso},
        ts=ts,
    )


def test_identical_times_share_all_aspects(aspects):
    """Three events at the same instant share every aspect (fraction 1.0)."""
    ts = aspects.astro.ts
    iso = "2020-12-21T18:00:00Z"
    events = [_ev(ts, f"e{i}", iso) for i in range(3)]
    shared = shared_aspects_across_events(aspects, events, min_events=2)
    assert len(shared) > 0
    assert all(s.n_events == 3 and s.fraction == 1.0 for s in shared)
    # the great conjunction must be among the shared aspects
    assert any(
        {s.body_a, s.body_b} == {"jupiter", "saturn"} and s.aspect == "conjunction"
        for s in shared
    )


def test_ranked_by_event_count(aspects):
    ts = aspects.astro.ts
    events = [
        _ev(ts, "a", "2020-12-21T18:00:00Z"),
        _ev(ts, "b", "2020-12-21T18:00:00Z"),  # same sky as a
        _ev(ts, "c", "1995-06-15T12:00:00Z"),  # different sky
    ]
    shared = shared_aspects_across_events(aspects, events, min_events=1)
    counts = [s.n_events for s in shared]
    assert counts == sorted(counts, reverse=True)
    # aspects common to a & b appear with n_events >= 2
    assert shared[0].n_events >= 2


def test_guardrail_drops_moon_for_day_events(aspects):
    """A day-precision event can't contribute Moon aspects to the tally."""
    ts = aspects.astro.ts
    # same instant, but one event has only day precision -> Moon refused there
    exact = _ev(ts, "exact", "2020-12-21T18:00:00Z", precision="exact")
    day = _ev(ts, "day", "2020-12-21T18:00:00Z", precision="day")
    shared = shared_aspects_across_events(
        aspects, [exact, day], exclude=(), min_events=1
    )
    moon_aspects = [s for s in shared if "moon" in (s.body_a, s.body_b)]
    # any Moon aspect appears in at most one event (the exact one) and was
    # eligible in only one event
    for s in moon_aspects:
        assert s.n_events == 1
        assert s.n_eligible == 1


def test_moon_excluded_by_default(aspects):
    ts = aspects.astro.ts
    events = [_ev(ts, f"e{i}", "2020-12-21T18:00:00Z") for i in range(2)]
    shared = shared_aspects_across_events(aspects, events)  # default exclude=("moon",)
    assert all("moon" not in (s.body_a, s.body_b) for s in shared)


def test_accepts_bare_times(aspects):
    ts = aspects.astro.ts
    times = [ts.utc(2020, 12, 21, 18), ts.utc(2020, 12, 21, 18)]
    shared = shared_aspects_across_events(aspects, times, min_events=2)
    assert len(shared) > 0
    assert all(s.n_events == 2 for s in shared)
