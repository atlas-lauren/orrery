"""orrery.events — the event data model and the time-precision guardrail.

An event carries a name, category, time, location, and crucially a
``time_precision`` flag. The guardrail is the methodological point of this
module: when an event's time is only known to the ``day`` (or is ``unknown``),
the engine **refuses** to use time-sensitive factors for it — the Moon's fine
position, the Ascendant/Midheaven, and house placements — because those move
fast enough that a coarse time makes them meaningless. Slow factors (Sun, the
planets, the nodes) remain valid.

This is a hard guardrail. :func:`require` raises; :func:`reliable_bodies` and
:func:`census_for_event` silently drop refused factors *and* report what was
dropped, so the refusal is surfaced in every output rather than buried.

Time is stored as a Skyfield ``Time`` so events of any era are representable,
including BCE dates that Python's ``datetime`` cannot express.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from zoneinfo import ZoneInfo

import pandas as pd
from skyfield.api import Loader
from skyfield.timelib import Time

from orrery.astro import ALL_BODIES


class TimePrecision(str, Enum):
    EXACT = "exact"      # known to the minute
    HOUR = "hour"        # known to ~the hour
    DAY = "day"          # only the calendar day is known
    UNKNOWN = "unknown"  # time of day not known at all


# Higher rank = more precise.
_PRECISION_RANK = {
    TimePrecision.EXACT: 3,
    TimePrecision.HOUR: 2,
    TimePrecision.DAY: 1,
    TimePrecision.UNKNOWN: 0,
}

# Minimum precision rank at which a factor is reliable. A factor not listed here
# (the Sun, planets, nodes) is always reliable — those move slowly enough that
# even day-level timing keeps them within aspect orbs.
#
#   moon       : ~13°/day, ~0.5°/hour — needs at least HOUR precision.
#   ascendant  : ~360°/day             — needs EXACT time *and* a location.
#   midheaven  : ~360°/day             — needs EXACT time *and* a location.
#   houses     : derived from Asc/MC    — needs EXACT time *and* a location.
FACTOR_MIN_RANK = {
    "moon": _PRECISION_RANK[TimePrecision.HOUR],
    "ascendant": _PRECISION_RANK[TimePrecision.EXACT],
    "midheaven": _PRECISION_RANK[TimePrecision.EXACT],
    "houses": _PRECISION_RANK[TimePrecision.EXACT],
}

# Factors that additionally require a known observing location.
_LOCATION_DEPENDENT = frozenset({"ascendant", "midheaven", "houses"})


class TimePrecisionError(ValueError):
    """Raised when a time-sensitive factor is requested for an event whose
    time precision (or missing location) makes it unreliable."""


@dataclass(frozen=True)
class Event:
    """A single dated event.

    ``time`` is the canonical, era-agnostic Skyfield ``Time``. ``datetime_utc``
    is a convenience mirror for years >= 1 CE (``None`` for BCE). The original
    local time and zone are retained when a conversion was performed.
    """

    name: str
    category: str
    time_precision: TimePrecision
    time: Time
    latitude: float | None = None
    longitude: float | None = None
    datetime_utc: datetime | None = None
    local_datetime: datetime | None = None
    tz: str | None = None
    source: str = ""
    notes: str = ""

    # -- guardrail ------------------------------------------------------------

    @property
    def precision_rank(self) -> int:
        return _PRECISION_RANK[self.time_precision]

    @property
    def has_location(self) -> bool:
        return (
            self.latitude is not None
            and self.longitude is not None
            and not (isinstance(self.latitude, float) and math.isnan(self.latitude))
            and not (isinstance(self.longitude, float) and math.isnan(self.longitude))
        )

    def is_reliable(self, factor: str) -> bool:
        """Whether ``factor`` (a body name or 'ascendant'/'midheaven'/'houses')
        is reliable for this event given its time precision and location."""
        if factor in _LOCATION_DEPENDENT and not self.has_location:
            return False
        return self.precision_rank >= FACTOR_MIN_RANK.get(factor, 0)

    def require(self, factor: str) -> None:
        """Hard guardrail: raise if ``factor`` is not reliable for this event."""
        if not self.is_reliable(factor):
            need = FACTOR_MIN_RANK.get(factor, 0)
            need_name = next(
                p.value for p, r in _PRECISION_RANK.items() if r == need
            )
            extra = (
                " and a known location"
                if factor in _LOCATION_DEPENDENT and not self.has_location
                else ""
            )
            raise TimePrecisionError(
                f"factor {factor!r} is unreliable for event {self.name!r}: "
                f"time_precision is {self.time_precision.value!r} but {factor!r} "
                f"needs at least {need_name!r}{extra}."
            )

    def refused_factors(self, factors=ALL_BODIES) -> tuple[str, ...]:
        """Of ``factors``, those the guardrail refuses for this event."""
        return tuple(f for f in factors if not self.is_reliable(f))


def reliable_bodies(event: Event, bodies=ALL_BODIES) -> tuple[str, ...]:
    """Subset of ``bodies`` usable for ``event`` under the guardrail."""
    return tuple(b for b in bodies if event.is_reliable(b))


@dataclass(frozen=True)
class EventCensus:
    """Result of running the aspect census on an event under the guardrail.

    ``refused`` is always populated so the refusal is visible in every output.
    """

    event: Event
    aspects: list  # list[orrery.aspects.Aspect]
    bodies_used: tuple[str, ...]
    refused: tuple[str, ...]

    def __str__(self) -> str:
        note = (
            f" | REFUSED (time precision {self.event.time_precision.value}): "
            + ", ".join(self.refused)
            if self.refused
            else ""
        )
        return (
            f"<EventCensus {self.event.name!r}: {len(self.aspects)} aspects, "
            f"{len(self.bodies_used)} bodies{note}>"
        )


def census_for_event(aspect_engine, event: Event, **census_kwargs) -> EventCensus:
    """Run the multi-vertex census for an event, applying the guardrail.

    Time-sensitive factors the event's precision can't support are excluded
    from the bodies fed to the census, and reported in ``refused``.
    """
    bodies = reliable_bodies(event)
    refused = event.refused_factors()
    aspects = aspect_engine.census(event.time, bodies=bodies, **census_kwargs)
    return EventCensus(
        event=event,
        aspects=aspects,
        bodies_used=bodies,
        refused=refused,
    )


# ---------------------------------------------------------------------------
# Loading
# ---------------------------------------------------------------------------

_loader_cache: dict[str, object] = {}


def _default_timescale():
    """A cheap timescale (no planetary ephemeris needed for time conversion)."""
    if "ts" not in _loader_cache:
        import os

        data_dir = os.path.join(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data"
        )
        os.makedirs(data_dir, exist_ok=True)
        _loader_cache["ts"] = Loader(data_dir, verbose=False).timescale()
    return _loader_cache["ts"]


def _parse_precision(value) -> TimePrecision:
    try:
        return TimePrecision(str(value).strip().lower())
    except ValueError:
        raise ValueError(
            f"invalid time_precision {value!r}; "
            f"expected one of {[p.value for p in TimePrecision]}"
        )


def _opt_float(value):
    if value is None:
        return None
    if isinstance(value, float) and math.isnan(value):
        return None
    s = str(value).strip()
    if s == "" or s.lower() in ("nan", "none"):
        return None
    return float(value)


def _opt_str(value) -> str:
    if value is None:
        return ""
    if isinstance(value, float) and math.isnan(value):
        return ""
    return str(value).strip()


def _build_time(ts, row) -> tuple[Time, datetime | None, datetime | None, str | None]:
    """Resolve a row's time to (Time, datetime_utc|None, local_dt|None, tz|None).

    Resolution order:
      1. ``datetime_utc`` ISO string (year >= 1 CE).
      2. ``local_datetime`` + ``tz`` (IANA) -> converted to UTC.
      3. explicit numeric ``year``/``month``/``day``[/``hour``/``minute``],
         which supports BCE via a non-positive year.
    """
    utc_raw = _opt_str(row.get("datetime_utc"))
    local_raw = _opt_str(row.get("local_datetime"))
    tz_raw = _opt_str(row.get("tz"))

    if utc_raw:
        dt = datetime.fromisoformat(utc_raw.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        dt = dt.astimezone(timezone.utc)
        return ts.from_datetime(dt), dt, None, None

    if local_raw and tz_raw:
        naive = datetime.fromisoformat(local_raw)
        if naive.tzinfo is not None:
            raise ValueError(
                f"local_datetime {local_raw!r} must be naive when a tz is given"
            )
        local = naive.replace(tzinfo=ZoneInfo(tz_raw))
        dt = local.astimezone(timezone.utc)
        return ts.from_datetime(dt), dt, local, tz_raw

    # explicit numeric components (era-agnostic; supports BCE)
    if "year" in row and not (
        isinstance(row.get("year"), float) and math.isnan(row.get("year"))
    ) and _opt_str(row.get("year")) != "":
        y = int(row["year"])
        mo = int(row.get("month", 1) or 1)
        d = int(row.get("day", 1) or 1)
        h = int(row.get("hour", 0) or 0)
        mi = int(row.get("minute", 0) or 0)
        t = ts.utc(y, mo, d, h, mi)
        dt = t.utc_datetime() if y >= 1 else None
        return t, dt, None, None

    raise ValueError(
        "row has no usable time: provide 'datetime_utc', or "
        "'local_datetime'+'tz', or numeric 'year'[/'month'/'day'/...]"
    )


def event_from_row(row: dict, ts=None) -> Event:
    """Build one :class:`Event` from a mapping (e.g. a CSV/JSON row)."""
    if ts is None:
        ts = _default_timescale()
    for col in ("name", "category", "time_precision"):
        if _opt_str(row.get(col)) == "":
            raise ValueError(f"missing required field {col!r}")
    time, dt_utc, local_dt, tz = _build_time(ts, row)
    return Event(
        name=_opt_str(row["name"]),
        category=_opt_str(row["category"]),
        time_precision=_parse_precision(row["time_precision"]),
        time=time,
        latitude=_opt_float(row.get("latitude")),
        longitude=_opt_float(row.get("longitude")),
        datetime_utc=dt_utc,
        local_datetime=local_dt,
        tz=tz,
        source=_opt_str(row.get("source")),
        notes=_opt_str(row.get("notes")),
    )


def load_events(path: str, ts=None) -> list[Event]:
    """Load events from a CSV or JSON file into a list of :class:`Event`.

    Pass a Skyfield timescale ``ts`` (e.g. ``AstroEngine().ts``) to avoid the
    module creating its own; otherwise a lightweight one is built lazily.
    """
    if ts is None:
        ts = _default_timescale()
    if path.lower().endswith(".json"):
        df = pd.read_json(path)
    else:
        df = pd.read_csv(path)
    events = []
    for _, raw in df.iterrows():
        events.append(event_from_row(raw.to_dict(), ts=ts))
    return events
