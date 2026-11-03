/*
 * timezone.js -- IANA time zones for the orrery clock.
 *
 * Classic script (no import/export). Attaches window.TimeZones in browsers and
 * exports the same object via module.exports in Node. Pure functions, no DOM.
 *
 * The clock itself runs in UT (a Julian Date). This file converts between that
 * instant and the civil time of an IANA zone such as 'America/New_York', using
 * the browser's own zone database through Intl.DateTimeFormat with the 'en-US'
 * locale: the formatter is asked for the civil fields of the instant, and the
 * zone's UT offset is the difference between those fields read as UT and the
 * instant. Everything else (the inverse, labels, abbreviations) is built on that
 * offset. Intl's Gregorian calendar is proleptic in current engines
 * (scripts/verify_timezone.js reads the formatter's own fields for Etc/GMT at
 * dates in 1500, 44 BCE and 3000 BCE and compares them with ephemeris.js; the
 * 'UTC' zone itself skips the formatter), so the fields agree with the rest of
 * the app from 3000 BCE to 3000 CE; dates before a zone's standardisation (1883
 * for the US) come back in local mean time, with offsets that are not whole
 * minutes.
 *
 * Conventions: years are astronomical (0 = 1 BCE, -1 = 2 BCE); offsets are in
 * seconds, east positive; weekdays are 0 = Sunday. No function throws on an
 * unknown zone: it behaves as UTC instead.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.TimeZones = api;
  } else if (root) {
    root.TimeZones = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var UNIX_EPOCH_JD = 2440587.5;
  var MS_PER_DAY = 86400000;
  var LOCALE = 'en-US';

  // Region prefixes of the IANA names, in the order the picker groups them; any
  // zone outside these (Arctic/Longyearbyen, legacy names) goes under 'Other'.
  var REGIONS = ['Africa', 'America', 'Antarctica', 'Asia', 'Atlantic', 'Australia', 'Europe', 'Indian', 'Pacific'];
  var OTHER_REGION = 'Other';

  // Used when Intl.supportedValuesOf is missing (older browsers): one or two
  // zones per major offset, so the picker is still useful.
  var FALLBACK_ZONES = [
    'Africa/Cairo', 'Africa/Johannesburg', 'Africa/Lagos', 'Africa/Nairobi',
    'America/Anchorage', 'America/Argentina/Buenos_Aires', 'America/Bogota', 'America/Chicago',
    'America/Denver', 'America/Halifax', 'America/Los_Angeles', 'America/Mexico_City',
    'America/New_York', 'America/Phoenix', 'America/Sao_Paulo', 'America/St_Johns', 'America/Toronto',
    'Asia/Bangkok', 'Asia/Dhaka', 'Asia/Dubai', 'Asia/Hong_Kong', 'Asia/Jakarta', 'Asia/Jerusalem',
    'Asia/Karachi', 'Asia/Kathmandu', 'Asia/Kolkata', 'Asia/Seoul', 'Asia/Shanghai', 'Asia/Singapore',
    'Asia/Tehran', 'Asia/Tokyo', 'Atlantic/Azores', 'Atlantic/Reykjavik',
    'Australia/Adelaide', 'Australia/Brisbane', 'Australia/Perth', 'Australia/Sydney',
    'Europe/Athens', 'Europe/Berlin', 'Europe/Istanbul', 'Europe/London', 'Europe/Moscow', 'Europe/Paris',
    'Indian/Maldives', 'Indian/Mauritius',
    'Pacific/Auckland', 'Pacific/Chatham', 'Pacific/Honolulu', 'Pacific/Tongatapu'
  ];

  // Formatters are expensive to construct (about 50 us each) and cheap to use, so
  // one of each kind is kept per zone. A null entry records a zone Intl rejected.
  var fieldFormatters = {};
  var nameFormatters = {};

  function makeFormatter(zone, extra) {
    var options = { timeZone: zone, era: 'short', year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23' };
    var key;
    for (key in extra) {
      if (Object.prototype.hasOwnProperty.call(extra, key)) options[key] = extra[key];
    }
    try {
      return new Intl.DateTimeFormat(LOCALE, options);
    } catch (err) {
      return null;
    }
  }

  function fieldFormatter(zone) {
    if (typeof zone !== 'string' || !zone) return null;
    if (!Object.prototype.hasOwnProperty.call(fieldFormatters, zone)) {
      fieldFormatters[zone] = makeFormatter(zone, {});
    }
    return fieldFormatters[zone];
  }

  function nameFormatter(zone) {
    if (!Object.prototype.hasOwnProperty.call(nameFormatters, zone)) {
      nameFormatters[zone] = fieldFormatter(zone) ? makeFormatter(zone, { timeZoneName: 'short' }) : null;
    }
    return nameFormatters[zone];
  }

  function isValid(zone) {
    return fieldFormatter(zone) !== null;
  }

  function browserZone() {
    var zone = null;
    try {
      zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch (err) {
      zone = null;
    }
    return zone && isValid(zone) ? zone : 'UTC';
  }

  // Every IANA zone the engine knows, 'UTC' first and otherwise in the engine's
  // (alphabetical) order. Aliases of UTC are dropped; nothing else is filtered.
  function list() {
    var zones = null;
    var out = ['UTC'];
    var i;
    try {
      if (typeof Intl.supportedValuesOf === 'function') zones = Intl.supportedValuesOf('timeZone');
    } catch (err) {
      zones = null;
    }
    if (!zones || !zones.length) zones = FALLBACK_ZONES;
    for (i = 0; i < zones.length; i++) {
      if (zones[i] === 'UTC' || zones[i] === 'Etc/UTC' || zones[i] === 'Etc/GMT' || zones[i] === 'GMT') continue;
      if (out.indexOf(zones[i]) < 0 && isValid(zones[i])) out.push(zones[i]);
    }
    return out;
  }

  // Picker group for a zone: its IANA region prefix, or 'Other'.
  function region(zone) {
    var slash = typeof zone === 'string' ? zone.indexOf('/') : -1;
    var prefix = slash > 0 ? zone.slice(0, slash) : '';
    return REGIONS.indexOf(prefix) >= 0 ? prefix : OTHER_REGION;
  }

  // ---------------------------------------------------------------------------
  // Instants and calendar helpers
  // ---------------------------------------------------------------------------

  function msFromJd(jd) {
    return (jd - UNIX_EPOCH_JD) * MS_PER_DAY;
  }

  function jdFromMs(ms) {
    return ms / MS_PER_DAY + UNIX_EPOCH_JD;
  }

  function mod(a, b) {
    return ((a % b) + b) % b;
  }

  // Milliseconds since the Unix epoch of a proleptic Gregorian civil time read as
  // UT. Date.UTC maps years 0..99 to 1900..1999, so the year is set explicitly;
  // the time of day is added as a number so a fractional second survives.
  function utcMs(year, month, day, hour, minute, second) {
    var date = new Date(0);
    date.setUTCFullYear(year, month - 1, day);
    date.setUTCHours(0, 0, 0, 0);
    return date.getTime() + ((hour || 0) * 3600 + (minute || 0) * 60 + (second || 0)) * 1000;
  }

  // Richards' algorithm (Explanatory Supplement, 3rd ed.) for the proleptic
  // Gregorian calendar, the same as ephemeris.js uses, so the two agree exactly.
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

  // Civil fields of a Julian Date, with the day fraction rounded to the nearest
  // millisecond as Ephemeris.civilFromJd does, plus the weekday (0 = Sunday).
  function civilFromJd(jd) {
    var v = jd + 0.5;
    var Z = Math.floor(v);
    var F = v - Z;
    var secs = Math.round(F * 86400 * 1000) / 1000;
    if (secs >= 86400) {
      secs -= 86400;
      Z += 1;
    }
    var ymd = civilFromJdn(Z);
    var hour = Math.floor(secs / 3600);
    var minute = Math.floor((secs - hour * 3600) / 60);
    var second = Math.round((secs - hour * 3600 - minute * 60) * 1000) / 1000;
    return { year: ymd.year, month: ymd.month, day: ymd.day, hour: hour, minute: minute, second: second,
      weekday: mod(Z + 1, 7) };
  }

  // ---------------------------------------------------------------------------
  // Offsets
  // ---------------------------------------------------------------------------

  // Start of the whole second containing the instant. The instant is first rounded
  // to the nearest millisecond: a Julian Date converted to milliseconds can land a
  // hair below the second it means (07:00:00 as 06:59:59.9999), and that would read
  // the offset of the wrong side of a transition.
  function wholeSecondMs(ms) {
    return Math.floor(Math.round(ms) / 1000) * 1000;
  }

  // The zone's UT offset in seconds (east positive) at an instant given in
  // milliseconds since the Unix epoch. The formatter is given a whole second, so
  // the civil fields it returns read back as UT differ from the instant by exactly
  // the offset; the era turns a BC year into an astronomical one. 0 for UTC and
  // for any zone Intl does not know.
  function offsetAtMs(zone, ms) {
    var formatter;
    var whole, parts, v, i, year, hour, civil;
    if (zone === 'UTC') return 0;
    formatter = fieldFormatter(zone);
    if (!formatter || !isFinite(ms)) return 0;
    whole = wholeSecondMs(ms);
    try {
      parts = formatter.formatToParts(new Date(whole));
    } catch (err) {
      return 0;
    }
    v = {};
    for (i = 0; i < parts.length; i++) {
      if (parts[i].type !== 'literal') v[parts[i].type] = parts[i].value;
    }
    year = parseInt(v.year, 10);
    if (/^B/i.test(v.era || '')) year = 1 - year;
    hour = parseInt(v.hour, 10) % 24;   // some engines print midnight as 24 even with h23
    civil = utcMs(year, parseInt(v.month, 10), parseInt(v.day, 10), hour, parseInt(v.minute, 10), parseInt(v.second, 10));
    if (!isFinite(civil)) return 0;
    return Math.round((civil - whole) / 1000);
  }

  function offsetSeconds(zone, jd) {
    return offsetAtMs(zone, msFromJd(jd));
  }

  // 'UTC', 'UTC+05:30', 'UTC-04:00', or 'UTC-04:56:02' when the offset has seconds.
  function formatOffset(seconds) {
    var s = Math.round(seconds || 0);
    var sign = s < 0 ? '-' : '+';
    var abs = Math.abs(s);
    var hh = Math.floor(abs / 3600);
    var mm = Math.floor((abs - hh * 3600) / 60);
    var ss = abs - hh * 3600 - mm * 60;
    var text;
    if (s === 0) return 'UTC';
    text = 'UTC' + sign + (hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm;
    if (ss) text += ':' + (ss < 10 ? '0' : '') + ss;
    return text;
  }

  // Short zone name at the instant: 'EDT', 'GMT+5:30', 'UTC'. Intl's short names
  // for zones outside the locale's region are 'GMT+n' forms, which are kept; a
  // missing or odd answer falls back to the formatted offset.
  function abbreviation(zone, jd) {
    var formatter, parts, i, name = '';
    if (zone === 'UTC') return 'UTC';
    formatter = nameFormatter(zone);
    if (formatter) {
      try {
        parts = formatter.formatToParts(new Date(wholeSecondMs(msFromJd(jd))));
        for (i = 0; i < parts.length; i++) {
          if (parts[i].type === 'timeZoneName') name = parts[i].value;
        }
      } catch (err) {
        name = '';
      }
    }
    if (!name || !/^[A-Za-z]/.test(name) || name.length > 12) name = formatOffset(offsetSeconds(zone, jd));
    return name;
  }

  // 'America/New_York (UTC-04:00)': the picker's option text before display tweaks.
  function label(zone, jd) {
    return zone + ' (' + formatOffset(offsetSeconds(zone, jd)) + ')';
  }

  // ---------------------------------------------------------------------------
  // Civil time in a zone
  // ---------------------------------------------------------------------------

  // Civil time of the instant jd in the zone. The fields come from the app's own
  // calendar code applied to jd shifted by the offset, so they match
  // Ephemeris.civilFromJd exactly when the offset is zero.
  function civil(zone, jd) {
    var off = offsetSeconds(zone, jd);
    var c = civilFromJd(jd + off / 86400);
    c.offsetSeconds = off;
    c.abbreviation = abbreviation(zone, jd);
    return c;
  }

  // UT Julian Date of a civil time in the zone. The civil time read as UT, c, is
  // off from the answer by the zone's offset at the answer, which is not yet
  // known; so the offsets in force a day before, at, and a day after c are tried
  // as candidates (a transition near c lies between the first and the last), and
  // a candidate counts when the zone's offset at the instant it gives is itself.
  //   - Ambiguous times (the repeated hour when clocks fall back) have two valid
  //     candidates; the earlier instant, the first occurrence, is returned.
  //   - Non-existent times (the skipped hour when clocks spring forward) have none;
  //     the pre-transition offset is used, so the clock lands the same distance
  //     past the transition as the request was into the gap: 02:30 on the US
  //     spring-forward day becomes 03:30 daylight time, one instant later than
  //     01:30 standard time plus an hour.
  function jd(zone, year, month, day, hour, minute, second) {
    var c = utcMs(year, month, day, hour, minute, second);
    var offsets = [];
    var probes, i, o, t, best = NaN;
    if (!isFinite(c)) return NaN;
    probes = [c - MS_PER_DAY, c, c + MS_PER_DAY];
    for (i = 0; i < probes.length; i++) {
      o = offsetAtMs(zone, probes[i]);
      if (offsets.indexOf(o) < 0) offsets.push(o);
    }
    for (i = 0; i < offsets.length; i++) {
      t = c - offsets[i] * 1000;
      if (offsetAtMs(zone, t) === offsets[i] && (isNaN(best) || t < best)) best = t;
    }
    if (isNaN(best)) best = c - offsets[0] * 1000;
    return jdFromMs(best);
  }

  return {
    REGIONS: REGIONS.concat([OTHER_REGION]),
    isValid: isValid,
    browserZone: browserZone,
    list: list,
    region: region,
    offsetSeconds: offsetSeconds,
    formatOffset: formatOffset,
    abbreviation: abbreviation,
    label: label,
    civil: civil,
    jd: jd
  };
});
