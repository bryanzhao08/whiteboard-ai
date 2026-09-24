import test from 'node:test';
import assert from 'node:assert/strict';
import { findInkLineBounds } from '../recognition.mjs';

function mask(width, height, rectangles) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (const [left, top, right, bottom] of rectangles) {
    for (let y = top; y < bottom; y++) {
      for (let x = left; x < right; x++) data[(y * width + x) * 4 + 3] = 255;
    }
  }
  return data;
}

test('separates two handwritten lines and keeps nearby dots with their letters', () => {
  const width = 180, height = 130;
  const data = mask(width, height, [
    [20, 32, 115, 44], [35, 20, 40, 24],
    [28, 78, 133, 94]
  ]);
  const lines = findInkLineBounds(data, width, height);
  assert.equal(lines.length, 2);
  assert.ok(lines[0].top <= 20);
  assert.ok(lines[0].right >= 115);
  assert.ok(lines[1].top <= 78 && lines[1].bottom >= 94);
});

test('ignores blank boards and isolated small ink marks', () => {
  assert.deepEqual(findInkLineBounds(mask(100, 70, []), 100, 70), []);
  assert.deepEqual(findInkLineBounds(mask(100, 70, [[8, 8, 11, 11]]), 100, 70), []);
});
