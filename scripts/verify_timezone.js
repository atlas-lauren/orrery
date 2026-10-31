#!/usr/bin/env node
/*
 * verify_timezone.js -- check the time-zone conversions of web/timezone.js.
 *
 *   node scripts/verify_timezone.js
 *
 * 1. civil('UTC', jd) equals Ephemeris.civilFromJd(jd) at a dozen dates from
 *    3000 BCE to 2999 CE (the UTC path skips Intl, so this checks the shared
 *    calendar code), and the fields a real Intl formatter prints for Etc/GMT equal
 *    Ephemeris.civilFromJd at dates before 1582, which confirms Intl's calendar is
 *    proleptic Gregorian; London's 1500 local mean time pins the same thing
 *    through offsetSeconds.
 * 2. jd -> civil -> jd round-trips exactly (to 1e-9 days) for five zones with
 *    unusual rules at 500 seeded random whole-millisecond instants between 1800 and
 *    2100 and 50 between 3000 BCE and 1800. An instant in the repeated hour of a
 *    fall-back night may come back as the first occurrence instead; that is the
 *    documented rule and is accepted when the civil fields still agree.
 * 3. DST gap and overlap rules for America/New_York in 2026.
 * 4. Local mean time before standardisation: New York on 1800-01-01 is -4:56:02.
 * 5. Abbreviations, and the behaviour on an unknown zone.
 * Exit status is non-zero when any check fails.
 */
'use strict';
var path = require('path');

// Both scripts attach to window when one exists, as they do in the browser.
global.window = global;
var Eph = require(path.join(__dirname, '..', 'web', 'ephemeris.js'));
require(path.join(__dirname, '..', 'web', 'timezone.js'));
var TZ = global.window.TimeZones;

var failures = [];
function check(ok, msg) {
  console.log((ok ? 'PASS ' : 'FAIL ') + msg);
  if (!ok) failures.push(msg);
}

function sameFields(a, b) {
  return a.year === b.year && a.month === b.month && a.day === b.day &&
    a.hour === b.hour && a.minute === b.minute && Math.abs(a.second - b.second) < 1e-9;
}

// Deterministic PRNG (mulberry32) so a failure can be reproduced.
function rng(seed) {
  var s = seed >>> 0;
  return function () {
    s = (s + 0x6D2B79F5) >>> 0;
    var t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---- 1. UTC agrees with the ephemeris calendar ------------------------------------ */

check(TZ.isValid('UTC') && TZ.isValid('America/New_York'), 'isValid accepts UTC and America/New_York');

var utcDates = [
  [-3000, 1, 1, 0, 0, 0], [-3000, 7, 15, 12, 30, 15], [-43, 3, 15, 9, 0, 0], [0, 2, 29, 23, 59, 59],
  [1500, 3, 1, 6, 0, 0], [1582, 10, 10, 12, 0, 0], [1900, 1, 1, 0, 0, 0], [1999, 12, 31, 23, 59, 0],
  [2026, 10, 31, 15, 59, 0], [2026, 3, 8, 7, 0, 0], [2999, 12, 31, 23, 59, 59], [2000, 1, 1, 12, 0, 0]
];
utcDates.forEach(function (d) {
  var jd = Eph.jdFromCivil(d[0], d[1], d[2], d[3], d[4], d[5]);
  var want = Eph.civilFromJd(jd);
  var got = TZ.civil('UTC', jd);
  var weekdayOk = got.weekday === ((Math.floor(jd + 1.5) % 7) + 7) % 7;
  check(sameFields(want, got) && got.offsetSeconds === 0 && got.abbreviation === 'UTC' && weekdayOk,
    'civil(UTC) matches Ephemeris.civilFromJd at ' + d.join('-') + ' -> ' + JSON.stringify(got));
});

// The UTC path above never consults Intl, so the calendar check goes through a real
// formatter: Etc/GMT has offset zero but is formatter-backed, and its fields must be
// the proleptic Gregorian ones back to 3000 BCE. A Julian-calendar reading would be
// off by days, and would also break the local-mean-time offset of London in 1500.
function intlFields(zone, jd) {
  var f = new Intl.DateTimeFormat('en-US', { timeZone: zone, era: 'short', year: 'numeric', month: 'numeric',
    day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23' });
  var v = {};
  f.formatToParts(new Date(Math.round((jd - 2440587.5) * 86400000))).forEach(function (p) {
    if (p.type !== 'literal') v[p.type] = p.value;
  });
  var year = parseInt(v.year, 10);
  if (/^B/i.test(v.era || '')) year = 1 - year;
  return { year: year, month: +v.month, day: +v.day, hour: +v.hour % 24, minute: +v.minute, second: +v.second };
}

[[-3000, 1, 1, 0, 0, 0], [-43, 3, 15, 9, 0, 0], [0, 2, 29, 23, 59, 59], [1500, 3, 1, 6, 0, 0], [1582, 10, 10, 12, 0, 0]].forEach(function (d) {
  var jd = Eph.jdFromCivil(d[0], d[1], d[2], d[3], d[4], d[5]);
  var got = intlFields('Etc/GMT', jd);
  check(sameFields(Eph.civilFromJd(jd), got),
    'Intl fields for Etc/GMT are proleptic Gregorian at ' + d.join('-') + ' -> ' + JSON.stringify(got));
});
check(TZ.offsetSeconds('Europe/London', Eph.jdFromCivil(1500, 3, 1, 0, 0, 0)) === -75,
  'offsetSeconds(Europe/London, 1500-03-01) is -75 s (LMT), read through the formatter');

/* ---- 2. Round trips ------------------------------------------------------------------ */

var zones = ['America/New_York', 'Europe/London', 'Asia/Kolkata', 'Australia/Lord_Howe', 'Pacific/Chatham'];
var random = rng(20261031);

function randomJd(jdLo, jdHi) {
  // Whole milliseconds, so the millisecond rounding in civil() loses nothing.
  var msLo = Math.ceil((jdLo - 2440587.5) * 86400000);
  var msHi = Math.floor((jdHi - 2440587.5) * 86400000);
  var ms = msLo + Math.floor(random() * (msHi - msLo));
  return ms / 86400000 + 2440587.5;
}

function roundTrip(zone, jd) {
  var c = TZ.civil(zone, jd);
  var back = TZ.jd(zone, c.year, c.month, c.day, c.hour, c.minute, c.second);
  if (Math.abs(back - jd) < 1e-9) return null;
  // The first occurrence of an ambiguous time is returned by design.
  if (back < jd && sameFields(TZ.civil(zone, back), c) && TZ.offsetSeconds(zone, back) !== c.offsetSeconds) return null;
  return 'jd ' + jd + ' -> ' + JSON.stringify(c) + ' -> ' + back + ' (diff ' + (back - jd) + ' d)';
}

zones.forEach(function (zone) {
  var bad = [], i, err;
  for (i = 0; i < 500; i++) {
    err = roundTrip(zone, randomJd(Eph.jdFromCivil(1800, 1, 1), Eph.jdFromCivil(2100, 1, 1)));
    if (err) bad.push(err);
  }
  for (i = 0; i < 50; i++) {
    err = roundTrip(zone, randomJd(Eph.jdFromCivil(-3000, 1, 1), Eph.jdFromCivil(1800, 1, 1)));
    if (err) bad.push(err);
  }
  check(bad.length === 0, zone + ': 550 jd -> civil -> jd round trips exact' + (bad.length ? '; first failure ' + bad[0] : ''));
});

/* ---- 3. DST gap and overlap ----------------------------------------------------------- */

var gap = TZ.jd('America/New_York', 2026, 3, 8, 2, 30, 0);
check(Math.abs(gap - Eph.jdFromCivil(2026, 3, 8, 7, 30, 0)) < 1e-9,
  'spring-forward gap: New York 2026-03-08 02:30 -> 07:30 UT (03:30 EDT), got ' + JSON.stringify(TZ.civil('America/New_York', gap)));
var overlap = TZ.jd('America/New_York', 2026, 11, 1, 1, 30, 0);
check(Math.abs(overlap - Eph.jdFromCivil(2026, 11, 1, 5, 30, 0)) < 1e-9,
  'fall-back overlap: New York 2026-11-01 01:30 -> first occurrence 05:30 UT (EDT), got ' + JSON.stringify(TZ.civil('America/New_York', overlap)));
var beforeGap = TZ.jd('America/New_York', 2026, 3, 8, 1, 59, 0);
var afterGap = TZ.jd('America/New_York', 2026, 3, 8, 3, 0, 0);
check(Math.abs((afterGap - beforeGap) * 1440 - 1) < 1e-6, 'one clock minute spans the gap: 01:59 EST to 03:00 EDT is one minute of UT');
check(TZ.civil('America/New_York', Eph.jdFromCivil(2026, 3, 8, 6, 59, 0)).hour === 1 &&
  TZ.civil('America/New_York', Eph.jdFromCivil(2026, 3, 8, 7, 0, 0)).hour === 3, 'civil() jumps from 01:59 to 03:00 across the gap');

/* ---- 4. Local mean time ----------------------------------------------------------------- */

check(TZ.offsetSeconds('America/New_York', Eph.jdFromCivil(1800, 1, 1, 0, 0, 0)) === -17762,
  'offsetSeconds(America/New_York, 1800-01-01) is -17762 s (-4:56:02 LMT)');
check(TZ.offsetSeconds('America/New_York', Eph.jdFromCivil(-3000, 1, 1, 0, 0, 0)) === -17762,
  'offsetSeconds(America/New_York, 3000 BCE) is still LMT');
check(TZ.offsetSeconds('Asia/Kolkata', Eph.jdFromCivil(2026, 1, 1, 0, 0, 0)) === 19800 &&
  TZ.offsetSeconds('Pacific/Chatham', Eph.jdFromCivil(2026, 1, 1, 0, 0, 0)) === 49500,
  'half-hour and 45-minute offsets (Kolkata +5:30, Chatham summer +13:45)');
check(TZ.formatOffset(-17762) === 'UTC-04:56:02' && TZ.formatOffset(19800) === 'UTC+05:30' && TZ.formatOffset(0) === 'UTC',
  'formatOffset renders seconds, minutes and zero');
check(TZ.label('America/New_York', Eph.jdFromCivil(2026, 7, 1, 0, 0, 0)) === 'America/New_York (UTC-04:00)',
  'label() is "America/New_York (UTC-04:00)" in summer');

/* ---- 5. Abbreviations and bad zones ---------------------------------------------------------- */

check(TZ.abbreviation('America/New_York', Eph.jdFromCivil(2026, 7, 1, 12, 0, 0)) === 'EDT', 'abbreviation(America/New_York, summer 2026) is EDT');
check(TZ.abbreviation('America/New_York', Eph.jdFromCivil(2026, 1, 1, 12, 0, 0)) === 'EST', 'abbreviation(America/New_York, winter 2026) is EST');
check(TZ.abbreviation('UTC', Eph.jdFromCivil(-2000, 1, 1, 0, 0, 0)) === 'UTC', 'abbreviation(UTC) is UTC');
var kolkata = TZ.abbreviation('Asia/Kolkata', Eph.jdFromCivil(2026, 1, 1, 0, 0, 0));
check(/^[A-Za-z]/.test(kolkata) && kolkata.length <= 12, 'abbreviation(Asia/Kolkata) is a short name: ' + kolkata);

check(TZ.isValid('Mars/Olympus') === false, 'isValid(Mars/Olympus) is false');
var marsOk = true, mars;
try {
  mars = TZ.civil('Mars/Olympus', Eph.jdFromCivil(2026, 10, 31, 15, 59, 0));
  marsOk = sameFields(mars, Eph.civilFromJd(Eph.jdFromCivil(2026, 10, 31, 15, 59, 0))) && mars.abbreviation === 'UTC';
  TZ.jd('Mars/Olympus', 2026, 10, 31, 15, 59, 0);
  TZ.abbreviation('Mars/Olympus', 2451545);
  TZ.label('Mars/Olympus', 2451545);
  TZ.offsetSeconds(null, 2451545);
  TZ.civil(undefined, 2451545);
} catch (err) {
  marsOk = false;
}
check(marsOk, 'an unknown zone behaves as UTC and nothing throws');

var list = TZ.list();
check(list[0] === 'UTC' && list.indexOf('America/New_York') > 0 && list.indexOf('UTC', 1) < 0, 'list() starts with UTC once and includes America/New_York (' + list.length + ' zones)');
check(TZ.region('America/New_York') === 'America' && TZ.region('Arctic/Longyearbyen') === 'Other' && TZ.region('UTC') === 'Other', 'region() groups by prefix with Other for the rest');
check(TZ.isValid(TZ.browserZone()), 'browserZone() is a valid zone: ' + TZ.browserZone());

/* ---- Summary ------------------------------------------------------------------------- */

if (failures.length) {
  console.log('\n' + failures.length + ' check(s) failed');
  process.exit(1);
}
console.log('\nall checks passed');
