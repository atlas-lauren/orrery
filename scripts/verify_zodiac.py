#!/usr/bin/env python
"""Verify the browser zodiac (geocentric tropical longitudes) against the engine.

A Node harness evaluates web/ephemeris.js on a set of UT instants:
Ephemeris.geocentric(body, jd) for the J2000 geocentric vector, then
Ephemeris.tropicalLongitude(lon, jd) for the longitude from the mean equinox of
date, and Ephemeris.zodiacSign for the sign. The reference is the project's own
astrology engine, orrery.astro.AstroEngine.position(body, when, vertex='earth',
zodiac='tropical') on DE441 (Skyfield, apparent place, true ecliptic and equinox
of date), whose BodyPosition.sign is compared with the JS sign name.

Tolerances (wrapped longitude difference, degrees):
  * Sun, Mercury, Venus, Mars in the JPL 1800-2050 element set: 0.05
  * Jupiter and Saturn in that set: 0.2 and 0.3, the geocentric reflection of
    the accuracy JPL documents for Table 1 (400" and 600" from the uncaptured
    great inequality; see verify_ephemeris.py), which the 0.05 figure cannot
    hold for these two
  * Uranus, Neptune, Pluto in that set: 0.1, 0.1, 0.3
  * every planet and the Sun outside 1800-2050 (JPL 3000 BC - 3000 AD set): 0.3,
    except Saturn: 0.5, the heliocentric limit verify_ephemeris.py uses for that
    set (Saturn's Table 2a longitude is off by 0.34 deg geocentric in 500 BC)
  * the Moon everywhere: 0.3 (truncated Meeus theory and delta T differences)
A sign mismatch is a failure unless the reference longitude lies within the
body's tolerance of a 30-degree boundary, in which case it is reported as a
boundary case.

Usage:  .venv/bin/python scripts/verify_zodiac.py
"""

from __future__ import annotations

import json
import math
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from orrery.astro import AstroEngine  # noqa: E402

EPHEMERIS_JS = os.path.join(ROOT, "web", "ephemeris.js")

BODIES = ["sun", "moon", "mercury", "venus", "mars", "jupiter", "saturn", "uranus", "neptune", "pluto"]

# UT instants: [year, month, day, hour, minute], proleptic Gregorian,
# astronomical year numbering.
DATES = [
    [-500, 3, 20, 12, 0],
    [1000, 1, 1, 6, 0],
    [1600, 7, 15, 18, 0],
    [2000, 1, 1, 12, 0],
    [2026, 10, 31, 15, 0],
    [2026, 11, 15, 0, 0],
    [2500, 12, 25, 20, 0],
    [2999, 6, 30, 3, 0],
]

NODE_HARNESS = r"""
const E = require(process.argv[1]);
const input = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const rows = input.dates.map(([y, m, d, hh, mi]) => {
  const jd = E.jdFromCivil(y, m, d, hh, mi, 0);
  const bodies = {};
  for (const body of input.bodies) {
    const g = E.geocentric(body, jd);
    const tropical = E.tropicalLongitude(g.lon, jd);
    const sign = E.zodiacSign(tropical);
    bodies[body] = { lonJ2000: g.lon, lat: g.lat, r: g.r, tropical, sign: sign.name, glyph: sign.glyph,
                     degrees: sign.degrees, index: sign.index };
  }
  return { civil: [y, m, d, hh, mi], jd, set: E.elementSet(jd), deltaT: E.deltaT(jd),
           equinox: E.equinoxLongitude(jd), bodies };
});
// Fixed-point checks of the zodiac helpers themselves.
const checks = {
  j2000Equinox: E.equinoxLongitude(2451545.0),
  signs: E.ZODIAC.map((s) => s.name + ' ' + s.glyph),
  sign0: E.zodiacSign(0), sign29_99: E.zodiacSign(29.99), sign30: E.zodiacSign(30), sign359_9: E.zodiacSign(359.9),
  signNeg: E.zodiacSign(-10), sign720: E.zodiacSign(720 + 218.2),
  tropicalWrap: E.tropicalLongitude(359.9, 2461345.125),
  earthThrows: (() => { try { E.geocentric('earth', 2451545.0); return false; } catch (e) { return true; } })()
};
process.stdout.write(JSON.stringify({ rows, checks }));
"""

SHORT_SET = "jpl-1800-2050"
SHORT_LIMITS = {
    "sun": 0.05, "mercury": 0.05, "venus": 0.05, "mars": 0.05,
    "jupiter": 0.2, "saturn": 0.3, "uranus": 0.1, "neptune": 0.1, "pluto": 0.3,
    "moon": 0.3,
}
LONG_LIMIT = 0.3
LONG_LIMITS = {"saturn": 0.5}   # JPL Table 2a accuracy, as in verify_ephemeris.py
MOON_LIMIT = 0.3

SIGNS = ("Aries", "Taurus", "Gemini", "Cancer", "Leo", "Virgo",
         "Libra", "Scorpio", "Sagittarius", "Capricorn", "Aquarius", "Pisces")
GLYPHS = "♈♉♊♋♌♍♎♏♐♑♒♓"


def limit_for(body: str, element_set: str) -> float:
    if body == "moon":
        return MOON_LIMIT
    if element_set == SHORT_SET:
        return SHORT_LIMITS[body]
    return LONG_LIMITS.get(body, LONG_LIMIT)


def wrap180(deg: float) -> float:
    return (deg + 180.0) % 360.0 - 180.0


def fmt_date(c: list[int]) -> str:
    y, m, d, hh, mi = c
    return f"{y:05d}-{m:02d}-{d:02d} {hh:02d}:{mi:02d}"


def run_node() -> dict:
    proc = subprocess.run(
        ["node", "-e", NODE_HARNESS, EPHEMERIS_JS],
        input=json.dumps({"dates": DATES, "bodies": BODIES}),
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(proc.stdout)


def main() -> int:
    js = run_node()
    failures: list[str] = []
    boundary_notes: list[str] = []

    # --- helper fixed points -------------------------------------------------
    c = js["checks"]
    print("zodiac helpers (web/ephemeris.js)")
    print(f"  equinoxLongitude(J2000) = {c['j2000Equinox']:.3e} deg   expect 0 within 1e-6")
    if abs(c["j2000Equinox"]) > 1e-6:
        failures.append("equinoxLongitude is not 0 at J2000")
    expected_signs = [f"{n} {g}" for n, g in zip(SIGNS, GLYPHS)]
    print(f"  ZODIAC table: {' '.join(s.split()[1] for s in c['signs'])}   "
          f"{'matches' if c['signs'] == expected_signs else 'MISMATCH'}")
    if c["signs"] != expected_signs:
        failures.append("Ephemeris.ZODIAC names/glyphs differ from the contract")
    sign_cases = [
        ("zodiacSign(0)", c["sign0"], "Aries", 0, 0.0),
        ("zodiacSign(29.99)", c["sign29_99"], "Aries", 0, 29.99),
        ("zodiacSign(30)", c["sign30"], "Taurus", 1, 0.0),
        ("zodiacSign(359.9)", c["sign359_9"], "Pisces", 11, 29.9),
        ("zodiacSign(-10)", c["signNeg"], "Pisces", 11, 20.0),
        ("zodiacSign(938.2)", c["sign720"], "Scorpio", 7, 8.2),
    ]
    for label, got, name, index, degrees in sign_cases:
        ok = got["name"] == name and got["index"] == index and abs(got["degrees"] - degrees) < 1e-9
        print(f"  {label:<18} -> {got['glyph']} {got['name']:<11} {got['degrees']:6.2f} deg   {'ok' if ok else 'WRONG'}")
        if not ok:
            failures.append(f"{label} gave {got}")
    print(f"  tropicalLongitude(359.9, 2026-10-31) = {c['tropicalWrap']:.4f} (wrapped into [0, 360): "
          f"{'ok' if 0.0 <= c['tropicalWrap'] < 360.0 else 'WRONG'})")
    if not (0.0 <= c["tropicalWrap"] < 360.0):
        failures.append("tropicalLongitude did not wrap into [0, 360)")
    print(f"  geocentric('earth') throws: {'yes' if c['earthThrows'] else 'NO'}")
    if not c["earthThrows"]:
        failures.append("geocentric('earth') did not throw")
    print()

    # --- reference engine ----------------------------------------------------
    engine = AstroEngine(ephemeris="de441.bsp")
    ts = engine.ts

    hdr = (f"{'UT instant':<17} {'set':<18} {'equinox':>8} {'body':<8} {'js J2000':>9} {'js trop':>9} "
           f"{'sf trop':>9} {'|diff|':>7} {'lim':>5} {'ok':>3}  {'js sign':<14} {'sf sign':<14} {'same':>4}")
    print(f"geocentric tropical longitudes: web/ephemeris.js vs AstroEngine ({engine.ephemeris_name}, "
          f"vertex=earth, zodiac=tropical, apparent)")
    print(hdr)
    print("-" * len(hdr))

    worst: dict[str, tuple[float, str]] = {}
    sun_2026 = None
    for rec in js["rows"]:
        jd = rec["jd"]
        t = ts.ut1_jd(jd)
        element_set = rec["set"]
        date = fmt_date(rec["civil"])
        for body in BODIES:
            ref = engine.position(body, t, vertex="earth", zodiac="tropical")
            got = rec["bodies"][body]
            diff = abs(wrap180(got["tropical"] - ref.longitude))
            lim = limit_for(body, element_set)
            ok = diff <= lim
            same = got["sign"] == ref.sign
            if not ok:
                failures.append(f"{body} off by {diff:.3f} deg at {date} (limit {lim})")
            if not same:
                to_boundary = min(ref.longitude % 30.0, 30.0 - ref.longitude % 30.0)
                if to_boundary <= lim:
                    boundary_notes.append(
                        f"{body} at {date}: engine {ref.sign} {ref.sign_degrees:.2f}, js {got['sign']} "
                        f"{got['degrees']:.2f}; {to_boundary:.3f} deg from the boundary, within the {lim} deg tolerance")
                else:
                    failures.append(f"{body} sign {got['sign']} != engine {ref.sign} at {date}")
            key = body
            if key not in worst or diff > worst[key][0]:
                worst[key] = (diff, date)
            if body == "sun" and rec["civil"][:3] == [2026, 10, 31]:
                sun_2026 = (got["tropical"], got["sign"], got["degrees"], ref.longitude)
            print(f"{date:<17} {element_set:<18} {rec['equinox']:8.3f} {body:<8} {got['lonJ2000']:9.3f} "
                  f"{got['tropical']:9.3f} {ref.longitude:9.3f} {diff:7.3f} {lim:5.2f} {'yes' if ok else 'NO':>3}  "
                  f"{got['glyph'] + ' ' + got['sign']:<14} {GLYPHS[SIGNS.index(ref.sign)] + ' ' + ref.sign:<14} "
                  f"{'yes' if same else 'NO':>4}")
        print()

    print("worst wrapped difference per body (deg):")
    for body in BODIES:
        d, when = worst[body]
        print(f"  {body:<8} {d:7.3f}   at {when}")
    print()

    if sun_2026 is not None:
        trop, sign, degrees, ref_lon = sun_2026
        ok = abs(trop - 218.0) < 1.0 and sign == "Scorpio" and 7.0 <= degrees <= 9.0
        print(f"2026-10-31 15:00 UT Sun: js tropical {trop:.3f} deg = {sign} {degrees:.2f} deg "
              f"(engine {ref_lon:.3f})   expect about 218 deg, Scorpio about 8 deg: {'ok' if ok else 'WRONG'}")
        if not ok:
            failures.append("Sun on 2026-10-31 is not about 218 deg / Scorpio 8 deg")
        print()

    # --- sign of the equinox correction ---------------------------------------
    # The mean equinox of date regresses, so its J2000 longitude must be negative
    # after J2000 and positive before; a systematic offset of twice the equinox
    # longitude between js and the engine would mean the correction was applied
    # with the wrong sign.
    for rec in js["rows"]:
        year = rec["civil"][0]
        eq = rec["equinox"]
        if (year > 2000 and eq >= 0) or (year < 2000 and eq <= 0):
            failures.append(f"equinoxLongitude has the wrong sign at {fmt_date(rec['civil'])}: {eq:.3f}")
    print("columns: equinox = J2000 ecliptic longitude of the mean equinox of date (deg); "
          "js J2000 = geocentric ecliptic J2000 longitude; js trop / sf trop = tropical longitude from "
          "web/ephemeris.js and from the engine; |diff| wrapped to [0, 180]")
    print()
    if boundary_notes:
        print("sign-boundary cases (not failures):")
        for note in boundary_notes:
            print("  " + note)
        print()
    if failures:
        for f in failures:
            print("FAIL:", f)
    print(f"overall: {'PASS' if not failures else 'FAIL'} ({len(failures)} failures, "
          f"{len(boundary_notes)} boundary cases)")
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(main())
