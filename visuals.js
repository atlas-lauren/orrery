/*
 * visuals.js - procedural textures, shaders and sky for the orrery.
 *
 * Classic script (no import/export). Attaches window.OrreryVisuals.
 * Call OrreryVisuals.init(THREE) once before using anything that needs three.js.
 *
 * Every texture is generated on a canvas at runtime from seeded noise; there are
 * no external image assets. The pure pixel generators live under
 * OrreryVisuals.pixels and can run without THREE or a DOM (used by the tests).
 */
(function (global) {
  'use strict';

  var THREE = null;
  var TAU = Math.PI * 2;

  /* ------------------------------------------------------------------ */
  /* Noise toolkit                                                       */
  /* ------------------------------------------------------------------ */

  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function hash2(x, y, seed) {
    var h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 2246822519);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  var GRAD3 = new Float32Array([
    1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0,
    1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1,
    0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1
  ]);
  var F3 = 1 / 3, G3 = 1 / 6;

  /* Seeded 3D simplex noise (Gustavson / Ashima style). Returns roughly [-1, 1]. */
  function makeNoise(seed) {
    var rng = mulberry32(seed);
    var p = new Uint8Array(256);
    var i, j, t;
    for (i = 0; i < 256; i++) p[i] = i;
    for (i = 255; i > 0; i--) {
      j = Math.floor(rng() * (i + 1));
      t = p[i]; p[i] = p[j]; p[j] = t;
    }
    var perm = new Uint8Array(512);
    var permMod = new Uint8Array(512);
    for (i = 0; i < 512; i++) {
      perm[i] = p[i & 255];
      permMod[i] = (perm[i] % 12) * 3;
    }
    return function noise3(xin, yin, zin) {
      var n0 = 0, n1 = 0, n2 = 0, n3 = 0;
      var s = (xin + yin + zin) * F3;
      var i0 = Math.floor(xin + s), j0 = Math.floor(yin + s), k0 = Math.floor(zin + s);
      var tt = (i0 + j0 + k0) * G3;
      var x0 = xin - (i0 - tt), y0 = yin - (j0 - tt), z0 = zin - (k0 - tt);
      var i1, j1, k1, i2, j2, k2;
      if (x0 >= y0) {
        if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
        else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; }
        else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; }
      } else {
        if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; }
        else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; }
        else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
      }
      var x1 = x0 - i1 + G3, y1 = y0 - j1 + G3, z1 = z0 - k1 + G3;
      var x2 = x0 - i2 + 2 * G3, y2 = y0 - j2 + 2 * G3, z2 = z0 - k2 + 2 * G3;
      var x3 = x0 - 1 + 3 * G3, y3 = y0 - 1 + 3 * G3, z3 = z0 - 1 + 3 * G3;
      var ii = i0 & 255, jj = j0 & 255, kk = k0 & 255;
      var g, t0 = 0.6 - x0 * x0 - y0 * y0 - z0 * z0;
      if (t0 > 0) {
        g = permMod[ii + perm[jj + perm[kk]]];
        t0 *= t0; n0 = t0 * t0 * (GRAD3[g] * x0 + GRAD3[g + 1] * y0 + GRAD3[g + 2] * z0);
      }
      var t1 = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;
      if (t1 > 0) {
        g = permMod[ii + i1 + perm[jj + j1 + perm[kk + k1]]];
        t1 *= t1; n1 = t1 * t1 * (GRAD3[g] * x1 + GRAD3[g + 1] * y1 + GRAD3[g + 2] * z1);
      }
      var t2 = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;
      if (t2 > 0) {
        g = permMod[ii + i2 + perm[jj + j2 + perm[kk + k2]]];
        t2 *= t2; n2 = t2 * t2 * (GRAD3[g] * x2 + GRAD3[g + 1] * y2 + GRAD3[g + 2] * z2);
      }
      var t3 = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;
      if (t3 > 0) {
        g = permMod[ii + 1 + perm[jj + 1 + perm[kk + 1]]];
        t3 *= t3; n3 = t3 * t3 * (GRAD3[g] * x3 + GRAD3[g + 1] * y3 + GRAD3[g + 2] * z3);
      }
      return 32 * (n0 + n1 + n2 + n3);
    };
  }

  /* Fractal Brownian motion of 3D noise, roughly [-1, 1]. */
  function fbm(noise, x, y, z, octaves, lacunarity, gain) {
    var sum = 0, amp = 1, norm = 0, i;
    for (i = 0; i < octaves; i++) {
      sum += amp * noise(x, y, z);
      norm += amp;
      amp *= gain;
      x *= lacunarity; y *= lacunarity; z *= lacunarity;
    }
    return sum / norm;
  }

  /* Ridged multifractal, [0, 1], sharp bright ridges. */
  function ridged(noise, x, y, z, octaves, lacunarity, gain) {
    var sum = 0, amp = 1, norm = 0, i, n;
    for (i = 0; i < octaves; i++) {
      n = 1 - Math.abs(noise(x, y, z));
      n = n * n;
      sum += amp * n;
      norm += amp;
      amp *= gain;
      x *= lacunarity; y *= lacunarity; z *= lacunarity;
    }
    return sum / norm;
  }

  /* Domain-warped fbm: fbm evaluated at a point displaced by another fbm. */
  function warped(noise, x, y, z, warpAmt, octaves) {
    var qx = fbm(noise, x + 1.7, y + 9.2, z + 3.1, 3, 2.0, 0.5);
    var qy = fbm(noise, x + 8.3, y + 2.8, z + 5.6, 3, 2.0, 0.5);
    var qz = fbm(noise, x + 4.1, y + 6.4, z + 0.7, 3, 2.0, 0.5);
    return fbm(noise, x + warpAmt * qx, y + warpAmt * qy, z + warpAmt * qz, octaves, 2.0, 0.5);
  }

  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function smoothstep(a, b, x) {
    var t = clamp01((x - a) / (b - a));
    return t * t * (3 - 2 * t);
  }
  function mix3(a, b, t, out) {
    out[0] = a[0] + (b[0] - a[0]) * t;
    out[1] = a[1] + (b[1] - a[1]) * t;
    out[2] = a[2] + (b[2] - a[2]) * t;
    return out;
  }
  function put(px, idx, r, g, b, a) {
    px[idx] = r * 255; px[idx + 1] = g * 255; px[idx + 2] = b * 255; px[idx + 3] = a === undefined ? 255 : a * 255;
  }

  /* Multi-stop gradient keyed on t in [0,1]; stops = [[t, [r,g,b]], ...] ascending. */
  function gradient(stops, t, out) {
    var n = stops.length, i;
    if (t <= stops[0][0]) { out[0] = stops[0][1][0]; out[1] = stops[0][1][1]; out[2] = stops[0][1][2]; return out; }
    for (i = 1; i < n; i++) {
      if (t <= stops[i][0]) {
        var s0 = stops[i - 1], s1 = stops[i];
        var f = (t - s0[0]) / (s1[0] - s0[0]);
        f = f * f * (3 - 2 * f);
        return mix3(s0[1], s1[1], f, out);
      }
    }
    out[0] = stops[n - 1][1][0]; out[1] = stops[n - 1][1][1]; out[2] = stops[n - 1][1][2];
    return out;
  }

  /*
   * Sphere-sampled loop helper. Calls fn(px, py, pz, lat, lon, x, y, idx) for each pixel,
   * where (px,py,pz) is the unit-sphere point for that texel (so textures are seamless
   * horizontally and free of polar pinching) and lat/lon are in radians.
   */
  function forEachTexel(w, h, fn) {
    var cosLat = new Float64Array(h), sinLat = new Float64Array(h), lats = new Float64Array(h);
    var cosLon = new Float64Array(w), sinLon = new Float64Array(w), lons = new Float64Array(w);
    var x, y;
    for (y = 0; y < h; y++) {
      lats[y] = (0.5 - (y + 0.5) / h) * Math.PI;
      cosLat[y] = Math.cos(lats[y]); sinLat[y] = Math.sin(lats[y]);
    }
    for (x = 0; x < w; x++) {
      lons[x] = ((x + 0.5) / w) * TAU;
      cosLon[x] = Math.cos(lons[x]); sinLon[x] = Math.sin(lons[x]);
    }
    var idx = 0;
    for (y = 0; y < h; y++) {
      var cl = cosLat[y], sl = sinLat[y], la = lats[y];
      for (x = 0; x < w; x++) {
        fn(cl * cosLon[x], cl * sinLon[x], sl, la, lons[x], x, y, idx);
        idx += 4;
      }
    }
  }

  /*
   * Rasterize craters into a Float32Array height field (w*h) in equirectangular space.
   * Each crater is a bowl with a raised rim; sizes are angular radii in radians.
   * Craters near the poles stretch horizontally, as they should on an equirectangular map.
   */
  function stampCraters(height, w, h, rng, count, rMin, rMax, depthScale) {
    var c, cx, cy, r, lat, lon, cosLat, ry, rx, x0, x1, y0, y1, x, y, dx, dy, d, v, xx, i;
    for (c = 0; c < count; c++) {
      lon = rng() * TAU;
      lat = Math.asin(rng() * 2 - 1);
      r = rMin + (rMax - rMin) * Math.pow(rng(), 2.2);
      cosLat = Math.max(0.08, Math.cos(lat));
      cx = lon / TAU * w;
      cy = (0.5 - lat / Math.PI) * h;
      ry = r / Math.PI * h * 1.35;
      rx = ry / cosLat;
      if (rx > w * 0.5) rx = w * 0.5;
      x0 = Math.floor(cx - rx); x1 = Math.ceil(cx + rx);
      y0 = Math.max(0, Math.floor(cy - ry)); y1 = Math.min(h - 1, Math.ceil(cy + ry));
      var depth = depthScale * (0.6 + 0.8 * rng());
      var rimW = 0.72 + 0.12 * rng();
      for (y = y0; y <= y1; y++) {
        dy = (y + 0.5 - cy) / ry;
        for (x = x0; x <= x1; x++) {
          dx = (x + 0.5 - cx) / rx;
          d = Math.sqrt(dx * dx + dy * dy) / 0.74;
          if (d >= 1.35) continue;
          if (d < rimW) {
            v = -1 + (d / rimW) * (d / rimW) * 0.9;          /* bowl floor */
          } else if (d < 1.0) {
            v = -0.1 + 1.0 * Math.sin(((d - rimW) / (1.0 - rimW)) * Math.PI * 0.5) * 0.55; /* rise to rim */
          } else {
            v = 0.45 * (1 - (d - 1.0) / 0.35);                 /* ejecta apron fading out */
            v = v * v * 0.9;
          }
          xx = x; if (xx < 0) xx += w; else if (xx >= w) xx -= w;
          i = y * w + xx;
          height[i] += v * depth;
        }
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Pixel generators (pure; no THREE, no DOM)                          */
  /* ------------------------------------------------------------------ */

  var pixels = {};

  /* --- Mercury: grey-brown cratered surface --------------------------- */
  pixels.mercury = function (w, h) {
    var noise = makeNoise(101), rng = mulberry32(202);
    var map = new Uint8ClampedArray(w * h * 4), bump = new Uint8ClampedArray(w * h * 4);
    var height = new Float32Array(w * h);
    var area = (w * h) / (512 * 256);
    stampCraters(height, w, h, rng, Math.round(28 * area), 0.05, 0.13, 0.7);
    stampCraters(height, w, h, rng, Math.round(160 * area), 0.018, 0.05, 0.6);
    stampCraters(height, w, h, rng, Math.round(900 * area), 0.006, 0.018, 0.5);
    var dark = [0.36, 0.34, 0.32], light = [0.62, 0.59, 0.55], warm = [0.52, 0.45, 0.38];
    var c = [0, 0, 0], c2 = [0, 0, 0];
    forEachTexel(w, h, function (px, py, pz, lat, lon, x, y, idx) {
      var base = fbm(noise, px * 3.0, py * 3.0, pz * 3.0, 5, 2.1, 0.5);
      var fine = fbm(noise, px * 18, py * 18, pz * 18, 3, 2.0, 0.5);
      var hcr = height[y * w + x];
      var t = clamp01(0.5 + base * 0.55 + fine * 0.15 + hcr * 0.35);
      mix3(dark, light, t, c);
      var warmth = smoothstep(0.1, 0.45, fbm(noise, px * 1.3 + 7, py * 1.3, pz * 1.3, 3, 2, 0.5));
      mix3(c, warm, warmth * 0.35, c2);
      var shade = 1 + hcr * 0.42;
      put(map, idx, c2[0] * shade, c2[1] * shade, c2[2] * shade);
      var b = clamp01(0.5 + hcr * 0.45 + fine * 0.12 + base * 0.1);
      put(bump, idx, b, b, b);
    });
    return { map: map, bumpMap: bump };
  };

  /* --- Moon: grey with maria and craters ------------------------------ */
  pixels.moon = function (w, h) {
    var noise = makeNoise(303), rng = mulberry32(404);
    var map = new Uint8ClampedArray(w * h * 4), bump = new Uint8ClampedArray(w * h * 4);
    var height = new Float32Array(w * h);
    var area = (w * h) / (512 * 256);
    stampCraters(height, w, h, rng, Math.round(22 * area), 0.05, 0.12, 0.65);
    stampCraters(height, w, h, rng, Math.round(140 * area), 0.018, 0.05, 0.6);
    stampCraters(height, w, h, rng, Math.round(700 * area), 0.006, 0.018, 0.5);
    var high = [0.66, 0.65, 0.62], mare = [0.30, 0.30, 0.31];
    var c = [0, 0, 0];
    forEachTexel(w, h, function (px, py, pz, lat, lon, x, y, idx) {
      var m = fbm(noise, px * 1.15, py * 1.15, pz * 1.15, 3, 2.0, 0.5);
      var nearSide = 0.5 + 0.5 * px;                 /* maria concentrated on one hemisphere */
      var mariaMask = smoothstep(0.04, 0.16, m + nearSide * 0.26 - 0.26) * (1 - smoothstep(0.9, 1.3, Math.abs(lat)));
      var fine = fbm(noise, px * 14, py * 14, pz * 14, 3, 2.0, 0.5);
      var hcr = height[y * w + x];
      mix3(high, mare, mariaMask, c);
      var shade = 1 + fine * 0.10 + hcr * (0.42 - 0.14 * mariaMask);
      put(map, idx, c[0] * shade, c[1] * shade, c[2] * shade);
      var b = clamp01(0.5 + hcr * (0.45 - 0.2 * mariaMask) + fine * 0.08 - mariaMask * 0.08);
      put(bump, idx, b, b, b);
    });
    return { map: map, bumpMap: bump };
  };

  /* --- Venus: creamy swirling sulfuric cloud deck ---------------------- */
  pixels.venus = function (w, h) {
    var noise = makeNoise(505);
    var map = new Uint8ClampedArray(w * h * 4);
    var stops = [
      [0.0, [0.66, 0.52, 0.30]],
      [0.35, [0.82, 0.70, 0.45]],
      [0.65, [0.93, 0.85, 0.62]],
      [1.0, [0.98, 0.94, 0.78]]
    ];
    var c = [0, 0, 0];
    forEachTexel(w, h, function (px, py, pz, lat, lon, x, y, idx) {
      /* chevron: streamlines lean toward the equator, so shear longitude by latitude */
      var shear = lat * 0.9;
      var cs = Math.cos(shear), sn = Math.sin(shear);
      var qx = px * cs - py * sn, qy = px * sn + py * cs;
      var v = warped(noise, qx * 2.2, qy * 2.2, pz * 4.5, 0.9, 5);
      var band = Math.sin(lat * 7.0 + v * 2.0) * 0.08;
      var t = clamp01(0.55 + v * 0.7 + band - Math.abs(lat) * 0.12);
      gradient(stops, t, c);
      put(map, idx, c[0], c[1], c[2]);
    });
    return { map: map };
  };

  /* --- Earth: continents, oceans, ice, clouds, night lights ------------ */
  pixels.earth = function (w, h) {
    var noise = makeNoise(707);
    var n = w * h;
    var map = new Uint8ClampedArray(n * 4), bump = new Uint8ClampedArray(n * 4);
    var spec = new Uint8ClampedArray(n * 4), clouds = new Uint8ClampedArray(n * 4);
    var emis = new Uint8ClampedArray(n * 4);
    var SEA = 0.10;
    var deep = [0.02, 0.09, 0.30], shallow = [0.06, 0.32, 0.52];
    var grass = [0.16, 0.36, 0.12], forest = [0.08, 0.24, 0.09], desert = [0.72, 0.60, 0.36];
    var tundra = [0.45, 0.42, 0.32], rock = [0.42, 0.38, 0.33], snow = [0.93, 0.95, 0.97];
    var c = [0, 0, 0], c2 = [0, 0, 0];
    forEachTexel(w, h, function (px, py, pz, lat, lon, x, y, idx) {
      var e = fbm(noise, px * 2.3, py * 2.3, pz * 2.3, 6, 2.05, 0.5);
      var e2 = ridged(noise, px * 5.5 + 3, py * 5.5, pz * 5.5, 4, 2.1, 0.5);
      var elev = e * 0.85 + (e2 - 0.5) * 0.3;
      var moist = fbm(noise, px * 3.1 + 40, py * 3.1, pz * 3.1, 3, 2.0, 0.5);
      var absLat = Math.abs(lat);
      var polar = smoothstep(1.02, 1.42, absLat + fbm(noise, px * 6 + 11, py * 6, pz * 6, 2, 2, 0.5) * 0.16);
      var land = elev > SEA;
      if (land) {
        var hgt = clamp01((elev - SEA) / 0.75);
        var arid = smoothstep(0.25, 0.62, absLat) * (1 - smoothstep(0.62, 0.95, absLat));
        arid = arid * (0.5 - moist * 0.9);
        mix3(grass, forest, clamp01(moist * 1.4 + 0.3), c);
        mix3(c, desert, clamp01(arid * 2.0), c2);
        mix3(c2, tundra, smoothstep(0.85, 1.15, absLat), c);
        mix3(c, rock, smoothstep(0.5, 0.85, hgt), c2);
        mix3(c2, snow, smoothstep(0.88, 1.0, hgt + absLat * 0.08), c);
        mix3(c, snow, polar, c2);
        var detail = 1 + fbm(noise, px * 24, py * 24, pz * 24, 2, 2, 0.5) * 0.08;
        put(map, idx, c2[0] * detail, c2[1] * detail, c2[2] * detail);
        var b = 0.42 + hgt * 0.5 + (e2 - 0.5) * 0.12;
        put(bump, idx, b, b, b);
        put(spec, idx, polar * 0.25, polar * 0.25, polar * 0.25);
        /* night lights: near coasts and mid-latitudes, speckled */
        var coast = 1 - smoothstep(0.0, 0.16, elev - SEA);
        var temperate = 1 - smoothstep(0.85, 1.15, absLat);
        var pop = smoothstep(0.05, 0.5, fbm(noise, px * 9 + 90, py * 9, pz * 9, 2, 2, 0.5) + coast * 0.35);
        var speck = hash2(x, y, 17);
        var dense = pop * temperate * (1 - polar) * (1 - smoothstep(0.55, 0.85, hgt));
        var light = dense * smoothstep(1 - dense * 0.7, 1.0, speck) * 1.2;
        light += dense * dense * 0.12;
        light = clamp01(light);
        put(emis, idx, light, light * 0.82, light * 0.55);
      } else {
        var depth = clamp01((SEA - elev) / 0.22);
        mix3(shallow, deep, smoothstep(0.0, 1.0, depth), c);
        mix3(c, snow, polar, c2);
        put(map, idx, c2[0], c2[1], c2[2]);
        put(bump, idx, 0.4, 0.4, 0.4);
        var s = 1 - polar * 0.7;
        put(spec, idx, s, s, s);
        put(emis, idx, 0, 0, 0);
      }
      /* clouds: stretched along latitude, more around the ITCZ and mid-latitude storm tracks */
      var cl = ridged(noise, px * 2.0 + 300, py * 2.0, pz * 5.0, 3, 2.2, 0.55);
      var cw = fbm(noise, px * 4.5 + 500, py * 4.5, pz * 10.0, 2, 2.0, 0.5);
      var belts = 0.55 + 0.25 * Math.cos(absLat * 6.0) + 0.15 * (1 - smoothstep(0.0, 0.25, absLat));
      var cover = smoothstep(0.42, 0.98, cl * 0.8 + cw * 0.35 + belts * 0.25 + (-0.05));
      var a = clamp01(cover) * 0.9;
      put(clouds, idx, 1, 1, 1, a);
    });
    return { map: map, bumpMap: bump, specularMap: spec, cloudsMap: clouds, emissiveMap: emis };
  };

  /* --- Mars: rust, basalt, canyons, dust, polar caps ------------------- */
  pixels.mars = function (w, h) {
    var noise = makeNoise(909), rng = mulberry32(910);
    var n = w * h;
    var map = new Uint8ClampedArray(n * 4), bump = new Uint8ClampedArray(n * 4);
    var height = new Float32Array(n);
    var area = n / (512 * 256);
    stampCraters(height, w, h, rng, Math.round(10 * area), 0.04, 0.10, 0.5);
    stampCraters(height, w, h, rng, Math.round(90 * area), 0.014, 0.04, 0.45);
    stampCraters(height, w, h, rng, Math.round(400 * area), 0.005, 0.014, 0.35);
    var rust = [0.72, 0.36, 0.18], basalt = [0.38, 0.22, 0.16], dust = [0.86, 0.62, 0.42];
    var cap = [0.95, 0.94, 0.92], c = [0, 0, 0], c2 = [0, 0, 0];
    forEachTexel(w, h, function (px, py, pz, lat, lon, x, y, idx) {
      var big = fbm(noise, px * 1.8, py * 1.8, pz * 1.8, 5, 2.0, 0.5);
      var fine = fbm(noise, px * 12, py * 12, pz * 12, 3, 2.0, 0.5);
      var dark = smoothstep(0.02, 0.30, big + (lat < 0 ? 0.10 : -0.05));
      var dusty = smoothstep(0.15, 0.45, fbm(noise, px * 2.6 + 50, py * 2.6, pz * 2.6, 3, 2, 0.5) - lat * 0.25);
      /* canyon streaks: ridged noise stretched along longitude, near the equator */
      var canyon = ridged(noise, px * 3.0 + 20, py * 3.0, pz * 7.0, 3, 2.0, 0.5);
      var canyonMask = smoothstep(0.80, 0.97, canyon) * (1 - smoothstep(0.15, 0.7, Math.abs(lat + 0.15))) * (0.5 + 0.5 * smoothstep(-0.2, 0.3, big));
      var absLat = Math.abs(lat);
      var polar = smoothstep(1.36, 1.46, absLat + fine * 0.05 + (lat > 0 ? 0.0 : -0.05));
      var hcr = height[y * w + x];
      mix3(rust, basalt, dark, c);
      mix3(c, dust, dusty * 0.55, c2);
      var shade = 1 + fine * 0.10 + hcr * 0.25 - canyonMask * 0.25;
      mix3(c2, cap, polar, c);
      put(map, idx, c[0] * shade, c[1] * shade, c[2] * shade);
      var b = clamp01(0.5 + hcr * 0.35 + big * 0.15 + fine * 0.08 - canyonMask * 0.3);
      put(bump, idx, b, b, b);
    });
    return { map: map, bumpMap: bump };
  };

  /* Shared helper for banded gas giants. bandFn(lat) -> t in [0,1] for the palette. */
  function gasGiant(w, h, seed, stops, opts) {
    var noise = makeNoise(seed);
    var map = new Uint8ClampedArray(w * h * 4);
    var c = [0, 0, 0];
    var turb = opts.turbulence, freq = opts.bandFreq, detail = opts.detail;
    forEachTexel(w, h, function (px, py, pz, lat, lon, x, y, idx) {
      /* warp latitude with flow-aligned noise (stretched along longitude) */
      var q = fbm(noise, px * 1.6, py * 1.6, pz * 6.0, 4, 2.1, 0.5);
      var q2 = fbm(noise, px * 3.5 + 12, py * 3.5, pz * 14.0, 3, 2.0, 0.5);
      var wl = lat + q * turb + q2 * turb * 0.35;
      var t = opts.bandFn(wl, freq);
      var shade = 1 + q2 * detail + fbm(noise, px * 9 + 40, py * 9, pz * 30, 2, 2, 0.5) * detail * 0.6;
      if (opts.extra) shade = opts.extra(px, py, pz, lat, lon, t, shade, noise, c);
      gradient(stops, clamp01(t), c);
      put(map, idx, c[0] * shade, c[1] * shade, c[2] * shade);
    });
    return { map: map };
  }

  /* --- Jupiter: zones and belts, Great Red Spot ------------------------ */
  pixels.jupiter = function (w, h) {
    var stops = [
      [0.00, [0.55, 0.36, 0.25]],
      [0.22, [0.78, 0.58, 0.42]],
      [0.42, [0.90, 0.80, 0.66]],
      [0.60, [0.97, 0.93, 0.85]],
      [0.78, [0.85, 0.72, 0.55]],
      [1.00, [0.62, 0.40, 0.28]]
    ];
    var GRS_LON = 3.6, GRS_LAT = -0.38;
    function bandFn(lat, f) {
      var s = Math.sin(lat * f) * 0.55 + Math.sin(lat * f * 2.3 + 0.7) * 0.25 + Math.sin(lat * f * 0.55 - 0.3) * 0.2;
      var polarFade = smoothstep(0.9, 1.4, Math.abs(lat));
      return lerp(0.5 + s * 0.5, 0.4, polarFade);
    }
    var noise = makeNoise(1111);
    var map = new Uint8ClampedArray(w * h * 4);
    var c = [0, 0, 0], sc = [0, 0, 0];
    forEachTexel(w, h, function (px, py, pz, lat, lon, x, y, idx) {
      var q = fbm(noise, px * 1.6, py * 1.6, pz * 6.0, 4, 2.1, 0.5);
      var q2 = fbm(noise, px * 3.5 + 12, py * 3.5, pz * 14.0, 3, 2.0, 0.5);
      var wl = lat + q * 0.10 + q2 * 0.04;
      var t = bandFn(wl, 9.0);
      var edge = Math.abs(Math.cos(wl * 9.0));
      var sw = fbm(noise, px * 7 + 40, py * 7, pz * 22, 3, 2, 0.5);
      var shade = 1 + q2 * 0.10 + sw * 0.07 * (0.4 + 0.6 * edge);
      gradient(stops, clamp01(t), c);
      /* Great Red Spot */
      var dlon = lon - GRS_LON;
      if (dlon > Math.PI) dlon -= TAU; else if (dlon < -Math.PI) dlon += TAU;
      var ex = dlon * Math.cos(GRS_LAT) / 0.34, ey = (lat - GRS_LAT) / 0.18;
      var d = Math.sqrt(ex * ex + ey * ey);
      if (d < 1.7) {
        var ang = Math.atan2(ey, ex);
        var swirl = fbm(noise, Math.cos(ang + d * 3.0) * 2 + d * 3, Math.sin(ang + d * 3.0) * 2, d * 4, 3, 2, 0.5);
        var inner = 1 - smoothstep(0.78, 1.05, d + swirl * 0.08);
        var collar = smoothstep(0.88, 1.05, d) * (1 - smoothstep(1.2, 1.7, d));
        mix3(c, [0.80, 0.42, 0.28], inner * 0.9, sc);
        mix3(sc, [0.96, 0.92, 0.86], collar * 0.6, c);
        shade *= (1 - inner * 0.2 * (1 - smoothstep(0.0, 0.6, d))) + swirl * 0.06 * inner;
      }
      put(map, idx, c[0] * shade, c[1] * shade, c[2] * shade);
    });
    return { map: map };
  };

  /* --- Saturn: soft butterscotch bands, polar hexagon hint ------------- */
  pixels.saturn = function (w, h) {
    var stops = [
      [0.00, [0.74, 0.60, 0.40]],
      [0.30, [0.86, 0.74, 0.52]],
      [0.55, [0.94, 0.86, 0.66]],
      [0.80, [0.97, 0.92, 0.76]],
      [1.00, [0.84, 0.70, 0.48]]
    ];
    return gasGiant(w, h, 1313, stops, {
      turbulence: 0.05, bandFreq: 8.0, detail: 0.05,
      bandFn: function (lat, f) {
        var s = Math.sin(lat * f) * 0.5 + Math.sin(lat * f * 2.1 + 1.1) * 0.2 + Math.sin(lat * f * 0.4) * 0.3;
        var polar = smoothstep(1.0, 1.45, Math.abs(lat));
        return lerp(0.5 + s * 0.4, 0.25, polar);
      },
      extra: function (px, py, pz, lat, lon, t, shade) {
        if (lat > 1.28) {
          /* hexagon: polar radius vs a hexagonal boundary */
          var r = (Math.PI / 2 - lat);
          var a = lon % (Math.PI / 3) - Math.PI / 6;
          var hexR = 0.16 / Math.cos(a);
          var line = 1 - smoothstep(0.0, 0.03, Math.abs(r - hexR));
          return shade * (1 - line * 0.10) * (r < hexR ? 0.97 : 1.0);
        }
        return shade;
      }
    });
  };

  /* --- Uranus: nearly featureless pale cyan ---------------------------- */
  pixels.uranus = function (w, h) {
    var stops = [
      [0.0, [0.58, 0.82, 0.88]],
      [0.5, [0.64, 0.87, 0.92]],
      [1.0, [0.70, 0.90, 0.94]]
    ];
    return gasGiant(w, h, 1515, stops, {
      turbulence: 0.03, bandFreq: 6.0, detail: 0.015,
      bandFn: function (lat, f) {
        return 0.5 + 0.3 * Math.sin(lat * f) + 0.15 * smoothstep(0.9, 1.4, Math.abs(lat));
      }
    });
  };

  /* --- Neptune: deep azure with bright streaks and a dark spot --------- */
  pixels.neptune = function (w, h) {
    var stops = [
      [0.0, [0.10, 0.22, 0.70]],
      [0.4, [0.16, 0.34, 0.86]],
      [0.7, [0.24, 0.44, 0.92]],
      [1.0, [0.30, 0.52, 0.94]]
    ];
    var SPOT_LON = 1.1, SPOT_LAT = -0.40;
    return gasGiant(w, h, 1717, stops, {
      turbulence: 0.06, bandFreq: 5.0, detail: 0.06,
      bandFn: function (lat, f) {
        return 0.55 + 0.35 * Math.sin(lat * f + 0.4) - 0.2 * smoothstep(0.9, 1.4, Math.abs(lat));
      },
      extra: function (px, py, pz, lat, lon, t, shade, noise, c) {
        var streak = ridged(noise, px * 1.1 + 70, py * 1.1, pz * 6.0, 3, 2.1, 0.5);
        var zone = (1 - smoothstep(0.1, 0.4, Math.abs(lat + 0.55))) * 0.8 + (1 - smoothstep(0.05, 0.3, Math.abs(lat - 0.45))) * 0.6;
        var wisps = smoothstep(0.70, 0.92, streak) * zone;
        var dlon = lon - SPOT_LON;
        if (dlon > Math.PI) dlon -= TAU; else if (dlon < -Math.PI) dlon += TAU;
        var ex = dlon * Math.cos(SPOT_LAT) / 0.22, ey = (lat - SPOT_LAT) / 0.13;
        var d = Math.sqrt(ex * ex + ey * ey);
        var spot = 1 - smoothstep(0.7, 1.05, d);
        var rim = smoothstep(0.9, 1.05, d) * (1 - smoothstep(1.05, 1.35, d));
        return shade * (1 - spot * 0.45) + wisps * 0.9 + rim * 0.25;
      }
    });
  };

  /* --- Pluto: mottled with a bright heart and dark equatorial maculae -- */
  pixels.pluto = function (w, h) {
    var noise = makeNoise(1919);
    var n = w * h;
    var map = new Uint8ClampedArray(n * 4), bump = new Uint8ClampedArray(n * 4);
    var tan = [0.72, 0.58, 0.44], brown = [0.45, 0.30, 0.20], grey = [0.60, 0.56, 0.52];
    var ice = [0.94, 0.90, 0.84], dark = [0.32, 0.17, 0.12], c = [0, 0, 0], c2 = [0, 0, 0];
    var HEART_LON = 3.0, HEART_LAT = 0.30;
    forEachTexel(w, h, function (px, py, pz, lat, lon, x, y, idx) {
      var m = fbm(noise, px * 2.5, py * 2.5, pz * 2.5, 5, 2.0, 0.5);
      var m2 = fbm(noise, px * 6 + 30, py * 6, pz * 6, 3, 2.0, 0.5);
      mix3(tan, brown, smoothstep(-0.3, 0.3, m), c);
      mix3(c, grey, smoothstep(0.0, 0.4, m2), c2);
      /* dark reddish equatorial maculae */
      var mac = smoothstep(0.05, 0.35, fbm(noise, px * 1.4 + 80, py * 1.4, pz * 1.4, 3, 2, 0.5) + 0.1) * (1 - smoothstep(0.25, 0.55, Math.abs(lat)));
      mix3(c2, dark, mac * 0.9, c);
      /* heart (Tombaugh Regio / Sputnik Planitia) */
      var dlon = lon - HEART_LON;
      if (dlon > Math.PI) dlon -= TAU; else if (dlon < -Math.PI) dlon += TAU;
      var hx = dlon * Math.cos(HEART_LAT) / 0.62, hy = (lat - HEART_LAT) / 0.62 + 0.15;
      var wob = fbm(noise, px * 5 + 200, py * 5, pz * 5, 2, 2, 0.5) * 0.05;
      var q = hx * hx + hy * hy - 1;
      var heartF = q * q * q - hx * hx * hy * hy * hy;
      var heart = 1 - smoothstep(-0.10, 0.06, heartF + wob);
      var cells = ridged(noise, px * 30, py * 30, pz * 30, 2, 2, 0.5);
      mix3(c, ice, heart * 0.92, c2);
      var shade = 1 + m2 * 0.06 * (1 - heart) - heart * cells * 0.05;
      put(map, idx, c2[0] * shade, c2[1] * shade, c2[2] * shade);
      var b = clamp01(0.5 + m * 0.25 * (1 - heart) + m2 * 0.1 - heart * 0.15 + cells * heart * 0.06);
      put(bump, idx, b, b, b);
    });
    return { map: map, bumpMap: bump };
  };

  /* --- Sun: fallback granulation color map ----------------------------- */
  pixels.sun = function (w, h) {
    var noise = makeNoise(2121);
    var map = new Uint8ClampedArray(w * h * 4);
    var stops = [
      [0.0, [1.0, 0.35, 0.05]],
      [0.4, [1.0, 0.62, 0.12]],
      [0.75, [1.0, 0.85, 0.35]],
      [1.0, [1.0, 0.97, 0.80]]
    ];
    var c = [0, 0, 0];
    forEachTexel(w, h, function (px, py, pz, lat, lon, x, y, idx) {
      var g = ridged(noise, px * 24, py * 24, pz * 24, 3, 2.0, 0.55);
      var big = fbm(noise, px * 3, py * 3, pz * 3, 3, 2.0, 0.5);
      var t = clamp01(0.55 + (g - 0.5) * 0.9 + big * 0.25);
      gradient(stops, t, c);
      put(map, idx, c[0], c[1], c[2]);
    });
    return { map: map };
  };

  /* ------------------------------------------------------------------ */
  /* Small bodies (planetary moons): one parameterised generator         */
  /* ------------------------------------------------------------------ */

  /*
   * Stamp one crater at an explicit (lon, lat) with angular radius r (radians).
   * Same bowl / rim / ejecta profile as stampCraters, plus an optional central peak
   * (peak = height of the peak relative to the bowl depth, 0 for none).
   */
  function stampCraterAt(height, w, h, lon, lat, r, depth, peak) {
    var cosLat = Math.max(0.08, Math.cos(lat));
    var cx = lon / TAU * w, cy = (0.5 - lat / Math.PI) * h;
    var ry = r / Math.PI * h * 1.35, rx = ry / cosLat;
    if (rx > w * 0.5) rx = w * 0.5;
    var x0 = Math.floor(cx - rx), x1 = Math.ceil(cx + rx);
    var y0 = Math.max(0, Math.floor(cy - ry)), y1 = Math.min(h - 1, Math.ceil(cy + ry));
    var rimW = 0.78, x, y, dx, dy, d, v, xx;
    for (y = y0; y <= y1; y++) {
      dy = (y + 0.5 - cy) / ry;
      for (x = x0; x <= x1; x++) {
        dx = (x + 0.5 - cx) / rx;
        d = Math.sqrt(dx * dx + dy * dy) / 0.74;
        if (d >= 1.35) continue;
        if (d < rimW) {
          v = -1 + (d / rimW) * (d / rimW) * 0.9;
          if (peak) v += peak * (1 - smoothstep(0.0, 0.24, d));
        } else if (d < 1.0) {
          v = -0.1 + Math.sin(((d - rimW) / (1.0 - rimW)) * Math.PI * 0.5) * 0.55;
        } else {
          v = 0.45 * (1 - (d - 1.0) / 0.35);
          v = v * v * 0.9;
        }
        xx = x; if (xx < 0) xx += w; else if (xx >= w) xx -= w;
        height[y * w + xx] += v * depth;
      }
    }
  }

  /*
   * Add a soft radial blob (weights 0..1, additive) to a Float32 field, in equirectangular
   * space with the same polar stretching as craters. core is the flat-topped fraction of
   * the radius; when ring is true the profile is an annulus peaking at d = core.
   */
  function stampBlobAt(field, w, h, lon, lat, r, core, ring, strength) {
    var cosLat = Math.max(0.08, Math.cos(lat));
    var cx = lon / TAU * w, cy = (0.5 - lat / Math.PI) * h;
    var ry = r / Math.PI * h, rx = ry / cosLat;
    if (rx > w * 0.5) rx = w * 0.5;
    var x0 = Math.floor(cx - rx), x1 = Math.ceil(cx + rx);
    var y0 = Math.max(0, Math.floor(cy - ry)), y1 = Math.min(h - 1, Math.ceil(cy + ry));
    var x, y, dx, dy, d, v, xx;
    for (y = y0; y <= y1; y++) {
      dy = (y + 0.5 - cy) / ry;
      for (x = x0; x <= x1; x++) {
        dx = (x + 0.5 - cx) / rx;
        d = Math.sqrt(dx * dx + dy * dy);
        if (d >= 1) continue;
        v = 1 - smoothstep(core, 1.0, d);
        if (ring) v *= smoothstep(core * 0.5, core, d);
        xx = x; if (xx < 0) xx += w; else if (xx >= w) xx -= w;
        field[y * w + xx] += v * strength;
      }
    }
  }

  /* Bilinear upsample of a lattice (lw x lh) to w x h, wrapping in longitude, clamping at the poles. */
  function upsampleWrap(src, lw, lh, out, w, h) {
    var x, y, fx, fy, x0, x1, y0, y1, tx, ty, r0, r1, a, b, c, d, o;
    for (y = 0; y < h; y++) {
      fy = ((y + 0.5) / h) * lh - 0.5;
      y0 = Math.floor(fy); ty = fy - y0; y1 = y0 + 1;
      if (y0 < 0) y0 = 0;
      if (y1 > lh - 1) y1 = lh - 1;
      r0 = y0 * lw; r1 = y1 * lw; o = y * w;
      for (x = 0; x < w; x++) {
        fx = ((x + 0.5) / w) * lw - 0.5;
        x0 = Math.floor(fx); tx = fx - x0; x1 = x0 + 1;
        if (x0 < 0) x0 += lw;
        if (x1 >= lw) x1 -= lw;
        a = src[r0 + x0]; b = src[r0 + x1]; c = src[r1 + x0]; d = src[r1 + x1];
        a += (b - a) * tx; c += (d - c) * tx;
        out[o + x] = a + (c - a) * ty;
      }
    }
  }

  /*
   * Evaluate fn(px, py, pz, lat, lon) on a coarse sphere-sampled lattice (w >> div by h >> div)
   * and bilinearly upsample to w x h. Cheap way to get low-frequency fields at full resolution;
   * the lattice values come from 3D noise on the sphere so the result stays seamless and pinch-free.
   */
  function latticeField(w, h, div, fn) {
    var lw = Math.max(8, w >> div), lh = Math.max(4, h >> div);
    var lattice = new Float32Array(lw * lh);
    forEachTexel(lw, lh, function (px, py, pz, lat, lon, x, y) {
      lattice[y * lw + x] = fn(px, py, pz, lat, lon);
    });
    var out = new Float32Array(w * h);
    upsampleWrap(lattice, lw, lh, out, w, h);
    return out;
  }

  function wrapLon(dlon) {
    if (dlon > Math.PI) return dlon - TAU;
    if (dlon < -Math.PI) return dlon + TAU;
    return dlon;
  }

  /*
   * genSmallBody(w, h, o): cratered / icy / volcanic small-body colour + bump maps.
   *
   * Cost model (512 x 256): macro fields on a 128 x 64 lattice, fine grain on 256 x 128,
   * craters stamped into a height field, and one compose pass. Only o.feature evaluates
   * noise per texel (2-octave ridged), so a moon costs roughly 15-40 ms in Node.
   *
   * Options (all optional except seed and colors):
   *   seed            noise / rng seed
   *   colors          [dark, light, tint?]  base palette; tint is mixed in by a low-frequency field
   *   baseFreq/Amt    large-scale albedo variation (default 3.0 / 0.45)
   *   fineFreq/Amt    grain frequency and its palette influence (14 / 0.12); grain: shading amount (0.08)
   *   speckle         per-texel hash noise amplitude (0.025)
   *   tintAmt         how much of colors[2] shows (0.35)
   *   craters         [[count at 512x256, rMin, rMax, depth], ...]   random craters
   *   bigCraters      [[lon, lat, r, depth, peak], ...]              named craters
   *   craterTone/Shade/Bump   crater height -> palette shift / shading / bump (0.3 / 0.4 / 0.45)
   *   blob            { color, lo, hi, amt, freq }   maria / albedo provinces from a low-frequency field
   *   feature         { kind: 'lines'|'cells', freq, stretch, octaves, lo, hi, color, amt, shade, bump, mask, hemi }
   *                   per-texel ridged noise: 'lines' thresholds it into thin lineae / canyons / wisps (one octave
   *                   gives long unbroken curves), 'cells' uses it continuously (grooved or cantaloupe terrain).
   *                   mask: 'blob' | 'inv' | 'hemi' restricts it to the blob provinces, their inverse, or a hemisphere
   *   polar           { color, from, to, amt, north, south, wobble }  polar tint (radians of latitude)
   *   twoTone         { color, lon, w, h, wobble }  dark ellipse centred on (lon, 0): Iapetus' Cassini Regio
   *   ridge           { width, bump, shade }        equatorial ridge
   *   stripes         { color, spacing, width, length, angle, latStart, latFull, amt, bump }  south-polar tiger stripes
   *   spots           { count, rMin, rMax, core, ringChance, ringScale, dark, ring, bump, fixed }  volcanic centres
   */
  function genSmallBody(w, h, o) {
    var noise = makeNoise(o.seed), rng = mulberry32(o.seed * 31 + 7);
    var n = w * h, area = n / (512 * 256);
    var map = new Uint8ClampedArray(n * 4), bump = new Uint8ClampedArray(n * 4);
    var k, i;

    /* --- craters -> height field --- */
    var height = new Float32Array(n);
    var cr = o.craters || [];
    for (k = 0; k < cr.length; k++) {
      stampCraters(height, w, h, rng, Math.round(cr[k][0] * area), cr[k][1], cr[k][2], cr[k][3]);
    }
    var big = o.bigCraters || [];
    for (k = 0; k < big.length; k++) {
      stampCraterAt(height, w, h, big[k][0], big[k][1], big[k][2], big[k][3], big[k][4] || 0);
    }

    /* --- macro fields (coarse lattice, upsampled) --- */
    var bf = o.baseFreq || 3.0;
    var base = latticeField(w, h, 2, function (px, py, pz) {
      return fbm(noise, px * bf, py * bf, pz * bf, 3, 2.1, 0.5);
    });
    var blobOpt = o.blob || null, needBlob = !!blobOpt || !!(o.feature && o.feature.mask && o.feature.mask !== 'hemi') || !!o.twoTone;
    var blf = (blobOpt && blobOpt.freq) || 1.4;
    var blob = needBlob ? latticeField(w, h, 2, function (px, py, pz) {
      return fbm(noise, px * blf + 17.3, py * blf + 3.1, pz * blf - 8.7, 3, 2.0, 0.5);
    }) : null;
    var tintCol = o.colors[2] || null;
    var tintF = tintCol ? latticeField(w, h, 2, function (px, py, pz) {
      return fbm(noise, px * 1.3 + 41.2, py * 1.3 - 6.5, pz * 1.3 + 12.9, 2, 2.0, 0.5);
    }) : null;
    var ff = o.fineFreq || 14;
    var fine = latticeField(w, h, 1, function (px, py, pz) {
      return fbm(noise, px * ff + 5.5, py * ff - 2.2, pz * ff + 9.1, 2, 2.0, 0.5);
    });

    /* --- spots (volcanic centres / bright rings) --- */
    var sp = o.spots || null, spotCore = null, spotRing = null;
    if (sp) {
      spotCore = new Float32Array(n); spotRing = new Float32Array(n);
      var sc = sp.count || 0, sr, slon, slat, ring;
      for (k = 0; k < sc; k++) {
        slon = rng() * TAU;
        slat = Math.asin(rng() * 1.8 - 0.9);
        sr = sp.rMin + (sp.rMax - sp.rMin) * Math.pow(rng(), 1.6);
        ring = rng() < (sp.ringChance || 0);
        stampBlobAt(spotCore, w, h, slon, slat, sr, sp.core === undefined ? 0.45 : sp.core, false, 0.75 + 0.35 * rng());
        if (ring) stampBlobAt(spotRing, w, h, slon, slat, sr * ((sp.ringScale || 2.2) * (0.85 + 0.3 * rng())), 0.5 + 0.15 * rng(), true, 0.4 + 0.35 * rng());
      }
      var fx = sp.fixed || [];
      for (k = 0; k < fx.length; k++) {
        stampBlobAt(spotCore, w, h, fx[k][0], fx[k][1], fx[k][2], sp.core === undefined ? 0.45 : sp.core, false, 1.0);
        stampBlobAt(spotRing, w, h, fx[k][0], fx[k][1], fx[k][2] * (sp.ringScale || 2.2), 0.55, true, 1.0);
      }
    }

    /* --- resolve options once (the compose loop must stay branch-light) --- */
    var dark = o.colors[0], light = o.colors[1];
    var baseAmt = o.baseAmt === undefined ? 0.45 : o.baseAmt;
    var fineAmt = o.fineAmt === undefined ? 0.12 : o.fineAmt;
    var grain = o.grain === undefined ? 0.08 : o.grain;
    var fineBump = o.fineBump === undefined ? 0.10 : o.fineBump;
    var speckle = o.speckle === undefined ? 0.025 : o.speckle;
    var tintAmt = o.tintAmt === undefined ? 0.35 : o.tintAmt;
    var crTone = o.craterTone === undefined ? 0.3 : o.craterTone;
    var crShade = o.craterShade === undefined ? 0.4 : o.craterShade;
    var crBump = o.craterBump === undefined ? 0.45 : o.craterBump;
    var blobColor = blobOpt ? blobOpt.color : null;
    var blobLo = blobOpt ? blobOpt.lo : 0.0, blobHi = blobOpt ? blobOpt.hi : 0.3;
    var blobAmt = blobOpt ? (blobOpt.amt === undefined ? 1 : blobOpt.amt) : 0;
    var maskLo = (o.feature && o.feature.maskLo !== undefined) ? o.feature.maskLo : blobLo;
    var maskHi = (o.feature && o.feature.maskHi !== undefined) ? o.feature.maskHi : blobHi;

    var fe = o.feature || null;
    var feLines = fe ? fe.kind === 'lines' : false;
    var feFreq = fe ? fe.freq : 1, feStretch = fe ? (fe.stretch || 1) : 1, feOct = fe ? (fe.octaves || 2) : 2;
    var feLo = fe ? fe.lo : 0, feHi = fe ? fe.hi : 1;
    var feColor = fe ? (fe.color || null) : null;
    var feAmt = fe ? (fe.amt === undefined ? 1 : fe.amt) : 0;
    var feShade = fe ? (fe.shade || 0) : 0, feBump = fe ? (fe.bump || 0) : 0;
    var feMask = fe ? (fe.mask === 'blob' ? 1 : (fe.mask === 'inv' ? 2 : (fe.mask === 'hemi' ? 3 : 0))) : 0;
    var hx = 1, hy = 0, hz = 0;
    if (fe && fe.hemi) { hx = fe.hemi[0]; hy = fe.hemi[1]; hz = fe.hemi[2] || 0; }

    var po = o.polar || null;
    var poFrom = po ? po.from : 0, poTo = po ? po.to : 1;
    var poAmt = po ? (po.amt === undefined ? 1 : po.amt) : 0;
    var poN = po ? po.north !== false : false, poS = po ? po.south !== false : false;
    var poWob = po ? (po.wobble === undefined ? 0.06 : po.wobble) : 0;
    var poColor = po ? po.color : null;

    var tt = o.twoTone || null;
    var ttLon = tt ? tt.lon : 0, ttW = tt ? tt.w : 1, ttH = tt ? tt.h : 1, ttWob = tt ? (tt.wobble === undefined ? 0.25 : tt.wobble) : 0;
    var ttColor = tt ? tt.color : null;

    var rg = o.ridge || null;
    var rgW = rg ? rg.width : 0, rgBump = rg ? rg.bump : 0, rgShade = rg ? (rg.shade || 0) : 0;

    var st = o.stripes || null;
    var stCos = st ? Math.cos(st.angle || 0) : 1, stSin = st ? Math.sin(st.angle || 0) : 0;
    var stSpacing = st ? st.spacing : 1, stWidth = st ? st.width : 0, stLen = st ? st.length : 0;
    var stLatStart = st ? st.latStart : 0, stLatFull = st ? st.latFull : 0;
    var stAmt = st ? (st.amt === undefined ? 1 : st.amt) : 0, stBump = st ? (st.bump || 0) : 0, stColor = st ? st.color : null;

    var spDark = sp ? (sp.dark || null) : null, spRing = sp ? (sp.ring || null) : null, spBump = sp ? (sp.bump || 0) : 0;
    var seed = o.seed | 0;

    var c = [0, 0, 0];

    forEachTexel(w, h, function (px, py, pz, lat, lon, x, y, idx) {
      i = y * w + x;
      var b0 = base[i], fn = fine[i], hcr = clamp(height[i], -1.4, 1.2);
      var speck = (hash2(x, y, seed) - 0.5) * speckle;
      var t = clamp01(0.5 + b0 * baseAmt + fn * fineAmt + hcr * crTone);
      mix3(dark, light, t, c);
      if (tintCol) mix3(c, tintCol, tintAmt * smoothstep(-0.15, 0.35, tintF[i]), c);
      var region = 0;
      if (blob) region = smoothstep(blobLo, blobHi, blob[i]);
      if (blobColor) mix3(c, blobColor, region * blobAmt, c);
      var shade = 1 + hcr * crShade + fn * grain + speck;
      var bmp = 0.5 + hcr * crBump + fn * fineBump + speck * 0.5;
      var m;
      if (fe) {
        var f = ridged(noise, px * feFreq + 9.4, py * feFreq + 4.2, pz * feFreq * feStretch - 3.3, feOct, 2.0, 0.5);
        var mask = 1;
        if (feMask === 1) mask = smoothstep(maskLo, maskHi, blob[i]);
        else if (feMask === 2) mask = 1 - smoothstep(maskLo, maskHi, blob[i]);
        else if (feMask === 3) mask = smoothstep(-0.2, 0.6, px * hx + py * hy + pz * hz);
        if (feLines) {
          m = smoothstep(feLo, feHi, f) * mask;
          if (feColor) mix3(c, feColor, m * feAmt, c);
          shade += m * feShade;
          bmp += m * feBump;
        } else {
          m = (f - 0.5) * mask;
          shade += m * feAmt;
          bmp += m * feBump;
          if (feColor) mix3(c, feColor, clamp01(m * 2) * 0.5, c);
        }
      }
      if (po) {
        var p = 0;
        if (poN) p += smoothstep(poFrom, poTo, lat + fn * poWob);
        if (poS) p += smoothstep(poFrom, poTo, -lat + fn * poWob);
        mix3(c, poColor, clamp01(p) * poAmt, c);
      }
      if (tt) {
        var dl = wrapLon(lon - ttLon) / ttW, dla = lat / ttH;
        var dd = Math.sqrt(dl * dl + dla * dla) + blob[i] * ttWob;
        m = 1 - smoothstep(0.82, 1.1, dd);
        mix3(c, ttColor, m, c);
      }
      if (rg) {
        var rr = 1 - smoothstep(0, rgW, Math.abs(lat));
        bmp += rr * rgBump;
        shade += rr * rgShade;
      }
      if (st && lat < stLatStart) {
        /* tangent-plane coordinates about the south pole */
        var s = px * stCos + py * stSin, u = -px * stSin + py * stCos;
        var kk = Math.round(s / stSpacing - 0.5);
        if (kk >= -2 && kk <= 1) {
          var ds = Math.abs(s - (kk + 0.5) * stSpacing) + fn * 0.01;
          var along = 1 - smoothstep(stLen * 0.7, stLen, Math.abs(u + fn * 0.05));
          m = (1 - smoothstep(stWidth * 0.5, stWidth, ds)) * along * smoothstep(-stLatStart, -stLatFull, -lat);
          mix3(c, stColor, m * stAmt, c);
          bmp += m * stBump;
          shade += m * stBump * 0.3;
        }
      }
      if (sp) {
        var a = clamp01(spotCore[i]), r2 = clamp01(spotRing[i]);
        if (spRing) mix3(c, spRing, r2, c);
        if (spDark) mix3(c, spDark, a, c);
        bmp += a * spBump;
      }
      /* floors: overlapping craters must not go black, and a 0 in either map then only ever means NaN */
      if (shade < 0.2) shade = 0.2;
      put(map, idx, c[0] * shade, c[1] * shade, c[2] * shade);
      bmp = clamp(bmp, 0.02, 1);
      put(bump, idx, bmp, bmp, bmp);
    });
    return { map: map, bumpMap: bump };
  }

  /* Palette shorthands */
  var GREY_DARK = [0.34, 0.34, 0.34], GREY_LIGHT = [0.66, 0.66, 0.65];
  var ICE_DARK = [0.66, 0.67, 0.66], ICE_LIGHT = [0.90, 0.90, 0.89];

  /*
   * Per-moon recipes. accent is the label / orbit colour used by the app (PLANET_STYLE).
   * Order matches Moons.SYSTEMS (distance order within each planet).
   */
  var MOON_SPECS = {
    /* Mars */
    phobos: {
      seed: 3001, accent: 0x9a8c7e,
      colors: [[0.19, 0.17, 0.15], [0.42, 0.38, 0.34], [0.38, 0.30, 0.24]],
      baseFreq: 2.6, baseAmt: 0.42, fineAmt: 0.14, grain: 0.11, speckle: 0.035,
      craters: [[45, 0.03, 0.10, 0.7], [380, 0.008, 0.03, 0.55]],
      bigCraters: [[0.9, 0.12, 0.40, 0.95, 0]],
      craterShade: 0.45, craterBump: 0.5,
      feature: { kind: 'lines', freq: 2.0, stretch: 3.5, octaves: 1, lo: 0.92, hi: 0.975, color: [0.15, 0.13, 0.11], amt: 0.5, shade: -0.10, bump: -0.18 }
    },
    deimos: {
      seed: 3002, accent: 0xa4988c,
      colors: [[0.25, 0.22, 0.19], [0.47, 0.43, 0.38], [0.44, 0.36, 0.28]],
      baseFreq: 2.2, baseAmt: 0.38, fineAmt: 0.12, grain: 0.09, speckle: 0.03,
      craters: [[14, 0.04, 0.12, 0.45], [160, 0.01, 0.04, 0.35]],
      craterShade: 0.3, craterBump: 0.35, craterTone: 0.2
    },

    /* Jupiter */
    io: {
      seed: 3101, accent: 0xe8a83a,
      colors: [[0.74, 0.60, 0.20], [0.92, 0.86, 0.52], [0.84, 0.50, 0.16]],
      baseFreq: 2.2, baseAmt: 0.5, fineFreq: 10, fineAmt: 0.10, grain: 0.05, speckle: 0.02, tintAmt: 0.6, fineBump: 0.06,
      blob: { color: [0.90, 0.92, 0.78], lo: 0.12, hi: 0.40, amt: 0.85, freq: 1.8 },
      polar: { color: [0.55, 0.36, 0.20], from: 0.85, to: 1.45, amt: 0.45, wobble: 0.12 },
      spots: { count: 48, rMin: 0.025, rMax: 0.10, core: 0.35, ringChance: 0.45, ringScale: 2.4,
               dark: [0.20, 0.14, 0.09], ring: [0.66, 0.22, 0.08], bump: -0.25 }
    },
    europa: {
      seed: 3102, accent: 0xdcd6c6,
      colors: [[0.80, 0.78, 0.70], [0.95, 0.94, 0.91], [0.78, 0.66, 0.50]],
      baseFreq: 2.8, baseAmt: 0.3, fineAmt: 0.06, grain: 0.04, speckle: 0.015, tintAmt: 0.45, fineBump: 0.05,
      craters: [[6, 0.012, 0.035, 0.35]],
      craterShade: 0.3, craterBump: 0.3, craterTone: 0.1,
      blob: { color: [0.72, 0.58, 0.44], lo: 0.18, hi: 0.42, amt: 0.6, freq: 2.4 },
      feature: { kind: 'lines', freq: 2.2, stretch: 0.8, octaves: 1, lo: 0.905, hi: 0.965, color: [0.52, 0.32, 0.20], amt: 0.85, shade: -0.02, bump: 0.16 }
    },
    ganymede: {
      seed: 3103, accent: 0xaa9f90,
      colors: [[0.56, 0.54, 0.50], [0.74, 0.73, 0.70], [0.62, 0.55, 0.46]],
      baseFreq: 2.4, baseAmt: 0.35, fineAmt: 0.10, grain: 0.07, speckle: 0.025,
      craters: [[24, 0.03, 0.08, 0.55], [220, 0.008, 0.03, 0.5]],
      craterShade: 0.4, craterBump: 0.45,
      blob: { color: [0.30, 0.26, 0.22], lo: 0.02, hi: 0.30, amt: 0.9, freq: 1.5 },
      feature: { kind: 'cells', freq: 9.0, stretch: 1.6, lo: 0, hi: 1, amt: 0.30, bump: 0.40, mask: 'inv' }
    },
    callisto: {
      seed: 3104, accent: 0x8c8073,
      colors: [[0.24, 0.21, 0.18], [0.50, 0.46, 0.41], [0.42, 0.34, 0.26]],
      baseFreq: 2.8, baseAmt: 0.42, fineAmt: 0.14, grain: 0.10, speckle: 0.035,
      craters: [[40, 0.03, 0.10, 0.75], [300, 0.01, 0.03, 0.65], [900, 0.005, 0.012, 0.5]],
      bigCraters: [[2.4, 0.25, 0.30, 0.6, 0.6]],
      craterShade: 0.55, craterBump: 0.5, craterTone: 0.45
    },

    /* Saturn */
    mimas: {
      seed: 3201, accent: 0xbcbcbc,
      colors: [[0.50, 0.50, 0.50], [0.80, 0.80, 0.79]],
      baseFreq: 3.0, baseAmt: 0.3, fineAmt: 0.10, grain: 0.07, speckle: 0.03,
      craters: [[34, 0.03, 0.10, 0.7], [320, 0.01, 0.03, 0.6], [700, 0.005, 0.012, 0.5]],
      bigCraters: [[0.9, 0.0, 0.35, 1.5, 0.55]],
      craterShade: 0.5, craterBump: 0.55, craterTone: 0.25
    },
    enceladus: {
      seed: 3202, accent: 0xe8eff6,
      colors: [[0.86, 0.88, 0.91], [0.97, 0.98, 1.0]],
      baseFreq: 2.6, baseAmt: 0.18, fineAmt: 0.05, grain: 0.03, speckle: 0.012, fineBump: 0.05,
      craters: [[10, 0.02, 0.06, 0.4], [90, 0.006, 0.02, 0.35]],
      craterShade: 0.3, craterBump: 0.35, craterTone: 0.1,
      polar: { color: [0.74, 0.82, 0.92], from: 0.95, to: 1.25, amt: 0.55, north: false, wobble: 0.08 },
      stripes: { color: [0.56, 0.66, 0.82], spacing: 0.13, width: 0.012, length: 0.28, angle: 0.6, latStart: -0.9, latFull: -1.15, amt: 0.8, bump: -0.25 },
      feature: { kind: 'lines', freq: 2.6, stretch: 2.5, octaves: 1, lo: 0.92, hi: 0.975, color: [0.72, 0.80, 0.90], amt: 0.5, shade: -0.03, bump: -0.10 }
    },
    tethys: {
      seed: 3203, accent: 0xd2d2ce,
      colors: [[0.62, 0.62, 0.60], [0.90, 0.90, 0.88]],
      baseFreq: 2.8, baseAmt: 0.28, fineAmt: 0.10, grain: 0.06, speckle: 0.025,
      craters: [[30, 0.03, 0.09, 0.6], [280, 0.008, 0.03, 0.55]],
      bigCraters: [[4.2, 0.45, 0.42, 0.7, 0.4]],
      craterShade: 0.45, craterBump: 0.5,
      feature: { kind: 'lines', freq: 2.4, stretch: 0.45, octaves: 1, lo: 0.92, hi: 0.975, color: [0.97, 0.97, 0.96], amt: 0.8, shade: 0.06, bump: -0.12, mask: 'blob', maskLo: -0.05, maskHi: 0.25 }
    },
    dione: {
      seed: 3204, accent: 0xcbcac4,
      colors: [[0.58, 0.58, 0.56], [0.88, 0.87, 0.85]],
      baseFreq: 2.6, baseAmt: 0.3, fineAmt: 0.10, grain: 0.06, speckle: 0.025,
      craters: [[26, 0.03, 0.09, 0.6], [240, 0.008, 0.03, 0.5]],
      craterShade: 0.45, craterBump: 0.5,
      feature: { kind: 'lines', freq: 2.6, stretch: 0.4, octaves: 1, lo: 0.90, hi: 0.965, color: [0.98, 0.98, 0.97], amt: 0.95, shade: 0.12, bump: 0.10, mask: 'hemi', hemi: [-1, 0, 0] }
    },
    rhea: {
      seed: 3205, accent: 0xc6c4be,
      colors: [[0.56, 0.56, 0.54], [0.86, 0.86, 0.84]],
      baseFreq: 3.0, baseAmt: 0.3, fineAmt: 0.11, grain: 0.07, speckle: 0.03,
      craters: [[40, 0.03, 0.09, 0.65], [360, 0.008, 0.03, 0.55], [700, 0.004, 0.01, 0.45]],
      craterShade: 0.5, craterBump: 0.5,
      feature: { kind: 'lines', freq: 2.4, stretch: 0.4, octaves: 1, lo: 0.92, hi: 0.98, color: [0.96, 0.96, 0.95], amt: 0.7, shade: 0.08, bump: 0.06, mask: 'hemi', hemi: [-1, 0, 0] }
    },
    titan: {
      seed: 3206, accent: 0xe0913a,
      colors: [[0.80, 0.55, 0.20], [0.92, 0.70, 0.34], [0.86, 0.60, 0.24]],
      baseFreq: 2.0, baseAmt: 0.16, fineFreq: 8, fineAmt: 0.04, grain: 0.02, speckle: 0.006, fineBump: 0.02, tintAmt: 0.3,
      polar: { color: [0.72, 0.52, 0.26], from: 0.95, to: 1.45, amt: 0.35, wobble: 0.15 }
    },
    iapetus: {
      seed: 3207, accent: 0xb5a58e,
      colors: [[0.64, 0.62, 0.57], [0.86, 0.85, 0.81], [0.72, 0.62, 0.50]],
      baseFreq: 2.8, baseAmt: 0.3, fineAmt: 0.10, grain: 0.07, speckle: 0.03,
      craters: [[36, 0.03, 0.10, 0.65], [300, 0.008, 0.03, 0.55]],
      craterShade: 0.45, craterBump: 0.5,
      twoTone: { color: [0.19, 0.12, 0.08], lon: 0.0, w: 2.1, h: 0.85, wobble: 0.3 },
      ridge: { width: 0.05, bump: 0.35, shade: 0.06 }
    },

    /* Uranus */
    miranda: {
      seed: 3301, accent: 0xb4b4b4,
      colors: [[0.44, 0.44, 0.44], [0.72, 0.72, 0.71]],
      baseFreq: 2.6, baseAmt: 0.36, fineAmt: 0.10, grain: 0.07, speckle: 0.03,
      craters: [[22, 0.03, 0.08, 0.55], [200, 0.008, 0.03, 0.5]],
      craterShade: 0.4, craterBump: 0.45,
      blob: { color: [0.36, 0.36, 0.37], lo: 0.08, hi: 0.32, amt: 0.6, freq: 1.7 },
      feature: { kind: 'cells', freq: 7.0, stretch: 2.2, lo: 0, hi: 1, amt: 0.34, bump: 0.45, mask: 'blob' }
    },
    ariel: {
      seed: 3302, accent: 0xd1d1cd,
      colors: [[0.58, 0.58, 0.56], [0.86, 0.86, 0.84]],
      baseFreq: 2.8, baseAmt: 0.3, fineAmt: 0.10, grain: 0.06, speckle: 0.025,
      craters: [[20, 0.02, 0.07, 0.5], [220, 0.007, 0.025, 0.45]],
      craterShade: 0.4, craterBump: 0.45,
      feature: { kind: 'lines', freq: 2.2, stretch: 0.6, octaves: 1, lo: 0.89, hi: 0.96, color: [0.95, 0.95, 0.94], amt: 0.9, shade: 0.06, bump: -0.30, mask: 'blob', maskLo: -0.1, maskHi: 0.2 }
    },
    umbriel: {
      seed: 3303, accent: 0x8c8c8c,
      colors: [[0.22, 0.22, 0.22], [0.42, 0.42, 0.42]],
      baseFreq: 3.0, baseAmt: 0.3, fineAmt: 0.10, grain: 0.07, speckle: 0.03,
      craters: [[36, 0.03, 0.09, 0.6], [340, 0.008, 0.03, 0.55], [600, 0.004, 0.01, 0.45]],
      bigCraters: [[2.0, 0.15, 0.12, 0.6, 0]],
      craterShade: 0.45, craterBump: 0.5,
      spots: { count: 0, fixed: [[2.0, 0.15, 0.10]], core: 0.55, ringScale: 1.0, ring: [0.80, 0.80, 0.78], bump: 0 }
    },
    titania: {
      seed: 3304, accent: 0xaba7a1,
      colors: [[0.40, 0.38, 0.36], [0.66, 0.64, 0.62]],
      baseFreq: 2.8, baseAmt: 0.32, fineAmt: 0.10, grain: 0.07, speckle: 0.03,
      craters: [[24, 0.03, 0.09, 0.55], [260, 0.008, 0.03, 0.5]],
      craterShade: 0.42, craterBump: 0.45,
      feature: { kind: 'lines', freq: 1.8, stretch: 0.6, octaves: 1, lo: 0.92, hi: 0.975, color: [0.54, 0.52, 0.50], amt: 0.7, shade: -0.10, bump: -0.28, mask: 'blob', maskLo: 0.0, maskHi: 0.25 }
    },
    oberon: {
      seed: 3305, accent: 0xa59b91,
      colors: [[0.34, 0.31, 0.28], [0.62, 0.59, 0.55], [0.50, 0.40, 0.32]],
      baseFreq: 3.0, baseAmt: 0.32, fineAmt: 0.11, grain: 0.08, speckle: 0.03, tintAmt: 0.3,
      craters: [[40, 0.03, 0.10, 0.65], [360, 0.008, 0.03, 0.55], [500, 0.004, 0.01, 0.45]],
      craterShade: 0.5, craterBump: 0.5, craterTone: 0.45
    },

    /* Neptune */
    triton: {
      seed: 3401, accent: 0xe6c2c2,
      colors: [[0.74, 0.66, 0.64], [0.90, 0.86, 0.85], [0.84, 0.70, 0.66]],
      baseFreq: 2.4, baseAmt: 0.28, fineAmt: 0.06, grain: 0.04, speckle: 0.015, tintAmt: 0.4, fineBump: 0.05,
      craters: [[4, 0.015, 0.04, 0.35]],
      craterShade: 0.3, craterBump: 0.3, craterTone: 0.1,
      blob: { color: [0.70, 0.62, 0.60], lo: 0.02, hi: 0.32, amt: 0.5, freq: 1.4 },
      feature: { kind: 'cells', freq: 18.0, stretch: 1.0, lo: 0, hi: 1, amt: 0.18, bump: 0.40, mask: 'blob' },
      polar: { color: [0.96, 0.92, 0.92], from: 0.10, to: 0.55, amt: 0.9, north: false, wobble: 0.18 }
    },

    /* Pluto */
    charon: {
      seed: 3501, accent: 0xa89a8e,
      colors: [[0.46, 0.45, 0.44], [0.70, 0.69, 0.68], [0.60, 0.54, 0.48]],
      baseFreq: 2.6, baseAmt: 0.32, fineAmt: 0.10, grain: 0.07, speckle: 0.03, tintAmt: 0.3,
      craters: [[20, 0.03, 0.08, 0.55], [200, 0.008, 0.03, 0.5]],
      craterShade: 0.42, craterBump: 0.45,
      polar: { color: [0.42, 0.27, 0.21], from: 0.85, to: 1.30, amt: 0.9, south: false, wobble: 0.22 },
      feature: { kind: 'lines', freq: 1.6, stretch: 3.0, octaves: 1, lo: 0.925, hi: 0.975, color: [0.40, 0.39, 0.38], amt: 0.6, shade: -0.12, bump: -0.30 }
    }
  };

  var MOON_NAMES = Object.keys(MOON_SPECS);

  MOON_NAMES.forEach(function (name) {
    pixels[name] = function (w, h) { return genSmallBody(w, h, MOON_SPECS[name]); };
  });

  /* --- Ring textures: w x h RGBA, u along radius (inner -> outer) ------- */
  pixels.ring = function (name, w, h) {
    var out = new Uint8ClampedArray(w * h * 4);
    var noise = makeNoise(2323);
    var x, y, u, r, g, b, a, i, k;
    var col = new Float32Array(w * 4);
    if (name === 'uranus') {
      var rings = [
        [0.20, 0.004, 0.25], [0.30, 0.004, 0.22], [0.40, 0.005, 0.28], [0.48, 0.005, 0.3],
        [0.56, 0.006, 0.32], [0.66, 0.006, 0.34], [0.78, 0.008, 0.36], [0.95, 0.014, 0.65]
      ];
      for (x = 0; x < w; x++) {
        u = (x + 0.5) / w; a = 0;
        for (k = 0; k < rings.length; k++) {
          var d = Math.abs(u - rings[k][0]) / rings[k][1];
          a += rings[k][2] * (1 - smoothstep(0.6, 1.0, d));
        }
        a = clamp01(a);
        col[x * 4] = 0.42; col[x * 4 + 1] = 0.42; col[x * 4 + 2] = 0.46; col[x * 4 + 3] = a;
      }
    } else {
      for (x = 0; x < w; x++) {
        u = (x + 0.5) / w;
        var fine = fbm(noise, u * 90, 0.3, 0.7, 4, 2.0, 0.55);
        var fine2 = fbm(noise, u * 300, 1.3, 2.1, 3, 2.0, 0.5);
        var ringlets = 1 + fine * 0.22 + fine2 * 0.10;
        var cRing = smoothstep(0.0, 0.10, u) * (1 - smoothstep(0.24, 0.30, u));
        var bRing = smoothstep(0.26, 0.31, u) * (1 - smoothstep(0.60, 0.625, u));
        var aRing = smoothstep(0.645, 0.665, u) * (1 - smoothstep(0.93, 0.975, u));
        var encke = 1 - 0.85 * (1 - smoothstep(0.004, 0.010, Math.abs(u - 0.885)));
        var keeler = 1 - 0.6 * (1 - smoothstep(0.002, 0.005, Math.abs(u - 0.945)));
        var bInner = 0.55 + 0.45 * smoothstep(0.3, 0.45, u);   /* inner B ring dimmer than outer */
        a = cRing * (0.22 + 0.18 * (fine + 1) * 0.5) + bRing * 0.92 * bInner + aRing * 0.72 * encke * keeler;
        a = clamp01(a * (0.85 + 0.15 * ringlets));
        r = 0.80 + 0.12 * bRing - 0.10 * cRing; g = 0.72 + 0.10 * bRing - 0.10 * cRing; b = 0.56 + 0.08 * bRing - 0.05 * cRing;
        var bright = clamp01(ringlets * (0.9 + 0.1 * bRing));
        col[x * 4] = clamp01(r * bright); col[x * 4 + 1] = clamp01(g * bright); col[x * 4 + 2] = clamp01(b * bright); col[x * 4 + 3] = a;
      }
    }
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        i = (y * w + x) * 4;
        out[i] = col[x * 4] * 255; out[i + 1] = col[x * 4 + 1] * 255; out[i + 2] = col[x * 4 + 2] * 255; out[i + 3] = col[x * 4 + 3] * 255;
      }
    }
    return out;
  };

  /* ------------------------------------------------------------------ */
  /* GLSL                                                                */
  /* ------------------------------------------------------------------ */

  /* Ashima / Ian McEwan simplex noise, 3D. Prepended to fragment shaders. */
  var GLSL_NOISE = [
    'vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }',
    'vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }',
    'vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }',
    'vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }',
    'float snoise(vec3 v) {',
    '  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);',
    '  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);',
    '  vec3 i = floor(v + dot(v, C.yyy));',
    '  vec3 x0 = v - i + dot(i, C.xxx);',
    '  vec3 g = step(x0.yzx, x0.xyz);',
    '  vec3 l = 1.0 - g;',
    '  vec3 i1 = min(g.xyz, l.zxy);',
    '  vec3 i2 = max(g.xyz, l.zxy);',
    '  vec3 x1 = x0 - i1 + C.xxx;',
    '  vec3 x2 = x0 - i2 + C.yyy;',
    '  vec3 x3 = x0 - D.yyy;',
    '  i = mod289(i);',
    '  vec4 p = permute(permute(permute(',
    '      i.z + vec4(0.0, i1.z, i2.z, 1.0))',
    '    + i.y + vec4(0.0, i1.y, i2.y, 1.0))',
    '    + i.x + vec4(0.0, i1.x, i2.x, 1.0));',
    '  float n_ = 0.142857142857;',
    '  vec3 ns = n_ * D.wyz - D.xzx;',
    '  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);',
    '  vec4 x_ = floor(j * ns.z);',
    '  vec4 y_ = floor(j - 7.0 * x_);',
    '  vec4 x = x_ * ns.x + ns.yyyy;',
    '  vec4 y = y_ * ns.x + ns.yyyy;',
    '  vec4 h = 1.0 - abs(x) - abs(y);',
    '  vec4 b0 = vec4(x.xy, y.xy);',
    '  vec4 b1 = vec4(x.zw, y.zw);',
    '  vec4 s0 = floor(b0) * 2.0 + 1.0;',
    '  vec4 s1 = floor(b1) * 2.0 + 1.0;',
    '  vec4 sh = -step(h, vec4(0.0));',
    '  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;',
    '  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;',
    '  vec3 p0 = vec3(a0.xy, h.x);',
    '  vec3 p1 = vec3(a0.zw, h.y);',
    '  vec3 p2 = vec3(a1.xy, h.z);',
    '  vec3 p3 = vec3(a1.zw, h.w);',
    '  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));',
    '  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;',
    '  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);',
    '  m = m * m;',
    '  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));',
    '}',
    'float fbm3(vec3 p, int octaves) {',
    '  float sum = 0.0; float amp = 0.5; float norm = 0.0;',
    '  for (int i = 0; i < 6; i++) {',
    '    if (i >= octaves) break;',
    '    sum += amp * snoise(p); norm += amp; amp *= 0.5; p = p * 2.02 + vec3(1.7, 9.2, 3.1);',
    '  }',
    '  return sum / norm;',
    '}',
    'float ridged3(vec3 p, int octaves) {',
    '  float sum = 0.0; float amp = 0.5; float norm = 0.0;',
    '  for (int i = 0; i < 6; i++) {',
    '    if (i >= octaves) break;',
    '    float n = 1.0 - abs(snoise(p)); sum += amp * n * n; norm += amp; amp *= 0.5; p = p * 2.05 + vec3(3.3, 1.1, 7.7);',
    '  }',
    '  return sum / norm;',
    '}'
  ].join('\n');

  var SUN_VERT = [
    'varying vec3 vObj;',
    'varying vec3 vNormalV;',
    'varying vec3 vViewDir;',
    'void main() {',
    '  vObj = normalize(position);',
    '  vec4 mv = modelViewMatrix * vec4(position, 1.0);',
    '  vNormalV = normalize(normalMatrix * normal);',
    '  vViewDir = normalize(-mv.xyz);',
    '  gl_Position = projectionMatrix * mv;',
    '}'
  ].join('\n');

  var SUN_FRAG = [
    'uniform float uTime;',
    'uniform float uBrightness;',
    'varying vec3 vObj;',
    'varying vec3 vNormalV;',
    'varying vec3 vViewDir;',
    GLSL_NOISE,
    'void main() {',
    '  vec3 p = vObj;',
    '  float t = uTime;',
    '  vec3 drift = vec3(t * 0.030, t * 0.021, -t * 0.017);',
    '  float cells = ridged3(p * 14.0 + drift, 4);',
    '  float slow = fbm3(p * 3.0 + vec3(0.0, t * 0.012, 0.0), 4);',
    '  float fine = snoise(p * 40.0 + drift * 2.5) * 0.5 + 0.5;',
    '  float g = clamp(0.55 + (cells - 0.5) * 1.1 + slow * 0.35 + (fine - 0.5) * 0.18, 0.0, 1.0);',
    '  vec3 deep = vec3(1.0, 0.35, 0.05);',
    '  vec3 mid = vec3(1.0, 0.66, 0.16);',
    '  vec3 hot = vec3(1.0, 0.92, 0.55);',
    '  vec3 white = vec3(1.0, 0.99, 0.90);',
    '  vec3 col = mix(deep, mid, smoothstep(0.0, 0.42, g));',
    '  col = mix(col, hot, smoothstep(0.42, 0.78, g));',
    '  col = mix(col, white, smoothstep(0.78, 1.0, g));',
    '  float ndv = clamp(dot(normalize(vNormalV), normalize(vViewDir)), 0.0, 1.0);',
    '  float limb = pow(ndv, 0.55);',
    '  col = mix(col * vec3(0.85, 0.55, 0.30), col, limb);',
    '  float hdr = mix(0.7, 1.75, g) * uBrightness * mix(0.62, 1.0, limb);',
    '  gl_FragColor = vec4(col * hdr, 1.0);',
    '}'
  ].join('\n');

  var CORONA_VERT = [
    'varying vec2 vUv;',
    'void main() {',
    '  vUv = uv;',
    '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
    '}'
  ].join('\n');

  var CORONA_FRAG = [
    'uniform float uTime;',
    'uniform vec3 uColor;',
    'uniform float uIntensity;',
    'varying vec2 vUv;',
    GLSL_NOISE,
    'void main() {',
    '  vec2 q = (vUv - 0.5) * 2.0;',
    '  float d = length(q);',
    '  if (d >= 1.0) { gl_FragColor = vec4(0.0); return; }',
    '  float ang = atan(q.y, q.x);',
    '  float core = exp(-d * d * 22.0) * 0.9;',
    '  float halo = pow(1.0 - d, 2.6);',
    '  vec3 ap = vec3(cos(ang) * 2.6, sin(ang) * 2.6, uTime * 0.12 + d * 2.2);',
    '  float streak = fbm3(ap, 3) * 0.5 + 0.5;',
    '  float streak2 = ridged3(vec3(cos(ang) * 5.0, sin(ang) * 5.0, d * 3.0 - uTime * 0.07), 2);',
    '  float rays = mix(0.55, 1.45, streak) * mix(0.8, 1.2, streak2);',
    '  float wisps = halo * rays * (1.0 - smoothstep(0.0, 0.22, d) * 0.35);',
    '  float edge = 1.0 - smoothstep(0.82, 1.0, d);',
    '  float disc = smoothstep(0.34, 0.41, d);',
    '  float i = (core * mix(0.25, 1.0, disc) + wisps * 0.85 * disc) * edge * uIntensity;',
    '  vec3 col = uColor * i + vec3(1.0, 0.9, 0.7) * core * 0.35;',
    '  gl_FragColor = vec4(col, 1.0);',
    '}'
  ].join('\n');

  var ATMO_VERT = [
    'varying vec3 vNormalV;',
    'varying vec3 vViewDir;',
    'void main() {',
    '  vec4 mv = modelViewMatrix * vec4(position, 1.0);',
    '  vNormalV = normalize(normalMatrix * normal);',
    '  vViewDir = normalize(-mv.xyz);',
    '  gl_Position = projectionMatrix * mv;',
    '}'
  ].join('\n');

  /*
   * Rim glow drawn on the BackSide of a shell slightly larger than the planet.
   * Only the far hemisphere is rasterized and the planet hides its centre, so what
   * remains is the thin annulus between the planet limb and the shell silhouette.
   * There -dot(normal, viewDir) runs from uLimb (at the planet limb) to 0 (outer
   * edge); we normalise that and raise to uPower, which gives a glow that peaks at
   * the limb and fades smoothly to nothing at the outer edge.
   */
  var ATMO_FRAG = [
    'uniform vec3 uColor;',
    'uniform float uPower;',
    'uniform float uIntensity;',
    'uniform float uLimb;',
    'varying vec3 vNormalV;',
    'varying vec3 vViewDir;',
    'void main() {',
    '  vec3 n = normalize(vNormalV);',
    '  vec3 v = normalize(vViewDir);',
    '  float facing = dot(n, v);',
    '  float rim = clamp(-facing, 0.0, 1.0);',
    '  float t = clamp(rim / uLimb, 0.0, 1.0);',
    '  float glow = pow(t, uPower);',
    '  glow *= 1.0 - smoothstep(0.985, 1.0, t) * 0.35;',
    '  gl_FragColor = vec4(uColor * glow * uIntensity, 1.0);',
    '}'
  ].join('\n');

  var STAR_VERT = [
    'attribute float aSize;',
    'attribute vec3 aColor;',
    'attribute float aTwinkle;',
    'uniform float uPixelRatio;',
    'uniform float uTime;',
    'varying vec3 vColor;',
    'varying float vAlpha;',
    'void main() {',
    '  vColor = aColor;',
    '  float tw = 0.85 + 0.15 * sin(uTime * (1.5 + aTwinkle * 2.0) + aTwinkle * 40.0);',
    '  vAlpha = tw;',
    '  gl_PointSize = aSize * uPixelRatio * (0.92 + 0.08 * tw);',
    '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
    '}'
  ].join('\n');

  var STAR_FRAG = [
    'varying vec3 vColor;',
    'varying float vAlpha;',
    'void main() {',
    '  vec2 q = gl_PointCoord - vec2(0.5);',
    '  float d = length(q) * 2.0;',
    '  if (d > 1.0) discard;',
    '  float core = pow(1.0 - d, 2.2);',
    '  float soft = 1.0 - smoothstep(0.35, 1.0, d);',
    '  float a = clamp(core * 0.8 + soft * 0.5, 0.0, 1.0) * vAlpha;',
    '  gl_FragColor = vec4(vColor * a, a);',
    '}'
  ].join('\n');

  var SKY_VERT = [
    'varying vec3 vDir;',
    'void main() {',
    '  vDir = normalize(position);',
    '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
    '}'
  ].join('\n');

  var SKY_FRAG = [
    'uniform vec3 uPole;',
    'uniform vec3 uCenter;',
    'uniform float uPeak;',
    'varying vec3 vDir;',
    GLSL_NOISE,
    'void main() {',
    '  vec3 d = normalize(vDir);',
    '  vec3 pole = normalize(uPole);',
    '  vec3 cx = normalize(uCenter - pole * dot(uCenter, pole));',
    '  vec3 cy = cross(pole, cx);',
    '  float b = asin(clamp(dot(d, pole), -1.0, 1.0));',
    '  float l = atan(dot(d, cy), dot(d, cx));',
    '  vec3 np = d * 3.0;',
    '  float warp = fbm3(np * 0.9 + vec3(4.0), 3) * 0.10;',
    '  float bw = b + warp;',
    '  float width = 0.11 + 0.05 * (fbm3(vec3(l * 1.5, 0.3, 0.7), 2) + 1.0);',
    '  float band = exp(-(bw * bw) / (width * width));',
    '  float bulge = exp(-(l * l) / 1.1) * exp(-(bw * bw) / 0.06) * 0.9;',
    '  float dust = ridged3(np * 2.2 + vec3(9.0, 2.0, 5.0), 3);',
    '  float lane = smoothstep(0.55, 0.9, dust) * exp(-(bw * bw) / 0.010);',
    '  float glow = band * (0.75 + 0.35 * fbm3(np * 1.4, 3)) + bulge;',
    '  glow *= 1.0 - lane * 0.7;',
    '  float halo = exp(-(bw * bw) / 0.22) * 0.10;',
    '  float nebula = max(fbm3(np * 0.6 + vec3(20.0), 3), 0.0) * 0.05;',
    '  vec3 warm = vec3(0.95, 0.82, 0.68);',
    '  vec3 cool = vec3(0.62, 0.72, 0.95);',
    '  vec3 col = mix(cool, warm, clamp(band * 1.2 + bulge, 0.0, 1.0));',
    '  float i = (glow + halo + nebula) * uPeak;',
    '  gl_FragColor = vec4(col * i, 1.0);',
    '}'
  ].join('\n');

  /*
   * Orbital belt particles. Every particle is a Keplerian orbit propagated here
   * each frame; beltReference.positionOf() below is the line-by-line CPU twin
   * (same solver start, same iteration count, same rotation order), so keep the
   * two in step. Free orbit: M = M0 + n * days. Resonant orbit (p > 0): the
   * resonant argument phi = p lambda - q lambdaRef - (p - q) varpi librates about
   * phiCenter, which fixes lambda (and the mean motion (q / p) nRef) given the
   * reference planet's mean longitude uRefLon.
   */
  var KEPLER_ITERATIONS = 7;

  var BELT_VERT = [
    'precision highp float;',
    'attribute vec4 aOrbit;',
    'attribute vec4 aOrbit2;',
    'attribute vec4 aRes;',
    'attribute vec3 aLib;',
    'attribute vec3 color;',
    'uniform float uDays;',
    'uniform float uRefLon;',
    'uniform float uScale;',
    'uniform float uExponent;',
    'uniform float uPixelRatio;',
    'uniform float uSizeScale;',
    'varying vec3 vColor;',
    'const float PI = 3.141592653589793;',
    'const float TAU = 6.283185307179586;',
    'float wrapPi(float x) { return mod(x + PI, TAU) - PI; }',
    'void main() {',
    '  float a = aOrbit.x;',
    '  float e = aOrbit.y;',
    '  float inc = aOrbit.z;',
    '  float Om = aOrbit.w;',
    '  float w = aOrbit2.x;',
    '  float varpi = Om + w;',
    '  float M = aOrbit2.y + aOrbit2.z * uDays;',
    '  if (aRes.x > 0.5) {',
    '    float p = aRes.x;',
    '    float q = aRes.y;',
    '    float phi = aRes.z + aLib.x * sin(aLib.y + aLib.z * uDays);',
    '    float lambda = (q * uRefLon + (p - q) * varpi + phi) / p + aRes.w * TAU / p;',
    '    M = lambda - varpi;',
    '  }',
    '  M = wrapPi(M);',
    '  float E = M + e * sin(M);',
    '  for (int it = 0; it < ' + KEPLER_ITERATIONS + '; it++) {',
    '    E = E - (E - e * sin(E) - M) / (1.0 - e * cos(E));',
    '  }',
    '  float xp = a * (cos(E) - e);',
    '  float yp = a * sqrt(1.0 - e * e) * sin(E);',
    '  float cw = cos(w);',
    '  float sw = sin(w);',
    '  float cO = cos(Om);',
    '  float sO = sin(Om);',
    '  float ci = cos(inc);',
    '  float si = sin(inc);',
    '  float x = (cw * cO - sw * sO * ci) * xp + (-sw * cO - cw * sO * ci) * yp;',
    '  float y = (cw * sO + sw * cO * ci) * xp + (-sw * sO + cw * cO * ci) * yp;',
    '  float z = (sw * si) * xp + (cw * si) * yp;',
    '  float r = max(sqrt(x * x + y * y + z * z), 0.0001);',
    '  vec3 scenePos = vec3(x, z, -y) * (uScale * pow(r, uExponent - 1.0)) + position;',
    '  gl_Position = projectionMatrix * modelViewMatrix * vec4(scenePos, 1.0);',
    '  gl_PointSize = aOrbit2.w * uSizeScale * uPixelRatio;',
    '  vColor = color;',
    '}'
  ].join('\n');

  var BELT_FRAG = [
    'precision highp float;',
    'uniform float uOpacity;',
    'varying vec3 vColor;',
    'void main() {',
    '  float d = length(gl_PointCoord - vec2(0.5));',
    '  float alpha = (1.0 - smoothstep(0.25, 0.5, d)) * uOpacity;',
    '  if (alpha < 0.01) discard;',
    '  gl_FragColor = vec4(vColor, alpha);',
    '}'
  ].join('\n');

  /* ------------------------------------------------------------------ */
  /* THREE wrappers                                                      */
  /* ------------------------------------------------------------------ */

  function requireThree() {
    if (!THREE) throw new Error('OrreryVisuals.init(THREE) must be called first');
    return THREE;
  }

  function canvasFromPixels(px, w, h) {
    var canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    var ctx = canvas.getContext('2d');
    var img = ctx.createImageData(w, h);
    img.data.set(px);
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  function textureFromPixels(px, w, h, isColor) {
    var T = requireThree();
    var tex = new T.CanvasTexture(canvasFromPixels(px, w, h));
    tex.wrapS = T.RepeatWrapping;
    tex.wrapT = T.ClampToEdgeWrapping;
    if (isColor) tex.colorSpace = T.SRGBColorSpace;
    tex.needsUpdate = true;
    return tex;
  }

  var textureCache = {};

  var DEFAULT_SIZE = {
    mercury: 512, venus: 512, earth: 1024, mars: 512, jupiter: 1024, saturn: 1024,
    uranus: 512, neptune: 512, pluto: 512, moon: 512, sun: 512
  };
  MOON_NAMES.forEach(function (name) { DEFAULT_SIZE[name] = 512; });

  function planetTextures(name, size) {
    var w = size || DEFAULT_SIZE[name] || 1024;
    var key = name + ':' + w;
    if (textureCache[key]) return textureCache[key];
    var gen = pixels[name];
    if (!gen) throw new Error('OrreryVisuals: unknown body ' + name);
    var h = w >> 1;
    var raw = gen(w, h);
    var out = { map: textureFromPixels(raw.map, w, h, true) };
    if (raw.bumpMap) out.bumpMap = textureFromPixels(raw.bumpMap, w, h, false);
    if (raw.emissiveMap) out.emissiveMap = textureFromPixels(raw.emissiveMap, w, h, true);
    if (raw.cloudsMap) out.cloudsMap = textureFromPixels(raw.cloudsMap, w, h, true);
    if (raw.specularMap) out.specularMap = textureFromPixels(raw.specularMap, w, h, false);
    textureCache[key] = out;
    return out;
  }

  function ringTexture(name) {
    var T = requireThree();
    var key = 'ring:' + name;
    if (textureCache[key]) return textureCache[key];
    var w = 1024, h = 32;
    var tex = new T.CanvasTexture(canvasFromPixels(pixels.ring(name, w, h), w, h));
    tex.wrapS = T.ClampToEdgeWrapping;
    tex.wrapT = T.RepeatWrapping;
    tex.colorSpace = T.SRGBColorSpace;
    tex.needsUpdate = true;
    textureCache[key] = tex;
    return tex;
  }

  function sunMaterial() {
    var T = requireThree();
    return new T.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uBrightness: { value: 1.0 } },
      vertexShader: SUN_VERT,
      fragmentShader: SUN_FRAG,
      toneMapped: true
    });
  }

  function coronaMaterial(colorHex, intensity) {
    var T = requireThree();
    return new T.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uColor: { value: new T.Color(colorHex === undefined ? 0xffa64d : colorHex) },
        uIntensity: { value: intensity === undefined ? 1.0 : intensity }
      },
      vertexShader: CORONA_VERT,
      fragmentShader: CORONA_FRAG,
      transparent: true,
      depthWrite: false,
      blending: T.AdditiveBlending,
      side: T.DoubleSide
    });
  }

  function atmosphereMaterial(colorHex, power, intensity, shellScale) {
    var T = requireThree();
    var s = shellScale || 1.06;
    var limb = Math.sqrt(Math.max(1e-4, 1 - 1 / (s * s)));
    return new T.ShaderMaterial({
      uniforms: {
        uColor: { value: new T.Color(colorHex === undefined ? 0x4d8dff : colorHex) },
        uPower: { value: power === undefined ? 3.0 : power },
        uIntensity: { value: intensity === undefined ? 1.0 : intensity },
        uLimb: { value: limb }
      },
      vertexShader: ATMO_VERT,
      fragmentShader: ATMO_FRAG,
      side: T.BackSide,
      transparent: true,
      depthWrite: false,
      blending: T.AdditiveBlending
    });
  }

  /* Approximate blackbody tint for a star temperature (K), normalised so the max channel is 1. */
  function starColor(temp, out) {
    var stops = [
      [2800, [1.00, 0.55, 0.30]],
      [3800, [1.00, 0.72, 0.48]],
      [5000, [1.00, 0.86, 0.70]],
      [6000, [1.00, 0.96, 0.90]],
      [7500, [0.92, 0.94, 1.00]],
      [10000, [0.78, 0.85, 1.00]],
      [20000, [0.66, 0.76, 1.00]]
    ];
    var t = clamp01((temp - 2800) / (20000 - 2800));
    var i, n = stops.length;
    for (i = 0; i < n; i++) stops[i][0] = (stops[i][0] - 2800) / (20000 - 2800);
    return gradient(stops, t, out);
  }

  function starfield(radius, count) {
    var T = requireThree();
    radius = radius || 6000; count = count || 14000;
    var rng = mulberry32(31337);
    var pos = new Float32Array(count * 3), col = new Float32Array(count * 3);
    var size = new Float32Array(count), tw = new Float32Array(count);
    /* galactic plane: tilted great circle */
    var gpx = 0.36, gpy = 0.82, gpz = -0.44;
    var gl = Math.sqrt(gpx * gpx + gpy * gpy + gpz * gpz); gpx /= gl; gpy /= gl; gpz /= gl;
    var c = [0, 0, 0], i, x, y, z, len, k, dotg, temp, sz, brightness;
    for (i = 0; i < count; i++) {
      do { x = rng() * 2 - 1; y = rng() * 2 - 1; z = rng() * 2 - 1; len = x * x + y * y + z * z; } while (len > 1 || len < 1e-6);
      len = Math.sqrt(len); x /= len; y /= len; z /= len;
      if (rng() < 0.42) {
        k = 0.55 + 0.42 * rng();
        dotg = x * gpx + y * gpy + z * gpz;
        x -= gpx * dotg * k; y -= gpy * dotg * k; z -= gpz * dotg * k;
        len = Math.sqrt(x * x + y * y + z * z); x /= len; y /= len; z /= len;
      }
      pos[i * 3] = x * radius; pos[i * 3 + 1] = y * radius; pos[i * 3 + 2] = z * radius;
      var u = rng();
      temp = u < 0.55 ? 3000 + rng() * 2500 : (u < 0.9 ? 5000 + rng() * 3000 : 8000 + rng() * 12000);
      starColor(temp, c);
      var m = rng();
      if (m < 0.004) { sz = 5.0 + rng() * 2.5; brightness = 1.0; }
      else if (m < 0.04) { sz = 2.6 + rng() * 1.6; brightness = 0.9; }
      else if (m < 0.25) { sz = 1.6 + rng() * 0.8; brightness = 0.55 + rng() * 0.3; }
      else { sz = 1.0 + rng() * 0.6; brightness = 0.28 + rng() * 0.3; }
      col[i * 3] = c[0] * brightness; col[i * 3 + 1] = c[1] * brightness; col[i * 3 + 2] = c[2] * brightness;
      size[i] = sz; tw[i] = rng();
    }
    var geo = new T.BufferGeometry();
    geo.setAttribute('position', new T.BufferAttribute(pos, 3));
    geo.setAttribute('aColor', new T.BufferAttribute(col, 3));
    geo.setAttribute('aSize', new T.BufferAttribute(size, 1));
    geo.setAttribute('aTwinkle', new T.BufferAttribute(tw, 1));
    var pr = (typeof window !== 'undefined' && window.devicePixelRatio) ? Math.min(window.devicePixelRatio, 2) : 1;
    var mat = new T.ShaderMaterial({
      uniforms: { uPixelRatio: { value: pr }, uTime: { value: 0 } },
      vertexShader: STAR_VERT,
      fragmentShader: STAR_FRAG,
      transparent: true,
      depthWrite: false,
      blending: T.AdditiveBlending
    });
    var points = new T.Points(geo, mat);
    points.frustumCulled = false;
    points.renderOrder = -1;
    points.name = 'starfield';
    return points;
  }

  function milkyWay(radius) {
    var T = requireThree();
    radius = radius || 6500;
    var geo = new T.SphereGeometry(radius, 48, 32);
    var mat = new T.ShaderMaterial({
      uniforms: {
        uPole: { value: new T.Vector3(0.36, 0.82, -0.44).normalize() },
        uCenter: { value: new T.Vector3(-0.7, 0.1, -0.6).normalize() },
        uPeak: { value: 0.032 }
      },
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: T.BackSide,
      depthWrite: false,
      transparent: false
    });
    var mesh = new T.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = -2;
    mesh.name = 'milkyway';
    return mesh;
  }

  function asteroidBelt(innerRadius, outerRadius, count) {
    var T = requireThree();
    count = count || 4000;
    var rng = mulberry32(4242);
    var pos = new Float32Array(count * 3);
    var span = outerRadius - innerRadius, i, r, a, g;
    for (i = 0; i < count; i++) {
      /* triangular-ish radial density peaking mid-belt */
      r = innerRadius + span * (0.5 + (rng() + rng() + rng() - 1.5) / 2.4);
      r = clamp(r, innerRadius, outerRadius);
      a = rng() * TAU;
      g = (rng() + rng() + rng() - 1.5) / 1.5;
      pos[i * 3] = Math.cos(a) * r;
      pos[i * 3 + 1] = g * span * 0.10;
      pos[i * 3 + 2] = -Math.sin(a) * r;
    }
    var geo = new T.BufferGeometry();
    geo.setAttribute('position', new T.BufferAttribute(pos, 3));
    var mat = new T.PointsMaterial({
      color: 0x9a9690, size: 1.4, sizeAttenuation: false,
      transparent: true, opacity: 0.45, depthWrite: false
    });
    var points = new T.Points(geo, mat);
    points.name = 'asteroidBelt';
    return points;
  }

  /* Kuiper belt: a broad, puffy annulus of icy bodies. Radii are sampled in AU
   * from a profile peaking in the classical belt (42-48 AU), with the plutino
   * population near 39.4 AU, a sparse inner scattered region and a thin tail
   * outward, then mapped to scene units by the caller's mapRadius(au) so the
   * belt follows whatever distance compression the scene uses. Inclinations
   * are larger than the asteroid belt's, so the thickness grows with radius. */
  function kuiperBelt(innerAu, outerAu, count, mapRadius) {
    var T = requireThree();
    innerAu = innerAu || 30; outerAu = outerAu || 50; count = count || 9000;
    var rng = mulberry32(777);
    var pos = new Float32Array(count * 3);
    var col = new Float32Array(count * 3);
    var i, t, au, r, a, inc, g;
    for (i = 0; i < count; i++) {
      t = rng();
      if (t < 0.62) au = 42 + 6 * (0.5 + (rng() + rng() + rng() - 1.5) / 2.2);
      else if (t < 0.80) au = 39.4 + (rng() + rng() - 1) * 1.6;
      else if (t < 0.92) au = innerAu + (42 - innerAu) * rng();
      else au = 48 + (outerAu - 48) * Math.pow(rng(), 0.7);
      au = clamp(au, innerAu, outerAu);
      r = mapRadius ? mapRadius(au) : au;
      a = rng() * TAU;
      inc = (rng() + rng() + rng() - 1.5) / 1.5 * 0.22;
      pos[i * 3] = Math.cos(a) * r;
      pos[i * 3 + 1] = r * Math.tan(inc) * 0.6;
      pos[i * 3 + 2] = -Math.sin(a) * r;
      g = 0.55 + rng() * 0.45;
      col[i * 3] = 0.66 * g; col[i * 3 + 1] = 0.72 * g; col[i * 3 + 2] = 0.86 * g;
    }
    var geo = new T.BufferGeometry();
    geo.setAttribute('position', new T.BufferAttribute(pos, 3));
    geo.setAttribute('color', new T.BufferAttribute(col, 3));
    var mat = new T.PointsMaterial({
      vertexColors: true, size: 1.3, sizeAttenuation: false,
      transparent: true, opacity: 0.38, depthWrite: false
    });
    var points = new T.Points(geo, mat);
    points.name = 'kuiperBelt';
    return points;
  }

  /* ------------------------------------------------------------------ */
  /* Orbital belts: populations of real orbits propagated on the GPU     */
  /* ------------------------------------------------------------------ */

  /*
   * orbitalBelt({ kind: 'asteroid' | 'kuiper', count }) -> THREE.Points whose
   * particles are Keplerian orbits (ecliptic J2000, AU, radians) propagated by the
   * BELT_VERT shader every frame. Per-particle attributes:
   *
   *   aOrbit   = (a AU, e, i, Omega)
   *   aOrbit2  = (omega, M0 at J2000, n rad/day, point size px)
   *   aRes     = (p, q, phiCenter, k)   p = 0: free orbit; otherwise locked in the p:q
   *                                     mean-motion resonance with the reference planet
   *   aLib     = (amplitude, phase, rate rad/day)   libration of the resonant argument
   *   color    = (r, g, b)              every channel < 1 so the bloom pass ignores it
   *   position = (0, 0, 0)              three.js takes the draw count from it
   *
   * Resonant orbits: phi = p lambda - q lambdaRef - (p - q) varpi librates about
   * phiCenter, phi = phiCenter + amplitude sin(phase + rate days), so
   * lambda = (q lambdaRef + (p - q) varpi + phi) / p + 2 pi k / p, M = lambda - varpi
   * and the mean motion (q / p) nRef follows automatically:
   *   plutinos  p 3 q 2 about pi     perihelion passages 90 deg from Neptune
   *   twotinos  p 2 q 1 about pi     perihelion passages opposite Neptune
   *   Hildas    p 2 q 3 about 0      aphelia at L3, L4 and L5 (the Hilda triangle)
   *   Trojans   p 1 q 1 about +-60   the L4 and L5 clouds
   * (An interior 3:2 resonance needs p = 2, q = 3 in this form: the Hilda makes
   * three orbits per two of Jupiter, so lambda = (3 lambdaJ - varpi + phi) / 2.)
   *
   * Uniforms: uDays (TT days since J2000), uRefLon (mean longitude of the reference
   * planet, radians), uScale and uExponent (scene = (x, z, -y) uScale r^(uExponent - 1)),
   * uPixelRatio, uOpacity, uSizeScale. points.userData = { kind, refBody, count }.
   *
   * beltReference exposes the generator and the CPU twin of the vertex shader so the
   * orbit math can be tested in Node (scripts/verify_belts.js).
   */

  var D2R = Math.PI / 180;
  var GOLDEN = 0.6180339887498949;

  var BELT_DEFAULTS = {
    asteroid: { count: 9000, opacity: 0.5, refBody: 'jupiter', seed: 90210 },
    kuiper: { count: 14000, opacity: 0.45, refBody: 'neptune', seed: 48151 }
  };

  /* Kirkwood gaps: [centre AU, half width AU]; main-belt a is resampled when inside one. */
  var KIRKWOOD_GAPS = [[2.065, 0.015], [2.502, 0.025], [2.825, 0.02], [2.958, 0.015], [3.279, 0.03]];

  function uniform(rng, lo, hi) { return lo + (hi - lo) * rng(); }

  /* Rayleigh(sigma), rejection-sampled into [lo, hi] (clamped if 64 draws all miss). */
  function rayleigh(rng, sigma, lo, hi) {
    var v, tries = 0;
    do { v = sigma * Math.sqrt(-2 * Math.log(1 - rng())); } while ((v < lo || v > hi) && ++tries < 64);
    return clamp(v, lo, hi);
  }

  function normal(rng, mu, sigma) {
    return mu + sigma * Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(TAU * rng());
  }

  function inKirkwoodGap(a) {
    var g;
    for (g = 0; g < KIRKWOOD_GAPS.length; g++) {
      if (Math.abs(a - KIRKWOOD_GAPS[g][0]) < KIRKWOOD_GAPS[g][1]) return true;
    }
    return false;
  }

  /* Samplers fill o = { a, e, i, p, q, phiCenter, k, amp (rad), period (years) }. */
  function mainBelt(lo, hi) {
    return function (rng, o) {
      var tries = 0;
      do { o.a = uniform(rng, lo, hi); } while (inKirkwoodGap(o.a) && ++tries < 64);
      o.e = rayleigh(rng, 0.10, 0, 0.35);
      o.i = rayleigh(rng, 7 * D2R, 0, 30 * D2R);
    };
  }

  function trojan(centerDeg) {
    return function (rng, o) {
      o.a = normal(rng, 5.2, 0.1);
      o.e = rayleigh(rng, 0.06, 0, 0.2);
      o.i = rayleigh(rng, 11 * D2R, 0, 35 * D2R);
      o.p = 1; o.q = 1; o.phiCenter = centerDeg * D2R; o.k = 0;
      o.amp = uniform(rng, 2, 30) * D2R;
      o.period = normal(rng, 150, 20);
    };
  }

  var BELT_GROUPS = {
    kuiper: [
      { name: 'cold classical', frac: 0.32, color: [0.86, 0.70, 0.58],
        sample: function (rng, o) {
          o.a = uniform(rng, 42, 47.5);
          o.e = rayleigh(rng, 0.04, 0, 0.12);
          o.i = rayleigh(rng, 2.2 * D2R, 0, 7 * D2R);
        } },
      { name: 'hot classical', frac: 0.26, color: [0.72, 0.74, 0.80],
        sample: function (rng, o) {
          o.a = uniform(rng, 40, 48);
          o.e = rayleigh(rng, 0.11, 0, 0.30);
          o.i = rayleigh(rng, 13 * D2R, 0, 40 * D2R);
        } },
      { name: 'plutino', frac: 0.22, color: [0.80, 0.70, 0.64],
        sample: function (rng, o) {
          o.a = normal(rng, 39.45, 0.25);
          o.e = rayleigh(rng, 0.14, 0.03, 0.34);
          o.i = rayleigh(rng, 11 * D2R, 0, 35 * D2R);
          o.p = 3; o.q = 2; o.phiCenter = Math.PI; o.k = Math.floor(rng() * 3);
          o.amp = uniform(rng, 15, 90) * D2R;
          o.period = normal(rng, 20000, 3000);
        } },
      { name: 'twotino', frac: 0.06, color: [0.74, 0.72, 0.78],
        sample: function (rng, o) {
          o.a = normal(rng, 47.8, 0.15);
          o.e = uniform(rng, 0.10, 0.35);
          o.i = rayleigh(rng, 8 * D2R, 0, 30 * D2R);
          o.p = 2; o.q = 1; o.phiCenter = Math.PI; o.k = Math.floor(rng() * 2);
          o.amp = uniform(rng, 20, 60) * D2R;
          o.period = normal(rng, 20000, 4000);
        } },
      { name: 'scattered disk', frac: 0.14, color: [0.66, 0.72, 0.86],
        sample: function (rng, o) {
          var q = uniform(rng, 30, 40);
          o.a = Math.exp(uniform(rng, Math.log(50), Math.log(150)));
          o.e = Math.min(0.75, 1 - q / o.a);
          o.i = rayleigh(rng, 15 * D2R, 0, 45 * D2R);
        } }
    ],
    asteroid: [
      { name: 'inner main belt', frac: 0.30, color: [0.70, 0.66, 0.60], sample: mainBelt(2.1, 2.5) },
      { name: 'middle main belt', frac: 0.32, color: [0.70, 0.66, 0.60], sample: mainBelt(2.5, 2.82) },
      { name: 'outer main belt', frac: 0.26, color: [0.70, 0.66, 0.60], sample: mainBelt(2.82, 3.3) },
      { name: 'hilda', frac: 0.05, color: [0.62, 0.56, 0.50],
        sample: function (rng, o) {
          o.a = normal(rng, 3.97, 0.04);
          o.e = uniform(rng, 0.07, 0.30);
          o.i = rayleigh(rng, 7 * D2R, 0, 20 * D2R);
          o.p = 2; o.q = 3; o.phiCenter = 0; o.k = Math.floor(rng() * 2);
          o.amp = uniform(rng, 5, 40) * D2R;
          o.period = normal(rng, 270, 30);
        } },
      { name: 'trojan L4', frac: 0.07 * 0.55, color: [0.62, 0.62, 0.66], sample: trojan(60) },
      { name: 'trojan L5', frac: 0.07 * 0.45, color: [0.62, 0.62, 0.66], sample: trojan(-60) }
    ]
  };

  /*
   * Seeded, deterministic population of one belt. Returns typed arrays laid out
   * exactly like the geometry attributes (one generator serves both the THREE
   * builder and the tests), the per-particle group index and the group names.
   */
  function generateBelt(kind, count) {
    var def = BELT_DEFAULTS[kind];
    if (!def) throw new Error('OrreryVisuals: unknown belt kind "' + kind + '"');
    count = (count | 0) > 0 ? (count | 0) : def.count;
    var groups = BELT_GROUPS[kind];
    var rng = mulberry32(def.seed);
    var aOrbit = new Float32Array(count * 4), aOrbit2 = new Float32Array(count * 4);
    var aRes = new Float32Array(count * 4), aLib = new Float32Array(count * 3);
    var colors = new Float32Array(count * 3), group = new Uint8Array(count);
    var names = [], cum = [], total = 0, g, i, gi, grp, u, n, size, bright, rate, c;
    var o = { a: 0, e: 0, i: 0, p: 0, q: 0, phiCenter: 0, k: 0, amp: 0, period: 0 };
    for (g = 0; g < groups.length; g++) { total += groups[g].frac; names.push(groups[g].name); }
    for (g = 0; g < groups.length; g++) cum.push((g ? cum[g - 1] : 0) + groups[g].frac / total);
    for (i = 0; i < count; i++) {
      /* golden-ratio sequence: exact group proportions, groups interleaved in draw order */
      u = ((i + 0.5) * GOLDEN) % 1;
      for (gi = 0; gi < groups.length - 1 && u >= cum[gi]; gi++) { /* pick group */ }
      grp = groups[gi];
      o.a = 0; o.e = 0; o.i = 0; o.p = 0; o.q = 0; o.phiCenter = 0; o.k = 0; o.amp = 0; o.period = 0;
      grp.sample(rng, o);
      n = TAU / (Math.pow(o.a, 1.5) * 365.25);
      size = rng() < 0.04 ? uniform(rng, 2.0, 2.6) : uniform(rng, 1.0, 1.6);
      bright = uniform(rng, 0.55, 1.0);
      rate = o.period > 0 ? TAU / (o.period * 365.25) : 0;
      aOrbit[i * 4] = o.a; aOrbit[i * 4 + 1] = o.e; aOrbit[i * 4 + 2] = o.i; aOrbit[i * 4 + 3] = rng() * TAU;
      aOrbit2[i * 4] = rng() * TAU; aOrbit2[i * 4 + 1] = rng() * TAU; aOrbit2[i * 4 + 2] = n; aOrbit2[i * 4 + 3] = size;
      aRes[i * 4] = o.p; aRes[i * 4 + 1] = o.q; aRes[i * 4 + 2] = o.phiCenter; aRes[i * 4 + 3] = o.k;
      aLib[i * 3] = o.amp; aLib[i * 3 + 1] = rng() * TAU; aLib[i * 3 + 2] = rate;
      c = grp.color;
      colors[i * 3] = c[0] * bright; colors[i * 3 + 1] = c[1] * bright; colors[i * 3 + 2] = c[2] * bright;
      group[i] = gi;
    }
    return {
      kind: kind, count: count, refBody: def.refBody, opacity: def.opacity,
      groups: names, group: group,
      elements: { aOrbit: aOrbit, aOrbit2: aOrbit2, aRes: aRes, aLib: aLib },
      colors: colors
    };
  }

  /* Plain-object view of particle i of a generated belt (the float32 values the GPU sees). */
  function beltParticle(gen, i) {
    var o = gen.elements.aOrbit, o2 = gen.elements.aOrbit2, r = gen.elements.aRes, l = gen.elements.aLib;
    return {
      a: o[i * 4], e: o[i * 4 + 1], i: o[i * 4 + 2], Omega: o[i * 4 + 3],
      omega: o2[i * 4], M0: o2[i * 4 + 1], n: o2[i * 4 + 2], size: o2[i * 4 + 3],
      p: r[i * 4], q: r[i * 4 + 1], phiCenter: r[i * 4 + 2], k: r[i * 4 + 3],
      amp: l[i * 3], phase: l[i * 3 + 1], rate: l[i * 3 + 2],
      group: gen.groups[gen.group[i]]
    };
  }

  function wrapPi(x) { return x - TAU * Math.floor((x + Math.PI) / TAU); }

  /* Kepler's equation by Newton, exactly as the vertex shader does it. */
  function solveKepler(M, e) {
    var E = M + e * Math.sin(M), it;
    for (it = 0; it < KEPLER_ITERATIONS; it++) {
      E = E - (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    }
    return E;
  }

  /*
   * CPU twin of BELT_VERT: heliocentric ecliptic J2000 position (AU) of a particle
   * at `days` (TT days since J2000) with the reference planet at mean longitude
   * refLon (radians). Also returns r, the wrapped mean anomaly M and varpi.
   */
  function positionOf(pt, days, refLon) {
    var varpi = pt.Omega + pt.omega;
    var M = pt.M0 + pt.n * days;
    if (pt.p > 0.5) {
      var phi = pt.phiCenter + pt.amp * Math.sin(pt.phase + pt.rate * days);
      var lambda = (pt.q * refLon + (pt.p - pt.q) * varpi + phi) / pt.p + pt.k * TAU / pt.p;
      M = lambda - varpi;
    }
    M = wrapPi(M);
    var E = solveKepler(M, pt.e);
    var xp = pt.a * (Math.cos(E) - pt.e);
    var yp = pt.a * Math.sqrt(1 - pt.e * pt.e) * Math.sin(E);
    var cw = Math.cos(pt.omega), sw = Math.sin(pt.omega);
    var cO = Math.cos(pt.Omega), sO = Math.sin(pt.Omega);
    var ci = Math.cos(pt.i), si = Math.sin(pt.i);
    var x = (cw * cO - sw * sO * ci) * xp + (-sw * cO - cw * sO * ci) * yp;
    var y = (cw * sO + sw * cO * ci) * xp + (-sw * sO + cw * cO * ci) * yp;
    var z = (sw * si) * xp + (cw * si) * yp;
    return { x: x, y: y, z: z, r: Math.sqrt(x * x + y * y + z * z), M: M, E: E, varpi: varpi };
  }

  function orbitalBelt(opts) {
    var T = requireThree();
    opts = opts || {};
    var def = BELT_DEFAULTS[opts.kind];
    if (!def) throw new Error('OrreryVisuals.orbitalBelt: kind must be "asteroid" or "kuiper"');
    var gen = generateBelt(opts.kind, opts.count);
    var count = gen.count;
    var geo = new T.BufferGeometry();
    geo.setAttribute('position', new T.BufferAttribute(new Float32Array(count * 3), 3));
    geo.setAttribute('aOrbit', new T.BufferAttribute(gen.elements.aOrbit, 4));
    geo.setAttribute('aOrbit2', new T.BufferAttribute(gen.elements.aOrbit2, 4));
    geo.setAttribute('aRes', new T.BufferAttribute(gen.elements.aRes, 4));
    geo.setAttribute('aLib', new T.BufferAttribute(gen.elements.aLib, 3));
    geo.setAttribute('color', new T.BufferAttribute(gen.colors, 3));
    var pr = (typeof window !== 'undefined' && window.devicePixelRatio) ? Math.min(window.devicePixelRatio, 2) : 1;
    var mat = new T.ShaderMaterial({
      uniforms: {
        uDays: { value: 0 },
        uRefLon: { value: 0 },
        uScale: { value: opts.scale === undefined ? 22 : opts.scale },
        uExponent: { value: opts.exponent === undefined ? 0.6 : opts.exponent },
        uPixelRatio: { value: pr },
        uOpacity: { value: opts.opacity === undefined ? def.opacity : opts.opacity },
        uSizeScale: { value: 1 }
      },
      vertexShader: BELT_VERT,
      fragmentShader: BELT_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: T.NormalBlending
    });
    var points = new T.Points(geo, mat);
    points.frustumCulled = false;
    points.name = opts.kind === 'kuiper' ? 'kuiperBelt' : 'asteroidBelt';
    points.userData = { kind: opts.kind, refBody: def.refBody, count: count };
    return points;
  }

  var beltReference = {
    generate: generateBelt,
    particle: beltParticle,
    positionOf: positionOf,
    solveKepler: solveKepler,
    wrapPi: wrapPi,
    defaults: BELT_DEFAULTS,
    groups: BELT_GROUPS,
    kirkwoodGaps: KIRKWOOD_GAPS,
    KEPLER_ITERATIONS: KEPLER_ITERATIONS,
    shaders: { BELT_VERT: BELT_VERT, BELT_FRAG: BELT_FRAG }
  };

  /* ------------------------------------------------------------------ */
  /* Public API                                                          */
  /* ------------------------------------------------------------------ */

  var PLANET_STYLE = {
    sun: { color: 0xffc46b },
    mercury: { color: 0xb1adaa },
    venus: { color: 0xe8cda0 },
    earth: { color: 0x6fa8ff },
    moon: { color: 0xc9c9c9 },
    mars: { color: 0xff7a4d },
    jupiter: { color: 0xe0b48c },
    saturn: { color: 0xf0d9a0 },
    uranus: { color: 0x9ee5ee },
    neptune: { color: 0x5f7fff },
    pluto: { color: 0xd8c2b0 }
  };
  /* label / orbit accent for each planetary moon (grey and tan tints, Io and Titan orange, Triton pink) */
  MOON_NAMES.forEach(function (name) { PLANET_STYLE[name] = { color: MOON_SPECS[name].accent }; });

  var ATMOSPHERE = {
    earth: { color: 0x4d8dff, power: 3.0, intensity: 1.2 },
    venus: { color: 0xf2dca6, power: 2.2, intensity: 1.4 },
    mars: { color: 0xd9a070, power: 4.0, intensity: 0.45 },
    jupiter: { color: 0xe8c9a0, power: 3.5, intensity: 0.5 },
    saturn: { color: 0xf3dfae, power: 3.5, intensity: 0.45 },
    uranus: { color: 0xa8ecf2, power: 3.0, intensity: 0.6 },
    neptune: { color: 0x6f8fff, power: 3.0, intensity: 0.7 }
  };

  var OrreryVisuals = {
    init: function (three) { THREE = three; return OrreryVisuals; },
    planetTextures: planetTextures,
    ringTexture: ringTexture,
    sunMaterial: sunMaterial,
    coronaMaterial: coronaMaterial,
    atmosphereMaterial: atmosphereMaterial,
    starfield: starfield,
    milkyWay: milkyWay,
    asteroidBelt: asteroidBelt,
    kuiperBelt: kuiperBelt,
    orbitalBelt: orbitalBelt,
    beltReference: beltReference,
    PLANET_STYLE: PLANET_STYLE,
    ATMOSPHERE: ATMOSPHERE,
    DEFAULT_SIZE: DEFAULT_SIZE,
    /* pure helpers (no THREE / DOM) for tests and tooling */
    pixels: pixels,
    smallBody: { generate: genSmallBody, specs: MOON_SPECS, names: MOON_NAMES },
    noise: { makeNoise: makeNoise, fbm: fbm, ridged: ridged, warped: warped, mulberry32: mulberry32 },
    shaders: {
      GLSL_NOISE: GLSL_NOISE, SUN_VERT: SUN_VERT, SUN_FRAG: SUN_FRAG, CORONA_VERT: CORONA_VERT,
      CORONA_FRAG: CORONA_FRAG, ATMO_VERT: ATMO_VERT, ATMO_FRAG: ATMO_FRAG, STAR_VERT: STAR_VERT,
      STAR_FRAG: STAR_FRAG, SKY_VERT: SKY_VERT, SKY_FRAG: SKY_FRAG, BELT_VERT: BELT_VERT, BELT_FRAG: BELT_FRAG
    }
  };

  global.OrreryVisuals = OrreryVisuals;
})(typeof window !== 'undefined' ? window : globalThis);
