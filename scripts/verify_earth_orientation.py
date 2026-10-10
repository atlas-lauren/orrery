#!/usr/bin/env python
"""Verify Ephemeris.earthOrientation / Ephemeris.subsolarPoint against Skyfield.

A Node harness evaluates web/ephemeris.js on a set of UT instants spanning the
app's range; Skyfield (DE441, full IAU 2006/2000A precession-nutation, apparent
Sun, WGS84 subpoint) provides the reference sub-solar point. The mean pole and
equinox of date are also checked directly against Skyfield's IAU 2006
precession matrix, and GMST against Skyfield's sidereal time.

Usage:  .venv/bin/python scripts/verify_earth_orientation.py
"""

from __future__ import annotations

import json
import math
import os
import subprocess
import sys

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from skyfield.api import wgs84  # noqa: E402
from skyfield.framelib import ecliptic_J2000_frame  # noqa: E402
from skyfield.precessionlib import compute_precession  # noqa: E402

from orrery.astro import AstroEngine  # noqa: E402

EPHEMERIS_JS = os.path.join(ROOT, "web", "ephemeris.js")

NODE_HARNESS = r"""
const E = require(process.argv[1]);
const dates = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const out = dates.map(([y, m, d, hh, mi]) => {
  const jd = E.jdFromCivil(y, m, d, hh, mi, 0);
  return { civil: [y, m, d, hh, mi], jd, deltaT: E.deltaT(jd),
           orientation: E.earthOrientation(jd), subsolar: E.subsolarPoint(jd) };
});
const j2000 = E.earthOrientation(2451545.0);
process.stdout.write(JSON.stringify({ rows: out, j2000 }));
"""

# UT instants: [year, month, day, hour, minute] (proleptic Gregorian,
# astronomical year numbering). The mandated set plus the range ends and a few
# mid-range checks.
DATES = [
    [-3000, 1, 1, 0, 0],
    [-1000, 6, 21, 0, 0],
    [-500, 3, 20, 12, 0],
    [1000, 1, 1, 6, 0],
    [1600, 7, 15, 18, 0],
    [1850, 9, 23, 6, 0],
    [1969, 7, 20, 20, 17],
    [2000, 1, 1, 12, 0],
    [2026, 3, 20, 14, 46],
    [2026, 10, 10, 12, 24],
    [2026, 10, 10, 0, 0],
    [2100, 4, 1, 9, 30],
    [2500, 12, 25, 20, 0],
    [2999, 6, 30, 3, 0],
    [3000, 12, 31, 12, 0],
]

ASEC = 3600.0


def limit_for(year: int) -> float:
    return 0.3 if 1600 <= year <= 2500 else 1.5


def run_node(dates: list[list[int]]) -> dict:
    proc = subprocess.run(
        ["node", "-e", NODE_HARNESS, EPHEMERIS_JS],
        input=json.dumps(dates),
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(proc.stdout)


def wrap180(deg: float) -> float:
    return (deg + 180.0) % 360.0 - 180.0


def angle_arcsec(a: np.ndarray, b: np.ndarray) -> float:
    cross = np.linalg.norm(np.cross(a, b))
    dot = float(np.dot(a, b))
    return math.degrees(math.atan2(cross, dot)) * ASEC


def vec(d: dict) -> np.ndarray:
    return np.array([d["x"], d["y"], d["z"]], dtype=float)


def fmt_date(c: list[int]) -> str:
    y, m, d, hh, mi = c
    return f"{y:05d}-{m:02d}-{d:02d} {hh:02d}:{mi:02d}"


def main() -> int:
    js = run_node(DATES)
    failures: list[str] = []

    # --- fixed-point assertions at J2000 -----------------------------------
    o = js["j2000"]
    eq = vec(o["equinox"])
    pole = vec(o["pole"])
    gmst_deg = math.degrees(o["gmst"])
    print("J2000 (jd 2451545.0 UT) checks")
    print(f"  equinox = ({eq[0]:.9f}, {eq[1]:.9f}, {eq[2]:.9f})   expect (1, 0, 0) within 1e-6")
    print(f"  pole    = ({pole[0]:.6f}, {pole[1]:.6f}, {pole[2]:.6f})   expect (0, 0.3978, 0.9175) within 1e-3")
    print(f"  gmst    = {gmst_deg:.6f} deg   expect 280.46062 (18h41m50.55s) within 0.01")
    print(f"  obliquity = {o['obliquityDeg']:.7f} deg, precession = {o['precessionDeg']:.3e} deg")
    if np.max(np.abs(eq - np.array([1.0, 0.0, 0.0]))) > 1e-6:
        failures.append("J2000 equinox is not (1,0,0)")
    if np.max(np.abs(pole - np.array([0.0, 0.3978, 0.9175]))) > 1e-3:
        failures.append("J2000 pole is not (0, 0.3978, 0.9175)")
    if abs(gmst_deg - 280.46062) > 0.01:
        failures.append("J2000 GMST is not 280.46062 deg")
    if abs(float(np.dot(eq, pole))) > 1e-9:
        failures.append("J2000 equinox and pole are not perpendicular")
    print()

    # --- Skyfield reference --------------------------------------------------
    engine = AstroEngine(ephemeris="de441.bsp")
    ts = engine.ts
    eph = engine.eph
    sun = eph["sun"]
    earth = eph["earth"]
    ecl = ecliptic_J2000_frame.rotation_at(ts.J2000)  # ICRS -> ecliptic J2000

    hdr = (f"{'UT instant':<17} {'JD':>12} {'dT js':>7} {'dT sf':>7} "
           f"{'js lat':>8} {'js lon':>9} {'sf lat':>8} {'sf lon':>9} "
           f"{'|dlat|':>7} {'|dlon|':>7} {'lim':>4} {'ok':>3} "
           f"{'pole\"':>6} {'eqnx\"':>6} {'gmst\"':>7} {'perp':>8}")
    print("sub-solar point: web/ephemeris.js vs Skyfield "
          f"({engine.ephemeris_name}, apparent Sun, wgs84.subpoint_of)")
    print(hdr)
    print("-" * len(hdr))

    worst_mid = 0.0
    worst_far = 0.0
    for rec in js["rows"]:
        year = rec["civil"][0]
        jd = rec["jd"]
        t = ts.ut1_jd(jd)
        pos = earth.at(t).observe(sun).apparent()
        sp = wgs84.subpoint_of(pos)
        sf_lat = sp.latitude.degrees
        sf_lon = sp.longitude.degrees
        js_lat = rec["subsolar"]["lat"]
        js_lon = rec["subsolar"]["lon"]
        dlat = abs(js_lat - sf_lat)
        dlon = abs(wrap180(js_lon - sf_lon))
        lim = limit_for(year)
        ok = dlat <= lim and dlon <= lim
        if not ok:
            failures.append(f"sub-solar point off by lat {dlat:.3f} / lon {dlon:.3f} deg at {fmt_date(rec['civil'])}")
        err = max(dlat, dlon)
        if 1600 <= year <= 2500:
            worst_mid = max(worst_mid, err)
        else:
            worst_far = max(worst_far, err)

        # Frame check: mean pole / equinox of date from Skyfield's IAU 2006
        # precession matrix (GCRS -> mean equator & equinox of date), taken
        # into ecliptic J2000 with Skyfield's own ecliptic matrix.
        P = compute_precession(t.tdb)
        sf_pole = ecl @ P.T @ np.array([0.0, 0.0, 1.0])
        sf_eqnx = ecl @ P.T @ np.array([1.0, 0.0, 0.0])
        o = rec["orientation"]
        js_pole = vec(o["pole"])
        js_eqnx = vec(o["equinox"])
        d_pole = angle_arcsec(js_pole, sf_pole)
        d_eqnx = angle_arcsec(js_eqnx, sf_eqnx)
        perp = float(np.dot(js_pole, js_eqnx))
        # GMST check against Skyfield (IAU 2006 GMST, hours).
        sf_gmst_deg = float(t.gmst) * 15.0
        d_gmst = abs(wrap180(math.degrees(o["gmst"]) - sf_gmst_deg)) * ASEC
        if d_pole > 2.0 or d_eqnx > 2.0:
            failures.append(f"pole/equinox of date off by {d_pole:.2f}\" / {d_eqnx:.2f}\" at {fmt_date(rec['civil'])}")
        if d_gmst > 2.0:
            failures.append(f"GMST off by {d_gmst:.2f}\" at {fmt_date(rec['civil'])}")
        if abs(perp) > 1e-9:
            failures.append(f"pole and equinox not perpendicular at {fmt_date(rec['civil'])}")

        print(f"{fmt_date(rec['civil']):<17} {jd:12.3f} {rec['deltaT']:7.0f} {float(t.delta_t):7.0f} "
              f"{js_lat:8.3f} {js_lon:9.3f} {sf_lat:8.3f} {sf_lon:9.3f} "
              f"{dlat:7.3f} {dlon:7.3f} {lim:4.1f} {'yes' if ok else 'NO':>3} "
              f"{d_pole:6.2f} {d_eqnx:6.2f} {d_gmst:7.2f} {perp:8.1e}")

    print()
    print(f"worst sub-solar error 1600-2500: {worst_mid:.3f} deg (limit 0.3); "
          f"outside: {worst_far:.3f} deg (limit 1.5)")
    print("columns: dT = delta T in seconds (js = Espenak-Meeus, sf = Skyfield); "
          "pole\"/eqnx\" = angle between the JS mean pole/equinox of date and "
          "Skyfield's IAU 2006 precession matrix, arcsec; gmst\" = GMST difference "
          "vs Skyfield, arcsec; perp = pole . equinox")
    print()
    if failures:
        for f in failures:
            print("FAIL:", f)
    print(f"overall: {'PASS' if not failures else 'FAIL'} ({len(failures)} failures)")
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(main())
