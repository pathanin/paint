const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../js/core.js');

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
