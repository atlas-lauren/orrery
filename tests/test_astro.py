"""Day-one sanity tests for the astronomical core.

The anchor test is the 2020-12-21 great conjunction: Jupiter and Saturn passed
within ~0.1° (≈6 arcmin) geocentrically. If the engine and ephemeris are sound,
this reproduces; if not, we find out immediately.
"""

from datetime import datetime, timezone

import math
import pytest

from orrery import AstroEngine


UTC = timezone.utc


@pytest.fixture(scope="module")
def engine():
    # Pinned to the small kernel so the suite never depends on the 3.3 GB
    # de441 working default. de440s (1849–2150) covers every test date.
    return AstroEngine(ephemeris="de440s.bsp")


def test_great_conjunction_2020(engine):
    """Jupiter–Saturn closest approach, 2020-12-21 ~18:00 UTC, ~0.1° apart."""
    when = datetime(2020, 12, 21, 18, 0, tzinfo=UTC)
    sep = engine.angular_separation("jupiter", "saturn", when, vertex="earth")
    assert 0.05 < sep < 0.20, f"expected ~0.1°, got {sep:.4f}°"


def test_longitude_separation_folds_to_180(engine):
    when = datetime(2020, 12, 21, 18, 0, tzinfo=UTC)
    sep = engine.longitude_separation("jupiter", "saturn", when)
    assert 0.0 <= sep <= 180.0
    # In longitude alone the great conjunction is even tighter than the
    # great-circle gap, so it must be well under a degree.
    assert sep < 0.20


def test_geocentric_sun_is_opposite_heliocentric_earth(engine):
    """Sun seen from Earth and Earth seen from Sun are ~180° apart in longitude."""
    when = datetime(2000, 3, 20, 7, 35, tzinfo=UTC)  # near an equinox
    geo_sun = engine.position("sun", when, vertex="earth").longitude
    helio_earth = engine.position("earth", when, vertex="sun").longitude
    # They should be 180° apart: (geo_sun - helio_earth) mod 360 ≈ 180.
    off = abs(((geo_sun - helio_earth) % 360.0) - 180.0)
    assert off < 0.10, f"expected ~180° opposition, off by {off:.4f}°"


def test_separation_is_zodiac_independent(engine):
    """The ayanamsha cancels in any pairwise longitude separation."""
    when = datetime(2020, 12, 21, 18, 0, tzinfo=UTC)
    trop = engine.longitude_separation("mars", "saturn", when, zodiac="tropical")
    sid = engine.longitude_separation("mars", "saturn", when, zodiac="sidereal")
    assert abs(trop - sid) < 1e-6


def test_sidereal_offset_matches_ayanamsha(engine):
    when = datetime(2020, 6, 21, 0, 0, tzinfo=UTC)
    trop = engine.position("sun", when, zodiac="tropical").longitude
    sid = engine.position("sun", when, zodiac="sidereal", ayanamsha="lahiri").longitude
    ayan = engine.ayanamsha("lahiri", when)
    assert abs(((trop - sid) % 360.0) - ayan) < 1e-6


def test_naive_datetime_rejected(engine):
    with pytest.raises(ValueError):
        engine.position("sun", datetime(2020, 1, 1, 12, 0))  # no tzinfo


def test_nodes_require_geocentric(engine):
    when = datetime(2020, 1, 1, 12, 0, tzinfo=UTC)
    # Geocentric node is fine...
    geo = engine.position("north_node", when, vertex="earth")
    assert 0.0 <= geo.longitude < 360.0
    assert math.isnan(geo.distance_au)
    # ...but a heliocentric node is undefined.
    with pytest.raises(ValueError):
        engine.position("north_node", when, vertex="sun")


def test_node_opposition(engine):
    when = datetime(2020, 1, 1, 12, 0, tzinfo=UTC)
    n = engine.position("north_node", when).longitude
    s = engine.position("south_node", when).longitude
    # The nodes are exactly opposite: (north - south) mod 360 == 180.
    assert abs(((n - s) % 360.0) - 180.0) < 1e-6
