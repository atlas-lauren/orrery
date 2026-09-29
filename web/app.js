/*
 * Orrery web application.
 *
 * Classic script (no modules). Exposes a single global, window.startOrrery(bundle),
 * which the inline bootstrap module in index.html calls once three.js and its addons
 * have loaded. Depends on window.Ephemeris (ephemeris.js) and, optionally,
 * window.OrreryVisuals (visuals.js); every visuals call is guarded so the app still
 * runs with plain materials if a generator is missing or throws.
 *
 * Sections: constants, calendar helpers, startOrrery (state, scene setup, bodies,
 * orbits, precision mode, camera, UI, frame loop).
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
  const INFO_BODIES = PLANETS.concat(['moon']);
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

  // Obliquity relative to the ecliptic, degrees (for the planets this equals the
  // obliquity to their own orbit to within their small inclinations; the Moon's
  // value is its obliquity to the ecliptic per Cassini's laws, not the 6.7 degrees
  // it is tilted to its own orbit). Applied as a rotation about the scene X axis,
  // which is only an approximation of the true pole direction (exact for no body
  // but a reasonable one for Earth, whose pole projects toward ecliptic longitude 90).
  const AXIAL_TILT_DEG = {
    sun: 7.25, mercury: 0.03, venus: 177.4, earth: 23.44, mars: 25.19, jupiter: 3.13,
    saturn: 26.73, uranus: 97.77, neptune: 28.32, pluto: 122.5, moon: 1.54
  };
  // Sidereal rotation periods in days. The sign convention of the source table marks
  // retrograde rotators negative; because Venus, Uranus and Pluto already carry an
  // obliquity above 90 degrees, spinning positively about the tilted axis reproduces
  // their retrograde motion, so the absolute value is used.
  const ROTATION_PERIOD_DAYS = {
    sun: 25.38, mercury: 58.646, venus: -243.02, earth: 0.99727, mars: 1.02596, jupiter: 0.41354,
    saturn: 0.44401, uranus: -0.71833, neptune: 0.67125, pluto: -6.3872, moon: 27.32
  };

  const MAJOR_BODIES = new Set(['sun', 'venus', 'earth', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune']);

  const ATMOSPHERES = {
    earth: { color: 0x5fb2ff, power: 3.0, intensity: 1.0 },
    venus: { color: 0xf3d9a4, power: 3.4, intensity: 0.6 },
    mars: { color: 0xffa070, power: 4.0, intensity: 0.3 },
    jupiter: { color: 0xe3ceb0, power: 4.5, intensity: 0.28 },
    saturn: { color: 0xf1e2bc, power: 4.5, intensity: 0.24 },
    uranus: { color: 0xa8ecf5, power: 3.6, intensity: 0.5 },
    neptune: { color: 0x7090ff, power: 3.6, intensity: 0.55 }
  };
  const RINGS = {
    saturn: { inner: 1.35, outer: 2.3 },
    uranus: { inner: 1.6, outer: 2.0 }
  };

  const DEFAULT_COLOR = {
    sun: 0xffc46b, mercury: 0x9a9a9a, venus: 0xe8c48a, earth: 0x5c9cff, moon: 0xc9c9c9, mars: 0xe0713c,
    jupiter: 0xd9b48c, saturn: 0xe6d3a2, uranus: 0x9fe0ea, neptune: 0x5f7fff, pluto: 0xc8b7a6
  };

  const ZODIAC = ['Aries', 'Taurus', 'Gemini', 'Cancer', 'Leo', 'Virgo', 'Libra', 'Scorpio', 'Sagittarius', 'Capricorn', 'Aquarius', 'Pisces'];
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  const CAMERA_FOV = 45;
  const CAMERA_NEAR = 0.05;          // initial value; frame() rescales it with the orbit distance
  const CAMERA_FAR = 20000;
  const NEAR_FRACTION = 0.004;       // near plane = orbit distance * this, clamped below
  const NEAR_MIN = 0.005;
  const NEAR_MAX = 2;
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
    full: { elevation: 45, azimuth: 0, au: 32, mult: 1.55 },
    top: { elevation: 89.9, azimuth: 0, au: 32, mult: 1.35 },
    edge: { elevation: 1.5, azimuth: 0, au: 32, mult: 1.5 }
  };

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

  function weekdayName(jd) {
    const w = ((Math.floor(jd + 1.5) % 7) + 7) % 7;
    return WEEKDAYS[w];
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
    if (!Eph) throw new Error('window.Ephemeris is not available');

    const JD_MIN = Eph.range.jdMin;
    const JD_MAX = Eph.range.jdMax;

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
      optMilkyWay: $('opt-milkyway'),
      optBloom: $('opt-bloom'),
      bloomStrength: $('bloom-strength'),
      optTrueScale: $('opt-truescale'),
      optTrueSize: $('opt-truesize'),
      optPluto: $('opt-pluto'),
      optMoon: $('opt-moon'),
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
      showMilkyWay: true,
      showPluto: true,
      showMoon: true,
      focus: null,             // body name being followed, or null for the Sun
      hover: null,             // body name under the pointer
      lastJdChangeAt: 0,       // performance.now() of the last jd change
      lastInfoUpdate: 0,
      lastInputSync: 0,
      fineScrub: false,
      infoPanelUserSet: false
    };
    state.jd = clamp(state.jd, JD_MIN, JD_MAX);

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

    // ---- Distance mapping -------------------------------------------------------

    function mapDistance(rAu) {
      if (rAu <= 0) return 0;
      return state.trueScale ? DISTANCE_SCALE * rAu : DISTANCE_SCALE * Math.pow(rAu, COMPRESSED_EXPONENT);
    }

    // Ecliptic (x, y, z) in AU -> scene vector (sceneX = ex, sceneY = ez, sceneZ = -ey)
    // with the radial distance mapped through mapDistance.
    function toScene(p, out) {
      const r = Math.sqrt(p.x * p.x + p.y * p.y + p.z * p.z);
      const s = r > 0 ? mapDistance(r) / r : 0;
      return out.set(p.x * s, p.z * s, -p.y * s);
    }

    function bodyRadius(name) {
      if (state.trueSize) return TRUE_SIZE_EARTH * REAL_RADIUS_KM[name] / REAL_RADIUS_KM.earth;
      return VISUAL_RADIUS[name];
    }

    function accentOf(name) {
      const style = Vis && Vis.PLANET_STYLE && Vis.PLANET_STYLE[name];
      if (style && typeof style.color === 'number') return style.color;
      return DEFAULT_COLOR[name];
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
      const near = clamp(d * NEAR_FRACTION, NEAR_MIN, NEAR_MAX);
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
    }
    window.addEventListener('resize', onResize);

    // ---- Sky -------------------------------------------------------------------

    const sky = { stars: null, milkyWay: null, belt: null };

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

    function buildBelt() {
      if (sky.belt) {
        scene.remove(sky.belt);
        if (sky.belt.geometry) sky.belt.geometry.dispose();
        if (sky.belt.material) sky.belt.material.dispose();
        sky.belt = null;
      }
      const inner = mapDistance(2.2);
      const outer = mapDistance(3.3);
      sky.belt = visualsCall('asteroidBelt', [inner, outer, 4000], () => fallbackBelt(inner, outer, 4000));
      if (sky.belt) {
        sky.belt.name = 'asteroid-belt';
        sky.belt.visible = state.showBelt;
        scene.add(sky.belt);
      }
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
        if (params.emissiveMap) {
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

    function buildBody(name, tex) {
      const accent = accentOf(name);
      const radius = bodyRadius(name);
      const segments = MAJOR_BODIES.has(name) ? [96, 64] : [48, 32];

      const group = new THREE.Group();
      group.name = name;
      const tilt = new THREE.Group();
      tilt.rotation.x = -AXIAL_TILT_DEG[name] * DEG;
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
        name, group, tilt, spin, mesh, material, accent, radius,
        clouds: null, atmosphere: null, rings: null, pick: null, marker: null,
        label: null, visible: true, screen: { x: 0, y: 0, r: 0, visible: false }
      };

      if (name === 'earth' && tex && tex.cloudsMap) {
        const cloudMat = new THREE.MeshStandardMaterial({
          map: tex.cloudsMap, transparent: true, depthWrite: false, roughness: 1, metalness: 0, opacity: 0.85
        });
        const clouds = new THREE.Mesh(new THREE.SphereGeometry(1.012, 96, 64), cloudMat);
        clouds.name = 'earth-clouds';
        clouds.renderOrder = 1;
        tilt.add(clouds);
        record.clouds = clouds;
      }

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

      scene.add(group);
      bodies[name] = record;
      bodyList.push(record);
      return record;
    }

    function buildSun(tex) {
      const radius = bodyRadius('sun');
      const group = new THREE.Group();
      group.name = 'sun';
      const tilt = new THREE.Group();
      tilt.rotation.x = -AXIAL_TILT_DEG.sun * DEG;
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
        name: 'sun', group, tilt, spin, mesh, material, accent: accentOf('sun'), radius,
        clouds: null, atmosphere: null, rings: null, pick, marker: null,
        label: null, visible: true, screen: { x: 0, y: 0, r: 0, visible: false }
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
        if (rec.marker) rec.marker.visible = state.trueSize && rec.visible;
      }
      if (sun.corona) {
        const r = bodyRadius('sun');
        sun.corona.scale.set(2.6 * 2 * r, 2.6 * 2 * r, 1);
      }
    }

    function applyBodyVisibility() {
      const plutoRec = bodies.pluto;
      const moonRec = bodies.moon;
      if (plutoRec) { plutoRec.visible = state.showPluto; plutoRec.group.visible = state.showPluto; }
      if (moonRec) { moonRec.visible = state.showMoon; moonRec.group.visible = state.showMoon; }
      if (orbits.pluto) orbits.pluto.line.visible = state.showOrbits && state.showPluto;
      for (const rec of bodyList) {
        if (rec.marker) rec.marker.visible = state.trueSize && rec.visible;
        if (rec.label) rec.label.classList.toggle('hidden', !rec.visible);
      }
      if (state.focus && bodies[state.focus] && !bodies[state.focus].visible) setFocus(null);
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
    }

    function applyOrbitVisibility() {
      for (const name of PLANETS) {
        const o = orbits[name];
        if (!o) continue;
        o.line.visible = state.showOrbits && (name !== 'pluto' || state.showPluto);
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
      if (!precision.enabled || precision.inflight) return;
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

    async function probeBackend() {
      if (!precision.enabled) return;
      try {
        const res = await fetch('api/range', { cache: 'no-store' });
        if (!res.ok) { disablePrecision('no /api/range (HTTP ' + res.status + ')'); return; }
        const data = await res.json();
        if (data && data.ephemeris) precision.ephemeris = data.ephemeris;
        precision.checked = true;
      } catch (err) {
        disablePrecision('backend unreachable');
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

    // ---- Date display and inputs ------------------------------------------------

    function updateDateHeadline() {
      const c = Eph.civilFromJd(state.jd);
      const dayText = weekdayName(state.jd) + ', ' + c.day + ' ' + MONTHS[c.month - 1] + ' ';
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
      const time = pad2(c.hour) + ':' + pad2(c.minute) + ' UTC';
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

    function updateEraHint() {
      const y = parseInt(dom.inYear.value, 10);
      if (Number.isNaN(y)) { dom.eraHint.textContent = ''; return; }
      dom.eraHint.textContent = y <= 0 ? '= ' + (1 - y) + ' BCE' : 'CE';
    }

    function syncTimeInputs(force) {
      if (!force && fieldsFocused()) return;
      const c = Eph.civilFromJd(state.jd);
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
      setJd(Eph.jdFromCivil(y, mo, d, h, mi, 0));
      syncTimeInputs(true);
    }

    function applyDatetimeLocal() {
      const v = dom.inDatetime.value;
      if (!v) return;
      const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(v);
      if (!m) return;
      setPlaying(false);
      setJd(Eph.jdFromCivil(+m[1], +m[2], +m[3], +m[4], +m[5], 0));
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
        el.className = 'label';
        el.style.setProperty('--label-color', hexColor(rec.accent));
        el.textContent = DISPLAY_NAME[rec.name];
        el.style.display = 'none';
        el.addEventListener('click', (ev) => { ev.stopPropagation(); setFocus(rec.name === 'sun' ? null : rec.name); });
        dom.labels.appendChild(el);
        rec.label = el;
        rec.labelBox = { w: 0, h: 0 };
        rec.labelSlot = { dir: 0, ring: 0 };
      }
      dom.labels.classList.toggle('off', !state.showLabels);
      measureLabels();
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(measureLabels);
    }

    function measureLabels() {
      for (const rec of bodyList) {
        const el = rec.label;
        if (!el) continue;
        const wasHidden = el.style.display === 'none';
        if (wasHidden) el.style.display = '';
        rec.labelBox.w = el.offsetWidth;
        rec.labelBox.h = el.offsetHeight;
        if (wasHidden) el.style.display = 'none';
      }
    }

    const projV = new THREE.Vector3();
    const worldV = new THREE.Vector3();

    function updateScreenPositions() {
      const w = renderer.domElement.clientWidth;
      const h = renderer.domElement.clientHeight;
      const tanHalf = Math.tan(camera.fov * 0.5 * DEG);
      for (const rec of bodyList) {
        rec.group.getWorldPosition(worldV);
        const dist = worldV.distanceTo(camera.position);
        projV.copy(worldV).project(camera);
        const s = rec.screen;
        s.visible = rec.visible && projV.z < 1 && projV.z > -1 && Math.abs(projV.x) < 1.6 && Math.abs(projV.y) < 1.6;
        s.x = (projV.x * 0.5 + 0.5) * w;
        s.y = (-projV.y * 0.5 + 0.5) * h;
        s.r = dist > 0 ? (rec.radius / (dist * tanHalf)) * (h * 0.5) : 0;
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

    function slotFree(rec, rect, placed, w, h) {
      if (rect.x < 2 || rect.y < 2 || rect.x + rect.w > w - 2 || rect.y + rect.h > h - 2) return false;
      for (const p of placed) if (rectsOverlap(rect, p, LABEL_MARGIN)) return false;
      for (const other of bodyList) {
        if (other === rec || !other.screen.visible) continue;
        if (rectHitsDisc(rect, other.screen.x, other.screen.y, Math.max(other.screen.r, 2) + 2)) return false;
      }
      return true;
    }

    const labelOrder = [];
    const placedRects = [];
    const tmpRect = { x: 0, y: 0, w: 0, h: 0 };

    function hideLabel(rec) {
      rec.label.style.display = 'none';
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
        if (!rec.screen.visible) { hideLabel(rec); continue; }
        if (rec.labelBox.w === 0) measureLabels();
        labelOrder.push(rec);
      }
      labelOrder.sort((a, b) => {
        if (a.name === state.focus) return -1;
        if (b.name === state.focus) return 1;
        return b.screen.r - a.screen.r;
      });
      placedRects.length = 0;
      for (const rec of labelOrder) {
        const slot = rec.labelSlot;
        let found = false;
        labelRect(rec, slot.dir, slot.ring, tmpRect);
        if (slotFree(rec, tmpRect, placedRects, w, h)) {
          found = true;
        } else {
          search: for (let ring = 0; ring < LABEL_RINGS.length; ring++) {
            for (let di = 0; di < LABEL_DIRS.length; di++) {
              labelRect(rec, di, ring, tmpRect);
              if (slotFree(rec, tmpRect, placedRects, w, h)) { slot.dir = di; slot.ring = ring; found = true; break search; }
            }
          }
        }
        if (!found) { hideLabel(rec); continue; }
        placedRects.push({ x: tmpRect.x, y: tmpRect.y, w: tmpRect.w, h: tmpRect.h });
        const el = rec.label;
        el.style.display = '';
        el.style.transform = 'translate(' + tmpRect.x.toFixed(1) + 'px, ' + tmpRect.y.toFixed(1) + 'px)';
        el.classList.toggle('selected', state.focus === rec.name);
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

    function setFocus(name) {
      const rec = name ? bodies[name] : null;
      const changed = state.focus !== (rec ? name : null);
      state.focus = rec ? name : null;
      for (const key in rowByName) rowByName[key].classList.toggle('selected', key === state.focus);
      if (rec) {
        dom.focusChip.hidden = false;
        dom.focusName.textContent = DISPLAY_NAME[name];
        controls.minDistance = Math.min(2, rec.radius * 2.5);
        const dir = camera.position.clone().sub(controls.target);
        if (dir.lengthSq() < 1e-8) dir.set(0, 0.6, 1);
        dir.normalize();
        const dist = Math.max(rec.radius * 6, controls.minDistance * 1.5);
        startTween(dir.multiplyScalar(dist), changed ? 1100 : 700);
      } else {
        dom.focusChip.hidden = true;
        controls.minDistance = 2;
        if (changed) applyPreset('default', 1100);
      }
    }

    function applyPreset(preset, duration) {
      const offset = presetPosition(preset, new THREE.Vector3());
      startTween(offset, duration == null ? 1000 : duration);
    }

    function resetView() {
      state.focus = null;
      dom.focusChip.hidden = true;
      controls.minDistance = 2;
      for (const key in rowByName) rowByName[key].classList.remove('selected');
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
      for (const name of INFO_BODIES) {
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
    }

    function setText(el, text) {
      if (el.textContent !== text) el.textContent = text;
    }

    function updateInfoPanel(positions, source) {
      const b = positions.bodies;
      const earth = b.earth;
      for (const name of INFO_BODIES) {
        const p = b[name];
        const parts = rowParts[name];
        if (!p || !parts) continue;
        const zt = zodiacText(p.lon);
        const sp = zt.indexOf(' ');
        setText(parts.sign, zt.slice(0, sp));
        if (name === 'moon') {
          setText(parts.lonVal, zt.slice(sp + 1) + '  (' + p.lon.toFixed(2) + '° geocentric)');
          setText(parts.dSun, 'From Earth ' + Math.round(p.r * AU_KM).toLocaleString('en-US') + ' km');
          setText(parts.dEarth, '');
          continue;
        }
        setText(parts.lonVal, zt.slice(sp + 1) + '  (' + p.lon.toFixed(2) + '°)');
        setText(parts.dSun, 'Sun ' + p.r.toFixed(3) + ' AU');
        if (name === 'earth') {
          setText(parts.dEarth, 'Earth —');
        } else if (earth) {
          const d = Math.sqrt((p.x - earth.x) ** 2 + (p.y - earth.y) ** 2 + (p.z - earth.z) ** 2);
          setText(parts.dEarth, 'Earth ' + d.toFixed(3) + ' AU');
        }
      }
      let badge;
      let cls = 'badge';
      if (source === 'exact') { badge = prettyEphemeris(precision.ephemeris) + ' (exact)'; cls += ' exact'; }
      else if (source === 'anchored') { badge = prettyEphemeris(precision.ephemeris) + ' (exact anchor)'; cls += ' anchored'; }
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
      buildTimeline();
      buildInfoRows();
      setPlaying(state.playing);
      setDirection(state.direction);
      dom.inYear.min = String(Eph.civilFromJd(JD_MIN).year);
      dom.inYear.max = String(Eph.civilFromJd(JD_MAX).year);
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
      dom.optMilkyWay.addEventListener('change', () => { state.showMilkyWay = dom.optMilkyWay.checked; if (sky.milkyWay) sky.milkyWay.visible = state.showMilkyWay; });
      dom.optBloom.addEventListener('change', () => { bloomPass.enabled = dom.optBloom.checked; });
      dom.bloomStrength.addEventListener('input', () => { bloomPass.strength = parseFloat(dom.bloomStrength.value); });
      dom.optTrueScale.addEventListener('change', () => {
        state.trueScale = dom.optTrueScale.checked;
        updateOrbits(true);
        buildBelt();
        if (!state.focus) applyPreset('default', 900);
      });
      dom.optTrueSize.addEventListener('change', () => {
        state.trueSize = dom.optTrueSize.checked;
        applyRadii();
        if (state.focus) setFocus(state.focus);
      });
      dom.optPluto.addEventListener('change', () => { state.showPluto = dom.optPluto.checked; applyBodyVisibility(); applyOrbitVisibility(); });
      dom.optMoon.addEventListener('change', () => { state.showMoon = dom.optMoon.checked; applyBodyVisibility(); });
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
      dom.optMilkyWay.checked = state.showMilkyWay;
      dom.optBloom.checked = true;
      dom.bloomStrength.value = String(bloomPass.strength);
      dom.optTrueScale.checked = state.trueScale;
      dom.optTrueSize.checked = state.trueSize;
      dom.optPluto.checked = state.showPluto;
      dom.optMoon.checked = state.showMoon;
      if (window.innerWidth < 760) setInfoPanel(false); else setInfoPanel(true);
    }

    // ---- Per-frame body update ---------------------------------------------------------

    const earthScene = new THREE.Vector3();
    const moonDir = new THREE.Vector3();
    const MOON_MEAN_DISTANCE_EARTH_RADII = 60.3;
    const CLOUD_PERIOD_DAYS = ROTATION_PERIOD_DAYS.earth / 1.03;   // clouds drift slightly faster than the ground

    function spinAngle(name, jd) {
      const period = Math.abs(ROTATION_PERIOD_DAYS[name]);
      const turns = (jd - J2000) / period;
      return TWO_PI * (turns - Math.floor(turns));
    }

    function cloudAngle(jd) {
      const turns = (jd - J2000) / CLOUD_PERIOD_DAYS;
      return TWO_PI * (turns - Math.floor(turns)) + 0.4;
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
        rec.spin.rotation.y = spinAngle(name, jd);
        if (rec.clouds) rec.clouds.rotation.y = cloudAngle(jd);
      }
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
        moonRec.spin.rotation.y = spinAngle('moon', jd);
      }
      if (bodies.sun) bodies.sun.spin.rotation.y = spinAngle('sun', jd);
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

      updateCamera(now);
      controls.update();
      updateNearPlane();

      updateScreenPositions();
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
      const steps = SCENE_BODIES.length + 3;
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

      setProgress(done / steps, 'Tracing orbits');
      await nextTick();
      for (const name of PLANETS) buildOrbit(name);
      updateOrbits(true);
      buildBelt();
      buildLabels();
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
      setTimeout(() => { if (dom.loading && dom.loading.parentNode) dom.loading.parentNode.removeChild(dom.loading); }, 1000);
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
