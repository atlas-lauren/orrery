"""orrery.aspects — the aspect engine and multi-vertex census.

Given a moment, this module detects angular aspects between body pairs (from a
configurable list of aspect types and orbs), measured from any chosen vertex;
runs the *multi-vertex census* (every aspect at every body's vertex); and flags
whole-figure configurations (syzygies and near-regular polygons) that are
maximal from every vertex at once.

Aspects are defined on the difference in ecliptic *longitude* (latitude
ignored), which is zodiac-independent — see ``AstroEngine.longitude_separation``.
"""

from __future__ import annotations

import os
import tomllib
from dataclasses import dataclass
from datetime import datetime
from itertools import combinations

from skyfield.timelib import Time

from orrery.astro import (
    AstroEngine,
    ALL_BODIES,
    LUMINARIES,
    PLANETS,
    NODE_ALIASES,
    TRIVIAL_PAIRS,
)

# Small step used to estimate motion (applying/separating, faster body),
# expressed in days of Terrestrial Time so it works for any era (incl. BCE,
# which Python datetimes cannot represent).
_RATE_DT_DAYS = 10.0 / 1440.0  # 10 minutes

_DEFAULT_CONFIG_PATH = os.path.join(os.path.dirname(__file__), "config", "aspects.toml")


@dataclass(frozen=True)
class AspectType:
    """One aspect definition from the config."""

    name: str
    angle: float  # exact separation, folded to [0, 180]
    orb: float  # max deviation allowed
    family: str = ""


@dataclass(frozen=True)
class Aspect:
    """A detected aspect between two bodies, measured from one vertex."""

    body_a: str
    body_b: str
    vertex: str
    zodiac: str
    aspect: str  # aspect-type name, e.g. "square"
    angle: float  # the exact (canonical) angle, e.g. 90.0
    separation: float  # measured longitude separation, [0, 180]
    orb: float  # |separation - angle|
    applying: bool | None  # True applying, False separating, None if flat/unknown
    faster: str  # which of the two bodies moves faster in longitude


@dataclass(frozen=True)
class Figure:
    """A whole-figure configuration (syzygy or near-regular polygon)."""

    kind: str  # "syzygy" | "grand_trine" | "grand_cross" | "polygon_<k>"
    bodies: tuple[str, ...]
    vertex: str
    orb: float  # worst deviation across the figure


def load_aspect_config(path: str | None = None) -> list[AspectType]:
    """Load aspect definitions from a TOML file.

    Falls back to the packaged default config if no path is given.
    """
    if path is None:
        path = _DEFAULT_CONFIG_PATH
    with open(path, "rb") as fh:
        data = tomllib.load(fh)
    out = []
    for entry in data.get("aspect", []):
        out.append(
            AspectType(
                name=entry["name"],
                angle=float(entry["angle"]),
                orb=float(entry["orb"]),
                family=entry.get("family", ""),
            )
        )
    if not out:
        raise ValueError(f"no [[aspect]] entries found in {path!r}")
    return out


def _fold(angle: float) -> float:
    """Fold any angle into [0, 180] (the domain aspects live on)."""
    a = abs(angle) % 360.0
    return a if a <= 180.0 else 360.0 - a


def _delta_lon(lon0: float, lon1: float) -> float:
    """Signed shortest longitude change lon0 -> lon1, in (-180, 180]."""
    d = (lon1 - lon0) % 360.0
    return d - 360.0 if d > 180.0 else d


class AspectEngine:
    """Detects aspects, runs the census, and flags whole figures.

    Wraps an :class:`~orrery.astro.AstroEngine` and a list of aspect types.
    """

    def __init__(self, astro: AstroEngine, aspects: list[AspectType] | None = None):
        self.astro = astro
        self.aspects = aspects if aspects is not None else load_aspect_config()

    # -- internals ------------------------------------------------------------

    def _vertex_longitudes(
        self, when, vertex, bodies, zodiac, ayanamsha
    ) -> tuple[dict[str, float], dict[str, float]]:
        """Longitudes of `bodies` from `vertex` at `when` and at when+dt.

        Returns (lon_now, lon_next). The vertex body itself is excluded;
        nodes are excluded for non-Earth vertices. Time stepping is done in
        Skyfield's TT scale so the method is era-agnostic.
        """
        t0 = self.astro.time(when)
        t1 = self.astro.ts.tt_jd(t0.tt + _RATE_DT_DAYS)
        targets = [
            b
            for b in bodies
            if b != vertex and not (b in NODE_ALIASES and vertex != "earth")
        ]
        lon_now, lon_next = {}, {}
        for b in targets:
            lon_now[b] = self.astro.position(b, t0, vertex, zodiac, ayanamsha).longitude
            lon_next[b] = self.astro.position(b, t1, vertex, zodiac, ayanamsha).longitude
        return lon_now, lon_next

    def _classify(self, a, b, lon_now, lon_next, at, vertex, zodiac):
        """Build an Aspect for pair (a, b) if any aspect type matches."""
        sep_now = _fold(lon_now[a] - lon_now[b])
        sep_next = _fold(lon_next[a] - lon_next[b])
        # motion of each body in longitude over the step
        rate_a = _delta_lon(lon_now[a], lon_next[a])
        rate_b = _delta_lon(lon_now[b], lon_next[b])
        faster = a if abs(rate_a) >= abs(rate_b) else b

        out = []
        for atype in at:
            orb_now = abs(sep_now - atype.angle)
            if orb_now <= atype.orb:
                orb_next = abs(sep_next - atype.angle)
                if abs(orb_next - orb_now) < 1e-9:
                    applying = None
                else:
                    applying = bool(orb_next < orb_now)
                out.append(
                    Aspect(
                        body_a=a,
                        body_b=b,
                        vertex=vertex,
                        zodiac=zodiac,
                        aspect=atype.name,
                        angle=atype.angle,
                        separation=float(sep_now),
                        orb=float(orb_now),
                        applying=applying,
                        faster=faster,
                    )
                )
        return out

    # -- public API -----------------------------------------------------------

    def aspects_at(
        self,
        when: datetime | Time,
        vertex: str = "earth",
        bodies=ALL_BODIES,
        zodiac: str = "tropical",
        ayanamsha: str = "lahiri",
    ) -> list[Aspect]:
        """All aspects between body pairs as seen from `vertex`, sorted by orb."""
        lon_now, lon_next = self._vertex_longitudes(
            when, vertex, bodies, zodiac, ayanamsha
        )
        names = list(lon_now)
        found: list[Aspect] = []
        for a, b in combinations(names, 2):
            if frozenset({a, b}) in TRIVIAL_PAIRS:
                continue
            found.extend(
                self._classify(a, b, lon_now, lon_next, self.aspects, vertex, zodiac)
            )
        found.sort(key=lambda x: x.orb)
        return found

    def census(
        self,
        when: datetime | Time,
        vertices=LUMINARIES + PLANETS,
        bodies=ALL_BODIES,
        zodiac: str = "tropical",
        ayanamsha: str = "lahiri",
    ) -> list[Aspect]:
        """The multi-vertex census: every aspect at every vertex.

        Returns one flat, sorted table. Note that an aspect between A and B seen
        from vertex V is a genuinely different measurement from the same pair
        seen from vertex W — both appear.
        """
        all_aspects: list[Aspect] = []
        for v in vertices:
            all_aspects.extend(
                self.aspects_at(when, v, bodies, zodiac, ayanamsha)
            )
        all_aspects.sort(key=lambda x: (x.orb, x.vertex))
        return all_aspects

    def whole_figures(
        self,
        when: datetime | Time,
        vertex: str = "earth",
        bodies=ALL_BODIES,
        zodiac: str = "tropical",
        ayanamsha: str = "lahiri",
        syzygy_orb: float = 3.0,
        polygon_orb: float = 6.0,
        polygon_sizes=(3, 4),
    ) -> list[Figure]:
        """Flag syzygies and near-regular polygons among `bodies` from `vertex`."""
        lon_now, _ = self._vertex_longitudes(
            when, vertex, bodies, zodiac, ayanamsha
        )
        figures: list[Figure] = []
        figures.extend(find_syzygies(lon_now, vertex, syzygy_orb))
        for k in polygon_sizes:
            figures.extend(find_regular_polygons(lon_now, vertex, k, polygon_orb))
        figures.sort(key=lambda f: f.orb)
        return figures


# ---------------------------------------------------------------------------
# Whole-figure geometry — pure functions over {body: longitude} maps.
# Kept ephemeris-free so they are deterministically unit-testable.
# ---------------------------------------------------------------------------


def _circ_dist(a: float, b: float, modulus: float) -> float:
    """Shortest distance between a and b on a circle of given modulus."""
    d = abs(a - b) % modulus
    return min(d, modulus - d)


def find_syzygies(
    longitudes: dict[str, float], vertex: str = "earth", orb: float = 3.0
) -> list[Figure]:
    """Triples of bodies that are near-collinear (a straight line through the
    center): every pair is near conjunction (0°) or opposition (180°).

    Collinearity = the longitudes coincide modulo 180°.
    """
    names = list(longitudes)
    figs = []
    for trio in combinations(names, 3):
        vals = [longitudes[n] % 180.0 for n in trio]
        worst = max(
            _circ_dist(vals[i], vals[j], 180.0)
            for i, j in combinations(range(3), 2)
        )
        if worst <= orb:
            figs.append(Figure("syzygy", tuple(trio), vertex, worst))
    return figs


def find_regular_polygons(
    longitudes: dict[str, float],
    vertex: str = "earth",
    k: int = 3,
    orb: float = 6.0,
) -> list[Figure]:
    """k-body sets whose longitudes are near-equally spaced (gap ≈ 360/k).

    k=3 → grand trine, k=4 → grand cross. Returns each with its worst gap
    deviation. (Note a syzygy's degenerate "polygon" is reported separately by
    :func:`find_syzygies`.)
    """
    names = list(longitudes)
    ideal = 360.0 / k
    figs = []
    for combo in combinations(names, k):
        vals = sorted(longitudes[n] % 360.0 for n in combo)
        gaps = [
            (vals[(i + 1) % k] - vals[i]) % 360.0 for i in range(k)
        ]
        worst = max(abs(g - ideal) for g in gaps)
        if worst <= orb:
            kind = {3: "grand_trine", 4: "grand_cross"}.get(k, f"polygon_{k}")
            figs.append(Figure(kind, tuple(combo), vertex, worst))
    return figs
