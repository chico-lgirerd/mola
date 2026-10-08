'use strict';
// MolaCore: DOM-free port of the math in mola's src/*.c (bars.c, render.c,
// bezier.c, main.c). Loaded as a content script, via <script>, or require().
(function () {
  var f = Math.fround;

  var MIN_FREQ = 40;              // main.c MIN_FREQ
  var MAX_FREQ_CAP = 16000;       // main.c MAX_FREQ_CAP
  var MOLA_FFT_SIZE = 16384;      // main.c FFT_SIZE
  var HANN_COHERENT_GAIN = 0.5;
  var BLACKMAN_COHERENT_GAIN = 0.42;
  var BG_COLOR = [8, 8, 14];      // render.c background
  var ATTACK = 0.7, RELEASE = 0.1; // main.c bars_update args

  // render.c GRADIENTS (same order)
  var GRADIENTS = [
    { name: 'dusk',    lo: [70, 60, 140],  hi: [255, 170, 80] },
    { name: 'ocean',   lo: [20, 40, 90],   hi: [80, 220, 220] },
    { name: 'ember',   lo: [90, 20, 20],   hi: [255, 200, 60] },
    { name: 'mono',    lo: [55, 55, 60],   hi: [235, 235, 240] },
    { name: 'synth',   lo: [80, 20, 120],  hi: [255, 90, 180] },
    { name: 'citrus',  lo: [220, 110, 20], hi: [80, 200, 90] },
    { name: 'lagoon',  lo: [30, 170, 170], hi: [150, 60, 200] },
    { name: 'solaris', lo: [180, 30, 40],  hi: [40, 210, 220] },
    { name: 'tropic',  lo: [220, 30, 140], hi: [170, 220, 40] }
  ];
  var MODES = ['bars', 'wave', 'bezier'];
  var MOUNTS = ['above-bar', 'bottom', 'top'];
  var DEFAULTS = { enabled: true, mode: 'bars', gradient: 'dusk', bars: 100, sensitivity: 0.05, mount: 'above-bar' };
  var SETTINGS_KEY = 'molaSettings';
  var MSG_TYPE = 'zz-viz', MSG_VERSION = 1, WAVE_POINTS = 1024;

  // main.c SPACE cycle
  function nextMode(mode) {
    var i = MODES.indexOf(mode);
    return MODES[(i + 1) % MODES.length]; // unknown -> index -1 -> 'bars'
  }

  // main.c parse_gradient: case-insensitive name or integer index; -1 if bad
  function gradientIndex(arg) {
    if (typeof arg === 'number') {
      return Number.isInteger(arg) && arg >= 0 && arg < GRADIENTS.length ? arg : -1;
    }
    if (typeof arg !== 'string') return -1;
    var low = arg.toLowerCase();
    for (var i = 0; i < GRADIENTS.length; i++) if (GRADIENTS[i].name === low) return i;
    if (/^\s*\+?\d+\s*$/.test(arg)) {
      var n = parseInt(arg, 10);
      if (n >= 0 && n < GRADIENTS.length) return n;
    }
    return -1;
  }

  // main.c: max_freq = (CAP < nyquist) ? CAP : nyquist * 0.95
  function maxFreqFor(sampleRate) {
    var nyquist = f(sampleRate / 2);
    return MAX_FREQ_CAP < nyquist ? MAX_FREQ_CAP : f(nyquist * 0.95);
  }

  // bars.c bars_init
  function buildBarRanges(numBars, fftSize, sampleRate, minFreq, maxFreq) {
    var lo = new Int32Array(numBars), hi = new Int32Array(numBars);
    var binHz = f(f(sampleRate) / f(fftSize));
    var maxBin = Math.trunc(fftSize / 2);
    var logMin = f(Math.log(minFreq)), logMax = f(Math.log(maxFreq));
    var nextFree = 1;
    for (var i = 0; i < numBars; i++) {
      var fLo = f(Math.exp(f(logMin + f(f(f(logMax - logMin) * i) / numBars))));
      var fHi = f(Math.exp(f(logMin + f(f(f(logMax - logMin) * (i + 1)) / numBars))));
      var binLo = Math.trunc(f(f(fLo / binHz) + 0.5)); // x >= 0
      var binHi = Math.trunc(f(f(fHi / binHz) + 0.5));
      if (binLo < nextFree) binLo = nextFree;
      if (binHi <= binLo) binHi = binLo + 1;
      if (binHi > maxBin) binHi = maxBin;
      if (binLo >= maxBin) binLo = maxBin - 1;
      if (binHi <= binLo) binHi = binLo + 1;
      lo[i] = binLo; hi[i] = binHi;
      nextFree = binHi;
    }
    return { count: numBars, lo: lo, hi: hi };
  }

  // bars.c bars_update (in place on `smoothed`)
  function updateBars(ranges, smoothed, magnitudes, sensitivity, attack, release) {
    if (attack === undefined) attack = ATTACK;
    if (release === undefined) release = RELEASE;
    var n = magnitudes.length;
    for (var i = 0; i < ranges.count; i++) {
      var peak = 0;
      for (var b = ranges.lo[i]; b < ranges.hi[i]; b++) {
        var m = b < n ? magnitudes[b] : 0;
        if (m > peak) peak = m;
      }
      var value = Math.sqrt(peak) * sensitivity;
      if (value > 1) value = 1;
      if (value < 0) value = 0;
      var prev = smoothed[i];
      var rate = value > prev ? attack : release;
      smoothed[i] = prev + (value - prev) * rate;
    }
    return smoothed;
  }

  // AnalyserNode dBFS (Blackman, 1/N) -> mola linear magnitude units (Hann, N=16384)
  function dbToMolaMagnitudes(db, out) {
    var n = db.length;
    if (!out || out.length !== n) out = new Float32Array(n);
    var scale = MOLA_FFT_SIZE * (HANN_COHERENT_GAIN / BLACKMAN_COHERENT_GAIN);
    for (var i = 0; i < n; i++) {
      var d = db[i];
      out[i] = Number.isFinite(d) ? Math.pow(10, d / 20) * scale : 0;
    }
    return out;
  }

  // render.c lerp_color; (Uint8) cast truncates
  function lerpColor(grad, t) {
    if (!(t > 0)) t = 0; // also NaN
    if (t > 1) t = 1;
    var out = [0, 0, 0];
    for (var k = 0; k < 3; k++) out[k] = Math.trunc(grad.lo[k] + (grad.hi[k] - grad.lo[k]) * t) & 255;
    return out;
  }

  // render.c render_draw_bars
  function barRects(values, w, h) {
    var count = values.length, rects = [];
    if (count <= 0) return rects;
    var gap = 2;
    var barW = (w - gap * (count + 1)) / count;
    if (barW < 1) barW = 1;
    for (var i = 0; i < count; i++) {
      var v = values[i];
      if (!(v > 0)) v = 0;
      if (v > 1) v = 1;
      var barH = v * h * 0.95;
      var x = gap + i * (barW + gap);
      var y = h - barH;
      rects.push({ x: Math.trunc(x), y: Math.trunc(y), w: Math.trunc(barW), h: Math.trunc(barH) + 1, v: v });
    }
    return rects;
  }

  // render.c render_draw_waveform -> [x0,y0,x1,y1,...]
  function waveformPoints(samples, w, h) {
    var count = samples.length;
    if (count < 2) return new Float32Array(0);
    var out = new Float32Array(count * 2);
    var mid = Math.trunc(h / 2);
    for (var i = 0; i < count; i++) {
      out[2 * i] = Math.trunc(w * i / (count - 1));
      out[2 * i + 1] = Math.trunc(mid - samples[i] * mid * 0.9);
    }
    return out;
  }

  // bezier.c catmull_to_bezier
  function catmullToBezier(p0x, p0y, p1x, p1y, p2x, p2y, p3x, p3y) {
    return [p1x + (p2x - p0x) / 6, p1y + (p2y - p0y) / 6,
            p2x + (p3x - p1x) / 6, p2y + (p3y - p1y) / 6];
  }

  // bezier.c bezier_eval
  function bezierEval(p0x, p0y, c1x, c1y, c2x, c2y, p1x, p1y, t) {
    var u = 1 - t, uu = u * u, tt = t * t, uuu = uu * u, ttt = tt * t;
    return [uuu * p0x + 3 * uu * t * c1x + 3 * u * tt * c2x + ttt * p1x,
            uuu * p0y + 3 * uu * t * c1y + 3 * u * tt * c2y + ttt * p1y];
  }

  // render.c render_draw_bezier (geometry only): y per pixel column
  function bezierCurve(values, w, h) {
    var count = values.length;
    w = Math.trunc(w); h = Math.trunc(h);
    if (count < 2 || !(w > 0)) return new Float32Array(0);
    var cx = new Float32Array(count), cy = new Float32Array(count);
    var i, v;
    for (i = 0; i < count; i++) {
      v = values[i];
      if (!(v > 0)) v = 0;
      if (v > 1) v = 1;
      cx[i] = i * (w - 1) / (count - 1);
      cy[i] = h - v * h * 0.9;
    }
    var kernel = [0.05, 0.1, 0.2, 0.3, 0.2, 0.1, 0.05];
    var sy = new Float32Array(count);
    for (i = 0; i < count; i++) {
      var sum = 0;
      for (var k = -3; k <= 3; k++) {
        var idx = i + k;
        if (idx < 0) idx = 0;
        if (idx >= count) idx = count - 1;
        sum += cy[idx] * kernel[k + 3];
      }
      sy[i] = sum;
    }
    cy = sy;

    var maxPts = 2 + (count - 1) * 80;
    var px = new Float32Array(maxPts), py = new Float32Array(maxPts);
    var npts = 1;
    px[0] = cx[0]; py[0] = cy[0];
    for (i = 0; i < count - 1; i++) {
      var p0x = i === 0 ? cx[0] : cx[i - 1], p0y = i === 0 ? cy[0] : cy[i - 1];
      var p1x = cx[i], p1y = cy[i], p2x = cx[i + 1], p2y = cy[i + 1];
      var p3x = i + 2 < count ? cx[i + 2] : cx[count - 1];
      var p3y = i + 2 < count ? cy[i + 2] : cy[count - 1];
      var c = catmullToBezier(p0x, p0y, p1x, p1y, p2x, p2y, p3x, p3y);
      var steps = Math.trunc(Math.trunc(p2x - p1x) / 3);
      if (steps < 8) steps = 8;
      if (steps > 80) steps = 80;
      for (var s = 1; s <= steps && npts < maxPts; s++) {
        var p = bezierEval(p1x, p1y, c[0], c[1], c[2], c[3], p2x, p2y, s / steps);
        px[npts] = p[0]; py[npts] = p[1]; npts++;
      }
    }
    var curve = new Float32Array(w);
    var j = 0;
    for (var x = 0; x < w; x++) {
      while (j + 1 < npts - 1 && px[j + 1] < x) j++;
      var x0 = px[j], y0 = py[j], x1 = px[j + 1], y1 = py[j + 1];
      if (x <= x0) curve[x] = y0;
      else if (x >= x1) curve[x] = y1;
      else curve[x] = y0 + (y1 - y0) * (x - x0) / (x1 - x0);
    }
    return curve;
  }

  // render.c: v = (h - y) / (h * 0.9)
  function bezierLevel(y, h) { return (h - y) / (h * 0.9); }

  function pick(val, list, def) {
    return typeof val === 'string' && list.indexOf(val) >= 0 ? val : def;
  }

  // Storage schema shared by popup and renderer; always returns a fresh valid object.
  function sanitizeSettings(obj) {
    var o = obj && typeof obj === 'object' ? obj : {};
    var out = {
      enabled: typeof o.enabled === 'boolean' ? o.enabled : DEFAULTS.enabled,
      mode: pick(o.mode, MODES, DEFAULTS.mode),
      gradient: DEFAULTS.gradient,
      bars: DEFAULTS.bars,
      sensitivity: DEFAULTS.sensitivity,
      mount: pick(o.mount, MOUNTS, DEFAULTS.mount)
    };
    var g = gradientIndex(o.gradient);
    if (g >= 0) out.gradient = GRADIENTS[g].name;
    if (typeof o.bars === 'number' && Number.isFinite(o.bars)) {
      out.bars = Math.min(256, Math.max(8, Math.round(o.bars)));
    }
    // main.c: sensitivity <= 0 -> 0.05
    if (typeof o.sensitivity === 'number' && Number.isFinite(o.sensitivity) && o.sensitivity > 0) {
      out.sensitivity = Math.min(1, Math.max(0.005, o.sensitivity));
    }
    return out;
  }

  // stride pick: out[i] = src[floor(i * len / n)]
  function decimate(src, n, out) {
    if (!out || out.length !== n) out = new Float32Array(n);
    var len = src.length;
    for (var i = 0; i < n; i++) out[i] = len ? src[Math.floor(i * len / n)] : 0;
    return out;
  }

  function isF32(x) {
    return x instanceof Float32Array || Object.prototype.toString.call(x) === '[object Float32Array]';
  }

  // Structural check only; origin/source checks are done by the receiver.
  function isValidFrame(d) {
    if (!d || typeof d !== 'object' || Array.isArray(d)) return false;
    if (d.type !== MSG_TYPE || d.v !== MSG_VERSION) return false;
    if (d.kind === 'state') return typeof d.playing === 'boolean';
    if (d.kind !== 'frame' || d.playing !== true) return false;
    var sr = d.sampleRate, n = d.fftSize;
    if (typeof sr !== 'number' || !Number.isFinite(sr) || sr < 8000 || sr > 384000) return false;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 32 || n > 32768 || (n & (n - 1)) !== 0) return false;
    if (!isF32(d.spectrum) || d.spectrum.length !== n / 2 || d.spectrum.length > 16384) return false;
    if (!isF32(d.wave) || d.wave.length < 1 || d.wave.length > 4096) return false;
    return true;
  }

  var MolaCore = {
    MIN_FREQ: MIN_FREQ, MAX_FREQ_CAP: MAX_FREQ_CAP, MOLA_FFT_SIZE: MOLA_FFT_SIZE,
    HANN_COHERENT_GAIN: HANN_COHERENT_GAIN, BLACKMAN_COHERENT_GAIN: BLACKMAN_COHERENT_GAIN,
    BG_COLOR: BG_COLOR, GRADIENTS: GRADIENTS, MODES: MODES, MOUNTS: MOUNTS, DEFAULTS: DEFAULTS,
    ATTACK: ATTACK, RELEASE: RELEASE, SETTINGS_KEY: SETTINGS_KEY,
    MSG_TYPE: MSG_TYPE, MSG_VERSION: MSG_VERSION, WAVE_POINTS: WAVE_POINTS,
    nextMode: nextMode, gradientIndex: gradientIndex, maxFreqFor: maxFreqFor,
    buildBarRanges: buildBarRanges, updateBars: updateBars, dbToMolaMagnitudes: dbToMolaMagnitudes,
    lerpColor: lerpColor, barRects: barRects, waveformPoints: waveformPoints,
    catmullToBezier: catmullToBezier, bezierEval: bezierEval, bezierCurve: bezierCurve,
    bezierLevel: bezierLevel, sanitizeSettings: sanitizeSettings, decimate: decimate,
    isValidFrame: isValidFrame
  };

  globalThis.MolaCore = MolaCore;
  if (typeof module !== 'undefined' && module.exports) module.exports = MolaCore;
})();
