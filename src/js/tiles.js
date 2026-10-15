import Core from './core.js';
import { ctx, hist, img, pushHist } from './doc.js';
import { makeCanvas } from './dom.js';
import { drag, sel, setSel } from './state.js';
import { flash } from './toast.js';
import { requestRender, updateChrome } from './view.js';

// ---------- undo tiles ----------
// Undo is copy-on-write. Every edit calls touch(rect) *before* drawing into rect; the first touch
// of each TILE x TILE tile saves its pixels. endOp() keeps only the touched part of each tile.
// So no op copies the whole image, and a long diagonal stroke stores a thin band of tiles, not
// its whole bounding box. Tiles are saved on the GPU (drawImage, no readback):
//  - strokes (beginOp(true)): each tile into a small canvas of its own, as the stroke reaches it
//    (past 512 live tile canvases, 128 MB, they are read back mid-stroke to bound GPU memory);
//  - everything else: one canvas per contiguous block of each touch()'s tiles (snapshot()).
// The stored pixels stay on the GPU until an idle callback reads them back (toData()); undo/redo
// before that draws them straight back.
// Two Chrome gotchas shape this (measured on a 10000 px canvas):
//  - No readback (getImageData) of the document, or of anything drawn from it, while a stroke is in
//    progress: each one costs ~10 ms per frame, as the next frame then copies the whole canvas.
//  - No reusing snapshot canvases after they were read back: Chrome may move a canvas that was
//    read to the CPU, and then drawing the document into it is a readback too. So snapshot
//    canvases are fresh, and freed (width 0) once nothing refers to them.
// A tile or part {w, h} holds its pixels either as data (ImageData, w x h) or as cv/cx/cy: the
// block at (cx, cy) in canvas cv, which counts its users in cv.refs.
const TILE = 256;
let op = null;     // the current undoable region op: {tiles} (see touch())
function beginOp(stroke) {
  dropOp();
  op = { tiles: new Map(), stroke: !!stroke, live: 0 };
}
function release(t) {
  if (t.cv && --t.cv.refs === 0) t.cv.width = 0;
  t.cv = null;
}
// Snapshot the document's pixels under each item {x, y, w, h} without a readback; sets each item's
// cv/cx/cy. Chrome makes each drawImage to or from a large canvas costly (1600 tile draws ~130 ms
// at 100 MP, one whole-image draw ~15 ms), so items that tile a rectangle share one canvas.
function snapshot(items) {
  for (const g of Core.groupRects(items, 1)) {
    const cv = makeCanvas(g.w, g.h);
    cv.addEventListener('contextlost', gpuLost);
    cv.getContext('2d').drawImage(img, g.x, g.y, g.w, g.h, 0, 0, g.w, g.h); // onto transparent: exact, alpha too
    cv.refs = g.items.length;
    for (const i of g.items) { const t = items[i]; t.cv = cv; t.cx = t.x - g.x; t.cy = t.y - g.y; }
  }
}
// Group items by the canvas holding them: [[cv, items]].
function byCanvas(items) {
  const m = new Map();
  for (const t of items) { if (!m.has(t.cv)) m.set(t.cv, []); m.get(t.cv).push(t); }
  return [...m];
}
// Write the GPU-held block of each item (or the part (sx, sy, w, h) of it given by rect(t)) back to
// the document: one draw per canvas when its items tile a rectangle at matching offsets.
function drawBack(items, rect) {
  for (const [cv, ts] of byCanvas(items)) {
    const rs = ts.map((t) => rect(t));
    const x0 = Math.min(...rs.map((r) => r.x)), y0 = Math.min(...rs.map((r) => r.y));
    const x1 = Math.max(...rs.map((r) => r.x + r.w)), y1 = Math.max(...rs.map((r) => r.y + r.h));
    const area = rs.reduce((n, r) => n + r.w * r.h, 0), dx = rs[0].sx - rs[0].x, dy = rs[0].sy - rs[0].y;
    const one = area === (x1 - x0) * (y1 - y0) && rs.every((r) => r.sx - r.x === dx && r.sy - r.y === dy);
    for (const r of one ? [{ x: x0, y: y0, w: x1 - x0, h: y1 - y0, sx: x0 + dx, sy: y0 + dy }] : rs) {
      ctx.clearRect(r.x, r.y, r.w, r.h);
      ctx.drawImage(cv, r.sx, r.sy, r.w, r.h, r.x, r.y, r.w, r.h);
    }
  }
}
function touch(x, y, w, h) {
  if (!op) return;
  const fresh = [];
  for (const p of Core.tileParts({ x, y, w, h }, img.width, img.height, TILE)) {
    const t = op.tiles.get(p.key);
    if (t) {
      t.x0 = Math.min(t.x0, p.x); t.y0 = Math.min(t.y0, p.y);
      t.x1 = Math.max(t.x1, p.x + p.w); t.y1 = Math.max(t.y1, p.y + p.h);
      continue;
    }
    const ox = p.tx * TILE, oy = p.ty * TILE;
    const t2 = { cv: null, cx: 0, cy: 0, data: null, x: ox, y: oy, w: Math.min(TILE, img.width - ox), h: Math.min(TILE, img.height - oy), x0: p.x, y0: p.y, x1: p.x + p.w, y1: p.y + p.h };
    op.tiles.set(p.key, t2);
    fresh.push(t2);
  }
  if (!fresh.length) return;
  if (!op.stroke) { snapshot(fresh); queueToData(fresh); return; } // a float can keep an op open for long
  for (const t of fresh) {
    if (op.live >= 512) { toData([...op.tiles.values()].filter((x) => x.cv)); op.live = 0; }
    op.live++;
    snapshot([t]);
  }
}
// extra: fields for the entry (flattenObjs() adds the object list it baked).
function endOp(extra) {
  const o = op; op = null;
  if (!o || !o.tiles.size) { if (extra) pushHist({ type: 'obj', bytes: 0, ...extra }); return; }
  const parts = [];
  let bytes = 0;
  for (const t of o.tiles.values()) {
    const w = t.x1 - t.x0, h = t.y1 - t.y0, dx = t.x0 - t.x, dy = t.y0 - t.y;
    pendingParts.delete(t); // its canvas ref moves to the part
    const part = { x: t.x0, y: t.y0, w, h, cv: t.cv, cx: t.cx + dx, cy: t.cy + dy, data: t.data };
    if (t.data && (w !== t.w || h !== t.h)) { part.data = new ImageData(w, h); blit(t.data, dx, dy, part.data, 0, 0, w, h); }
    parts.push(part);
    bytes += w * h * 4; // a part on the GPU may sit in a larger tile until toData() crops it
  }
  pushHist({ type: 'region', parts, bytes, ...extra });
  queueToData(parts);
}
// Items on the GPU -> data (w x h ImageData each). Each readback has a large fixed cost, so a
// canvas holding many items is read once over their bounding box, and canvases holding one item
// each (stroke tiles) are first drawn into atlases of up to 16 x 16 tiles, each read once.
function toData(items) {
  const singles = [];
  for (const [cv, ts] of byCanvas(items)) {
    if (cv.refs === 1) { singles.push(...ts); continue; }
    const x0 = Math.min(...ts.map((t) => t.cx)), y0 = Math.min(...ts.map((t) => t.cy));
    const all = cv.getContext('2d').getImageData(x0, y0, Math.max(...ts.map((t) => t.cx + t.w)) - x0, Math.max(...ts.map((t) => t.cy + t.h)) - y0);
    for (const t of ts) {
      t.data = new ImageData(t.w, t.h);
      blit(all, t.cx - x0, t.cy - y0, t.data, 0, 0, t.w, t.h);
      release(t);
    }
  }
  for (let i = 0; i < singles.length; i += 256) {
    const batch = singles.slice(i, i + 256);
    const cols = Math.ceil(Math.sqrt(batch.length)), rows = Math.ceil(batch.length / cols);
    const atlas = makeCanvas(cols * TILE, rows * TILE), g = atlas.getContext('2d');
    batch.forEach((t, j) => { g.drawImage(t.cv, t.cx, t.cy, t.w, t.h, (j % cols) * TILE, Math.floor(j / cols) * TILE, t.w, t.h); release(t); });
    const all = g.getImageData(0, 0, atlas.width, atlas.height);
    atlas.width = 0;
    batch.forEach((t, j) => {
      t.data = new ImageData(t.w, t.h);
      blit(all, (j % cols) * TILE, Math.floor(j / cols) * TILE, t.data, 0, 0, t.w, t.h);
    });
  }
}
// Read history parts (and the tiles of an open op, e.g. under a floating selection) back to the CPU
// when the app is idle, up to 256 parts (~64 MB) per callback, never during a pointer gesture (see
// the gotchas above). It starts a second after the last history change, so a run of undo/redo
// doesn't pay a readback per step. Until then a GPU context loss can take them: see gpuLost().
const pendingParts = new Set();
let toDataGen = 0;
const onIdle = window.requestIdleCallback || ((f) => setTimeout(f, 0));
function queueToData(parts) {
  for (const p of parts) if (p.cv) pendingParts.add(p);
  if (!pendingParts.size) return;
  const gen = ++toDataGen;
  setTimeout(() => onIdle(() => idleToData(gen)), 1000);
}
function idleToData(gen) {
  if (gen !== toDataGen) return;
  if (drag) { queueToData([]); return; }
  const batch = [];
  for (const p of pendingParts) {
    pendingParts.delete(p);
    if (p.cv) batch.push(p);
    if (batch.length === 256) break;
  }
  toData(batch);
  if (pendingParts.size) onIdle(() => idleToData(gen));
}
function flushToData() { const all = [...pendingParts].filter((p) => p.cv); pendingParts.clear(); toData(all); }
// The GPU context was lost (driver reset, GPU process crash): every canvas's pixels are gone, so
// pixels not yet read back are too. Drop the undo steps that held any (doc entries hold a canvas;
// fill entries and read-back parts are safe), and those only reachable through them, rather than
// let undo paint blanks. An open op that can't be restored is abandoned along with its float.
function gpuLost() {
  const onGpu = (e) => e.type === 'doc' || (e.type === 'region' && e.parts.some((p) => p.cv));
  let n = hist.dropLost(onGpu);
  if (op && [...op.tiles.values()].some((t) => t.cv)) {
    dropOp(); n++;
    if (sel && sel.float) setSel(null);
  }
  pendingParts.clear();
  if (!n) return;
  flash('Graphics were reset; some undo steps were lost');
  updateChrome();
  requestRender();
}
// Abandon the current op. With restore, first put back every pixel it changed.
function dropOp(restore) {
  const o = op; op = null;
  if (!o) return;
  const tiles = [...o.tiles.values()];
  if (restore) {
    drawBack(tiles.filter((t) => t.cv), (t) => ({ x: t.x0, y: t.y0, w: t.x1 - t.x0, h: t.y1 - t.y0, sx: t.cx + t.x0 - t.x, sy: t.cy + t.y0 - t.y }));
    for (const t of tiles) if (t.data) ctx.putImageData(t.data, t.x, t.y, t.x0 - t.x, t.y0 - t.y, t.x1 - t.x0, t.y1 - t.y0);
  }
  tiles.forEach(release);
}
// Copy a w x h block between ImageData buffers (u32 rows).
function blit(src, sx, sy, dst, dx, dy, w, h) {
  const s32 = new Uint32Array(src.data.buffer), d32 = new Uint32Array(dst.data.buffer);
  for (let r = 0; r < h; r++) d32.set(s32.subarray((sy + r) * src.width + sx, (sy + r) * src.width + sx + w), (dy + r) * dst.width + dx);
}
// Swap a region entry's pixels with the canvas, with no readback: snapshot what's there now into
// fresh canvases (GPU), then write the stored pixels, then read the snapshot back at idle.
// One copy of the pixels at a time, so the entry's bytes don't change.
function swapParts(parts) {
  const old = parts.map((p) => ({ x: p.x, y: p.y, w: p.w, h: p.h, cv: p.cv, cx: p.cx, cy: p.cy, data: p.data }));
  snapshot(parts);
  drawBack(old.filter((o) => o.cv), (o) => ({ x: o.x, y: o.y, w: o.w, h: o.h, sx: o.cx, sy: o.cy }));
  for (const o of old) { if (o.data) ctx.putImageData(o.data, o.x, o.y); release(o); }
  for (const p of parts) p.data = null;
  queueToData(parts);
}

export { beginOp, blit, dropOp, endOp, flushToData, gpuLost, op, pendingParts, release, swapParts, TILE, touch };
