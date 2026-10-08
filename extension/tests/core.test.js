'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../lib/mola-core.js');

const near = (a, b, eps = 1e-5) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

test('constants', () => {
  assert.equal(C.MIN_FREQ, 40);
  assert.equal(C.MAX_FREQ_CAP, 16000);
  assert.equal(C.MOLA_FFT_SIZE, 16384);
  assert.deepEqual(C.BG_COLOR, [8, 8, 14]);
  assert.deepEqual(C.MODES, ['bars', 'wave', 'bezier']);
  assert.equal(C.SETTINGS_KEY, 'molaSettings');
});

test('GRADIENTS equals render.c table', () => {
  const expected = [
    ['dusk', [70, 60, 140], [255, 170, 80]],
    ['ocean', [20, 40, 90], [80, 220, 220]],
    ['ember', [90, 20, 20], [255, 200, 60]],
    ['mono', [55, 55, 60], [235, 235, 240]],
    ['synth', [80, 20, 120], [255, 90, 180]],
    ['citrus', [220, 110, 20], [80, 200, 90]],
    ['lagoon', [30, 170, 170], [150, 60, 200]],
    ['solaris', [180, 30, 40], [40, 210, 220]],
    ['tropic', [220, 30, 140], [170, 220, 40]],
  ].map(([name, lo, hi]) => ({ name, lo, hi }));
  assert.deepEqual(C.GRADIENTS, expected);
});

test('nextMode cycles', () => {
  assert.equal(C.nextMode('bars'), 'wave');
  assert.equal(C.nextMode('wave'), 'bezier');
  assert.equal(C.nextMode('bezier'), 'bars');
  assert.equal(C.nextMode('nope'), 'bars');
});

test('gradientIndex', () => {
  assert.equal(C.gradientIndex('dusk'), 0);
  assert.equal(C.gradientIndex('TrOpIc'), 8);
  assert.equal(C.gradientIndex(3), 3);
  assert.equal(C.gradientIndex('4'), 4);
  assert.equal(C.gradientIndex('9'), -1);
  assert.equal(C.gradientIndex(-1), -1);
  assert.equal(C.gradientIndex('-1'), -1);
  assert.equal(C.gradientIndex('1.5'), -1);
  assert.equal(C.gradientIndex('nope'), -1);
  assert.equal(C.gradientIndex(null), -1);
  assert.equal(C.gradientIndex(''), -1);
});

test('maxFreqFor', () => {
  assert.equal(C.maxFreqFor(48000), 16000);
  assert.equal(C.maxFreqFor(44100), 16000);
  near(C.maxFreqFor(16000), 8000 * 0.95, 1e-3);
});

test('buildBarRanges hand-computed (4 bars, fft 1024, 48 kHz, 40..16000)', () => {
  // bin_hz = 46.875, max_bin = 512. 16000/40 = 400, per-bar factor 400^(1/4) = 4.4721.
  // Edges: 40, 178.885, 800, 3577.7, 16000 Hz
  // bins = (int)(f/46.875 + 0.5): 0.85+.5->1, 3.82+.5->4, 17.07+.5->17, 76.3+.5->76, 341.3+.5->341
  // bars: [1,4) [4,17) [17,76) [76,341)
  const r = C.buildBarRanges(4, 1024, 48000, 40, 16000);
  assert.equal(r.count, 4);
  assert.deepEqual(Array.from(r.lo), [1, 4, 17, 76]);
  assert.deepEqual(Array.from(r.hi), [4, 17, 76, 341]);
});

test('buildBarRanges invariants for 100 bars', () => {
  for (const fft of [2048, 8192, 16384]) {
    const r = C.buildBarRanges(100, fft, 48000, 40, 16000);
    assert.equal(r.lo.length, 100);
    for (let i = 0; i < 100; i++) {
      assert.ok(r.lo[i] >= 1);
      assert.ok(r.hi[i] > r.lo[i]);
      assert.ok(r.hi[i] <= fft / 2);
      if (i) assert.ok(r.lo[i] >= r.hi[i - 1], `overlap at ${i}`);
    }
  }
});

test('buildBarRanges clamps at top of window', () => {
  const r = C.buildBarRanges(8, 64, 48000, 40, 16000); // only 32 bins
  for (let i = 0; i < 8; i++) {
    assert.ok(r.hi[i] <= 32);
    assert.ok(r.lo[i] < 32);
    assert.ok(r.hi[i] > r.lo[i]);
  }
});

test('updateBars attack/release', () => {
  const ranges = { count: 1, lo: Int32Array.of(1), hi: Int32Array.of(3) };
  const sm = new Float32Array(1);
  // peak 400 -> sqrt 20 * 0.05 = 1.0; prev 0 -> attack 0.7
  C.updateBars(ranges, sm, Float32Array.of(0, 100, 400, 9999), 0.05);
  near(sm[0], 0.7);
  // value 0 -> release 0.1: 0.7 + (0 - 0.7) * 0.1 = 0.63
  C.updateBars(ranges, sm, new Float32Array(4), 0.05);
  near(sm[0], 0.63);
  // custom rates: 0.63 * 0.5
  C.updateBars(ranges, sm, new Float32Array(4), 0.05, 0.5, 0.5);
  near(sm[0], 0.315);
});

test('updateBars clamps and range is [lo,hi)', () => {
  const ranges = { count: 1, lo: Int32Array.of(1), hi: Int32Array.of(2) };
  const sm = new Float32Array(1);
  C.updateBars(ranges, sm, Float32Array.of(0, 1e9, 1e9), 1, 1, 1); // value clamped to 1, attack 1
  assert.equal(sm[0], 1);
  sm[0] = 0;
  C.updateBars(ranges, sm, Float32Array.of(1e9, 0, 1e9), 1, 1, 1); // bins 0 and 2 excluded
  assert.equal(sm[0], 0);
});

test('updateBars tolerates short magnitudes array', () => {
  const ranges = { count: 1, lo: Int32Array.of(2), hi: Int32Array.of(10) };
  const sm = new Float32Array(1);
  C.updateBars(ranges, sm, Float32Array.of(0, 0, 0, 0), 0.05);
  assert.equal(sm[0], 0);
});

test('dbToMolaMagnitudes', () => {
  const out = C.dbToMolaMagnitudes(Float32Array.of(-Infinity, NaN, Infinity, 0, -20));
  assert.equal(out[0], 0);
  assert.equal(out[1], 0);
  assert.equal(out[2], 0);
  near(out[3], 16384 * 0.5 / 0.42, 1e-2);
  near(out[4], 16384 * 0.5 / 0.42 / 10, 1e-2);
});

test('dbToMolaMagnitudes reuses or reallocates out', () => {
  const db = new Float32Array(4);
  const out = new Float32Array(4);
  assert.equal(C.dbToMolaMagnitudes(db, out), out);
  assert.equal(C.dbToMolaMagnitudes(db, new Float32Array(2)).length, 4);
  assert.equal(C.dbToMolaMagnitudes(db).length, 4);
});

test('lerpColor', () => {
  const g = C.GRADIENTS[0]; // dusk
  assert.deepEqual(C.lerpColor(g, 0), [70, 60, 140]);
  assert.deepEqual(C.lerpColor(g, 1), [255, 170, 80]);
  assert.deepEqual(C.lerpColor(g, -5), [70, 60, 140]);
  assert.deepEqual(C.lerpColor(g, 5), [255, 170, 80]);
  assert.deepEqual(C.lerpColor(g, NaN), [70, 60, 140]);
  // t=0.5: 70+92.5=162.5->162, 60+55=115, 140-30=110
  assert.deepEqual(C.lerpColor(g, 0.5), [162, 115, 110]);
  // t=0.25: 70+46.25->116, 60+27.5->87, 140-15=125
  assert.deepEqual(C.lerpColor(g, 0.25), [116, 87, 125]);
});

test('barRects geometry', () => {
  // w=100, h=100, count=2: bar_w = (100 - 2*3)/2 = 47
  const r = C.barRects([1, 0.5], 100, 100);
  assert.equal(r.length, 2);
  // v=1: bar_h=95, x=2, y=5 -> {2,5,47,96}
  assert.deepEqual(r[0], { x: 2, y: 5, w: 47, h: 96, v: 1 });
  // v=.5: bar_h=47.5, x=2+49=51, y=52.5->52, h=47+1
  assert.deepEqual(r[1], { x: 51, y: 52, w: 47, h: 48, v: 0.5 });
});

test('barRects clamps values and min width', () => {
  const r = C.barRects([-1, 7], 4, 10);
  assert.equal(r[0].v, 0);
  assert.equal(r[1].v, 1);
  assert.equal(r[0].w, 1);
  assert.equal(r[0].h, 1);
  assert.deepEqual(C.barRects([], 10, 10), []);
});

test('waveformPoints', () => {
  const p = C.waveformPoints(Float32Array.of(0, 1, -1), 100, 100);
  // mid 50; x = 0,50,100; y = 50, 50-45=5, 50+45=95
  assert.deepEqual(Array.from(p), [0, 50, 50, 5, 100, 95]);
  assert.equal(C.waveformPoints(Float32Array.of(1), 100, 100).length, 0);
  assert.equal(C.waveformPoints([], 100, 100).length, 0);
  assert.equal(C.waveformPoints(Float32Array.of(0, 0), 10, 101)[1], 50); // mid = trunc(101/2)
});

test('catmullToBezier / bezierEval endpoints', () => {
  const c = C.catmullToBezier(0, 0, 10, 0, 20, 6, 30, 6);
  assert.deepEqual(c, [10 + 20 / 6, 1, 20 + 20 / 6, 7]);
  assert.deepEqual(C.bezierEval(10, 0, c[0], c[1], c[2], c[3], 20, 6, 0), [10, 0]);
  const e = C.bezierEval(10, 0, c[0], c[1], c[2], c[3], 20, 6, 1);
  near(e[0], 20); near(e[1], 6);
  const m = C.bezierEval(0, 0, 0, 0, 10, 10, 10, 10, 0.5);
  near(m[0], 5); near(m[1], 5);
});

test('bezierCurve flat input is flat, length w', () => {
  for (const [v, w, h] of [[0.5, 200, 100], [0, 64, 50], [1, 333, 72]]) {
    const curve = C.bezierCurve(new Float32Array(20).fill(v), w, h);
    assert.equal(curve.length, w);
    const y = h - v * h * 0.9;
    for (const c of curve) near(c, y, 1e-3);
    near(C.bezierLevel(curve[w >> 1], h), v, 1e-4);
  }
});

test('bezierCurve degenerate and varied input', () => {
  assert.equal(C.bezierCurve([0.5], 100, 50).length, 0);
  assert.equal(C.bezierCurve([0.5, 0.5], 0, 50).length, 0);
  const curve = C.bezierCurve(Float32Array.of(0, 1, 0, 1, 0), 120, 100);
  assert.equal(curve.length, 120);
  assert.ok(curve.every(Number.isFinite));
  const a = C.bezierCurve([-3, 9], 50, 40), b = C.bezierCurve([0, 1], 50, 40);
  assert.deepEqual(Array.from(a), Array.from(b)); // inputs clamped
});

test('bezierLevel', () => {
  near(C.bezierLevel(100, 100), 0);
  near(C.bezierLevel(10, 100), 1);
});

test('sanitizeSettings', () => {
  assert.deepEqual(C.sanitizeSettings(undefined), C.DEFAULTS);
  assert.deepEqual(C.sanitizeSettings(null), C.DEFAULTS);
  assert.deepEqual(C.sanitizeSettings('x'), C.DEFAULTS);
  assert.deepEqual(C.sanitizeSettings({}), C.DEFAULTS);
  const s = C.sanitizeSettings({ enabled: false, mode: 'wave', gradient: 'OCEAN', bars: 64.4, sensitivity: 0.2, mount: 'top', junk: 1 });
  assert.deepEqual(s, { enabled: false, mode: 'wave', gradient: 'ocean', bars: 64, sensitivity: 0.2, mount: 'top' });
  assert.equal(C.sanitizeSettings({ bars: 1 }).bars, 8);
  assert.equal(C.sanitizeSettings({ bars: 9999 }).bars, 256);
  assert.equal(C.sanitizeSettings({ bars: NaN }).bars, 100);
  assert.equal(C.sanitizeSettings({ bars: '50' }).bars, 100);
  assert.equal(C.sanitizeSettings({ sensitivity: 0 }).sensitivity, 0.05);
  assert.equal(C.sanitizeSettings({ sensitivity: -2 }).sensitivity, 0.05);
  assert.equal(C.sanitizeSettings({ sensitivity: '0.3' }).sensitivity, 0.05);
  assert.equal(C.sanitizeSettings({ sensitivity: Infinity }).sensitivity, 0.05);
  assert.equal(C.sanitizeSettings({ sensitivity: 0.0001 }).sensitivity, 0.005);
  assert.equal(C.sanitizeSettings({ sensitivity: 50 }).sensitivity, 1);
  assert.equal(C.sanitizeSettings({ gradient: 2 }).gradient, 'ember');
  assert.equal(C.sanitizeSettings({ gradient: 'zzz' }).gradient, 'dusk');
  assert.equal(C.sanitizeSettings({ mode: 'x' }).mode, 'bars');
  assert.equal(C.sanitizeSettings({ mount: 'y' }).mount, 'above-bar');
  assert.equal(C.sanitizeSettings({ enabled: 'no' }).enabled, true);
  const d = C.sanitizeSettings({});
  d.bars = 1;
  assert.equal(C.DEFAULTS.bars, 100); // fresh object, DEFAULTS untouched
});

test('decimate', () => {
  const src = Float32Array.from({ length: 8 }, (_, i) => i);
  assert.deepEqual(Array.from(C.decimate(src, 4)), [0, 2, 4, 6]);
  const out = new Float32Array(2);
  assert.equal(C.decimate(src, 2, out), out);
  assert.deepEqual(Array.from(out), [0, 4]);
  assert.equal(C.decimate(src, 3).length, 3);
});
