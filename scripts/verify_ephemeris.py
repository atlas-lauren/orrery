#!/usr/bin/env python
"""Verify web/ephemeris.js against the project's Skyfield/JPL engine.

Runs a Node harness that evaluates the browser ephemeris on a grid of dates,
computes the same heliocentric ecliptic-J2000 positions (and the geocentric
Moon) with orrery.astro.AstroEngine on DE441, and prints per-body maximum
angular and relative-distance errors split by JPL element set.

Usage:  .venv/bin/python scripts/verify_ephemeris.py
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

from skyfield.framelib import ecliptic_J2000_frame  # noqa: E402

from orrery.astro import AstroEngine, PLANETS  # noqa: E402

EPHEMERIS_JS = os.path.join(ROOT, "web", "ephemeris.js")

NODE_HARNESS = r"""
const E = require(process.argv[1]);
const dates = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const out = dates.map(([y, m, d, hh, mi]) => {
  const jd = E.jdFromCivil(y, m, d, hh, mi, 0);
  const civil = E.civilFromJd(jd);
  return { civil: [y, m, d, hh, mi], jd, roundtrip: civil, deltaT: E.deltaT(jd),
           set: E.elementSet(jd), bodies: E.all(jd) };
});
process.stdout.write(JSON.stringify(out));
"""

# Thresholds (degrees). Jupiter and Saturn in the 1800-2050 set use the
# accuracy JPL documents for Table 1 (400" and 600" max, i.e. 0.11 and 0.17
# deg, from the uncaptured Jupiter-Saturn great inequality) plus a margin;
# the residual there oscillates in sign with a ~20-year period and zero mean.
LIMITS = {
    "jpl-1800-2050": {
        "mercury": 0.05, "venus": 0.05, "earth": 0.05, "mars": 0.05,
        "jupiter": 0.15, "saturn": 0.25, "uranus": 0.1, "neptune": 0.1,
        "pluto": 0.3, "moon": 0.3,
    },
    "jpl-3000bc-3000ad": {
        "mercury": 0.5, "venus": 0.5, "earth": 0.5, "mars": 0.5,
        "jupiter": 0.5, "saturn": 0.5, "uranus": 0.5, "neptune": 0.5,
        "pluto": 2.0, "moon": 0.3,
    },
}


def date_grid() -> list[list[int]]:
    grid: list[list[int]] = []
    for year in range(1800, 2051, 7):
        grid.append([year, 1, 1, 0, 0])
    grid.append([2026, 9, 26, 0, 0])
    grid.append([2020, 12, 21, 18, 0])
    for year in range(-3000, 3001, 250):
        grid.append([year, 1, 1, 0, 0])
    return grid


def run_node(dates: list[list[int]]) -> list[dict]:
    proc = subprocess.run(
        ["node", "-e", NODE_HARNESS, EPHEMERIS_JS],
        input=json.dumps(dates),
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(proc.stdout)


def angle_deg(a: np.ndarray, b: np.ndarray) -> float:
    cross = np.linalg.norm(np.cross(a, b))
    dot = float(np.dot(a, b))
    return math.degrees(math.atan2(cross, dot))


def lon_diff_deg(a: np.ndarray, b: np.ndarray) -> float:
    la = math.degrees(math.atan2(a[1], a[0]))
    lb = math.degrees(math.atan2(b[1], b[0]))
    return abs((la - lb + 180.0) % 360.0 - 180.0)


def main() -> int:
    dates = date_grid()
    js = run_node(dates)

    engine = AstroEngine(ephemeris="de441.bsp")
    eph = engine.eph
    sun = eph["sun"]
    earth = eph["earth"]
    moon = eph["moon"]

    calendar_bad = 0
    for rec in js:
        c = rec["roundtrip"]
        y, m, d, hh, mi = rec["civil"]
        if (c["year"], c["month"], c["day"], c["hour"], c["minute"]) != (y, m, d, hh, mi):
            calendar_bad += 1
            print("calendar round-trip mismatch", rec["civil"], c)

    # stats[set][body] = {"ang": [], "rel": [], "lon": []}
    stats: dict[str, dict[str, dict[str, list[float]]]] = {}
    worst: dict[tuple[str, str], tuple[float, list[int]]] = {}
    dt_diff_max = 0.0

    for rec in js:
        jd_tt = rec["jd"] + rec["deltaT"] / 86400.0
        t = engine.time(engine.ts.tt_jd(jd_tt))
        # Skyfield's own TT for this UT, for information only.
        t_sf = engine.ts.ut1_jd(rec["jd"])
        dt_diff_max = max(dt_diff_max, abs((t_sf.tt - jd_tt) * 86400.0))
        set_name = rec["set"]
        bucket = stats.setdefault(set_name, {})

        def record(body: str, ref: np.ndarray, got: dict) -> None:
            v = np.array([got["x"], got["y"], got["z"]])
            ang = angle_deg(ref, v)
            rel = abs(np.linalg.norm(v) - np.linalg.norm(ref)) / np.linalg.norm(ref)
            lon = lon_diff_deg(ref, v)
            s = bucket.setdefault(body, {"ang": [], "rel": [], "lon": []})
            s["ang"].append(ang)
            s["rel"].append(rel)
            s["lon"].append(lon)
            key = (set_name, body)
            if key not in worst or ang > worst[key][0]:
                worst[key] = (ang, rec["civil"])

        for body in PLANETS:
            target = engine._target(body)
            ref = (target - sun).at(t).frame_xyz(ecliptic_J2000_frame).au
            record(body, np.asarray(ref, dtype=float), rec["bodies"][body])

        ref_moon = (moon - earth).at(t).frame_xyz(ecliptic_J2000_frame).au
        record("moon", np.asarray(ref_moon, dtype=float), rec["bodies"]["moon"])

    print(f"reference: {engine.ephemeris_name}; {len(js)} dates; "
          f"calendar round-trip mismatches: {calendar_bad}; "
          f"max |TT(Skyfield) - TT(Espenak-Meeus)| = {dt_diff_max:.1f} s")
    print()
    failures = 0
    for set_name in ("jpl-1800-2050", "jpl-3000bc-3000ad"):
        if set_name not in stats:
            continue
        n = len(next(iter(stats[set_name].values()))["ang"])
        print(f"element set {set_name}  ({n} dates)")
        print(f"  {'body':<8} {'max ang deg':>12} {'mean ang':>10} {'max lon deg':>12} "
              f"{'max rel r':>10} {'limit':>6} {'ok':>3}   worst date")
        for body in list(PLANETS) + ["moon"]:
            s = stats[set_name][body]
            max_ang = max(s["ang"])
            mean_ang = sum(s["ang"]) / len(s["ang"])
            max_lon = max(s["lon"])
            max_rel = max(s["rel"])
            limit = LIMITS[set_name][body]
            metric = max_lon if body == "moon" else max_ang
            ok = metric <= limit
            failures += 0 if ok else 1
            w = worst[(set_name, body)][1]
            print(f"  {body:<8} {max_ang:12.4f} {mean_ang:10.4f} {max_lon:12.4f} "
                  f"{max_rel:10.5f} {limit:6.2f} {'yes' if ok else 'NO':>3}   "
                  f"{w[0]:05d}-{w[1]:02d}-{w[2]:02d} {w[3]:02d}:{w[4]:02d}")
        print()

    print(f"overall: {'PASS' if failures == 0 else 'FAIL'} ({failures} bodies over limit)")
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
