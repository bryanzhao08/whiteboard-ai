import test from 'node:test';
import assert from 'node:assert/strict';
import { BoardViewport, NavigationGesture } from '../viewport.mjs';

test('zoom preserves the anchor and drawing maps back to the same world location', () => {
  const view = new BoardViewport();
  const anchor = { x: .3, y: .6 };
  view.zoomAt(2, anchor);
  assert.deepEqual(view.toWorld(anchor), anchor);
  view.pan(.2, -.1);
  const mapped = view.toWorld({ x: .5, y: .5 });
  assert.ok(Math.abs(mapped.x - .3) < 1e-9 && Math.abs(mapped.y - .6) < 1e-9);
  view.zoomAt(100); assert.equal(view.zoom, 4);
  view.zoomAt(.01); assert.equal(view.zoom, .5);
  view.reset(); assert.deepEqual(view.toWorld(anchor), anchor);
});

const hand = (x, y) => Array.from({ length: 21 }, () => ({ x, y }));
test('two fingers pan only after a deliberate hold and stop when the gesture releases', () => {
  const nav = new NavigationGesture();
  assert.equal(nav.update([hand(.3, .4)], ['victory'], 0).waiting, true);
  assert.equal(nav.update([hand(.3, .4)], ['victory'], 150).waiting, true);
  const result = nav.update([hand(.4, .5)], ['victory'], 250);
  assert.equal(result.mode, 'pan'); assert.ok(result.dx > 0 && result.dy > 0);
  assert.equal(nav.update([hand(.4, .5)], ['point'], 300), null);
});

test('two open palms zoom and pan without generating an undo or color gesture', () => {
  const nav = new NavigationGesture();
  nav.update([hand(.3, .5), hand(.7, .5)], ['palm', 'palm'], 0);
  const result = nav.update([hand(.25, .55), hand(.8, .55)], ['palm', 'palm'], 250);
  assert.equal(result.mode, 'zoom'); assert.ok(result.scale > 1); assert.ok(result.dy > 0);
  const lost = nav.update([], [], 300); assert.equal(lost, null);
});
