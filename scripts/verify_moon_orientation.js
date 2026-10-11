#!/usr/bin/env node
/*
 * verify_moon_orientation.js -- check Ephemeris.moonOrientation / moonLibration.
 *
 *   node scripts/verify_moon_orientation.js
 *
 * The IAU rotation model in web/ephemeris.js turns map longitude 0 of the lunar
 * globe toward the mean sub-Earth meridian, so the selenographic point under the
 * Earth (the geocentric libration) must
 *   - match Meeus, Astronomical Algorithms, example 53.a (1992 April 12, 0h TD:
 *     l = -1.23 deg, b = +4.20 deg) to a few hundredths of a degree;
 *   - stay inside the real libration limits (about 8.2 deg in longitude and
 *     6.9 deg in latitude, with a little slack for the truncated lunar theory)
 *     across the app's whole range, 3000 BCE to 3000 CE;
 *   - average to (0, 0) over each century, so the near side never drifts away.
 * The returned frame must also be orthonormal. Exit status is non-zero when any
 * check fails.
 */
'use strict';
var path = require('path');

var E = require(path.join(__dirname, '..', 'web', 'ephemeris.js'));

var failures = [];
function check(ok, msg) {
  console.log((ok ? 'ok   ' : 'FAIL ') + msg);
  if (!ok) failures.push(msg);
}

/* ---- frame ------------------------------------------------------------------------- */
[E.range.jdMin, 2451545.0, E.range.jdMax].forEach(function (jd) {
  var o = E.moonOrientation(jd);
  var p = o.pole, n = o.node;
  var lp = Math.hypot(p.x, p.y, p.z), ln = Math.hypot(n.x, n.y, n.z);
  var dot = p.x * n.x + p.y * n.y + p.z * n.z;
  var tilt = Math.acos(p.z) * 180 / Math.PI;
  check(Math.abs(lp - 1) < 1e-12 && Math.abs(ln - 1) < 1e-12 && Math.abs(dot) < 1e-12 &&
        o.w >= 0 && o.w < 2 * Math.PI,
        'orthonormal frame at JD ' + jd.toFixed(1));
  check(tilt > 1.2 && tilt < 1.9, 'pole ' + tilt.toFixed(3) + ' deg from the ecliptic pole at JD ' + jd.toFixed(1));
});

/* ---- Meeus example 53.a ------------------------------------------------------------ */
var jdTT = 2448724.5;
var lib = E.moonLibration(jdTT - E.deltaT(jdTT) / 86400);
check(Math.abs(lib.lon - (-1.23)) < 0.05 && Math.abs(lib.lat - 4.20) < 0.05,
      'Meeus 53.a: l = ' + lib.lon.toFixed(3) + ' (-1.23), b = ' + lib.lat.toFixed(3) + ' (+4.20)');

/* ---- libration limits and mean, century by century --------------------------------- */
var worstLon = 0, worstLat = 0, worstMean = 0;
for (var start = E.range.jdMin; start < E.range.jdMax; start += 36525) {
  var end = Math.min(start + 36525, E.range.jdMax);
  var sumLon = 0, sumLat = 0, n = 0;
  for (var jd = start; jd < end; jd += 0.37) {
    var l = E.moonLibration(jd);
    worstLon = Math.max(worstLon, Math.abs(l.lon));
    worstLat = Math.max(worstLat, Math.abs(l.lat));
    sumLon += l.lon;
    sumLat += l.lat;
    n++;
  }
  worstMean = Math.max(worstMean, Math.abs(sumLon / n), Math.abs(sumLat / n));
}
check(worstLon < 8.8, 'longitude libration within 8.8 deg (max ' + worstLon.toFixed(2) + ')');
check(worstLat < 7.3, 'latitude libration within 7.3 deg (max ' + worstLat.toFixed(2) + ')');
check(worstMean < 0.6, 'century means within 0.6 deg of (0, 0) (max ' + worstMean.toFixed(3) + ')');

if (failures.length) {
  console.log('\n' + failures.length + ' check(s) failed');
  process.exit(1);
}
console.log('\nall checks passed');
