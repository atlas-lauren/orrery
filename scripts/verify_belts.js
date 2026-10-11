#!/usr/bin/env node
/*
 * verify_belts.js -- exercise the orbital belt populations of web/visuals.js
 * (OrreryVisuals.orbitalBelt / beltReference) without a browser.
 *
 *   node scripts/verify_belts.js
 *
 * 1. Orbit math: particles built from the JPL J2000 elements of Pluto, Jupiter and
 *    Neptune, propagated by beltReference.positionOf (the CPU twin of the vertex
 *    shader), against Ephemeris.heliocentric at four dates.
 * 2. Resonance geometry: plutinos and twotinos pass perihelion 90 deg from / opposite
 *    Neptune, Hildas reach aphelion at L3, L4 and L5, Trojans sit 60 deg from Jupiter,
 *    and every resonant mean motion equals (q / p) of its planet's.
 * 3. Kirkwood gaps in the main-belt semi-major axis histogram (0.01 AU bins).
 * 4. Ranges per population, NaNs, Kepler solver convergence for e <= 0.75.
 * 5. Shader text: every attribute / uniform / varying declared, the Newton iteration
 *    count shared with positionOf, float literals, three.js built-ins not redeclared.
 * 6. Generation timing for both populations.
 * 7. orbitalBelt() contract through a stub THREE (attributes, uniforms, flags, userData).
 * Exit status is non-zero when any check fails.
 */
'use strict';
var path = require('path');

var ROOT = path.resolve(__dirname, '..');
require(path.join(ROOT, 'web', 'visuals.js'));
var Eph = require(path.join(ROOT, 'web', 'ephemeris.js'));
var V = globalThis.OrreryVisuals;
var B = V.beltReference;

var D2R = Math.PI / 180, R2D = 180 / Math.PI, TAU = Math.PI * 2, J2000 = 2451545.0;
var failures = [];
function fail(msg) { failures.push(msg); console.log('FAIL: ' + msg); }
function check(ok, msg) { if (!ok) fail(msg); return ok; }
function wrapDeg(x) { x = x % 360; if (x > 180) x -= 360; if (x <= -180) x += 360; return x; }
function nearest(x, centres) {
  var best = Infinity, k;
  for (k = 0; k < centres.length; k++) best = Math.min(best, Math.abs(wrapDeg(x - centres[k])));
  return best;
}
function fmt(x, d) { return Number(x).toFixed(d === undefined ? 3 : d); }
function pct(x) { return (x * 100).toFixed(1) + '%'; }
function ttDays(jd) { return jd + Eph.deltaT(jd) / 86400 - J2000; }

/* JPL Keplerian elements, 1800-2050 table, J2000 values: a, e, I, L, long. peri, long. node (deg)
 * and the rate of L in deg per Julian century. */
var JPL = {
  pluto:   { el: [39.48211675, 0.24882730, 17.14001206, 238.92903833, 224.06891629, 110.30393684], Ldot: 145.20780515 },
  jupiter: { el: [5.20288700, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909], Ldot: 3034.74612775 },
  neptune: { el: [30.06992276, 0.00859048, 1.77004347, -55.12002969, 44.96476227, 131.78422574], Ldot: 218.45945325 }
};
function particleFromJpl(row) {
  return {
    a: row[0], e: row[1], i: row[2] * D2R, Omega: row[5] * D2R, omega: (row[4] - row[5]) * D2R,
    M0: (row[3] - row[4]) * D2R, n: TAU / (Math.pow(row[0], 1.5) * 365.25),
    p: 0, q: 0, phiCenter: 0, k: 0, amp: 0, phase: 0, rate: 0
  };
}

/* ---- 1. orbit math vs the ephemeris ------------------------------------------------- */
console.log('1. positionOf vs Ephemeris.heliocentric (angular error, deg)');
var DATES = [[2451545.0, 1], [2461000.0, 1], [2440000.0, 3], [2470000.0, 3]];
Object.keys(JPL).forEach(function (body) {
  var pt = particleFromJpl(JPL[body].el), line = '   ' + body.padEnd(8);
  DATES.forEach(function (d) {
    var jd = d[0], limit = d[1];
    var p = B.positionOf(pt, ttDays(jd), 0);
    var ref = Eph.heliocentric(body, jd);
    var dot = (p.x * ref.x + p.y * ref.y + p.z * ref.z) / (p.r * ref.r);
    var ang = Math.acos(Math.max(-1, Math.min(1, dot))) * R2D;
    var rErr = Math.abs(p.r - ref.r) / ref.r;
    line += '  jd ' + jd + ': ' + fmt(ang, 3) + ' deg (r ' + pct(rErr) + ')';
    check(ang < limit, body + ' at jd ' + jd + ': angular error ' + fmt(ang, 3) + ' deg exceeds ' + limit);
    check(rErr < 0.02, body + ' at jd ' + jd + ': distance error ' + pct(rErr));
  });
  console.log(line);
});

/* ---- generate both populations ------------------------------------------------------ */
var kuiper = B.generate('kuiper', 14000);
var asteroid = B.generate('asteroid', 9000);
function particlesOf(gen, groupName) {
  var out = [], i, gi = gen.groups.indexOf(groupName);
  for (i = 0; i < gen.count; i++) if (gen.group[i] === gi) out.push(B.particle(gen, i));
  return out;
}
function countsOf(gen) {
  var c = {}, i;
  gen.groups.forEach(function (g) { c[g] = 0; });
  for (i = 0; i < gen.count; i++) c[gen.groups[gen.group[i]]]++;
  return c;
}
console.log('   kuiper ' + kuiper.count + ': ' + JSON.stringify(countsOf(kuiper)));
console.log('   asteroid ' + asteroid.count + ': ' + JSON.stringify(countsOf(asteroid)));
check(kuiper.refBody === 'neptune' && asteroid.refBody === 'jupiter', 'refBody per kind');

/* ---- 2. resonance geometry ------------------------------------------------------------ */
console.log('2. resonance geometry');
var LN0 = 304.88, LJ0 = JPL.jupiter.el[3];                 /* mean longitudes at J2000, deg */
var nN = JPL.neptune.Ldot / 36525, nJ = JPL.jupiter.Ldot / 36525;   /* deg per day */
if (typeof Eph.meanLongitude === 'function') {
  var mlN = Eph.meanLongitude('neptune', J2000), mlJ = Eph.meanLongitude('jupiter', J2000);
  console.log('   Ephemeris.meanLongitude at J2000: neptune ' + fmt(mlN, 3) + ' (304.88), jupiter ' + fmt(mlJ, 3) + ' (' + fmt(LJ0, 3) + ')');
  check(Math.abs(wrapDeg(mlN - LN0)) < 0.01 && Math.abs(wrapDeg(mlJ - LJ0)) < 0.01, 'meanLongitude at J2000 matches the JPL L0');
}

/* Longitude relative to the reference planet at the sample where r is extreme
 * (min: perihelion, max: aphelion) over one resonant period, planet moving. */
function extremeLongitude(pt, L0, nRef, wantMin) {
  var periodDays = (pt.p / pt.q) * 360 / nRef, steps = 360, s, days, lonRef, pos, r;
  var bestR = wantMin ? Infinity : -Infinity, best = 0;
  for (s = 0; s < steps; s++) {
    days = periodDays * s / steps;
    lonRef = L0 + nRef * days;
    pos = B.positionOf(pt, days, lonRef * D2R);
    r = pos.r;
    if (wantMin ? r < bestR : r > bestR) { bestR = r; best = wrapDeg(Math.atan2(pos.y, pos.x) * R2D - lonRef); }
  }
  return best;
}
/* Where a resonant particle passes perihelion (or aphelion) relative to its planet:
 * at that moment q (varpi - lambdaRef) = phi + const, so the offset from the nominal
 * clump centre is (phi - phiCenter) / q, at most amplitude / q. Add the reduction to
 * the ecliptic for an inclined orbit (at most tan^2(i / 2)) and the 1-deg scan step. */
function passageTolerance(pt) { return (pt.amp / pt.q + Math.pow(Math.tan(pt.i / 2), 2)) * R2D + 1.5; }
function resonantArgument(pt, lonRefRad, days) {
  var pos = B.positionOf(pt, days, lonRefRad);
  var lambda = pos.varpi + pos.M;
  return B.wrapPi(pt.p * lambda - pt.q * lonRefRad - (pt.p - pt.q) * pos.varpi - pt.phiCenter);
}
/* Mean motion from the mean longitude 2000 days apart with the planet moving. */
function meanMotionRatio(list, L0, nRef) {
  var sum = 0, k, pt, p0, p1, dl, expected;
  for (k = 0; k < list.length; k++) {
    pt = list[k];
    p0 = B.positionOf(pt, 0, L0 * D2R);
    p1 = B.positionOf(pt, 2000, (L0 + nRef * 2000) * D2R);
    dl = (p1.varpi + p1.M) - (p0.varpi + p0.M);
    dl -= TAU * Math.round((dl - pt.n * 2000) / TAU);      /* unwrap near the Kepler rate */
    expected = (pt.q / pt.p) * nRef * D2R * 2000;
    sum += dl / expected;
  }
  return sum / list.length;
}

var plutinos = particlesOf(kuiper, 'plutino');
var twotinos = particlesOf(kuiper, 'twotino');
var hildas = particlesOf(asteroid, 'hilda');
var l4 = particlesOf(asteroid, 'trojan L4'), l5 = particlesOf(asteroid, 'trojan L5');

/* plutinos */
var litHit = 0, snapN = 0, snapHit = 0, periHit = 0, periOk = 0, argOk = 0, k, pt, pos, lon, peri, maxPeriOff = 0;
for (k = 0; k < plutinos.length; k++) {
  pt = plutinos[k];
  if (nearest((pt.Omega + pt.omega) * R2D - LN0, [90, -90]) <= 45) litHit++;
  pos = B.positionOf(pt, 0, LN0 * D2R);
  if (Math.abs(pos.M) < 45 * D2R) {
    snapN++;
    lon = Math.atan2(pos.y, pos.x) * R2D - LN0;
    if (nearest(lon, [90, -90]) <= 45) snapHit++;
  }
  peri = nearest(extremeLongitude(pt, LN0, nN, true), [90, -90]);
  if (peri <= 45) periHit++;
  if (peri <= passageTolerance(pt)) periOk++;
  if (peri > maxPeriOff) maxPeriOff = peri;
  if (Math.abs(resonantArgument(pt, LN0 * D2R, 0)) <= pt.amp + 1e-6) argOk++;
}
console.log('   plutinos (' + plutinos.length + '), Neptune at ' + LN0 + ' deg:');
console.log('     perihelion passages within +-45 deg of Neptune +-90: ' + pct(periHit / plutinos.length) + ' (orbit scanned with Neptune moving; offset = (phi - pi) / 2 <= amplitude / 2 <= 45 deg, plus up to 5.7 deg of reduction to the ecliptic); within each particle\'s own tolerance: ' + pct(periOk / plutinos.length) + ', largest offset ' + fmt(maxPeriOff, 1) + ' deg');
console.log('     snapshot at J2000, particles within 45 deg of perihelion (' + snapN + '): longitude within +-45 deg of Neptune +-90: ' + pct(snapHit / snapN));
console.log('     resonant argument 3 lambda - 2 lambdaN - varpi within its libration amplitude of pi: ' + pct(argOk / plutinos.length));
console.log('     perihelion longitudes varpi themselves within +-45 deg of Neptune +-90: ' + pct(litHit / plutinos.length) + ' (Omega and omega are uniform by contract, so ~50% by construction; the clumps are where the particles pass perihelion, not where varpi points)');
check(periHit / plutinos.length > 0.95, 'plutino perihelion passages are not 90 deg from Neptune');
check(periOk === plutinos.length, 'plutino perihelion passage outside its libration tolerance');
check(snapHit / snapN > 0.85, 'plutino snapshot clumps weaker than expected');
check(argOk === plutinos.length, 'plutino resonant argument outside its libration amplitude');
console.log('     mean motion / ((2/3) Neptune): ' + fmt(meanMotionRatio(plutinos.slice(0, 200), LN0, nN), 5));

/* twotinos: perihelion opposite Neptune, offset = phi - pi <= amplitude <= 60 deg */
var two30 = 0, two60 = 0, twoOk = 0, twoArg = 0;
for (k = 0; k < twotinos.length; k++) {
  pt = twotinos[k];
  peri = nearest(extremeLongitude(pt, LN0, nN, true), [180]);
  if (peri <= 30) two30++;
  if (peri <= 60) two60++;
  if (peri <= passageTolerance(pt)) twoOk++;
  if (Math.abs(resonantArgument(pt, LN0 * D2R, 0)) <= pt.amp + 1e-6) twoArg++;
}
console.log('   twotinos (' + twotinos.length + '): perihelion passages within +-30 / +-60 deg of Neptune + 180: ' + pct(two30 / twotinos.length) + ' / ' + pct(two60 / twotinos.length) + ', within each particle\'s tolerance: ' + pct(twoOk / twotinos.length) + ', resonant argument within amplitude: ' + pct(twoArg / twotinos.length));
check(twoOk === twotinos.length, 'twotino perihelion passages not opposite Neptune');
check(twoArg === twotinos.length, 'twotino resonant argument outside its libration amplitude');
console.log('     mean motion / ((1/2) Neptune): ' + fmt(meanMotionRatio(twotinos.slice(0, 200), LN0, nN), 5));

/* Hildas: aphelia at L3 (180), L4 (60), L5 (-60), offset = phi / 3 <= 13.3 deg */
var corner = { 60: 0, 180: 0, 300: 0 }, hildaHit = 0, hildaOk = 0, hildaArg = 0, aph, dmin, cornerKey;
for (k = 0; k < hildas.length; k++) {
  pt = hildas[k];
  aph = extremeLongitude(pt, LJ0, nJ, false);
  dmin = nearest(aph, [60, 180, 300]);
  if (dmin <= 15) hildaHit++;
  if (dmin <= passageTolerance(pt)) hildaOk++;
  cornerKey = [60, 180, 300].reduce(function (best, c) { return Math.abs(wrapDeg(aph - c)) < Math.abs(wrapDeg(aph - best)) ? c : best; }, 60);
  corner[cornerKey]++;
  if (Math.abs(resonantArgument(pt, LJ0 * D2R, 0)) <= pt.amp + 1e-6) hildaArg++;
}
console.log('   Hildas (' + hildas.length + '), Jupiter at ' + fmt(LJ0, 2) + ' deg: aphelion passages within +-15 deg of Jupiter + 60 / 180 / 300: ' + pct(hildaHit / hildas.length) + ', within each particle\'s tolerance: ' + pct(hildaOk / hildas.length));
console.log('     corners: L4 ' + corner[60] + ', L3 (opposite Jupiter) ' + corner[180] + ', L5 ' + corner[300] + '; resonant argument 2 lambda - 3 lambdaJ + varpi within amplitude: ' + pct(hildaArg / hildas.length));
check(hildaOk === hildas.length, 'Hilda aphelia are not at the triangle corners');
check(corner[180] > hildas.length * 0.2 && corner[60] > hildas.length * 0.2 && corner[300] > hildas.length * 0.2, 'Hilda corners unevenly populated');
check(hildaArg === hildas.length, 'Hilda resonant argument outside its libration amplitude');
console.log('     mean motion / ((3/2) Jupiter): ' + fmt(meanMotionRatio(hildas.slice(0, 200), LJ0, nJ), 5));

/* Trojans */
function trojanStats(list, centre) {
  var meanOk = 0, trueHit = 0, maxOff = 0, k, pt, pos, lam, off, tol;
  for (k = 0; k < list.length; k++) {
    pt = list[k];
    pos = B.positionOf(pt, 0, LJ0 * D2R);
    lam = (pos.varpi + pos.M) * R2D - LJ0;
    if (Math.abs(wrapDeg(lam - centre)) <= pt.amp * R2D + 1e-6) meanOk++;
    off = Math.abs(wrapDeg(Math.atan2(pos.y, pos.x) * R2D - LJ0 - centre));
    /* libration + equation of centre + reduction to the ecliptic */
    tol = (pt.amp + 2 * pt.e + 1.3 * pt.e * pt.e + Math.pow(Math.tan(pt.i / 2), 2)) * R2D + 0.5;
    if (off <= tol) trueHit++;
    if (off > maxOff) maxOff = off;
  }
  return { meanOk: meanOk, trueHit: trueHit, maxOff: maxOff };
}
var s4 = trojanStats(l4, 60), s5 = trojanStats(l5, -60);
console.log('   Trojans L4 (' + l4.length + ') at Jupiter + 60: mean longitude within amplitude ' + pct(s4.meanOk / l4.length) + ', true longitude within amplitude + equation of centre ' + pct(s4.trueHit / l4.length) + ', max offset ' + fmt(s4.maxOff, 1) + ' deg');
console.log('   Trojans L5 (' + l5.length + ') at Jupiter - 60: mean longitude within amplitude ' + pct(s5.meanOk / l5.length) + ', true longitude within amplitude + equation of centre ' + pct(s5.trueHit / l5.length) + ', max offset ' + fmt(s5.maxOff, 1) + ' deg');
check(s4.meanOk === l4.length && s5.meanOk === l5.length, 'Trojan mean longitudes outside Jupiter +-60 +- amplitude');
check(s4.trueHit === l4.length && s5.trueHit === l5.length, 'Trojan true longitudes outside the expected spread');
console.log('     mean motion / Jupiter: ' + fmt(meanMotionRatio(l4.concat(l5).slice(0, 200), LJ0, nJ), 5));

/* ---- 3. Kirkwood gaps ------------------------------------------------------------------ */
console.log('3. Kirkwood gaps (main belt a, 0.01 AU bins)');
var BIN = 0.01, bins = {}, mainCount = 0, i, gi, a, b;
for (i = 0; i < asteroid.count; i++) {
  gi = asteroid.group[i];
  if (gi > 2) continue;
  mainCount++;
  a = asteroid.elements.aOrbit[i * 4];
  b = Math.floor(a / BIN);
  bins[b] = (bins[b] || 0) + 1;
}
var occupied = Object.keys(bins).map(function (k) { return bins[k]; }).sort(function (x, y) { return x - y; });
var medianBin = occupied[occupied.length >> 1];
console.log('   ' + mainCount + ' main-belt particles, median occupied bin ' + medianBin);
B.kirkwoodGaps.forEach(function (g) {
  var c = g[0], hw = g[1], cb = Math.floor(c / BIN), inside = [], outside = [], lo, hi, bb;
  for (bb = cb - 6; bb <= cb + 6; bb++) {
    lo = bb * BIN; hi = lo + BIN;
    if (lo >= c - hw && hi <= c + hw) inside.push(bins[bb] || 0);
    else if (hi <= c - hw || lo >= c + hw) outside.push(bins[bb] || 0);
  }
  var centre = bins[cb] || 0;
  var outMean = outside.length ? outside.reduce(function (s, v) { return s + v; }, 0) / outside.length : 0;
  console.log('   gap ' + fmt(c, 3) + ' +-' + fmt(hw, 3) + ': centre bin ' + centre + ', bins fully inside [' + inside.join(', ') + '], neighbours mean ' + fmt(outMean, 1) + (c < 2.1 ? ' (below the inner edge)' : ''));
  check(centre === 0, 'Kirkwood gap at ' + c + ' has ' + centre + ' particles in its centre bin');
  check(inside.every(function (v) { return v === 0; }), 'Kirkwood gap at ' + c + ' is not empty');
});

/* ---- 4. ranges, NaNs, Kepler convergence ---------------------------------------------- */
console.log('4. ranges');
var RANGES = {
  kuiper: {
    'cold classical': { a: [42, 47.5], e: [0, 0.12], i: [0, 7], p: 0 },
    'hot classical': { a: [40, 48], e: [0, 0.30], i: [0, 40], p: 0 },
    plutino: { a: [37.5, 41.5], e: [0.03, 0.34], i: [0, 35], p: 3, q: 2, phi: 180, kMax: 2, amp: [15, 90] },
    twotino: { a: [47, 48.6], e: [0.10, 0.35], i: [0, 30], p: 2, q: 1, phi: 180, kMax: 1, amp: [20, 60] },
    'scattered disk': { a: [50, 150], e: [0, 0.75], i: [0, 45], p: 0, q: [30, 40.01] }
  },
  asteroid: {
    'inner main belt': { a: [2.1, 2.5], e: [0, 0.35], i: [0, 30], p: 0 },
    'middle main belt': { a: [2.5, 2.82], e: [0, 0.35], i: [0, 30], p: 0 },
    'outer main belt': { a: [2.82, 3.3], e: [0, 0.35], i: [0, 30], p: 0 },
    hilda: { a: [3.7, 4.25], e: [0.07, 0.30], i: [0, 20], p: 2, q: 3, phi: 0, kMax: 1, amp: [5, 40] },
    'trojan L4': { a: [4.6, 5.8], e: [0, 0.2], i: [0, 35], p: 1, q: 1, phi: 60, kMax: 0, amp: [2, 30] },
    'trojan L5': { a: [4.6, 5.8], e: [0, 0.2], i: [0, 35], p: 1, q: 1, phi: -60, kMax: 0, amp: [2, 30] }
  }
};
function inRange(v, r) { return v >= r[0] - 1e-6 && v <= r[1] + 1e-6; }
[kuiper, asteroid].forEach(function (gen) {
  var el = gen.elements, bad = {}, nan = 0, sizeBad = 0, colBad = 0, eMax = 0, big = 0, i, pt, rr, q;
  function flag(name) { bad[name] = (bad[name] || 0) + 1; }
  ['aOrbit', 'aOrbit2', 'aRes', 'aLib'].forEach(function (key) {
    var arr = el[key], j;
    for (j = 0; j < arr.length; j++) if (arr[j] !== arr[j]) nan++;
  });
  for (i = 0; i < gen.colors.length; i++) {
    if (gen.colors[i] !== gen.colors[i]) nan++;
    if (!(gen.colors[i] > 0 && gen.colors[i] < 1)) colBad++;
  }
  for (i = 0; i < gen.count; i++) {
    pt = B.particle(gen, i);
    rr = RANGES[gen.kind][pt.group];
    if (pt.e > eMax) eMax = pt.e;
    if (!(pt.e >= 0 && pt.e <= 0.75)) flag('e outside [0, 0.75]');
    if (!inRange(pt.a, rr.a)) flag(pt.group + ' a');
    if (!inRange(pt.e, rr.e)) flag(pt.group + ' e');
    if (!inRange(pt.i * R2D, rr.i)) flag(pt.group + ' i');
    if (pt.p !== rr.p) flag(pt.group + ' p');
    if (rr.p) {
      if (pt.q !== rr.q) flag(pt.group + ' q');
      if (Math.abs(wrapDeg(pt.phiCenter * R2D - rr.phi)) > 1e-3) flag(pt.group + ' phiCenter');
      if (!(pt.k >= 0 && pt.k <= rr.kMax && pt.k === Math.floor(pt.k))) flag(pt.group + ' k');
      if (!inRange(pt.amp * R2D, rr.amp)) flag(pt.group + ' amplitude');
      if (!(pt.rate > 0)) flag(pt.group + ' libration rate');
    } else if (pt.q !== 0 || pt.amp !== 0 || pt.rate !== 0) flag(pt.group + ' free orbit carries resonance data');
    if (pt.group === 'scattered disk') { q = pt.a * (1 - pt.e); if (!inRange(q, rr.q)) flag('scattered perihelion'); }
    if (!(pt.size >= 1.0 && pt.size <= 2.6)) sizeBad++;
    if (pt.size >= 2.0) big++;
    if (Math.abs(pt.n - TAU / (Math.pow(pt.a, 1.5) * 365.25)) > 1e-9) flag('n != 2 pi / period');
    if (!(pt.Omega >= 0 && pt.Omega < TAU && pt.omega >= 0 && pt.omega < TAU && pt.M0 >= 0 && pt.M0 < TAU)) flag('angle outside [0, 2 pi)');
  }
  var badKeys = Object.keys(bad);
  console.log('   ' + gen.kind + ': NaNs ' + nan + ', max e ' + fmt(eMax, 3) + ', sizes outside [1, 2.6] ' + sizeBad + ', large sprites ' + pct(big / gen.count) + ', colour channels outside (0, 1) ' + colBad + (badKeys.length ? ', range violations ' + JSON.stringify(bad) : ', all ranges ok'));
  check(nan === 0, gen.kind + ': NaN values');
  check(sizeBad === 0 && colBad === 0 && badKeys.length === 0, gen.kind + ': range violations');
});
/* determinism */
var again = B.generate('kuiper', 14000), same = true;
for (i = 0; i < again.elements.aOrbit.length && same; i++) if (again.elements.aOrbit[i] !== kuiper.elements.aOrbit[i]) same = false;
for (i = 0; i < again.colors.length && same; i++) if (again.colors[i] !== kuiper.colors[i]) same = false;
check(same, 'generate() is not deterministic');
console.log('   generate() deterministic: ' + (same ? 'yes' : 'no'));
/* Kepler */
var rng = V.noise.mulberry32(12345), worst = 0, M, e, E, res;
for (i = 0; i < 10000; i++) {
  M = rng() * TAU - Math.PI; e = rng() * 0.75;
  E = B.solveKepler(M, e);
  res = Math.abs(E - e * Math.sin(E) - M);
  if (res > worst) worst = res;
}
console.log('   Kepler (' + B.KEPLER_ITERATIONS + ' Newton steps, 10000 random M, e <= 0.75): worst residual ' + worst.toExponential(2));
check(worst < 1e-6, 'Kepler solver does not converge: worst residual ' + worst);
check(Math.abs(B.wrapPi(3 * Math.PI + 0.5) - (-Math.PI + 0.5)) < 1e-12 && B.wrapPi(-Math.PI) === -Math.PI && B.wrapPi(Math.PI) === -Math.PI, 'wrapPi range is not [-pi, pi)');

/* ---- 5. shader text --------------------------------------------------------------------- */
console.log('5. shader text');
var VERT = B.shaders.BELT_VERT, FRAG = B.shaders.BELT_FRAG;
check(V.shaders.BELT_VERT === VERT && V.shaders.BELT_FRAG === FRAG, 'belt shaders not exported under OrreryVisuals.shaders');
function declared(src, kind) {
  var re = new RegExp('^\\s*' + kind + '\\s+\\w+\\s+(\\w+)\\s*;', 'gm'), m, out = {};
  while ((m = re.exec(src))) out[m[1]] = true;
  return out;
}
function used(src, prefixRe) {
  var re = new RegExp('\\b(' + prefixRe + ')\\b', 'g'), m, out = {};
  var body = src.replace(/^\s*(attribute|uniform|varying)\s+\w+\s+\w+\s*;/gm, '');
  while ((m = re.exec(body))) out[m[1]] = true;
  return Object.keys(out);
}
var vAttr = declared(VERT, 'attribute'), vUni = declared(VERT, 'uniform'), vVar = declared(VERT, 'varying');
var fUni = declared(FRAG, 'uniform'), fVar = declared(FRAG, 'varying');
used(VERT, 'a[A-Z]\\w*|color').forEach(function (n) { check(vAttr[n], 'vertex shader uses undeclared attribute ' + n); });
used(VERT, 'u[A-Z]\\w*').forEach(function (n) { check(vUni[n], 'vertex shader uses undeclared uniform ' + n); });
used(VERT, 'v[A-Z]\\w*').forEach(function (n) { check(vVar[n], 'vertex shader uses undeclared varying ' + n); });
used(FRAG, 'u[A-Z]\\w*').forEach(function (n) { check(fUni[n], 'fragment shader uses undeclared uniform ' + n); });
used(FRAG, 'v[A-Z]\\w*').forEach(function (n) { check(fVar[n], 'fragment shader uses undeclared varying ' + n); });
check(Object.keys(vVar).join() === Object.keys(fVar).join(), 'varyings differ between the two shaders');
['aOrbit', 'aOrbit2', 'aRes', 'aLib', 'color'].forEach(function (n) { check(vAttr[n], 'attribute ' + n + ' missing'); });
['position', 'normal', 'uv'].forEach(function (n) { check(!vAttr[n], 'vertex shader redeclares three.js built-in attribute ' + n); });
check(!/uniform\s+mat4\s+(projectionMatrix|modelViewMatrix)/.test(VERT), 'vertex shader redeclares a three.js matrix');
check(/projectionMatrix\s*\*\s*modelViewMatrix/.test(VERT) && /\bposition\b/.test(VERT), 'vertex shader does not use the three.js built-ins');
check(/precision highp float;/.test(VERT) && /precision highp float;/.test(FRAG), 'highp precision not requested');
check(/gl_PointSize\s*=/.test(VERT) && /gl_PointCoord/.test(FRAG) && /discard/.test(FRAG), 'point sprite code missing');
check(/mod\(x \+ PI, TAU\) - PI/.test(VERT), 'angle wrap in the shader is not mod-based');
var loop = /for \(int it = 0; it < (\d+); it\+\+\)/.exec(VERT);
check(loop && parseInt(loop[1], 10) === B.KEPLER_ITERATIONS, 'Newton iteration count in the shader differs from beltReference.KEPLER_ITERATIONS');
check(/KEPLER_ITERATIONS/.test(B.solveKepler.toString()), 'solveKepler does not use the shared KEPLER_ITERATIONS constant');
check(/M \+ e \* sin\(M\)/.test(VERT) && /M \+ e \* Math\.sin\(M\)/.test(B.solveKepler.toString()), 'Kepler start value differs between shader and solveKepler');
check(/E - \(E - e \* sin\(E\) - M\) \/ \(1\.0 - e \* cos\(E\)\)/.test(VERT), 'Newton step in the shader is not the reference form');
/* every numeric literal outside the loop header must be a float */
var intLits = [];
VERT.split('\n').concat(FRAG.split('\n')).forEach(function (line) {
  if (/for \(int it/.test(line)) return;
  var stripped = line.replace(/\d+\.\d+(e[-+]?\d+)?/g, ' ');
  var m = /(^|[^\w.])(\d+)(?![\w.])/.exec(stripped);
  if (m) intLits.push(line.trim());
});
check(intLits.length === 0, 'integer literals in float context: ' + intLits.join(' | '));
console.log('   attributes ' + Object.keys(vAttr).join(', ') + '; uniforms ' + Object.keys(vUni).concat(Object.keys(fUni)).join(', ') + '; varyings ' + Object.keys(vVar).join(', ') + '; Newton steps ' + (loop ? loop[1] : '?') + '; integer literals outside the loop header: ' + intLits.length);

/* ---- 6. timing -------------------------------------------------------------------------- */
console.log('6. timing');
var times = [], t0, run;
for (run = 0; run < 3; run++) {
  t0 = process.hrtime.bigint();
  B.generate('kuiper', 14000);
  B.generate('asteroid', 9000);
  times.push(Number(process.hrtime.bigint() - t0) / 1e6);
}
console.log('   generate kuiper 14000 + asteroid 9000: ' + times.map(function (t) { return fmt(t, 1); }).join(' / ') + ' ms (first run includes JIT warm-up)');
check(Math.min.apply(null, times) < 150, 'generation slower than 150 ms');

/* ---- 7. orbitalBelt() through a stub THREE ------------------------------------------------ */
console.log('7. orbitalBelt() contract');
function BufferGeometry() { this.attributes = {}; }
BufferGeometry.prototype.setAttribute = function (name, attr) { this.attributes[name] = attr; return this; };
BufferGeometry.prototype.dispose = function () {};
function BufferAttribute(array, itemSize) { this.array = array; this.itemSize = itemSize; this.count = array.length / itemSize; }
function ShaderMaterial(params) { var k; for (k in params) if (Object.prototype.hasOwnProperty.call(params, k)) this[k] = params[k]; this.isShaderMaterial = true; }
ShaderMaterial.prototype.dispose = function () {};
function PointsMaterial(params) { var k; for (k in params) if (Object.prototype.hasOwnProperty.call(params, k)) this[k] = params[k]; }
function Points(geo, mat) { this.geometry = geo; this.material = mat; this.userData = {}; this.frustumCulled = true; this.name = ''; }
V.init({
  BufferGeometry: BufferGeometry, BufferAttribute: BufferAttribute, ShaderMaterial: ShaderMaterial,
  PointsMaterial: PointsMaterial, Points: Points, NormalBlending: 'NormalBlending', AdditiveBlending: 'AdditiveBlending'
});
function checkBelt(kind, count, refBody, opacity) {
  var pts = V.orbitalBelt({ kind: kind, count: count });
  var g = pts.geometry.attributes, u = pts.material.uniforms;
  var expect = { position: 3, aOrbit: 4, aOrbit2: 4, aRes: 4, aLib: 3, color: 3 }, name;
  for (name in expect) {
    check(g[name] && g[name].itemSize === expect[name] && g[name].count === count, kind + ': attribute ' + name + ' missing or wrong size');
  }
  check(Object.keys(g).length === 6, kind + ': unexpected attributes ' + Object.keys(g).join());
  ['uDays', 'uRefLon', 'uScale', 'uExponent', 'uPixelRatio', 'uOpacity', 'uSizeScale'].forEach(function (n) {
    check(u[n] && typeof u[n].value === 'number', kind + ': uniform ' + n + ' missing');
  });
  check(Object.keys(u).length === 7, kind + ': unexpected uniforms ' + Object.keys(u).join());
  check(Object.keys(u).sort().join() === Object.keys(vUni).concat(Object.keys(fUni)).sort().join(), kind + ': material uniforms differ from the shader declarations');
  check(u.uScale.value === 22 && u.uExponent.value === 0.6 && u.uOpacity.value === opacity && u.uSizeScale.value === 1, kind + ': default uniform values');
  var m = pts.material;
  check(m.transparent === true && m.depthWrite === false && m.depthTest === true && m.blending === 'NormalBlending', kind + ': material flags');
  check(!m.vertexColors, kind + ': vertexColors must stay off (the shader declares color itself)');
  check(m.vertexShader === VERT && m.fragmentShader === FRAG, kind + ': shaders not attached');
  check(pts.frustumCulled === false, kind + ': frustumCulled must be false (positions come from the shader)');
  check(pts.userData.kind === kind && pts.userData.refBody === refBody && pts.userData.count === count, kind + ': userData');
  var zero = true, j;
  for (j = 0; j < g.position.array.length; j++) if (g.position.array[j] !== 0) zero = false;
  check(zero, kind + ': position attribute must be zero');
  console.log('   ' + kind + ': ' + count + ' particles, 6 attributes, 7 uniforms, NormalBlending, depthTest on, depthWrite off, userData ' + JSON.stringify(pts.userData));
}
checkBelt('kuiper', 14000, 'neptune', 0.45);
checkBelt('asteroid', 9000, 'jupiter', 0.5);
check(V.orbitalBelt({ kind: 'asteroid', count: 500 }).userData.count === 500, 'count override ignored');
check(V.orbitalBelt({ kind: 'kuiper' }).userData.count === 14000 && V.orbitalBelt({ kind: 'asteroid' }).userData.count === 9000, 'default counts');
var threw = false;
try { V.orbitalBelt({ kind: 'oort' }); } catch (err) { threw = true; }
check(threw, 'unknown kind must throw');
check(typeof V.asteroidBelt === 'function' && V.asteroidBelt(10, 20, 100).geometry.attributes.position.count === 100, 'old asteroidBelt builder broken');
check(typeof V.kuiperBelt === 'function' && V.kuiperBelt(30, 50, 100, function (au) { return au; }).geometry.attributes.position.count === 100, 'old kuiperBelt builder broken');
console.log('   fallbacks asteroidBelt / kuiperBelt still build; unknown kind throws; count override works');

console.log(failures.length ? failures.length + ' failure(s)' : 'all checks passed');
process.exit(failures.length ? 1 : 0);
