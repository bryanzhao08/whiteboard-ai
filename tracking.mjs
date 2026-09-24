export class PinchGate {
  constructor({ onThreshold = 0.52, offThreshold = 0.82, releaseMs = 180 } = {}) {
    this.onThreshold = onThreshold;
    this.offThreshold = offThreshold;
    this.releaseMs = releaseMs;
    this.active = false;
    this.releaseStartedAt = null;
  }

  update(ratio, now) {
    if (ratio <= this.onThreshold) {
      this.active = true;
      this.releaseStartedAt = null;
    } else if (this.active && ratio >= this.offThreshold) {
      if (this.releaseStartedAt === null) this.releaseStartedAt = now;
      if (now - this.releaseStartedAt >= this.releaseMs) this.reset();
    } else {
      this.releaseStartedAt = null;
    }
    return this.active;
  }

  reset() {
    this.active = false;
    this.releaseStartedAt = null;
  }
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
