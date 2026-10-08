'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const C = require('../lib/mola-core.js');

const frame = (o = {}) => ({
  type: 'zz-viz', v: 1, kind: 'frame', playing: true, sampleRate: 48000, fftSize: 8192,
  spectrum: new Float32Array(4096), wave: new Float32Array(1024), ...o,
});

test('constants', () => {
  assert.equal(C.MSG_TYPE, 'zz-viz');
  assert.equal(C.MSG_VERSION, 1);
  assert.equal(C.WAVE_POINTS, 1024);
});

test('accepts good frame and state', () => {
  assert.equal(C.isValidFrame(frame()), true);
  assert.equal(C.isValidFrame({ type: 'zz-viz', v: 1, kind: 'state', playing: false }), true);
  assert.equal(C.isValidFrame({ type: 'zz-viz', v: 1, kind: 'state', playing: true }), true);
  assert.equal(C.isValidFrame(frame({ fftSize: 32768, spectrum: new Float32Array(16384) })), true);
  assert.equal(C.isValidFrame(frame({ fftSize: 32, spectrum: new Float32Array(16), wave: new Float32Array(1) })), true);
});

test('accepts typed arrays from another realm', () => {
  const foreign = vm.runInNewContext('new Float32Array(4096)');
  assert.equal(foreign instanceof Float32Array, false);
  assert.equal(C.isValidFrame(frame({ spectrum: foreign, wave: vm.runInNewContext('new Float32Array(16)') })), true);
});

test('rejects non-objects and wrong envelope', () => {
  for (const x of [null, undefined, 1, 'zz-viz', [], true]) assert.equal(C.isValidFrame(x), false);
  assert.equal(C.isValidFrame(frame({ type: 'other' })), false);
  assert.equal(C.isValidFrame(frame({ v: 2 })), false);
  assert.equal(C.isValidFrame(frame({ v: '1' })), false);
  assert.equal(C.isValidFrame(frame({ kind: 'nope' })), false);
  assert.equal(C.isValidFrame({ type: 'zz-viz', v: 1 }), false);
});

test('state requires boolean playing', () => {
  assert.equal(C.isValidFrame({ type: 'zz-viz', v: 1, kind: 'state' }), false);
  assert.equal(C.isValidFrame({ type: 'zz-viz', v: 1, kind: 'state', playing: 'no' }), false);
});

test('frame field checks', () => {
  assert.equal(C.isValidFrame(frame({ playing: false })), false);
  assert.equal(C.isValidFrame(frame({ playing: 1 })), false);
  for (const sr of [NaN, Infinity, 7999, 384001, '48000', undefined]) {
    assert.equal(C.isValidFrame(frame({ sampleRate: sr })), false, String(sr));
  }
  assert.equal(C.isValidFrame(frame({ sampleRate: 8000 })), true);
  assert.equal(C.isValidFrame(frame({ sampleRate: 384000 })), true);
  for (const n of [16, 1000, 65536, 8192.5, 0, '8192']) {
    assert.equal(C.isValidFrame(frame({ fftSize: n })), false, String(n));
  }
});

test('rejects bad or oversized arrays', () => {
  assert.equal(C.isValidFrame(frame({ spectrum: new Float32Array(2048) })), false); // length mismatch
  assert.equal(C.isValidFrame(frame({ spectrum: Array(4096).fill(0) })), false);
  assert.equal(C.isValidFrame(frame({ spectrum: new Float64Array(4096) })), false);
  assert.equal(C.isValidFrame(frame({ spectrum: undefined })), false);
  assert.equal(C.isValidFrame(frame({ wave: new Float32Array(0) })), false);
  assert.equal(C.isValidFrame(frame({ wave: new Float32Array(4097) })), false);
  assert.equal(C.isValidFrame(frame({ wave: new Float64Array(1024) })), false);
  assert.equal(C.isValidFrame(frame({ wave: undefined })), false);
  assert.equal(C.isValidFrame(frame({ wave: new Float32Array(4096) })), true);
});
