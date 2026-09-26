"""Tests for the event model and — most importantly — the time-precision
guardrail that refuses time-sensitive factors for coarse-time events."""

import os
from datetime import timezone

import pytest

from orrery import (
    AstroEngine,
    AspectEngine,
    Event,
    TimePrecision,
    TimePrecisionError,
    load_events,
    event_from_row,
    reliable_bodies,
    census_for_event,
)

SAMPLE = os.path.join(os.path.dirname(__file__), "..", "examples", "events_sample.csv")


@pytest.fixture(scope="module")
def ts():
    # Reuse the small kernel's timescale; no planetary ephemeris needed here.
    return AstroEngine(ephemeris="de440s.bsp").ts


# -- loading -----------------------------------------------------------------


def test_load_sample(ts):
    events = load_events(SAMPLE, ts=ts)
    assert len(events) == 5
    by_name = {e.name: e for e in events}
    assert by_name["Battle of Waterloo"].time_precision is TimePrecision.DAY
    assert by_name["Caesar assassination"].category == "assassination"


def test_local_to_utc_conversion(ts):
    """JFK: 12:30 CST (UTC−6 in Nov 1963) -> 18:30 UTC, original retained."""
    events = {e.name: e for e in load_events(SAMPLE, ts=ts)}
    jfk = events["JFK assassination"]
    assert jfk.datetime_utc.astimezone(timezone.utc).hour == 18
    assert jfk.datetime_utc.minute == 30
    assert jfk.local_datetime.hour == 12  # original local time kept
    assert jfk.tz == "America/Chicago"


def test_bce_event_has_time_but_no_datetime(ts):
    events = {e.name: e for e in load_events(SAMPLE, ts=ts)}
    caesar = events["Caesar assassination"]
    assert caesar.datetime_utc is None  # year < 1 CE: no python datetime
    assert caesar.time is not None  # but a Skyfield Time exists
    assert "-043-03-15" in caesar.time.utc_strftime("%Y-%m-%d")


def test_invalid_precision_rejected(ts):
    with pytest.raises(ValueError):
        event_from_row(
            {"name": "x", "category": "c", "time_precision": "approximate",
             "datetime_utc": "2000-01-01T00:00:00Z"},
            ts=ts,
        )


def test_missing_time_rejected(ts):
    with pytest.raises(ValueError):
        event_from_row({"name": "x", "category": "c", "time_precision": "day"}, ts=ts)


# -- the guardrail -----------------------------------------------------------


def _ev(ts, precision, lat=None, lon=None):
    return event_from_row(
        {
            "name": f"t-{precision}",
            "category": "test",
            "time_precision": precision,
            "datetime_utc": "2020-12-21T18:00:00Z",
            "latitude": lat,
            "longitude": lon,
        },
        ts=ts,
    )


def test_slow_factors_always_reliable(ts):
    for precision in ("exact", "hour", "day", "unknown"):
        e = _ev(ts, precision)
        assert e.is_reliable("sun")
        assert e.is_reliable("pluto")
        assert e.is_reliable("north_node")


def test_moon_needs_at_least_hour(ts):
    assert _ev(ts, "exact").is_reliable("moon")
    assert _ev(ts, "hour").is_reliable("moon")
    assert not _ev(ts, "day").is_reliable("moon")
    assert not _ev(ts, "unknown").is_reliable("moon")


def test_ascendant_needs_exact_and_location(ts):
    # exact time but no location -> still refused
    assert not _ev(ts, "exact").is_reliable("ascendant")
    # exact time with location -> ok
    assert _ev(ts, "exact", lat=51.5, lon=-0.1).is_reliable("ascendant")
    # location but only hour precision -> refused
    assert not _ev(ts, "hour", lat=51.5, lon=-0.1).is_reliable("ascendant")


def test_require_raises_hard(ts):
    day_event = _ev(ts, "day")
    with pytest.raises(TimePrecisionError):
        day_event.require("moon")
    # slow factor passes silently
    day_event.require("saturn")


def test_reliable_bodies_drops_moon_for_day(ts):
    day_event = _ev(ts, "day")
    bodies = reliable_bodies(day_event)
    assert "moon" not in bodies
    assert "saturn" in bodies and "sun" in bodies
    # exact event keeps the Moon
    assert "moon" in reliable_bodies(_ev(ts, "exact"))


# -- guardrail flows into the census ----------------------------------------


def test_census_for_event_excludes_refused(ts):
    astro = AstroEngine(ephemeris="de440s.bsp")
    aspects = AspectEngine(astro)
    day_event = _ev(ts, "day")
    result = census_for_event(aspects, day_event)
    # the refusal is surfaced
    assert "moon" in result.refused
    assert "moon" not in result.bodies_used
    # and no aspect anywhere in the census involves the Moon
    assert all(
        "moon" not in (a.body_a, a.body_b) for a in result.aspects
    )
    assert "REFUSED" in str(result)
