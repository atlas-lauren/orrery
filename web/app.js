/*
 * Orrery web application.
 *
 * Classic script (no modules). Exposes a single global, window.startOrrery(bundle),
 * which the inline bootstrap module in index.html calls once three.js and its addons
 * have loaded. Depends on window.Ephemeris (ephemeris.js) and, optionally,
 * window.OrreryVisuals (visuals.js), window.Moons (moons.js) and window.TimeZones
 * (timezone.js). Every visuals call is guarded so the app still runs with plain
 * materials if a generator is missing or throws; without moons.js no planet moons
 * are built and the planets fall back to the old rotation about the scene X axis
 * instead of their IAU pole directions; without timezone.js the clock is shown in
 * UT and the time-zone picker is hidden.
 * Earth starts with its procedural textures, then streams in NASA Blue Marble
 * imagery after start-up, and is oriented from Ephemeris.earthOrientation (mean
 * pole and equinox of date, Greenwich sidereal time) when that function exists.
 * The Moon likewise swaps in NASA's LRO colour mosaic and LOLA relief (shipped in
 * textures/) and is turned with Ephemeris.moonOrientation (IAU rotation model).
 * The asteroid and Kuiper belts are populations of real orbits propagated on the
 * GPU (OrreryVisuals.orbitalBelt): the app only feeds them the time, the reference
 * planet's mean longitude and the distance mapping each frame. The optional zodiac
 * overlay (OrreryVisuals.zodiacDisc) is a disc of twelve sectors centred on Earth,
 * turned to the mean equinox of date from Ephemeris.equinoxLongitude. While it is on
 * the scene is drawn at linear scale and the camera follows Earth from above, so the
 * planets sit in their signs; the signs and a marker for each body's direction from
 * Earth sit on a wheel of fixed screen size around Earth, and the Positions panel
 * shows geocentric tropical longitudes. The clock (state.jd)
 * runs in UT; the date headline and the date form show and accept civil time in the
 * IANA zone chosen in the picker (state.timeZone, converted by TimeZones and kept in
 * localStorage), while the Julian Date in the subline stays UT.
 *
 * Sections: constants, calendar helpers, startOrrery (state, moon catalogue, scene
 * setup, bodies, orbits, moon systems, precision mode, time engine, time zone, date
 * display, camera, UI, frame loop).
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------

  const J2000 = 2451545.0;
  const AU_KM = 149597870.7;
  const DEG = Math.PI / 180;
  const TWO_PI = Math.PI * 2;

  const PLANETS = ['mercury', 'venus', 'earth', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune', 'pluto'];
  // Positions panel order: the Moon sits directly under Earth.
  const INFO_BODIES = PLANETS.flatMap((p) => (p === 'earth' ? [p, 'moon'] : [p]));
  const SCENE_BODIES = ['sun'].concat(PLANETS, ['moon']);

  const DISPLAY_NAME = {
    sun: 'Sun', mercury: 'Mercury', venus: 'Venus', earth: 'Earth', moon: 'Moon', mars: 'Mars',
    jupiter: 'Jupiter', saturn: 'Saturn', uranus: 'Uranus', neptune: 'Neptune', pluto: 'Pluto'
  };

  const SPEEDS = [
    { label: 'Real time', daysPerSec: 1 / 86400 },
    { label: '1 min/s', daysPerSec: 1 / 1440 },
    { label: '1 hour/s', daysPerSec: 1 / 24 },
    { label: '1 day/s', daysPerSec: 1 },
    { label: '1 week/s', daysPerSec: 7 },
    { label: '1 month/s', daysPerSec: 30.4375 },
    { label: '1 year/s', daysPerSec: 365.25 },
    { label: '10 years/s', daysPerSec: 3652.5 },
    { label: '100 years/s', daysPerSec: 36525 }
  ];
  const DEFAULT_SPEED_INDEX = 0;

  // Distance mapping: scene units from heliocentric distance in AU.
  const DISTANCE_SCALE = 22;
  const COMPRESSED_EXPONENT = 0.6;
  const MOON_VISUAL_DISTANCE = 1.6;   // scene units from Earth center in compressed mode

  // Visual radii in scene units (compressed / default mode).
  const VISUAL_RADIUS = {
    sun: 4.0, mercury: 0.42, venus: 0.7, earth: 0.72, moon: 0.2, mars: 0.52,
    jupiter: 2.3, saturn: 1.95, uranus: 1.25, neptune: 1.2, pluto: 0.32
  };
  // Mean radii in km for "true size" mode (Earth = TRUE_SIZE_EARTH scene units).
  const REAL_RADIUS_KM = {
    sun: 695700, mercury: 2439.7, venus: 6051.8, earth: 6371.0, moon: 1737.4, mars: 3389.5,
    jupiter: 69911, saturn: 58232, uranus: 25362, neptune: 24622, pluto: 1188.3
  };
  const TRUE_SIZE_EARTH = 0.06;

  // Obliquity relative to the ecliptic, degrees. Fallback only: with moons.js loaded
  // the Sun and the planets are oriented to their IAU pole directions instead (see
  // orientBody). The Moon's value is its obliquity to the ecliptic per Cassini's laws
  // and is always applied as a rotation about the scene X axis.
  const AXIAL_TILT_DEG = {
    sun: 7.25, mercury: 0.03, venus: 177.4, earth: 23.44, mars: 25.19, jupiter: 3.13,
    saturn: 26.73, uranus: 97.77, neptune: 28.32, pluto: 122.5, moon: 1.54
  };
  // Sidereal rotation periods in days; negative marks the bodies that turn clockwise
  // seen from ecliptic north (Venus, Uranus, Pluto). The magnitude sets the spin rate
  // and orientBody resolves the sense against the pole direction it applied, so the
  // same table serves the IAU poles and the fallback tilt (whose obliquities above
  // 90 degrees reproduce the retrograde rotators with a positive spin). Planet moons
  // are added at start-up with their orbital period, i.e. synchronous rotation.
  const ROTATION_PERIOD_DAYS = {
    sun: 25.38, mercury: 58.646, venus: -243.02, earth: 0.99727, mars: 1.02596, jupiter: 0.41354,
    saturn: 0.44401, uranus: -0.71833, neptune: 0.67125, pluto: -6.3872, moon: 27.32
  };

  // A planet's moon system fades in as the planet's apparent radius on screen grows
  // from MOON_GATE_LO_PX to MOON_GATE_HI_PX (labels join at the halfway point).
  const MOON_GATE_LO_PX = 18;
  const MOON_GATE_HI_PX = 36;

  const MAJOR_BODIES = new Set(['sun', 'venus', 'earth', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune']);

  const ATMOSPHERES = {
    earth: { color: 0x5fb2ff, power: 3.0, intensity: 1.0 },
    venus: { color: 0xf3d9a4, power: 3.4, intensity: 0.6 },
    mars: { color: 0xffa070, power: 4.0, intensity: 0.3 },
    jupiter: { color: 0xe3ceb0, power: 4.5, intensity: 0.28 },
    saturn: { color: 0xf1e2bc, power: 4.5, intensity: 0.24 },
    uranus: { color: 0xa8ecf5, power: 3.6, intensity: 0.5 },
    neptune: { color: 0x7090ff, power: 3.6, intensity: 0.55 },
    titan: { color: 0xe6b264, power: 3.6, intensity: 0.45 }
  };
  const RINGS = {
    saturn: { inner: 1.35, outer: 2.3 },
    uranus: { inner: 1.6, outer: 2.0 }
  };

  const DEFAULT_COLOR = {
    sun: 0xffc46b, mercury: 0x9a9a9a, venus: 0xe8c48a, earth: 0x5c9cff, moon: 0xc9c9c9, mars: 0xe0713c,
    jupiter: 0xd9b48c, saturn: 0xe6d3a2, uranus: 0x9fe0ea, neptune: 0x5f7fff, pluto: 0xc8b7a6,
    // Planet moons, used only when OrreryVisuals.PLANET_STYLE has no entry for them.
    phobos: 0x9a8f85, deimos: 0xa89d92, io: 0xe0b040, europa: 0xd9d2c4, ganymede: 0xa89a88, callisto: 0x8c8378,
    mimas: 0xbdbdbd, enceladus: 0xe8ecf0, tethys: 0xd0d0d0, dione: 0xc4c4c2, rhea: 0xbfbdb8, titan: 0xe0a050,
    iapetus: 0xa0958a, miranda: 0xb5b5b5, ariel: 0xc2c2c0, umbriel: 0x8a8a88, titania: 0xb0aaa4, oberon: 0xa09a94,
    triton: 0xe0b8b0, charon: 0x9a8f86
  };
  const FALLBACK_COLOR = 0xb0aca6;

  const ZODIAC = ['Aries', 'Taurus', 'Gemini', 'Cancer', 'Leo', 'Virgo', 'Libra', 'Scorpio', 'Sagittarius', 'Capricorn', 'Aquarius', 'Pisces'];
  // Sign glyphs U+2648 .. U+2653 in ZODIAC order; used when visuals.js supplies no
  // OrreryVisuals.ZODIAC table.
  const ZODIAC_GLYPHS = ['\u2648', '\u2649', '\u264A', '\u264B', '\u264C', '\u264D', '\u264E', '\u264F', '\u2650', '\u2651', '\u2652', '\u2653'];
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  // localStorage key of the chosen time zone (an IANA name). Declared here, not in
  // startOrrery, because loadTimeZone() runs while the state object is being built.
  const TZ_STORAGE_KEY = 'orrery.timeZone';

  const CAMERA_FOV = 45;
  const CAMERA_NEAR = 0.05;          // initial value; frame() rescales it with the orbit distance
  const CAMERA_FAR = 20000;
  const NEAR_FRACTION = 0.004;       // near plane = orbit distance * this, clamped below
  const NEAR_MIN = 0.005;
  const NEAR_MAX = 2;
  // While a body with radius below NEAR_MIN / NEAR_RADIUS_FRACTION is followed (true-size
  // Phobos is 1e-4 units in radius; Iapetus and everything larger still clear NEAR_MIN),
  // the floor drops to this fraction of its radius: the camera then sits at the usual
  // 2.5-6 radii with the near surface 2x-6.7x beyond the near plane. The cost is far-depth
  // precision while such a body is followed, which only affects distant few-pixel discs.
  const NEAR_RADIUS_FRACTION = 0.75;
  const STAR_RADIUS = 6000;
  const SKY_RADIUS = 6500;

  const EXACT_TOLERANCE = 1e-6;      // days: response jd must match current jd this closely
  const ANCHOR_WINDOW_DAYS = 3;      // while playing slowly, drift from an exact anchor this far
  const FETCH_DEBOUNCE_MS = 200;
  const FETCH_THROTTLE_MS = 1000;
  const CACHE_MAX = 500;
  const INFO_UPDATE_MS = 100;

  // Camera presets: elevation above the ecliptic, reference heliocentric distance in AU
  // (mapped through the current distance mapping), and a multiplier on that distance.
  const CAMERA_PRESETS = {
    default: { elevation: 32, azimuth: 0, au: 7.5, mult: 1.8 },
    inner: { elevation: 42, azimuth: 0, au: 1.8, mult: 1.95 },
    full: { elevation: 45, azimuth: 0, au: 42, mult: 1.55 },
    top: { elevation: 89.9, azimuth: 0, au: 42, mult: 1.35 },
    edge: { elevation: 1.5, azimuth: 0, au: 42, mult: 1.5 }
  };

  // Zodiac view: the signs and the body markers sit on a wheel of fixed screen
  // size around Earth, like a chart wheel, whatever the zoom. Its radius in
  // CSS px comes from the part of the viewport clear of the title strip, the time
  // controls and the Positions panel, less room outside it for the sign labels, and
  // the camera's view offset puts Earth at its centre. The camera presets then set
  // how many AU from Earth lie on the ring: Saturn's distance (default and Top), the
  // inner system (Inner), the whole disc out past Pluto (Full).
  const WHEEL_MARGIN_X = 84;     // px outside the ring for the widest sign label
  const WHEEL_MARGIN_Y = 36;     // px outside the ring for a label above or below
  const WHEEL_MIN_PX = 150;      // below this the Positions panel may overlap the wheel instead
  const WHEEL_SIGN_GAP = 6;      // px between the ring and a sign label's near edge
  const WHEEL_TAG_GAP = 5;       // px between a marker dot and its tag's near edge
  const WHEEL_ELEVATION = 89.9;  // camera elevation above the ecliptic in the view
  const ZODIAC_RING_AU = { default: 11, top: 11, inner: 1.6, full: 50 };
  // Zoom-out limit of the orbit controls: the usual one, and the ceiling the
  // zodiac view may raise it to so the Full framing fits (the star sphere is
  // at STAR_RADIUS, 6000; the camera must stay inside it).
  const ZOOM_MAX_DEFAULT = 3000;
  const ZOOM_MAX_WHEEL = 5800;
  // The disc shader's default fade-in spans the first 4% of its radius about Earth;
  // at linear scale that is 2.2 AU and would blank the sector lines over the inner
  // system, so the view fades it over this many screen px instead (just past
  // Earth's dot) and draws the lines at this alpha.
  const WHEEL_DISC_INNER_PX = 10;
  const WHEEL_LINE_ALPHA = 0.6;
  // Nominal sector line width in CSS px; the shader's soft edge makes the visible
  // line about 2.5x this (its default, 0.75 device px, is hair-thin on HiDPI).
  const WHEEL_LINE_CSS_PX = 0.5;

  // Body dots: the fixed-size sprite each body carries for true-size mode doubles as
  // the body's mark in the zodiac view, where the globes are a pixel or
  // less at any framing that shows the outer planets. Its drawn radius in CSS px
  // (for label placement), and the globe radius above which it is not needed.
  const DOT_RADIUS_PX = 5;
  const DOT_FADE_PX = 7;

  // ---------------------------------------------------------------------------
  // Calendar helpers (proleptic Gregorian, astronomical year numbering)
  // ---------------------------------------------------------------------------

  function isLeapYear(year) {
    return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  }

  function daysInMonth(year, month) {
    const table = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (month === 2 && isLeapYear(year)) return 29;
    return table[month - 1];
  }

  function formatYear(year) {
    return year <= 0 ? (1 - year) + ' BCE' : String(year);
  }

  // Day of the week of a UT instant, 0 = Sunday (an index into WEEKDAYS).
  function weekdayIndex(jd) {
    return ((Math.floor(jd + 1.5) % 7) + 7) % 7;
  }

  function pad2(n) {
    n = Math.floor(n);
    return (n < 10 ? '0' : '') + n;
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : (v > hi ? hi : v);
  }

  function easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  // 0 at or below a, 1 at or above b, a smooth ramp between.
  function smoothstep01(a, b, x) {
    const t = clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  }

  function hexColor(value) {
    return '#' + ('000000' + (value >>> 0).toString(16)).slice(-6);
  }

  function prettyEphemeris(name) {
    if (!name) return 'JPL';
    const m = /de(\d+)/i.exec(name);
    return m ? 'JPL DE' + m[1] : String(name);
  }

  function zodiacText(lon) {
    let l = lon % 360;
    if (l < 0) l += 360;
    const idx = Math.min(11, Math.floor(l / 30));
    const within = l - idx * 30;
    return ZODIAC[idx] + ' ' + within.toFixed(1) + '°';
  }

  // ---------------------------------------------------------------------------
  // Application
  // ---------------------------------------------------------------------------

  function startOrrery(bundle) {
    const THREE = bundle.THREE;
    const OrbitControls = bundle.OrbitControls;
    const EffectComposer = bundle.EffectComposer;
    const RenderPass = bundle.RenderPass;
    const UnrealBloomPass = bundle.UnrealBloomPass;
    const OutputPass = bundle.OutputPass;

    const Eph = window.Ephemeris;
    const Vis = window.OrreryVisuals || null;
    const Moons = window.Moons || null;
    const TZ = window.TimeZones || null;
    if (!Eph) throw new Error('window.Ephemeris is not available');

    const JD_MIN = Eph.range.jdMin;
    const JD_MAX = Eph.range.jdMax;

    // ---- Moon catalogue ---------------------------------------------------------
    //
    // Everything about the major moons of the other planets comes from moons.js. The
    // catalogue is read once here so the tables above (display names, radii, rotation
    // periods) are extended before any body is built; the scene objects themselves
    // are created in buildMoonSystem / buildMoon during boot.

    const moonData = {};     // moon name -> { parent, displayName, radiusKm, periodDays, retrograde, parentRadiusKm }
    const moonOrder = [];    // [{ planet, names }] in Moons.SYSTEMS order, planets only

    function loadMoonCatalogue() {
      if (!Moons || !Moons.SYSTEMS || !Moons.DATA) return;
      if (typeof Moons.position !== 'function' || typeof Moons.orbitPoints !== 'function') {
        console.warn('window.Moons lacks position/orbitPoints; planet moons disabled');
        return;
      }
      for (const planet of PLANETS) {
        const names = Moons.SYSTEMS[planet];
        if (!Array.isArray(names) || names.length === 0) continue;
        const list = [];
        for (const name of names) {
          const d = Moons.DATA[name];
          if (!d || !(d.radiusKm > 0) || !(Math.abs(d.periodDays) > 0)) {
            console.warn('Moons.DATA is incomplete for ' + name + '; skipped');
            continue;
          }
          if (d.parent && d.parent !== planet) {
            console.warn('Moons.DATA[' + name + '].parent is ' + d.parent + ' but it is listed under ' + planet + '; skipped');
            continue;
          }
          if (SCENE_BODIES.indexOf(name) !== -1 || moonData[name]) {
            console.warn('Moon name ' + name + ' clashes with an existing body; skipped');
            continue;
          }
          const parentRadiusKm = (Moons.PLANET_RADIUS_KM && Moons.PLANET_RADIUS_KM[planet] > 0)
            ? Moons.PLANET_RADIUS_KM[planet] : REAL_RADIUS_KM[planet];
          moonData[name] = {
            parent: planet,
            displayName: d.displayName || (name.charAt(0).toUpperCase() + name.slice(1)),
            radiusKm: d.radiusKm,
            periodDays: Math.abs(d.periodDays),
            retrograde: !!d.retrograde,
            parentRadiusKm
          };
          DISPLAY_NAME[name] = moonData[name].displayName;
          REAL_RADIUS_KM[name] = d.radiusKm;
          ROTATION_PERIOD_DAYS[name] = moonData[name].periodDays;   // tidally locked: one turn per orbit
          list.push(name);
        }
        if (list.length) moonOrder.push({ planet, names: list });
      }
    }
    loadMoonCatalogue();
    const MOON_NAMES = moonOrder.reduce((acc, s) => acc.concat(s.names), []);

    // ---- DOM -----------------------------------------------------------------

    const $ = (id) => document.getElementById(id);
    const dom = {
      scene: $('scene'),
      labels: $('labels'),
      loading: $('loading'),
      loadingBar: $('loading-bar'),
      loadingStatus: $('loading-status'),
      dateHeadline: $('date-headline'),
      dateSubline: $('date-subline'),
      btnPlay: $('btn-play'),
      iconPlay: $('icon-play'),
      iconPause: $('icon-pause'),
      btnBackYear: $('btn-back-year'),
      btnBackMonth: $('btn-back-month'),
      btnBackDay: $('btn-back-day'),
      btnFwdDay: $('btn-fwd-day'),
      btnFwdMonth: $('btn-fwd-month'),
      btnFwdYear: $('btn-fwd-year'),
      speedSelect: $('speed-select'),
      btnReverse: $('btn-reverse'),
      btnNow: $('btn-now'),
      timeline: $('timeline'),
      timelineMarker: $('timeline-marker'),
      timelineTicks: $('timeline-ticks'),
      timelineHint: $('timeline-hint'),
      dateForm: $('date-form'),
      inYear: $('in-year'),
      eraHint: $('era-hint'),
      inMonth: $('in-month'),
      inDay: $('in-day'),
      inHour: $('in-hour'),
      inMinute: $('in-minute'),
      tzSelect: $('tz-select'),
      tzFallback: $('tz-fallback'),
      btnApply: $('btn-apply'),
      inDatetime: $('in-datetime'),
      infoPanel: $('info-panel'),
      infoRows: $('info-rows'),
      sourceBadge: $('source-badge'),
      elementSet: $('element-set'),
      btnInfoToggle: $('btn-info-toggle'),
      btnInfoClose: $('btn-info-close'),
      btnSettings: $('btn-settings'),
      btnHelp: $('btn-help'),
      settingsPopover: $('settings-popover'),
      helpPopover: $('help-popover'),
      optOrbits: $('opt-orbits'),
      optLabels: $('opt-labels'),
      optBelt: $('opt-belt'),
      optKuiper: $('opt-kuiper'),
      optPlutoPanel: $('opt-pluto-panel'),
      optZodiac: $('opt-zodiac'),
      optZodiacPanel: $('opt-zodiac-panel'),
      zodiacBadge: $('zodiac-badge'),
      titleBlock: $('title-block'),
      btnInfoHelp: $('btn-info-help'),
      infoFineprint: $('info-fineprint'),
      optMilkyWay: $('opt-milkyway'),
      optBloom: $('opt-bloom'),
      bloomStrength: $('bloom-strength'),
      optTrueScale: $('opt-truescale'),
      optTrueSize: $('opt-truesize'),
      optPluto: $('opt-pluto'),
      optMoon: $('opt-moon'),
      optPlanetMoons: $('opt-planet-moons'),
      presetInner: $('preset-inner'),
      presetFull: $('preset-full'),
      presetTop: $('preset-top'),
      presetEdge: $('preset-edge'),
      btnResetView: $('btn-reset-view'),
      focusChip: $('focus-chip'),
      focusName: $('focus-name'),
      btnUnfocus: $('btn-unfocus')
    };

    // ---- State ----------------------------------------------------------------

    const state = {
      jd: Eph.jdFromDate(new Date()),
      playing: true,
      speedIndex: DEFAULT_SPEED_INDEX,
      direction: 1,
      trueScale: false,
      trueSize: false,
      showOrbits: true,
      showLabels: true,
      showBelt: true,
      showKuiper: true,
      showMilkyWay: true,
      showPluto: true,
      showMoon: true,
      showPlanetMoons: true,
      zodiac: false,           // tropical zodiac view: linear scale, Earth followed from above, geocentric panel
      focus: null,             // body name being followed, or null for the Sun
      hover: null,             // body name under the pointer
      lastJdChangeAt: 0,       // performance.now() of the last jd change
      lastInfoUpdate: 0,
      lastInputSync: 0,
      fineScrub: false,
      infoPanelUserSet: false,
      timeZone: 'UTC'          // IANA zone of the headline and date form; set from storage below
    };
    state.jd = clamp(state.jd, JD_MIN, JD_MAX);
    state.timeZone = loadTimeZone();

    // Debug handle: the geographic point with the Sun overhead and the selenographic
    // point with the Earth overhead at the current date are the ground truth the Earth
    // and Moon orientations below are checked against.
    window.__orrery = {
      subsolar: () => (typeof Eph.subsolarPoint === 'function' ? Eph.subsolarPoint(state.jd) : null),
      libration: () => (typeof Eph.moonLibration === 'function' ? Eph.moonLibration(state.jd) : null),
      jd: () => state.jd,
      zodiac: () => ({ on: state.zodiac, linear: linearDistances(), equinoxDeg: zodiac.equinoxDeg,
        radius: zodiac.radius, ring: zodiac.ring, disc: !!zodiac.mesh, wheel: zodiac.wheel,
        ariesRad: zodiac.uniforms ? zodiac.uniforms.uAries.value : NaN,
        markers: zodiac.markers.map((m) => ({ name: m.name, shown: m.shown, tropicalDeg: m.tropicalDeg })) }),
      // Screen positions (CSS px) of the bodies and of the zodiac markers, for checking
      // that at real scale each marker, its body and Earth are collinear on screen.
      screen: () => ({
        bodies: bodyList.map((rec) => ({ name: rec.name, x: rec.screen.x, y: rec.screen.y, r: rec.screen.r, visible: rec.screen.visible })),
        markers: zodiac.markers.map((m) => ({ name: m.name, x: m.screen.x, y: m.screen.y, shown: m.shown, tropicalDeg: m.tropicalDeg }))
      }),
      precision: () => ({ enabled: precision.enabled, checked: precision.checked, inflight: precision.inflight,
        lastFetchAt: precision.lastFetchAt, lastRequestedJd: precision.lastRequestedJd, hasExact: !!precision.exact,
        playing: state.playing, speedIndex: state.speedIndex })
    };

    const precision = {
      enabled: true,
      checked: false,
      ephemeris: null,
      exact: null,             // { jd, bodies }
      kepAnchor: null,         // Ephemeris.all(exact.jd)
      inflight: false,
      lastFetchAt: -Infinity,
      lastRequestedJd: NaN,
      cache: new Map()
    };
    if (location.protocol === 'file:') precision.enabled = false;

    // Set once the zodiac objects exist; the wheel layout (called from resize and
    // panel handlers, some of which run during the build) waits for it.
    let wheelReady = false;

    // ---- Distance mapping -------------------------------------------------------

    // Linear (true-scale) distances are on when the user asks for them or while the
    // zodiac view is on; otherwise radii are compressed.
    function linearDistances() {
      return state.trueScale || state.zodiac;
    }

    function zodiacOn() {
      return state.zodiac;
    }

    // Fixed-size body dots are drawn in true-size mode and in the zodiac view.
    function bodyDotsOn() {
      return state.trueSize || state.zodiac;
    }

    function mapDistance(rAu) {
      if (rAu <= 0) return 0;
      return linearDistances() ? DISTANCE_SCALE * rAu : DISTANCE_SCALE * Math.pow(rAu, COMPRESSED_EXPONENT);
    }

    // Everything that bakes mapDistance in: the orbit lines, the belts (mapping
    // uniforms, or a rebuild of a static fallback belt) and the zodiac disc. Called
    // whenever the effective mapping flips, from the true-scale switch or the
    // zodiac view. With recenter, an unfocused camera returns to the
    // default view, which is sized through the new mapping.
    function applyDistanceMapping(recenter) {
      updateOrbits(true);
      applyBeltScale();
      buildZodiacDisc();   // its radius is mapDistance(ZODIAC_RADIUS_AU) in the new mapping; the markers follow next frame
      if (recenter && !state.focus) applyPreset('default', 900);
    }

    // Ecliptic (x, y, z) in AU -> scene vector (sceneX = ex, sceneY = ez, sceneZ = -ey)
    // with the radial distance mapped through mapDistance.
    function toScene(p, out) {
      const r = Math.sqrt(p.x * p.x + p.y * p.y + p.z * p.z);
      const s = r > 0 ? mapDistance(r) / r : 0;
      return out.set(p.x * s, p.z * s, -p.y * s);
    }

    function bodyRadius(name) {
      const md = moonData[name];
      if (md) {
        // Planet moons scale with their parent's drawn radius: the true ratio in
        // true-size mode, otherwise three times it, clamped so the smallest stay
        // visible and clickable and Charon does not rival Pluto.
        const ratio = md.radiusKm / md.parentRadiusKm;
        const rParent = bodyRadius(md.parent);
        return state.trueSize ? rParent * ratio : rParent * clamp(3 * ratio, 0.06, 0.5);
      }
      if (state.trueSize) return TRUE_SIZE_EARTH * REAL_RADIUS_KM[name] / REAL_RADIUS_KM.earth;
      return VISUAL_RADIUS[name];
    }

    function accentOf(name) {
      const style = Vis && Vis.PLANET_STYLE && Vis.PLANET_STYLE[name];
      if (style && typeof style.color === 'number') return style.color;
      if (typeof DEFAULT_COLOR[name] === 'number') return DEFAULT_COLOR[name];
      return FALLBACK_COLOR;
    }

    // ---- Renderer, scene, camera ------------------------------------------------

    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    renderer.setPixelRatio(pixelRatio);
    renderer.setSize(Math.max(1, window.innerWidth), Math.max(1, window.innerHeight));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    dom.scene.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = null;

    const camera = new THREE.PerspectiveCamera(CAMERA_FOV, Math.max(1, window.innerWidth) / Math.max(1, window.innerHeight), CAMERA_NEAR, CAMERA_FAR);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;
    controls.minDistance = 2;
    controls.maxDistance = 3000;
    controls.zoomSpeed = 0.8;
    controls.enablePan = false;

    const composer = new EffectComposer(renderer);
    composer.setPixelRatio(pixelRatio);
    composer.setSize(Math.max(1, window.innerWidth), Math.max(1, window.innerHeight));
    const renderPass = new RenderPass(scene, camera);
    // Threshold sits above the brightest lit planet texel: with the point light below,
    // a white Lambert surface reaches intensity / PI = 1.08 in the linear HDR buffer,
    // so only the Sun shader (which outputs well above 1.3) crosses into the bloom.
    const bloomPass = new UnrealBloomPass(new THREE.Vector2(Math.max(1, window.innerWidth), Math.max(1, window.innerHeight)), 0.5, 0.55, 1.15);
    const outputPass = new OutputPass();
    composer.addPass(renderPass);
    composer.addPass(bloomPass);
    composer.addPass(outputPass);

    const sunLight = new THREE.PointLight(0xfff2dd, 3.4, 0, 0);
    sunLight.position.set(0, 0, 0);
    scene.add(sunLight);
    scene.add(new THREE.AmbientLight(0x334466, 0.12));

    // A fixed near plane cannot serve both true-size Pluto (radius 0.011) and the
    // outer planets 660 units away, so it follows the orbit distance. Depth precision
    // then stays fine enough for the additive atmosphere shells to be occluded by
    // the planet body at every zoom.
    function updateNearPlane() {
      const d = camera.position.distanceTo(controls.target);
      const followed = state.focus ? bodies[state.focus] : null;
      const floor = (followed && followed.radius > 0) ? Math.min(NEAR_MIN, followed.radius * NEAR_RADIUS_FRACTION) : NEAR_MIN;
      const near = clamp(d * NEAR_FRACTION, floor, NEAR_MAX);
      if (Math.abs(near - camera.near) > camera.near * 0.01) {
        camera.near = near;
        camera.far = CAMERA_FAR;
        camera.updateProjectionMatrix();
      }
    }

    function onResize() {
      const w = window.innerWidth;
      const h = window.innerHeight;
      if (w === 0 || h === 0) return;
      if (!state.infoPanelUserSet) setInfoPanel(w >= 760);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
      composer.setSize(w, h);
      if (sky.stars && sky.stars.material && sky.stars.material.uniforms && sky.stars.material.uniforms.uPixelRatio) {
        sky.stars.material.uniforms.uPixelRatio.value = renderer.getPixelRatio();
      }
      for (let i = 0; i < orbitalBelts.length; i++) {
        const u = orbitalBelts[i].uniforms;
        if (u.uPixelRatio) u.uPixelRatio.value = renderer.getPixelRatio();
      }
      updateWheelLayout();
    }
    window.addEventListener('resize', onResize);

    // Keep the positions panel clear of the time controls, whose height changes
    // as the date form wraps at different widths (the CSS default is a guess).
    const controlsEl = document.getElementById('controls');
    if (controlsEl && typeof ResizeObserver !== 'undefined') {
      const updateControlsHeight = () => {
        // Distance from the controls' top edge to the window bottom, so the
        // panel's 20 px gap holds whatever the controls' own bottom offset is.
        const h = Math.round(window.innerHeight - controlsEl.getBoundingClientRect().top);
        if (h > 0 && h < window.innerHeight) document.documentElement.style.setProperty('--controls-h', h + 'px');
        updateWheelLayout();
      };
      const controlsObserver = new ResizeObserver(updateControlsHeight);
      controlsObserver.observe(controlsEl);
      window.addEventListener('resize', updateControlsHeight);
      updateControlsHeight();
    }

    // ---- Sky -------------------------------------------------------------------

    const sky = { stars: null, milkyWay: null, belt: null, kuiper: null };

    function fallbackStarfield() {
      const count = 6000;
      const positions = new Float32Array(count * 3);
      const colors = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        const u = Math.random() * 2 - 1;
        const phi = Math.random() * TWO_PI;
        const s = Math.sqrt(1 - u * u);
        positions[i * 3] = STAR_RADIUS * s * Math.cos(phi);
        positions[i * 3 + 1] = STAR_RADIUS * u;
        positions[i * 3 + 2] = STAR_RADIUS * s * Math.sin(phi);
        const t = Math.random();
        colors[i * 3] = 0.75 + 0.25 * t;
        colors[i * 3 + 1] = 0.78 + 0.18 * (1 - Math.abs(t - 0.5));
        colors[i * 3 + 2] = 0.8 + 0.2 * (1 - t);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      const mat = new THREE.PointsMaterial({ size: 1.6, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0.85 });
      return new THREE.Points(geo, mat);
    }

    function fallbackBelt(inner, outer, count) {
      const positions = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        const r = inner + (outer - inner) * Math.sqrt(Math.random());
        const a = Math.random() * TWO_PI;
        positions[i * 3] = r * Math.cos(a);
        positions[i * 3 + 1] = (Math.random() - 0.5) * 0.08 * r;
        positions[i * 3 + 2] = r * Math.sin(a);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      const mat = new THREE.PointsMaterial({ color: 0x8a8f9a, size: 1.2, sizeAttenuation: false, transparent: true, opacity: 0.45 });
      return new THREE.Points(geo, mat);
    }

    function visualsCall(fnName, args, fallback) {
      if (Vis && typeof Vis[fnName] === 'function') {
        try {
          const result = Vis[fnName].apply(Vis, args);
          if (result) return result;
          console.warn('OrreryVisuals.' + fnName + ' returned nothing; using fallback');
        } catch (err) {
          console.warn('OrreryVisuals.' + fnName + ' failed; using fallback', err);
        }
      }
      return typeof fallback === 'function' ? fallback() : null;
    }

    function buildSky() {
      sky.stars = visualsCall('starfield', [STAR_RADIUS, 14000], fallbackStarfield);
      if (sky.stars) { sky.stars.name = 'starfield'; sky.stars.frustumCulled = false; scene.add(sky.stars); }
      sky.milkyWay = visualsCall('milkyWay', [SKY_RADIUS], null);
      if (sky.milkyWay) { sky.milkyWay.name = 'milkyway'; sky.milkyWay.frustumCulled = false; sky.milkyWay.visible = state.showMilkyWay; scene.add(sky.milkyWay); }
    }

    // ---- Belts -----------------------------------------------------------------
    //
    // Both belts are populations of real Keplerian orbits propagated in the vertex
    // shader (OrreryVisuals.orbitalBelt). The geometry holds orbital elements and is
    // built once; the material maps every particle into the scene from uDays (TT days
    // since J2000), uRefLon (unwrapped mean longitude of the reference planet, which
    // the resonant particles are locked to: plutinos and twotinos with Neptune, Hildas
    // and Trojans with Jupiter) and the current distance mapping (uScale, uExponent). The
    // true-scale toggle therefore only changes two uniforms. If orbitalBelt is missing
    // or throws, the old static ring builders are used; those bake scene positions and
    // are rebuilt on scale changes as before.

    const BELT_SPECS = {
      belt:   { kind: 'asteroid', count: 9000,  name: 'asteroid-belt', refBody: 'jupiter' },
      kuiper: { kind: 'kuiper',   count: 14000, name: 'kuiper-belt',   refBody: 'neptune' }
    };
    const orbitalBelts = [];      // [{ points, uniforms, refBody, lastL, refLon }], rebuilt by refreshOrbitalBelts
    const beltWarned = {};        // kind -> true once the static-fallback warning has been logged
    // The shader's resonant branch formula divides the planet's mean longitude by p,
    // so uRefLon has to be continuous in time: a 360 deg wrap would move every
    // plutino, twotino and Hilda by q / p of a turn in one frame (only the 1:1 Trojans
    // are immune). Ephemeris.meanLongitudeUnwrapped is that continuous angle; with
    // only the [0, 360) meanLongitude available it is unwrapped across frames instead.
    const hasUnwrappedLongitude = typeof Eph.meanLongitudeUnwrapped === 'function';
    const hasMeanLongitude = hasUnwrappedLongitude || typeof Eph.meanLongitude === 'function';
    let lastBeltJd = NaN;

    function disposeSkyObject(key) {
      const obj = sky[key];
      if (!obj) return;
      scene.remove(obj);
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) obj.material.dispose();
      sky[key] = null;
    }

    // The ShaderMaterial uniforms of an orbital belt, or null for a static one.
    function beltUniforms(points) {
      const u = points && points.material && points.material.uniforms;
      return u && u.uDays && u.uRefLon && u.uScale && u.uExponent ? u : null;
    }

    function isOrbitalBelt(points) {
      return beltUniforms(points) !== null;
    }

    function warnBeltFallback(kind, message, err) {
      if (beltWarned[kind]) return;
      beltWarned[kind] = true;
      if (err) console.warn(message, err); else console.warn(message);
    }

    function makeOrbitalBelt(spec) {
      if (!Vis || typeof Vis.orbitalBelt !== 'function') {
        warnBeltFallback(spec.kind, 'OrreryVisuals.orbitalBelt is not available; using the static ' + spec.kind + ' belt');
        return null;
      }
      let points = null;
      try {
        points = Vis.orbitalBelt({ kind: spec.kind, count: spec.count });
        if (points && beltUniforms(points)) return points;
        throw new Error('orbitalBelt(' + spec.kind + ') returned no Points with the belt uniforms');
      } catch (err) {
        if (points) {
          if (points.geometry) points.geometry.dispose();
          if (points.material) points.material.dispose();
        }
        warnBeltFallback(spec.kind, 'OrreryVisuals.orbitalBelt(' + spec.kind + ') failed; using the static belt', err);
        return null;
      }
    }

    // Distance mapping and sprite scale for an orbital belt; no-op for a static one.
    function applyBeltUniforms(points) {
      const u = beltUniforms(points);
      if (!u) return;
      u.uScale.value = DISTANCE_SCALE;
      u.uExponent.value = linearDistances() ? 1.0 : COMPRESSED_EXPONENT;
      if (u.uPixelRatio) u.uPixelRatio.value = renderer.getPixelRatio();
    }

    function attachBelt(key, points) {
      sky[key] = points;
      if (!points) return;
      const spec = BELT_SPECS[key];
      points.name = spec.name;
      points.visible = key === 'belt' ? state.showBelt : state.showKuiper;
      points.frustumCulled = false;   // positions are computed in the vertex shader
      applyBeltUniforms(points);
      scene.add(points);
    }

    // Rebuild the per-frame list of orbital belts and push the current time into them.
    function refreshOrbitalBelts() {
      orbitalBelts.length = 0;
      for (const key of ['belt', 'kuiper']) {
        const points = sky[key];
        const uniforms = beltUniforms(points);
        if (!uniforms) continue;
        const refBody = (points.userData && typeof points.userData.refBody === 'string') ? points.userData.refBody : BELT_SPECS[key].refBody;
        orbitalBelts.push({ points: points, uniforms: uniforms, refBody: refBody, lastL: NaN, refLon: 0 });
      }
      if (orbitalBelts.length > 0 && !hasMeanLongitude) {
        warnBeltFallback('meanLongitude', 'Ephemeris.meanLongitude is missing; resonant belt particles will not follow their planets');
      }
      lastBeltJd = NaN;
      updateBelts(state.jd);
    }

    function buildBelt() {
      disposeSkyObject('belt');
      let points = makeOrbitalBelt(BELT_SPECS.belt);
      if (!points) {
        const inner = mapDistance(2.2);
        const outer = mapDistance(3.3);
        points = visualsCall('asteroidBelt', [inner, outer, 4000], () => fallbackBelt(inner, outer, 4000));
      }
      attachBelt('belt', points);
      refreshOrbitalBelts();
    }

    function buildKuiperBelt() {
      disposeSkyObject('kuiper');
      let points = makeOrbitalBelt(BELT_SPECS.kuiper);
      if (!points) {
        // Static ring, 30 to 50 AU, sampled in AU and mapped through the current
        // distance mapping so it sits correctly in both compressed and true scale.
        const mapRadius = (au) => mapDistance(au);
        points = visualsCall('kuiperBelt', [30, 50, 9000, mapRadius], () => fallbackBelt(mapDistance(39), mapDistance(48), 6000));
      }
      attachBelt('kuiper', points);
      refreshOrbitalBelts();
    }

    // True-scale toggle: an orbital belt just takes the new mapping uniforms; a static
    // fallback belt has its scene positions baked in and must be rebuilt.
    function applyBeltScale() {
      if (sky.belt && !isOrbitalBelt(sky.belt)) buildBelt(); else applyBeltUniforms(sky.belt);
      if (sky.kuiper && !isOrbitalBelt(sky.kuiper)) buildKuiperBelt(); else applyBeltUniforms(sky.kuiper);
    }

    // Per frame: TT days since J2000 and the reference planet's mean longitude.
    // Allocation-free; skipped while the clock stands still.
    function updateBelts(jd) {
      if (orbitalBelts.length === 0 || jd === lastBeltJd) return;
      lastBeltJd = jd;
      const days = jd + Eph.deltaT(jd) / 86400 - J2000;
      for (let i = 0; i < orbitalBelts.length; i++) {
        const entry = orbitalBelts[i];
        entry.uniforms.uDays.value = days;
        if (hasMeanLongitude) entry.uniforms.uRefLon.value = referenceLongitude(entry, jd);
      }
    }

    // Continuous mean longitude of a belt's reference planet, radians. The fallback
    // unwraps the [0, 360) value from frame to frame: Jupiter moves at most 51 deg
    // per 60 fps frame at the fastest clock rate, well under the 180 deg ambiguity;
    // a larger date jump just lands on the nearest branch, which is harmless since
    // every particle moves anyway.
    function referenceLongitude(entry, jd) {
      if (hasUnwrappedLongitude) return Eph.meanLongitudeUnwrapped(entry.refBody, jd) * DEG;
      const L = Eph.meanLongitude(entry.refBody, jd) * DEG;
      if (Number.isNaN(entry.lastL)) {
        entry.lastL = L;
        entry.refLon = L;
        return L;
      }
      let d = L - entry.lastL;
      if (d > Math.PI) d -= TWO_PI; else if (d < -Math.PI) d += TWO_PI;
      entry.refLon += d;
      entry.lastL = L;
      return entry.refLon;
    }

    // ---- Bodies ------------------------------------------------------------------

    const bodies = {};          // name -> body record
    const bodyList = [];        // records in SCENE_BODIES order
    const sun = { mesh: null, material: null, corona: null, coronaMaterial: null, group: null };

    function safeTextures(name) {
      if (!Vis || typeof Vis.planetTextures !== 'function') return null;
      try {
        const tex = Vis.planetTextures(name);
        if (tex && tex.map && THREE.SRGBColorSpace) tex.map.colorSpace = THREE.SRGBColorSpace;
        if (tex && tex.emissiveMap && THREE.SRGBColorSpace) tex.emissiveMap.colorSpace = THREE.SRGBColorSpace;
        if (tex && tex.cloudsMap && THREE.SRGBColorSpace) tex.cloudsMap.colorSpace = THREE.SRGBColorSpace;
        return tex;
      } catch (err) {
        console.warn('planetTextures(' + name + ') failed; using flat color', err);
        return null;
      }
    }

    function makeMarkerTexture(color) {
      const size = 64;
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      const c = new THREE.Color(color);
      const rgb = Math.round(c.r * 255) + ',' + Math.round(c.g * 255) + ',' + Math.round(c.b * 255);
      const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
      grad.addColorStop(0, 'rgba(' + rgb + ',1)');
      grad.addColorStop(0.28, 'rgba(' + rgb + ',0.95)');
      grad.addColorStop(0.42, 'rgba(' + rgb + ',0.25)');
      grad.addColorStop(1, 'rgba(' + rgb + ',0)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, size, size);
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      return tex;
    }

    // View-space direction from Earth toward the Sun; the Earth shader fades its city
    // lights out on the sunlit hemisphere with it. Updated every frame in updateBodies.
    const earthSunDir = { value: new THREE.Vector3(0, 0, 1) };

    // Masks Earth's emissive city lights to the night side. Installed on the Phong
    // material whenever it carries an emissive map, procedural or downloaded.
    function installEarthNightLights(material) {
      if (material.userData.nightLights) return;
      material.userData.nightLights = true;
      material.onBeforeCompile = (shader) => {
        shader.uniforms.uSunDir = earthSunDir;
        shader.fragmentShader = 'uniform vec3 uSunDir;\n' + shader.fragmentShader.replace(
          '#include <emissivemap_fragment>',
          '#include <emissivemap_fragment>\n' +
          '  totalEmissiveRadiance *= 1.0 - smoothstep(-0.15, 0.05, dot(normalize(vNormal), uSunDir));'
        );
      };
      material.customProgramCacheKey = () => 'earth-night-lights';
    }

    function createPlanetMaterial(name, tex, accent) {
      const hasMap = !!(tex && tex.map);
      if (name === 'earth') {
        const params = {
          shininess: 18,
          specular: new THREE.Color(0x4a5560),
          emissive: new THREE.Color(0xffe2a8),
          emissiveIntensity: 0.9
        };
        if (hasMap) params.map = tex.map; else params.color = new THREE.Color(accent);
        if (tex && tex.bumpMap) { params.bumpMap = tex.bumpMap; params.bumpScale = 0.02; }
        if (tex && tex.specularMap) params.specularMap = tex.specularMap;
        if (tex && tex.emissiveMap) params.emissiveMap = tex.emissiveMap; else params.emissiveIntensity = 0;
        const material = new THREE.MeshPhongMaterial(params);
        if (params.emissiveMap) installEarthNightLights(material);
        return material;
      }
      const params = { roughness: 0.9, metalness: 0 };
      if (hasMap) params.map = tex.map; else params.color = new THREE.Color(accent);
      if (tex && tex.bumpMap) { params.bumpMap = tex.bumpMap; params.bumpScale = 0.02; }
      return new THREE.MeshStandardMaterial(params);
    }

    function buildRing(name, spec, accent) {
      const geo = new THREE.RingGeometry(spec.inner, spec.outer, 256, 1);
      const pos = geo.attributes.position;
      const uv = geo.attributes.uv;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i);
        const y = pos.getY(i);
        const r = Math.sqrt(x * x + y * y);
        uv.setXY(i, clamp((r - spec.inner) / (spec.outer - spec.inner), 0, 1), 0.5);
      }
      uv.needsUpdate = true;
      const map = visualsCall('ringTexture', [name], null);
      if (map && THREE.SRGBColorSpace) map.colorSpace = THREE.SRGBColorSpace;
      // The opaque planet (drawn first) provides occlusion; the rings themselves do not
      // write depth, so the translucent C ring lets the atmosphere rim and orbit lines
      // show through instead of cutting a notch out of them.
      const params = { side: THREE.DoubleSide, transparent: true, alphaTest: 0.05, depthWrite: false };
      if (map) params.map = map; else { params.color = new THREE.Color(accent); params.opacity = 0.6; }
      const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial(params));
      mesh.rotation.x = -Math.PI / 2;
      mesh.renderOrder = 1;
      mesh.name = name + '-rings';
      return mesh;
    }

    const UP = new THREE.Vector3(0, 1, 0);
    const poleTmp = new THREE.Vector3();

    // IAU north pole of a body as a unit vector in scene coordinates, or null when
    // moons.js is absent or has no pole for it.
    function poleSceneOf(name, out) {
      if (!Moons || typeof Moons.poleEcliptic !== 'function') return null;
      if (Moons.POLES && !Moons.POLES[name]) return null;
      let p = null;
      try { p = Moons.poleEcliptic(name); } catch (err) { p = null; }
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return null;
      out.set(p.x, p.z, -p.y);
      if (out.lengthSq() < 1e-12) return null;
      return out.normalize();
    }

    // Orients a body's tilt group and returns the sign of its spin about that group's
    // +Y axis. With moons.js, +Y is rotated onto the body's IAU pole; a planet moon
    // takes its parent's pole, reversed for a retrograde orbit, since the major moons
    // are tidally locked with their spin axis along the orbit normal. A pole table may
    // give the north pole or the right-hand pole, so the sense is settled against the
    // ecliptic: the rotation table marks the bodies that turn clockwise seen from
    // ecliptic north, which is a negative spin about a north-pointing pole and a
    // positive one about a south-pointing pole. Without moons.js the rotation about
    // the scene X axis is kept, and a positive spin is right for every body there.
    function orientBody(tilt, name, moonOf) {
      if (moonOf) {
        const parentRec = bodies[moonOf];
        const md = moonData[name];
        const pole = poleSceneOf(moonOf, poleTmp);
        if (pole && parentRec) {
          if (md && md.retrograde) pole.negate();
          tilt.quaternion.setFromUnitVectors(UP, pole);
          return parentRec.spinSign;
        }
        tilt.rotation.x = -(AXIAL_TILT_DEG[moonOf] || 0) * DEG;
        return 1;
      }
      if (name !== 'moon') {
        const pole = poleSceneOf(name, poleTmp);
        if (pole) {
          tilt.quaternion.setFromUnitVectors(UP, pole);
          const clockwise = (ROTATION_PERIOD_DAYS[name] || 0) < 0;
          return (clockwise ? -1 : 1) * (pole.y >= 0 ? 1 : -1);
        }
      }
      tilt.rotation.x = -(AXIAL_TILT_DEG[name] || 0) * DEG;
      return 1;
    }

    // Earth's cloud shell, a child of the tilt group so it shares the pole; its own
    // rotation.y is set per frame. Built at start-up from the procedural map, or when
    // the downloaded one arrives if visuals.js supplied none.
    function attachEarthClouds(record, map) {
      const cloudMat = new THREE.MeshStandardMaterial({
        map, transparent: true, depthWrite: false, roughness: 1, metalness: 0, opacity: 0.85
      });
      const clouds = new THREE.Mesh(new THREE.SphereGeometry(1.012, 96, 64), cloudMat);
      clouds.name = 'earth-clouds';
      clouds.renderOrder = 1;
      record.tilt.add(clouds);
      record.clouds = clouds;
      return clouds;
    }

    // opts.moonOf names the parent planet of a planet moon and opts.container the
    // Object3D the body's group is added to (the scene by default).
    function buildBody(name, tex, opts) {
      const o = opts || {};
      const moonOf = o.moonOf || null;
      const accent = accentOf(name);
      const radius = bodyRadius(name);
      const segments = MAJOR_BODIES.has(name) ? [96, 64] : [48, 32];

      const group = new THREE.Group();
      group.name = name;
      const tilt = new THREE.Group();
      const spinSign = orientBody(tilt, name, moonOf);
      tilt.scale.setScalar(radius);
      const spin = new THREE.Group();

      const geometry = new THREE.SphereGeometry(1, segments[0], segments[1]);
      const material = createPlanetMaterial(name, tex, accent);
      if (material.bumpMap) material.bumpScale = 0.02 * radius;
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = name + '-surface';
      spin.add(mesh);
      tilt.add(spin);
      group.add(tilt);

      const record = {
        name, group, tilt, spin, mesh, material, accent, radius, spinSign,
        isMoon: !!moonOf, parent: moonOf, parentRadiusKm: moonOf ? moonData[name].parentRadiusKm : 0,
        distKm: 0, system: null, orbit: null, labelOn: true,
        clouds: null, atmosphere: null, rings: null, pick: null, marker: null,
        label: null, visible: true, screen: { x: 0, y: 0, r: 0, visible: false, inView: false }
      };

      if (name === 'earth' && tex && tex.cloudsMap) attachEarthClouds(record, tex.cloudsMap);

      const atmo = ATMOSPHERES[name];
      if (atmo) {
        const atmoMat = visualsCall('atmosphereMaterial', [atmo.color, atmo.power, atmo.intensity], null);
        if (atmoMat) {
          const shell = new THREE.Mesh(new THREE.SphereGeometry(1.06, 64, 48), atmoMat);
          shell.name = name + '-atmosphere';
          shell.renderOrder = 2;
          tilt.add(shell);
          record.atmosphere = shell;
        }
      }

      if (RINGS[name]) {
        const rings = buildRing(name, RINGS[name], accent);
        tilt.add(rings);
        record.rings = rings;
      }

      // Invisible, slightly larger sphere so small bodies are easy to click.
      const pick = new THREE.Mesh(
        new THREE.SphereGeometry(1.7, 16, 12),
        new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, transparent: true, opacity: 0 })
      );
      pick.name = name + '-pick';
      pick.userData.body = name;
      mesh.userData.body = name;
      tilt.add(pick);
      record.pick = pick;

      // Always-visible marker for true-size mode.
      const marker = new THREE.Sprite(new THREE.SpriteMaterial({
        map: makeMarkerTexture(accent), sizeAttenuation: false, depthTest: false, depthWrite: false, transparent: true, opacity: 0.9
      }));
      marker.scale.set(0.02, 0.02, 1);
      marker.visible = false;
      marker.renderOrder = 5;
      marker.userData.body = name;
      group.add(marker);
      record.marker = marker;

      (o.container || scene).add(group);
      bodies[name] = record;
      bodyList.push(record);
      return record;
    }

    function buildSun(tex) {
      const radius = bodyRadius('sun');
      const group = new THREE.Group();
      group.name = 'sun';
      const tilt = new THREE.Group();
      const spinSign = orientBody(tilt, 'sun', null);
      tilt.scale.setScalar(radius);
      const spin = new THREE.Group();

      let material = visualsCall('sunMaterial', [], null);
      if (!material) {
        // Only the fallback needs a painted map; the shader material ignores textures.
        if (!tex) tex = safeTextures('sun');
        const params = { color: new THREE.Color(2.6, 1.9, 1.1) };
        if (tex && tex.map) { params.map = tex.map; }
        material = new THREE.MeshBasicMaterial(params);
      }
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 64), material);
      mesh.name = 'sun-surface';
      mesh.userData.body = 'sun';
      spin.add(mesh);
      tilt.add(spin);
      group.add(tilt);

      const coronaMat = visualsCall('coronaMaterial', [], null);
      let corona = null;
      if (coronaMat) {
        corona = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), coronaMat);
        corona.name = 'sun-corona';
        corona.scale.set(2.6 * 2 * radius, 2.6 * 2 * radius, 1);
        corona.renderOrder = 3;
        corona.frustumCulled = false;
        group.add(corona);
      }

      const pick = new THREE.Mesh(
        new THREE.SphereGeometry(1.15, 16, 12),
        new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, transparent: true, opacity: 0 })
      );
      pick.userData.body = 'sun';
      tilt.add(pick);

      scene.add(group);
      sun.group = group;
      sun.mesh = mesh;
      sun.material = material;
      sun.corona = corona;
      sun.coronaMaterial = coronaMat;

      const record = {
        name: 'sun', group, tilt, spin, mesh, material, accent: accentOf('sun'), radius, spinSign,
        isMoon: false, parent: null, parentRadiusKm: 0, system: null, orbit: null, labelOn: true,
        clouds: null, atmosphere: null, rings: null, pick, marker: null,
        label: null, visible: true, screen: { x: 0, y: 0, r: 0, visible: false, inView: false }
      };
      bodies.sun = record;
      bodyList.push(record);
      return record;
    }

    function applyRadii() {
      for (const rec of bodyList) {
        const r = bodyRadius(rec.name);
        rec.radius = r;
        rec.tilt.scale.setScalar(r);
        if (rec.material && rec.material.bumpMap) rec.material.bumpScale = 0.02 * r;
        if (rec.marker) rec.marker.visible = bodyDotsOn() && rec.visible;
      }
      if (sun.corona) {
        const r = bodyRadius('sun');
        sun.corona.scale.set(2.6 * 2 * r, 2.6 * 2 * r, 1);
      }
    }

    // Pluto can be switched from the settings popover or the Positions panel;
    // both switches, the scene, the orbit and the panel row follow one state.
    function setShowPluto(on) {
      state.showPluto = !!on;
      if (dom.optPluto) dom.optPluto.checked = state.showPluto;
      if (dom.optPlutoPanel) dom.optPlutoPanel.checked = state.showPluto;
      if (rowByName.pluto) rowByName.pluto.hidden = !state.showPluto;
      applyBodyVisibility();
      applyOrbitVisibility();
    }

    function applyBodyVisibility() {
      const plutoRec = bodies.pluto;
      const moonRec = bodies.moon;
      if (plutoRec) { plutoRec.visible = state.showPluto; plutoRec.group.visible = state.showPluto; }
      if (moonRec) { moonRec.visible = state.showMoon; moonRec.group.visible = state.showMoon; }
      if (rowByName.moon) rowByName.moon.hidden = !state.showMoon;
      if (orbits.pluto) orbits.pluto.line.visible = state.showOrbits && state.showPluto;
      for (const rec of bodyList) {
        if (rec.isMoon) continue;   // gated per frame in updateMoonSystems
        if (rec.marker) rec.marker.visible = bodyDotsOn() && rec.visible;
        if (rec.label) rec.label.classList.toggle('hidden', !rec.visible);
      }
      for (const sys of moonSystems) {
        sys.enabled = state.showPlanetMoons && sys.parent.visible && !sys.broken;
        if (!sys.enabled) hideMoonSystem(sys);
        for (const m of sys.moons) if (m.label) m.label.classList.toggle('hidden', !sys.enabled);
      }
      const followed = state.focus ? bodies[state.focus] : null;
      if (followed && !(followed.isMoon ? followed.system.enabled : followed.visible)) setFocus(null);
      syncInfoMoonRows();
    }

    // ---- Earth imagery ----------------------------------------------------------------
    //
    // Earth starts with the procedural textures like every other body so the first
    // frame never waits on the network; the NASA Blue Marble set shipped with the
    // three.js repository (public domain) is then streamed in once the loading overlay
    // is gone and swapped into the materials texture by texture. Any file that fails
    // to arrive leaves its procedural counterpart in place.

    const EARTH_TEXTURE_BASE = 'https://cdn.jsdelivr.net/gh/mrdoob/three.js@r170/examples/textures/planets/';
    const EARTH_TEXTURE_FILES = {
      map: 'earth_atmos_2048.jpg',
      normal: 'earth_normal_2048.jpg',
      specular: 'earth_specular_2048.jpg',
      lights: 'earth_lights_2048.png',
      clouds: 'earth_clouds_1024.png'
    };
    const earthImagery = { started: false, failed: false, loaded: 0 };

    function disposeTexture(tex, keep) {
      if (tex && tex !== keep && typeof tex.dispose === 'function') tex.dispose();
    }

    // Swaps one downloaded texture into Earth's materials; returns false for a key it
    // does not know. The replaced procedural texture is disposed.
    function applyEarthTexture(key, tex) {
      const rec = bodies.earth;
      if (!rec || !rec.material) return false;
      const material = rec.material;
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
      if (key === 'map') {
        tex.colorSpace = THREE.SRGBColorSpace;
        const old = material.map;
        material.map = tex;
        material.color.setHex(0xffffff);   // a map-less material carried the accent colour
        material.needsUpdate = true;
        disposeTexture(old, tex);
      } else if (key === 'normal') {
        const oldBump = material.bumpMap;
        material.normalMap = tex;
        // Y negated to match this asset's handedness, as the three.js examples do.
        material.normalScale.set(0.8, -0.8);
        material.bumpMap = null;
        material.needsUpdate = true;
        disposeTexture(oldBump, tex);
      } else if (key === 'specular') {
        const old = material.specularMap;
        material.specularMap = tex;
        material.needsUpdate = true;
        disposeTexture(old, tex);
      } else if (key === 'lights') {
        tex.colorSpace = THREE.SRGBColorSpace;
        const old = material.emissiveMap;
        material.emissiveMap = tex;
        if (!(material.emissiveIntensity > 0)) {   // visuals.js supplied no night lights
          material.emissive.setHex(0xffe2a8);
          material.emissiveIntensity = 0.9;
        }
        installEarthNightLights(material);
        material.needsUpdate = true;
        disposeTexture(old, tex);
      } else if (key === 'clouds') {
        tex.colorSpace = THREE.SRGBColorSpace;
        if (!rec.clouds) {
          attachEarthClouds(rec, tex);
        } else {
          const cloudMat = rec.clouds.material;
          const old = cloudMat.map;
          cloudMat.map = tex;
          cloudMat.transparent = true;
          cloudMat.needsUpdate = true;
          disposeTexture(old, tex);
        }
      } else {
        return false;
      }
      return true;
    }

    // Streams one body's image files and hands each to apply(key, texture) as it
    // arrives; apply returns false for a key it does not know. Failures are logged
    // once and leave the procedural textures in place.
    function streamImagery(label, imagery, base, files, apply) {
      if (imagery.started || typeof THREE.TextureLoader !== 'function') return;
      imagery.started = true;
      let loader;
      try {
        loader = new THREE.TextureLoader();
        loader.setCrossOrigin('anonymous');
      } catch (err) {
        console.info(label + ' imagery unavailable; keeping the procedural globe', err);
        return;
      }
      const fail = (key, err) => {
        if (imagery.failed) return;
        imagery.failed = true;
        console.info(label + ' imagery could not be fetched (' + key + '); the procedural textures stay where needed', err || '');
      };
      for (const key of Object.keys(files)) {
        try {
          loader.load(base + files[key], (tex) => {
            try {
              if (apply(key, tex)) imagery.loaded++; else disposeTexture(tex, null);
            } catch (err) {
              disposeTexture(tex, null);
              fail(key, err);
            }
          }, undefined, (err) => fail(key, err));
        } catch (err) {
          fail(key, err);
        }
      }
    }

    function loadEarthImagery() {
      if (!bodies.earth) return;
      streamImagery('Earth', earthImagery, EARTH_TEXTURE_BASE, EARTH_TEXTURE_FILES, applyEarthTexture);
    }

    // ---- Moon imagery -----------------------------------------------------------------
    //
    // The Moon gets the same treatment from NASA's CGI Moon Kit (Scientific
    // Visualization Studio, public domain): the LRO Camera colour mosaic, and the LOLA
    // elevation map as its bump map. NASA's server does not allow cross-origin texture
    // loads, so both files ship with the site. Like the Earth maps they are centred on
    // longitude 0, which orientMoon turns toward the mean sub-Earth point.

    const MOON_TEXTURE_BASE = 'textures/';
    const MOON_TEXTURE_FILES = {
      map: 'moon_lroc_2048.jpg',
      bump: 'moon_ldem_1024.jpg'
    };
    const moonImagery = { started: false, failed: false, loaded: 0 };

    function applyMoonTexture(key, tex) {
      const rec = bodies.moon;
      if (!rec || !rec.material) return false;
      const material = rec.material;
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
      if (key === 'map') {
        tex.colorSpace = THREE.SRGBColorSpace;
        const old = material.map;
        material.map = tex;
        material.color.setHex(0xffffff);   // a map-less material carried the accent colour
        material.needsUpdate = true;
        disposeTexture(old, tex);
      } else if (key === 'bump') {
        const old = material.bumpMap;
        material.bumpMap = tex;
        material.bumpScale = 0.02 * rec.radius;
        material.needsUpdate = true;
        disposeTexture(old, tex);
      } else {
        return false;
      }
      return true;
    }

    function loadMoonImagery() {
      if (!bodies.moon) return;
      streamImagery('Moon', moonImagery, MOON_TEXTURE_BASE, MOON_TEXTURE_FILES, applyMoonTexture);
    }

    // ---- Orbits ---------------------------------------------------------------------

    const orbits = {};   // name -> { line, geometry, jdSampled, period }
    const orbitGroup = new THREE.Group();
    orbitGroup.name = 'orbits';
    scene.add(orbitGroup);

    function buildOrbit(name) {
      const period = Eph.orbitalPeriodDays(name);
      const geometry = new THREE.BufferGeometry();
      const positions = new Float32Array(256 * 3);
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      const material = new THREE.LineBasicMaterial({ color: accentOf(name), transparent: true, opacity: 0.35, depthWrite: false });
      const line = new THREE.LineLoop(geometry, material);
      line.name = name + '-orbit';
      line.frustumCulled = false;
      orbitGroup.add(line);
      orbits[name] = { line, geometry, period, jdSampled: NaN };
    }

    const tmpV = new THREE.Vector3();

    function sampleOrbit(name, jd) {
      const o = orbits[name];
      const pos = o.geometry.attributes.position;
      const n = pos.count;
      const start = jd - o.period / 2;
      for (let i = 0; i < n; i++) {
        const t = start + (o.period * i) / n;
        const p = Eph.heliocentric(name, clamp(t, JD_MIN - 36525, JD_MAX + 36525));
        toScene(p, tmpV);
        pos.setXYZ(i, tmpV.x, tmpV.y, tmpV.z);
      }
      pos.needsUpdate = true;
      o.geometry.computeBoundingSphere();
      o.jdSampled = jd;
    }

    function updateOrbits(force) {
      for (const name of PLANETS) {
        const o = orbits[name];
        if (!o) continue;
        if (force || !(Math.abs(state.jd - o.jdSampled) <= o.period / 4)) sampleOrbit(name, state.jd);
      }
      updateMoonOrbit(force);
    }

    // Moon orbit: the locus of where the app places the Moon over one sidereal
    // month, attached to Earth's group so it travels with Earth. It fades in as
    // Earth is approached and is invisible from solar-system distances.
    const MOON_ORBIT_SAMPLES = 128;
    const moonOrbit = { line: null, geometry: null, jdSampled: NaN, period: 27.321662 };
    const moonSample = new THREE.Vector3();

    function buildMoonOrbit() {
      if (!bodies.earth || moonOrbit.line) return;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MOON_ORBIT_SAMPLES * 3), 3));
      const material = new THREE.LineBasicMaterial({ color: accentOf('moon'), transparent: true, opacity: 0, depthWrite: false });
      const line = new THREE.LineLoop(geometry, material);
      line.name = 'moon-orbit';
      line.frustumCulled = false;
      line.visible = false;
      bodies.earth.group.add(line);
      moonOrbit.line = line;
      moonOrbit.geometry = geometry;
      moonOrbit.jdSampled = NaN;
    }

    function sampleMoonOrbit(jd) {
      const pos = moonOrbit.geometry.attributes.position;
      const n = pos.count;
      const start = jd - moonOrbit.period / 2;
      const dist = moonSceneDistance();
      for (let i = 0; i < n; i++) {
        const t = start + (moonOrbit.period * i) / n;
        const m = Eph.moonGeocentric(clamp(t, JD_MIN - 36525, JD_MAX + 36525));
        moonSample.set(m.x, m.z, -m.y);
        const len = moonSample.length();
        if (len > 0) moonSample.multiplyScalar(dist / len);
        pos.setXYZ(i, moonSample.x, moonSample.y, moonSample.z);
      }
      pos.needsUpdate = true;
      moonOrbit.geometry.computeBoundingSphere();
      moonOrbit.jdSampled = jd;
    }

    function updateMoonOrbit(force) {
      if (!moonOrbit.line) buildMoonOrbit();
      if (!moonOrbit.line) return;
      if (force || !(Math.abs(state.jd - moonOrbit.jdSampled) <= moonOrbit.period / 4)) sampleMoonOrbit(state.jd);
    }

    // Invisible while the ring would be under ~12 px on screen, fully drawn above ~40 px.
    function updateMoonOrbitVisibility() {
      const line = moonOrbit.line;
      if (!line) return;
      const earth = bodies.earth;
      if (!(state.showOrbits && state.showMoon && earth && earth.screen.visible)) { line.visible = false; return; }
      const rE = bodyRadius('earth');
      const ringPx = rE > 0 ? earth.screen.r * (moonSceneDistance() / rE) : 0;
      const t = clamp((ringPx - 12) / 28, 0, 1);
      const opacity = 0.45 * t * t * (3 - 2 * t);
      line.material.opacity = opacity;
      line.visible = opacity > 0.01;
    }

    function applyOrbitVisibility() {
      for (const name of PLANETS) {
        const o = orbits[name];
        if (!o) continue;
        o.line.visible = state.showOrbits && (name !== 'pluto' || state.showPluto);
      }
    }

    // ---- Zodiac overlay ----------------------------------------------------------------
    //
    // Twelve 30-degree sectors radiating from Earth in the ecliptic plane: the
    // geocentric tropical zodiac. 0 deg Aries points at the mean equinox of date,
    // whose J2000 ecliptic longitude Ephemeris.equinoxLongitude gives (0 at J2000,
    // regressing about 1.4 deg per century). The disc comes from
    // OrreryVisuals.zodiacDisc with the sectors drawn in its fragment shader, so per
    // frame the app only moves it to Earth and sets the uAries uniform; the sign
    // labels are HTML like the body labels and are placed with them (see Labels).
    // Without zodiacDisc the markers, the labels and the panel figures still work.
    //
    // The view holds the distance mapping linear (the compressed mapping is radial
    // about the Sun and bends directions from Earth by up to about 14 deg, which
    // would draw planets in the wrong sector) and follows Earth from straight above.
    // The disc is 1200 units across and its rim is out of view for anything nearer
    // than Neptune, so the sign labels and a marker for each body sit on a wheel of
    // fixed screen size around Earth (zodiac.wheel, zodiac.ring): a drawn ring with
    // degree ticks, the sign labels just outside it, the marker dots on it at each
    // body's geocentric ecliptic longitude with their tags just inside, a ray from
    // Earth through the body to its dot, Earth at its centre. Zooming changes what
    // the wheel frames, never the wheel. (The Moon is drawn relative to Earth's size,
    // not on the AU scale, so its marker, not its globe, shows its sign.)

    // Disc radius in AU. The disc is centred on Earth, so Pluto's distance FROM EARTH
    // matters: it reaches 48.8 AU near aphelion (2110s). The shader fades the rim from
    // 0.82 of the radius, i.e. from 45 AU, so Pluto never leaves the lit part of the disc.
    const ZODIAC_RADIUS_AU = 55;
    const ZODIAC_MARKER_PX = 4;           // screen radius of a marker dot, for the tag placement
    // Bodies with a geocentric marker, in Positions-panel order (Earth is the centre).
    const ZODIAC_MARKER_BODIES = ['sun', 'moon', 'mercury', 'venus', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune', 'pluto'];
    const zodiac = {
      mesh: null, uniforms: null, radius: 0, equinoxDeg: 0, lastJd: NaN, labels: [], warned: false,
      ring: 0,      // rim radius for this frame's sign labels and markers (see updateZodiacRing)
      wheel: { cx: 0, cy: 0, px: 0 },   // the wheel's screen centre and radius (CSS px)
      ringLine: null, ticks: null,      // the drawn wheel: a LineLoop and 36 degree ticks
      rays: null,   // LineSegments, one segment per marker from Earth to the dot
      // Marker records carry the same label fields as the bodies (label, labelBox,
      // labelSlot, screen) so the label placement pass treats their tags alike.
      markers: ZODIAC_MARKER_BODIES.map((name) => ({
        name, sprite: null, shown: false, tropicalDeg: NaN, world: new THREE.Vector3(), label: null,
        labelBox: { w: 0, h: 0 }, labelSlot: { dir: 0, ring: 0 },
        screen: { x: 0, y: 0, r: 0, visible: false, inView: false, ux: 1, uy: 0 }
      }))
    };
    const hasEquinoxLongitude = typeof Eph.equinoxLongitude === 'function';
    const hasTropicalLongitude = typeof Eph.tropicalLongitude === 'function';

    // Sign names and glyphs in order, from visuals.js when it supplies a full table.
    const ZODIAC_SIGNS = (function () {
      const table = Vis && Array.isArray(Vis.ZODIAC) ? Vis.ZODIAC : null;
      const ok = !!table && table.length === 12
        && table.every((s) => s && typeof s.name === 'string' && typeof s.glyph === 'string');
      return ZODIAC.map((name, i) => ({ name: ok ? table[i].name : name, glyph: ok ? table[i].glyph : ZODIAC_GLYPHS[i] }));
    })();

    function warnZodiac(message, err) {
      if (zodiac.warned) return;
      zodiac.warned = true;
      if (err) console.warn(message, err); else console.warn(message);
    }

    function zodiacUniforms(mesh) {
      const u = mesh && mesh.material && mesh.material.uniforms;
      return u && u.uAries && u.uRadius ? u : null;
    }

    function disposeZodiacDisc() {
      const mesh = zodiac.mesh;
      if (!mesh) return;
      scene.remove(mesh);
      if (mesh.geometry) mesh.geometry.dispose();
      if (mesh.material) mesh.material.dispose();
      zodiac.mesh = null;
      zodiac.uniforms = null;
    }

    // (Re)builds the disc for the current distance mapping: at boot and whenever the
    // true-scale toggle changes mapDistance.
    function buildZodiacDisc() {
      disposeZodiacDisc();
      zodiac.radius = mapDistance(ZODIAC_RADIUS_AU);
      zodiac.ring = zodiac.radius;
      zodiac.lastJd = NaN;
      if (!Vis || typeof Vis.zodiacDisc !== 'function') {
        warnZodiac('OrreryVisuals.zodiacDisc is not available; the zodiac overlay shows sign labels only');
        return;
      }
      let mesh = null;
      try {
        mesh = Vis.zodiacDisc(zodiac.radius);
        if (!mesh || !zodiacUniforms(mesh)) throw new Error('zodiacDisc returned no Mesh with the uAries / uRadius uniforms');
      } catch (err) {
        if (mesh) {
          if (mesh.geometry) mesh.geometry.dispose();
          if (mesh.material) mesh.material.dispose();
        }
        warnZodiac('OrreryVisuals.zodiacDisc failed; the zodiac overlay shows sign labels only', err);
        return;
      }
      mesh.name = 'zodiac';
      mesh.renderOrder = -1;          // beneath the orbit lines and the belts
      mesh.frustumCulled = false;     // one draw call, and the camera is usually inside its bounds
      mesh.visible = state.zodiac;
      zodiac.mesh = mesh;
      zodiac.uniforms = zodiacUniforms(mesh);
      zodiac.uniforms.uRadius.value = zodiac.radius;
      scene.add(mesh);
      updateZodiac(state.jd);
    }

    // One sprite per marker body in the body's accent colour (sharing the body's
    // true-size marker texture where there is one) and one LineSegments of rays from
    // Earth to the dots, coloured per segment. Built once after the bodies: the
    // positions are refreshed every frame from zodiac.radius, so the true-scale
    // toggle needs no rebuild here. Independent of zodiacDisc.
    function buildZodiacMarkers() {
      const n = zodiac.markers.length;
      const rayPos = new Float32Array(n * 6);
      const rayCol = new Float32Array(n * 6);
      const color = new THREE.Color();
      for (let i = 0; i < n; i++) {
        const m = zodiac.markers[i];
        const rec = bodies[m.name];
        const accent = rec ? rec.accent : accentOf(m.name);
        const map = rec && rec.marker && rec.marker.material && rec.marker.material.map
          ? rec.marker.material.map : makeMarkerTexture(accent);
        const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
          map, sizeAttenuation: false, depthTest: false, depthWrite: false, transparent: true, opacity: 0.85
        }));
        sprite.scale.set(0.016, 0.016, 1);
        sprite.renderOrder = 6;             // above the bodies' own true-size markers (5)
        sprite.visible = false;
        sprite.name = 'zodiac-marker-' + m.name;
        scene.add(sprite);
        m.sprite = sprite;
        color.setHex(accent);
        for (let k = 0; k < 2; k++) {
          const o = i * 6 + k * 3;
          rayCol[o] = color.r; rayCol[o + 1] = color.g; rayCol[o + 2] = color.b;
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(rayPos, 3).setUsage(THREE.DynamicDrawUsage));
      geo.setAttribute('color', new THREE.BufferAttribute(rayCol, 3));
      const mat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.3, depthWrite: false });
      const rays = new THREE.LineSegments(geo, mat);
      rays.name = 'zodiacRays';
      rays.frustumCulled = false;   // the camera is usually inside its bounds
      rays.visible = false;         // shown by updateZodiacMarkers once it holds positions
      scene.add(rays);
      zodiac.rays = rays;
      buildZodiacWheel();
    }

    // The drawn wheel: a unit circle in the ecliptic plane and
    // 36 radial ticks every 10 deg from 0 deg Aries, longer at the sign boundaries;
    // both are moved to Earth and scaled to zodiac.ring each frame, the ticks turned
    // to the equinox of date. Hidden outside the view.
    function buildZodiacWheel() {
      const N = 180;
      const pos = new Float32Array(N * 3);
      for (let i = 0; i < N; i++) {
        const a = (i / N) * TWO_PI;
        pos[i * 3] = Math.cos(a); pos[i * 3 + 1] = 0; pos[i * 3 + 2] = -Math.sin(a);
      }
      const ringGeo = new THREE.BufferGeometry();
      ringGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const ringLine = new THREE.LineLoop(ringGeo, new THREE.LineBasicMaterial({ color: 0xd9c58a, transparent: true, opacity: 0.42, depthWrite: false }));
      ringLine.name = 'zodiacWheel';
      ringLine.frustumCulled = false;
      ringLine.renderOrder = 1;
      ringLine.visible = false;
      scene.add(ringLine);
      zodiac.ringLine = ringLine;

      const T = 36;
      const tp = new Float32Array(T * 6);
      for (let j = 0; j < T; j++) {
        const a = j * 10 * DEG;
        const len = j % 3 === 0 ? 1.045 : 1.022;
        const c = Math.cos(a), s = -Math.sin(a), o = j * 6;
        tp[o] = c; tp[o + 1] = 0; tp[o + 2] = s;
        tp[o + 3] = c * len; tp[o + 4] = 0; tp[o + 5] = s * len;
      }
      const tickGeo = new THREE.BufferGeometry();
      tickGeo.setAttribute('position', new THREE.BufferAttribute(tp, 3));
      const ticks = new THREE.LineSegments(tickGeo, new THREE.LineBasicMaterial({ color: 0xd9c58a, transparent: true, opacity: 0.55, depthWrite: false }));
      ticks.name = 'zodiacWheelTicks';
      ticks.frustumCulled = false;
      ticks.renderOrder = 1;
      ticks.visible = false;
      scene.add(ticks);
      zodiac.ticks = ticks;
    }

    // J2000 ecliptic longitude of 0 deg Aries (the mean equinox of date), degrees,
    // cached per jd. Without Ephemeris.equinoxLongitude the J2000 equinox stands in.
    function equinoxOfDate(jd) {
      if (jd === zodiac.lastJd) return zodiac.equinoxDeg;
      zodiac.lastJd = jd;
      zodiac.equinoxDeg = 0;
      if (hasEquinoxLongitude) {
        try {
          const e = Eph.equinoxLongitude(jd);
          if (Number.isFinite(e)) zodiac.equinoxDeg = e;
        } catch (err) {
          warnZodiac('Ephemeris.equinoxLongitude failed; zodiac signs are measured from the J2000 equinox', err);
        }
      }
      return zodiac.equinoxDeg;
    }

    // Tropical longitude in [0, 360) of a J2000 ecliptic longitude, degrees.
    function tropicalOf(lonJ2000, jd) {
      if (hasTropicalLongitude) return Eph.tropicalLongitude(lonJ2000, jd);
      return wrapLon(lonJ2000 - equinoxOfDate(jd));
    }

    function wrapLon(deg) {
      let l = deg % 360;
      if (l < 0) l += 360;
      return l;
    }

    // Per frame, after updateBodies: the disc follows Earth, 0 deg Aries follows the
    // equinox of date and the body markers follow the geocentric directions in
    // positions (the frame's positions object; omitted when called outside the frame
    // loop, and the next frame catches up). Allocation-free.
    function updateZodiac(jd, positions) {
      if (!state.zodiac) return;
      const eq = equinoxOfDate(jd);
      const earth = bodies.earth;
      if (!earth) return;
      const earthPos = earth.group.position;   // Earth's group is a direct child of the scene
      if (zodiac.mesh) {
        zodiac.mesh.position.copy(earthPos);
        zodiac.uniforms.uAries.value = eq * DEG;
      }
      updateZodiacRing(earthPos);
      if (zodiac.mesh) updateZodiacDiscFade(earthPos);
      if (zodiac.ringLine) {
        zodiac.ringLine.visible = true;
        zodiac.ticks.visible = true;
        zodiac.ringLine.position.copy(earthPos);
        zodiac.ringLine.scale.setScalar(zodiac.ring);
        zodiac.ticks.position.copy(earthPos);
        zodiac.ticks.scale.setScalar(zodiac.ring);
        zodiac.ticks.rotation.y = eq * DEG;   // local +x (0 deg Aries) to the equinox's J2000 longitude
      }
      if (positions) updateZodiacMarkers(positions, earthPos, eq);
    }

    // The wheel's radius in world units: what its fixed screen radius subtends at
    // Earth's depth, so the wheel holds its size on screen through any zoom
    // (updateZodiac runs after the camera update in the frame, so there is no lag).
    function updateZodiacRing(earthPos) {
      const h = renderer.domElement.clientHeight;
      const camDist = camera.position.distanceTo(earthPos);
      zodiac.ring = Math.max(1e-3, (zodiac.wheel.px / (h * 0.5)) * camDist * Math.tan(camera.fov * 0.5 * DEG));
    }

    // Inner fade and line strength of the disc (see WHEEL_DISC_INNER_PX): the fade
    // spans a few screen px at Earth's depth, so the sector lines run in to Earth's
    // dot at any zoom.
    function updateZodiacDiscFade(earthPos) {
      const u = zodiac.uniforms;
      if (!u.uInner || !u.uLineAlpha) return;   // older visuals.js
      const h = renderer.domElement.clientHeight;
      const camDist = camera.position.distanceTo(earthPos);
      u.uInner.value = Math.max(1e-4, (WHEEL_DISC_INNER_PX / (h * 0.5)) * camDist * Math.tan(camera.fov * 0.5 * DEG));
      u.uLineAlpha.value = WHEEL_LINE_ALPHA;
      if (u.uLineWidth) u.uLineWidth.value = WHEEL_LINE_CSS_PX * renderer.getPixelRatio();
    }

    // ---- Wheel layout ----
    //
    // The wheel's centre and radius in CSS px from the part of the viewport that
    // the fixed UI leaves free. Recomputed on resize, when the time controls change
    // height, when the Positions panel opens or closes and on entering the view.
    // wheelReady (declared with the state) guards calls made while the scene is
    // still being built.
    function updateWheelLayout() {
      if (!wheelReady) return;
      const w = renderer.domElement.clientWidth;
      const h = renderer.domElement.clientHeight;
      if (!w || !h) return;
      let top = 72, bottom = h, left = 0, right = w;   // 72: the top-right buttons
      if (dom.titleBlock) top = Math.max(top, dom.titleBlock.getBoundingClientRect().bottom + 10);
      if (controlsEl) bottom = Math.min(bottom, controlsEl.getBoundingClientRect().top - 8);
      const panelOpen = dom.infoPanel && !dom.infoPanel.classList.contains('collapsed');
      let pr = null;
      if (panelOpen) {
        pr = dom.infoPanel.getBoundingClientRect();
        if (pr.left >= w * 0.45) right = Math.min(right, pr.left - 12);        // beside the scene
        else if (pr.top >= h * 0.4) bottom = Math.min(bottom, pr.top - 8);    // narrow layout: below it
      }
      const radius = (l, r, t, b) => Math.min((r - l) * 0.5 - WHEEL_MARGIN_X, (b - t) * 0.5 - WHEEL_MARGIN_Y);
      let px = radius(left, right, top, bottom);
      if (px < WHEEL_MIN_PX && pr) {   // too cramped: let the panel overlap the wheel instead
        right = w;
        bottom = Math.min(h, controlsEl ? controlsEl.getBoundingClientRect().top - 8 : h);
        px = radius(left, right, top, bottom);
      }
      if (px < 60) { left = 0; right = w; top = 0; bottom = h; px = Math.max(60, radius(0, w, 0, h)); }
      zodiac.wheel.cx = (left + right) * 0.5;
      zodiac.wheel.cy = (top + bottom) * 0.5;
      zodiac.wheel.px = px;
      applyViewOffset();
      updateZoomRange();
    }

    // In the zodiac view the camera's frustum is shifted so that its target,
    // Earth, projects to the wheel's centre; projection, picking and labels follow.
    function applyViewOffset() {
      const w = renderer.domElement.clientWidth;
      const h = renderer.domElement.clientHeight;
      if (zodiacOn() && w && h && wheelReady) {
        camera.setViewOffset(w, h, w * 0.5 - zodiac.wheel.cx, h * 0.5 - zodiac.wheel.cy, w, h);
      } else if (camera.view && camera.view.enabled) {
        camera.clearViewOffset();
      }
    }

    // Camera offset from Earth, straight above it, that puts `au` AU from Earth on
    // the wheel's ring (linear mapping: the view holds distances linear).
    function zodiacPresetOffset(au, out) {
      const h = renderer.domElement.clientHeight;
      const px = Math.max(1, zodiac.wheel.px);
      const dist = (DISTANCE_SCALE * au) * (h * 0.5) / (px * Math.tan(camera.fov * 0.5 * DEG));
      const el = WHEEL_ELEVATION * DEG;
      return out.set(0, Math.sin(el) * dist, Math.cos(el) * dist);
    }

    // The orbit controls' zoom-out limit: in the zodiac view far enough for the
    // Full framing (a small wheel on a tall window needs a distant camera), else the
    // default. Called with the wheel layout and on leaving the view.
    const zoomRangeV = new THREE.Vector3();
    function updateZoomRange() {
      if (zodiacOn() && wheelReady) {
        const full = zodiacPresetOffset(ZODIAC_RING_AU.full, zoomRangeV).length();
        controls.maxDistance = clamp(full * 1.05, ZOOM_MAX_DEFAULT, ZOOM_MAX_WHEEL);
      } else {
        controls.maxDistance = ZOOM_MAX_DEFAULT;
      }
    }

    // Marker i sits on the wheel, Earth + ring along the body's
    // geocentric ecliptic longitude a (J2000; scene direction (cos a, 0, -sin a), the
    // same angle the disc shader sectors), and its ray runs from Earth to it. The
    // geocentric vectors come from the frame's heliocentric positions: Sun = -Earth,
    // Moon as given (already geocentric), planet - Earth; the latitude is dropped,
    // as the zodiac measures longitude along the ecliptic. A marker without data, or
    // Pluto's while Pluto is switched off, is hidden and its ray collapsed to a point.
    function updateZodiacMarkers(positions, earthPos, eq) {
      const b = positions.bodies;
      const e = b.earth;
      const r = zodiac.ring;
      const rayAttr = zodiac.rays ? zodiac.rays.geometry.attributes.position : null;
      const ray = rayAttr ? rayAttr.array : null;
      for (let i = 0; i < zodiac.markers.length; i++) {
        const m = zodiac.markers[i];
        let gx = 0, gy = 0, has = !!e;
        if (has) {
          if (m.name === 'sun') { gx = -e.x; gy = -e.y; }
          else if (m.name === 'moon') { const mo = b.moon; has = !!mo; if (has) { gx = mo.x; gy = mo.y; } }
          else { const p = b[m.name]; has = !!p; if (has) { gx = p.x - e.x; gy = p.y - e.y; } }
        }
        const shown = has && (m.name !== 'pluto' || state.showPluto);
        m.shown = shown;
        let rayR = r, ca = 1, sa = 0;
        if (shown) {
          const a = Math.atan2(gy, gx);
          ca = Math.cos(a); sa = Math.sin(a);
          m.tropicalDeg = wrapLon(a / DEG - eq);
          m.world.set(earthPos.x + r * ca, earthPos.y, earthPos.z - r * sa);
          if (m.sprite) m.sprite.position.copy(m.world);
          // The scene is at linear scale, so the drawn direction from Earth is the true
          // one and the ray runs on past the marker to the body itself when the body
          // lies beyond the wheel (not for the Moon, drawn relative to Earth's size).
          if (m.name !== 'moon') rayR = Math.max(r, mapDistance(Math.hypot(gx, gy)));
        } else {
          m.tropicalDeg = NaN;
        }
        if (m.sprite) m.sprite.visible = shown;
        if (ray) {
          const o = i * 6;
          ray[o] = earthPos.x; ray[o + 1] = earthPos.y; ray[o + 2] = earthPos.z;
          if (shown) { ray[o + 3] = earthPos.x + rayR * ca; ray[o + 4] = earthPos.y; ray[o + 5] = earthPos.z - rayR * sa; }
          else { ray[o + 3] = earthPos.x; ray[o + 4] = earthPos.y; ray[o + 5] = earthPos.z; }
        }
      }
      if (rayAttr) {
        rayAttr.needsUpdate = true;
        zodiac.rays.visible = true;
      }
    }

    // Zodiac can be switched from the settings popover, the Positions panel header
    // or the Z key; both switches, the disc, the labels and the panel follow one state.
    // Turning it on holds the distance mapping linear and enters the view (Earth
    // followed from above); turning it off returns the mapping to the true-scale
    // setting and keeps the camera where it is.
    function setZodiac(on) {
      const wasLinear = linearDistances();
      state.zodiac = !!on;
      syncZodiacUI();
      if (zodiac.mesh) zodiac.mesh.visible = state.zodiac;
      if (!state.zodiac) {
        for (const z of zodiac.labels) z.label.style.display = 'none';
        for (const m of zodiac.markers) {
          m.shown = false;
          if (m.sprite) m.sprite.visible = false;
          if (m.label) m.label.style.display = 'none';
        }
        if (zodiac.rays) zodiac.rays.visible = false;   // shown again by the next frame's marker update
        if (zodiac.ringLine) { zodiac.ringLine.visible = false; zodiac.ticks.visible = false; }
      }
      if (linearDistances() !== wasLinear) applyDistanceMapping(false);
      applyViewOffset();
      updateZoomRange();
      if (state.zodiac) enterZodiacView();
      zodiac.lastJd = NaN;
      updateZodiac(state.jd);
      state.lastInfoUpdate = 0;   // the panel swaps heliocentric and geocentric figures at once
    }

    // Both zodiac switches and the badge mirror the state.
    function syncZodiacUI() {
      if (dom.optZodiac) dom.optZodiac.checked = state.zodiac;
      if (dom.optZodiacPanel) dom.optZodiacPanel.checked = state.zodiac;
      if (dom.zodiacBadge) dom.zodiacBadge.hidden = !state.zodiac;
    }

    // Follow Earth from straight above, with Saturn's distance on the wheel's ring.
    function enterZodiacView() {
      updateWheelLayout();
      setFocus('earth', zodiacPresetOffset(ZODIAC_RING_AU.default, new THREE.Vector3()), 1100);
    }

    // ---- Moon systems -------------------------------------------------------------------
    //
    // The major moons of Mars, Jupiter, Saturn, Uranus, Neptune and Pluto live in a
    // "system" group under their planet's unrotated group, so their positions and
    // orbit lines are parent-centric and travel with the planet. Like Earth's Moon
    // they are placed relative to the parent's drawn radius rather than the AU scale.
    // A system fades in as the parent's apparent radius crosses the MOON_GATE range;
    // below it the meshes, orbit lines and labels are all hidden and nothing but the
    // (cheap) positions is updated.

    const moonSystems = [];             // [{ planet, parent, group, moons, t, enabled, broken }]
    const moonLocal = new THREE.Vector3();
    const moonPosOut = { x: 0, y: 0, z: 0, r: 0 };   // reused by Moons.position each frame

    // Scene distance of a planet moon from its parent's centre for a parent-centric
    // distance in km: the true ratio to the parent's radius in true-size mode,
    // otherwise a compressed mapping that keeps the innermost moons clear of the
    // globe (and of Saturn's rings) while the outermost stay within reach.
    function moonSceneDistanceFor(rec, rKm) {
      const rParent = bodyRadius(rec.parent);
      const ratio = rKm / rec.parentRadiusKm;
      if (state.trueSize) return rParent * ratio;
      return rParent * (1.3 + 0.9 * Math.sqrt(ratio));
    }

    function buildMoonSystem(planet) {
      const parent = bodies[planet];
      if (!parent) return null;
      const group = new THREE.Group();
      group.name = planet + '-system';
      group.visible = false;
      parent.group.add(group);
      const sys = { planet, parent, group, moons: [], t: 0, enabled: true, broken: false };
      moonSystems.push(sys);
      return sys;
    }

    function buildMoonOrbitLine(rec, sys) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MOON_ORBIT_SAMPLES * 3), 3));
      const material = new THREE.LineBasicMaterial({ color: rec.accent, transparent: true, opacity: 0, depthWrite: false });
      const line = new THREE.LineLoop(geometry, material);
      line.name = rec.name + '-orbit';
      line.frustumCulled = false;
      line.visible = false;
      sys.group.add(line);
      rec.orbit = { line, geometry, material, jdSampled: NaN, period: moonData[rec.name].periodDays, failed: false };
    }

    function buildMoon(sys, name, tex) {
      const rec = buildBody(name, tex, { moonOf: sys.planet, container: sys.group });
      rec.system = sys;
      rec.visible = false;
      rec.labelOn = false;
      buildMoonOrbitLine(rec, sys);
      sys.moons.push(rec);
      return rec;
    }

    // Locus of where the app places the moon over one orbit, with the same radial
    // mapping as the moon itself, in the parent's local frame.
    function sampleMoonSystemOrbit(rec, jd) {
      const o = rec.orbit;
      let pts = null;
      try {
        pts = Moons.orbitPoints(rec.name, jd, MOON_ORBIT_SAMPLES);
      } catch (err) {
        console.warn('Moons.orbitPoints(' + rec.name + ') failed', err);
        pts = null;
      }
      o.jdSampled = jd;   // on failure this also spaces the retries a quarter period apart
      if (!pts || !pts.length) { o.failed = true; return; }
      const pos = o.geometry.attributes.position;
      const n = Math.min(pos.count, pts.length);
      for (let i = 0; i < n; i++) {
        const p = pts[i];
        moonLocal.set(p.x, p.z, -p.y);
        const len = moonLocal.length();
        if (len > 0) moonLocal.multiplyScalar(moonSceneDistanceFor(rec, len * AU_KM) / len);
        pos.setXYZ(i, moonLocal.x, moonLocal.y, moonLocal.z);
      }
      o.geometry.setDrawRange(0, n);
      pos.needsUpdate = true;
      o.failed = false;
    }

    // Marks every planet-moon orbit stale; visible ones are resampled on the next frame.
    function invalidateMoonOrbits() {
      for (const sys of moonSystems) for (const m of sys.moons) if (m.orbit) m.orbit.jdSampled = NaN;
    }

    function hideMoonSystem(sys) {
      sys.t = 0;
      sys.group.visible = false;
      for (const m of sys.moons) {
        m.visible = false;
        m.screen.visible = false;
        m.labelOn = false;
        if (m.marker) m.marker.visible = false;
        if (m.orbit) m.orbit.line.visible = false;
      }
    }

    // Parent-centric placement of every planet moon; called from updateBodies once the
    // planets have moved. Positions are kept current even while a system is hidden so
    // a followed moon never jumps when its system fades back in.
    function updateMoonPositions(jd) {
      for (const sys of moonSystems) {
        if (sys.broken) continue;
        try {
          for (const m of sys.moons) {
            // moons.js fills the optional out object; an implementation that ignores
            // it simply returns a fresh one, which is used the same way.
            const p = Moons.position(m.name, jd, moonPosOut) || moonPosOut;
            moonLocal.set(p.x, p.z, -p.y);
            const len = moonLocal.length();
            m.distKm = (p.r > 0 ? p.r : len) * AU_KM;   // shown in the info panel
            if (len > 0) moonLocal.multiplyScalar(moonSceneDistanceFor(m, len * AU_KM) / len);
            m.group.position.copy(moonLocal);
            m.spin.rotation.y = spinAngle(m.name, jd) * m.spinSign;
          }
        } catch (err) {
          sys.broken = true;
          sys.enabled = false;
          console.warn('Moons.position failed for the ' + DISPLAY_NAME[sys.planet] + ' system; hiding it', err);
          hideMoonSystem(sys);
          // Same rule as applyBodyVisibility: a followed moon of a hidden system is
          // released, and the info panel drops the system's sub-rows.
          const followed = state.focus ? bodies[state.focus] : null;
          if (followed && followed.isMoon && followed.system === sys) setFocus(null);
          syncInfoMoonRows();
        }
      }
    }

    // Zoom gate, run after updateScreenPositions so the parent's apparent radius is
    // current: meshes above t = 0.02, orbit lines fading with t, labels above t = 0.5.
    // The system holding the followed moon is always fully revealed: from true-size
    // Iapetus, Saturn subtends under 18 px, which would otherwise hide the followed body.
    function updateMoonSystems() {
      const followed = state.focus ? bodies[state.focus] : null;
      const followedSys = followed && followed.isMoon ? followed.system : null;
      for (const sys of moonSystems) {
        if (!sys.enabled) continue;   // hidden by applyBodyVisibility
        const t = sys === followedSys ? 1 : smoothstep01(MOON_GATE_LO_PX, MOON_GATE_HI_PX, sys.parent.screen.r);
        if (t <= 0.02) {
          if (sys.group.visible) hideMoonSystem(sys);
          continue;
        }
        sys.t = t;
        sys.group.visible = true;
        const labelsOn = t > 0.5;
        const orbitsOn = state.showOrbits;
        const orbitOpacity = 0.4 * t;
        for (const m of sys.moons) {
          m.visible = true;
          m.screen.visible = m.screen.inView;
          m.labelOn = labelsOn;
          if (m.marker) m.marker.visible = bodyDotsOn();
          const o = m.orbit;
          if (!o) continue;
          if (orbitsOn && !(Math.abs(state.jd - o.jdSampled) <= o.period / 4)) sampleMoonSystemOrbit(m, state.jd);
          o.material.opacity = orbitOpacity;
          o.line.visible = orbitsOn && !o.failed;
        }
      }
    }

    // ---- Positions (Keplerian, exact, anchored) ------------------------------------------

    function blendBody(exact, kepNow, kepAnchor) {
      const x = exact.x + (kepNow.x - kepAnchor.x);
      const y = exact.y + (kepNow.y - kepAnchor.y);
      const z = exact.z + (kepNow.z - kepAnchor.z);
      const r = Math.sqrt(x * x + y * y + z * z);
      let lon = Math.atan2(y, x) / DEG;
      if (lon < 0) lon += 360;
      const lat = r > 0 ? Math.asin(z / r) / DEG : 0;
      return { x, y, z, lon, lat, r };
    }

    // Returns { bodies, source } where source is 'exact', 'anchored' or 'keplerian'.
    function computePositions(jd) {
      const kep = Eph.all(jd);
      if (precision.exact && precision.kepAnchor) {
        const dj = Math.abs(jd - precision.exact.jd);
        if (dj <= EXACT_TOLERANCE) return { bodies: precision.exact.bodies, source: 'exact' };
        if (dj <= ANCHOR_WINDOW_DAYS) {
          const out = {};
          for (const name of INFO_BODIES) {
            const e = precision.exact.bodies[name];
            const k = kep[name];
            const a = precision.kepAnchor[name];
            out[name] = (e && k && a) ? blendBody(e, k, a) : k;
          }
          return { bodies: out, source: 'anchored' };
        }
      }
      return { bodies: kep, source: 'keplerian' };
    }

    // ---- Precision mode (backend) ---------------------------------------------------

    function cacheKey(jd) { return Math.round(jd * 1e6); }

    function cacheStore(key, data) {
      if (precision.cache.size >= CACHE_MAX) {
        const oldest = precision.cache.keys().next().value;
        precision.cache.delete(oldest);
      }
      precision.cache.set(key, data);
    }

    function disablePrecision(reason) {
      if (precision.enabled) console.warn('Precision mode disabled: ' + reason);
      precision.enabled = false;
      precision.exact = null;
      precision.kepAnchor = null;
    }

    async function fetchExact(jd) {
      // Wait for the /api/range probe so a static host gets a single 404, not two.
      if (!precision.enabled || !precision.checked) return null;
      const key = cacheKey(jd);
      if (precision.cache.has(key)) return precision.cache.get(key);
      let res;
      try {
        res = await fetch('api/positions?jd=' + encodeURIComponent(jd.toFixed(8)), { cache: 'no-store' });
      } catch (err) {
        disablePrecision('backend unreachable (' + (err && err.message ? err.message : err) + ')');
        return null;
      }
      if (res.status === 400) {
        return null;   // out of range or rejected input; keep precision mode alive
      }
      if (!res.ok) {
        disablePrecision('HTTP ' + res.status);
        return null;
      }
      let data;
      try {
        data = await res.json();
      } catch (err) {
        disablePrecision('non-JSON response');
        return null;
      }
      if (!data || typeof data.jd !== 'number' || !data.bodies) {
        disablePrecision('unexpected response shape');
        return null;
      }
      cacheStore(key, data);
      return data;
    }

    function requestExact() {
      const jdReq = state.jd;
      precision.inflight = true;
      precision.lastFetchAt = performance.now();
      precision.lastRequestedJd = jdReq;
      fetchExact(jdReq).then((data) => {
        precision.inflight = false;
        if (!data) return;
        const dj = Math.abs(data.jd - state.jd);
        const slow = state.playing && SPEEDS[state.speedIndex].daysPerSec <= 1;
        if (dj <= EXACT_TOLERANCE || (slow && dj <= ANCHOR_WINDOW_DAYS)) {
          precision.exact = { jd: data.jd, bodies: Object.assign({}, Eph.all(data.jd), data.bodies) };
          precision.kepAnchor = Eph.all(data.jd);
          precision.ephemeris = data.ephemeris || precision.ephemeris;
        }
      }, () => { precision.inflight = false; });
    }

    function maintainPrecision(now) {
      // Nothing is requested until the /api/range probe has answered; otherwise
      // the paused path would record the date as requested and never retry it.
      if (!precision.enabled || !precision.checked || precision.inflight) return;
      const dps = SPEEDS[state.speedIndex].daysPerSec;
      const slow = !state.playing || dps <= 1;
      if (!slow) return;
      if (precision.exact && Math.abs(state.jd - precision.exact.jd) <= EXACT_TOLERANCE) return;
      if (!state.playing) {
        if (now - state.lastJdChangeAt < FETCH_DEBOUNCE_MS) return;
        if (precision.lastRequestedJd === state.jd) return;
        requestExact();
      } else if (now - precision.lastFetchAt >= FETCH_THROTTLE_MS) {
        requestExact();
      }
    }

    // A 404 means static hosting (no backend): give up at once. Anything else
    // (server restarting, kernel still loading) is retried a few times before
    // precision mode is switched off for the session.
    async function probeBackend(attempt) {
      if (!precision.enabled) return;
      attempt = attempt || 0;
      try {
        const res = await fetch('api/range', { cache: 'no-store' });
        if (res.status === 404) { disablePrecision('no /api/range (HTTP 404)'); return; }
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        if (data && data.ephemeris) precision.ephemeris = data.ephemeris;
        precision.checked = true;
      } catch (err) {
        if (attempt < 3 && location.protocol !== 'file:') {
          setTimeout(() => probeBackend(attempt + 1), 1500 * (attempt + 1));
          return;
        }
        disablePrecision('backend unreachable (' + (err && err.message ? err.message : err) + ')');
      }
    }

    // ---- Time engine ------------------------------------------------------------

    function setJd(jd, options) {
      const opts = options || {};
      const clamped = clamp(jd, JD_MIN, JD_MAX);
      if (clamped !== state.jd) {
        state.jd = clamped;
        state.lastJdChangeAt = performance.now();
      }
      if (clamped !== jd && state.playing && !opts.keepPlaying) setPlaying(false);
      if (!opts.silent) syncTimeInputs(true);
    }

    function setPlaying(playing) {
      state.playing = !!playing;
      dom.btnPlay.setAttribute('aria-pressed', state.playing ? 'true' : 'false');
      dom.btnPlay.setAttribute('aria-label', state.playing ? 'Pause' : 'Play');
      dom.iconPlay.style.display = state.playing ? 'none' : '';
      dom.iconPause.style.display = state.playing ? '' : 'none';
    }

    function setSpeed(index) {
      state.speedIndex = clamp(index, 0, SPEEDS.length - 1);
      dom.speedSelect.value = String(state.speedIndex);
    }

    function setDirection(direction) {
      state.direction = direction < 0 ? -1 : 1;
      dom.btnReverse.setAttribute('aria-pressed', state.direction < 0 ? 'true' : 'false');
    }

    function advanceTime(dt) {
      if (!state.playing) return;
      const dps = SPEEDS[state.speedIndex].daysPerSec;
      const next = state.jd + state.direction * dps * dt;
      if (next <= JD_MIN || next >= JD_MAX) {
        state.jd = clamp(next, JD_MIN, JD_MAX);
        state.lastJdChangeAt = performance.now();
        setPlaying(false);
      } else {
        state.jd = next;
        state.lastJdChangeAt = performance.now();
      }
    }

    function stepDays(n) { setJd(state.jd + n); }

    // Month and year steps, like day steps, work on the UT calendar whatever zone the
    // headline shows.
    function stepMonths(n) {
      const c = Eph.civilFromJd(state.jd);
      let m = c.month - 1 + n;
      const y = c.year + Math.floor(m / 12);
      m = ((m % 12) + 12) % 12 + 1;
      const d = Math.min(c.day, daysInMonth(y, m));
      setJd(Eph.jdFromCivil(y, m, d, c.hour, c.minute, c.second));
    }

    function stepYears(n) {
      const c = Eph.civilFromJd(state.jd);
      const y = c.year + n;
      const d = Math.min(c.day, daysInMonth(y, c.month));
      setJd(Eph.jdFromCivil(y, c.month, d, c.hour, c.minute, c.second));
    }

    function goToNow() {
      setJd(Eph.jdFromDate(new Date()));
    }

    // ---- Time zone --------------------------------------------------------------
    //
    // The clock is a UT Julian Date; the headline and the date form present it as
    // civil time in state.timeZone, an IANA zone name the picker chooses and
    // localStorage remembers. Without timezone.js (or with a zone the browser does
    // not know) everything falls back to UT, exactly as before the picker existed.

    function zonesAvailable() {
      return !!(TZ && typeof TZ.civil === 'function' && typeof TZ.jd === 'function' && typeof TZ.isValid === 'function');
    }

    // The saved zone when there is a valid one, else the browser's own zone.
    function loadTimeZone() {
      if (!zonesAvailable()) return 'UTC';
      let saved = null;
      try {
        saved = window.localStorage.getItem(TZ_STORAGE_KEY);
      } catch (err) {
        saved = null;          // storage blocked (private mode, sandbox): start from the browser zone
      }
      return saved && TZ.isValid(saved) ? saved : TZ.browserZone();
    }

    function saveTimeZone(zone) {
      try {
        window.localStorage.setItem(TZ_STORAGE_KEY, zone);
      } catch (err) {
        // Storage blocked or full: the choice still holds for this page.
      }
    }

    // Civil time of a UT instant in the chosen zone: {year, month, day, hour, minute,
    // second, weekday, offsetSeconds, abbreviation}, with astronomical years.
    function zonedCivil(jd) {
      if (zonesAvailable()) return TZ.civil(state.timeZone, jd);
      const c = Eph.civilFromJd(jd);
      c.weekday = weekdayIndex(jd);
      c.offsetSeconds = 0;
      c.abbreviation = 'UTC';
      return c;
    }

    // UT Julian Date of a civil time in the chosen zone. TimeZones.jd documents how a
    // skipped or repeated hour at a daylight-saving change is resolved.
    function zonedJd(year, month, day, hour, minute, second) {
      const s = second || 0;
      if (zonesAvailable()) {
        const jd = TZ.jd(state.timeZone, year, month, day, hour, minute, s);
        if (Number.isFinite(jd)) return jd;
      }
      return Eph.jdFromCivil(year, month, day, hour, minute, s);
    }

    // Option text: 'America/New York (UTC-04:00)', the offset taken at the clock's
    // current instant.
    function timeZoneOptionText(zone) {
      return TZ.label(zone, state.jd).replace(/_/g, ' ');
    }

    // Fills the picker: UTC, then the browser's zone, then every zone the browser
    // knows grouped by IANA region. Hidden, with the old static 'UTC' label shown in
    // its place, when timezone.js is unavailable.
    function buildTimeZoneSelect() {
      if (!dom.tzSelect) return;
      if (!zonesAvailable()) {
        dom.tzSelect.hidden = true;
        if (dom.tzFallback) dom.tzFallback.hidden = false;
        return;
      }
      dom.tzSelect.textContent = '';
      const addOption = (parent, zone) => {
        const opt = document.createElement('option');
        opt.value = zone;
        opt.textContent = timeZoneOptionText(zone);
        parent.appendChild(opt);
      };
      const zones = TZ.list();
      const local = TZ.browserZone();
      addOption(dom.tzSelect, 'UTC');
      if (local !== 'UTC') addOption(dom.tzSelect, local);
      // A saved zone the list lacks (another browser knew it) still gets an entry.
      if (state.timeZone !== 'UTC' && state.timeZone !== local && zones.indexOf(state.timeZone) < 0) addOption(dom.tzSelect, state.timeZone);
      const byRegion = new Map();
      zones.forEach((zone) => {
        if (zone === 'UTC') return;
        const region = TZ.region(zone);
        if (!byRegion.has(region)) byRegion.set(region, []);
        byRegion.get(region).push(zone);
      });
      TZ.REGIONS.forEach((region) => {
        const members = byRegion.get(region);
        if (!members) return;
        const group = document.createElement('optgroup');
        group.label = region;
        members.forEach((zone) => addOption(group, zone));
        dom.tzSelect.appendChild(group);
      });
      dom.tzSelect.value = state.timeZone;
    }

    // Rewrites the offsets in the option labels for the clock's current instant. A
    // few milliseconds for the whole list, so it runs on a zone change, not per frame.
    function refreshTimeZoneLabels() {
      if (!dom.tzSelect || !zonesAvailable()) return;
      Array.prototype.forEach.call(dom.tzSelect.options, (opt) => {
        opt.textContent = timeZoneOptionText(opt.value);
      });
    }

    function setTimeZone(zone) {
      if (!zonesAvailable() || !TZ.isValid(zone)) return;
      state.timeZone = zone;
      saveTimeZone(zone);
      if (dom.tzSelect && dom.tzSelect.value !== zone) dom.tzSelect.value = zone;
      refreshTimeZoneLabels();
      updateYearBounds();
      syncTimeInputs(true);
      updateDateHeadline();
    }

    // ---- Date display and inputs ------------------------------------------------

    function updateDateHeadline() {
      const c = zonedCivil(state.jd);
      const dayText = WEEKDAYS[c.weekday] + ', ' + c.day + ' ' + MONTHS[c.month - 1] + ' ';
      if (c.year <= 0) {
        dom.dateHeadline.textContent = '';
        dom.dateHeadline.appendChild(document.createTextNode(dayText + (1 - c.year) + ' '));
        const era = document.createElement('span');
        era.className = 'era';
        era.textContent = 'BCE';
        dom.dateHeadline.appendChild(era);
      } else {
        dom.dateHeadline.textContent = dayText + c.year;
      }
      // Clock time in the chosen zone with its short name ('11:59 EDT', '15:59 UTC');
      // the Julian Date that follows is always UT.
      const time = pad2(c.hour) + ':' + pad2(c.minute) + ' ' + c.abbreviation;
      dom.dateSubline.textContent = '';
      const parts = [time, 'JD ' + state.jd.toFixed(3), 'proleptic Gregorian'];
      parts.forEach((text, i) => {
        if (i > 0) {
          const sep = document.createElement('span');
          sep.className = 'sep';
          sep.textContent = '·';
          dom.dateSubline.appendChild(sep);
        }
        dom.dateSubline.appendChild(document.createTextNode(text));
      });
    }

    function fieldsFocused() {
      const a = document.activeElement;
      return a && dom.dateForm.contains(a);
    }

    // The year field's native min and max, taken in the chosen zone: at the clamped
    // ends of the clock range the zoned year is -3001 west of Greenwich and 3001 east
    // of it, and a synced value outside the bounds would make the browser block Apply.
    function updateYearBounds() {
      dom.inYear.min = String(zonedCivil(JD_MIN).year);
      dom.inYear.max = String(zonedCivil(JD_MAX).year);
    }

    function updateEraHint() {
      const y = parseInt(dom.inYear.value, 10);
      if (Number.isNaN(y)) { dom.eraHint.textContent = ''; return; }
      dom.eraHint.textContent = y <= 0 ? '= ' + (1 - y) + ' BCE' : 'CE';
    }

    function syncTimeInputs(force) {
      if (!force && fieldsFocused()) return;
      const c = zonedCivil(state.jd);
      dom.inYear.value = String(c.year);
      dom.inMonth.value = String(c.month);
      dom.inDay.value = String(c.day);
      dom.inHour.value = String(c.hour);
      dom.inMinute.value = String(c.minute);
      updateEraHint();
      if (c.year >= 1 && c.year <= 9999) {
        const yearText = ('0000' + c.year).slice(-4);
        dom.inDatetime.value = yearText + '-' + pad2(c.month) + '-' + pad2(c.day) + 'T' + pad2(c.hour) + ':' + pad2(c.minute);
      } else {
        dom.inDatetime.value = '';
      }
      if (!state.fineScrub) dom.timeline.value = String(state.jd);
      updateTimelineMarker();
    }

    function applyDateFields() {
      const y = parseInt(dom.inYear.value, 10);
      const mo = parseInt(dom.inMonth.value, 10);
      let d = parseInt(dom.inDay.value, 10);
      let h = parseInt(dom.inHour.value, 10);
      let mi = parseInt(dom.inMinute.value, 10);
      if ([y, mo].some(Number.isNaN)) return;
      if (Number.isNaN(d)) d = 1;
      if (Number.isNaN(h)) h = 0;
      if (Number.isNaN(mi)) mi = 0;
      d = clamp(d, 1, daysInMonth(y, mo));
      h = clamp(h, 0, 23);
      mi = clamp(mi, 0, 59);
      setPlaying(false);
      setJd(zonedJd(y, mo, d, h, mi, 0));
      syncTimeInputs(true);
    }

    function applyDatetimeLocal() {
      const v = dom.inDatetime.value;
      if (!v) return;
      const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(v);
      if (!m) return;
      setPlaying(false);
      setJd(zonedJd(+m[1], +m[2], +m[3], +m[4], +m[5], 0));
      syncTimeInputs(true);
    }

    // ---- Timeline -----------------------------------------------------------------

    function buildTimeline() {
      dom.timeline.min = String(JD_MIN);
      dom.timeline.max = String(JD_MAX);
      dom.timeline.step = 'any';
      dom.timeline.value = String(state.jd);
      dom.timelineTicks.textContent = '';
      for (let year = -3000; year <= 3000; year += 1000) {
        const jd = clamp(Eph.jdFromCivil(year, 1, 1), JD_MIN, JD_MAX);
        const pct = ((jd - JD_MIN) / (JD_MAX - JD_MIN)) * 100;
        const tick = document.createElement('span');
        tick.className = 'tick';
        tick.style.left = pct + '%';
        tick.textContent = formatYear(year);
        dom.timelineTicks.appendChild(tick);
      }
    }

    function updateTimelineMarker() {
      const min = parseFloat(dom.timeline.min);
      const max = parseFloat(dom.timeline.max);
      const frac = clamp((state.jd - min) / (max - min), 0, 1);
      // Track has 8px of thumb inset on each side.
      dom.timelineMarker.style.left = 'calc(8px + (100% - 16px) * ' + frac.toFixed(5) + ')';
    }

    function beginFineScrub(clientX) {
      if (state.fineScrub) return;
      state.fineScrub = true;
      // Map the pointer's current track position to the current jd so pressing does not
      // jump in time; dragging then scrubs up to a year either side.
      const rect = dom.timeline.getBoundingClientRect();
      const frac = clamp((clientX - rect.left - 8) / Math.max(1, rect.width - 16), 0, 1);
      let min = state.jd - 730.5 * frac;
      let max = min + 730.5;
      if (min < JD_MIN) { min = JD_MIN; max = min + 730.5; }
      if (max > JD_MAX) { max = JD_MAX; min = max - 730.5; }
      dom.timeline.min = String(min);
      dom.timeline.max = String(max);
      dom.timeline.value = String(state.jd);
      dom.timeline.classList.add('fine');
      dom.timelineHint.classList.add('active');
      dom.timelineHint.textContent = 'Fine scrub: one year either side';
    }

    function endFineScrub() {
      if (!state.fineScrub) return;
      state.fineScrub = false;
      dom.timeline.min = String(JD_MIN);
      dom.timeline.max = String(JD_MAX);
      dom.timeline.value = String(state.jd);
      dom.timeline.classList.remove('fine');
      dom.timelineHint.classList.remove('active');
      dom.timelineHint.textContent = '';
      const kbd = document.createElement('span');
      kbd.className = 'kbd';
      kbd.textContent = 'Shift';
      dom.timelineHint.appendChild(kbd);
      dom.timelineHint.appendChild(document.createTextNode(' + drag: fine scrub'));
      updateTimelineMarker();
    }

    // ---- Labels -------------------------------------------------------------------
    //
    // Labels are placed each frame by a small collision-avoidance pass. Every body
    // has eight candidate directions and three distance rings; bodies are placed in
    // priority order (the followed body, then larger apparent discs first), each
    // taking the first slot that clears the labels already placed, every visible
    // disc, and the viewport edge. A label keeps its previous slot while that slot
    // stays free so labels do not hop between frames.

    // Screen-space unit directions (y down), in order of preference.
    const LABEL_DIRS = [[1, -1], [1, 1], [-1, -1], [-1, 1], [1, 0], [-1, 0], [0, -1], [0, 1]];
    const LABEL_RINGS = [2, 9, 18];    // px between the disc edge and the label, per ring
    const LABEL_MARGIN = 3;            // px of clearance between label boxes
    const labelViewport = { w: 0, h: 0 };

    function buildLabels() {
      dom.labels.textContent = '';
      labelViewport.w = 0; labelViewport.h = 0;
      for (const rec of bodyList) {
        const el = document.createElement('div');
        el.className = rec.isMoon ? 'label minor' : 'label';
        el.style.setProperty('--label-color', hexColor(rec.accent));
        el.textContent = DISPLAY_NAME[rec.name];
        el.style.display = 'none';
        el.addEventListener('click', (ev) => { ev.stopPropagation(); setFocus(rec.name === 'sun' ? null : rec.name); });
        dom.labels.appendChild(el);
        rec.label = el;
        rec.labelBox = { w: 0, h: 0 };
        rec.labelSlot = { dir: 0, ring: 0 };
      }
      buildZodiacLabels();
      buildZodiacMarkerLabels();
      dom.labels.classList.toggle('off', !state.showLabels);
      measureLabels();
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(measureLabels);
    }

    // One label per sign, glyph and name, dimmer than the body labels and not
    // clickable; shown only while the zodiac overlay is on. Their records carry the
    // same screen / labelBox / labelSlot fields as the bodies so the placement pass
    // treats them alike; updateZodiacLabelPositions projects their anchors.
    function buildZodiacLabels() {
      zodiac.labels.length = 0;
      for (let k = 0; k < ZODIAC_SIGNS.length; k++) {
        const sign = ZODIAC_SIGNS[k];
        const el = document.createElement('div');
        el.className = 'label zodiac';
        const glyph = document.createElement('span');
        glyph.className = 'glyph';
        glyph.textContent = sign.glyph;
        el.appendChild(glyph);
        el.appendChild(document.createTextNode(sign.name));
        el.style.display = 'none';
        dom.labels.appendChild(el);
        zodiac.labels.push({
          name: 'zodiac-' + sign.name.toLowerCase(), index: k, label: el,
          labelBox: { w: 0, h: 0 }, labelSlot: { dir: 0, ring: 0 },
          screen: { x: 0, y: 0, r: 0, visible: false, inView: false, ux: 1, uy: 0 }
        });
      }
    }

    // One small tag per zodiac marker with the body's name in its colour, clickable
    // like a body label (click follows the body); shown only while the overlay is on
    // and the marker is on screen. The marker records persist; only the element is
    // rebuilt with the other labels.
    function buildZodiacMarkerLabels() {
      for (const m of zodiac.markers) {
        const el = document.createElement('div');
        el.className = 'label zodiac-mark';
        const rec = bodies[m.name];
        el.style.setProperty('--label-color', hexColor(rec ? rec.accent : accentOf(m.name)));
        el.textContent = DISPLAY_NAME[m.name] || m.name;
        el.style.display = 'none';
        el.addEventListener('click', (ev) => { ev.stopPropagation(); setFocus(m.name === 'sun' ? null : m.name); });
        dom.labels.appendChild(el);
        m.label = el;
        m.labelBox.w = 0; m.labelBox.h = 0;
      }
    }

    function measureLabelBox(rec) {
      const el = rec.label;
      if (!el) return;
      const wasHidden = el.style.display === 'none';
      if (wasHidden) el.style.display = '';
      rec.labelBox.w = el.offsetWidth;
      rec.labelBox.h = el.offsetHeight;
      if (wasHidden) el.style.display = 'none';
    }

    function measureLabels() {
      for (const rec of bodyList) measureLabelBox(rec);
      for (const z of zodiac.labels) measureLabelBox(z);
      for (const m of zodiac.markers) measureLabelBox(m);
    }

    const projV = new THREE.Vector3();
    const worldV = new THREE.Vector3();
    const zodiacAnchor = new THREE.Vector3();

    // Projects the sign label anchors, Earth + the label radius toward the middle of
    // each sector (ecliptic longitude a is the scene direction (cos a, 0, -sin a)),
    // and the body markers' world positions, and records each anchor's screen
    // direction from Earth for the wheel placement; run after updateScreenPositions
    // so the camera matrices and Earth's screen position are current. Anchors behind
    // the camera or well outside the viewport are marked not visible.
    function updateZodiacLabelPositions() {
      if (!state.zodiac || !bodies.earth) return;
      const w = renderer.domElement.clientWidth;
      const h = renderer.domElement.clientHeight;
      const earthRec = bodies.earth;
      const earthPos = earthRec.group.position;
      const ex = earthRec.screen.x, ey = earthRec.screen.y;
      const r = zodiac.ring;
      const eq = equinoxOfDate(state.jd);
      for (let k = 0; k < zodiac.labels.length; k++) {
        const z = zodiac.labels[k];
        const a = (eq + 15 + 30 * k) * DEG;
        zodiacAnchor.set(earthPos.x + r * Math.cos(a), earthPos.y, earthPos.z - r * Math.sin(a));
        projV.copy(zodiacAnchor).project(camera);
        const s = z.screen;
        s.inView = projV.z < 1 && projV.z > -1 && Math.abs(projV.x) < 1.3 && Math.abs(projV.y) < 1.3;
        s.visible = s.inView;
        s.x = (projV.x * 0.5 + 0.5) * w;
        s.y = (-projV.y * 0.5 + 0.5) * h;
        radialDir(s, ex, ey);
      }
      for (const m of zodiac.markers) {
        const s = m.screen;
        if (!m.shown) { s.visible = false; s.inView = false; continue; }
        projV.copy(m.world).project(camera);
        s.inView = projV.z < 1 && projV.z > -1 && Math.abs(projV.x) < 1.3 && Math.abs(projV.y) < 1.3;
        s.visible = s.inView;
        s.x = (projV.x * 0.5 + 0.5) * w;
        s.y = (-projV.y * 0.5 + 0.5) * h;
        s.r = ZODIAC_MARKER_PX;
        radialDir(s, ex, ey);
      }
    }

    // Unit screen direction from Earth (ex, ey) to the anchor, stored on its record.
    function radialDir(s, ex, ey) {
      const dx = s.x - ex, dy = s.y - ey;
      const len = Math.hypot(dx, dy);
      if (len > 1e-6) { s.ux = dx / len; s.uy = dy / len; } else { s.ux = 1; s.uy = 0; }
    }

    function updateScreenPositions() {
      const w = renderer.domElement.clientWidth;
      const h = renderer.domElement.clientHeight;
      const tanHalf = Math.tan(camera.fov * 0.5 * DEG);
      const dots = bodyDotsOn();
      for (const rec of bodyList) {
        rec.group.getWorldPosition(worldV);
        const dist = worldV.distanceTo(camera.position);
        projV.copy(worldV).project(camera);
        const s = rec.screen;
        s.inView = projV.z < 1 && projV.z > -1 && Math.abs(projV.x) < 1.6 && Math.abs(projV.y) < 1.6;
        s.visible = rec.visible && s.inView;
        s.x = (projV.x * 0.5 + 0.5) * w;
        s.y = (-projV.y * 0.5 + 0.5) * h;
        s.r = dist > 0 ? (rec.radius / (dist * tanHalf)) * (h * 0.5) : 0;
        // Body dot (see DOT_RADIUS_PX): always in true-size mode; in the zodiac
        // view only while the globe itself is too small to see. Labels then
        // stand off the dot rather than the globe. Planet moons are gated per frame
        // in updateMoonSystems instead.
        if (rec.marker && !rec.isMoon) {
          let dot = dots && rec.visible && (state.trueSize || s.r < DOT_FADE_PX);
          // Earth's Moon is drawn relative to Earth's size, so at a wide framing its
          // dot would sit on Earth's: show it once the two have come apart on screen
          // (Earth precedes the Moon in bodyList, so its screen position is current).
          if (dot && rec.name === 'moon' && !state.trueSize && bodies.earth) {
            const es = bodies.earth.screen;
            dot = Math.hypot(s.x - es.x, s.y - es.y) >= 3 * DOT_RADIUS_PX;
          }
          rec.marker.visible = dot;
          if (dot) s.r = Math.max(s.r, DOT_RADIUS_PX);
        }
      }
    }

    function rectsOverlap(a, b, m) {
      return a.x < b.x + b.w + m && a.x + a.w + m > b.x && a.y < b.y + b.h + m && a.y + a.h + m > b.y;
    }

    function rectHitsDisc(r, cx, cy, rad) {
      const nx = Math.max(r.x, Math.min(cx, r.x + r.w));
      const ny = Math.max(r.y, Math.min(cy, r.y + r.h));
      const dx = cx - nx, dy = cy - ny;
      return dx * dx + dy * dy < rad * rad;
    }

    // Box for a label in the given direction/ring. The box's nearest corner or
    // edge midpoint sits `ring` px past the disc edge along the direction.
    function labelRect(rec, dirIndex, ring, out) {
      const s = rec.screen, box = rec.labelBox;
      const d = LABEL_DIRS[dirIndex];
      const k = (d[0] !== 0 && d[1] !== 0) ? Math.SQRT1_2 : 1;
      const gap = Math.max(s.r, 3) + LABEL_RINGS[ring];
      const gx = s.x + d[0] * k * gap, gy = s.y + d[1] * k * gap;
      out.x = gx + d[0] * box.w * 0.5 - box.w * 0.5;
      out.y = gy + d[1] * box.h * 0.5 - box.h * 0.5;
      out.w = box.w; out.h = box.h;
      return out;
    }

    function slotFree(rec, rect, w, h) {
      if (rect.x < 2 || rect.y < 2 || rect.x + rect.w > w - 2 || rect.y + rect.h > h - 2) return false;
      for (let i = 0; i < placedCount; i++) if (rectsOverlap(rect, placedRects[i], LABEL_MARGIN)) return false;
      for (const other of bodyList) {
        if (other === rec || !other.screen.visible) continue;
        if (rectHitsDisc(rect, other.screen.x, other.screen.y, Math.max(other.screen.r, 2) + 2)) return false;
      }
      return true;
    }

    const labelOrder = [];
    const placedRects = [];     // pooled boxes of the labels placed this frame; placedCount are in use
    let placedCount = 0;
    const tmpRect = { x: 0, y: 0, w: 0, h: 0 };

    function hideLabel(rec) {
      rec.label.style.display = 'none';
    }

    function recordPlaced(rect) {
      let p = placedRects[placedCount];
      if (!p) { p = { x: 0, y: 0, w: 0, h: 0 }; placedRects.push(p); }
      p.x = rect.x; p.y = rect.y; p.w = rect.w; p.h = rect.h;
      placedCount++;
    }

    // Positions rec's label in the first free slot (its previous slot first) and
    // returns true; with no free slot the label is hidden and false is returned,
    // unless anchorFallback is set, when it is centred on its anchor instead (the
    // zodiac signs are never dropped for lack of room).
    function placeLabel(rec, w, h, anchorFallback) {
      const slot = rec.labelSlot;
      let found = false;
      labelRect(rec, slot.dir, slot.ring, tmpRect);
      if (slotFree(rec, tmpRect, w, h)) {
        found = true;
      } else {
        search: for (let ring = 0; ring < LABEL_RINGS.length; ring++) {
          for (let di = 0; di < LABEL_DIRS.length; di++) {
            labelRect(rec, di, ring, tmpRect);
            if (slotFree(rec, tmpRect, w, h)) { slot.dir = di; slot.ring = ring; found = true; break search; }
          }
        }
      }
      if (!found) {
        if (!anchorFallback) { hideLabel(rec); return false; }
        tmpRect.x = rec.screen.x - rec.labelBox.w * 0.5;
        tmpRect.y = rec.screen.y - rec.labelBox.h * 0.5;
        tmpRect.w = rec.labelBox.w;
        tmpRect.h = rec.labelBox.h;
      }
      recordPlaced(tmpRect);
      const el = rec.label;
      el.style.display = '';
      el.style.transform = 'translate(' + tmpRect.x.toFixed(1) + 'px, ' + tmpRect.y.toFixed(1) + 'px)';
      return true;
    }

    // Distance from a box's centre to its edge along the unit direction (ux, uy).
    function boxReach(box, ux, uy) {
      const rx = Math.abs(ux) > 1e-6 ? (box.w * 0.5) / Math.abs(ux) : Infinity;
      const ry = Math.abs(uy) > 1e-6 ? (box.h * 0.5) / Math.abs(uy) : Infinity;
      return Math.min(rx, ry);
    }

    // Places rec's label centred on (cx, cy) and records it; with check, only when
    // the slot is free, returning false otherwise.
    function placeLabelCentred(rec, cx, cy, check, w, h) {
      const box = rec.labelBox;
      tmpRect.x = cx - box.w * 0.5; tmpRect.y = cy - box.h * 0.5; tmpRect.w = box.w; tmpRect.h = box.h;
      if (check && !slotFree(rec, tmpRect, w, h)) return false;
      recordPlaced(tmpRect);
      const el = rec.label;
      el.style.display = '';
      el.style.transform = 'translate(' + tmpRect.x.toFixed(1) + 'px, ' + tmpRect.y.toFixed(1) + 'px)';
      return true;
    }

    // Wheel: a sign label hugs the ring from outside at its
    // sector's middle and is never displaced (it is placed first; the bodies' labels
    // avoid it); a marker tag hugs its dot from inside, falling back to the usual
    // search around the dot when that slot is taken.
    function placeSignOnWheel(z, w, h) {
      const s = z.screen;
      const d = WHEEL_SIGN_GAP + boxReach(z.labelBox, s.ux, s.uy);
      placeLabelCentred(z, s.x + s.ux * d, s.y + s.uy * d, false, w, h);
    }

    function placeTagOnWheel(m, w, h) {
      const s = m.screen;
      const d = WHEEL_TAG_GAP + ZODIAC_MARKER_PX + boxReach(m.labelBox, s.ux, s.uy);
      return placeLabelCentred(m, s.x - s.ux * d, s.y - s.uy * d, true, w, h);
    }

    function updateLabels() {
      if (!state.showLabels) return;
      const w = renderer.domElement.clientWidth;
      const h = renderer.domElement.clientHeight;
      if (labelViewport.w !== w || labelViewport.h !== h) {
        labelViewport.w = w; labelViewport.h = h;
        measureLabels();   // the label font size changes with the viewport width
      }
      labelOrder.length = 0;
      for (const rec of bodyList) {
        if (!rec.label) continue;
        if (!rec.screen.visible || !rec.labelOn) { hideLabel(rec); continue; }
        if (rec.labelBox.w === 0) measureLabels();
        labelOrder.push(rec);
      }
      // The followed body first, then the planets by apparent size, then the planet
      // moons, so a planet's label always wins over those of its moons.
      labelOrder.sort((a, b) => {
        if (a.name === state.focus) return -1;
        if (b.name === state.focus) return 1;
        if (a.isMoon !== b.isMoon) return a.isMoon ? 1 : -1;
        return b.screen.r - a.screen.r;
      });
      placedCount = 0;
      const wheelOn = state.zodiac;
      // On the wheel the signs are fixed furniture: placed first, so every other
      // label keeps clear of them.
      if (wheelOn) {
        for (const z of zodiac.labels) {
          if (!z.screen.visible) { hideLabel(z); continue; }
          if (z.labelBox.w === 0) measureLabels();
          placeSignOnWheel(z, w, h);
        }
      }
      for (const rec of labelOrder) {
        if (placeLabel(rec, w, h, false)) rec.label.classList.toggle('selected', state.focus === rec.name);
      }
      // The zodiac marker tags come after the bodies: just inside the dot on the
      // wheel, else in the first free slot around it; a tag hides when crowded (its
      // dot still shows the direction). Off-screen anchors are hidden.
      if (wheelOn) {
        for (const m of zodiac.markers) {
          if (!m.label) continue;
          if (!m.screen.visible) { hideLabel(m); continue; }
          if (m.labelBox.w === 0) measureLabels();
          if (!placeTagOnWheel(m, w, h)) placeLabel(m, w, h, false);
        }
      }
    }

    // ---- Camera and focus ---------------------------------------------------------

    const cameraTween = { active: false, t0: 0, duration: 0, fromPos: new THREE.Vector3(), fromTarget: new THREE.Vector3(), endOffset: new THREE.Vector3(), staticTarget: new THREE.Vector3() };
    const followPrev = new THREE.Vector3();
    const focusWorld = new THREE.Vector3();

    function presetPosition(preset, out) {
      const p = CAMERA_PRESETS[preset] || CAMERA_PRESETS.default;
      const dist = mapDistance(p.au) * p.mult;
      const el = p.elevation * DEG;
      const az = p.azimuth * DEG;
      return out.set(Math.sin(az) * Math.cos(el) * dist, Math.sin(el) * dist, Math.cos(az) * Math.cos(el) * dist);
    }

    function focusTargetWorld(out) {
      if (state.focus && bodies[state.focus]) return bodies[state.focus].group.getWorldPosition(out);
      return out.set(0, 0, 0);
    }

    function startTween(endOffset, duration) {
      cameraTween.active = true;
      cameraTween.t0 = performance.now();
      cameraTween.duration = duration;
      cameraTween.fromPos.copy(camera.position);
      cameraTween.fromTarget.copy(controls.target);
      cameraTween.endOffset.copy(endOffset);
      controls.enabled = false;
    }

    function updateCamera(now) {
      if (cameraTween.active) {
        const t = clamp((now - cameraTween.t0) / cameraTween.duration, 0, 1);
        const k = easeInOutCubic(t);
        focusTargetWorld(focusWorld);
        controls.target.lerpVectors(cameraTween.fromTarget, focusWorld, k);
        const endPos = focusWorld.clone().add(cameraTween.endOffset);
        camera.position.lerpVectors(cameraTween.fromPos, endPos, k);
        if (t >= 1) {
          cameraTween.active = false;
          controls.enabled = true;
          followPrev.copy(controls.target);
        }
        return;
      }
      if (state.focus && bodies[state.focus]) {
        focusTargetWorld(focusWorld);
        const dx = focusWorld.x - controls.target.x;
        const dy = focusWorld.y - controls.target.y;
        const dz = focusWorld.z - controls.target.z;
        camera.position.x += dx;
        camera.position.y += dy;
        camera.position.z += dz;
        controls.target.copy(focusWorld);
      }
    }

    // Follow a body (null: the Sun). The camera tweens to `offset` from the body when
    // given, otherwise to a close view along its current direction.
    function setFocus(name, offset, duration) {
      const rec = name ? bodies[name] : null;
      const changed = state.focus !== (rec ? name : null);
      state.focus = rec ? name : null;
      for (const key in rowByName) rowByName[key].classList.toggle('selected', key === state.focus);
      if (rec) {
        dom.focusChip.hidden = false;
        dom.focusName.textContent = DISPLAY_NAME[name];
        controls.minDistance = Math.min(2, rec.radius * 2.5);
        let end = offset;
        if (!end) {
          const dir = camera.position.clone().sub(controls.target);
          if (dir.lengthSq() < 1e-8) dir.set(0, 0.6, 1);
          dir.normalize();
          const dist = Math.max(rec.radius * 6, controls.minDistance * 1.5);
          end = dir.multiplyScalar(dist);
        }
        startTween(end, duration != null ? duration : (changed ? 1100 : 700));
      } else {
        dom.focusChip.hidden = true;
        controls.minDistance = 2;
        if (changed) applyPreset('default', 1100);
      }
      syncInfoMoonRows();
    }

    // In the zodiac view the Inner, Full and Top presets (and the default)
    // frame Earth from straight above instead, refocusing Earth first if needed:
    // the inner system out to Mars, the whole disc out past Pluto, Saturn's distance.
    function applyPreset(preset, duration) {
      const ms = duration == null ? 1000 : duration;
      if (zodiacOn() && ZODIAC_RING_AU[preset] != null) {
        const offset = zodiacPresetOffset(ZODIAC_RING_AU[preset], new THREE.Vector3());
        if (state.focus !== 'earth') { setFocus('earth', offset, ms); return; }
        startTween(offset, ms);
        return;
      }
      const offset = presetPosition(preset, new THREE.Vector3());
      startTween(offset, ms);
    }

    function resetView() {
      if (zodiacOn()) { enterZodiacView(); return; }   // the view's home is above Earth
      state.focus = null;
      dom.focusChip.hidden = true;
      controls.minDistance = 2;
      for (const key in rowByName) rowByName[key].classList.remove('selected');
      syncInfoMoonRows();
      applyPreset('default', 1000);
    }

    // ---- Picking -------------------------------------------------------------------

    const raycaster = new THREE.Raycaster();
    const pointerNdc = new THREE.Vector2();
    let pointerDown = { x: 0, y: 0, t: 0 };

    function pickAt(clientX, clientY) {
      const rect = renderer.domElement.getBoundingClientRect();
      const x = clientX - rect.left;
      const y = clientY - rect.top;
      pointerNdc.set((x / rect.width) * 2 - 1, -(y / rect.height) * 2 + 1);
      raycaster.setFromCamera(pointerNdc, camera);
      const pickables = [];
      for (const rec of bodyList) {
        if (!rec.visible) continue;
        pickables.push(rec.mesh);
        if (rec.pick) pickables.push(rec.pick);
      }
      const hits = raycaster.intersectObjects(pickables, false);
      if (hits.length) {
        const hit = hits.find((h) => h.object.userData && h.object.userData.body);
        if (hit) return hit.object.userData.body;
      }
      // Fall back to screen-space proximity so tiny bodies remain clickable.
      let best = null;
      let bestD = Infinity;
      for (const rec of bodyList) {
        const s = rec.screen;
        if (!s.visible) continue;
        const d = Math.hypot(s.x - x, s.y - y);
        const threshold = Math.max(14, s.r + 6);
        if (d < threshold && d < bestD) { bestD = d; best = rec.name; }
      }
      return best;
    }

    function onPointerDown(ev) {
      pointerDown = { x: ev.clientX, y: ev.clientY, t: performance.now() };
    }

    function onPointerUp(ev) {
      if (ev.button !== 0) return;
      const moved = Math.hypot(ev.clientX - pointerDown.x, ev.clientY - pointerDown.y);
      if (moved > 5 || performance.now() - pointerDown.t > 500) return;
      const name = pickAt(ev.clientX, ev.clientY);
      if (name) setFocus(name === 'sun' ? null : name);
    }

    function onDoubleClick(ev) {
      const name = pickAt(ev.clientX, ev.clientY);
      if (!name) resetView();
    }

    function onPointerMove(ev) {
      const name = pickAt(ev.clientX, ev.clientY);
      if (name !== state.hover) {
        if (state.hover && rowByName[state.hover]) rowByName[state.hover].classList.remove('hover');
        state.hover = name;
        if (name && rowByName[name]) rowByName[name].classList.add('hover');
        renderer.domElement.style.cursor = name ? 'pointer' : '';
      }
    }

    // ---- Info panel -----------------------------------------------------------------

    const rowByName = {};
    const rowParts = {};

    function buildInfoRows() {
      dom.infoRows.textContent = '';
      removeInfoMoonRows();
      for (const name of PLANETS) {
        const row = document.createElement('div');
        row.className = 'info-row';
        row.setAttribute('role', 'listitem');
        row.dataset.body = name;
        row.style.setProperty('--row-color', hexColor(accentOf(name)));
        const dot = document.createElement('span');
        dot.className = 'dot';
        const nameEl = document.createElement('span');
        nameEl.className = 'name';
        nameEl.textContent = DISPLAY_NAME[name];
        const lon = document.createElement('span');
        lon.className = 'lon';
        const sign = document.createElement('span');
        sign.className = 'sign';
        const lonVal = document.createElement('span');
        lon.appendChild(sign);
        lon.appendChild(lonVal);
        const dist = document.createElement('span');
        dist.className = 'dist';
        const dSun = document.createElement('span');
        const dEarth = document.createElement('span');
        dist.appendChild(dSun);
        dist.appendChild(dEarth);
        row.appendChild(dot);
        row.appendChild(nameEl);
        row.appendChild(lon);
        row.appendChild(dist);
        row.addEventListener('click', () => setFocus(name));
        dom.infoRows.appendChild(row);
        rowByName[name] = row;
        rowParts[name] = { sign, lonVal, dSun, dEarth };
      }
      // Earth's Moon is always listed beneath Earth, in the same form as the
      // other planets' moons (distance from the planet in km and radii, period).
      if (rowByName.earth) {
        const moonRow = buildMinorRow('moon', accentOf('moon'), MOON_SIDEREAL_PERIOD_DAYS, false);
        moonRow.hidden = !state.showMoon;
        rowByName.earth.insertAdjacentElement('afterend', moonRow);
      }
    }

    function setText(el, text) {
      if (el.textContent !== text) el.textContent = text;
    }

    // Moons of the followed planet (or of the followed moon's planet) are listed as
    // sub-rows beneath that planet's row, in rowByName / rowParts like the planets so
    // hover and selection work unchanged. The DOM is rebuilt only when the system
    // shown changes; the figures refresh with the rest of the panel.
    const infoMoons = { planet: null, recs: [] };

    function infoMoonSystemFor(focus) {
      if (!focus || !state.showPlanetMoons) return null;
      const md = moonData[focus];
      const planet = md ? md.parent : focus;
      for (const sys of moonSystems) {
        if (sys.planet === planet) return (sys.enabled && !sys.broken && sys.moons.length) ? sys : null;
      }
      return null;
    }

    function formatPeriod(days) {
      const digits = days < 1 ? 3 : (days < 10 ? 2 : 1);
      return days.toFixed(digits) + ' d';
    }

    function removeInfoMoonRows() {
      for (const rec of infoMoons.recs) {
        const row = rowByName[rec.name];
        if (row && row.parentNode) row.parentNode.removeChild(row);
        delete rowByName[rec.name];
        delete rowParts[rec.name];
      }
      infoMoons.recs.length = 0;
      infoMoons.planet = null;
    }

    const MOON_SIDEREAL_PERIOD_DAYS = 27.321662;

    function buildInfoMoonRow(rec) {
      const md = moonData[rec.name];
      return buildMinorRow(rec.name, rec.accent, md.periodDays, md.retrograde);
    }

    // A moon sub-row: name, distance from its planet (km and planet radii), period.
    function buildMinorRow(name, accent, periodDays, retrograde) {
      const row = document.createElement('div');
      row.className = 'info-row minor';
      row.setAttribute('role', 'listitem');
      row.dataset.body = name;
      row.style.setProperty('--row-color', hexColor(accent));
      const dot = document.createElement('span');
      dot.className = 'dot';
      const nameEl = document.createElement('span');
      nameEl.className = 'name';
      nameEl.textContent = DISPLAY_NAME[name];
      const km = document.createElement('span');
      km.className = 'lon';
      const dist = document.createElement('span');
      dist.className = 'dist';
      const radii = document.createElement('span');
      const period = document.createElement('span');
      period.textContent = formatPeriod(periodDays);
      if (retrograde) {
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = 'retrograde';
        period.appendChild(tag);
      }
      dist.appendChild(radii);
      dist.appendChild(period);
      row.appendChild(dot);
      row.appendChild(nameEl);
      row.appendChild(km);
      row.appendChild(dist);
      row.classList.toggle('selected', state.focus === name);
      row.classList.toggle('hover', state.hover === name);
      row.addEventListener('click', () => setFocus(name));
      rowByName[name] = row;
      rowParts[name] = { km, radii };
      return row;
    }

    // Called whenever the focus or the moon toggle changes.
    function syncInfoMoonRows() {
      const sys = infoMoonSystemFor(state.focus);
      const planet = sys ? sys.planet : null;
      if (planet === infoMoons.planet) return;
      removeInfoMoonRows();
      const parentRow = planet ? rowByName[planet] : null;
      if (!sys || !parentRow) return;
      let after = parentRow;
      for (const rec of sys.moons) {
        const row = buildInfoMoonRow(rec);
        after.insertAdjacentElement('afterend', row);
        after = row;
        infoMoons.recs.push(rec);
      }
      infoMoons.planet = planet;
      updateInfoMoonRows();
    }

    function updateInfoMoonRows() {
      for (const rec of infoMoons.recs) {
        const parts = rowParts[rec.name];
        if (!parts) continue;
        const km = rec.distKm;
        if (!(km > 0)) { setText(parts.km, '—'); setText(parts.radii, ''); continue; }
        setText(parts.km, Math.round(km).toLocaleString('en-US') + ' km');
        setText(parts.radii, (km / rec.parentRadiusKm).toFixed(1) + ' R');
      }
    }

    // Ecliptic longitude in [0, 360) of the vector from a to b (same frame).
    function longitudeFrom(a, b) {
      return wrapLon(Math.atan2(b.y - a.y, b.x - a.x) / DEG);
    }

    // "<glyph> <Sign>" for a tropical longitude; signDegrees gives the degrees within.
    function signLabel(tropicalLon) {
      const sign = ZODIAC_SIGNS[Math.min(11, Math.floor(tropicalLon / 30))];
      return sign.glyph + ' ' + sign.name;
    }

    function signDegrees(tropicalLon) {
      return tropicalLon - Math.min(11, Math.floor(tropicalLon / 30)) * 30;
    }

    // In zodiac mode the longitude column shows GEOCENTRIC TROPICAL figures: each
    // planet as seen from Earth, measured from the equinox of date; Earth's own row
    // carries the Sun's sign (its geocentric direction is -Earth) and the Moon's
    // sub-row its sign in place of the km figure. Otherwise the heliocentric J2000
    // longitudes are shown as before. Geocentric vectors are differences of the
    // frame's heliocentric positions; nothing is allocated here.
    function updateInfoPanel(positions, source) {
      const b = positions.bodies;
      const earth = b.earth;
      const geo = state.zodiac && !!earth;
      for (const name of PLANETS) {
        const p = b[name];
        const parts = rowParts[name];
        if (!p || !parts) continue;
        if (geo) {
          const lonG = name === 'earth' ? wrapLon(Math.atan2(-earth.y, -earth.x) / DEG) : longitudeFrom(earth, p);
          const trop = tropicalOf(lonG, state.jd);
          setText(parts.sign, (name === 'earth' ? 'Sun in ' : '') + signLabel(trop));
          setText(parts.lonVal, signDegrees(trop).toFixed(1) + '°  (' + trop.toFixed(2) + '°)');
        } else {
          const zt = zodiacText(p.lon);
          const sp = zt.indexOf(' ');
          setText(parts.sign, zt.slice(0, sp));
          setText(parts.lonVal, zt.slice(sp + 1) + '  (' + p.lon.toFixed(2) + '°)');
        }
        setText(parts.dSun, 'Sun ' + p.r.toFixed(3) + ' AU');
        if (name === 'earth') {
          setText(parts.dEarth, 'Earth —');
        } else if (earth) {
          const d = Math.sqrt((p.x - earth.x) ** 2 + (p.y - earth.y) ** 2 + (p.z - earth.z) ** 2);
          setText(parts.dEarth, 'Earth ' + d.toFixed(3) + ' AU');
        }
      }
      if (b.moon && rowParts.moon) {
        const moon = b.moon;   // geocentric already
        const km = moon.r * AU_KM;
        if (geo) {
          const trop = tropicalOf(wrapLon(Math.atan2(moon.y, moon.x) / DEG), state.jd);
          setText(rowParts.moon.km, signLabel(trop) + ' ' + signDegrees(trop).toFixed(1) + '°');
        } else {
          setText(rowParts.moon.km, Math.round(km).toLocaleString('en-US') + ' km');
        }
        setText(rowParts.moon.radii, (km / REAL_RADIUS_KM.earth).toFixed(1) + ' R');
      }
      updateInfoMoonRows();
      let badge;
      let cls = 'badge';
      // 'exact' (positions fetched for this very instant) and 'anchored' (exact
      // positions a few hours old carried forward with Keplerian motion) differ
      // by arcseconds at most, and in real-time playback they alternate every
      // second; one label keeps the panel from reflowing.
      if (source === 'exact' || source === 'anchored') { badge = prettyEphemeris(precision.ephemeris) + ' (exact)'; cls += ' exact'; }
      else badge = 'Keplerian (JPL elements)';
      setText(dom.sourceBadge, badge);
      if (dom.sourceBadge.className !== cls) dom.sourceBadge.className = cls;
      let setName = '';
      try { setName = Eph.elementSet(state.jd); } catch (err) { setName = ''; }
      setText(dom.elementSet, setName);
    }

    // ---- Popovers and panel toggles -------------------------------------------------

    function setPopover(which, open) {
      const pop = which === 'settings' ? dom.settingsPopover : dom.helpPopover;
      const btn = which === 'settings' ? dom.btnSettings : dom.btnHelp;
      const other = which === 'settings' ? dom.helpPopover : dom.settingsPopover;
      const otherBtn = which === 'settings' ? dom.btnHelp : dom.btnSettings;
      pop.hidden = !open;
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) { other.hidden = true; otherBtn.setAttribute('aria-expanded', 'false'); }
    }

    function togglePopover(which) {
      const pop = which === 'settings' ? dom.settingsPopover : dom.helpPopover;
      setPopover(which, pop.hidden);
    }

    function setInfoPanel(open) {
      dom.infoPanel.classList.toggle('collapsed', !open);
      dom.btnInfoToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      updateWheelLayout();
      setTimeout(updateWheelLayout, 420);   // again once the panel's slide transition has ended
    }

    // ---- UI wiring -------------------------------------------------------------------

    function buildSpeedSelect() {
      dom.speedSelect.textContent = '';
      SPEEDS.forEach((s, i) => {
        const opt = document.createElement('option');
        opt.value = String(i);
        opt.textContent = s.label;
        dom.speedSelect.appendChild(opt);
      });
      dom.speedSelect.value = String(state.speedIndex);
    }

    function buildMonthSelect() {
      dom.inMonth.textContent = '';
      MONTHS.forEach((m, i) => {
        const opt = document.createElement('option');
        opt.value = String(i + 1);
        opt.textContent = m;
        dom.inMonth.appendChild(opt);
      });
    }

    function isFormControl(el) {
      if (!el) return false;
      const tag = el.tagName;
      return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || !!el.isContentEditable;
    }

    // Controls that consume keystrokes as text. The timeline range slider is excluded so
    // the transport shortcuts keep working after it has been clicked.
    function isTypingTarget(el) {
      if (!isFormControl(el)) return false;
      if (el.tagName === 'INPUT' && el.type === 'range') return false;
      return true;
    }

    function onKeyDown(ev) {
      if (ev.key === 'Escape') {
        if (!dom.settingsPopover.hidden || !dom.helpPopover.hidden) {
          setPopover('settings', false);
          setPopover('help', false);
        } else if (isFormControl(document.activeElement)) {
          document.activeElement.blur();
        } else {
          setFocus(null);
        }
        return;
      }
      if (isTypingTarget(document.activeElement)) return;
      if (ev.metaKey || ev.ctrlKey) return;
      switch (ev.code) {
        case 'Space':
          ev.preventDefault();
          if (document.activeElement && document.activeElement.tagName === 'BUTTON') document.activeElement.blur();
          setPlaying(!state.playing);
          break;
        case 'ArrowLeft':
        case 'ArrowRight': {
          ev.preventDefault();
          const sign = ev.code === 'ArrowLeft' ? -1 : 1;
          if (ev.altKey) stepYears(sign);
          else if (ev.shiftKey) stepMonths(sign);
          else stepDays(sign);
          break;
        }
        case 'ArrowUp':
          ev.preventDefault();
          setSpeed(state.speedIndex + 1);
          break;
        case 'ArrowDown':
          ev.preventDefault();
          setSpeed(state.speedIndex - 1);
          break;
        case 'KeyN': goToNow(); break;
        case 'KeyR': resetView(); break;
        case 'KeyL': dom.optLabels.checked = !dom.optLabels.checked; dom.optLabels.dispatchEvent(new Event('change')); break;
        case 'KeyO': dom.optOrbits.checked = !dom.optOrbits.checked; dom.optOrbits.dispatchEvent(new Event('change')); break;
        case 'KeyZ': setZodiac(!state.zodiac); break;
        case 'KeyH': togglePopover('help'); break;
        case 'Digit1': applyPreset('inner'); break;
        case 'Digit2': applyPreset('full'); break;
        case 'Digit3': applyPreset('top'); break;
        case 'Digit4': applyPreset('edge'); break;
        default: break;
      }
    }

    function wireUI() {
      buildSpeedSelect();
      buildMonthSelect();
      buildTimeZoneSelect();
      buildTimeline();
      buildInfoRows();
      setPlaying(state.playing);
      setDirection(state.direction);
      updateYearBounds();
      syncTimeInputs(true);
      updateDateHeadline();

      dom.btnPlay.addEventListener('click', () => setPlaying(!state.playing));
      dom.btnBackYear.addEventListener('click', () => stepYears(-1));
      dom.btnBackMonth.addEventListener('click', () => stepMonths(-1));
      dom.btnBackDay.addEventListener('click', () => stepDays(-1));
      dom.btnFwdDay.addEventListener('click', () => stepDays(1));
      dom.btnFwdMonth.addEventListener('click', () => stepMonths(1));
      dom.btnFwdYear.addEventListener('click', () => stepYears(1));
      dom.btnNow.addEventListener('click', goToNow);
      dom.speedSelect.addEventListener('change', () => setSpeed(parseInt(dom.speedSelect.value, 10)));
      dom.btnReverse.addEventListener('click', () => setDirection(-state.direction));

      dom.dateForm.addEventListener('submit', (ev) => { ev.preventDefault(); applyDateFields(); });
      dom.inYear.addEventListener('input', updateEraHint);
      dom.inDatetime.addEventListener('change', applyDatetimeLocal);
      if (dom.tzSelect) dom.tzSelect.addEventListener('change', () => setTimeZone(dom.tzSelect.value));

      dom.timeline.addEventListener('pointerdown', (ev) => { if (ev.shiftKey) beginFineScrub(ev.clientX); });
      dom.timeline.addEventListener('input', () => {
        const v = parseFloat(dom.timeline.value);
        if (!Number.isNaN(v)) { setPlaying(false); setJd(v, { silent: true }); updateTimelineMarker(); syncTimeInputs(false); }
      });
      const endScrub = () => { if (state.fineScrub) endFineScrub(); };
      dom.timeline.addEventListener('pointerup', endScrub);
      dom.timeline.addEventListener('pointercancel', endScrub);
      window.addEventListener('pointerup', endScrub);
      window.addEventListener('keyup', (ev) => { if (ev.key === 'Shift') endScrub(); });
      // The slider's own arrow handling would step by 1/100 of the range (about 60 years)
      // and Space would do nothing, so the transport keys are handled here and stopped
      // before the window handler sees them.
      dom.timeline.addEventListener('keydown', (ev) => {
        if (ev.metaKey || ev.ctrlKey) return;
        if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
          ev.preventDefault();
          ev.stopPropagation();
          const sign = ev.key === 'ArrowLeft' ? -1 : 1;
          if (ev.shiftKey) stepYears(sign * 10); else stepYears(sign);
        } else if (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') {
          ev.preventDefault();
          ev.stopPropagation();
          setSpeed(state.speedIndex + (ev.key === 'ArrowUp' ? 1 : -1));
        } else if (ev.code === 'Space') {
          ev.preventDefault();
          ev.stopPropagation();
          setPlaying(!state.playing);
        }
      });

      dom.btnSettings.addEventListener('click', () => togglePopover('settings'));
      dom.btnHelp.addEventListener('click', () => togglePopover('help'));
      dom.btnInfoToggle.addEventListener('click', () => { state.infoPanelUserSet = true; setInfoPanel(dom.infoPanel.classList.contains('collapsed')); });
      dom.btnInfoClose.addEventListener('click', () => { state.infoPanelUserSet = true; setInfoPanel(false); });
      dom.btnUnfocus.addEventListener('click', () => setFocus(null));
      document.addEventListener('pointerdown', (ev) => {
        const inPop = dom.settingsPopover.contains(ev.target) || dom.helpPopover.contains(ev.target)
          || dom.btnSettings.contains(ev.target) || dom.btnHelp.contains(ev.target);
        if (!inPop) { setPopover('settings', false); setPopover('help', false); }
      });

      dom.optOrbits.addEventListener('change', () => { state.showOrbits = dom.optOrbits.checked; applyOrbitVisibility(); });
      dom.optLabels.addEventListener('change', () => { state.showLabels = dom.optLabels.checked; dom.labels.classList.toggle('off', !state.showLabels); });
      dom.optBelt.addEventListener('change', () => { state.showBelt = dom.optBelt.checked; if (sky.belt) sky.belt.visible = state.showBelt; });
      dom.optKuiper.addEventListener('change', () => { state.showKuiper = dom.optKuiper.checked; if (sky.kuiper) sky.kuiper.visible = state.showKuiper; });
      dom.btnInfoHelp.addEventListener('click', () => {
        const open = dom.infoFineprint.hidden;
        dom.infoFineprint.hidden = !open;
        dom.btnInfoHelp.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
      dom.optMilkyWay.addEventListener('change', () => { state.showMilkyWay = dom.optMilkyWay.checked; if (sky.milkyWay) sky.milkyWay.visible = state.showMilkyWay; });
      dom.optBloom.addEventListener('change', () => { bloomPass.enabled = dom.optBloom.checked; });
      dom.bloomStrength.addEventListener('input', () => { bloomPass.strength = parseFloat(dom.bloomStrength.value); });
      dom.optTrueScale.addEventListener('change', () => {
        const wasLinear = linearDistances();
        state.trueScale = dom.optTrueScale.checked;
        if (linearDistances() !== wasLinear) applyDistanceMapping(true);   // no-op while the zodiac view holds the mapping linear
      });
      dom.optTrueSize.addEventListener('change', () => {
        state.trueSize = dom.optTrueSize.checked;
        applyRadii();
        updateMoonOrbit(true);
        invalidateMoonOrbits();
        if (state.focus) setFocus(state.focus);
      });
      dom.optPluto.addEventListener('change', () => setShowPluto(dom.optPluto.checked));
      dom.optPlutoPanel.addEventListener('change', () => setShowPluto(dom.optPlutoPanel.checked));
      if (dom.optZodiac) dom.optZodiac.addEventListener('change', () => setZodiac(dom.optZodiac.checked));
      if (dom.optZodiacPanel) dom.optZodiacPanel.addEventListener('change', () => setZodiac(dom.optZodiacPanel.checked));
      dom.optMoon.addEventListener('change', () => { state.showMoon = dom.optMoon.checked; applyBodyVisibility(); });
      if (dom.optPlanetMoons) {
        dom.optPlanetMoons.addEventListener('change', () => { state.showPlanetMoons = dom.optPlanetMoons.checked; applyBodyVisibility(); });
      }
      dom.presetInner.addEventListener('click', () => applyPreset('inner'));
      dom.presetFull.addEventListener('click', () => applyPreset('full'));
      dom.presetTop.addEventListener('click', () => applyPreset('top'));
      dom.presetEdge.addEventListener('click', () => applyPreset('edge'));
      dom.btnResetView.addEventListener('click', resetView);

      const canvas = renderer.domElement;
      canvas.addEventListener('pointerdown', onPointerDown);
      canvas.addEventListener('pointerup', onPointerUp);
      canvas.addEventListener('dblclick', onDoubleClick);
      canvas.addEventListener('pointermove', onPointerMove);
      window.addEventListener('keydown', onKeyDown);

      // Initial state of the option switches mirrors the state object.
      dom.optOrbits.checked = state.showOrbits;
      dom.optLabels.checked = state.showLabels;
      dom.optBelt.checked = state.showBelt;
      dom.optKuiper.checked = state.showKuiper;
      dom.optMilkyWay.checked = state.showMilkyWay;
      dom.optBloom.checked = true;
      dom.bloomStrength.value = String(bloomPass.strength);
      dom.optTrueScale.checked = state.trueScale;
      dom.optTrueSize.checked = state.trueSize;
      dom.optPluto.checked = state.showPluto;
      dom.optPlutoPanel.checked = state.showPluto;
      syncZodiacUI();
      dom.optMoon.checked = state.showMoon;
      if (dom.optPlanetMoons) {
        dom.optPlanetMoons.checked = state.showPlanetMoons;
        dom.optPlanetMoons.disabled = moonOrder.length === 0;   // moons.js missing or empty
      }
      if (window.innerWidth < 760) setInfoPanel(false); else setInfoPanel(true);
    }

    // ---- Per-frame body update ---------------------------------------------------------

    const earthScene = new THREE.Vector3();
    const moonDir = new THREE.Vector3();
    const MOON_MEAN_DISTANCE_EARTH_RADII = 60.3;
    const CLOUD_PERIOD_DAYS = ROTATION_PERIOD_DAYS.earth / 1.03;   // clouds drift slightly faster than the ground

    // Unsigned spin phase; callers multiply by the record's spinSign (see orientBody).
    function spinAngle(name, jd) {
      const period = Math.abs(ROTATION_PERIOD_DAYS[name]);
      const turns = (jd - J2000) / period;
      return TWO_PI * (turns - Math.floor(turns));
    }

    function cloudAngle(jd) {
      const turns = (jd - J2000) / CLOUD_PERIOD_DAYS;
      return TWO_PI * (turns - Math.floor(turns)) + 0.4;
    }

    // Earth's real orientation. The tilt basis sends the spin group's +X to the mean
    // equinox of date and +Y to the mean pole of date; the map's longitude 0 faces
    // local +X and a positive spin turns it eastward (counterclockwise seen from the
    // pole), so rotation.y = GMST puts Greenwich at hour angle zero of the equinox
    // and the geography under the Sun agrees with Ephemeris.subsolarPoint. Without
    // Ephemeris.earthOrientation the IAU pole and mean rotation period stand in, as
    // for every other planet. Clouds share the frame plus a slow drift.
    const earthOrient = { available: typeof Eph.earthOrientation === 'function' };
    const frameX = new THREE.Vector3();
    const frameY = new THREE.Vector3();
    const frameZ = new THREE.Vector3();
    const frameBasis = new THREE.Matrix4();
    const CLOUD_DRIFT_PERIOD_DAYS = 31;

    function cloudDrift(jd) {
      const turns = (jd - J2000) / CLOUD_DRIFT_PERIOD_DAYS;
      return TWO_PI * (turns - Math.floor(turns));
    }

    function disableEarthOrientation(rec, reason, err) {
      earthOrient.available = false;
      console.warn('Ephemeris.earthOrientation ' + reason + '; Earth falls back to its IAU pole and mean rotation', err || '');
      rec.tilt.rotation.set(0, 0, 0);
      rec.spinSign = orientBody(rec.tilt, 'earth', null);
    }

    // Returns true when the real orientation was applied, false to use the fallback.
    function orientEarth(rec, jd) {
      if (!earthOrient.available) return false;
      let o = null;
      try {
        o = Eph.earthOrientation(jd);
      } catch (err) {
        disableEarthOrientation(rec, 'threw', err);
        return false;
      }
      if (!o || !o.pole || !o.equinox || !Number.isFinite(o.gmst)) {
        disableEarthOrientation(rec, 'returned an unexpected value');
        return false;
      }
      if (!setTiltFrame(rec.tilt, o.equinox, o.pole)) {
        disableEarthOrientation(rec, 'returned a degenerate frame');
        return false;
      }
      rec.spin.rotation.y = o.gmst;
      if (rec.clouds) rec.clouds.rotation.y = o.gmst + cloudDrift(jd);
      return true;
    }

    // Points a tilt group's +X along x and +Y along pole (ecliptic J2000 vectors),
    // re-orthogonalised around the pole so the basis is a pure rotation. Returns
    // false, leaving the group untouched, for a degenerate pair.
    function setTiltFrame(tilt, x, pole) {
      frameX.set(x.x, x.z, -x.y);
      frameY.set(pole.x, pole.z, -pole.y);
      const lx = frameX.lengthSq();
      const ly = frameY.lengthSq();
      if (!(lx > 1e-12) || !(ly > 1e-12) || !Number.isFinite(lx) || !Number.isFinite(ly)) return false;
      frameX.normalize();
      frameY.normalize();
      frameZ.crossVectors(frameX, frameY);
      if (!(frameZ.lengthSq() > 1e-12)) return false;
      frameZ.normalize();
      frameX.crossVectors(frameY, frameZ);
      frameBasis.makeBasis(frameX, frameY, frameZ);
      tilt.quaternion.setFromRotationMatrix(frameBasis);
      return true;
    }

    // The Moon's real orientation from Ephemeris.moonOrientation: the tilt basis sends
    // +X to the node of the lunar equator and +Y to the lunar pole, and rotation.y = W
    // brings map longitude 0 round to the mean sub-Earth meridian, so the near side
    // faces Earth with its true libration. Without it the Moon keeps a plain spin.
    const moonOrient = { available: typeof Eph.moonOrientation === 'function' };

    function disableMoonOrientation(rec, reason, err) {
      moonOrient.available = false;
      console.warn('Ephemeris.moonOrientation ' + reason + '; the Moon falls back to a uniform spin', err || '');
      rec.tilt.rotation.set(0, 0, 0);
      rec.spinSign = orientBody(rec.tilt, 'moon', null);
    }

    // Returns true when the real orientation was applied, false to use the fallback.
    function orientMoon(rec, jd) {
      if (!moonOrient.available) return false;
      let o = null;
      try {
        o = Eph.moonOrientation(jd);
      } catch (err) {
        disableMoonOrientation(rec, 'threw', err);
        return false;
      }
      if (!o || !o.pole || !o.node || !Number.isFinite(o.w)) {
        disableMoonOrientation(rec, 'returned an unexpected value');
        return false;
      }
      if (!setTiltFrame(rec.tilt, o.node, o.pole)) {
        disableMoonOrientation(rec, 'returned a degenerate frame');
        return false;
      }
      rec.spin.rotation.y = o.w;
      return true;
    }

    // Scene distance of the Moon from Earth's centre. Body radii are tens of times larger
    // than the distance scale even in true-scale mode (0.06 for Earth versus 0.0009 at
    // 22 units per AU), so the Moon is placed relative to Earth's current radius: at
    // the real 60.3 Earth radii in true-size mode, otherwise just clear of the globe.
    function moonSceneDistance() {
      const rE = bodyRadius('earth');
      const rM = bodyRadius('moon');
      if (state.trueSize) return rE * MOON_MEAN_DISTANCE_EARTH_RADII;
      return Math.max(MOON_VISUAL_DISTANCE, (rE + rM) * 1.8);
    }

    function updateBodies(positions, jd) {
      const b = positions.bodies;
      for (const name of PLANETS) {
        const rec = bodies[name];
        const p = b[name];
        if (!rec || !p) continue;
        toScene(p, rec.group.position);
        if (name === 'earth' && orientEarth(rec, jd)) continue;
        // Fallback for Earth, and the regular path for every other planet.
        rec.spin.rotation.y = spinAngle(name, jd) * rec.spinSign;
        if (rec.clouds) rec.clouds.rotation.y = cloudAngle(jd);
      }
      updateMoonPositions(jd);
      if (bodies.earth) {
        // Direction from Earth to the Sun (at the origin), in view space for the shader.
        earthSunDir.value.copy(bodies.earth.group.position).negate();
        if (earthSunDir.value.lengthSq() > 0) {
          earthSunDir.value.normalize().transformDirection(camera.matrixWorldInverse);
        }
      }
      const moonRec = bodies.moon;
      const moon = b.moon;
      if (moonRec && moon && bodies.earth) {
        earthScene.copy(bodies.earth.group.position);
        moonDir.set(moon.x, moon.z, -moon.y);
        const len = moonDir.length();
        if (len > 0) moonDir.multiplyScalar(moonSceneDistance() / len);
        moonRec.group.position.copy(earthScene).add(moonDir);
        if (!orientMoon(moonRec, jd)) moonRec.spin.rotation.y = spinAngle('moon', jd) * moonRec.spinSign;
      }
      if (bodies.sun) bodies.sun.spin.rotation.y = spinAngle('sun', jd) * bodies.sun.spinSign;
    }

    function updateSun(elapsedSeconds) {
      if (sky.stars && sky.stars.material && sky.stars.material.uniforms && sky.stars.material.uniforms.uTime) {
        sky.stars.material.uniforms.uTime.value = elapsedSeconds;
      }
      if (sun.material && sun.material.uniforms && sun.material.uniforms.uTime) sun.material.uniforms.uTime.value = elapsedSeconds;
      if (sun.corona) {
        sun.corona.quaternion.copy(camera.quaternion);
        if (sun.coronaMaterial && sun.coronaMaterial.uniforms && sun.coronaMaterial.uniforms.uTime) sun.coronaMaterial.uniforms.uTime.value = elapsedSeconds;
      }
    }

    // ---- Frame loop -----------------------------------------------------------------

    let lastFrameTime = null;
    let lastHeadlineJd = NaN;
    let currentSource = 'keplerian';

    function frame(timeMs) {
      const now = performance.now();
      const dt = lastFrameTime == null ? 0 : Math.min(0.1, (timeMs - lastFrameTime) / 1000);
      lastFrameTime = timeMs;

      advanceTime(dt);
      maintainPrecision(now);

      const positions = computePositions(state.jd);
      currentSource = positions.source;
      updateBodies(positions, state.jd);
      updateOrbits(false);
      updateSun(timeMs / 1000);
      updateBelts(state.jd);

      updateCamera(now);
      controls.update();
      updateNearPlane();

      updateZodiac(state.jd, positions);   // after the camera: the wheel's world radius depends on it
      updateScreenPositions();
      updateZodiacLabelPositions();
      updateMoonSystems();
      updateMoonOrbitVisibility();
      updateLabels();

      if (state.jd !== lastHeadlineJd) {
        updateDateHeadline();
        lastHeadlineJd = state.jd;
      }
      if (now - state.lastInfoUpdate >= INFO_UPDATE_MS) {
        state.lastInfoUpdate = now;
        updateInfoPanel(positions, currentSource);
        if (state.playing && now - state.lastInputSync >= 250) {
          state.lastInputSync = now;
          syncTimeInputs(false);
        }
      }

      if (renderer.domElement.width > 0 && renderer.domElement.height > 0) composer.render();
    }

    // ---- Loading ------------------------------------------------------------------

    function setProgress(fraction, text) {
      if (dom.loadingBar) dom.loadingBar.style.width = (clamp(fraction, 0, 1) * 100).toFixed(1) + '%';
      if (dom.loadingStatus && text != null) dom.loadingStatus.textContent = text;
    }

    function nextTick() {
      return new Promise((resolve) => setTimeout(resolve, 0));
    }

    async function boot() {
      const steps = SCENE_BODIES.length + MOON_NAMES.length + 3;
      let done = 0;
      setProgress(0, 'Initialising renderer');
      await nextTick();

      if (Vis && typeof Vis.init === 'function') {
        try { Vis.init(THREE); } catch (err) { console.warn('OrreryVisuals.init failed', err); }
      }
      done++;
      setProgress(done / steps, 'Scattering the stars');
      await nextTick();
      buildSky();
      done++;

      for (const name of SCENE_BODIES) {
        setProgress(done / steps, 'Painting ' + DISPLAY_NAME[name] + '...');
        await nextTick();
        let tex = null;
        try {
          if (name === 'sun') {
            buildSun(null);
          } else {
            tex = safeTextures(name);
            buildBody(name, tex);
          }
        } catch (err) {
          console.warn('Failed to build ' + name + ' with textures; retrying with flat color', err);
          try { if (name === 'sun') buildSun(null); else buildBody(name, null); } catch (err2) { console.error('Could not build ' + name, err2); }
        }
        done++;
      }

      // Planet moons go after their parents so each system group has a planet to hang from.
      for (const entry of moonOrder) {
        const sys = buildMoonSystem(entry.planet);
        if (!sys) { done += entry.names.length; continue; }
        for (const name of entry.names) {
          setProgress(done / steps, 'Painting ' + DISPLAY_NAME[name] + '...');
          await nextTick();
          try {
            buildMoon(sys, name, safeTextures(name));
          } catch (err) {
            console.warn('Failed to build ' + name + ' with textures; retrying with flat color', err);
            try { if (!bodies[name]) buildMoon(sys, name, null); } catch (err2) { console.error('Could not build ' + name, err2); }
          }
          done++;
        }
      }

      setProgress(done / steps, 'Tracing orbits');
      await nextTick();
      for (const name of PLANETS) buildOrbit(name);
      updateOrbits(true);
      buildBelt();
      buildKuiperBelt();
      buildLabels();
      buildZodiacDisc();
      buildZodiacMarkers();
      wheelReady = true;
      updateWheelLayout();
      done++;

      wireUI();
      applyBodyVisibility();
      applyOrbitVisibility();
      applyRadii();

      camera.position.copy(presetPosition('default', new THREE.Vector3()));
      controls.target.set(0, 0, 0);
      controls.update();

      setProgress(1, 'Ready');
      probeBackend();
      renderer.setAnimationLoop(frame);

      await new Promise((resolve) => setTimeout(resolve, 250));
      dom.loading.classList.add('fade');
      setTimeout(() => {
        if (dom.loading && dom.loading.parentNode) dom.loading.parentNode.removeChild(dom.loading);
        loadEarthImagery();
        loadMoonImagery();
      }, 1000);
    }

    boot().catch((err) => {
      console.error(err);
      if (dom.loadingStatus) {
        dom.loadingStatus.textContent = 'The orrery could not start: ' + (err && err.message ? err.message : err);
        dom.loadingStatus.classList.add('error');
      }
    });
  }

  window.startOrrery = startOrrery;
})();
