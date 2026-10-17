const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../src/js/core.js');

// Build a w*h grid from rows of chars; each char maps to a u32 color.
function grid(rows, map) {
  const h = rows.length, w = rows[0].length;
  const u32 = new Uint32Array(w * h);
  rows.forEach((row, y) => [...row].forEach((ch, x) => { u32[y * w + x] = map[ch]; }));
  return { u32, w, h };
}
function toRows(u32, w, h, rev) {
  const out = [];
  for (let y = 0; y < h; y++) {
    let s = '';
    for (let x = 0; x < w; x++) s += rev[u32[y * w + x]];
    out.push(s);
  }
  return out;
}

test('rgbaToU32 packs little-endian ImageData order', () => {
  const buf = new Uint8ClampedArray([10, 20, 30, 255]);
  const view = new Uint32Array(buf.buffer);
  assert.equal(Core.rgbaToU32(10, 20, 30, 255), view[0]);
});

test('colorDistance is max channel difference', () => {
  const a = Core.rgbaToU32(10, 20, 30, 255);
  const b = Core.rgbaToU32(15, 60, 30, 250);
  assert.equal(Core.colorDistance(a, b), 40);
  assert.equal(Core.colorDistance(a, a), 0);
});

test('floodFill fills enclosed region only, respects wall', () => {
  const W = Core.rgbaToU32(255, 255, 255, 255), K = Core.rgbaToU32(0, 0, 0, 255), R = Core.rgbaToU32(255, 0, 0, 255);
  const map = { '.': W, '#': K, 'r': R }, rev = { [W]: '.', [K]: '#', [R]: 'r' };
  const g = grid([
    '..#..',
    '..#..',
    '###..',
    '.....',
    '.....',
  ], map);
  const bbox = Core.floodFill(g.u32, g.w, g.h, 0, 0, R, 0);
  assert.deepEqual(toRows(g.u32, g.w, g.h, rev), [
    'rr#..',
    'rr#..',
    '###..',
    '.....',
    '.....',
  ]);
  assert.deepEqual(bbox, { x: 0, y: 0, w: 2, h: 2 });
});

test('floodFill flows around diagonal gap? no: 4-connected', () => {
  const W = Core.rgbaToU32(255, 255, 255, 255), K = Core.rgbaToU32(0, 0, 0, 255), R = Core.rgbaToU32(255, 0, 0, 255);
  const map = { '.': W, '#': K }, rev = { [W]: '.', [K]: '#', [R]: 'r' };
  const g = grid([
    '.#.',
    '#..',
    '...',
  ], map);
  Core.floodFill(g.u32, g.w, g.h, 0, 0, R, 0);
  assert.deepEqual(toRows(g.u32, g.w, g.h, rev), ['r#.', '#..', '...']);
});

test('floodFill tolerance boundary: included at threshold, excluded just above', () => {
  const base = Core.rgbaToU32(100, 100, 100, 255);
  const R = Core.rgbaToU32(255, 0, 0, 255);
  // tolerance 20% -> threshold round(0.2*255)=51
  const near = Core.rgbaToU32(151, 100, 100, 255); // dist 51 -> fill
  const far = Core.rgbaToU32(152, 100, 100, 255);  // dist 52 -> stop
  const u32 = new Uint32Array([base, near, far, base]);
  Core.floodFill(u32, 4, 1, 0, 0, R, 20);
  assert.deepEqual([...u32], [R, R, far, base]);
});

test('floodFill returns null when nothing changes and terminates with tolerance covering fill color', () => {
  const W = Core.rgbaToU32(255, 255, 255, 255);
  const u32 = new Uint32Array(9).fill(W);
  assert.equal(Core.floodFill(u32, 3, 3, 1, 1, W, 0), null);
  const almost = Core.rgbaToU32(250, 255, 255, 255);
  const bbox = Core.floodFill(u32, 3, 3, 1, 1, almost, 50);
  assert.deepEqual(bbox, { x: 0, y: 0, w: 3, h: 3 });
  assert.ok([...u32].every(v => v === almost));
});

test('floodFill out of bounds is a no-op', () => {
  const u32 = new Uint32Array(4);
  assert.equal(Core.floodFill(u32, 2, 2, 5, 0, 1, 0), null);
});

// fillEdge: the region of floodMask, then the ring fillEdge returns written over it.
function fillWithEdge(g, x, y, color, tol) {
  const target = g.u32[y * g.w + x];
  const region = Core.floodMask(g.u32, g.w, g.h, x, y, tol);
  const e = Core.fillEdge(g.u32, g.w, g.h, region, target, color, tol);
  assert.ok(region.mask.every((m) => m === 0 || m === 1)); // edge marks are cleared
  assert.equal(new Set(region.edge).size, region.edge.length); // each edge pixel once
  for (let i = 0; i < region.mask.length; i++) if (region.mask[i]) g.u32[i] = color;
  e.idx.forEach((i, k) => { g.u32[i] = e.val[k]; });
  return e;
}
const rgba = (v) => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, v >>> 24];

test('fillEdge recolours an anti-aliased edge as if it had been drawn over the fill colour', () => {
  const W = Core.rgbaToU32(255, 255, 255, 255), K = Core.rgbaToU32(0, 0, 0, 255), R = Core.rgbaToU32(255, 0, 0, 255);
  const g40 = Core.rgbaToU32(102, 102, 102, 255); // 40% white over black ink
  const g = grid(['..gKK', '..gKK', '..gKK'], { '.': W, g: g40, K });
  const e = fillWithEdge(g, 0, 0, R, 10);
  assert.equal(e.idx.length, 3);
  for (let y = 0; y < 3; y++) {
    assert.deepEqual(rgba(g.u32[y * 5 + 2]), [102, 0, 0, 255]); // 40% red over black
    assert.equal(g.u32[y * 5 + 3], K);
  }
  assert.deepEqual(e.box, { x: 0, y: 0, w: 3, h: 3 }); // the region's box grown by the ring
});

test('fillEdge reaches edge pixels that touch the region only diagonally', () => {
  const W = Core.rgbaToU32(255, 255, 255, 255), K = Core.rgbaToU32(0, 0, 0, 255), R = Core.rgbaToU32(255, 0, 0, 255);
  const g50 = Core.rgbaToU32(128, 128, 128, 255);
  // a 45-degree edge: g is half covered; the flood is 4-connected, the ring 8-connected
  const g = grid(['..gK', '.gKK', 'gKKK', 'KKKK'], { '.': W, g: g50, K });
  fillWithEdge(g, 0, 0, R, 10);
  for (const [x, y] of [[2, 0], [1, 1], [0, 2]]) assert.deepEqual(rgba(g.u32[y * 4 + x]), [128, 0, 0, 255]);
});

test('fillEdge grows through soft pixels to ones that only touch soft pixels (a narrow wedge)', () => {
  const W = Core.rgbaToU32(255, 255, 255, 255), K = Core.rgbaToU32(0, 0, 0, 255), R = Core.rgbaToU32(255, 0, 0, 255);
  const s30 = Core.rgbaToU32(77, 77, 77, 255), s78 = Core.rgbaToU32(199, 199, 199, 255);
  // w: 78% background, touching the region only through 30% pixels
  const g = grid(['..sKK', '..swK', '..sKK'], { '.': W, s: s30, w: s78, K });
  fillWithEdge(g, 0, 0, R, 10);
  assert.deepEqual(rgba(g.u32[8]), [199, 0, 0, 255]);
  assert.deepEqual(rgba(g.u32[2]), [77, 0, 0, 255]);
});

test('fillEdge does not grow onto soft pixels that touch another region', () => {
  const W = Core.rgbaToU32(255, 255, 255, 255), K = Core.rgbaToU32(0, 0, 0, 255), R = Core.rgbaToU32(255, 0, 0, 255);
  const s30 = Core.rgbaToU32(77, 77, 77, 255), s78 = Core.rgbaToU32(199, 199, 199, 255);
  // the w pixels belong to the soft edge of the region on the right, which isn't filled
  const g = grid(['.sw..', '.sK..', '.sw..'], { '.': W, s: s30, w: s78, K });
  fillWithEdge(g, 0, 0, R, 10);
  assert.equal(g.u32[2], s78);
  assert.equal(g.u32[12], s78);
  assert.equal(g.u32[3], W);
});

test('fillEdge leaves hard-edged art byte-identical', () => {
  const W = Core.rgbaToU32(255, 255, 255, 255), K = Core.rgbaToU32(0, 0, 0, 255), R = Core.rgbaToU32(255, 0, 0, 255), B = Core.rgbaToU32(0, 0, 255, 255);
  const map = { '.': W, r: R, '#': K }, rev = { [W]: '.', [R]: 'r', [K]: '#', [B]: 'b' };
  // two-colour pixel art and a 1 px diagonal pencil line on white
  const g = grid(['.......', '.r#..#.', '.#r.#..', '...#...', '.......'], map);
  const e = fillWithEdge(g, 0, 0, B, 10);
  assert.equal(e.idx.length, 0);
  assert.deepEqual(toRows(g.u32, g.w, g.h, rev), ['bbbbbbb', 'br#bb#b', 'b#rb#bb', 'bbb#bbb', 'bbbbbbb']);
});

test('fillEdge does not leak into a separate region that touches diagonally', () => {
  const W = Core.rgbaToU32(255, 255, 255, 255), K = Core.rgbaToU32(0, 0, 0, 255), R = Core.rgbaToU32(255, 0, 0, 255);
  const g = grid(['.#.', '#..', '...'], { '.': W, '#': K });
  const e = fillWithEdge(g, 0, 0, R, 0);
  assert.equal(e.idx.length, 0);
  assert.equal(g.u32[4], W); // (1, 1): the other region, diagonal to the filled pixel
});

test('fillEdge leaves a thin line with no fully inked pixel as it is', () => {
  const W = Core.rgbaToU32(255, 255, 255, 255), R = Core.rgbaToU32(255, 0, 0, 255);
  const g50 = Core.rgbaToU32(128, 128, 128, 255);
  const g = grid(['..g..', '..g..'], { '.': W, g: g50 });
  const e = fillWithEdge(g, 0, 0, R, 10);
  assert.equal(e.idx.length, 0); // nothing darker nearby: the ink colour is unknown
});

test('fillEdge over a transparent background composites the ink onto the fill colour', () => {
  const T = 0, K = Core.rgbaToU32(0, 0, 0, 255), R = Core.rgbaToU32(255, 0, 0, 255);
  const half = Core.rgbaToU32(0, 0, 0, 128); // canvas reads transparent as 0,0,0,0
  const g = grid(['.hK', '.hK'], { '.': T, h: half, K });
  fillWithEdge(g, 0, 0, R, 10);
  assert.deepEqual(rgba(g.u32[1]), [127, 0, 0, 255]);
});

test('fillEdge clamps its box to the image', () => {
  const W = Core.rgbaToU32(255, 255, 255, 255), K = Core.rgbaToU32(0, 0, 0, 255), R = Core.rgbaToU32(255, 0, 0, 255);
  const g40 = Core.rgbaToU32(102, 102, 102, 255);
  const g = grid(['gg..', 'gg..'], { '.': W, g: g40 });
  g.u32[0] = K; g.u32[4] = K;
  const e = fillWithEdge(g, 3, 0, R, 10);
  assert.deepEqual(e.box, { x: 1, y: 0, w: 3, h: 2 });
});

// fillPlan: the whole fill (region, soft edge, undo data) in one call, so it can run in a worker.
test('fillPlan fills like floodMask + fillEdge and returns the undo data for its box', () => {
  const W = Core.rgbaToU32(255, 255, 255, 255), K = Core.rgbaToU32(0, 0, 0, 255), R = Core.rgbaToU32(255, 0, 0, 255);
  const g40 = Core.rgbaToU32(102, 102, 102, 255);
  const rows = ['......', '.##g..', '.#..#.', '..g#..', '......', '######'];
  const a = grid(rows, { '.': W, '#': K, g: g40 }), b = grid(rows, { '.': W, '#': K, g: g40 });
  const orig = a.u32.slice();
  const e = fillWithEdge(a, 0, 0, R, 10);
  const p = Core.fillPlan(b.u32, b.w, b.h, 0, 0, R, 10);
  assert.deepEqual([...b.u32], [...a.u32]); // the same pixels as the two-step fill
  assert.deepEqual(p.box, e.box);
  const { x, y, w, h } = p.box;
  assert.equal(p.before.length, w * h);
  // before: the box's original pixels; bits/ek/ev rebuild the box's filled pixels from them (redo)
  const after = p.before.slice();
  for (let yy = 0; yy < h; yy++) {
    for (let xx = 0; xx < w; xx++) {
      const k = yy * w + xx;
      assert.equal(p.before[k], orig[(y + yy) * b.w + x + xx]);
      if (p.bits[k >> 3] & (1 << (k & 7))) after[k] = R;
    }
  }
  p.ek.forEach((k, j) => { after[k] = p.ev[j]; });
  for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) assert.equal(after[yy * w + xx], b.u32[(y + yy) * b.w + x + xx]);
  assert.ok(p.ek.length > 0); // the grey pixels are a soft edge
});

test('fillPlan returns null and leaves the pixels alone when nothing changes', () => {
  const W = Core.rgbaToU32(255, 255, 255, 255), K = Core.rgbaToU32(0, 0, 0, 255);
  const g = grid(['..#', '.#.', '#..'], { '.': W, '#': K });
  const orig = g.u32.slice();
  assert.equal(Core.fillPlan(g.u32, g.w, g.h, 0, 0, W, 0), null);
  assert.equal(Core.fillPlan(g.u32, g.w, g.h, 0, 0, W, 10), null);
  assert.equal(Core.fillPlan(g.u32, g.w, g.h, 9, 0, K, 0), null); // outside the image
  assert.deepEqual([...g.u32], [...orig]);
});

test('line produces contiguous Bresenham points', () => {
  assert.deepEqual(Core.line(0, 0, 3, 0), [[0, 0], [1, 0], [2, 0], [3, 0]]);
  assert.deepEqual(Core.line(0, 0, 2, 2), [[0, 0], [1, 1], [2, 2]]);
  const back = Core.line(2, 1, 0, 0);
  assert.equal(back.length, 3);
  assert.deepEqual(back[0], [2, 1]);
  assert.deepEqual(back[2], [0, 0]);
  const pts = Core.line(0, 0, 5, 2);
  assert.equal(pts.length, 6);
  for (let i = 1; i < pts.length; i++) {
    assert.ok(Math.abs(pts[i][0] - pts[i - 1][0]) <= 1 && Math.abs(pts[i][1] - pts[i - 1][1]) <= 1);
  }
  assert.deepEqual(pts[0], [0, 0]);
  assert.deepEqual(pts[5], [5, 2]);
  assert.deepEqual(Core.line(4, 4, 4, 4), [[4, 4]]);
});

test('normRect and clampRect', () => {
  assert.deepEqual(Core.normRect({ x: 5, y: 1 }, { x: 2, y: 4 }), { x: 2, y: 1, w: 3, h: 3 });
  assert.deepEqual(Core.clampRect({ x: -2, y: 3, w: 5, h: 10 }, 10, 8), { x: 0, y: 3, w: 3, h: 5 });
  assert.equal(Core.clampRect({ x: 20, y: 0, w: 5, h: 5 }, 10, 10), null);
  assert.equal(Core.clampRect({ x: 0, y: 0, w: 0, h: 5 }, 10, 10), null);
});

test('constrainShape: square for rect/ellipse, 45deg snap for line', () => {
  const s = { x: 10, y: 10 };
  assert.deepEqual(Core.constrainShape(s, { x: 14, y: 2 }, false, 'rect'), { x: 14, y: 2 });
  assert.deepEqual(Core.constrainShape(s, { x: 14, y: 2 }, true, 'rect'), { x: 18, y: 2 });
  assert.deepEqual(Core.constrainShape(s, { x: 4, y: 12 }, true, 'ellipse'), { x: 4, y: 16 });
  assert.deepEqual(Core.constrainShape(s, { x: 30, y: 12 }, true, 'line'), { x: 30, y: 10 });
  assert.deepEqual(Core.constrainShape(s, { x: 11, y: 30 }, true, 'line'), { x: 10, y: 30 });
  assert.deepEqual(Core.constrainShape(s, { x: 19, y: 21 }, true, 'line'), { x: 20, y: 20 });
});

test('fitDims: percent, locked width/height, unlocked, min 1', () => {
  assert.deepEqual(Core.fitDims(200, 100, { pct: 50 }), { w: 100, h: 50 });
  assert.deepEqual(Core.fitDims(200, 100, { w: 50, lockAspect: true }), { w: 50, h: 25 });
  assert.deepEqual(Core.fitDims(200, 100, { h: 30, lockAspect: true }), { w: 60, h: 30 });
  assert.deepEqual(Core.fitDims(200, 100, { w: 7, h: 9 }), { w: 7, h: 9 });
  assert.deepEqual(Core.fitDims(3, 3, { pct: 1 }), { w: 1, h: 1 });
});

test('anchorOffset positions old image in new canvas', () => {
  assert.deepEqual(Core.anchorOffset(10, 10, 20, 30, 'tl'), { dx: 0, dy: 0 });
  assert.deepEqual(Core.anchorOffset(10, 10, 20, 30, 'mc'), { dx: 5, dy: 10 });
  assert.deepEqual(Core.anchorOffset(10, 10, 20, 30, 'br'), { dx: 10, dy: 20 });
  assert.deepEqual(Core.anchorOffset(10, 10, 4, 4, 'br'), { dx: -6, dy: -6 });
});

test('rotateDims swaps on 90/270 only', () => {
  assert.deepEqual(Core.rotateDims(3, 5, 90), { w: 5, h: 3 });
  assert.deepEqual(Core.rotateDims(3, 5, -90), { w: 5, h: 3 });
  assert.deepEqual(Core.rotateDims(3, 5, 180), { w: 3, h: 5 });
});

test('History: undo/redo order, redo cleared on push', () => {
  const h = new Core.History({ maxBytes: 1000, maxCount: 10 });
  assert.equal(h.undo(), null);
  h.push({ id: 1, bytes: 1 });
  h.push({ id: 2, bytes: 1 });
  assert.equal(h.undo().id, 2);
  assert.equal(h.canRedo(), true);
  assert.equal(h.redo().id, 2);
  assert.equal(h.redo(), null);
  h.undo();
  h.push({ id: 3, bytes: 1 });
  assert.equal(h.canRedo(), false);
  assert.equal(h.undo().id, 3);
  assert.equal(h.undo().id, 1);
  assert.equal(h.canUndo(), false);
});

test('History evicts oldest by count and by bytes', () => {
  const byCount = new Core.History({ maxBytes: 1e9, maxCount: 2 });
  [1, 2, 3].forEach(id => byCount.push({ id, bytes: 1 }));
  assert.equal(byCount.undo().id, 3);
  assert.equal(byCount.undo().id, 2);
  assert.equal(byCount.undo(), null);

  const byBytes = new Core.History({ maxBytes: 100, maxCount: 100 });
  byBytes.push({ id: 1, bytes: 60 });
  byBytes.push({ id: 2, bytes: 30 });
  assert.equal(byBytes.bytes, 90);
  byBytes.push({ id: 3, bytes: 30 }); // 120 > 100 -> evict id 1
  assert.equal(byBytes.bytes, 60);
  assert.equal(byBytes.undo().id, 3);
  assert.equal(byBytes.undo().id, 2);
  assert.equal(byBytes.undo(), null);
  // a single oversize entry is still kept (newest always survives)
  byBytes.push({ id: 4, bytes: 500 });
  assert.equal(byBytes.undo().id, 4);
});

test('dragResize: edges lock one axis, corner moves both, zoom scales the delta', () => {
  // 30 screen px at zoom 2 = 15 image px
  assert.deepEqual(Core.dragResize(100, 80, 30, 50, 'e', 2, false, 16384), { w: 115, h: 80 });
  assert.deepEqual(Core.dragResize(100, 80, 30, 50, 's', 2, false, 16384), { w: 100, h: 105 });
  assert.deepEqual(Core.dragResize(100, 80, 30, -20, 'se', 1, false, 16384), { w: 130, h: 60 });
  assert.deepEqual(Core.dragResize(100, 80, 0.4, 0.6, 'se', 1, false, 16384), { w: 100, h: 81 }); // rounds
});

test('dragResize clamps to [1, max] on both sides of the boundary', () => {
  assert.deepEqual(Core.dragResize(100, 80, -99, 0, 'e', 1, false, 200), { w: 1, h: 80 });
  assert.deepEqual(Core.dragResize(100, 80, -100, 0, 'e', 1, false, 200), { w: 1, h: 80 });
  assert.deepEqual(Core.dragResize(100, 80, -98, 0, 'e', 1, false, 200), { w: 2, h: 80 });
  assert.deepEqual(Core.dragResize(100, 80, 100, 0, 'e', 1, false, 200), { w: 200, h: 80 });
  assert.deepEqual(Core.dragResize(100, 80, 101, 0, 'e', 1, false, 200), { w: 200, h: 80 });
});

test('dragResize shift on corner keeps aspect, driven by the larger relative change', () => {
  // 200x100: dx=+100 (x1.5) dominates dy=+10 (x1.1) -> 300x150
  assert.deepEqual(Core.dragResize(200, 100, 100, 10, 'se', 1, true, 16384), { w: 300, h: 150 });
  // dy=+100 (x2) dominates dx=+20 (x1.1) -> 400x200
  assert.deepEqual(Core.dragResize(200, 100, 20, 100, 'se', 1, true, 16384), { w: 400, h: 200 });
  // shift is ignored on single edges
  assert.deepEqual(Core.dragResize(200, 100, 100, 0, 'e', 1, true, 16384), { w: 300, h: 100 });
});

test('History save point: clean only at the saved state', () => {
  const h = new Core.History({ maxBytes: 1e9, maxCount: 10 });
  assert.equal(h.isClean(), true); // fresh document
  h.push({ id: 1 });
  assert.equal(h.isClean(), false);
  h.undo();
  assert.equal(h.isClean(), true); // undone back to the start
  h.redo();
  h.markSaved();
  assert.equal(h.isClean(), true);
  h.push({ id: 2 });
  assert.equal(h.isClean(), false);
  h.undo();
  assert.equal(h.isClean(), true); // back at the save
  h.undo();
  assert.equal(h.isClean(), false); // before the save
  h.redo();
  assert.equal(h.isClean(), true);
});

test('History save point becomes unreachable when its state is discarded', () => {
  const h = new Core.History({ maxBytes: 1e9, maxCount: 10 });
  h.push({ id: 1 });
  h.markSaved();
  h.undo();
  h.push({ id: 2 }); // saved state was on the redo stack and is now gone
  assert.equal(h.isClean(), false);
  h.undo();
  assert.equal(h.isClean(), false); // the base state was never saved
  // a saved base state is lost once its entries are evicted
  const e = new Core.History({ maxBytes: 1e9, maxCount: 2 });
  [1, 2, 3].forEach((id) => e.push({ id }));
  e.undo(); e.undo();
  assert.equal(e.canUndo(), false);
  assert.equal(e.isClean(), false); // the empty stack is no longer the original image
  // clear() starts a new clean document
  e.clear();
  assert.equal(e.isClean(), true);
});

test('History save point survives eviction of the saved entry (it becomes the base state)', () => {
  const h = new Core.History({ maxBytes: 1e9, maxCount: 2 });
  h.push({ id: 1 });
  h.markSaved(); // state after 1
  h.push({ id: 2 });
  h.push({ id: 3 }); // evicts 1: "after 1" is now the base state
  assert.equal(h.isClean(), false);
  h.undo(); h.undo();
  assert.equal(h.isClean(), true);
});

test('History.push reports how many old entries were evicted', () => {
  const h = new Core.History({ maxBytes: 100, maxCount: 3 });
  assert.equal(h.push({ bytes: 40 }), 0);
  assert.equal(h.push({ bytes: 40 }), 0);
  assert.equal(h.push({ bytes: 40 }), 1); // 120 > 100
  assert.equal(h.push({ bytes: 10 }), 0); // 90
  assert.equal(h.push({ bytes: 1 }), 1); // count 4 > 3
});

test('sizeError: per-side range on both sides of the boundary', () => {
  assert.equal(Core.sizeError(1, 1, 200, Infinity), null);
  assert.equal(Core.sizeError(200, 200, 200, Infinity), null);
  assert.deepEqual(Core.sizeError(201, 5, 200, Infinity), { field: 'w', reason: 'range' });
  assert.deepEqual(Core.sizeError(5, 0, 200, Infinity), { field: 'h', reason: 'range' });
  assert.deepEqual(Core.sizeError(NaN, 5, 200, Infinity), { field: 'w', reason: 'range' });
});

test('sizeError: total-pixel cap on both sides of the boundary', () => {
  // 10000 x 10000 = 1e8 exactly fits a 1e8 cap; one more row does not
  assert.equal(Core.sizeError(10000, 10000, 16384, 1e8), null);
  assert.deepEqual(Core.sizeError(10000, 10001, 16384, 1e8), { field: null, reason: 'area' });
});

test('dragResize: area cap clamps each edge, keeps aspect on the corner, never rounds over', () => {
  // 'e' at h=100, cap 10000 -> w <= 100
  assert.deepEqual(Core.dragResize(50, 100, 500, 0, 'e', 1, false, 16384, 10000), { w: 100, h: 100 });
  assert.deepEqual(Core.dragResize(100, 50, 0, 500, 's', 1, false, 16384, 10000), { w: 100, h: 100 });
  // keepAspect corner: 100x50 x4 = 400x200 = 80000 > 20000 -> factor 2 -> 200x100
  assert.deepEqual(Core.dragResize(100, 50, 300, 0, 'se', 1, true, 16384, 20000), { w: 200, h: 100 });
  // free corner 300x300 = 90000 > 10000 -> scale by 1/3 -> 100x100
  const r = Core.dragResize(100, 100, 200, 200, 'se', 1, false, 16384, 10000);
  assert.ok(r.w * r.h <= 10000, `area ${r.w * r.h}`);
  assert.deepEqual(r, { w: 100, h: 100 });
  // cap 1001 at h=10: w would round to 101 (1010 px) -> must floor to 100
  assert.deepEqual(Core.dragResize(50, 10, 60, 0, 'e', 1, false, 16384, 1005), { w: 100, h: 10 });
  // shrinking a doc that sits at the cap still works; default cap = no area limit
  assert.deepEqual(Core.dragResize(100, 100, -10, 0, 'e', 1, false, 16384, 10000), { w: 90, h: 100 });
  assert.deepEqual(Core.dragResize(100, 100, 1000, 1000, 'se', 1, false, 16384), { w: 1100, h: 1100 });
});

test('saveName: keeps writable names, swaps only known image extensions, appends otherwise', () => {
  assert.equal(Core.saveName('photo.jpg'), 'photo.jpg');
  assert.equal(Core.saveName('x.JPG'), 'x.JPG');
  assert.equal(Core.saveName('a.webp'), 'a.webp');
  assert.equal(Core.saveName('a.gif'), 'a.png');
  assert.equal(Core.saveName('scan.BMP'), 'scan.png');
  assert.equal(Core.saveName('report v1.2'), 'report v1.2.png'); // a dot is not an extension
  assert.equal(Core.saveName('my.photo'), 'my.photo.png');
  assert.equal(Core.saveName('sketch'), 'sketch.png');
});

test('saveName: sanitises like a browser download and rejects empty names', () => {
  assert.equal(Core.saveName('  a/b.png '), 'a_b.png');
  assert.equal(Core.saveName('q?:*"<>|\\.png'), 'q________.png');
  assert.equal(Core.saveName('.png'), 'untitled.png'); // just an extension: keep the type, name it
  assert.equal(Core.saveName('.gif'), 'untitled.png');
  assert.equal(Core.saveName('.JPG'), 'untitled.JPG');
  assert.equal(Core.saveName('..hidden'), 'hidden.png');
  assert.equal(Core.saveName('   '), null);
  assert.equal(Core.saveName('...'), null);
  assert.equal(Core.saveName(null), null);
});

test('stepSize: [ and ] are inverse around the 10 px boundary', () => {
  // below 10 steps by 1, from 10 up by 2
  assert.equal(Core.stepSize(9, 1), 10);
  assert.equal(Core.stepSize(10, 1), 12);
  assert.equal(Core.stepSize(12, -1), 10);
  assert.equal(Core.stepSize(11, -1), 10); // not 9: don't skip 10
  assert.equal(Core.stepSize(10, -1), 9);
  assert.equal(Core.stepSize(2, -1), 1);
  for (let s = 1; s < 60; s++) {
    const up = Core.stepSize(s, 1);
    if (s >= 10 && s % 2 === 0 || s < 10) assert.equal(Core.stepSize(up, -1), s, `down(up(${s}))`);
  }
});

test('tileParts: splits a rect into per-tile pieces that exactly cover its in-image area', () => {
  let s = 7; const rnd = (n) => ((s = Math.imul(s, 1103515245) + 12345 >>> 0) >>> 8) % n;
  for (let iter = 0; iter < 300; iter++) {
    const W = 1 + rnd(90), H = 1 + rnd(90), T = 1 + rnd(20);
    const r = { x: rnd(120) - 15, y: rnd(120) - 15, w: rnd(60), h: rnd(60) };
    const cover = new Uint8Array(W * H);
    for (const p of Core.tileParts(r, W, H, T)) {
      // the piece lies inside its tile, which lies inside the image
      assert.ok(p.x >= p.tx * T && p.x + p.w <= Math.min(W, (p.tx + 1) * T), 'x within tile');
      assert.ok(p.y >= p.ty * T && p.y + p.h <= Math.min(H, (p.ty + 1) * T), 'y within tile');
      assert.equal(p.key, p.ty * Math.ceil(W / T) + p.tx);
      assert.ok(p.w > 0 && p.h > 0);
      for (let y = p.y; y < p.y + p.h; y++) for (let x = p.x; x < p.x + p.w; x++) cover[y * W + x]++;
    }
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const want = x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h ? 1 : 0;
      assert.equal(cover[y * W + x], want, `pixel ${x},${y} of ${JSON.stringify(r)} in ${W}x${H} T=${T}`);
    }
  }
});

test('tileParts: fractional rects grow outward to whole pixels', () => {
  const parts = Core.tileParts({ x: 1.5, y: 2.2, w: 1, h: 0.1 }, 10, 10, 4);
  assert.deepEqual(parts.map(({ x, y, w, h }) => ({ x, y, w, h })), [{ x: 1, y: 2, w: 2, h: 1 }]);
});

test('History onDrop: called once for every entry that becomes unreachable, never for live ones', () => {
  const dropped = [];
  const h = new Core.History({ maxCount: 3, onDrop: (e) => dropped.push(e.id) });
  for (let id = 1; id <= 4; id++) h.push({ id, bytes: 1 }); // 1 evicted by count
  assert.deepEqual(dropped, [1]);
  h.undo(); h.undo(); // 4, 3 on the redo stack
  h.push({ id: 5, bytes: 1 }); // redo stack discarded
  assert.deepEqual(dropped, [1, 4, 3]);
  h.undo(); h.redo(); // moving between stacks drops nothing
  assert.deepEqual(dropped, [1, 4, 3]);
  h.push({ id: 6, bytes: 1 }); h.push({ id: 7, bytes: 1 }); // [2, 5, 6, 7] -> evicts 2
  assert.deepEqual(dropped, [1, 4, 3, 2]);
  h.undo(); // 7 on redo
  h.clear();
  assert.deepEqual(dropped.sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(h.canUndo() || h.canRedo(), false);
});

test('History onDrop: byte eviction drops the oldest first and keeps the newest', () => {
  const dropped = [];
  const h = new Core.History({ maxBytes: 10, onDrop: (e) => dropped.push(e.id) });
  h.push({ id: 1, bytes: 4 }); h.push({ id: 2, bytes: 4 }); h.push({ id: 3, bytes: 4 });
  assert.deepEqual(dropped, [1]);
  h.push({ id: 4, bytes: 50 }); // over budget alone: everything older goes, it stays
  assert.deepEqual(dropped, [1, 2, 3]);
  assert.equal(h.top().id, 4);
});

test('groupRects: every rect lands in exactly one group whose box contains it', () => {
  let s = 99; const rnd = (n) => ((s = Math.imul(s, 1103515245) + 12345 >>> 0) >>> 8) % n;
  for (let iter = 0; iter < 200; iter++) {
    const rects = Array.from({ length: 1 + rnd(40) }, () => ({ x: rnd(2000), y: rnd(2000), w: 1 + rnd(256), h: 1 + rnd(256) }));
    const groups = Core.groupRects(rects, 2);
    const seen = new Array(rects.length).fill(0);
    for (const g of groups) {
      let area = 0;
      for (const i of g.items) {
        const r = rects[i]; seen[i]++; area += r.w * r.h;
        assert.ok(r.x >= g.x && r.y >= g.y && r.x + r.w <= g.x + g.w && r.y + r.h <= g.y + g.h, 'inside its group');
      }
      // a group of several rects never wastes more than the slack allows
      if (g.items.length > 1) assert.ok(g.w * g.h <= 2 * area, `group box ${g.w}x${g.h} vs area ${area}`);
    }
    assert.ok(seen.every((n) => n === 1));
  }
});

test('groupRects: a dense band merges into one group, far-apart rects stay apart', () => {
  const band = Array.from({ length: 10 }, (_, i) => ({ x: i * 256, y: 512, w: 256, h: 256 }));
  assert.equal(Core.groupRects(band, 2).length, 1);
  // two touching diagonal tiles waste exactly 2x (merge); a third would waste 3x (doesn't)
  const diagonal = Array.from({ length: 10 }, (_, i) => ({ x: i * 256, y: i * 256, w: 256, h: 256 }));
  assert.equal(Core.groupRects(diagonal, 2).length, 5);
  const spaced = Array.from({ length: 10 }, (_, i) => ({ x: i * 512, y: i * 512, w: 256, h: 256 }));
  assert.equal(Core.groupRects(spaced, 2).length, 10);
  assert.deepEqual(Core.groupRects([], 2), []);
});

// The pre-optimisation flood fill, kept verbatim as an oracle.
function oracleFill(u32, w, h, x, y, color, tolerance) {
  if (x < 0 || y < 0 || x >= w || y >= h) return null;
  const target = u32[y * w + x];
  const thr = Math.round((tolerance || 0) * 255 / 100);
  if (thr === 0 && target === color) return null;
  const match = thr === 0 ? (i) => u32[i] === target : (i) => Core.colorDistance(u32[i], target) <= thr;
  const seen = new Uint8Array(w * h);
  const stack = [x, y];
  let minX = x, maxX = x, minY = y, maxY = y, changed = false;
  while (stack.length) {
    const sy = stack.pop(), sx = stack.pop();
    const row = sy * w;
    if (seen[row + sx] || !match(row + sx)) continue;
    let l = sx, r = sx;
    while (l > 0 && !seen[row + l - 1] && match(row + l - 1)) l--;
    while (r < w - 1 && !seen[row + r + 1] && match(row + r + 1)) r++;
    for (let i = l; i <= r; i++) { if (u32[row + i] !== color) changed = true; u32[row + i] = color; seen[row + i] = 1; }
    if (l < minX) minX = l; if (r > maxX) maxX = r; if (sy < minY) minY = sy; if (sy > maxY) maxY = sy;
    for (const ny of [sy - 1, sy + 1]) {
      if (ny < 0 || ny >= h) continue;
      const nrow = ny * w; let inRun = false;
      for (let i = l; i <= r; i++) { const ok = !seen[nrow + i] && match(nrow + i); if (ok && !inRun) stack.push(i, ny); inRun = ok; }
    }
  }
  return changed ? { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } : null;
}

test('floodFill and floodMask agree with the original fill on random images', () => {
  let s = 4242; const rnd = (n) => ((s = Math.imul(s, 1103515245) + 12345 >>> 0) >>> 8) % n;
  for (let iter = 0; iter < 400; iter++) {
    const w = 1 + rnd(40), h = 1 + rnd(40);
    const pal = Array.from({ length: 1 + rnd(4) }, () => Core.rgbaToU32(rnd(256), rnd(256), rnd(256), rnd(2) ? 255 : rnd(256)));
    const img = new Uint32Array(w * h).map(() => pal[rnd(pal.length)]);
    const x = rnd(w + 2) - 1, y = rnd(h + 2) - 1, tol = [0, 0, 5, 30, 60, 100][rnd(6)];
    const color = rnd(3) ? pal[rnd(pal.length)] : Core.rgbaToU32(rnd(256), rnd(256), rnd(256), 255);
    const a = img.slice(), b = img.slice();
    const ra = oracleFill(a, w, h, x, y, color, tol);
    const rb = Core.floodFill(b, w, h, x, y, color, tol);
    assert.deepEqual(rb, ra, `box, iter ${iter}`);
    assert.deepEqual(b, a, `pixels, iter ${iter}`);
    // the mask marks exactly the region the fill reached (independent of the fill colour)
    const m = Core.floodMask(img, w, h, x, y, tol);
    if (x < 0 || y < 0 || x >= w || y >= h) { assert.equal(m, null); continue; }
    const probe = img.slice(); const marker = 0x01020304 === img[y * w + x] ? 0x05060708 : 0x01020304;
    const want = new Uint8Array(w * h);
    if (!pal.includes(marker) && oracleFill(probe, w, h, x, y, marker, tol)) for (let i = 0; i < w * h; i++) want[i] = probe[i] === marker && img[i] !== marker ? 1 : 0;
    else continue; // marker collides with a palette colour: skip the mask check for this case
    assert.deepEqual(m.mask, want, `mask, iter ${iter}`);
    const xs = [], ys = [];
    want.forEach((v, i) => { if (v) { xs.push(i % w); ys.push((i / w) | 0); } });
    assert.deepEqual(m.box, { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs) + 1, h: Math.max(...ys) - Math.min(...ys) + 1 });
  }
});

// ---------- Stroke (smoothed brush path) ----------
// Flatten segments ({a, c, b}; c null = straight) into a fine polyline, independently of Core.
function flatten(segs) {
  const out = [];
  for (const { a, c, b } of segs) {
    for (let i = 0; i <= 64; i++) {
      const t = i / 64, u = 1 - t;
      out.push(c ? { x: u * u * a.x + 2 * u * t * c.x + t * t * b.x, y: u * u * a.y + 2 * u * t * c.y + t * t * b.y }
        : { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  return out;
}
function distToPolyline(p, pl) {
  let best = Infinity;
  for (let i = 1; i < pl.length; i++) {
    const a = pl[i - 1], b = pl[i], dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
    best = Math.min(best, Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy));
  }
  return best;
}
// Feed samples through a Stroke; return every segment it produced, the final tail included.
function run(samples, radius, minStep) {
  const s = new Core.Stroke(samples[0], radius, minStep);
  const segs = [];
  for (const q of samples.slice(1)) segs.push(...s.add(q));
  segs.push(...s.finish(samples[samples.length - 1]));
  return segs;
}
// A wobbly circle-ish path, ~1 px between samples.
const wobble = Array.from({ length: 400 }, (_, i) => {
  const t = i / 60;
  return { x: 100 + 60 * Math.cos(t) + 3 * Math.sin(i * 1.7), y: 100 + 40 * Math.sin(t) + 3 * Math.cos(i * 2.3) };
});

test('Stroke starts at the pointerdown point and ends exactly at the release point', () => {
  for (const r of [0, 4, 30]) {
    const segs = run(wobble, r, 0.5);
    assert.deepEqual(segs[0].a, wobble[0]);
    assert.deepEqual(segs[segs.length - 1].b, wobble[wobble.length - 1]);
  }
});

test('Stroke segments are continuous (each starts where the last ended)', () => {
  const segs = run(wobble, 4, 0.5);
  for (let i = 1; i < segs.length; i++) {
    assert.ok(Math.hypot(segs[i].a.x - segs[i - 1].b.x, segs[i].a.y - segs[i - 1].b.y) < 1e-9, 'gap at ' + i);
  }
});

test('Stroke with radius 0 passes within |second difference| / 8 of every sample', () => {
  // A midpoint-chain curve passes (X[k-1] + 6 X[k] + X[k+1]) / 8 at its control point X[k].
  const pl = flatten(run(wobble, 0, 0));
  wobble.forEach((p, k) => {
    const a = wobble[k - 1] || p, b = wobble[k + 1] || p;
    const bound = Math.hypot(a.x - 2 * p.x + b.x, a.y - 2 * p.y + b.y) / 8;
    assert.ok(distToPolyline(p, pl) <= bound + 1e-6, `sample ${k}: ${distToPolyline(p, pl)} > ${bound}`);
  });
  // and on a smooth curve that is well under a pixel
  const circle = Array.from({ length: 300 }, (_, i) => ({ x: 50 + 40 * Math.cos(i / 40), y: 50 + 40 * Math.sin(i / 40) }));
  const cl = flatten(run(circle, 0, 0));
  assert.ok(Math.max(...circle.map((p) => distToPolyline(p, cl))) < 0.01);
});

test('Stroke with radius r stays within r (+ step) of every sample', () => {
  for (const [r, step] of [[4, 0], [10, 0], [4, 1]]) {
    const pl = flatten(run(wobble, r, step));
    const worst = Math.max(...wobble.map((p) => distToPolyline(p, pl)));
    assert.ok(worst <= r + step + 0.75, `r=${r} step=${step} worst ${worst}`);
  }
});

test('Stroke smooths jitter: radius cuts the wobble the raw path has', () => {
  // Straight line with ±2 px zig-zag: the smoothed path must stay much closer to the true line.
  const zig = Array.from({ length: 200 }, (_, i) => ({ x: i, y: 50 + (i % 2 ? 2 : -2) }));
  const dev = (r) => Math.max(...flatten(run(zig, r, 0.5)).filter((p) => p.x > 30 && p.x < 170).map((p) => Math.abs(p.y - 50)));
  assert.ok(dev(0) > 0.9, 'raw keeps the zig-zag: ' + dev(0)); // |second difference| / 8 = 1
  assert.ok(dev(4) < 0.5, 'r=4: ' + dev(4));
  assert.ok(dev(8) < dev(4), 'r=8 smoother than r=4');
});

test('Stroke: a click with no movement yields no segments (the app draws a dot)', () => {
  const s = new Core.Stroke({ x: 5, y: 5 }, 4, 0.5);
  assert.deepEqual(s.add({ x: 5, y: 5 }), []);
  assert.deepEqual(s.finish({ x: 5, y: 5 }), []);
});

test('Stroke: movement that never leaves the radius still draws start → release', () => {
  const s = new Core.Stroke({ x: 5, y: 5 }, 10, 0.5);
  assert.deepEqual(s.add({ x: 8, y: 5 }), []);
  assert.deepEqual(s.add({ x: 11, y: 6 }), []);
  assert.deepEqual(s.finish({ x: 11, y: 6 }), [{ a: { x: 5, y: 5 }, c: null, b: { x: 11, y: 6 } }]);
});

test('Stroke.tail previews exactly what finish would add, without consuming state', () => {
  const s = new Core.Stroke(wobble[0], 4, 0.5);
  for (const q of wobble.slice(1, 200)) s.add(q);
  const t1 = s.tail(wobble[199]), t2 = s.tail(wobble[199]);
  assert.deepEqual(t1, t2);
  assert.deepEqual(s.finish(wobble[199]), t1);
});

test('Stroke lazy step moves the brush by distance − radius (lazy-brush rule)', () => {
  const s = new Core.Stroke({ x: 0, y: 0 }, 30, 0);
  s.add({ x: 20, y: 0 });
  assert.deepEqual(s.brush, { x: 0, y: 0 });
  s.add({ x: 40, y: 0 });
  assert.deepEqual(s.brush, { x: 10, y: 0 });
});

test('History.dropLost drops lost entries and everything only reachable through them', () => {
  const dropped = [];
  const h = new Core.History({ onDrop: (e) => dropped.push(e.id) });
  for (const id of [1, 2, 3, 4, 5]) h.push({ id, bytes: 10 });
  h.undo(); h.undo(); // undo [1,2,3], redo next 4 then 5
  h.markSaved(); // saved at 3
  const lost = new Set([2, 5]);
  assert.equal(h.dropLost((e) => lost.has(e.id)), 3); // 1, 2 (older side) and 5 (beyond it)
  assert.deepEqual(dropped.sort(), [1, 2, 5]);
  assert.deepEqual(h.undoStack.map((e) => e.id), [3]);
  assert.equal(h.redo().id, 4);
  assert.equal(h.redo(), null);
  assert.equal(h.bytes, 20);
  h.undo(); assert.ok(h.isClean()); // saved entry 3 survives
  h.undo(); assert.equal(h.undo(), null);
  assert.equal(h.dropLost(() => false), 0);
});

test('History.dropLost: the saved state becomes unreachable when it is dropped', () => {
  const h = new Core.History();
  h.markSaved(); // saved = base (null)
  h.push({ id: 1 }); h.push({ id: 2 });
  h.dropLost((e) => e.id === 1); // base can no longer be reached
  assert.ok(!h.isClean()); h.undo(); assert.ok(!h.isClean());
  const g = new Core.History();
  g.push({ id: 1 }); g.markSaved(); g.push({ id: 2 }); g.undo();
  g.dropLost((e) => e.id === 1); // the saved entry itself is gone, though we're on top of its state
  assert.ok(!g.isClean());
});

// ---------- objects ----------
const obj = (t, a, b, extra) => Object.assign({ id: 1, t, a, b, color: '#000000', alt: '#ffffff', size: 2, mode: 'outline' }, extra);

test('objBox covers the shape plus its stroke width, either drag direction', () => {
  assert.deepEqual(Core.objBox(obj('rect', { x: 10, y: 20 }, { x: 40, y: 30 })), { x: 8, y: 18, w: 35, h: 15 });
  assert.deepEqual(Core.objBox(obj('rect', { x: 40, y: 30 }, { x: 10, y: 20 })), { x: 8, y: 18, w: 35, h: 15 });
});

test('hitsObject: outline rect hits near the edge only; filled rect hits inside', () => {
  const o = obj('rect', { x: 10, y: 10 }, { x: 50, y: 50 });
  assert.ok(Core.hitsObject(o, { x: 10, y: 30 }, 0));
  assert.ok(Core.hitsObject(o, { x: 13, y: 30 }, 2)); // 3 px in: size/2 (1) + tol (2)
  assert.ok(!Core.hitsObject(o, { x: 14, y: 30 }, 2));
  assert.ok(!Core.hitsObject(o, { x: 30, y: 30 }, 2)); // the hollow middle
  assert.ok(!Core.hitsObject(o, { x: 5, y: 30 }, 2));
  assert.ok(Core.hitsObject({ ...o, mode: 'fill' }, { x: 30, y: 30 }, 0));
  assert.ok(Core.hitsObject({ ...o, mode: 'both' }, { x: 30, y: 30 }, 0));
  assert.ok(!Core.hitsObject({ ...o, mode: 'fill' }, { x: 54, y: 54 }, 2)); // outside the corner (hypot)
});

test('hitsObject: ellipse and line', () => {
  const e = obj('ellipse', { x: 0, y: 0 }, { x: 100, y: 50 }); // centre (50, 25), radii 50 x 25
  assert.ok(Core.hitsObject(e, { x: 100, y: 25 }, 0));
  assert.ok(Core.hitsObject(e, { x: 50, y: 0 }, 0));
  assert.ok(!Core.hitsObject(e, { x: 50, y: 25 }, 2)); // hollow
  assert.ok(Core.hitsObject({ ...e, mode: 'fill' }, { x: 50, y: 25 }, 0));
  assert.ok(!Core.hitsObject(e, { x: 2, y: 2 }, 2)); // the box corner is off the ellipse
  const l = obj('line', { x: 0, y: 0 }, { x: 100, y: 100 });
  assert.ok(Core.hitsObject(l, { x: 50, y: 52 }, 1)); // ~1.4 px off the line
  assert.ok(!Core.hitsObject(l, { x: 50, y: 60 }, 1));
  assert.ok(!Core.hitsObject(l, { x: 110, y: 110 }, 1)); // past the end
  assert.ok(Core.hitsObject(obj('line', { x: 5, y: 5 }, { x: 5, y: 5 }), { x: 6, y: 5 }, 0)); // a dot
  const flat = obj('ellipse', { x: 0, y: 10 }, { x: 40, y: 10 });
  assert.equal(Core.hitsObject(flat, { x: 20, y: 11 }, 0), true); // flat ellipse: a line
  assert.equal(Core.hitsObject(flat, { x: 20, y: 300 }, 2), false); // ...not everything around it
  assert.equal(Core.hitsObject(obj('ellipse', { x: 10, y: 0 }, { x: 10, y: 40 }), { x: 200, y: 20 }, 2), false);
});

test('hitObject returns the topmost hit (last in the list) or -1', () => {
  const objs = [obj('rect', { x: 0, y: 0 }, { x: 50, y: 50 }, { id: 1, mode: 'fill' }), obj('rect', { x: 20, y: 20 }, { x: 70, y: 70 }, { id: 2, mode: 'fill' })];
  assert.equal(Core.hitObject(objs, { x: 30, y: 30 }, 0), 1);
  assert.equal(Core.hitObject(objs, { x: 10, y: 10 }, 0), 0);
  assert.equal(Core.hitObject(objs, { x: 90, y: 90 }, 0), -1);
});

test('objHandles and handleAt: 8 handles for boxes (corners win), 2 ends for lines', () => {
  const o = obj('rect', { x: 40, y: 30 }, { x: 10, y: 10 });
  const hs = Core.objHandles(o);
  assert.equal(hs.length, 8);
  assert.deepEqual(hs.find((h) => h.h === 'nw'), { h: 'nw', x: 10, y: 10 });
  assert.deepEqual(hs.find((h) => h.h === 's'), { h: 's', x: 25, y: 30 });
  assert.equal(Core.handleAt(o, { x: 41, y: 31 }, 2), 'se');
  assert.equal(Core.handleAt(o, { x: 25, y: 9 }, 2), 'n');
  assert.equal(Core.handleAt(o, { x: 25, y: 20 }, 2), null);
  assert.equal(Core.handleAt(obj('rect', { x: 0, y: 0 }, { x: 2, y: 2 }), { x: 2, y: 2 }, 3), 'se'); // tiny: a corner, not an edge
  const l = obj('line', { x: 0, y: 0 }, { x: 100, y: 0 });
  assert.deepEqual(Core.objHandles(l).map((h) => h.h), ['a', 'b']);
  assert.equal(Core.handleAt(l, { x: 99, y: 1 }, 2), 'b');
});

test('resizeObj moves the dragged edges (and may flip); moveObj shifts both points', () => {
  const o = obj('rect', { x: 40, y: 30 }, { x: 10, y: 10 });
  assert.deepEqual(Core.normRect(...(({ a, b }) => [a, b])(Core.resizeObj(o, 'se', 5, 6))), { x: 10, y: 10, w: 35, h: 26 });
  assert.deepEqual(Core.normRect(...(({ a, b }) => [a, b])(Core.resizeObj(o, 'w', -4, 99))), { x: 6, y: 10, w: 34, h: 20 });
  assert.deepEqual(Core.normRect(...(({ a, b }) => [a, b])(Core.resizeObj(o, 'e', -40, 0))), { x: 0, y: 10, w: 10, h: 20 }); // past the west edge
  const l = Core.resizeObj(obj('line', { x: 0, y: 0 }, { x: 10, y: 0 }), 'a', 3, 4);
  assert.deepEqual([l.a, l.b], [{ x: 3, y: 4 }, { x: 10, y: 0 }]);
  const m = Core.moveObj(o, -10, 5);
  assert.deepEqual([m.a, m.b, m.id, o.a.x], [{ x: 30, y: 35 }, { x: 0, y: 15 }, 1, 40]); // o untouched
});

test('a small box shows only its corner handles, and a press inside it moves rather than resizes', () => {
  const tiny = obj('rect', { x: 0, y: 0 }, { x: 4, y: 4 });
  assert.deepEqual(Core.objHandles(tiny, 6).map((h) => h.h), ['nw', 'ne', 'se', 'sw']);
  assert.equal(Core.objHandles(obj('rect', { x: 0, y: 0 }, { x: 40, y: 4 }), 6).map((h) => h.h).join(), 'nw,ne,se,sw,n,s'); // wide: n and s fit
  assert.equal(Core.objHandles(tiny).length, 8); // no gap: all of them
  assert.equal(Core.handleAt(tiny, { x: 2, y: 2 }, 2.5, 6), null); // the middle: a move
  assert.equal(Core.handleAt(tiny, { x: 3.5, y: 3.5 }, 2.5, 6), 'se'); // ...but its corner is still in reach
  assert.equal(Core.handleAt(tiny, { x: 5, y: 5 }, 2.5, 6), 'se'); // outside: full reach
  const small = obj('rect', { x: 0, y: 0 }, { x: 8, y: 8 });
  assert.equal(Core.handleAt(small, { x: 4, y: -1 }, 2.5, 10), null); // a hidden n handle can't be hit
  assert.equal(Core.handleAt(small, { x: 4, y: -1 }, 2.5), 'n');
  const big = obj('rect', { x: 0, y: 0 }, { x: 100, y: 100 });
  assert.equal(Core.handleAt(big, { x: 3, y: 3 }, 4, 6), 'nw'); // a big box keeps its full reach inward
  const short = obj('line', { x: 0, y: 0 }, { x: 4, y: 0 });
  assert.equal(Core.handleAt(short, { x: 2, y: 0 }, 2.5), null); // the middle of a short line moves it
  assert.equal(Core.handleAt(short, { x: -2, y: 0 }, 2.5), 'a');
});

test('resizeObj with keep: corners and edges keep the aspect ratio, line ends snap to 45°', () => {
  const o = obj('rect', { x: 10, y: 10 }, { x: 40, y: 30 }); // 30 × 20
  const box = (x) => Core.normRect(x.a, x.b);
  assert.deepEqual(box(Core.resizeObj(o, 'se', 30, 0, true)), { x: 10, y: 10, w: 60, h: 40 });
  assert.deepEqual(box(Core.resizeObj(o, 'nw', 15, 15, true)), { x: 25, y: 20, w: 15, h: 10 });
  assert.deepEqual(box(Core.resizeObj(o, 'se', -60, -40, true)), { x: -20, y: -10, w: 30, h: 20 }); // flipped past the anchor
  assert.deepEqual(box(Core.resizeObj(o, 'e', 30, 7, true)), { x: 10, y: 0, w: 60, h: 40 }); // grows about the middle
  assert.deepEqual(box(Core.resizeObj(o, 'n', 0, -20, true)), { x: -5, y: -10, w: 60, h: 40 });
  const flat = obj('rect', { x: 0, y: 5 }, { x: 30, y: 5 });
  assert.deepEqual(box(Core.resizeObj(flat, 'se', 10, 3, true)), { x: 0, y: 5, w: 40, h: 3 }); // no ratio to keep
  const l = Core.resizeObj(obj('line', { x: 0, y: 0 }, { x: 10, y: 0 }), 'b', 0, 9, true);
  assert.deepEqual([l.a, l.b], [{ x: 0, y: 0 }, { x: 10, y: 10 }]);
  assert.deepEqual(Core.resizeObj(obj('line', { x: 0, y: 0 }, { x: 10, y: 0 }), 'a', 2, 1, true).a, { x: 2, y: 0 });
});

test('transformObj rotates and flips a shape with the image, on the pixel grid its stroke width uses', () => {
  // 100 × 50 image. Odd widths draw on pixel centres (px x maps to W-1-x), even ones on pixel edges (W-x).
  const odd = obj('rect', { x: 10, y: 5 }, { x: 30, y: 15 }, { size: 1 });
  const even = { ...odd, size: 2 };
  const box = (o) => Core.normRect(o.a, o.b);
  assert.deepEqual(box(Core.transformObj(odd, 'flipH', 100, 50)), { x: 69, y: 5, w: 20, h: 10 });
  assert.deepEqual(box(Core.transformObj(even, 'flipH', 100, 50)), { x: 70, y: 5, w: 20, h: 10 });
  assert.deepEqual(box(Core.transformObj(odd, 'flipV', 100, 50)), { x: 10, y: 34, w: 20, h: 10 });
  assert.deepEqual(box(Core.transformObj(odd, 'rotR', 100, 50)), { x: 34, y: 10, w: 10, h: 20 }); // into a 50 × 100 image
  assert.deepEqual(box(Core.transformObj(even, 'rotL', 100, 50)), { x: 5, y: 70, w: 10, h: 20 });
  for (const k of ['rotR', 'rotL', 'flipH', 'flipV']) { // four quarter turns, or two flips, are the identity
    let o = odd, W = 100, H = 50;
    for (let i = 0; i < (k.startsWith('rot') ? 4 : 2); i++) { o = Core.transformObj(o, k, W, H); if (k.startsWith('rot')) [W, H] = [H, W]; }
    assert.deepEqual([o.a, o.b], [odd.a, odd.b], k);
  }
  const l = Core.transformObj(obj('line', { x: 0, y: 0 }, { x: 9, y: 0 }, { size: 3 }), 'rotR', 10, 10);
  assert.deepEqual([l.a, l.b], [{ x: 9, y: 0 }, { x: 9, y: 9 }]); // a line keeps its direction (a to b)
});

test('scaleObj scales the geometry and the stroke width with a resize', () => {
  const o = obj('rect', { x: 10, y: 10 }, { x: 30, y: 20 }, { size: 2 });
  const s = Core.scaleObj(o, 2, 2);
  assert.deepEqual([s.a, s.b, s.size], [{ x: 20, y: 20 }, { x: 60, y: 40 }, 4]);
  const h = Core.scaleObj(o, 0.5, 0.5);
  assert.deepEqual([h.a, h.b, h.size], [{ x: 5, y: 5 }, { x: 15, y: 10 }, 1]);
  assert.equal(Core.scaleObj({ ...o, size: 1 }, 0.1, 0.1).size, 1); // never thinner than 1 px
  assert.equal(Core.scaleObj(o, 3, 1).size, 3); // uneven scale: the geometric mean (√3 × 2)
  assert.equal(o.a.x, 10); // o untouched
});

test('odd stroke widths: hit tests and handles follow the drawn stroke, half a pixel off the stored points', () => {
  // drawObj strokes an odd width on pixel centres (+0.5), so a 1 px line from (5,10) covers pixel row 10: y 10..11.
  const l = obj('line', { x: 5, y: 10 }, { x: 35, y: 10 }, { size: 1 });
  assert.deepEqual(Core.drawnObj(l).a, { x: 5.5, y: 10.5 });
  assert.equal(Core.hitsObject(l, { x: 20, y: 10.95 }, 0.25), true); // the bottom of the drawn pixel
  assert.equal(Core.hitsObject(l, { x: 20, y: 9.6 }, 0.25), false); // above it
  const r = obj('rect', { x: 5, y: 20 }, { x: 25, y: 30 }, { size: 3 });
  assert.deepEqual(Core.objHandles(r)[0], { h: 'nw', x: 5.5, y: 20.5 });
  assert.equal(Core.handleAt(r, { x: 25.5, y: 30.5 }, 0.3), 'se');
  const e = obj('rect', { x: 5, y: 20 }, { x: 25, y: 30 }, { size: 2 });
  assert.equal(Core.drawnObj(e), e); // even widths are drawn on the points themselves
});

test('zBetween: a key strictly between its neighbours, at either end, and after many inserts in one gap', () => {
  const a = Core.zBetween(null, null);
  assert.equal(typeof a, 'string');
  const top = Core.zBetween(a, null), bottom = Core.zBetween(null, a);
  assert.ok(bottom < a && a < top);
  let lo = a, hi = top;
  for (let i = 0; i < 200; i++) { const m = Core.zBetween(lo, hi); assert.ok(lo < m && m < hi, `${lo} < ${m} < ${hi}`); if (i % 2) lo = m; else hi = m; }
  let k = a; // appending stays short
  for (let i = 0; i < 5000; i++) { const n = Core.zBetween(k, null); assert.ok(n > k); k = n; }
  assert.ok(k.length <= 6, 'append key length ' + k.length);
  let b = a; // and so does prepending
  for (let i = 0; i < 2000; i++) { const n = Core.zBetween(null, b); assert.ok(n < b); b = n; }
  assert.throws(() => Core.zBetween(top, a));
});

test('dirtyTiles: each grid tile a dirty pixel falls in, once, whole (clipped at the image edge)', () => {
  const W = 1000, H = 700, T = 256;
  let s = 3;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  for (let n = 0; n < 30; n++) {
    const rects = [];
    for (let i = 0; i < 1 + n % 7; i++) rects.push({ x: rnd() * 1100 - 50, y: rnd() * 800 - 50, w: rnd() * 400, h: rnd() * 300 });
    const tiles = Core.dirtyTiles(rects, W, H, T);
    const want = new Set();
    for (const r of rects) {
      const x0 = Math.max(0, Math.floor(r.x)), y0 = Math.max(0, Math.floor(r.y)), x1 = Math.min(W, Math.ceil(r.x + r.w)), y1 = Math.min(H, Math.ceil(r.y + r.h));
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) want.add(Math.floor(y / T) * 4 + Math.floor(x / T));
    }
    assert.deepEqual(new Set(tiles.map((t) => t.key)), want);
    assert.equal(tiles.length, want.size);
    for (const t of tiles) {
      assert.equal(t.x % T, 0); assert.equal(t.y % T, 0);
      assert.equal(t.w, Math.min(T, W - t.x)); assert.equal(t.h, Math.min(T, H - t.y));
    }
  }
  assert.deepEqual(Core.dirtyTiles([], W, H, T), []);
});

test('diffObjs / applyPairs: an entry holds only what changed, and swapping it undoes and redoes', () => {
  let z = null;
  const mk = (id) => { z = Core.zBetween(z, null); return { id, z, t: 'rect', a: { x: id, y: 0 }, b: { x: id + 5, y: 5 } }; };
  const A = Array.from({ length: 50 }, (_, i) => mk(i + 1));
  const moved = { ...A[10], a: { x: 99, y: 9 } };
  const B = A.map((o) => (o.id === 11 ? moved : o)); // one edit
  let pairs = Core.diffObjs(A, B);
  assert.equal(pairs.length, 1);
  assert.deepEqual(Core.applyPairs(B, pairs), A);
  const swapped = pairs.map(([n, t]) => [t, n]);
  assert.deepEqual(Core.applyPairs(A, swapped), B);
  // add, delete and reorder in one step
  const top = mk(99);
  const C = B.filter((o) => o.id !== 3).concat(top);
  const [x, y] = [C[5], C[6]];
  C[5] = { ...y, z: x.z }; C[6] = { ...x, z: y.z };
  pairs = Core.diffObjs(B, C);
  assert.equal(pairs.length, 4); // the deleted one, the two that traded keys, the new one
  assert.deepEqual(Core.applyPairs(C, pairs), B);
  assert.deepEqual(Core.applyPairs(B, pairs.map(([n, t]) => [t, n])), C);
  assert.deepEqual(Core.diffObjs(A, A), []);
});

test('stroke, text and bitmap objects: boxes, hit tests, moves, turns and flips', () => {
  const pen = { t: 'pencil', pts: [10, 10, 20, 10], size: 3, color: '#000' };
  assert.deepEqual(Core.objBox(pen), { x: 9, y: 9, w: 13, h: 3 }); // stamps cover x 9..22, y 9..12
  assert.ok(Core.hitsObject(pen, { x: 15, y: 11 }, 0) && !Core.hitsObject(pen, { x: 15, y: 14 }, 0));
  assert.deepEqual(Core.moveObj(pen, 2, 3).pts, [12, 13, 22, 13]);
  // a turned stamp covers the pixels the turned image would: flipH maps pixel x to W - 1 - x (odd size)
  assert.deepEqual(Core.transformObj(pen, 'flipH', 100, 50).pts, [89, 10, 79, 10]);
  assert.deepEqual(Core.transformObj({ ...pen, size: 2 }, 'flipH', 100, 50).pts, [90, 10, 80, 10]);
  const four = (o) => ['rotR', 'rotR', 'rotR', 'rotR'].reduce((q, k, i) => Core.transformObj(q, k, i % 2 ? 50 : 100, i % 2 ? 100 : 50), o);
  assert.deepEqual(four(pen).pts, pen.pts);

  const br = { t: 'brush', segs: [{ a: { x: 10, y: 10 }, c: null, b: { x: 30, y: 10 } }], size: 4, color: '#000' };
  assert.deepEqual(Core.objBox(br), { x: 7, y: 7, w: 26, h: 6 });
  assert.ok(Core.hitsObject(br, { x: 20, y: 11.5 }, 0) && !Core.hitsObject(br, { x: 20, y: 13 }, 0));
  assert.deepEqual(Core.transformObj(br, 'flipH', 100, 50).segs[0].a, { x: 90, y: 10 });

  const im = { t: 'image', x: 5, y: 6, w: 10, h: 4, asset: {} };
  assert.deepEqual(Core.objBox(im), { x: 5, y: 6, w: 10, h: 4 });
  const r = Core.transformObj(im, 'rotR', 100, 50); // the 10 x 4 image turns into a 4 x 10 one
  assert.deepEqual(Core.objBox(r), { x: 40, y: 5, w: 4, h: 10 });
  assert.ok(Core.hitsObject(r, { x: 42, y: 14 }, 0) && !Core.hitsObject(r, { x: 46, y: 14 }, 0));
  assert.deepEqual(Core.objBox(four(im)), Core.objBox(im));
  const fl = { t: 'fill', x: 0, y: 0, w: 2, h: 1, asset: { bits: new Uint8Array([1]) } };
  assert.ok(Core.hitsObject(fl, { x: 0.5, y: 0.5 }, 0) && !Core.hitsObject(fl, { x: 1.5, y: 0.5 }, 0), 'a fill hits only its own pixels');
  const tx = { t: 'text', x: 10, y: 10, lines: ['ab'], fs: 20, w: 30, base: 18, color: '#000', font: 'x' };
  assert.deepEqual(Core.objBox(tx), { x: 0, y: 0, w: 50, h: 44 });
  assert.deepEqual(Core.objHandles(tx), []);
  assert.equal(Core.handleAt(tx, { x: 10, y: 10 }, 5), null);
  assert.deepEqual(Core.scaleObj(im, 2, 2).m, [2, 0, 0, 2]);
});
