"""orrery.web — FastAPI backend for the web orrery (Part 6).

Serves the static frontend in ``web/`` and exposes exact JPL positions:

* ``GET /api/range``            -> kernel name and the JD span it covers
* ``GET /api/positions?jd=...`` -> heliocentric ecliptic J2000 positions (AU)
  for the nine planets plus the geocentric Moon. ``?iso=<ISO-8601 UTC>`` is
  accepted as an alternative to ``jd``.

Time convention: the ``jd`` parameter is a Julian Date in UT (the same number
the frontend derives from a JavaScript ``Date``), so it is interpreted with
Skyfield's ``ts.ut1_jd``. An ``iso`` string is converted to that same UT JD
(proleptic Gregorian, astronomical year numbering), so the two entry points
are exactly equivalent for the same instant.

The ephemeris engine is created lazily on the first request so importing this
module (or building the app in tests) never loads the 3.3 GB de441 kernel up
front.

Run with::

    .venv/bin/python -m orrery.web [--host 127.0.0.1] [--port 8000] [--ephemeris de441.bsp]
"""

from __future__ import annotations

import argparse
import logging
import math
import os
import re
import threading
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles

from orrery.astro import AstroEngine, PLANETS

log = logging.getLogger("orrery.web")

FRAME = "heliocentric-ecliptic-j2000-au"
ROOT_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT_DIR / "data"
WEB_DIR = ROOT_DIR / "web"

_ISO_RE = re.compile(
    r"^\s*(?P<year>[+-]?\d{1,6})-(?P<month>\d{1,2})-(?P<day>\d{1,2})"
    r"(?:[T ](?P<hour>\d{1,2})(?::(?P<minute>\d{1,2})(?::(?P<second>\d{1,2}(?:\.\d+)?))?)?)?"
    r"\s*(?P<tz>Z|z|[+-]\d{2}:?\d{2})?\s*$"
)


# ---------------------------------------------------------------------------
# Calendar helpers (proleptic Gregorian, astronomical year numbering)
# ---------------------------------------------------------------------------

def jd_from_civil(year: int, month: int, day: int,
                  hour: int = 0, minute: int = 0, second: float = 0.0) -> float:
    """Julian Date of a proleptic-Gregorian civil date (year 0 = 1 BCE)."""
    a = (14 - month) // 12
    y = year + 4800 - a
    m = month + 12 * a - 3
    jdn = day + (153 * m + 2) // 5 + 365 * y + y // 4 - y // 100 + y // 400 - 32045
    return jdn - 0.5 + (hour + minute / 60.0 + second / 3600.0) / 24.0


def civil_from_jd(jd: float) -> tuple[int, int, int, int, int, int]:
    """Proleptic-Gregorian civil date of a Julian Date, rounded to the second."""
    total = int(math.floor((jd + 0.5) * 86400.0 + 0.5))
    jdn, secs = divmod(total, 86400)
    a = jdn + 32044
    b = (4 * a + 3) // 146097
    c = a - 146097 * b // 4
    d = (4 * c + 3) // 1461
    e = c - 1461 * d // 4
    m = (5 * e + 2) // 153
    day = e - (153 * m + 2) // 5 + 1
    month = m + 3 - 12 * (m // 10)
    year = 100 * b + d - 4800 + m // 10
    hour, rem = divmod(secs, 3600)
    minute, second = divmod(rem, 60)
    return year, month, day, hour, minute, second


def iso_from_jd(jd: float) -> str:
    """UTC ISO-8601 string for a UT JD; negative years as e.g. -0587-03-12T00:00:00Z."""
    year, month, day, hour, minute, second = civil_from_jd(jd)
    ystr = f"{year:04d}" if year >= 0 else f"-{-year:04d}"
    return f"{ystr}-{month:02d}-{day:02d}T{hour:02d}:{minute:02d}:{second:02d}Z"


def jd_from_iso(text: str) -> float:
    """Parse an ISO-8601 date/time (assumed UTC when no zone is given) to a UT JD."""
    m = _ISO_RE.match(text or "")
    if not m:
        raise ValueError(f"cannot parse ISO-8601 date/time {text!r}")
    year = int(m.group("year"))
    month = int(m.group("month"))
    day = int(m.group("day"))
    hour = int(m.group("hour") or 0)
    minute = int(m.group("minute") or 0)
    second = float(m.group("second") or 0.0)
    if not (1 <= month <= 12):
        raise ValueError(f"month out of range in {text!r}")
    if not (1 <= day <= _days_in_month(year, month)):
        raise ValueError(f"day out of range in {text!r}")
    if not (0 <= hour <= 24 and 0 <= minute < 60 and 0.0 <= second < 61.0):
        raise ValueError(f"time out of range in {text!r}")
    jd = jd_from_civil(year, month, day, hour, minute, second)
    tz = m.group("tz")
    if tz and tz not in ("Z", "z"):
        sign = 1 if tz[0] == "+" else -1
        digits = tz[1:].replace(":", "")
        offset_min = sign * (int(digits[:2]) * 60 + int(digits[2:]))
        jd -= offset_min / 1440.0
    return jd


def _days_in_month(year: int, month: int) -> int:
    if month == 2:
        leap = year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)
        return 29 if leap else 28
    return 30 if month in (4, 6, 9, 11) else 31


# ---------------------------------------------------------------------------
# Ephemeris selection and engine wrapper
# ---------------------------------------------------------------------------

def select_ephemeris(explicit: str | None = None, data_dir: Path | str = DATA_DIR) -> str:
    """ORRERY_EPHEMERIS env if set, else de441.bsp if present, else de440s.bsp."""
    if explicit:
        return explicit
    env = os.environ.get("ORRERY_EPHEMERIS")
    if env:
        return env
    if (Path(data_dir) / "de441.bsp").exists():
        return "de441.bsp"
    return "de440s.bsp"


class PositionService:
    """Lazily-constructed AstroEngine plus the position/range computations."""

    def __init__(self, ephemeris: str, data_dir: Path | str = DATA_DIR):
        self.ephemeris = ephemeris
        self.data_dir = str(data_dir)
        self._engine: AstroEngine | None = None
        self._lock = threading.Lock()
        self._range: tuple[float, float] | None = None

    @property
    def engine(self) -> AstroEngine:
        if self._engine is None:
            with self._lock:
                if self._engine is None:
                    log.info("loading ephemeris %s from %s", self.ephemeris, self.data_dir)
                    self._engine = AstroEngine(ephemeris=self.ephemeris, data_dir=self.data_dir)
        return self._engine

    def kernel_range(self) -> tuple[float, float]:
        """(jd_min, jd_max) covered by every segment of the loaded kernel."""
        if self._range is None:
            eph = self.engine.eph
            # A kernel may split one (center, target) pair across several
            # consecutive segments (de441 splits at 1969-07-30), so first take
            # the union of each pair's coverage, then the span common to all
            # pairs so that every body can be evaluated anywhere in the range.
            coverage: dict[tuple[int, int], list[float]] = {}
            for seg in eph.segments:
                spk = getattr(seg, "spk_segment", seg)
                key = (int(seg.center), int(seg.target))
                span = coverage.setdefault(key, [math.inf, -math.inf])
                span[0] = min(span[0], float(spk.start_jd))
                span[1] = max(span[1], float(spk.end_jd))
            self._range = (
                max(span[0] for span in coverage.values()),
                min(span[1] for span in coverage.values()),
            )
        return self._range

    def check_in_range(self, jd: float) -> None:
        jd_min, jd_max = self.kernel_range()
        if not (jd_min <= jd <= jd_max):
            raise HTTPException(
                status_code=400,
                detail=(
                    f"jd {jd} is outside the range of {self.ephemeris} "
                    f"({jd_min} .. {jd_max}, i.e. {iso_from_jd(jd_min)} .. {iso_from_jd(jd_max)})"
                ),
            )

    def positions(self, jd: float) -> dict:
        from skyfield.framelib import ecliptic_J2000_frame

        self.check_in_range(jd)
        eng = self.engine
        t = eng.ts.ut1_jd(jd)
        sun = eng._target("sun")
        earth = eng._target("earth")
        bodies: dict[str, dict[str, float]] = {}
        for name in PLANETS:
            vec = (eng._target(name) - sun).at(t).frame_xyz(ecliptic_J2000_frame).au
            bodies[name] = _vector_record(vec)
        moon = (eng._target("moon") - earth).at(t).frame_xyz(ecliptic_J2000_frame).au
        bodies["moon"] = _vector_record(moon)
        return {
            "jd": jd,
            "iso": iso_from_jd(jd),
            "ephemeris": self.ephemeris,
            "frame": FRAME,
            "bodies": bodies,
        }


def _vector_record(vec) -> dict[str, float]:
    x, y, z = (float(v) for v in vec)
    r = math.sqrt(x * x + y * y + z * z)
    lon = math.degrees(math.atan2(y, x)) % 360.0
    lat = math.degrees(math.atan2(z, math.hypot(x, y))) if r > 0 else 0.0
    return {
        "x": round(x, 9),
        "y": round(y, 9),
        "z": round(z, 9),
        "lon": round(lon, 9),
        "lat": round(lat, 9),
        "r": round(r, 9),
    }


# ---------------------------------------------------------------------------
# Static files that tolerate a directory created after startup
# ---------------------------------------------------------------------------

class _LazyStaticFiles:
    """ASGI app: serve ``directory`` with StaticFiles once it exists, else 404."""

    def __init__(self, directory: Path):
        self.directory = directory
        self._static: StaticFiles | None = None

    async def __call__(self, scope, receive, send) -> None:
        if self._static is None and self.directory.is_dir():
            self._static = StaticFiles(directory=str(self.directory), html=True)
        if self._static is None:
            response = PlainTextResponse("web/ directory not found", status_code=404)
            await response(scope, receive, send)
            return

        async def send_no_cache(message):
            # The frontend is edited in place; make browsers revalidate every
            # request instead of applying heuristic caching to the JS files.
            if message["type"] == "http.response.start":
                headers = [(k, v) for k, v in message.get("headers", [])
                           if k.lower() != b"cache-control"]
                headers.append((b"cache-control", b"no-cache"))
                message = {**message, "headers": headers}
            await send(message)

        await self._static(scope, receive, send_no_cache)


# ---------------------------------------------------------------------------
# App factory
# ---------------------------------------------------------------------------

def create_app(ephemeris: str | None = None, data_dir: Path | str = DATA_DIR,
               web_dir: Path | str = WEB_DIR) -> FastAPI:
    service = PositionService(select_ephemeris(ephemeris, data_dir), data_dir)
    app = FastAPI(title="orrery web", version="0.1.0", docs_url="/api/docs",
                  redoc_url=None, openapi_url="/api/openapi.json")
    app.state.service = service

    @app.exception_handler(RequestValidationError)
    async def _validation_error(request: Request, exc: RequestValidationError):
        # The API contract promises HTTP 400 with a string "detail" for bad
        # input, so FastAPI's default 422 (list-shaped detail) is remapped for
        # every path under /api/. Static paths never reach this handler.
        if request.url.path.startswith("/api/"):
            problems = "; ".join(
                f"{'.'.join(str(part) for part in err.get('loc', ()))}: {err.get('msg', 'invalid')}"
                for err in exc.errors()
            ) or "invalid request"
            return JSONResponse(status_code=400, content={"detail": problems})
        return JSONResponse(status_code=422, content={"detail": exc.errors()})

    @app.get("/api/range")
    def api_range() -> dict:
        jd_min, jd_max = service.kernel_range()
        return {"ephemeris": service.ephemeris, "jd_min": jd_min, "jd_max": jd_max}

    @app.get("/api/positions")
    def api_positions(
        jd: str | None = Query(default=None, description="Julian Date, UT (decimal number)"),
        iso: str | None = Query(default=None, description="ISO-8601 UTC date/time"),
    ) -> dict:
        # ``jd`` is taken as a raw string and parsed here (rather than as
        # ``float``) so that malformed values yield the contract's 400 with a
        # string detail instead of FastAPI's 422.
        if jd is None and iso is None:
            raise HTTPException(status_code=400, detail="provide either jd=<float> or iso=<ISO-8601 UTC>")
        if jd is not None and iso is not None:
            raise HTTPException(status_code=400, detail="provide only one of jd or iso")
        if jd is None:
            try:
                jd_value = jd_from_iso(iso)
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
        else:
            try:
                jd_value = float(jd.strip())
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=f"jd must be a number, got {jd!r}") from exc
        if not math.isfinite(jd_value):
            raise HTTPException(status_code=400, detail="jd must be a finite number")
        return service.positions(jd_value)

    # Mounted after the API routes. The wrapper lets the server start before
    # web/ exists (it answers 404 until the directory appears), which matters
    # while the frontend is being written alongside the backend.
    web_path = Path(web_dir)
    if not web_path.is_dir():
        log.warning("static web directory %s not found; GET / will 404 until it exists", web_path)
    app.mount("/", _LazyStaticFiles(web_path), name="web")

    return app


app = create_app()


def main(argv: list[str] | None = None) -> None:
    import uvicorn

    parser = argparse.ArgumentParser(description="Serve the orrery web app and positions API.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--ephemeris", default=None,
                        help="kernel file in data/ (default: $ORRERY_EPHEMERIS, de441.bsp, or de440s.bsp)")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    served = create_app(ephemeris=args.ephemeris)
    print(f"orrery web: http://{args.host}:{args.port}/  (ephemeris {served.state.service.ephemeris})",
          flush=True)
    uvicorn.run(served, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
