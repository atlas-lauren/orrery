/*
 * ephemeris.js -- Keplerian planetary positions and a truncated lunar theory.
 *
 * Classic script (no import/export). Attaches window.Ephemeris in browsers and
 * exports the same object via module.exports in Node. Pure functions, no DOM.
 *
 * Sources
 *   Planets : E. M. Standish, "Keplerian Elements for Approximate Positions of
 *             the Major Planets" (JPL Solar System Dynamics). Table 1 covers
 *             1800 AD - 2050 AD; Table 2a covers 3000 BC - 3000 AD with the
 *             Table 2b correction terms (b, c, s, f) for Jupiter .. Pluto.
 *   Moon    : J. Meeus, "Astronomical Algorithms" 2nd ed., chapter 47
 *             (ELP-2000/82 truncated periodic terms), precessed to J2000
 *             with the ecliptic precession of chapter 21.
 *   Delta T : F. Espenak & J. Meeus, polynomial expressions (NASA Eclipse web
 *             site), valid -1999 .. +3000 with the long-term parabola outside.
 *
 * Frame: heliocentric ecliptic J2000, right-handed, AU. x toward the vernal
 * equinox, z toward ecliptic north. Longitudes in [0, 360) degrees.
 *
 * Time: every public function takes a Julian Date in UT (a JS number). The
 * Keplerian elements are evaluated at TT = UT + deltaT(UT).
 *
 * 'earth' is the true Earth, not the Earth-Moon barycenter: the JPL element
 * set describes the EMB, so Earth = EMB - moonGeocentric / (1 + 81.30056),
 * where 81.30056 is the Earth/Moon mass ratio.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.Ephemeris = api;
  } else if (root) {
    root.Ephemeris = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEG = Math.PI / 180;
  var RAD = 180 / Math.PI;
  var J2000 = 2451545.0;
  var AU_KM = 149597870.7;
  var EARTH_MOON_MASS_RATIO = 81.30056;
  var UNIX_EPOCH_JD = 2440587.5;
  var JD_1800 = 2378496.5; // 1800-01-01 00:00 UT
  var JD_2050 = 2469807.5; // 2050-01-01 00:00 UT

  var BODIES = ['mercury', 'venus', 'earth', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune', 'pluto'];

  // ---------------------------------------------------------------------------
  // JPL Keplerian elements. Each body: [values at J2000, rates per century]
  // Order: a (AU), e, I (deg), L (deg), long. perihelion (deg), long. node (deg)
  // 'earth' rows are the Earth-Moon barycenter.
  // ---------------------------------------------------------------------------

  // Table 1: 1800 AD - 2050 AD
  var TABLE_1 = {
    mercury: [[0.38709927, 0.20563593, 7.00497902, 252.25032350, 77.45779628, 48.33076593],
              [0.00000037, 0.00001906, -0.00594749, 149472.67411175, 0.16047689, -0.12534081]],
    venus:   [[0.72333566, 0.00677672, 3.39467605, 181.97909950, 131.60246718, 76.67984255],
              [0.00000390, -0.00004107, -0.00078890, 58517.81538729, 0.00268329, -0.27769418]],
    earth:   [[1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0.0],
              [0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0.0]],
    mars:    [[1.52371034, 0.09339410, 1.84969142, -4.55343205, -23.94362959, 49.55953891],
              [0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343]],
    jupiter: [[5.20288700, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909],
              [-0.00011607, -0.00013253, -0.00183714, 3034.74612775, 0.21252668, 0.20469106]],
    saturn:  [[9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448],
              [-0.00125060, -0.00050991, 0.00193609, 1222.49362201, -0.41897216, -0.28867794]],
    uranus:  [[19.18916464, 0.04725744, 0.77263783, 313.23810451, 170.95427630, 74.01692503],
              [-0.00196176, -0.00004397, -0.00242939, 428.48202785, 0.40805281, 0.04240589]],
    neptune: [[30.06992276, 0.00859048, 1.77004347, -55.12002969, 44.96476227, 131.78422574],
              [0.00026291, 0.00005105, 0.00035372, 218.45945325, -0.32241464, -0.00508664]],
    pluto:   [[39.48211675, 0.24882730, 17.14001206, 238.92903833, 224.06891629, 110.30393684],
              [-0.00031596, 0.00005170, 0.00004818, 145.20780515, -0.04062942, -0.01183482]]
  };

  // Table 2a: 3000 BC - 3000 AD
  var TABLE_2 = {
    mercury: [[0.38709843, 0.20563661, 7.00559432, 252.25166724, 77.45771895, 48.33961819],
              [0.00000000, 0.00002123, -0.00590158, 149472.67486623, 0.15940013, -0.12214182]],
    venus:   [[0.72332102, 0.00676399, 3.39777545, 181.97970850, 131.76755713, 76.67261496],
              [-0.00000026, -0.00005107, 0.00043494, 58517.81560260, 0.05679648, -0.27274174]],
    earth:   [[1.00000018, 0.01673163, -0.00054346, 100.46691572, 102.93005885, -5.11260389],
              [-0.00000003, -0.00003661, -0.01337178, 35999.37306329, 0.31795260, -0.24123856]],
    mars:    [[1.52371243, 0.09336511, 1.85181869, -4.56813164, -23.91744784, 49.71320984],
              [0.00000097, 0.00009149, -0.00724757, 19140.29934243, 0.45223625, -0.26852431]],
    jupiter: [[5.20248019, 0.04853590, 1.29861416, 34.33479152, 14.27495244, 100.29282654],
              [-0.00002864, 0.00018026, -0.00322699, 3034.90371757, 0.18199196, 0.13024619]],
    saturn:  [[9.54149883, 0.05550825, 2.49424102, 50.07571329, 92.86136063, 113.63998702],
              [-0.00003065, -0.00032044, 0.00451969, 1222.11494724, 0.54179478, -0.25015002]],
    uranus:  [[19.18797948, 0.04685740, 0.77298127, 314.20276625, 172.43404441, 73.96250215],
              [-0.00020455, -0.00001550, -0.00180155, 428.49512952, 0.09266985, 0.05739699]],
    neptune: [[30.06952752, 0.00895439, 1.77005520, 304.22289287, 46.68158724, 131.78635853],
              [0.00006447, 0.00000818, 0.00022400, 218.46515314, 0.01009938, -0.00606302]],
    pluto:   [[39.48686035, 0.24885238, 17.14104260, 238.96535011, 224.09702598, 110.30167986],
              [0.00449751, 0.00006016, 0.00000501, 145.18042903, -0.00968827, -0.00809981]]
  };

  // Table 2b: additional terms for the mean anomaly, used only with TABLE_2.
  // M = L - long.peri + b*T^2 + c*cos(f*T) + s*sin(f*T); f in deg/century.
  var TABLE_2B = {
    jupiter: { b: -0.00012452, c: 0.06064060, s: -0.35635438, f: 38.35125000 },
    saturn:  { b: 0.00025899, c: -0.13434469, s: 0.87320147, f: 38.35125000 },
    uranus:  { b: 0.00058331, c: -0.97731848, s: 0.17689245, f: 7.67025000 },
    neptune: { b: -0.00041348, c: 0.68346318, s: -0.10162547, f: 7.67025000 },
    pluto:   { b: -0.01262724, c: 0.0, s: 0.0, f: 0.0 }
  };

  var PERIOD_DAYS = {
    mercury: 87.9691,
    venus: 224.701,
    earth: 365.256,
    mars: 686.980,
    jupiter: 4332.589,
    saturn: 10759.22,
    uranus: 30688.5,
    neptune: 60182.0,
    pluto: 90560.0,
    moon: 27.321661
  };

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------

  function mod(a, n) {
    return a - n * Math.floor(a / n);
  }

  function wrap360(deg) {
    return mod(deg, 360);
  }

  function wrap180(deg) {
    return mod(deg + 180, 360) - 180;
  }

  function toNumber(x, name) {
    var v = Number(x);
    if (!isFinite(v)) {
      throw new TypeError(name + ' must be a finite number, got ' + x);
    }
    return v;
  }

  function checkBody(body) {
    if (BODIES.indexOf(body) < 0) {
      throw new Error('unknown body "' + body + '"; expected one of ' + BODIES.join(', '));
    }
  }

  // ---------------------------------------------------------------------------
  // Calendar (proleptic Gregorian, astronomical year numbering: 0 = 1 BCE)
  // ---------------------------------------------------------------------------

  function jdFromDate(date) {
    var ms = date instanceof Date ? date.getTime() : toNumber(date, 'date');
    return ms / 86400000 + UNIX_EPOCH_JD;
  }

  function dateFromJd(jd) {
    return new Date((toNumber(jd, 'jd') - UNIX_EPOCH_JD) * 86400000);
  }

  // Meeus, Astronomical Algorithms ch. 7, Gregorian branch, with floor() so it
  // stays valid for negative years. The day may carry a fraction.
  function jdFromCivil(year, month, day, hour, minute, second) {
    var y = toNumber(year, 'year');
    var m = toNumber(month, 'month');
    var d = toNumber(day, 'day');
    var hh = hour === undefined ? 0 : toNumber(hour, 'hour');
    var mi = minute === undefined ? 0 : toNumber(minute, 'minute');
    var ss = second === undefined ? 0 : toNumber(second, 'second');
    if (m <= 2) {
      y -= 1;
      m += 12;
    }
    var A = Math.floor(y / 100);
    var B = 2 - A + Math.floor(A / 4);
    var jd = Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1)) + d + B - 1524.5;
    return jd + (hh + mi / 60 + ss / 3600) / 24;
  }

  // Richards' algorithm (Explanatory Supplement, 3rd ed.) for the proleptic
  // Gregorian calendar; floor-based so negative years round trip exactly.
  function civilFromJdn(J) {
    var f = J + 1401 + Math.floor((Math.floor((4 * J + 274277) / 146097) * 3) / 4) - 38;
    var e = 4 * f + 3;
    var g = Math.floor(mod(e, 1461) / 4);
    var h = 5 * g + 2;
    var day = Math.floor(mod(h, 153) / 5) + 1;
    var month = mod(Math.floor(h / 153) + 2, 12) + 1;
    var year = Math.floor(e / 1461) - 4716 + Math.floor((14 - month) / 12);
    return { year: year, month: month, day: day };
  }

  function civilFromJd(jd) {
    var v = toNumber(jd, 'jd') + 0.5;
    var Z = Math.floor(v);
    var F = v - Z;
    // Round the day fraction to the nearest millisecond so 12:00 stays 12:00.
    var secs = Math.round(F * 86400 * 1000) / 1000;
    if (secs >= 86400) {
      secs -= 86400;
      Z += 1;
    }
    var ymd = civilFromJdn(Z);
    var hour = Math.floor(secs / 3600);
    var minute = Math.floor((secs - hour * 3600) / 60);
    var second = Math.round((secs - hour * 3600 - minute * 60) * 1000) / 1000;
    return { year: ymd.year, month: ymd.month, day: ymd.day, hour: hour, minute: minute, second: second };
  }

  // ---------------------------------------------------------------------------
  // Delta T = TT - UT (seconds), Espenak & Meeus polynomials
  // ---------------------------------------------------------------------------

  function deltaT(jd) {
    var c = civilFromJd(toNumber(jd, 'jd'));
    var y = c.year + (c.month - 0.5) / 12;
    var t, u;
    if (y < -500) {
      u = (y - 1820) / 100;
      return -20 + 32 * u * u;
    }
    if (y < 500) {
      u = y / 100;
      return 10583.6 - 1014.41 * u + 33.78311 * u * u - 5.952053 * u * u * u
        - 0.1798452 * Math.pow(u, 4) + 0.022174192 * Math.pow(u, 5) + 0.0090316521 * Math.pow(u, 6);
    }
    if (y < 1600) {
      u = (y - 1000) / 100;
      return 1574.2 - 556.01 * u + 71.23472 * u * u + 0.319781 * u * u * u
        - 0.8503463 * Math.pow(u, 4) - 0.005050998 * Math.pow(u, 5) + 0.0083572073 * Math.pow(u, 6);
    }
    if (y < 1700) {
      t = y - 1600;
      return 120 - 0.9808 * t - 0.01532 * t * t + t * t * t / 7129;
    }
    if (y < 1800) {
      t = y - 1700;
      return 8.83 + 0.1603 * t - 0.0059285 * t * t + 0.00013336 * t * t * t - Math.pow(t, 4) / 1174000;
    }
    if (y < 1860) {
      t = y - 1800;
      return 13.72 - 0.332447 * t + 0.0068612 * t * t + 0.0041116 * t * t * t
        - 0.00037436 * Math.pow(t, 4) + 0.0000121272 * Math.pow(t, 5)
        - 0.0000001699 * Math.pow(t, 6) + 0.000000000875 * Math.pow(t, 7);
    }
    if (y < 1900) {
      t = y - 1860;
      return 7.62 + 0.5737 * t - 0.251754 * t * t + 0.01680668 * t * t * t
        - 0.0004473624 * Math.pow(t, 4) + Math.pow(t, 5) / 233174;
    }
    if (y < 1920) {
      t = y - 1900;
      return -2.79 + 1.494119 * t - 0.0598939 * t * t + 0.0061966 * t * t * t - 0.000197 * Math.pow(t, 4);
    }
    if (y < 1941) {
      t = y - 1920;
      return 21.20 + 0.84493 * t - 0.076100 * t * t + 0.0020936 * t * t * t;
    }
    if (y < 1961) {
      t = y - 1950;
      return 29.07 + 0.407 * t - t * t / 233 + t * t * t / 2547;
    }
    if (y < 1986) {
      t = y - 1975;
      return 45.45 + 1.067 * t - t * t / 260 - t * t * t / 718;
    }
    if (y < 2005) {
      t = y - 2000;
      return 63.86 + 0.3345 * t - 0.060374 * t * t + 0.0017275 * t * t * t
        + 0.000651814 * Math.pow(t, 4) + 0.00002373599 * Math.pow(t, 5);
    }
    if (y < 2050) {
      t = y - 2000;
      return 62.92 + 0.32217 * t + 0.005589 * t * t;
    }
    if (y < 2150) {
      u = (y - 1820) / 100;
      return -20 + 32 * u * u - 0.5628 * (2150 - y);
    }
    u = (y - 1820) / 100;
    return -20 + 32 * u * u;
  }

  function ttFromUt(jdUT) {
    return jdUT + deltaT(jdUT) / 86400;
  }

  // ---------------------------------------------------------------------------
  // Planets
  // ---------------------------------------------------------------------------

  function usesShortSet(jdUT) {
    return jdUT >= JD_1800 && jdUT <= JD_2050;
  }

  function elementSet(jd) {
    return usesShortSet(toNumber(jd, 'jd')) ? 'jpl-1800-2050' : 'jpl-3000bc-3000ad';
  }

  // Solve Kepler's equation M = E - e sin E (angles in degrees), JPL method:
  // e* = e in degrees, Newton iteration until |dE| < 1e-6 deg.
  function solveKepler(Mdeg, e) {
    var eStar = e * RAD;
    var E = Mdeg + eStar * Math.sin(Mdeg * DEG);
    for (var i = 0; i < 50; i++) {
      var dM = Mdeg - (E - eStar * Math.sin(E * DEG));
      var dE = dM / (1 - e * Math.cos(E * DEG));
      E += dE;
      if (Math.abs(dE) < 1e-6) {
        break;
      }
    }
    return E;
  }

  function spherical(x, y, z) {
    var r = Math.sqrt(x * x + y * y + z * z);
    var lon = wrap360(Math.atan2(y, x) * RAD);
    var lat = r > 0 ? Math.asin(z / r) * RAD : 0;
    return { x: x, y: y, z: z, lon: lon, lat: lat, r: r };
  }

  // Heliocentric ecliptic J2000 position of a JPL element set body. For
  // 'earth' this is the Earth-Moon barycenter.
  function keplerian(body, jdUT) {
    var jdTT = ttFromUt(jdUT);
    var T = (jdTT - J2000) / 36525;
    var shortSet = usesShortSet(jdUT);
    var row = (shortSet ? TABLE_1 : TABLE_2)[body];
    var v = row[0];
    var d = row[1];

    var a = v[0] + d[0] * T;
    var e = v[1] + d[1] * T;
    var I = v[2] + d[2] * T;
    var L = v[3] + d[3] * T;
    var wbar = v[4] + d[4] * T;
    var Omega = v[5] + d[5] * T;

    var omega = wbar - Omega;
    var M = L - wbar;
    if (!shortSet && TABLE_2B[body]) {
      var k = TABLE_2B[body];
      M += k.b * T * T + k.c * Math.cos(k.f * T * DEG) + k.s * Math.sin(k.f * T * DEG);
    }
    M = wrap180(M);

    var E = solveKepler(M, e) * DEG;
    var xp = a * (Math.cos(E) - e);
    var yp = a * Math.sqrt(1 - e * e) * Math.sin(E);

    var cw = Math.cos(omega * DEG), sw = Math.sin(omega * DEG);
    var cO = Math.cos(Omega * DEG), sO = Math.sin(Omega * DEG);
    var cI = Math.cos(I * DEG), sI = Math.sin(I * DEG);

    var x = (cw * cO - sw * sO * cI) * xp + (-sw * cO - cw * sO * cI) * yp;
    var y = (cw * sO + sw * cO * cI) * xp + (-sw * sO + cw * cO * cI) * yp;
    var z = (sw * sI) * xp + (cw * sI) * yp;
    return spherical(x, y, z);
  }

  function heliocentric(body, jd) {
    checkBody(body);
    var jdUT = toNumber(jd, 'jd');
    if (body !== 'earth') {
      return keplerian(body, jdUT);
    }
    // True Earth = EMB - (Moon mass fraction) * geocentric Moon vector.
    var emb = keplerian('earth', jdUT);
    var moon = moonGeocentric(jdUT);
    var f = 1 / (1 + EARTH_MOON_MASS_RATIO);
    return spherical(emb.x - f * moon.x, emb.y - f * moon.y, emb.z - f * moon.z);
  }

  // ---------------------------------------------------------------------------
  // Moon (Meeus ch. 47). Periodic terms: [D, M, M', F, coefficient]
  // ---------------------------------------------------------------------------

  var MOON_LR = [
    [0, 0, 1, 0, 6288774, -20905355],
    [2, 0, -1, 0, 1274027, -3699111],
    [2, 0, 0, 0, 658314, -2955968],
    [0, 0, 2, 0, 213618, -569925],
    [0, 1, 0, 0, -185116, 48888],
    [0, 0, 0, 2, -114332, -3149],
    [2, 0, -2, 0, 58793, 246158],
    [2, -1, -1, 0, 57066, -152138],
    [2, 0, 1, 0, 53322, -170733],
    [2, -1, 0, 0, 45758, -204586],
    [0, 1, -1, 0, -40923, -129620],
    [1, 0, 0, 0, -34720, 108743],
    [0, 1, 1, 0, -30383, 104755],
    [2, 0, 0, -2, 15327, 10321],
    [0, 0, 1, 2, -12528, 0],
    [0, 0, 1, -2, 10980, 79661],
    [4, 0, -1, 0, 10675, -34782],
    [0, 0, 3, 0, 10034, -23210],
    [4, 0, -2, 0, 8548, -21636],
    [2, 1, -1, 0, -7888, 24208],
    [2, 1, 0, 0, -6766, 30824],
    [1, 0, -1, 0, -5163, -8379],
    [1, 1, 0, 0, 4987, -16675],
    [2, -1, 1, 0, 4036, -12831],
    [2, 0, 2, 0, 3994, -10445],
    [4, 0, 0, 0, 3861, -11650],
    [2, 0, -3, 0, 3665, 14403],
    [0, 1, -2, 0, -2689, -7003],
    [2, 0, -1, 2, -2602, 0],
    [2, -1, -2, 0, 2390, 10056],
    [1, 0, 1, 0, -2348, 6322],
    [2, -2, 0, 0, 2236, -9884],
    [0, 1, 2, 0, -2120, 5751],
    [0, 2, 0, 0, -2069, 0],
    [2, -2, -1, 0, 2048, -4950],
    [2, 0, 1, -2, -1773, 4130],
    [2, 0, 0, 2, -1595, 0],
    [4, -1, -1, 0, 1215, -3958],
    [0, 0, 2, 2, -1110, 0],
    [3, 0, -1, 0, -892, 3258],
    [2, 1, 1, 0, -810, 2616],
    [4, -1, -2, 0, 759, -1897],
    [0, 2, -1, 0, -713, -2117],
    [2, 2, -1, 0, -700, 2354],
    [2, 1, -2, 0, 691, 0],
    [2, -1, 0, -2, 596, 0],
    [4, 0, 1, 0, 549, -1423],
    [0, 0, 4, 0, 537, -1117],
    [4, -1, 0, 0, 520, -1571],
    [1, 0, -2, 0, -487, -1739],
    [2, 1, 0, -2, -399, 0],
    [0, 0, 2, -2, -381, -4421],
    [1, 1, 1, 0, 351, 0],
    [3, 0, -2, 0, -340, 0],
    [4, 0, -3, 0, 330, 0],
    [2, -1, 2, 0, 327, 0],
    [0, 2, 1, 0, -323, 1165],
    [1, 1, -1, 0, 299, 0],
    [2, 0, 3, 0, 294, 0],
    [2, 0, -1, -2, 0, 8752]
  ];

  var MOON_B = [
    [0, 0, 0, 1, 5128122],
    [0, 0, 1, 1, 280602],
    [0, 0, 1, -1, 277693],
    [2, 0, 0, -1, 173237],
    [2, 0, -1, 1, 55413],
    [2, 0, -1, -1, 46271],
    [2, 0, 0, 1, 32573],
    [0, 0, 2, 1, 17198],
    [2, 0, 1, -1, 9266],
    [0, 0, 2, -1, 8822],
    [2, -1, 0, -1, 8216],
    [2, 0, -2, -1, 4324],
    [2, 0, 1, 1, 4200],
    [2, 1, 0, -1, -3359],
    [2, -1, -1, 1, 2463],
    [2, -1, 0, 1, 2211],
    [2, -1, -1, -1, 2065],
    [0, 1, -1, -1, -1870],
    [4, 0, -1, -1, 1828],
    [0, 1, 0, 1, -1794],
    [0, 0, 0, 3, -1749],
    [0, 1, -1, 1, -1565],
    [1, 0, 0, 1, -1491],
    [0, 1, 1, 1, -1475],
    [0, 1, 1, -1, -1410],
    [0, 1, 0, -1, -1344],
    [1, 0, 0, -1, -1335],
    [0, 0, 3, 1, 1107],
    [4, 0, 0, -1, 1021],
    [4, 0, -1, 1, 833],
    [0, 0, 1, -3, 777],
    [4, 0, -2, 1, 671],
    [2, 0, 0, -3, 607],
    [2, 0, 2, -1, 596],
    [2, -1, 1, -1, 491],
    [2, 0, -2, 1, -451],
    [0, 0, 3, -1, 439],
    [2, 0, 2, 1, 422],
    [2, 0, -3, -1, 421],
    [2, 1, -1, 1, -366],
    [2, 1, 0, 1, -351],
    [4, 0, 0, 1, 331],
    [2, -1, 1, 1, 315],
    [2, -2, 0, -1, 302],
    [0, 0, 1, 3, -283],
    [2, 1, 1, -1, -229],
    [1, 1, 0, -1, 223],
    [1, 1, 0, 1, 223],
    [0, 1, -2, -1, -220],
    [2, 1, -1, -1, -220],
    [1, 0, 1, 1, -185],
    [2, -1, -2, -1, 181],
    [0, 1, 2, 1, -177],
    [4, 0, -2, -1, 176],
    [4, -1, -1, -1, -166],
    [1, 0, 1, -1, -164],
    [4, 0, 1, -1, 132],
    [1, 0, -1, -1, -119],
    [4, -1, 0, -1, 115],
    [2, -2, 0, 1, 107]
  ];

  // Geocentric Moon in the ecliptic of date (Meeus 47): lon, lat in degrees,
  // distance in km.
  function moonOfDate(T) {
    var T2 = T * T, T3 = T2 * T, T4 = T3 * T;
    var Lp = wrap360(218.3164477 + 481267.88123421 * T - 0.0015786 * T2 + T3 / 538841 - T4 / 65194000);
    var D = wrap360(297.8501921 + 445267.1114034 * T - 0.0018819 * T2 + T3 / 545868 - T4 / 113065000);
    var M = wrap360(357.5291092 + 35999.0502909 * T - 0.0001536 * T2 + T3 / 24490000);
    var Mp = wrap360(134.9633964 + 477198.8675055 * T + 0.0087414 * T2 + T3 / 69699 - T4 / 14712000);
    var F = wrap360(93.2720950 + 483202.0175233 * T - 0.0036539 * T2 - T3 / 3526000 + T4 / 863310000);
    var A1 = wrap360(119.75 + 131.849 * T);
    var A2 = wrap360(53.09 + 479264.290 * T);
    var A3 = wrap360(313.45 + 481266.484 * T);
    var Ecc = 1 - 0.002516 * T - 0.0000074 * T2;
    var E2 = Ecc * Ecc;

    var sl = 0, sr = 0, sb = 0, i, t, arg, mult;
    for (i = 0; i < MOON_LR.length; i++) {
      t = MOON_LR[i];
      arg = (t[0] * D + t[1] * M + t[2] * Mp + t[3] * F) * DEG;
      mult = t[1] === 0 ? 1 : (Math.abs(t[1]) === 1 ? Ecc : E2);
      sl += t[4] * mult * Math.sin(arg);
      sr += t[5] * mult * Math.cos(arg);
    }
    for (i = 0; i < MOON_B.length; i++) {
      t = MOON_B[i];
      arg = (t[0] * D + t[1] * M + t[2] * Mp + t[3] * F) * DEG;
      mult = t[1] === 0 ? 1 : (Math.abs(t[1]) === 1 ? Ecc : E2);
      sb += t[4] * mult * Math.sin(arg);
    }
    sl += 3958 * Math.sin(A1 * DEG) + 1962 * Math.sin((Lp - F) * DEG) + 318 * Math.sin(A2 * DEG);
    sb += -2235 * Math.sin(Lp * DEG) + 382 * Math.sin(A3 * DEG)
      + 175 * Math.sin((A1 - F) * DEG) + 175 * Math.sin((A1 + F) * DEG)
      + 127 * Math.sin((Lp - Mp) * DEG) - 115 * Math.sin((Lp + Mp) * DEG);

    return {
      lon: wrap360(Lp + sl / 1e6),
      lat: sb / 1e6,
      distKm: 385000.56 + sr / 1000
    };
  }

  // Rotate ecliptic coordinates of date (epoch T centuries from J2000) to the
  // ecliptic of J2000 (Meeus ch. 21, eqs. 21.5 and 21.7, with t = -T).
  function eclipticOfDateToJ2000(lonDeg, latDeg, T) {
    var t = -T;
    var eta = ((47.0029 - 0.06603 * T + 0.000598 * T * T) * t
      + (-0.03302 + 0.000598 * T) * t * t + 0.000060 * t * t * t) / 3600;
    var Pi = 174.876384 + (3289.4789 * T + 0.60622 * T * T
      - (869.8089 + 0.50491 * T) * t + 0.03536 * t * t) / 3600;
    var p = ((5029.0966 + 2.22226 * T - 0.000042 * T * T) * t
      + (1.11113 - 0.000042 * T) * t * t - 0.000006 * t * t * t) / 3600;

    var lam = lonDeg * DEG, bet = latDeg * DEG;
    var ce = Math.cos(eta * DEG), se = Math.sin(eta * DEG);
    var sinPiL = Math.sin(Pi * DEG - lam), cosPiL = Math.cos(Pi * DEG - lam);
    var A = ce * Math.sin(bet) + se * Math.cos(bet) * sinPiL;
    var B = Math.cos(bet) * cosPiL;
    var C = ce * Math.cos(bet) * sinPiL - se * Math.sin(bet);
    var lonOut = wrap360(p + Pi - Math.atan2(C, B) * RAD);
    var latOut = Math.asin(Math.max(-1, Math.min(1, A))) * RAD;
    return { lon: lonOut, lat: latOut };
  }

  // Geocentric Moon, ecliptic J2000, AU.
  function moonGeocentric(jd) {
    var jdUT = toNumber(jd, 'jd');
    var T = (ttFromUt(jdUT) - J2000) / 36525;
    var m = moonOfDate(T);
    var j = eclipticOfDateToJ2000(m.lon, m.lat, T);
    var r = m.distKm / AU_KM;
    var cl = Math.cos(j.lon * DEG), sl = Math.sin(j.lon * DEG);
    var cb = Math.cos(j.lat * DEG), sb = Math.sin(j.lat * DEG);
    return { x: r * cb * cl, y: r * cb * sl, z: r * sb, lon: j.lon, lat: j.lat, r: r };
  }

  // ---------------------------------------------------------------------------
  // Convenience
  // ---------------------------------------------------------------------------

  function all(jd) {
    var jdUT = toNumber(jd, 'jd');
    var out = {};
    for (var i = 0; i < BODIES.length; i++) {
      out[BODIES[i]] = heliocentric(BODIES[i], jdUT);
    }
    out.moon = moonGeocentric(jdUT);
    return out;
  }

  function orbitalPeriodDays(body) {
    if (!Object.prototype.hasOwnProperty.call(PERIOD_DAYS, body)) {
      throw new Error('unknown body "' + body + '"');
    }
    return PERIOD_DAYS[body];
  }

  var range = {
    jdMin: jdFromCivil(-3000, 1, 1),
    jdMax: jdFromCivil(3000, 12, 31, 23, 59, 59)
  };

  return {
    BODIES: BODIES,
    jdFromDate: jdFromDate,
    dateFromJd: dateFromJd,
    jdFromCivil: jdFromCivil,
    civilFromJd: civilFromJd,
    deltaT: deltaT,
    heliocentric: heliocentric,
    moonGeocentric: moonGeocentric,
    all: all,
    orbitalPeriodDays: orbitalPeriodDays,
    range: range,
    elementSet: elementSet,
    J2000: J2000,
    AU_KM: AU_KM
  };
});
