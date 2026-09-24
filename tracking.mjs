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
