# Orrery — Astrological Configuration Analysis Engine

A research tool to test whether specific planetary angular configurations recur
around defined classes of historical events, and to explore the geometry
interactively.

This is an **empirical hypothesis-testing project**. It is built to be as
capable of *disproving* a pattern as finding one. Statistical honesty is the
priority: base-rate/Monte-Carlo controls, multiple-comparison accounting, and a
hard wall between discovery and confirmation are first-class features, not
afterthoughts.

## Status

Build is staged (see *Build order* below). **Currently implemented:**

- **Part 1 — Astronomical core** (`orrery/astro.py`): multi-vertex ecliptic
  positions and angular separations via Skyfield + JPL DE440, tropical and
  sidereal longitudes, mean lunar nodes, with day-one sanity tests.
- **Part 2 — Aspect engine** (`orrery/aspects.py`): aspect detection from a
  configurable list/orbs (`orrery/config/aspects.toml`), with applying/
  separating and faster-body for each hit; the multi-vertex census (every
  aspect at every body's vertex); and whole-figure detection (syzygies and
  near-regular polygons — grand trine, grand cross).
- **Part 3 — Event model + time-precision guardrail** (`orrery/events.py`):
  CSV/JSON event loader with timezone conversion, era-agnostic times (BCE
  supported via Skyfield `Time`), and a *hard* guardrail that refuses
  time-sensitive factors (Moon fine position, Ascendant/MC, houses) for events
  whose time is only `day`/`unknown` — and surfaces the refusal in every output.
- **Part 4 — Statistics** (`orrery/stats.py`): Monte-Carlo control test with
  empirical p-values and the full null distribution; the **analytic base rate**
  (`aspect_duty_cycle` — the exact fraction of time an aspect holds, computed by
  a dense ephemeris scan, no sampling) and `assess_shared_aspects`, which bridges
  the reverse search to an exact binomial test; Schuster's test for circular
  phase clustering; and `MultipleComparisons` (Bonferroni + FDR) that tracks the
  comparison count and makes an uncorrected p-value hard to quote.
- **Configuration search** (`orrery/search.py`): two ways to find a moment's
  closest historical recurrences, vectorized over history —
  - `find_aspect_overlap` (**exploratory default**): ranks past moments by *how
    many* of the current aspects they reproduce (same pair, same aspect type,
    within orb). Degrades gracefully — if nothing reproduces all of them, the
    best match might share 14, the next 11, then 10, 9, … each match listing
    exactly which aspects recur.
    Each match carries the list of `SharedAspect`s it reproduces (with orbs).
  - `find_similar_configurations`: continuous RMS-of-separations distance over
    a chosen set of priority pairs.
  - `shared_aspects_across_events` (**reverse search**): given a historical
    event set, tally which aspects recur across the most events — a discovery
    aid for what a class of events has in common. Guardrail-aware: a day/unknown
    event contributes no Moon aspects, and `fraction` is over *eligible* events.
  - `assess_overlap` / `background_overlap_distribution` (**overlap baseline**):
    two random dates always share several aspects (every date has dozens in
    force). This measures that baseline distribution, then asks whether an
    event-pair shares *more* than random pairs do — the right way to judge
    "are these skies unusually alike", since the background overlap is not zero.
    Reports two statistics: a raw shared count *and* a **rarity-weighted score**
    (each shared aspect weighted by `-log10(base_rate)`, so a rare slow-planet
    aspect counts far more than a common fast one — aspects are not equal).

Parts 5–6 are not yet built.

## Methodological commitments (baked into the design)

- **Multi-vertex geometry.** Configurations are read from every body's corner
  (geocentric *and* heliocentric and beyond), not just Earth's. The vertex is a
  parameter throughout.
- **Base rates from the start.** Patterns are always tested against Monte-Carlo
  control dates — the "and not otherwise" half of the question.
- **Discovery/confirmation wall.** A frozen hypothesis file the analysis cannot
  see during exploration; confirmation runs on held-out data only.
- **Honest data quality.** Every event carries a time-precision flag, and the
  engine refuses to use time-sensitive factors (Moon fine position, Ascendant,
  houses) for events whose time is uncertain.

## Setup

```bash
python3.12 -m venv .venv          # any Python ≥ 3.11
.venv/bin/python -m pip install -e ".[dev]"
.venv/bin/python -m pytest        # downloads the ephemeris on first run
```

The first test run downloads the JPL ephemeris kernel into `data/` (~32 MB for
the default `de440s.bsp`).

### Ephemeris span

The working default is **`de441.bsp`** (deep history, −13200 … +17191, ~3.3 GB)
so ancient/medieval events are in range. The test suite pins the small
`de440s.bsp` so it never needs the large kernel.

| kernel       | span            | size    | role                       |
|--------------|-----------------|---------|----------------------------|
| `de441.bsp`  | −13200 – +17191 | ~3.3 GB | **working default**        |
| `de440.bsp`  | 1550 – 2650     | ~119 MB | modern + early-modern      |
| `de440s.bsp` | 1849 – 2150     | ~32 MB  | tests / fast dev           |

Override per-instance — `AstroEngine(ephemeris="de440s.bsp")` — or globally with
the `ORRERY_EPHEMERIS` environment variable.

> **Ancient-date caveat:** for dates more than a few centuries back, the
> uncertainty in ΔT (TT−UT, the Earth's unpredictable rotation) reaches minutes
> to hours. That doesn't affect the slow outer-planet longitudes, but it makes
> the Moon, Ascendant/MC and houses unreliable — which the Part 3 time-precision
> guardrail will already refuse for such events.

## Quick start

```python
from datetime import datetime, timezone
from orrery import AstroEngine

eng = AstroEngine()
when = datetime(2020, 12, 21, 18, 0, tzinfo=timezone.utc)

# The 2020 great conjunction — Jupiter and Saturn ~0.1° apart:
print(eng.angular_separation("jupiter", "saturn", when))   # ~0.10°

# Heliocentric view (vertex = the Sun):
print(eng.position("mars", when, vertex="sun"))

# Aspects + the multi-vertex census:
from orrery import AspectEngine
asp = AspectEngine(eng)
for a in asp.aspects_at(when, vertex="earth")[:3]:
    print(a.body_a, a.aspect, a.body_b, f"orb={a.orb:.2f}", "applying" if a.applying else "separating")
census = asp.census(when)          # every aspect at every body's vertex
figures = asp.whole_figures(when)  # syzygies and grand trines/crosses
```

## Build order

1. **Astro core + tests** ✅ — verified against the 2020-12-21 conjunction.
2. **Aspect engine + multi-vertex census + tests** ✅
3. **Event loader with the time-precision guardrail** ✅
4. **Stats module: Monte-Carlo controls + multiple-comparison accounting** ✅
   (plus the configuration-search engine for historical recurrences)
5. Discovery/confirmation harness.
6. **Web orrery** ✅ — `web/` + `orrery/web.py` (see below).

### Default view (planned — Part 6 rendering, engine support built)

When opened with no arguments, the program's default view will:

1. Show the orrery for the **current time** and identify the aspects in play
   now (the multi-vertex census / `aspects_at`).
2. List the **top 10 other times in history** the planets aligned most closely
   to that same configuration. The default ranking is by *count of matching
   aspects* (`find_aspect_overlap`) — most shared aspects first, then fewer —
   so it stays useful even when no exact recurrence exists. A continuous
   RMS-distance ranking over a curated priority set
   (`find_similar_configurations`) is also available.

The data for both is produced now by `orrery.aspects` and `orrery.search`; only
the interactive rendering waits for the web layer.

## Web orrery (Part 6)

An interactive 3D orrery (Three.js) showing where the planets are for any
date between 3000 BCE and 3000 CE, past, present or future.

```bash
.venv/bin/python -m pip install -e ".[web]"
.venv/bin/python -m orrery.web            # serves http://127.0.0.1:8000
```

Or open `web/index.html` directly in a browser without the server (the
three.js library is loaded from a CDN; everything else is local).

**Two position sources.** The page always computes positions itself from the
JPL Keplerian element tables (Standish; 1800–2050 set and the 3000 BCE–3000 CE
set with the long-range corrections), so animation is smooth at any speed.
When served by the backend, the page also fetches exact positions from the
JPL ephemeris (DE441 by default) whenever the clock settles or runs at one
day per second or slower; the badge in the Positions panel says which source
is in use. `scripts/verify_ephemeris.py` compares the JavaScript tables to
Skyfield/DE441: inner planets agree to hundredths of a degree, Jupiter and
Saturn to about 0.1–0.35 degrees (the documented limit of the JPL tables).

**Controls.** Play/pause and speed (real time to 100 years per second,
forward or reverse), step by day/month/year, a 6000-year timeline (Shift+drag
scrubs one year either side), a date form that accepts negative years for BCE,
and a "Now" button. Click a planet or its row to follow it; Esc returns to the
Sun. Keys: Space, arrow keys, N (now), R (reset view), L (labels), O (orbits),
H (help), 1–4 camera presets.

**Display.** Every planet texture, the Sun's surface, corona, atmospheres,
starfield and Milky Way are generated procedurally at load (no image assets).
Distances are compressed by default (angular positions stay exact; only the
radial distance is scaled) with true-scale distance and true-size toggles in
the settings panel. Dates are shown in the proleptic Gregorian calendar with
astronomical year numbering (year 0 = 1 BCE).

API: `GET /api/range`, `GET /api/positions?jd=<UT Julian Date>` or
`?iso=<UTC timestamp>` return heliocentric ecliptic J2000 x/y/z in AU (Moon
geocentric).

## Project layout

```
orrery/            importable engine (no web dependency)
  astro.py         astronomical core (Part 1)
  web.py           FastAPI backend for the web orrery (Part 6)
web/               the browser orrery (index.html, app.js, ephemeris.js, visuals.js)
scripts/           verify_ephemeris.py — JS element tables vs Skyfield/DE441
tests/             pytest suite
data/              downloaded ephemeris kernels (git-ignored)
pyproject.toml
```
