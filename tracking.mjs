export const PINCH_TOUCH_THRESHOLD = 0.24;

export class PinchGate {
  constructor({ threshold = PINCH_TOUCH_THRESHOLD } = {}) {
    this.threshold = threshold;
    this.active = false;
  }

  update(ratio) {
    this.active = Number.isFinite(ratio) && ratio <= this.threshold;
    return this.active;
  }

  reset() {
    this.active = false;
  }
}

const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

export function pinchRatio(hand) {
  const palmSize = Math.max(distance(hand[5], hand[17]), distance(hand[0], hand[9]), .001);
  return distance(hand[4], hand[8]) / palmSize;
}

function fingerExtended(hand, mcp, pip, dip, tip) {
  const a = { x: hand[mcp].x - hand[pip].x, y: hand[mcp].y - hand[pip].y };
  const b = { x: hand[dip].x - hand[pip].x, y: hand[dip].y - hand[pip].y };
  const cosine = (a.x * b.x + a.y * b.y) / Math.max(Math.hypot(a.x, a.y) * Math.hypot(b.x, b.y), 1e-6);
  const reach = distance(hand[tip], hand[mcp]) / Math.max(distance(hand[pip], hand[mcp]), 1e-6);
  return reach > 1.4 && (cosine < -.5 || reach > 1.9);
}

export function classifyHandPose(hand) {
  if (!hand) return 'none';
  const extended = [[5,6,7,8],[9,10,11,12],[13,14,15,16],[17,18,19,20]]
    .map(indices => fingerExtended(hand, ...indices));
  const count = extended.filter(Boolean).length;
  if (count >= 3) return 'palm';
  if (extended[0] && extended[1] && count === 2) return 'victory';
  if (extended[0] && count === 1) return 'point';
  if (!extended[0] && count <= 1) return 'fist';
  return 'other';
}

export function recognizedHandPose(hand, categories = []) {
  const category = categories[0];
  const poses = { Closed_Fist: 'fist', Pointing_Up: 'point', Open_Palm: 'palm', Victory: 'victory' };
  if (category?.score >= .55 && poses[category.categoryName]) return poses[category.categoryName];
  return classifyHandPose(hand);
}

export class OffhandGesture {
  constructor({ pointHoldMs = 450, fistHoldMs = 300 } = {}) {
    this.pointHoldMs = pointHoldMs;
    this.fistHoldMs = fistHoldMs;
    this.reset();
  }

  reset() {
    this.pose = 'none';
    this.since = 0;
    this.lastSeenAt = 0;
    this.fired = false;
  }

  update(hand, now, recognizedPose = null) {
    const observed = recognizedPose || classifyHandPose(hand);
    if ((observed === 'other' || observed === 'none') && (this.pose === 'point' || this.pose === 'fist') && now - this.lastSeenAt <= 250) {
      return { pose: this.pose, pause: true, action: null };
    }
    const pose = observed;
    if (pose !== this.pose) {
      this.pose = pose;
      this.since = now;
      this.fired = false;
    }
    this.lastSeenAt = now;
    let action = null;
    const holdMs = pose === 'point' ? this.pointHoldMs : pose === 'fist' ? this.fistHoldMs : Infinity;
    if (!this.fired && now - this.since >= holdMs) {
      action = pose === 'point' ? 'color' : 'undo';
      this.fired = true;
    }
    return { pose, pause: pose === 'palm' || pose === 'point' || pose === 'fist', action };
  }
}

export function pickDrawingHandIndex(hands, previousWrist = null) {
  if (!hands.length) return -1;
  if (hands.length === 1) return 0;
  const pinched = hands.map(hand => pinchRatio(hand) <= PINCH_TOUCH_THRESHOLD);
  if (pinched[0] !== pinched[1]) return pinched[0] ? 0 : 1;
  if (previousWrist) return distance(hands[0][0], previousWrist) <= distance(hands[1][0], previousWrist) ? 0 : 1;
  return hands[0][0].x > hands[1][0].x ? 0 : 1;
}

export function selectHandRoles(hands, handednesses = [], previousWrist = null, drawingLabel = null, poses = []) {
  if (!hands.length) return { drawing: null, offhand: null, drawingLabel };
  const labels = hands.map((_, index) => handednesses[index]?.[0]?.categoryName || null);
  const pinched = hands.map((hand, i) => (poses[i] || classifyHandPose(hand)) !== 'fist' && pinchRatio(hand) <= PINCH_TOUCH_THRESHOLD);
  const uniquePinch = pinched.filter(Boolean).length === 1 ? pinched.indexOf(true) : -1;
  let drawingIndex = -1;
  if (drawingLabel) {
    const matches = labels.map((label, index) => label === drawingLabel ? index : -1).filter(index => index >= 0);
    if (matches.length === 1) drawingIndex = matches[0];
  }
  if (drawingIndex < 0 && !drawingLabel) drawingIndex = uniquePinch;
  if (drawingIndex < 0) drawingIndex = pickDrawingHandIndex(hands, previousWrist);
  if (hands.length === 1 && drawingLabel && labels[0] && labels[0] !== drawingLabel) {
    return { drawing: null, offhand: hands[0], drawingLabel };
  }
  return {
    drawing: hands[drawingIndex],
    offhand: hands.length === 2 ? hands[1 - drawingIndex] : null,
    drawingLabel: drawingLabel || (uniquePinch >= 0 ? labels[uniquePinch] : null)
  };
}

export function handNearFace(hand, faceBox) {
  if (!hand || !faceBox) return false;
  const marginX = faceBox.width * .2 + .025;
  const marginY = faceBox.height * .2 + .025;
  const left = faceBox.x - marginX;
  const right = faceBox.x + faceBox.width + marginX;
  const top = faceBox.y - marginY;
  const bottom = faceBox.y + faceBox.height + marginY;
  return [hand[0], hand[9], hand[8]].some(point =>
    point && point.x >= left && point.x <= right && point.y >= top && point.y <= bottom);
}

// A One Euro filter: steady hands get stronger smoothing while deliberate motion
// raises the cutoff so the cursor can keep up.
export class AdaptivePointFilter {
  constructor({ minCutoff = 1.4, beta = 3, derivativeCutoff = 1 } = {}) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.derivativeCutoff = derivativeCutoff;
    this.reset();
  }

  reset() {
    this.point = null;
    this.raw = null;
    this.anchor = null;
    this.candidate = null;
    this.discontinuity = false;
    this.derivative = { x: 0, y: 0 };
    this.time = null;
  }

  update(point, time, anchor = null) {
    this.discontinuity = false;
    if (!this.point || this.time === null || time <= this.time) {
      this.point = { x: point.x, y: point.y };
      this.raw = { x: point.x, y: point.y };
      this.anchor = anchor;
      this.time = time;
      return this.point;
    }
    const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    if (this.candidate && distance(point, this.candidate) < .08) {
      this.reset();
      this.discontinuity = true;
      this.point = { x: point.x, y: point.y };
      this.raw = { x: point.x, y: point.y };
      this.anchor = anchor;
      this.time = time;
      return this.point;
    }
    this.candidate = null;
    if (anchor && this.anchor && distance(point, this.raw) > .16 && distance(anchor, this.anchor) < .05) {
      this.candidate = { x: point.x, y: point.y };
      this.time = time;
      return this.point;
    }
    const dt = Math.min(.1, Math.max(.001, (time - this.time) / 1000));
    const alpha = cutoff => 1 - Math.exp(-2 * Math.PI * cutoff * dt);
    const derivativeAlpha = alpha(this.derivativeCutoff);
    const next = {};
    for (const axis of ['x', 'y']) {
      const velocity = (point[axis] - this.raw[axis]) / dt;
      this.derivative[axis] += derivativeAlpha * (velocity - this.derivative[axis]);
      const cutoff = this.minCutoff + this.beta * Math.abs(this.derivative[axis]);
      next[axis] = this.point[axis] + alpha(cutoff) * (point[axis] - this.point[axis]);
    }
    this.raw = { x: point.x, y: point.y };
    this.anchor = anchor;
    this.point = next;
    this.time = time;
    return next;
  }
}

export function isIPhoneCamera(device) {
  return /iphone|continuity camera/i.test(device?.label || '');
}

export function pickCameraDevice(devices, mode, selectedId = '', onIPhone = false) {
  const cameras = devices.filter(device => device.kind === 'videoinput');
  const matching = cameras.filter(device => mode === 'iphone' ? onIPhone || isIPhoneCamera(device) : !isIPhoneCamera(device));
  if (selectedId) return matching.find(device => device.deviceId === selectedId) || null;
  if (mode === 'iphone') {
    const ultraWide = matching.find(device => /ultra[ -]?wide|0[.,]5\s?x/i.test(device.label));
    if (ultraWide) return ultraWide;
  }
  if (mode === 'iphone' && onIPhone) return matching.find(device => /back|rear|environment/i.test(device.label)) || null;
  if (mode === 'iphone') return matching[0] || null;
  return matching.find(device => /built-in|facetime|integrated|macbook|display/i.test(device.label)) || matching[0] || null;
}

export async function listCameraDevicesWithPermission(mediaDevices, force = false, initialDevices = null) {
  let devices = initialDevices || await mediaDevices.enumerateDevices();
  if (!force && devices.some(device => device.kind === 'videoinput' && device.label)) return devices;
  // Keep the permission stream alive until labels and Continuity Camera appear.
  const permissionStream = await mediaDevices.getUserMedia({ audio: false, video: true });
  try {
    devices = await mediaDevices.enumerateDevices();
  } finally {
    permissionStream.getTracks().forEach(track => track.stop());
  }
  return devices;
}

export async function findCameraWithPermission(mediaDevices, mode, selectedId = '', onIPhone = false) {
  let devices = await mediaDevices.enumerateDevices();
  let selected = pickCameraDevice(devices, mode, selectedId, onIPhone) || pickCameraDevice(devices, mode, '', onIPhone);
  if (selected && selected.label) return selected;
  devices = await listCameraDevicesWithPermission(mediaDevices, true, devices);
  selected = pickCameraDevice(devices, mode, selectedId, onIPhone) || pickCameraDevice(devices, mode, '', onIPhone);
  return selected;
}

export function cameraVideoConstraints(selected, mode) {
  const source = selected?.deviceId
    ? { deviceId: { exact: selected.deviceId } }
    : { facingMode: mode === 'iphone' ? 'environment' : 'user' };
  return { ...source, width: { ideal: 960 }, height: { ideal: 540 }, frameRate: { ideal: 30 } };
}

// Keep discovery's permission stream alive until the selected camera is open.
// If it is already the selected device, reuse it rather than restarting iPhone.
export async function openCameraStream(mediaDevices, mode, selectedId = '', onIPhone = false) {
  let permissionStream;
  try {
    let devices = await mediaDevices.enumerateDevices();
    let selected = pickCameraDevice(devices, mode, selectedId, onIPhone) || pickCameraDevice(devices, mode, '', onIPhone);
    if (!selected?.label) {
      permissionStream = await mediaDevices.getUserMedia({ audio: false, video: true });
      devices = await mediaDevices.enumerateDevices();
      selected = pickCameraDevice(devices, mode, selectedId, onIPhone) || pickCameraDevice(devices, mode, '', onIPhone);
    }
    if (mode === 'iphone' && !onIPhone && !selected) {
      throw Object.assign(new Error('iPhone Continuity Camera is not listed by this browser'), { name: 'IPhoneCameraNotFound' });
    }
    const permissionTrack = permissionStream?.getVideoTracks()[0];
    if (selected?.deviceId && permissionTrack?.getSettings?.().deviceId === selected.deviceId) {
      const stream = permissionStream;
      permissionStream = null;
      return { stream, selected };
    }
    let stream;
    try {
      stream = await mediaDevices.getUserMedia({ audio: false, video: cameraVideoConstraints(selected, mode) });
    } catch (error) {
      if (!['OverconstrainedError', 'NotReadableError', 'NotFoundError'].includes(error.name)) throw error;
      const fresh = await mediaDevices.enumerateDevices();
      selected = pickCameraDevice(fresh, mode, selected?.deviceId, onIPhone) || pickCameraDevice(fresh, mode, '', onIPhone);
      if (mode === 'iphone' && !onIPhone && !selected) throw Object.assign(new Error('iPhone camera disconnected'), { name: 'IPhoneCameraNotFound' });
      const video = selected?.deviceId ? { deviceId: { exact: selected.deviceId } } : { facingMode: mode === 'iphone' ? 'environment' : 'user' };
      stream = await mediaDevices.getUserMedia({ audio: false, video });
    }
    return { stream, selected };
  } finally {
    permissionStream?.getTracks().forEach(track => track.stop());
  }
}

export async function requestWideZoom(track, target = .5) {
  const current = track?.getSettings?.().zoom;
  if (typeof current === 'number' && Math.abs(current - target) < .05) return 'active';
  const range = track?.getCapabilities?.().zoom;
  if (!range || typeof range.min !== 'number' || typeof range.max !== 'number') return 'requested';
  if (target < range.min || target > range.max || !track.applyConstraints) return 'unavailable';
  try {
    await track.applyConstraints({ advanced: [{ zoom: target }] });
    const actual = track.getSettings?.().zoom;
    return typeof actual === 'number' ? (Math.abs(actual - target) < .05 ? 'active' : 'unavailable') : 'requested';
  } catch { return 'unavailable'; }
}

export function mapCameraPoint(point, mirrored = false) {
  const x = mirrored ? 1 - point.x : point.x;
  return { x: Math.max(0, Math.min(1, (x - .06) / .88)), y: Math.max(0, Math.min(1, (point.y - .06) / .88)) };
}

export function classifyPencilPixel(r, g, b) {
  if (r >= 165 && b >= r * .34 && b >= g * 1.13 && r >= g * 1.25) return 'eraser';
  if (r >= 165 && r >= g * 1.65 && r >= b * 1.65) return 'tip';
  return null;
}

export function findPencilMarker(pixels, width, height, hand) {
  const found = { tip: { x: 0, y: 0, n: 0 }, eraser: { x: 0, y: 0, n: 0 } };
  for (let y = 0; y < height; y += 2) for (let x = 0; x < width; x += 2) {
    const nx = x / width, ny = y / height;
    if (Math.hypot(nx - hand[8].x, ny - hand[8].y) > .28) continue;
    const i = (y * width + x) * 4;
    const kind = classifyPencilPixel(pixels[i], pixels[i + 1], pixels[i + 2]);
    if (kind) { found[kind].x += nx; found[kind].y += ny; found[kind].n++; }
  }
  const candidates = ['tip', 'eraser'].filter(kind => found[kind].n >= 5).map(kind => ({
    kind, x: found[kind].x / found[kind].n, y: found[kind].y / found[kind].n,
  }));
  if (candidates.length < 2) return candidates[0] || null;
  return candidates.sort((a, b) => distance(b, hand[0]) - distance(a, hand[0]))[0];
}

export function waitForVideoFrame(video, timeoutMs = 7000) {
  return new Promise((resolve, reject) => {
    let timeout, poll;
    const cleanup = () => {
      clearTimeout(timeout);
      clearInterval(poll);
      video.removeEventListener('loadeddata', check);
      video.removeEventListener('resize', check);
    };
    const fail = error => { cleanup(); reject(error); };
    const check = () => {
      if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
        cleanup(); resolve();
      }
    };
    video.addEventListener('loadeddata', check);
    video.addEventListener('resize', check);
    timeout = setTimeout(() => fail(Object.assign(new Error('Camera delivered no video frames'), { name: 'NoVideoFrames' })), timeoutMs);
    poll = setInterval(check, 80);
    try { Promise.resolve(video.play()).catch(fail); }
    catch (error) { fail(error); }
    check();
  });
}
