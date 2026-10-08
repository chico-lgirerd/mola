'use strict';
// End-to-end check of the spectrum path: a synthetic tone run through an
// AnalyserNode-equivalent transform (Blackman window, 1/N scaling, dBFS, as in
// the Web Audio spec) must give the same bar height mola's C pipeline
// (Hann window, FFT 16384, linear magnitude, bars_update) would give.
const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../lib/mola-core.js');

const SR = 48000;
const N = 8192;

// AnalyserNode.getFloatFrequencyData equivalent (smoothingTimeConstant 0).
function analyserDb(x) {
  const n = x.length;
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    w[i] = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / n) + 0.08 * Math.cos((4 * Math.PI * i) / n);
  }
  const out = new Float32Array(n / 2);
  for (let k = 0; k < n / 2; k++) {
    let re = 0;
    let im = 0;
    for (let i = 0; i < n; i++) {
      const a = (-2 * Math.PI * k * i) / n;
      const v = x[i] * w[i];
      re += v * Math.cos(a);
      im += v * Math.sin(a);
    }
    out[k] = 20 * Math.log10(Math.hypot(re, im) / n);
  }
  return out;
}

function tone(freq, amp, n) {
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
  return x;
}

test('bin-centred tone gives mola-equivalent bar height', () => {
  const bin = 171; // 171 * 48000 / 8192 = 1001.95 Hz
  const amp = 0.01;
  const db = analyserDb(tone((bin * SR) / N, amp, N));
  const mags = Core.dbToMolaMagnitudes(db);

  // mola: Hann-windowed 16384-point FFT of the same tone peaks at amp*N*0.5/2.
  const molaPeak = (amp * Core.MOLA_FFT_SIZE * 0.5) / 2;
  assert.ok(Math.abs(mags[bin] - molaPeak) / molaPeak < 0.01, `peak ${mags[bin]} vs ${molaPeak}`);

  const ranges = Core.buildBarRanges(100, N, SR, Core.MIN_FREQ, Core.maxFreqFor(SR));
  const smoothed = new Float32Array(100);
  Core.updateBars(ranges, smoothed, mags, 0.05, Core.ATTACK, Core.RELEASE);

  let target = -1;
  for (let i = 0; i < ranges.count; i++) if (ranges.lo[i] <= bin && bin < ranges.hi[i]) target = i;
  assert.ok(target >= 0);
  let maxI = 0;
  for (let i = 1; i < 100; i++) if (smoothed[i] > smoothed[maxI]) maxI = i;
  assert.equal(maxI, target, 'loudest bar is the one holding the tone bin');

  const expected = Core.ATTACK * Math.min(1, Math.sqrt(molaPeak) * 0.05); // 0.7 * 0.32
  assert.ok(Math.abs(smoothed[target] - expected) < 0.005, `${smoothed[target]} vs ${expected}`);
});

test('silence (-Infinity dB) leaves bars at rest', () => {
  const db = new Float32Array(N / 2).fill(-Infinity);
  const mags = Core.dbToMolaMagnitudes(db);
  const ranges = Core.buildBarRanges(64, N, SR, Core.MIN_FREQ, Core.maxFreqFor(SR));
  const smoothed = new Float32Array(64).fill(0.5);
  Core.updateBars(ranges, smoothed, mags, 0.05);
  for (const v of smoothed) assert.ok(Math.abs(v - 0.45) < 1e-6); // release 0.1
});

test('8192-point analyser keeps log spacing in the upper bars (PLAN deviation 1)', () => {
  const r = Core.buildBarRanges(100, N, SR, Core.MIN_FREQ, Core.maxFreqFor(SR));
  // Every bar maps to at least one bin and ranges are contiguous.
  for (let i = 0; i < 100; i++) {
    assert.ok(r.hi[i] > r.lo[i]);
    if (i) assert.equal(r.lo[i], r.hi[i - 1]);
  }
  // Last bar ends at 16 kHz bin, as in mola.
  assert.equal(r.hi[99], Math.trunc(16000 / (SR / N) + 0.5));
});
