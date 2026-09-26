"""Tests for the aspect engine, multi-vertex census, and whole-figure finders.

Ephemeris-dependent checks reuse the 2020-12-21 great conjunction. Whole-figure
geometry is tested with synthetic longitude maps so it is fully deterministic
and independent of the ephemeris.
"""

from datetime import datetime, timezone

import pytest

from orrery import AstroEngine, AspectEngine, AspectType, load_aspect_config
from orrery.aspects import find_regular_polygons, find_syzygies, _fold

UTC = timezone.utc
GC = datetime(2020, 12, 21, 18, 0, tzinfo=UTC)  # great conjunction


@pytest.fixture(scope="module")
def aspects():
    return AspectEngine(AstroEngine(ephemeris="de440s.bsp"))


# -- config -----------------------------------------------------------------


def test_default_config_loads():
    cfg = load_aspect_config()
    names = {a.name for a in cfg}
    assert {"conjunction", "opposition", "trine", "square", "sextile"} <= names
    assert len(cfg) == 10
    conj = next(a for a in cfg if a.name == "conjunction")
    assert conj.angle == 0.0 and conj.orb == 8.0


# -- detection ---------------------------------------------------------------


def test_great_conjunction_detected(aspects):
    found = aspects.aspects_at(GC, "earth", bodies=("jupiter", "saturn"))
    assert len(found) == 1
    a = found[0]
    assert a.aspect == "conjunction"
    assert a.orb < 0.01
    assert a.angle == 0.0
    assert a.faster == "jupiter"  # Jupiter outruns Saturn


def test_applying_then_separating(aspects):
    before = aspects.aspects_at(datetime(2020, 12, 19, 18, tzinfo=UTC), "earth",
                                bodies=("jupiter", "saturn"))[0]
    after = aspects.aspects_at(datetime(2020, 12, 23, 18, tzinfo=UTC), "earth",
                               bodies=("jupiter", "saturn"))[0]
    assert before.applying is True
    assert after.applying is False


def test_orb_widening_changes_detection(aspects):
    """A custom config with a tiny orb rejects what the default accepts."""
    tight = AspectEngine(aspects.astro, [AspectType("conjunction", 0.0, 0.001)])
    wide = AspectEngine(aspects.astro, [AspectType("conjunction", 0.0, 8.0)])
    # 2020-12-25, conjunction has separated past 0.001° but is within 8°.
    when = datetime(2020, 12, 25, 18, tzinfo=UTC)
    assert tight.aspects_at(when, "earth", bodies=("jupiter", "saturn")) == []
    assert len(wide.aspects_at(when, "earth", bodies=("jupiter", "saturn"))) == 1


# -- multi-vertex census -----------------------------------------------------


def test_census_is_multi_vertex(aspects):
    cen = aspects.census(GC)
    assert len(cen) > 100  # the "many channels" calculation
    vertices = {a.vertex for a in cen}
    assert len(vertices) > 3  # genuinely measured from multiple corners
    # The geocentric great conjunction must be in there.
    assert any(
        a.vertex == "earth" and a.aspect == "conjunction"
        and {a.body_a, a.body_b} == {"jupiter", "saturn"}
        for a in cen
    )


def test_census_excludes_definitional_pairs(aspects):
    """No node self-aspects: mean_node alias is excluded, node axis is skipped."""
    cen = aspects.census(GC)
    for a in cen:
        assert "mean_node" not in (a.body_a, a.body_b)
        assert {a.body_a, a.body_b} != {"north_node", "south_node"}


def test_census_sorted_by_orb(aspects):
    cen = aspects.census(GC)
    orbs = [a.orb for a in cen]
    assert orbs == sorted(orbs)


# -- whole figures (synthetic, deterministic) --------------------------------


def test_grand_trine_detected():
    lons = {"a": 10.0, "b": 130.0, "c": 250.0}  # exact 120° spacing
    figs = find_regular_polygons(lons, "earth", k=3, orb=6.0)
    assert len(figs) == 1
    assert figs[0].kind == "grand_trine"
    assert figs[0].orb < 1e-9


def test_grand_cross_detected():
    lons = {"a": 0.0, "b": 90.0, "c": 180.0, "d": 270.0}
    figs = find_regular_polygons(lons, "earth", k=4, orb=6.0)
    assert len(figs) == 1
    assert figs[0].kind == "grand_cross"


def test_polygon_rejected_outside_orb():
    lons = {"a": 0.0, "b": 130.0, "c": 250.0}  # 130/120/110 spacing, 10° off
    assert find_regular_polygons(lons, "earth", k=3, orb=6.0) == []


def test_syzygy_collinear_mod_180():
    # x and z near 0°/conjunction, y near 180°/opposition -> collinear line.
    lons = {"x": 10.0, "y": 190.5, "z": 9.0}
    figs = find_syzygies(lons, "earth", orb=3.0)
    assert len(figs) == 1
    assert set(figs[0].bodies) == {"x", "y", "z"}


def test_syzygy_rejected_when_not_collinear():
    lons = {"x": 10.0, "y": 100.0, "z": 200.0}
    assert find_syzygies(lons, "earth", orb=3.0) == []


def test_fold():
    assert _fold(0.0) == 0.0
    assert _fold(190.0) == 170.0
    assert _fold(-90.0) == 90.0
    assert _fold(360.0) == 0.0
