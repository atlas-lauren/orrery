#!/usr/bin/env python3
"""Verify web/moons.js against JPL Horizons.

For every moon in Moons.NAMES the script evaluates moons.js in Node at a set
of UT Julian dates, converts each date to TT exactly as moons.js does
(Moons.ttFromUt), asks the Horizons API for the parent-centric ecliptic-J2000
state vector of the same satellite at those TDB instants (TDB ~ TT), and
prints the angular error between the two parent-centric vectors and the
relative distance error at each date.

Python 3 standard library only (json, math, subprocess, urllib). Node must be
on PATH. Horizons is queried once per moon, sequentially, with a short pause,
per the SSD API fair-use policy; pass --cache FILE to store the raw responses
and reuse them on later runs. Requests go through urllib; if this Python has
no usable CA bundle (a python.org build on macOS before "Install
Certificates.command" has been run rejects every HTTPS host with
CERTIFICATE_VERIFY_FAILED) the script says so once and fetches with the
system curl instead, which trusts the macOS keychain.

If Horizons cannot be reached the script says so explicitly and falls back to
internal consistency checks (period versus mean motion, |r| within
a(1-e)..a(1+e), orbit normal within the inclination of the expected pole).

Usage:  python3 scripts/verify_moons.py [--cache FILE] [--dates JD,JD,...]
Exit status: 0 all moons pass, 1 some fail, 2 Horizons unreachable (internal
checks only).
"""

from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB = os.path.join(ROOT, "web")
MOONS_JS = os.path.join(WEB, "moons.js")
EPHEMERIS_JS = os.path.join(WEB, "ephemeris.js")

HORIZONS_URL = "https://ssd.jpl.nasa.gov/api/horizons.api"
USER_AGENT = "orrery-verify-moons/1.0 (https://github.com/atlas-lauren/orrery)"

# UT Julian dates: J2000, 2010-01-01, 2020-05-31, 2028-08-16, 1900-01-01.
DEFAULT_DATES = [2451545.0, 2455197.5, 2459000.5, 2462000.5, 2415020.5]

# Pass limits in degrees: "modern" = every date on or after 1950; "old" = the
# rest (a century from the epoch). Distance limit is a relative error.
LIMIT_MODERN_DEG = 5.0
LIMIT_OLD_DEG = 12.0
LIMIT_REL_DIST = 0.05
JD_1950 = 2433282.5

NODE_HARNESS = r"""
const path = process.argv[1];
const E = require(path + '/ephemeris.js');
globalThis.Ephemeris = E;
const M = require(path + '/moons.js');
const dates = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const out = { names: M.NAMES, parentId: M.PARENT_JPL_ID, moons: {}, dates: [] };
for (const jd of dates) out.dates.push({ jdUT: jd, jdTT: M.ttFromUt(jd), deltaT: M.deltaT(jd) });
for (const name of M.NAMES) {
  const d = M.DATA[name];
  const rec = { parent: d.parent, jplId: d.jplId, aKm: d.aKm, e: d.e, periodDays: d.periodDays,
                nDegPerDay: d.nDegPerDay, omegaDot: d.omegaDotDegPerDay, nodeDot: d.nodeDotDegPerDay,
                inclinationDeg: d.inclinationDeg, retrograde: d.retrograde, pos: [] };
  for (const jd of dates) rec.pos.push(M.position(name, jd));
  const pts = M.orbitPoints(name, dates[0], 128);
  rec.orbit = pts.map(p => [p.x, p.y, p.z]);
  rec.pole = M.poleEcliptic(d.parent);
  rec.refPole = M.icrfToEcliptic(d.poleRa, d.poleDec);
  out.moons[name] = rec;
}
process.stdout.write(JSON.stringify(out));
"""


def run_node(dates: list[float]) -> dict:
    proc = subprocess.run(
        ["node", "-e", NODE_HARNESS, WEB],
        input=json.dumps(dates),
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        sys.stderr.write(proc.stderr)
        raise SystemExit("node harness failed")
    return json.loads(proc.stdout)


_TRANSPORT = "urllib"  # becomes "curl" after Python's trust store rejects the host


def fetch_json(url: str) -> dict:
    """GET url and parse the JSON body.

    urllib first. If the TLS handshake fails only because this Python has no
    CA bundle to verify the server against, switch to the system curl for the
    rest of the run; curl verifies the same chain against the OS keychain, so
    certificate checking is not weakened, just done by a different client.
    """
    global _TRANSPORT
    if _TRANSPORT == "urllib":
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.URLError as err:
            if not isinstance(err.reason, ssl.SSLCertVerificationError) or not shutil.which("curl"):
                raise
            host = urllib.parse.urlsplit(url).netloc
            print(f"python's SSL trust store cannot verify {host} ({err.reason.verify_message}); "
                  "fetching with the system curl instead")
            _TRANSPORT = "curl"
    proc = subprocess.run(
        ["curl", "-sS", "--fail", "--max-time", "120", "-A", USER_AGENT, url],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise urllib.error.URLError(f"curl exit {proc.returncode}: {proc.stderr.strip()}")
    return json.loads(proc.stdout)


def horizons_vectors(sat_id: int, parent_id: int, jd_tt: list[float]) -> list[dict]:
    """Parent-centric ecliptic-J2000 vectors (AU) at the given TDB Julian dates."""
    params = {
        "format": "json",
        "COMMAND": f"'{sat_id}'",
        "OBJ_DATA": "'NO'",
        "MAKE_EPHEM": "'YES'",
        "EPHEM_TYPE": "'VECTORS'",
        "CENTER": f"'500@{parent_id}'",
        "REF_PLANE": "'ECLIPTIC'",
        "REF_SYSTEM": "'ICRF'",
        "OUT_UNITS": "'AU-D'",
        "VEC_TABLE": "'1'",
        "CSV_FORMAT": "'YES'",
        "TLIST": "'" + " ".join(f"{t:.9f}" for t in jd_tt) + "'",
    }
    url = HORIZONS_URL + "?" + urllib.parse.urlencode(params)
    last_err: Exception | None = None
    for attempt in range(3):
        try:
            payload = fetch_json(url)
            break
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError) as err:
            last_err = err
            time.sleep(3.0 * (attempt + 1))
    else:
        raise ConnectionError(f"Horizons unreachable: {last_err}")
    text = payload.get("result", "")
    if "$$SOE" not in text:
        raise ValueError("Horizons returned no data: " + (payload.get("error") or text[:300]))
    rows = []
    for line in text.split("$$SOE")[1].split("$$EOE")[0].strip().splitlines():
        f = [x.strip() for x in line.split(",")]
        rows.append({"jd": float(f[0]), "x": float(f[2]), "y": float(f[3]), "z": float(f[4])})
    # Horizons sorts a TLIST chronologically; callers match rows by JD.
    return rows


def angle_deg(a: list[float], b: list[float]) -> float:
    ax, ay, az = a
    bx, by, bz = b
    cx, cy, cz = ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx
    cross = math.sqrt(cx * cx + cy * cy + cz * cz)
    dot = ax * bx + ay * by + az * bz
    return math.degrees(math.atan2(cross, dot))


def norm(v: list[float]) -> float:
    return math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])


def internal_checks(js: dict) -> int:
    """Consistency checks that need no network. Returns the failure count."""
    failures = 0
    print("internal consistency checks (no Horizons):")
    print(f"  {'moon':10s} {'P vs rate':>9s} {'|r| in [q,Q]':>12s} {'normal vs pole':>14s} {'i':>6s}  ok")
    for name in js["names"]:
        rec = js["moons"][name]
        # 1. periodDays is the sidereal period of the spatial longitude:
        #    360/P must equal |nodeDot + sign(cos i) (n + omegaDot)|.
        s = 1.0 if math.cos(math.radians(rec["inclinationDeg"])) >= 0 else -1.0
        rate = abs(rec["nodeDot"] + s * (rec["nDegPerDay"] + rec["omegaDot"]))
        p_ok = abs(360.0 / rate - rec["periodDays"]) < 1e-6 * rec["periodDays"]
        # 2. every sampled distance lies between periapsis and apoapsis.
        a_au = rec["aKm"] / 149597870.7
        e = rec["e"]
        r_ok = True
        for pt in rec["orbit"] + [[p["x"], p["y"], p["z"]] for p in rec["pos"]]:
            r = norm(pt)
            if not (a_au * (1 - e) * (1 - 1e-6) <= r <= a_au * (1 + e) * (1 + 1e-6)):
                r_ok = False
        # 3. the orbit normal (from the sampled loop) is within the tabulated
        #    inclination (+ a small margin) of the reference-plane pole, and
        #    retrograde moons point the other way.
        pts = rec["orbit"]
        nx = ny = nz = 0.0
        for k in range(len(pts)):
            p1 = pts[k]
            p2 = pts[(k + 1) % len(pts)]
            nx += p1[1] * p2[2] - p1[2] * p2[1]
            ny += p1[2] * p2[0] - p1[0] * p2[2]
            nz += p1[0] * p2[1] - p1[1] * p2[0]
        pole = rec["refPole"]
        ang = angle_deg([nx, ny, nz], [pole["x"], pole["y"], pole["z"]])
        n_ok = abs(ang - rec["inclinationDeg"]) < 0.05
        ok = p_ok and r_ok and n_ok
        failures += 0 if ok else 1
        print(f"  {name:10s} {'yes' if p_ok else 'NO':>9s} {'yes' if r_ok else 'NO':>12s} "
              f"{ang:14.3f} {rec['inclinationDeg']:6.1f}  {'yes' if ok else 'NO'}")
    return failures


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--cache", help="JSON file to store/reuse raw Horizons vectors")
    ap.add_argument("--dates", help="comma-separated UT Julian dates (default: %s)" % ",".join(str(d) for d in DEFAULT_DATES))
    ap.add_argument("--pause", type=float, default=1.0, help="seconds between Horizons requests")
    args = ap.parse_args()
    dates = [float(x) for x in args.dates.split(",")] if args.dates else list(DEFAULT_DATES)

    js = run_node(dates)
    jd_tt = [d["jdTT"] for d in js["dates"]]
    print("moons.js evaluated at UT JDs " + ", ".join(f"{d['jdUT']:.1f}" for d in js["dates"])
          + "; TT = UT + deltaT with deltaT = "
          + ", ".join(f"{d['deltaT']:.1f}s" for d in js["dates"]))

    cache: dict = {}
    if args.cache and os.path.exists(args.cache):
        with open(args.cache) as fh:
            cache = json.load(fh)

    horizons: dict[str, list[dict]] = {}
    unreachable = False
    for name in js["names"]:
        rec = js["moons"][name]
        key = f"{rec['jplId']}@{js['parentId'][rec['parent']]}:" + ",".join(f"{t:.6f}" for t in jd_tt)
        if key in cache:
            horizons[name] = cache[key]
            continue
        try:
            rows = horizons_vectors(rec["jplId"], js["parentId"][rec["parent"]], jd_tt)
        except ConnectionError as err:
            print(f"HORIZONS UNREACHABLE while querying {name}: {err}")
            unreachable = True
            break
        except ValueError as err:
            print(f"{name}: {err}")
            continue
        horizons[name] = rows
        cache[key] = rows
        if args.cache:
            with open(args.cache, "w") as fh:
                json.dump(cache, fh)
        time.sleep(args.pause)

    if unreachable or not horizons:
        print("Horizons comparison NOT performed; falling back to internal consistency checks.")
        bad = internal_checks(js)
        print(f"internal checks: {'PASS' if bad == 0 else 'FAIL'} ({bad} moons failing)")
        return 2

    date_labels = [f"{d['jdUT']:.1f}" for d in js["dates"]]
    print()
    print("angular error (deg) between moons.js and Horizons parent-centric vectors, and max relative |r| error")
    print(f"  {'moon':10s} " + " ".join(f"{lbl:>10s}" for lbl in date_labels)
          + f" {'max mod':>8s} {'max old':>8s} {'max rel r':>9s}  result")
    failures = 0
    for name in js["names"]:
        rec = js["moons"][name]
        rows = horizons.get(name)
        if not rows:
            print(f"  {name:10s} no Horizons data")
            failures += 1
            continue
        by_jd = {}
        for row in rows:
            by_jd[round(row["jd"], 5)] = row
        angs = []
        rels = []
        max_modern = 0.0
        max_old = 0.0
        for k, t in enumerate(jd_tt):
            row = by_jd.get(round(t, 5))
            if row is None:
                angs.append(float("nan"))
                rels.append(float("nan"))
                continue
            ref = [row["x"], row["y"], row["z"]]
            got = [rec["pos"][k]["x"], rec["pos"][k]["y"], rec["pos"][k]["z"]]
            ang = angle_deg(ref, got)
            rel = abs(norm(got) - norm(ref)) / norm(ref)
            angs.append(ang)
            rels.append(rel)
            if js["dates"][k]["jdUT"] >= JD_1950:
                max_modern = max(max_modern, ang)
            else:
                max_old = max(max_old, ang)
        max_rel = max(r for r in rels if r == r) if rels else float("nan")
        ok = (max_modern <= LIMIT_MODERN_DEG and max_old <= LIMIT_OLD_DEG and max_rel <= LIMIT_REL_DIST
              and all(a == a for a in angs))
        failures += 0 if ok else 1
        print(f"  {name:10s} " + " ".join(f"{a:10.2f}" for a in angs)
              + f" {max_modern:8.2f} {max_old:8.2f} {max_rel:9.4f}  {'pass' if ok else 'FAIL'}")
    print()
    print(f"limits: {LIMIT_MODERN_DEG:.0f} deg for dates >= 1950, {LIMIT_OLD_DEG:.0f} deg before, "
          f"{LIMIT_REL_DIST * 100:.0f}% in distance")
    print(f"overall: {'PASS' if failures == 0 else 'FAIL'} ({failures} moons over limit)")
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
