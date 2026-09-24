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
  return cosine < -.82 && distance(hand[tip], hand[mcp]) > distance(hand[pip], hand[mcp]) * 1.35;
}

export function classifyHandPose(hand) {
  if (!hand) return 'none';
  const extended = [[5,6,7,8],[9,10,11,12],[13,14,15,16],[17,18,19,20]]
    .map(indices => fingerExtended(hand, ...indices));
  const count = extended.filter(Boolean).length;
  if (count >= 3) return 'palm';
  if (extended[0] && count === 1) return 'point';
  if (!extended[0] && count <= 1) return 'fist';
  return 'other';
}

export class OffhandGesture {
  constructor({ pointHoldMs = 650, fistHoldMs = 350 } = {}) {
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

  update(hand, now) {
    const observed = classifyHandPose(hand);
    if (observed === 'other' && (this.pose === 'point' || this.pose === 'fist') && now - this.lastSeenAt <= 120) {
      return { pose: this.pose, pause: false, action: null };
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
    return { pose, pause: pose === 'palm', action };
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

export function pickCameraDevice(devices, mode, selectedId = '') {
  const cameras = devices.filter(device => device.kind === 'videoinput');
  const matching = cameras.filter(device => mode === 'iphone' ? isIPhoneCamera(device) : !isIPhoneCamera(device));
  if (selectedId) return matching.find(device => device.deviceId === selectedId) || null;
  if (mode === 'iphone') return matching[0] || null;
  return matching.find(device => /built-in|facetime|integrated|macbook|display/i.test(device.label)) || matching[0] || null;
}
