"""Tests for the FastAPI backend (orrery.web), pinned to the small de440s kernel."""

import math
from pathlib import Path

import pytest

fastapi = pytest.importorskip("fastapi")
from fastapi.testclient import TestClient  # noqa: E402

from orrery import web  # noqa: E402

BODIES = ["mercury", "venus", "earth", "mars", "jupiter", "saturn", "uranus", "neptune", "pluto", "moon"]


@pytest.fixture(scope="module")
def client():
    app = web.create_app(ephemeris="de440s.bsp")
    with TestClient(app) as c:
        yield c


def test_calendar_roundtrip():
    assert web.jd_from_civil(2000, 1, 1, 12) == 2451545.0
    assert web.civil_from_jd(2451545.0) == (2000, 1, 1, 12, 0, 0)
    assert web.iso_from_jd(2451545.0) == "2000-01-01T12:00:00Z"
    jd = web.jd_from_iso("-0587-03-12T00:00:00Z")
    assert web.iso_from_jd(jd) == "-0587-03-12T00:00:00Z"
    assert web.jd_from_iso("2020-12-21T18:00:00Z") == 2459205.25
    assert web.jd_from_iso("2020-12-21T13:00:00-05:00") == 2459205.25


def test_range_returns_floats(client):
    r = client.get("/api/range")
    assert r.status_code == 200
    body = r.json()
    assert body["ephemeris"] == "de440s.bsp"
    assert isinstance(body["jd_min"], float) and isinstance(body["jd_max"], float)
    assert body["jd_min"] < 2451545.0 < body["jd_max"]


def test_positions_j2000(client):
    r = client.get("/api/positions", params={"jd": 2451545.0})
    assert r.status_code == 200
    body = r.json()
    assert body["jd"] == 2451545.0
    assert body["iso"] == "2000-01-01T12:00:00Z"
    assert body["frame"] == "heliocentric-ecliptic-j2000-au"
    assert body["ephemeris"] == "de440s.bsp"
    assert set(body["bodies"]) == set(BODIES)
    for name in BODIES:
        rec = body["bodies"][name]
        for key in ("x", "y", "z", "lon", "lat", "r"):
            assert math.isfinite(rec[key]), (name, key)
        assert 0.0 <= rec["lon"] < 360.0
    earth = body["bodies"]["earth"]
    assert abs(earth["lon"] - 100.4) < 0.5
    assert abs(earth["r"] - 0.983) < 0.01
    moon = body["bodies"]["moon"]
    assert 0.0023 < moon["r"] < 0.0028


def test_iso_matches_jd(client):
    a = client.get("/api/positions", params={"iso": "2020-12-21T18:00:00Z"}).json()
    b = client.get("/api/positions", params={"jd": 2459205.25}).json()
    assert a["jd"] == b["jd"] == 2459205.25
    assert a["bodies"] == b["bodies"]
    assert abs(a["bodies"]["jupiter"]["lon"] - 303.0) < 4.0
    assert abs(a["bodies"]["saturn"]["lon"] - 302.0) < 4.0


def test_out_of_range_jd(client):
    r = client.get("/api/positions", params={"jd": 1000000.0})
    assert r.status_code == 400
    assert "detail" in r.json()
    r = client.get("/api/positions", params={"jd": 9000000.0})
    assert r.status_code == 400


def test_bad_input(client):
    assert client.get("/api/positions", params={"iso": "not-a-date"}).status_code == 400
    assert client.get("/api/positions", params={"iso": "2020-13-01T00:00:00Z"}).status_code == 400
    assert client.get("/api/positions").status_code == 400
    assert client.get("/api/positions", params={"jd": 2451545.0, "iso": "2000-01-01T12:00:00Z"}).status_code == 400
    for bad in ("abc", "", "nan", "inf", "1e400"):
        r = client.get("/api/positions", params={"jd": bad})
        assert r.status_code == 400, bad
        assert isinstance(r.json()["detail"], str), bad


def test_jd_accepts_numeric_strings(client):
    r = client.get("/api/positions", params={"jd": " 2451545 "})
    assert r.status_code == 200
    assert r.json()["jd"] == 2451545.0
    r = client.get("/api/positions", params={"jd": "2.451545e6"})
    assert r.status_code == 200
    assert r.json()["jd"] == 2451545.0


def test_index_html(client):
    if not (web.WEB_DIR / "index.html").exists():
        pytest.skip("web/index.html not present")
    r = client.get("/")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/html")
