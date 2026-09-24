import test from 'node:test';
import assert from 'node:assert/strict';
import { PinchGate, isIPhoneCamera, pickCameraDevice } from '../tracking.mjs';

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
