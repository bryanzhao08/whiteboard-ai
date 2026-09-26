export class BoardViewport {
  constructor() { this.reset(); }
  reset() { this.zoom = 1; this.x = 0; this.y = 0; }
  toWorld(point) { return { x: (point.x - this.x) / this.zoom, y: (point.y - this.y) / this.zoom }; }
  pan(dx, dy) { this.x += dx; this.y += dy; }
  zoomAt(zoom, anchor = { x: .5, y: .5 }) {
    const world = this.toWorld(anchor);
    this.zoom = Math.max(.5, Math.min(4, zoom));
    this.x = anchor.x - world.x * this.zoom;
    this.y = anchor.y - world.y * this.zoom;
  }
}

export class NavigationGesture {
  constructor() { this.reset(); }
  reset() { this.mode = null; this.anchor = null; this.startedAt = 0; this.engaged = false; }
  update(hands, poses, now) {
    const palms = hands.map((hand, i) => poses[i] === 'palm' ? hand[9] : null).filter(Boolean);
    const victory = hands.find((_, i) => poses[i] === 'victory');
    const mode = palms.length === 2 ? 'zoom' : victory ? 'pan' : null;
    if (!mode) { this.reset(); return null; }
    const center = mode === 'zoom'
      ? { x: (palms[0].x + palms[1].x) / 2, y: (palms[0].y + palms[1].y) / 2 }
      : victory[9];
    const span = mode === 'zoom' ? Math.hypot(palms[0].x - palms[1].x, palms[0].y - palms[1].y) : 1;
    if (mode !== this.mode) {
      this.mode = mode; this.anchor = { ...center, span }; this.startedAt = now; this.engaged = false;
      return { mode, waiting: true };
    }
    if (now - this.startedAt < 200) { this.anchor = { ...center, span }; return { mode, waiting: true }; }
    const filtered = { x: this.anchor.x + (center.x - this.anchor.x) * .4, y: this.anchor.y + (center.y - this.anchor.y) * .4, span: this.anchor.span + (span - this.anchor.span) * .4 };
    const result = { mode, waiting: false, dx: filtered.x - this.anchor.x, dy: filtered.y - this.anchor.y, scale: filtered.span / Math.max(this.anchor.span, .06), center: filtered };
    const rawJump = Math.hypot(center.x - this.anchor.x, center.y - this.anchor.y);
    this.anchor = filtered; this.engaged = true;
    // Ignore one-frame jumps, which would otherwise fling or zoom the board.
    if (rawJump > .2 || result.scale < .7 || result.scale > 1.3) { this.anchor = { ...center, span }; return { mode, waiting: true }; }
    return result;
  }
}
