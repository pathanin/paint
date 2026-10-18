import RBush from 'rbush';
import Core from './core.js';
import { base, ctx, img } from './doc.js';
import { makeCanvas, stage, vp } from './dom.js';
import { S } from './state.js';
import { drawObj, drawPieces, segBox, stampBox, stampPieces } from './tools.js';

// ---------- scene ----------
// #image is a document-resolution cache of the scene: the base canvas (pixels), then every object
// in z order (docs/total-objects.md). Pan and zoom never redraw it; an edit marks the rects it
// changed (markDirty) and redraw() repaints only those, from an R-tree of the objects' boxes.
// Invariant: any sequence of redraws leaves #image byte-identical to drawing the whole scene once.
// The repaint runs in a microtask, and a pointermove's several marks cost one repaint. A big one may
// be painted later (see `later` and the fence below), so whatever reads #image (a save, a copy, the
// picker, a fill, the tests) goes through composite() / flushRedraw(), which finishes it first.

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
  prev = prev.filter((o) => !o.locked); next = next.filter((o) => !o.locked); // the base is drawn as the base canvas
  if (pairs) {
    for (const [n, t] of pairs) { if (t && !t.locked) gone.push(t); if (n && !n.locked) came.push(n); }
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
// Its arrays grow as the pointer moves, and the caller calls growLive() after adding to them. Each
// new piece (a stamp line, a brush segment) is filed under the tiles it reaches, so repainting a tile
// draws only its pieces however long the stroke gets: the same pieces, in the same order, that
// drawObj picks for that tile once the stroke is an object (tools.js stampBox / segBox), so its
// pixels don't change when it joins.
let live = null, liveAt = null, liveN = 0, quiet = false; // liveAt: tile key -> pieces; liveN: pieces filed
const meets = (b, r) => b.x < r.x + r.w && b.x + b.w > r.x && b.y < r.y + r.h && b.y + b.h > r.y;
function setLive(o) { live = o; liveAt = new Map(); liveN = 0; growLive(); }
function growLive() {
  const o = live;
  const file = (piece, b) => {
    markDirty(b);
    for (const t of Core.dirtyTiles([b], img.width, img.height, TILE)) {
      if (!meets(b, t)) continue;
      let k = liveAt.get(t.key);
      if (!k) liveAt.set(t.key, (k = []));
      if (k[k.length - 1] !== piece) k.push(piece);
    }
  };
  if (o.segs) for (; liveN < o.segs.length; liveN++) file(o.segs[liveN], segBox(o, o.segs[liveN]));
  else {
    const n = stampPieces(o);
    for (let i = liveN; i < n; i += 2) file(i, stampBox(o, i));
    liveN = o.pts.length > 2 ? n : 0; // a lone point is filed again once it becomes a line (its box grows)
  }
}
// The live stroke is about to join the scene on top, as the next object added: its pixels are on
// screen already, so that add marks nothing.
function endLive() { quiet = !!live; live = null; liveAt = null; }

let dirty = [], queued = false, redrawCount = 0;
function markDirty(r) {
  dirty.push(r);
  if (!queued) { queued = true; queueMicrotask(() => paint(false)); }
}
const markAll = () => markDirty({ x: 0, y: 0, w: img.width, h: img.height });
// Tiles still to repaint once the visible ones are done, by key. A big repaint (rotate, resize, a
// context restored, thousands of objects at once) paints what is on screen first and the rest in
// slices between frames, so the page answers meanwhile (OpenPencil's "visible before overscan").
// Anything that reads the cache (save, copy, the picker, flatten, the tests' __paint.img) calls
// flushRedraw() first, which finishes them all.
// The GPU, not the main thread, is what a big repaint costs: at 10000², 360 tiles take ~2 ms to
// queue and ~50 ms to draw, and a frame waits for everything queued before it. So once over BIG tiles
// are queued, a fence (fenceAfter()) marks their end, and until it passes, another big repaint is
// held and slices wait: held arrows with 5k objects selected repaint once per GPU
// round, with whatever came meanwhile, instead of stacking 50 ms per press. Small repaints (a
// stroke, one object) never wait.
const later = new Map();
const SLICE_MS = 12, BIG = 64;
let laterTimer = 0, fence = null, held = []; // held: rects of big repaints waiting for the fence
function paint(all) {
  queued = false;
  if (all && held.length) { dirty.push(...held); held = []; }
  const now = [];
  if (dirty.length) {
    const rs = dirty;
    dirty = [];
    const tiles = Core.dirtyTiles(rs, img.width, img.height, TILE);
    if (!all && tiles.length > BIG && fence) { held.push(...rs); return; } // repainted when it passes
    if (!all && tiles.length > BIG) {
      const v = visibleRect();
      for (const t of tiles) {
        if (v && t.x < v.x + v.w && t.x + t.w > v.x && t.y < v.y + v.h && t.y + t.h > v.y) { later.delete(t.key); now.push(t); }
        else later.set(t.key, t);
      }
    } else for (const t of tiles) { later.delete(t.key); now.push(t); }
  }
  if (all) { now.push(...later.values()); later.clear(); }
  redrawCount += now.length;
  drawTiles(ctx, now);
  if (now.length > BIG) fenceAfter();
  if (later.size && !laterTimer && !fence) laterTimer = setTimeout(paintLater, 0);
}
function paintLater() {
  laterTimer = 0;
  if (fence) return; // fencePassed() comes back
  const end = performance.now() + SLICE_MS;
  let n = 0;
  while (later.size && n < BIG && performance.now() <= end) {
    const batch = [];
    for (const [k, t] of later) { later.delete(k); batch.push(t); if (batch.length === POOL) break; }
    n += batch.length;
    drawTiles(ctx, batch);
  }
  redrawCount += n;
  fenceAfter();
  if (later.size && !fence) laterTimer = setTimeout(paintLater, 0);
}
// A WebGL2 fence after the work queued on #image so far: a 1 px copy of #image into a small canvas,
// uploaded to a texture (GPU to GPU, so ordered after it), then fenceSync. Polling it never blocks.
// Without WebGL2 there is no fence, and nothing waits. In WebKit the upload itself waits for the GPU
// (~125 ms on the main thread after a 10000² repaint, measured in Playwright WebKit), which is the
// stall the fence is there to avoid: two slow uploads in a row turn it off for the session.
let gl = null, tiny = null, tex = null, slowUploads = 0;
function fenceAfter() {
  if (gl === null) {
    try { gl = new OffscreenCanvas(1, 1).getContext('webgl2') || false; } catch { gl = false; }
    if (gl) { tiny = makeCanvas(1, 1).getContext('2d'); tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex); }
  }
  if (!gl || slowUploads >= 2 || gl.isContextLost()) return;
  const t0 = performance.now();
  tiny.clearRect(0, 0, 1, 1);
  tiny.drawImage(img, 0, 0, 1, 1, 0, 0, 1, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, tiny.canvas);
  slowUploads = performance.now() - t0 > 8 ? slowUploads + 1 : 0;
  if (slowUploads >= 2) return; // a fence still pending passes as usual
  const f = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
  if (!f) return;
  gl.flush();
  if (fence) { gl.deleteSync(fence.f); fence.f = f; fence.t = performance.now(); } // its poll goes on
  else { fence = { f, t: performance.now() }; setTimeout(pollFence, 2); }
}
function pollFence() {
  const f = fence;
  if (!f) return;
  // 2 s: a fence that never passes (a lost context) mustn't stop the repaint for good
  if (!gl.isContextLost() && gl.getSyncParameter(f.f, gl.SYNC_STATUS) !== gl.SIGNALED && performance.now() - f.t < 2000) { setTimeout(pollFence, 2); return; }
  if (!gl.isContextLost()) gl.deleteSync(f.f);
  fence = null;
  if (held.length) { dirty.push(...held); held = []; paint(false); }
  else if (later.size && !laterTimer) laterTimer = setTimeout(paintLater, 0);
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
// A pool of scratch canvases, filled in turn and then copied in together. With one scratch, each tile's
// copy has to land before the next tile can clear it, so the GPU alternates between the scratch and
// #image tile by tile; at 10000², 360 tiles took ~135 ms of GPU time that way, and ~65 ms in runs of 16.
// Every tile goes through a scratch, even one with only the base: a 512² copy from the big base into
// the big #image costs about as much as composing one (both canvases huge).
const POOL = 16;
const pool = Array.from({ length: POOL }, () => { const c = makeCanvas(TILE, TILE); return { c, g: c.getContext('2d') }; });
function compose(s, t) {
  const sg = s.g, hits = objsIn(t), lv = live && liveAt.get(t.key);
  sg.setTransform(1, 0, 0, 1, 0, 0);
  sg.clearRect(0, 0, TILE, TILE);
  sg.drawImage(base, t.x, t.y, t.w, t.h, 0, 0, t.w, t.h);
  if (!hits.length && !lv) return;
  sg.translate(-t.x, -t.y);
  for (const o of hits) drawObj(sg, o, t);
  if (lv) drawPieces(sg, live, lv);
}
function drawTiles(g, tiles) {
  for (let i = 0; i < tiles.length; i += POOL) {
    const run = tiles.slice(i, i + POOL);
    run.forEach((t, j) => compose(pool[j], t));
    run.forEach((t, j) => { g.clearRect(t.x, t.y, t.w, t.h); g.drawImage(pool[j].c, 0, 0, t.w, t.h, t.x, t.y, t.w, t.h); });
  }
}
// The whole scene drawn into a new canvas the same way, tile by tile: what the cache must equal after
// any sequence of repaints (the tests compare the two).
function freshRender() {
  const c = makeCanvas(base.width, base.height), g = c.getContext('2d');
  drawTiles(g, Core.dirtyTiles([{ x: 0, y: 0, w: c.width, h: c.height }], c.width, c.height, TILE));
  return c;
}

export { boxOf, endLive, freshRender, growLive, setLive, flushRedraw, hitAt, markAll, markDirty, objsIn, redrawCount, sceneSwap };
