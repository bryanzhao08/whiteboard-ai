import test from 'node:test';
import assert from 'node:assert/strict';
import { AdaptivePointFilter, PinchGate, isIPhoneCamera, pickCameraDevice } from '../tracking.mjs';

test('a held pinch stays on through short landmark flicker and turns off after release', () => {
  const gate = new PinchGate();
  assert.equal(gate.update(1.2, 0), false);
  assert.equal(gate.update(.4, 20), true);
  assert.equal(gate.update(.95, 40), true);
  assert.equal(gate.update(.6, 120), true);
  assert.equal(gate.update(.4, 150), true);
  assert.equal(gate.update(1.1, 200), true);
  assert.equal(gate.update(1.1, 350), true);
  assert.equal(gate.update(1.1, 390), false);
});

test('camera selection keeps computer and iPhone sources separate', () => {
  const devices = [
    { kind: 'videoinput', deviceId: 'phone', label: "Bryan's iPhone Camera" },
    { kind: 'videoinput', deviceId: 'mac', label: 'FaceTime HD Camera (Built-in)' },
  ];
  assert.equal(isIPhoneCamera(devices[0]), true);
  assert.equal(pickCameraDevice(devices, 'computer')?.deviceId, 'mac');
  assert.equal(pickCameraDevice(devices, 'iphone')?.deviceId, 'phone');
  assert.equal(pickCameraDevice(devices, 'iphone', 'mac'), null);
  assert.equal(pickCameraDevice(devices.slice(1), 'iphone'), null);
});

test('hand smoothing damps small jitter without holding back deliberate movement', () => {
  const filter = new AdaptivePointFilter();
  let rawError = 0, filteredError = 0;
  for (let i = 0; i < 60; i++) {
    const x = .5 + (i % 2 ? .012 : -.012);
    rawError += Math.abs(x - .5);
    filteredError += Math.abs(filter.update({ x, y: .5 }, i * 33, { x: .3, y: .7 }).x - .5);
  }
  assert.ok(filteredError < rawError * .35);
  filter.reset();
  let output;
  for (let i = 0; i <= 10; i++) output = filter.update({ x: .2 + i * .025, y: .2 }, i * 33, { x: .1 + i * .025, y: .4 });
  assert.ok(output.x > .41, `cursor lagged too far behind: ${output.x}`);
});

test('one-frame tracking spike does not draw a bounce, and a new stable position breaks the stroke', () => {
  const filter = new AdaptivePointFilter();
  const wrist = { x: .3, y: .7 };
  filter.update({ x: .5, y: .5 }, 0, wrist);
  assert.equal(filter.update({ x: .8, y: .5 }, 33, wrist).x, .5);
  assert.equal(filter.update({ x: .5, y: .5 }, 66, wrist).x, .5);
  assert.equal(filter.discontinuity, false);
  filter.update({ x: .8, y: .5 }, 99, wrist);
  assert.equal(filter.update({ x: .8, y: .5 }, 132, wrist).x, .8);
  assert.equal(filter.discontinuity, true);
});
