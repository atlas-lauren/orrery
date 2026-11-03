/*
 * moons.js -- parent-centric positions of the major moons of Mars, Jupiter,
 * Saturn, Uranus, Neptune and Pluto from JPL mean orbital elements.
 *
 * Classic script (no import/export). Attaches window.Moons in browsers and
 * exports the same object via module.exports in Node. Pure functions, no DOM.
 * Uses window.Ephemeris.deltaT when it is present (TT = UT + deltaT) and a
 * 69 s fallback otherwise.
 *
 * Source of the elements
 *   JPL Solar System Dynamics, "Planetary Satellite Mean Orbital Parameters",
 *   https://ssd.jpl.nasa.gov/sats/elem/ (fetched 2026-09-29). Rows cite the
 *   satellite ephemerides MAR099, JUP365, SAT441, URA182, NEP097 and PLU060.
 *   Column definitions from that page: a, e, omega (argument of periapsis),
 *   M (mean anomaly), i (inclination to the reference plane), node
 *   ("longitude of the ascending node measured from the node of the
 *   reference plane on the ICRF equator"), P (sidereal period), P apsis and
 *   P node (precession periods, years, unsigned), R.A./Dec. (reference-plane
 *   pole, ICRF), Tilt (angle between the planet's equator and the Laplace
 *   plane). Epoch of every row used here: 2000-01-01.5 TDB = JD 2451545.0.
 *
 *   Reference planes. The Mars, Jupiter, Saturn and Neptune rows are referred
 *   to each moon's local Laplace plane, whose pole is tabulated. The Uranus
 *   rows and Charon are "equatorial": the Uranus rows are referred to the
 *   pole about which the moons orbit prograde, RA 77.311 Dec +15.175 (the
 *   angular-momentum pole, antipodal to the IAU north pole; the page's Puck
 *   row lists this pole with tilt 180), and Charon to Pluto's IAU 2015 pole
 *   RA 132.993 Dec -6.163 (the 2015 report adopted the right-hand rule for
 *   Pluto, so Charon orbits prograde about it). Both were checked against
 *   Horizons: every moon's orbit normal lies within its tabulated
 *   inclination of the adopted pole.
 *
 *   Conventions established against Horizons (scripts/verify_moons.py):
 *   - The node is measured from the ascending node of the reference plane on
 *     the ICRF equator, i.e. from the direction RA = poleRA + 90, Dec = 0;
 *     angles increase counterclockwise about the reference pole.
 *   - The P column is the sidereal period of the mean longitude for every
 *     row except the JUP365 rows, where it is the anomalistic period (the
 *     rate of M; e.g. Io 1.762732 d versus its 1.769138 d sidereal period).
 *     Both readings are the same model once the mean-anomaly rate n is
 *     derived accordingly (see MODEL.periodOf).
 *   - The page's precession periods carry no sign. Adopted directions: the
 *     node regresses for prograde orbits and advances for Triton; the
 *     periapsis advances, except for Io and Europa, whose Laplace-resonance
 *     forced pericentres regress (their period 1.33 yr is 360/(2 n_Europa -
 *     n_Io)). Tethys' 0.005 yr apsidal period is an artefact of e = 0.001
 *     and is not applied.
 *
 *   Calibrations against Horizons (all recorded per moon in MODEL, page
 *   values kept verbatim in ELEMENTS):
 *   - SAT441 rows: the tabulated epoch mean anomalies are offset from the
 *     SAT441 ephemeris by constant per-moon amounts (Mimas +18.4, Enceladus
 *     +5.8, Tethys -60.0, Dione -151.2, Rhea -157.4, Titan -156.9, Iapetus
 *     +144.4 deg), while their periods, shapes and orientations fit; the
 *     offsets are applied as dMDeg. Mimas additionally carries its 70.6 yr,
 *     43.4 deg longitude libration from the Mimas-Tethys resonance.
 *   - Phobos and Deimos: the page gives P to four decimals, which alone
 *     drifts 0.7 deg/day for Phobos; their mean-longitude rates were refit to
 *     Horizons over 1900-2100 (Phobos 1128.84476 deg/d plus its secular
 *     acceleration 1.88e-8 deg/d^2, Deimos 285.161886 deg/d; both agree with
 *     the published sidereal periods 0.31891023 d and 1.2624407 d).
 *   - Triton: sidereal rate refit (61.25726 deg/d, i.e. the published
 *     5.876854 d); its node advances with a 678 yr period in NEP097 (the
 *     page lists 340.379 yr, half of that); epoch offset -4.0 deg.
 *
 *   Accuracy versus Horizons (angular error of the parent-centric vector):
 *   under 1 deg for the Uranian moons, Charon, Ganymede, Callisto, Deimos,
 *   Dione, Rhea and Triton over 1900-2100; 1-3 deg for Io, Europa, Phobos,
 *   Enceladus, Tethys, Titan and Iapetus; up to about 5 deg for Mimas.
 *
 * Frames
 *   Positions are parent-centric, ecliptic J2000, right-handed, x toward the
 *   vernal equinox, z toward ecliptic north, in AU. ICRF -> ecliptic is a
 *   rotation about x by -23.4392911 deg. IAU north poles are the constant
 *   terms of the IAU WGCCRE 2015 report (Archinal et al. 2018), ICRF, J2000.
 *   Note for renderers: with the IAU 2015 Pluto pole the rotation is
 *   prograde (W = 302.695 + 56.3625225 d), unlike the 2009 pole.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.Moons = api;
  } else if (root) {
    root.Moons = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEG = Math.PI / 180;
  var RAD = 180 / Math.PI;
  var TWO_PI = 2 * Math.PI;
  var J2000 = 2451545.0;
  var AU_KM = 149597870.7;
  var OBLIQUITY_DEG = 23.4392911;
  var DAYS_PER_YEAR = 365.25;
  var DELTA_T_FALLBACK = 69; // seconds, used only without window.Ephemeris

  var SYSTEMS = {
    mars: ['phobos', 'deimos'],
    jupiter: ['io', 'europa', 'ganymede', 'callisto'],
    saturn: ['mimas', 'enceladus', 'tethys', 'dione', 'rhea', 'titan', 'iapetus'],
    uranus: ['miranda', 'ariel', 'umbriel', 'titania', 'oberon'],
    neptune: ['triton'],
    pluto: ['charon']
  };
  var PLANETS = ['mars', 'jupiter', 'saturn', 'uranus', 'neptune', 'pluto'];
  var NAMES = [];
  for (var pi = 0; pi < PLANETS.length; pi++) {
    NAMES = NAMES.concat(SYSTEMS[PLANETS[pi]]);
  }

  // IAU WGCCRE 2015 north poles at J2000 (constant terms), degrees, ICRF.
  var POLES = {
    sun: { ra: 286.13, dec: 63.87 },
    mercury: { ra: 281.0103, dec: 61.4155 },
    venus: { ra: 272.76, dec: 67.16 },
    earth: { ra: 0.0, dec: 90.0 },
    mars: { ra: 317.269, dec: 54.433 },
    jupiter: { ra: 268.057, dec: 64.495 },
    saturn: { ra: 40.589, dec: 83.537 },
    uranus: { ra: 257.311, dec: -15.175 },
    neptune: { ra: 299.36, dec: 43.46 },
    pluto: { ra: 132.993, dec: -6.163 }
  };

  var PLANET_RADIUS_KM = {
    earth: 6371.0, mars: 3389.5, jupiter: 69911, saturn: 58232,
    uranus: 25362, neptune: 24622, pluto: 1188.3
  };

  var PARENT_JPL_ID = { mars: 499, jupiter: 599, saturn: 699, uranus: 799, neptune: 899, pluto: 999 };

  // ---------------------------------------------------------------------------
  // Page rows, verbatim (https://ssd.jpl.nasa.gov/sats/elem/, epoch
  // 2000-01-01.5 TDB). Columns:
  //   parent, displayName, jplId, radiusKm (mean radius), ephemeris, frame,
  //   a (km), e, omega (deg), M (deg), i (deg), node (deg), P (days),
  //   P apsis (yr), P node (yr), pole RA (deg), pole Dec (deg), tilt (deg)
  // "-" on the page (Charon's precession periods) is stored as 0. For the
  // equatorial-frame rows the pole columns are the planet equator poles
  // described in the header.
  // ---------------------------------------------------------------------------
  var ELEMENTS = {
    phobos:    ['mars', 'Phobos', 401, 11.1, 'MAR099', 'laplace', 9375, 0.015, 216.3, 189.7, 1.1, 169.2, 0.3187, 1.1, 2.3, 317.7, 52.9, 0.0],
    deimos:    ['mars', 'Deimos', 402, 6.2, 'MAR099', 'laplace', 23457, 0.000, 0.0, 205.0, 1.8, 54.3, 1.2625, 0.0, 56.2, 316.6, 53.5, 0.9],
    io:        ['jupiter', 'Io', 501, 1821.6, 'JUP365', 'laplace', 421800, 0.004, 49.1, 330.9, 0.0, 0.0, 1.762732, 1.333, 0.000, 268.1, 64.5, 0.0],
    europa:    ['jupiter', 'Europa', 502, 1560.8, 'JUP365', 'laplace', 671100, 0.009, 45.0, 345.4, 0.5, 184.0, 3.525463, 1.394, 30.202, 268.1, 64.5, 0.0],
    ganymede:  ['jupiter', 'Ganymede', 503, 2634.1, 'JUP365', 'laplace', 1070400, 0.001, 198.3, 324.8, 0.2, 58.5, 7.155588, 68.301, 137.812, 268.2, 64.6, 0.1],
    callisto:  ['jupiter', 'Callisto', 504, 2410.3, 'JUP365', 'laplace', 1882700, 0.007, 43.8, 87.4, 0.3, 309.1, 16.690440, 277.921, 577.264, 268.7, 64.8, 0.4],
    mimas:     ['saturn', 'Mimas', 601, 198.2, 'SAT441', 'laplace', 186000, 0.020, 160.4, 275.3, 1.6, 66.2, 0.942422, 0.493, 0.986, 40.6, 83.5, 0.0],
    enceladus: ['saturn', 'Enceladus', 602, 252.1, 'SAT441', 'laplace', 238400, 0.005, 119.5, 57.0, 0.0, 0.0, 1.370218, 2.916, 0.000, 40.6, 83.5, 0.0],
    tethys:    ['saturn', 'Tethys', 603, 531.1, 'SAT441', 'laplace', 295000, 0.001, 335.3, 0.0, 1.1, 273.0, 1.887802, 0.005, 4.982, 40.6, 83.5, 0.0],
    dione:     ['saturn', 'Dione', 604, 561.4, 'SAT441', 'laplace', 377700, 0.002, 116.0, 212.0, 0.0, 0.0, 2.736916, 11.698, 0.000, 40.6, 83.5, 0.0],
    rhea:      ['saturn', 'Rhea', 605, 763.8, 'SAT441', 'laplace', 527200, 0.001, 44.3, 31.5, 0.3, 133.7, 4.517503, 33.939, 35.775, 40.6, 83.5, 0.0],
    titan:     ['saturn', 'Titan', 606, 2574.7, 'SAT441', 'laplace', 1221900, 0.029, 78.3, 11.7, 0.3, 78.6, 15.945448, 346.680, 687.370, 36.4, 84.0, 0.6],
    iapetus:   ['saturn', 'Iapetus', 608, 734.5, 'SAT441', 'laplace', 3561700, 0.028, 254.5, 74.8, 7.6, 86.5, 79.331002, 1662.900, 3130.302, 288.7, 78.9, 14.8],
    miranda:   ['uranus', 'Miranda', 705, 235.8, 'URA182', 'equatorial', 129846, 0.001, 154.8, 73.0, 4.4, 100.9, 1.413479, 8.939, 17.787, 77.311, 15.175, 180.0],
    ariel:     ['uranus', 'Ariel', 701, 578.9, 'URA182', 'equatorial', 190929, 0.001, 9.6, 193.5, 0.0, 0.0, 2.520379, 28.901, 0.000, 77.311, 15.175, 180.0],
    umbriel:   ['uranus', 'Umbriel', 702, 584.7, 'URA182', 'equatorial', 265986, 0.004, 183.4, 253.0, 0.1, 174.8, 4.144177, 64.126, 129.745, 77.311, 15.175, 180.0],
    titania:   ['uranus', 'Titania', 703, 788.4, 'URA182', 'equatorial', 436298, 0.002, 184.0, 68.1, 0.1, 29.5, 8.705869, 579.928, 1644.649, 77.311, 15.175, 180.0],
    oberon:    ['uranus', 'Oberon', 704, 761.4, 'URA182', 'equatorial', 583511, 0.002, 132.2, 143.6, 0.1, 76.8, 13.463237, 158.604, 192.798, 77.311, 15.175, 180.0],
    triton:    ['neptune', 'Triton', 801, 1353.4, 'NEP097', 'laplace', 354800, 0.000, 0.0, 63.0, 157.3, 178.1, 5.876994, 0.000, 340.379, 299.8, 43.1, 0.4],
    charon:    ['pluto', 'Charon', 901, 606.0, 'PLU060', 'equatorial', 19600, 0.000, 0.0, 304.1, 0.0, 0.0, 6.387222, 0, 0, 132.993, -6.163, 0.0]
  };

  // ---------------------------------------------------------------------------
  // How each row is propagated (see header). Fields:
  //   periodOf      'L': the page's P is the sidereal period of the mean
  //                 longitude; 'M': it is the anomalistic period (rate of M).
  //   apsidalDir    +1 periapsis advances, -1 regresses, 0 not applied.
  //   nodalDir      +1 node advances, -1 regresses.
  //   longitudeRateDegPerDay   overrides 360/P for 'L' rows (signed: negative
  //                 for a retrograde spatial longitude).
  //   nodalPeriodYears         overrides the page's P node.
  //   nDotDegPerDay2           secular acceleration, added as 0.5 * nDot * t^2.
  //   dMDeg         calibration added to the page's M.
  //   libration     { ampDeg, periodDays, phaseDeg } added to the mean
  //                 longitude: amp * sin(2 pi t / period + phase).
  // ---------------------------------------------------------------------------
  var MODEL = {
    phobos:    { periodOf: 'L', apsidalDir: 1, nodalDir: -1, longitudeRateDegPerDay: 1128.84475937, nDotDegPerDay2: 1.883e-8 },
    deimos:    { periodOf: 'L', apsidalDir: 1, nodalDir: -1, longitudeRateDegPerDay: 285.161886 },
    io:        { periodOf: 'M', apsidalDir: -1, nodalDir: -1 },
    europa:    { periodOf: 'M', apsidalDir: -1, nodalDir: -1 },
    ganymede:  { periodOf: 'M', apsidalDir: 1, nodalDir: -1 },
    callisto:  { periodOf: 'M', apsidalDir: 1, nodalDir: -1 },
    mimas:     { periodOf: 'L', apsidalDir: 1, nodalDir: -1, longitudeRateDegPerDay: 381.994496, dMDeg: 18.43,
                 libration: { ampDeg: 43.44, periodDays: 70.64 * DAYS_PER_YEAR, phaseDeg: 140.79 } },
    enceladus: { periodOf: 'L', apsidalDir: 1, nodalDir: -1, dMDeg: 5.76 },
    tethys:    { periodOf: 'L', apsidalDir: 0, nodalDir: -1, dMDeg: -60.00 },
    dione:     { periodOf: 'L', apsidalDir: 1, nodalDir: -1, dMDeg: -151.16 },
    rhea:      { periodOf: 'L', apsidalDir: 1, nodalDir: -1, dMDeg: -157.37 },
    titan:     { periodOf: 'L', apsidalDir: 1, nodalDir: -1, dMDeg: -156.87 },
    iapetus:   { periodOf: 'L', apsidalDir: 1, nodalDir: -1, dMDeg: 144.38 },
    miranda:   { periodOf: 'L', apsidalDir: 1, nodalDir: -1 },
    ariel:     { periodOf: 'L', apsidalDir: 1, nodalDir: -1 },
    umbriel:   { periodOf: 'L', apsidalDir: 1, nodalDir: -1 },
    titania:   { periodOf: 'L', apsidalDir: 1, nodalDir: -1 },
    oberon:    { periodOf: 'L', apsidalDir: 1, nodalDir: -1 },
    triton:    { periodOf: 'L', apsidalDir: 1, nodalDir: 1, longitudeRateDegPerDay: -61.25725972, nodalPeriodYears: 678.2, dMDeg: -4.0 },
    charon:    { periodOf: 'L', apsidalDir: 1, nodalDir: -1 }
  };

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------

  function toNumber(x, name) {
    var v = Number(x);
    if (!isFinite(v)) {
      throw new TypeError(name + ' must be a finite number, got ' + x);
    }
    return v;
  }

  function checkMoon(name) {
    if (!Object.prototype.hasOwnProperty.call(ELEMENTS, name)) {
      throw new Error('unknown moon "' + name + '"; expected one of ' + NAMES.join(', '));
    }
    return DATA[name];
  }

  function wrapRad(x) {
    x = x % TWO_PI;
    return x < 0 ? x + TWO_PI : x;
  }

  // 3x3 matrices as flat row-major arrays.
  function rotX(deg) {
    var c = Math.cos(deg * DEG), s = Math.sin(deg * DEG);
    return [1, 0, 0, 0, c, -s, 0, s, c];
  }

  function rotZ(deg) {
    var c = Math.cos(deg * DEG), s = Math.sin(deg * DEG);
    return [c, -s, 0, s, c, 0, 0, 0, 1];
  }

  function mul(a, b) {
    var out = new Array(9);
    for (var r = 0; r < 3; r++) {
      for (var c = 0; c < 3; c++) {
        out[3 * r + c] = a[3 * r] * b[c] + a[3 * r + 1] * b[3 + c] + a[3 * r + 2] * b[6 + c];
      }
    }
    return out;
  }

  var ICRF_TO_ECLIPTIC = rotX(-OBLIQUITY_DEG);

  // ---------------------------------------------------------------------------
  // Time: TT = UT + deltaT. Uses Ephemeris.deltaT when available.
  // ---------------------------------------------------------------------------

  var ephemerisOverride = null;

  function ephemeris() {
    if (ephemerisOverride) return ephemerisOverride;
    var g = typeof window !== 'undefined' ? window
      : (typeof globalThis !== 'undefined' ? globalThis : null);
    if (g && g.Ephemeris && typeof g.Ephemeris.deltaT === 'function') return g.Ephemeris;
    return null;
  }

  function useEphemeris(E) {
    ephemerisOverride = (E && typeof E.deltaT === 'function') ? E : null;
  }

  function deltaT(jdUT) {
    var E = ephemeris();
    return E ? E.deltaT(jdUT) : DELTA_T_FALLBACK;
  }

  // The last UT -> TT conversion is memoised: every moon in a frame is
  // evaluated at the same jd, and Ephemeris.deltaT runs a calendar conversion
  // (allocating) on each call, so without this the per-frame path would pay
  // for it once per moon. The cache is keyed on the deltaT source too, so a
  // useEphemeris() swap or a late-loading window.Ephemeris is honoured.
  var lastUt = NaN, lastTt = NaN, lastSource = null;

  function ttFromUt(jdUT) {
    var jd = toNumber(jdUT, 'jd');
    var E = ephemeris();
    if (jd === lastUt && E === lastSource) return lastTt;
    lastUt = jd;
    lastSource = E;
    lastTt = jd + (E ? E.deltaT(jd) : DELTA_T_FALLBACK) / 86400;
    return lastTt;
  }

  // ---------------------------------------------------------------------------
  // Frames
  // ---------------------------------------------------------------------------

  function applyMatrix(m, x, y, z, out) {
    out.x = m[0] * x + m[1] * y + m[2] * z;
    out.y = m[3] * x + m[4] * y + m[5] * z;
    out.z = m[6] * x + m[7] * y + m[8] * z;
    return out;
  }

  // Unit vector of an ICRF direction (RA, Dec in degrees) in ecliptic J2000.
  function icrfToEcliptic(ra, dec) {
    var a = toNumber(ra, 'ra') * DEG, d = toNumber(dec, 'dec') * DEG;
    var cd = Math.cos(d);
    return applyMatrix(ICRF_TO_ECLIPTIC, cd * Math.cos(a), cd * Math.sin(a), Math.sin(d), { x: 0, y: 0, z: 0 });
  }

  function poleEcliptic(planet) {
    var p = POLES[planet];
    if (!p) {
      throw new Error('no IAU pole for "' + planet + '"');
    }
    return icrfToEcliptic(p.ra, p.dec);
  }

  function systemFrame(planet) {
    return { normal: poleEcliptic(planet) };
  }

  // Reference plane (pole RA, Dec) -> ICRF: Rz(RA + 90) Rx(90 - Dec). The x
  // axis of the reference frame is the plane's ascending node on the ICRF
  // equator, from which the page measures the node longitude.
  function referenceToEcliptic(poleRa, poleDec) {
    return mul(ICRF_TO_ECLIPTIC, mul(rotZ(poleRa + 90), rotX(90 - poleDec)));
  }

  // ---------------------------------------------------------------------------
  // Build the per-moon records
  // ---------------------------------------------------------------------------

  function buildRecord(name) {
    var e = ELEMENTS[name];
    var m = MODEL[name];
    var inclinationDeg = e[10];
    var pApsis = e[13];
    var pNode = m.nodalPeriodYears !== undefined ? m.nodalPeriodYears : e[14];
    var omegaDot = (pApsis > 0 && m.apsidalDir !== 0) ? m.apsidalDir * 360 / (pApsis * DAYS_PER_YEAR) : 0;
    var nodeDot = pNode > 0 ? m.nodalDir * 360 / (pNode * DAYS_PER_YEAR) : 0;
    // Mean rate of the spatial longitude about the reference pole: for a
    // retrograde orbit the in-plane motion counts backwards.
    var sense = Math.cos(inclinationDeg * DEG) >= 0 ? 1 : -1;
    var n;
    if (m.periodOf === 'M') {
      n = 360 / e[12];
    } else {
      var longitudeRate = m.longitudeRateDegPerDay !== undefined ? m.longitudeRateDegPerDay : 360 / e[12];
      n = sense * (longitudeRate - nodeDot) - omegaDot;
    }
    var spatialRate = nodeDot + sense * (n + omegaDot);
    var rec = {
      name: name,
      parent: e[0],
      displayName: e[1],
      jplId: e[2],
      radiusKm: e[3],
      ephemeris: e[4],
      frame: e[5],
      epochJd: J2000,
      aKm: e[6],
      aAu: e[6] / AU_KM,
      e: e[7],
      omegaDeg: e[8],
      MDeg: e[9],
      inclinationDeg: inclinationDeg,
      nodeDeg: e[11],
      pageperiodDays: e[12],
      apsidalPeriodYears: pApsis,
      nodalPeriodYears: pNode,
      poleRa: e[15],
      poleDec: e[16],
      tiltDeg: e[17],
      retrograde: sense < 0,
      // model quantities
      nDegPerDay: n,
      omegaDotDegPerDay: omegaDot,
      nodeDotDegPerDay: nodeDot,
      nDotDegPerDay2: m.nDotDegPerDay2 || 0,
      dMDeg: m.dMDeg || 0,
      libration: m.libration || null,
      periodDays: 360 / Math.abs(spatialRate),
      matrix: referenceToEcliptic(e[15], e[16])
    };
    rec.M0Rad = (rec.MDeg + rec.dMDeg) * DEG;
    rec.omega0Rad = rec.omegaDeg * DEG;
    rec.node0Rad = rec.nodeDeg * DEG;
    rec.nRad = n * DEG;
    rec.omegaDotRad = omegaDot * DEG;
    rec.nodeDotRad = nodeDot * DEG;
    rec.nDotRad = rec.nDotDegPerDay2 * DEG;
    rec.cosI = Math.cos(inclinationDeg * DEG);
    rec.sinI = Math.sin(inclinationDeg * DEG);
    rec.sqrt1me2 = Math.sqrt(1 - rec.e * rec.e);
    return rec;
  }

  var DATA = {};
  for (var ni = 0; ni < NAMES.length; ni++) {
    DATA[NAMES[ni]] = buildRecord(NAMES[ni]);
  }

  // ---------------------------------------------------------------------------
  // Position
  // ---------------------------------------------------------------------------

  // Kepler's equation for small e (max 0.03 here): Newton from E = M + e sin M.
  function solveKepler(M, e) {
    var E = M + e * Math.sin(M);
    for (var i = 0; i < 20; i++) {
      var dE = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
      E -= dE;
      if (Math.abs(dE) < 1e-12) break;
    }
    return E;
  }

  // Parent-centric ecliptic J2000 position (AU) at a TT Julian date, written
  // into out {x, y, z, r}. No allocations.
  function positionTT(rec, jdTT, out) {
    var t = jdTT - rec.epochJd;
    var omega = rec.omega0Rad + rec.omegaDotRad * t;
    var node = rec.node0Rad + rec.nodeDotRad * t;
    var M = rec.M0Rad + rec.nRad * t + 0.5 * rec.nDotRad * t * t;
    if (rec.libration) {
      M += rec.libration.ampDeg * DEG *
        Math.sin(TWO_PI * t / rec.libration.periodDays + rec.libration.phaseDeg * DEG);
    }
    M = wrapRad(M);
    var E = solveKepler(M, rec.e);
    var cosE = Math.cos(E);
    var xp = rec.aAu * (cosE - rec.e);
    var yp = rec.aAu * rec.sqrt1me2 * Math.sin(E);

    var cw = Math.cos(omega), sw = Math.sin(omega);
    var cO = Math.cos(node), sO = Math.sin(node);
    var cI = rec.cosI, sI = rec.sinI;
    // orbital plane -> reference plane: Rz(node) Rx(i) Rz(omega)
    var x = (cw * cO - sw * sO * cI) * xp + (-sw * cO - cw * sO * cI) * yp;
    var y = (cw * sO + sw * cO * cI) * xp + (-sw * sO + cw * cO * cI) * yp;
    var z = (sw * sI) * xp + (cw * sI) * yp;
    applyMatrix(rec.matrix, x, y, z, out);
    out.r = rec.aAu * (1 - rec.e * cosE);
    return out;
  }

  // Parent-centric ecliptic J2000 position {x, y, z, r} in AU at a UT Julian
  // date. Pass an object as `out` to avoid allocating.
  function position(name, jdUT, out) {
    var rec = checkMoon(name);
    var jdTT = ttFromUt(jdUT);
    return positionTT(rec, jdTT, out || { x: 0, y: 0, z: 0, r: 0 });
  }

  // n points {x, y, z, r} sampled over one sidereal period centred on jdUT,
  // parent-centric ecliptic J2000, AU. The last point precedes the first by
  // one step, so the array closes as a loop.
  function orbitPoints(name, jdUT, n) {
    var rec = checkMoon(name);
    var count = n === undefined ? 128 : Math.max(3, Math.floor(toNumber(n, 'n')));
    var jdTT = ttFromUt(jdUT);
    var start = jdTT - rec.periodDays / 2;
    var step = rec.periodDays / count;
    var pts = new Array(count);
    for (var i = 0; i < count; i++) {
      pts[i] = positionTT(rec, start + i * step, { x: 0, y: 0, z: 0, r: 0 });
    }
    return pts;
  }

  function periodDays(name) {
    return checkMoon(name).periodDays;
  }

  function parentOf(name) {
    return checkMoon(name).parent;
  }

  return {
    SYSTEMS: SYSTEMS,
    NAMES: NAMES,
    DATA: DATA,
    ELEMENTS: ELEMENTS,
    MODEL: MODEL,
    POLES: POLES,
    PLANET_RADIUS_KM: PLANET_RADIUS_KM,
    PARENT_JPL_ID: PARENT_JPL_ID,
    icrfToEcliptic: icrfToEcliptic,
    poleEcliptic: poleEcliptic,
    systemFrame: systemFrame,
    position: position,
    orbitPoints: orbitPoints,
    periodDays: periodDays,
    parentOf: parentOf,
    deltaT: deltaT,
    ttFromUt: ttFromUt,
    useEphemeris: useEphemeris,
    J2000: J2000,
    AU_KM: AU_KM,
    OBLIQUITY_DEG: OBLIQUITY_DEG
  };
});
