// Find separate handwritten lines in the rendered ink mask. The alpha channel
// preserves erased areas and works regardless of the board's ink or theme color.
export function findInkLineBounds(data, width, height) {
  const rows = [];
  for (let y = 0; y < height; y++) {
    let left = width;
    let right = -1;
    let count = 0;
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] < 55) continue;
      left = Math.min(left, x);
      right = x;
      count++;
    }
    if (count) rows.push({ y, left, right, count });
  }
  if (!rows.length) return [];

  const groups = [];
  const maxGap = Math.max(12, Math.min(18, Math.round(height * 0.012)));
  for (const row of rows) {
    let group = groups.at(-1);
    if (!group || row.y - group.bottom > maxGap) {
      group = { left: row.left, right: row.right, top: row.y, bottom: row.y, pixels: 0 };
      groups.push(group);
    }
    group.left = Math.min(group.left, row.left);
    group.right = Math.max(group.right, row.right);
    group.bottom = row.y;
    group.pixels += row.count;
  }

  return groups
    .filter(group => group.right - group.left >= 18 && group.bottom - group.top >= 4 && group.pixels >= 35)
    .map(group => {
      const pad = Math.max(10, Math.round((group.bottom - group.top + 1) * 0.18));
      return {
        left: Math.max(0, group.left - pad),
        top: Math.max(0, group.top - pad),
        right: Math.min(width, group.right + pad + 1),
        bottom: Math.min(height, group.bottom + pad + 1)
      };
    });
}
