#!/usr/bin/env node
/*
 * verify_moon_textures.js -- exercise the procedural moon textures in web/visuals.js
 * without a browser.
 *
 *   node scripts/verify_moon_textures.js [--png DIR]
 *
 * For each moon in Moons.NAMES it runs the pure pixel generator at 512 x 256 and reports
 * generation time, value ranges, zero (NaN) channels, horizontal seam continuity (the
 * |col 0 - col w-1| difference against an interior neighbour difference), and the
 * luminance spread along the polar rows (large values would mean polar pinching). It then
 * runs OrreryVisuals.planetTextures() against a stub THREE / document to check the wrapper
 * contract (CanvasTexture map + bumpMap, SRGB colour space on the map, 512 x 256, cached).
 * With --png DIR it also writes contact sheets (colour and bump) as PNGs.
 * Exit status is non-zero when any check fails.
 */
'use strict';
var fs = require('fs');
var path = require('path');
var zlib = require('zlib');

var ROOT = path.resolve(__dirname, '..');
require(path.join(ROOT, 'web', 'visuals.js'));
var Moons = require(path.join(ROOT, 'web', 'moons.js'));
var V = globalThis.OrreryVisuals;

var args = process.argv.slice(2);
var pngDir = null;
for (var ai = 0; ai < args.length; ai++) if (args[ai] === '--png') pngDir = args[++ai];

var W = 512, H = 256, LIMIT_MS = 60;
var names = Moons.NAMES;
var failures = [];
function fail(msg) { failures.push(msg); console.log('FAIL: ' + msg); }

/* ---- contract: every moon has a generator, an accent colour and a default size ------- */
names.forEach(function (n) {
  if (typeof V.pixels[n] !== 'function') fail('pixels.' + n + ' missing');
  var st = V.PLANET_STYLE[n];
  if (!st || typeof st.color !== 'number' || st.color < 0 || st.color > 0xffffff) fail('PLANET_STYLE.' + n + ' has no hex accent');
  if (V.DEFAULT_SIZE[n] !== 512) fail('DEFAULT_SIZE.' + n + ' !== 512');
});
if (V.smallBody.names.join(',') !== names.join(',')) fail('OrreryVisuals.smallBody.names differs from Moons.NAMES');

/* ---- per-map statistics -------------------------------------------------------------- */
function stats(px, w, h) {
  var n = w * h, i, c, v, y, x;
  var min = [255, 255, 255], max = [0, 0, 0], sum = [0, 0, 0], zeros = 0, alphaBad = 0;
  for (i = 0; i < n; i++) {
    for (c = 0; c < 3; c++) {
      v = px[i * 4 + c];
      if (v === 0) zeros++;
      if (v < min[c]) min[c] = v;
      if (v > max[c]) max[c] = v;
      sum[c] += v;
    }
    if (px[i * 4 + 3] !== 255) alphaBad++;
  }
  var seam = 0, inner = 0;
  for (y = 0; y < h; y++) {
    var a = (y * w) * 4, b = (y * w + w - 1) * 4, k = (y * w + (w >> 1)) * 4;
    for (c = 0; c < 3; c++) {
      seam += Math.abs(px[a + c] - px[b + c]);
      inner += Math.abs(px[k + c] - px[k + 4 + c]);
    }
  }
  seam /= h * 3; inner /= h * 3;
  function spread(row) {
    var lo = 1e9, hi = -1e9;
    for (x = 0; x < w; x++) {
      var o = (row * w + x) * 4, l = 0.299 * px[o] + 0.587 * px[o + 1] + 0.114 * px[o + 2];
      if (l < lo) lo = l;
      if (l > hi) hi = l;
    }
    return hi - lo;
  }
  return {
    min: min, max: max, mean: sum.map(function (s) { return s / n; }),
    zeros: zeros, alphaBad: alphaBad, seam: seam, inner: inner,
    top: spread(0), mid: spread(h >> 1), bot: spread(h - 1)
  };
}

var results = {}, totalCold = 0, totalWarm = 0;
console.log('name        cold ms  warm ms | map min..max (mean)                     zeros | seam/inner | pole spread top/mid/bot | bump min..max seam/inner');
names.forEach(function (name) {
  var gen = V.pixels[name];
  var t0 = process.hrtime.bigint();
  var out = gen(W, H);
  var cold = Number(process.hrtime.bigint() - t0) / 1e6;
  var t1 = process.hrtime.bigint();
  var again = gen(W, H);
  var warm = Number(process.hrtime.bigint() - t1) / 1e6;
  totalCold += cold; totalWarm += warm;
  if (!(out.map instanceof Uint8ClampedArray) || out.map.length !== W * H * 4) fail(name + ': map is not a ' + W + 'x' + H + ' RGBA Uint8ClampedArray');
  if (!(out.bumpMap instanceof Uint8ClampedArray) || out.bumpMap.length !== W * H * 4) fail(name + ': bumpMap is not a ' + W + 'x' + H + ' RGBA Uint8ClampedArray');
  for (var i = 0; i < out.map.length; i += 991) {
    if (out.map[i] !== again.map[i]) { fail(name + ': generator is not deterministic'); break; }
  }
  var sm = stats(out.map, W, H), sb = stats(out.bumpMap, W, H);
  if (sm.zeros) fail(name + ': map has ' + sm.zeros + ' zero channels (NaN or black)');
  if (sb.zeros) fail(name + ': bump has ' + sb.zeros + ' zero channels (NaN)');
  if (sm.alphaBad || sb.alphaBad) fail(name + ': alpha is not 255 everywhere');
  if (sm.seam > 3 * sm.inner + 4) fail(name + ': map seam ' + sm.seam.toFixed(2) + ' vs interior ' + sm.inner.toFixed(2));
  if (sb.seam > 3 * sb.inner + 4) fail(name + ': bump seam ' + sb.seam.toFixed(2) + ' vs interior ' + sb.inner.toFixed(2));
  if (sm.top > 0.6 * sm.mid + 20 || sm.bot > 0.6 * sm.mid + 20) fail(name + ': polar rows vary as much as the equator (pinching?)');
  if (cold > LIMIT_MS) fail(name + ': ' + cold.toFixed(1) + ' ms exceeds ' + LIMIT_MS + ' ms');
  results[name] = out;
  console.log(
    name.padEnd(11) + cold.toFixed(1).padStart(8) + warm.toFixed(1).padStart(9) + ' | ' +
    (sm.min.join('/') + '..' + sm.max.join('/') + ' (' + sm.mean.map(function (m) { return m.toFixed(0); }).join('/') + ')').padEnd(40) +
    String(sm.zeros).padStart(5) + ' | ' + (sm.seam.toFixed(2) + '/' + sm.inner.toFixed(2)).padEnd(10) + ' | ' +
    (sm.top.toFixed(0) + '/' + sm.mid.toFixed(0) + '/' + sm.bot.toFixed(0)).padEnd(23) + ' | ' +
    sb.min[0] + '..' + sb.max[0] + ' ' + sb.seam.toFixed(2) + '/' + sb.inner.toFixed(2)
  );
});
console.log('total: cold ' + totalCold.toFixed(0) + ' ms, warm ' + totalWarm.toFixed(0) + ' ms for ' + names.length + ' moons at ' + W + 'x' + H);

/* ---- planetTextures() through a stub THREE and document ------------------------------ */
globalThis.document = {
  createElement: function () {
    var canvas = { width: 0, height: 0 };
    canvas.getContext = function () {
      return {
        createImageData: function (w, h) { return { data: new Uint8ClampedArray(w * h * 4) }; },
        putImageData: function (img) { canvas.data = img.data; }
      };
    };
    return canvas;
  }
};
function CanvasTexture(canvas) { this.image = canvas; this.colorSpace = 'linear'; }
V.init({ CanvasTexture: CanvasTexture, RepeatWrapping: 'repeat', ClampToEdgeWrapping: 'clamp', SRGBColorSpace: 'srgb' });
names.forEach(function (name) {
  var tex = V.planetTextures(name);
  if (!(tex.map instanceof CanvasTexture)) fail(name + ': planetTextures().map is not a CanvasTexture');
  if (!(tex.bumpMap instanceof CanvasTexture)) fail(name + ': planetTextures().bumpMap is not a CanvasTexture');
  if (tex.map.colorSpace !== 'srgb') fail(name + ': map colour space is not SRGB');
  if (tex.bumpMap.colorSpace !== 'linear') fail(name + ': bump map should stay linear');
  if (tex.map.image.width !== 512 || tex.map.image.height !== 256) fail(name + ': map canvas is not 512x256');
  if (tex.map.wrapS !== 'repeat' || tex.map.wrapT !== 'clamp') fail(name + ': wrap modes');
  if (V.planetTextures(name) !== tex) fail(name + ': planetTextures() result is not cached');
});
console.log('planetTextures(): map + bumpMap CanvasTextures, SRGB map, 512x256, cached: ' + (failures.length ? 'see failures' : 'ok'));

/* ---- optional contact sheets --------------------------------------------------------- */
if (pngDir) {
  var crcTable = (function () {
    var t = new Uint32Array(256), n, k, c;
    for (n = 0; n < 256; n++) { c = n; for (k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  var crc32 = function (buf) {
    var crc = 0xffffffff, i;
    for (i = 0; i < buf.length; i++) crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  };
  var chunk = function (type, data) {
    var len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    var td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    var crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td), 0);
    return Buffer.concat([len, td, crc]);
  };
  var writePng = function (file, rgba, w, h) {
    var raw = Buffer.alloc((w * 3 + 1) * h), o = 0, x, y, i;
    for (y = 0; y < h; y++) {
      raw[o++] = 0;
      for (x = 0; x < w; x++) { i = (y * w + x) * 4; raw[o++] = rgba[i]; raw[o++] = rgba[i + 1]; raw[o++] = rgba[i + 2]; }
    }
    var ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
    fs.writeFileSync(file, Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))
    ]));
  };
  var sheet = function (file, key) {
    var cols = 4, rows = Math.ceil(names.length / cols), cw = W >> 1, ch = H >> 1;
    var sw = cols * cw, sh = rows * ch, rgba = new Uint8ClampedArray(sw * sh * 4);
    names.forEach(function (name, k) {
      var src = results[name][key], ox = (k % cols) * cw, oy = Math.floor(k / cols) * ch, x, y, c;
      for (y = 0; y < ch; y++) for (x = 0; x < cw; x++) {
        var d = ((oy + y) * sw + ox + x) * 4, s = ((2 * y) * W + 2 * x) * 4;
        for (c = 0; c < 3; c++) rgba[d + c] = (src[s + c] + src[s + 4 + c] + src[s + W * 4 + c] + src[s + W * 4 + 4 + c]) >> 2;
        rgba[d + 3] = 255;
      }
    });
    writePng(file, rgba, sw, sh);
  };
  fs.mkdirSync(pngDir, { recursive: true });
  sheet(path.join(pngDir, 'moons_map.png'), 'map');
  sheet(path.join(pngDir, 'moons_bump.png'), 'bumpMap');
  console.log('wrote contact sheets to ' + pngDir + ' (4 columns, Moons.NAMES order, half size)');
}

console.log(failures.length ? failures.length + ' failure(s)' : 'all checks passed');
process.exit(failures.length ? 1 : 0);
