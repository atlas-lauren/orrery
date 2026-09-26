"""orrery.astro — the astronomical core.

Computes ecliptic positions and angular separations for solar-system bodies,
observed from an arbitrary *vertex* (the observing body), using Skyfield and a
JPL DE-series ephemeris.

Key design decisions
---------------------
* **Multi-vertex.** The observing body is a parameter. ``vertex="earth"`` is
  geocentric, ``vertex="sun"`` is heliocentric, but any ephemeris body may be
  used. This supports the model's premise of reading the geometry from every
  body's corner, not only Earth's.

* **Tropical and sidereal.** Tropical longitude is the ecliptic longitude
  referred to the equinox of date. Sidereal longitude = tropical − ayanamsha,
  where the ayanamsha is selectable. *Angular separations between two bodies
  are identical in both systems* (the ayanamsha is a constant offset applied to
  both), so the zodiac choice only affects absolute longitudes.

* **Two notions of separation.** Astrological aspects (Part 2) are defined on
  the difference in ecliptic *longitude* (latitude ignored) — see
  ``longitude_separation``. The true great-circle angular separation in the sky
  (which does account for ecliptic latitude) is ``angular_separation``. The
  2020-12-21 great conjunction (~0.1°) is a great-circle figure, so the day-one
  sanity test uses ``angular_separation``.

Ephemeris note
--------------
Default is ``de440s.bsp`` (DE440, short span **1849–2150**, ~32 MB). For events
outside that window use the full ``de440.bsp`` (1550–2650, ~114 MB) or
``de441.bsp`` (−13200…+17191). Pass ``ephemeris=`` to :class:`AstroEngine`.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from datetime import datetime, timezone

from skyfield.api import Loader
from skyfield.timelib import Time

# ---------------------------------------------------------------------------
# Body catalogue
# ---------------------------------------------------------------------------

LUMINARIES = ("sun", "moon")
PLANETS = (
    "mercury",
    "venus",
    "earth",
    "mars",
    "jupiter",
    "saturn",
    "uranus",
    "neptune",
    "pluto",
)
# Mean lunar nodes. Computed analytically (geocentric concept), not from the
# ephemeris kernel. The two nodes are the public default set; "mean_node" is
# accepted as an alias for the (ascending) north node but is kept out of the
# default body list so it doesn't produce a spurious zero-orb self-aspect.
NODES = ("north_node", "south_node")
NODE_ALIASES = frozenset({"north_node", "south_node", "mean_node"})

# Pairs that are opposed by construction and so are never meaningful aspects.
TRIVIAL_PAIRS = frozenset({frozenset({"north_node", "south_node"})})

ALL_BODIES = LUMINARIES + PLANETS + NODES

# Each catalogue name maps to a list of ephemeris target names to try in order.
# Outer planets are present only as system barycenters in the DE kernels; for
# those the barycenter is an excellent proxy for the planet's own position.
_BODY_ALIASES = {
    "sun": ["sun"],
    "moon": ["moon"],
    "mercury": ["mercury", "mercury barycenter"],
    "venus": ["venus", "venus barycenter"],
    "earth": ["earth"],
    "mars": ["mars", "mars barycenter"],
    "jupiter": ["jupiter barycenter", "jupiter"],
    "saturn": ["saturn barycenter", "saturn"],
    "uranus": ["uranus barycenter", "uranus"],
    "neptune": ["neptune barycenter", "neptune"],
    "pluto": ["pluto barycenter", "pluto"],
}


@dataclass(frozen=True)
class BodyPosition:
    """Ecliptic position of one body, observed from one vertex."""

    body: str
    vertex: str
    zodiac: str  # "tropical" | "sidereal"
    longitude: float  # degrees, [0, 360)
    latitude: float  # degrees
    distance_au: float  # distance from the vertex, AU (NaN for nodes)

    @property
    def sign(self) -> str:
        """Zodiac sign containing the longitude (informational)."""
        return _SIGNS[int(self.longitude // 30) % 12]

    @property
    def sign_degrees(self) -> float:
        """Degrees within the sign, [0, 30)."""
        return self.longitude % 30.0


_SIGNS = (
    "Aries", "Taurus", "Gemini", "Cancer", "Leo", "Virgo",
    "Libra", "Scorpio", "Sagittarius", "Capricorn", "Aquarius", "Pisces",
)


class AstroEngine:
    """Loads an ephemeris and computes positions/separations.

    The engine is cheap to keep alive and caches resolved ephemeris targets, so
    construct one and reuse it across an analysis run.
    """

    #: Working default for real analysis. Deep-history DE441 (−13200…+17191).
    #: Overridable per-instance or via the ``ORRERY_EPHEMERIS`` env var. Tests
    #: pin the small ``de440s.bsp`` explicitly so they never need this 3.3 GB
    #: kernel.
    DEFAULT_EPHEMERIS = os.environ.get("ORRERY_EPHEMERIS", "de441.bsp")

    def __init__(self, ephemeris: str | None = None, data_dir: str | None = None):
        if ephemeris is None:
            ephemeris = self.DEFAULT_EPHEMERIS
        if data_dir is None:
            data_dir = os.path.join(
                os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data"
            )
        os.makedirs(data_dir, exist_ok=True)
        self.ephemeris_name = ephemeris
        self.data_dir = data_dir
        self._loader = Loader(data_dir, verbose=False)
        self.eph = self._loader(ephemeris)  # downloads on first use
        self.ts = self._loader.timescale()
        self._target_cache: dict[str, object] = {}

    # -- time / target helpers ------------------------------------------------

    def time(self, when: datetime | Time) -> Time:
        """Public: coerce a datetime or Skyfield Time into a Skyfield Time.

        Use Skyfield ``Time`` (e.g. ``engine.ts.utc(-43, 3, 15)``) for dates
        before 1 CE, which Python's ``datetime`` cannot represent.
        """
        return self._to_time(when)

    def _to_time(self, when: datetime | Time) -> Time:
        if isinstance(when, Time):
            return when
        if not isinstance(when, datetime):
            raise TypeError(f"expected datetime or skyfield Time, got {type(when)!r}")
        if when.tzinfo is None:
            raise ValueError(
                "datetime must be timezone-aware (UTC). Naive datetimes are "
                "rejected to avoid silent local-time errors."
            )
        return self.ts.from_datetime(when.astimezone(timezone.utc))

    def _target(self, name: str):
        if name not in _BODY_ALIASES:
            raise KeyError(f"unknown body {name!r}; known: {sorted(_BODY_ALIASES)}")
        if name in self._target_cache:
            return self._target_cache[name]
        for key in _BODY_ALIASES[name]:
            try:
                target = self.eph[key]
                self._target_cache[name] = target
                return target
            except (KeyError, ValueError):
                continue
        raise KeyError(
            f"body {name!r} not available in ephemeris {self.ephemeris_name!r}"
        )

    # -- ayanamsha ------------------------------------------------------------

    def ayanamsha(self, name: str, when: datetime | Time) -> float:
        """Ayanamsha (degrees) at ``when``.

        APPROXIMATE: a linear precession model (rate ≈ 50.288″/yr) anchored at
        J2000. Adequate for orb-based work (sub-arcminute error over a century)
        but not a substitute for Swiss Ephemeris if exact sidereal longitudes
        are ever needed. Selectable so a better model can be dropped in.
        """
        t = self._to_time(when)
        years = (t.tt - 2451545.0) / 365.25
        rate = 50.2877 / 3600.0  # deg/yr
        anchors = {
            "lahiri": 23.8523,          # Lahiri/Chitrapaksha at J2000.0
            "fagan_bradley": 24.7400,   # Fagan–Bradley at J2000.0
        }
        key = name.replace("-", "_")
        if key not in anchors:
            raise ValueError(
                f"unknown ayanamsha {name!r}; known: {sorted(anchors)}"
            )
        return anchors[key] + rate * years

    # -- positions ------------------------------------------------------------

    def position(
        self,
        body: str,
        when: datetime | Time,
        vertex: str = "earth",
        zodiac: str = "tropical",
        ayanamsha: str = "lahiri",
        apparent: bool = True,
    ) -> BodyPosition:
        """Ecliptic position of ``body`` seen from ``vertex``.

        Light-time is always corrected. ``apparent=True`` additionally applies
        aberration and gravitational deflection (apparent place — the
        astrological convention) but *only for the Earth vertex*; for any other
        vertex the geometric (light-time-corrected) direction is used, since
        apparent-place corrections are an Earth-observer convention and the
        Sun's deflection term is singular at the Sun itself.
        """
        if zodiac not in ("tropical", "sidereal"):
            raise ValueError("zodiac must be 'tropical' or 'sidereal'")
        t = self._to_time(when)

        if body in NODE_ALIASES:
            return self._node_position(body, t, vertex, zodiac, ayanamsha)

        observer = self._target(vertex)
        astrometric = observer.at(t).observe(self._target(body))
        # Apparent place (aberration + gravitational deflection) is an
        # Earth-observer convention; for the Sun vertex the Sun's own
        # deflection term is singular (divide-by-zero). For any non-Earth
        # vertex we use the light-time-corrected geometric direction, which is
        # the standard for heliocentric longitudes.
        use_apparent = apparent and vertex == "earth"
        pos = astrometric.apparent() if use_apparent else astrometric
        # equinox-of-date ecliptic = tropical longitude
        lat, lon, dist = pos.ecliptic_latlon(epoch=t)
        longitude = lon.degrees
        if zodiac == "sidereal":
            longitude -= self.ayanamsha(ayanamsha, t)
        return BodyPosition(
            body=body,
            vertex=vertex,
            zodiac=zodiac,
            longitude=longitude % 360.0,
            latitude=lat.degrees,
            distance_au=dist.au,
        )

    def _node_position(self, body, t, vertex, zodiac, ayanamsha) -> BodyPosition:
        if vertex != "earth":
            raise ValueError(
                "lunar nodes are a geocentric (Earth–Moon orbit) concept; "
                "vertex must be 'earth'"
            )
        # Mean longitude of the ascending node (Meeus, equinox of date).
        T = (t.tt - 2451545.0) / 36525.0
        omega = (
            125.0445479
            - 1934.1362891 * T
            + 0.0020754 * T**2
            + T**3 / 467441.0
            - T**4 / 60616000.0
        ) % 360.0
        longitude = omega
        if body == "south_node":
            longitude = (longitude + 180.0) % 360.0
        if zodiac == "sidereal":
            longitude -= self.ayanamsha(ayanamsha, t)
        return BodyPosition(
            body=body,
            vertex=vertex,
            zodiac=zodiac,
            longitude=longitude % 360.0,
            latitude=0.0,
            distance_au=float("nan"),
        )

    def positions(
        self,
        when: datetime | Time,
        bodies=ALL_BODIES,
        vertex: str = "earth",
        zodiac: str = "tropical",
        ayanamsha: str = "lahiri",
    ) -> dict[str, BodyPosition]:
        """All requested bodies at one instant, keyed by body name.

        Nodes are skipped automatically for non-Earth vertices.
        """
        out: dict[str, BodyPosition] = {}
        for b in bodies:
            if b in NODES and vertex != "earth":
                continue
            out[b] = self.position(b, when, vertex, zodiac, ayanamsha)
        return out

    def longitudes(
        self,
        body: str,
        times: Time,
        vertex: str = "earth",
        zodiac: str = "tropical",
        ayanamsha: str = "lahiri",
    ):
        """Vectorized ecliptic longitudes (degrees) for one body over a Skyfield
        ``Time`` *array*. Returns a numpy array. Used for fast history scans.

        Separations are zodiac-independent, so callers doing similarity search
        can leave ``zodiac="tropical"`` and ignore the ayanamsha.
        """
        import numpy as np

        if body in NODE_ALIASES:
            if vertex != "earth":
                raise ValueError("lunar nodes require vertex='earth'")
            T = (times.tt - 2451545.0) / 36525.0
            omega = (
                125.0445479
                - 1934.1362891 * T
                + 0.0020754 * T**2
                + T**3 / 467441.0
                - T**4 / 60616000.0
            ) % 360.0
            lon = omega + (180.0 if body == "south_node" else 0.0)
            if zodiac == "sidereal":
                lon = lon - self.ayanamsha(ayanamsha, times)
            return np.asarray(lon) % 360.0

        observer = self._target(vertex)
        astrometric = observer.at(times).observe(self._target(body))
        pos = astrometric.apparent() if vertex == "earth" else astrometric
        _, lon, _ = pos.ecliptic_latlon(epoch=times)
        out = np.asarray(lon.degrees)
        if zodiac == "sidereal":
            out = out - self.ayanamsha(ayanamsha, times)
        return out % 360.0

    # -- separations ----------------------------------------------------------

    def angular_separation(
        self,
        body_a: str,
        body_b: str,
        when: datetime | Time,
        vertex: str = "earth",
        apparent: bool = True,
    ) -> float:
        """True great-circle angular separation (degrees), latitude included.

        Not defined for the lunar nodes (no 3-D ephemeris position); use
        :meth:`longitude_separation` for those.
        """
        if body_a in NODE_ALIASES or body_b in NODE_ALIASES:
            raise ValueError(
                "angular_separation is undefined for lunar nodes; use "
                "longitude_separation instead"
            )
        t = self._to_time(when)
        observer = self._target(vertex)
        pa = observer.at(t).observe(self._target(body_a))
        pb = observer.at(t).observe(self._target(body_b))
        if apparent and vertex == "earth":  # see note in position()
            pa, pb = pa.apparent(), pb.apparent()
        return pa.separation_from(pb).degrees

    def longitude_separation(
        self,
        body_a: str,
        body_b: str,
        when: datetime | Time,
        vertex: str = "earth",
        zodiac: str = "tropical",
        ayanamsha: str = "lahiri",
    ) -> float:
        """Difference in ecliptic longitude, folded to [0, 180] degrees.

        This is the quantity aspects are defined on. Zodiac-independent.
        """
        la = self.position(body_a, when, vertex, zodiac, ayanamsha).longitude
        lb = self.position(body_b, when, vertex, zodiac, ayanamsha).longitude
        d = abs(la - lb) % 360.0
        return d if d <= 180.0 else 360.0 - d
