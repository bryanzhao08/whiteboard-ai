import test from 'node:test';
import assert from 'node:assert/strict';
import { AdaptivePointFilter, OffhandGesture, PinchGate, classifyHandPose, pinchRatio, pickDrawingHandIndex, isIPhoneCamera, pickCameraDevice, findCameraWithPermission, cameraVideoConstraints, waitForVideoFrame, requestWideZoom, classifyPencilPixel, findPencilMarker, mapCameraPoint } from '../tracking.mjs';

function makeHand(pose = 'palm', offsetX = 0) {
  const hand = Array.from({ length: 21 }, () => ({ x: .5 + offsetX, y: .7 }));
  hand[0] = { x: .5 + offsetX, y: .88 };
  hand[4] = { x: .2 + offsetX, y: .48 };
  [5,9,13,17].forEach((mcp, finger) => {
    const x = .32 + finger * .12 + offsetX;
    const extended = pose === 'palm' || (pose === 'point' && finger === 0);
    hand[mcp] = { x, y: .55 };
    hand[mcp + 1] = { x, y: .42 };
    hand[mcp + 2] = { x, y: extended ? .32 : .53 };
    hand[mcp + 3] = { x, y: extended ? .22 : .61 };
  });
  return hand;
}

test('drawing starts only at a close fingertip touch and stops on the first released frame', () => {
  const gate = new PinchGate();
  const hand = makeHand();
  assert.equal(gate.update(pinchRatio(hand)), false);
  hand[4] = { x: hand[8].x + .06, y: hand[8].y };
  assert.equal(gate.update(pinchRatio(hand)), true);
  hand[4] = { x: hand[8].x + .13, y: hand[8].y };
  assert.equal(gate.update(pinchRatio(hand)), false);
  assert.equal(gate.update(.25), false);
  assert.equal(gate.update(.34), false);
  assert.equal(gate.update(.2), true);
  assert.equal(gate.update(NaN), false);
});

test('point, fist, and open palm remain distinct in either camera orientation', () => {
  for (const pose of ['point', 'fist', 'palm']) {
    const hand = makeHand(pose);
    assert.equal(classifyHandPose(hand), pose);
    const rotated = hand.map(({ x, y }) => ({ x: 1 - y, y: x }));
    assert.equal(classifyHandPose(rotated), pose);
  }
  const imperfectFist = makeHand('fist');
  imperfectFist[19] = { x: imperfectFist[18].x, y: .32 };
  imperfectFist[20] = { x: imperfectFist[18].x, y: .22 };
  assert.equal(classifyHandPose(imperfectFist), 'fist');
  const imperfectPalm = makeHand('palm');
  imperfectPalm[19] = { x: imperfectPalm[18].x, y: .53 };
  imperfectPalm[20] = { x: imperfectPalm[18].x, y: .61 };
  assert.equal(classifyHandPose(imperfectPalm), 'palm');
});

test('offhand pointer changes color once and held fist undoes once', () => {
  const gesture = new OffhandGesture();
  const point = makeHand('point');
  const fist = makeHand('fist');
  assert.equal(gesture.update(point, 100).action, null);
  const unclear = makeHand('point');
  unclear[8] = { x: unclear[8].x + .16, y: unclear[8].y + .16 };
  assert.equal(gesture.update(unclear, 175).action, null);
  assert.equal(gesture.update(point, 749).action, null);
  assert.equal(gesture.update(point, 750).action, 'color');
  assert.equal(gesture.update(point, 1400).action, null);
  assert.equal(gesture.update(fist, 1500).action, null);
  assert.equal(gesture.update(fist, 1850).action, 'undo');
  assert.equal(gesture.update(fist, 2500).action, null);
  assert.equal(gesture.update(makeHand('palm'), 2600).pause, true);
});

test('a pinched hand remains the drawing hand when the other hand points', () => {
  const pointer = makeHand('point', -.18);
  const drawing = makeHand('palm', .18);
  drawing[4] = { ...drawing[8] };
  assert.equal(pickDrawingHandIndex([pointer, drawing], pointer[0]), 1);
  assert.equal(pickDrawingHandIndex([drawing, pointer], pointer[0]), 0);
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
  assert.equal(pickCameraDevice([{ kind: 'videoinput', deviceId: 'rear', label: 'Back Camera' }], 'iphone', '', true)?.deviceId, 'rear');
  assert.equal(pickCameraDevice([
    { kind: 'videoinput', deviceId: 'rear', label: 'Back Camera' },
    { kind: 'videoinput', deviceId: 'wide', label: 'Back Ultra Wide Camera' },
  ], 'iphone', '', true)?.deviceId, 'wide');
  assert.equal(cameraVideoConstraints(devices[0], 'iphone').deviceId.exact, 'phone');
  assert.equal(cameraVideoConstraints(null, 'iphone').facingMode, 'environment');
  assert.equal(cameraVideoConstraints(devices[0], 'iphone').zoom.ideal, .5);
});

test('0.5x uses physical camera zoom when available and reports its limit otherwise', async () => {
  let zoom = 1;
  const track = {
    getSettings: () => ({ zoom }),
    getCapabilities: () => ({ zoom: { min: .5, max: 3 } }),
    async applyConstraints({ advanced }) { zoom = advanced[0].zoom; },
  };
  assert.equal(await requestWideZoom(track), 'active');
  assert.equal(zoom, .5);
  track.getCapabilities = () => ({ zoom: { min: 1, max: 3 } });
  zoom = 1;
  assert.equal(await requestWideZoom(track), 'unavailable');
  track.getCapabilities = () => ({});
  assert.equal(await requestWideZoom(track), 'requested');
});

test('unmirrored camera coordinates move in the same direction on the board', () => {
  assert.ok(mapCameraPoint({ x: .8, y: .5 }).x > mapCameraPoint({ x: .2, y: .5 }).x);
  assert.equal(mapCameraPoint({ x: .5, y: .5 }).x, .5);
});

test('neon red tip draws and pink end erases without mistaking skin for a marker', () => {
  assert.equal(classifyPencilPixel(245, 30, 20), 'tip');
  assert.equal(classifyPencilPixel(245, 70, 170), 'eraser');
  assert.equal(classifyPencilPixel(220, 170, 145), null);
  assert.equal(classifyPencilPixel(245, 225, 30), null);
  const width = 160, height = 90;
  const pixels = new Uint8ClampedArray(width * height * 4);
  const paint = (centerY, rgb) => {
    for (let y = centerY - 4; y <= centerY + 4; y++) for (let x = 76; x <= 84; x++) {
      const i = (y * width + x) * 4;
      pixels.set([...rgb, 255], i);
    }
  };
  const hand = makeHand();
  hand[0] = { x: .5, y: .88 };
  hand[8] = { x: .5, y: .48 };
  paint(25, [245, 30, 20]);
  paint(46, [245, 70, 170]);
  assert.equal(findPencilMarker(pixels, width, height, hand)?.kind, 'tip');
  pixels.fill(0);
  paint(25, [245, 70, 170]);
  paint(46, [245, 30, 20]);
  assert.equal(findPencilMarker(pixels, width, height, hand)?.kind, 'eraser');
});

test('Continuity Camera is enumerated while the permission stream is still active', async () => {
  const events = [];
  let permissionOpen = false;
  const mediaDevices = {
    async enumerateDevices() {
      events.push('enumerate');
      return permissionOpen
        ? [{ kind: 'videoinput', deviceId: 'phone', label: "Bryan's iPhone Camera" }]
        : [{ kind: 'videoinput', deviceId: 'default', label: '' }];
    },
    async getUserMedia() {
      events.push('permission');
      permissionOpen = true;
      return { getTracks: () => [{ stop: () => { events.push('stop'); permissionOpen = false; } }] };
    },
  };
  const selected = await findCameraWithPermission(mediaDevices, 'iphone');
  assert.equal(selected.deviceId, 'phone');
  assert.deepEqual(events, ['enumerate', 'permission', 'enumerate', 'stop']);
});

test('camera startup waits for real frames and reports a stalled stream', async () => {
  const video = new EventTarget();
  video.readyState = 0;
  video.videoWidth = 0;
  video.videoHeight = 0;
  video.play = async () => {};
  const ready = waitForVideoFrame(video, 100);
  video.readyState = 2; video.videoWidth = 960; video.videoHeight = 540;
  video.dispatchEvent(new Event('loadeddata'));
  await ready;
  video.readyState = 0; video.videoWidth = 0; video.videoHeight = 0;
  await assert.rejects(waitForVideoFrame(video, 20), { name: 'NoVideoFrames' });
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
