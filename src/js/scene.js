import RBush from 'rbush';
import Core from './core.js';
import { base, ctx, img } from './doc.js';
import { makeCanvas, stage, vp } from './dom.js';
import { S } from './state.js';
import { drawObj } from './tools.js';

// ---------- scene ----------
// #image is a document-resolution cache of the scene: the base canvas (pixels), then every object
// in z order (docs/total-objects.md). Pan and zoom never redraw it; an edit marks the rects it
// changed (markDirty) and redraw() repaints only those, from an R-tree of the objects' boxes.
// Invariant: any sequence of redraws leaves #image byte-identical to drawing the whole scene once.
// The repaint runs in a microtask, so it lands before anything else (a frame, a test, a save) can
// read #image, and a pointermove's several marks cost one repaint.

// Geometry cache: objects are immutable, so each one's box (everything drawing it can paint) and its
// index entry are computed once and live as long as the object.
const boxes = new WeakMap(), entries = new WeakMap();
function boxOf(o) {
  let b = boxes.get(o);
  if (!b) { b = Core.objBox(o); boxes.set(o, b); }
  return b;
}
function entryOf(o) {
  let e = entries.get(o);
  if (!e) { const b = boxOf(o); e = { minX: b.x, minY: b.y, maxX: b.x + b.w, maxY: b.y + b.h, o }; entries.set(o, e); }
  return e;
}
const tree = new RBush();
const byZ = (p, q) => (p.z < q.z ? -1 : p.z > q.z ? 1 : 0);

// The object list changed from prev to next (both sorted by z): update the index and mark the boxes
// of everything that came or went. pairs ([now, then] from prev to next, see Core.diffObjs), when
// the caller has them, name the change; else same length and order (one object edited, a drag frame) is a walk
// comparing references, and anything else is found with sets.
function sceneSwap(prev, next, pairs) {
  if (prev === next) return;
  const gone = [], came = [];
  if (pairs) {
    for (const [n, t] of pairs) { if (t) gone.push(t); if (n) came.push(n); }
  } else if (prev.length === next.length) {
    for (let i = 0; i < prev.length; i++) if (prev[i] !== next[i]) { gone.push(prev[i]); came.push(next[i]); }
  } else {
    const a = new Set(prev), b = new Set(next);
    for (const o of prev) if (!b.has(o)) gone.push(o);
    for (const o of next) if (!a.has(o)) came.push(o);
  }
  if (gone.length + came.length > 0.5 * (prev.length + next.length) + 64) { // mostly new: rebuild
    tree.clear();
    tree.load(next.map(entryOf));
  } else {
    for (const o of gone) tree.remove(entryOf(o));
    for (const o of came) tree.insert(entryOf(o));
  }
  for (const o of gone) markDirty(boxOf(o));
  if (!quiet) for (const o of came) markDirty(boxOf(o));
  quiet = false;
}
// Objects whose box meets r, bottom to top.
function objsIn(r) {
  const hits = tree.search({ minX: r.x, minY: r.y, maxX: r.x + r.w, maxY: r.y + r.h }).map((e) => e.o);
  return hits.length > 1 ? hits.sort(byZ) : hits;
}
// The topmost object at p within tol (image px), or null: a box query, then the exact test.
function hitAt(p, tol) {
  const hits = objsIn({ x: p.x - tol, y: p.y - tol, w: 2 * tol, h: 2 * tol });
  for (let i = hits.length - 1; i >= 0; i--) if (Core.hitsObject(hits[i], p, tol)) return hits[i];
  return null;
}

// The stroke being drawn (pencil, eraser, brush): drawn on top of every object, through the same
// tile repaint, so its pixels are already final when it joins the scene on release (endLive()).
// Its arrays grow as the pointer moves; the caller marks each new piece dirty.
let live = null, quiet = false;
const meets = (b, r) => b.x < r.x + r.w && b.x + b.w > r.x && b.y < r.y + r.h && b.y + b.h > r.y;
const liveBox = () => Core.objBox(live);
function setLive(o) { live = o; }
// The live stroke is about to join the scene on top, as the next object added: its pixels are on
// screen already, so that add marks nothing.
function endLive() { quiet = !!live; live = null; }

let dirty = [], queued = false, redrawCount = 0;
function markDirty(r) {
  dirty.push(r);
  if (!queued) { queued = true; queueMicrotask(() => paint(false)); }
}
const markAll = () => markDirty({ x: 0, y: 0, w: img.width, h: img.height });
// Tiles still to repaint once the visible ones are done, by key. A big repaint (rotate, resize, a
// context restored, thousands of objects at once) paints what is on screen first and the rest in
// slices of about SLICE_MS between frames, so the page answers meanwhile (OpenPencil's "visible
// before overscan"). Anything that reads the cache (save, copy, the picker, flatten, the tests'
// __paint.img) calls flushRedraw() first, which finishes them all.
const later = new Map();
const SLICE_MS = 12, BIG = 64;
let laterTimer = 0;
function paint(all) {
  queued = false;
  if (dirty.length) {
    const rs = dirty;
    dirty = [];
    const tiles = Core.dirtyTiles(rs, img.width, img.height, TILE);
    if (!all && tiles.length > BIG) {
      const v = visibleRect();
      for (const t of tiles) {
        if (v && t.x < v.x + v.w && t.x + t.w > v.x && t.y < v.y + v.h && t.y + t.h > v.y) { later.delete(t.key); redrawCount++; drawTile(ctx, t); }
        else later.set(t.key, t);
      }
    } else for (const t of tiles) { later.delete(t.key); redrawCount++; drawTile(ctx, t); }
  }
  if (all) { for (const t of later.values()) { redrawCount++; drawTile(ctx, t); } later.clear(); }
  if (later.size && !laterTimer) laterTimer = setTimeout(paintLater, 0);
}
function paintLater() {
  laterTimer = 0;
  const end = performance.now() + SLICE_MS;
  for (const [k, t] of later) {
    later.delete(k);
    redrawCount++; drawTile(ctx, t);
    if (performance.now() > end) break;
  }
  if (later.size) laterTimer = setTimeout(paintLater, 0);
}
const flushRedraw = () => paint(true);
// The image px rect on screen, or null if the view can't tell (not laid out).
function visibleRect() {
  const z = S.zoom, v = vp.getBoundingClientRect(), r = stage.getBoundingClientRect();
  if (!r.width) return null;
  const L = v.left + vp.clientLeft - r.left, T = v.top + vp.clientTop - r.top;
  const x = Math.max(0, Math.floor(L / z)), y = Math.max(0, Math.floor(T / z));
  return { x, y, w: Math.ceil((L + vp.clientWidth) / z) - x, h: Math.ceil((T + vp.clientHeight) / z) - y };
}
// The cache is repainted in whole TILE x TILE tiles, each composed on a tile-sized scratch canvas
// at the tile's origin and copied in with one draw. Two Chrome facts force this (task.md, Phase 0):
//  - How the GPU anti-aliases a path depends on what else is in the same batch: after an ellipse, a
//    line's edge pixels come out multisampled (up to 100 of 255 off) and at another canvas offset
//    differently again. A tile composed from scratch the same way every time gets the same pixels
//    every time, so the cache is a pure function of the scene, whatever rect caused the repaint.
//  - At 10000², a path drawn straight into the big canvas after a drawImage into it costs ~12 ms of
//    GPU time; composed on the scratch, ~0.1 ms.
const TILE = 512; // 256 took 3.5x as long to rebuild 5k objects at 10000² (1,600 copies, 575 ms vs 163 ms)
const scratch = makeCanvas(TILE, TILE), sg = scratch.getContext('2d');
function drawTile(g, t) {
  const hits = objsIn(t);
  if (!hits.length && !(live && meets(liveBox(), t))) { // only the base: one exact copy (onto transparent, alpha too)
    g.clearRect(t.x, t.y, t.w, t.h);
    g.drawImage(base, t.x, t.y, t.w, t.h, t.x, t.y, t.w, t.h);
    return;
  }
  sg.setTransform(1, 0, 0, 1, 0, 0);
  sg.clearRect(0, 0, TILE, TILE);
  sg.drawImage(base, t.x, t.y, t.w, t.h, 0, 0, t.w, t.h);
  sg.translate(-t.x, -t.y);
  for (const o of hits) drawObj(sg, o, t);
  if (live) drawObj(sg, live, t);
  g.clearRect(t.x, t.y, t.w, t.h);
  g.drawImage(scratch, 0, 0, t.w, t.h, t.x, t.y, t.w, t.h);
}
// The whole scene drawn into a new canvas the same way, tile by tile: what the cache must equal after
// any sequence of repaints (the tests compare the two).
function freshRender() {
  const c = makeCanvas(base.width, base.height), g = c.getContext('2d');
  for (const t of Core.dirtyTiles([{ x: 0, y: 0, w: c.width, h: c.height }], c.width, c.height, TILE)) drawTile(g, t);
  return c;
}

export { boxOf, endLive, freshRender, setLive, flushRedraw, hitAt, markAll, markDirty, objsIn, redrawCount, sceneSwap };
