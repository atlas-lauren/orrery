"""Tests for the configuration similarity search."""

from datetime import datetime, timezone

import pytest

from orrery import (
    AstroEngine,
    AspectEngine,
    configuration_vector,
    find_similar_configurations,
    reference_aspect_set,
    find_aspect_overlap,
    aspect_pairs,
)

UTC = timezone.utc


@pytest.fixture(scope="module")
def astro():
    return AstroEngine(ephemeris="de440s.bsp")


def test_configuration_vector_matches_separation(astro):
    when = datetime(2020, 12, 21, 18, tzinfo=UTC)
    vec = configuration_vector(astro, when, [("jupiter", "saturn")])
    # the great conjunction: separation ~0
    assert vec[("jupiter", "saturn")] < 0.5


def test_finds_reference_itself_when_not_excluded(astro):
    """With exclusion off, the reference moment is its own best match (~0°)."""
    ref = datetime(2015, 6, 1, 0, tzinfo=UTC)
    pairs = [("mars", "jupiter"), ("venus", "saturn")]
    matches = find_similar_configurations(
        astro, ref, pairs, start=2014, end=2017,
        step_days=2.0, top_n=5, exclude_within_days=0.0,
    )
    assert len(matches) >= 1
    # best match sits essentially on the reference with near-zero distance
    assert matches[0].distance < 0.5
    assert abs(matches[0].tt - astro.time(ref).tt) < 3.0


def test_exclusion_removes_the_reference(astro):
    ref = datetime(2015, 6, 1, 0, tzinfo=UTC)
    pairs = [("mars", "jupiter"), ("venus", "saturn")]
    matches = find_similar_configurations(
        astro, ref, pairs, start=2010, end=2020,
        step_days=2.0, top_n=10, exclude_within_days=30.0,
    )
    ref_tt = astro.time(ref).tt
    assert all(abs(m.tt - ref_tt) > 30.0 for m in matches)


def test_results_sorted_and_deduped(astro):
    ref = datetime(2000, 1, 1, 0, tzinfo=UTC)
    pairs = [("mars", "saturn")]
    matches = find_similar_configurations(
        astro, ref, pairs, start=1990, end=2010,
        step_days=3.0, top_n=8, min_separation_days=90.0,
    )
    dists = [m.distance for m in matches]
    assert dists == sorted(dists)
    # all matches are separated by at least the min separation
    tts = sorted(m.tt for m in matches)
    assert all(tts[i + 1] - tts[i] >= 90.0 for i in range(len(tts) - 1))


def test_aspect_pairs_excludes_moon(astro):
    aspects = AspectEngine(astro)
    when = datetime(2020, 12, 21, 18, tzinfo=UTC)
    pairs = aspect_pairs(aspects, when, vertex="earth")
    assert all("moon" not in p for p in pairs)
    # the great conjunction pair should be among current aspects
    assert ("jupiter", "saturn") in pairs or ("saturn", "jupiter") in pairs


def test_empty_pairs_rejected(astro):
    with pytest.raises(ValueError):
        find_similar_configurations(astro, 2000, [], start=1999, end=2001)


# -- aspect-overlap (count-based) search -------------------------------------


@pytest.fixture(scope="module")
def aspects(astro):
    return AspectEngine(astro)


def test_reference_aspect_set_excludes_moon(astro, aspects):
    when = datetime(2020, 12, 21, 18, tzinfo=UTC)
    ref = reference_aspect_set(aspects, when, vertex="earth")
    assert len(ref) > 0
    assert all("moon" not in (a, b) for (a, b, _n, _ang) in ref)
    # each entry is (body_a, body_b, aspect_name, angle)
    assert all(isinstance(name, str) for (_a, _b, name, _ang) in ref)


def test_self_match_reproduces_all_aspects(astro, aspects):
    """Searching a window around the reference (exclusion off) finds a moment
    that reproduces every reference aspect."""
    ref = datetime(2005, 3, 1, 0, tzinfo=UTC)
    refset = reference_aspect_set(aspects, ref, vertex="earth")
    matches = find_aspect_overlap(
        astro, aspects, ref, start=2005, end=2006,
        reference_aspects=refset, step_days=1.0, top_n=3,
        exclude_within_days=0.0, min_separation_days=10.0,
    )
    assert matches[0].n_matched == len(refset)
    assert matches[0].n_reference == len(refset)


def test_overlap_ranked_by_match_count(astro, aspects):
    ref = datetime(2000, 1, 1, 0, tzinfo=UTC)
    matches = find_aspect_overlap(
        astro, aspects, ref, start=1900, end=2100,
        step_days=3.0, top_n=8, exclude_within_days=365.0,
    )
    counts = [m.n_matched for m in matches]
    assert counts == sorted(counts, reverse=True)  # non-increasing
    # every reported match shares at least one aspect, and matched aspects are
    # genuinely within orb (orb recorded per matched aspect)
    for m in matches:
        assert m.n_matched >= 1
        assert m.n_matched <= m.n_reference
        assert len(m.matched) == m.n_matched
        # matched entries are SharedAspect objects within orb
        assert all(s.orb >= 0 for s in m.matched)
        assert m.shared_aspects == m.matched


def test_overlap_excludes_reference_window(astro, aspects):
    ref = datetime(2000, 6, 1, 0, tzinfo=UTC)
    matches = find_aspect_overlap(
        astro, aspects, ref, start=1995, end=2005,
        step_days=3.0, top_n=5, exclude_within_days=200.0,
    )
    ref_tt = astro.time(ref).tt
    assert all(abs(m.tt - ref_tt) > 200.0 for m in matches)


def test_overlap_empty_reference_rejected(astro, aspects):
    ref = datetime(2000, 1, 1, tzinfo=UTC)
    with pytest.raises(ValueError):
        find_aspect_overlap(astro, aspects, ref, start=1999, end=2001,
                            reference_aspects=[])
