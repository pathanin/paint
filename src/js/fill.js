import Core from './core.js';
import { base, bctx as ctx, hist, pushHist } from './doc.js';
import { hexToU32 } from './dom.js';
import { startWorker, used, workerCall } from './libs.js';
import { markDirty } from './scene.js';
import { S, sel } from './state.js';
import { op } from './tiles.js';
import { flash } from './toast.js';

// ---------- fill ----------
// The flood fill and its soft edge (Core.fillPlan) run in fill-worker.js, so a big fill (~0.9 s at
// 100 MP) doesn't freeze the page; only reading the pixels and putting the box back stay here. If
// the worker can't start or fails, the same function runs on the main thread. The page stays live
// meanwhile, so a fill whose image changed before it finished is dropped, like a resize.
let worker = null; // created on the first fill; false once it has failed
let filling = null; // the running fill's promise (for the tests)
function doFill(p, color) {
  const W = base.width, H = base.height;
  if (p.x < 0 || p.y < 0 || p.x >= W || p.y >= H) return;
  if (filling) { flash('Still filling'); return; }
  const c = hexToU32(color);
  // Exact-match fill on a pixel that already has the colour changes nothing: skip the full readback.
  if (Math.round(S.tolerance * 255 / 100) === 0 && new Uint32Array(ctx.getImageData(p.x, p.y, 1, 1).data.buffer)[0] === c) return;
  filling = runFill(p, c, S.tolerance).finally(() => { filling = null; });
}
async function runFill(p, c, tolerance) {
  const src = base, top = hist.top(), openOp = op, float = sel && sel.float;
  const W = src.width, H = src.height;
  // Every way pixels change shows here: a stroke opens an op, a lift makes a float, crop/resize/New
  // swap the base, everything else commits to history. Drags that write no pixels (pan, marquee, a shape
  // before release) don't count, so panning around while a big fill runs keeps it.
  const changed = () => base !== src || hist.top() !== top || op !== openOp || (sel && sel.float) !== float;
  const job = (buf) => ({ buf, w: W, h: H, x: p.x, y: p.y, color: c, tolerance });
  let shown = false; // say so only if it takes a noticeable time
  const slow = setTimeout(() => { shown = true; flash('Filling…'); }, 300);
  try {
    let res = null;
    if (worker !== false) {
      const buf = ctx.getImageData(0, 0, W, H).data.buffer;
      try {
        worker = worker || startWorker('fill-worker');
        res = await workerCall(worker, job(buf), [buf]);
        used.fill = 'worker';
      } catch {
        if (worker) worker.terminate();
        worker = false;
      }
    }
    if (!res) { // no worker: the same work here (the buffer sent to a failed worker is gone)
      if (changed()) return dropped();
      const buf = ctx.getImageData(0, 0, W, H).data.buffer;
      res = { buf, plan: Core.fillPlan(new Uint32Array(buf), W, H, p.x, p.y, c, tolerance) };
      used.fill = 'main';
    }
    const { buf, plan } = res;
    if (!plan) { if (shown) flash('Nothing to fill'); return; }
    if (changed()) return dropped();
    const box = plan.box;
    ctx.putImageData(new ImageData(new Uint8ClampedArray(buf), W, H), 0, 0, box.x, box.y, box.w, box.h);
    markDirty(box);
    const before = new ImageData(new Uint8ClampedArray(plan.before.buffer), box.w, box.h);
    pushHist({ type: 'fill', x: box.x, y: box.y, before, bits: plan.bits, color: c, ek: plan.ek, ev: plan.ev, undone: false, bytes: before.data.length + plan.bits.length + plan.ek.length * 8 });
    if (shown) flash('Filled');
  } finally {
    clearTimeout(slow);
  }
}
const dropped = () => flash('Fill cancelled: the image changed while it ran', true);
// Undo/redo of a fill entry: put back the pixels before, or recompute the filled ones.
function applyFill(e) {
  markDirty({ x: e.x, y: e.y, w: e.before.width, h: e.before.height });
  // Redo: the box holds exactly the before pixels, so painting the mask's runs in the (opaque) fill
  // colour, then each edge pixel in its (opaque) colour, gives the after state. Path fills of
  // whole-pixel rects are exact and cost no upload.
  const rgb = (v) => `rgb(${v & 255}, ${(v >>> 8) & 255}, ${(v >>> 16) & 255})`;
  if (e.undone && (e.color >>> 24) === 255 && e.ek.length <= 100000 && e.ev.every((v) => (v >>> 24) === 255)) {
    const path = fillRuns(e.bits, e.before.width, e.before.height, e.x, e.y);
    if (path) {
      ctx.fillStyle = rgb(e.color);
      ctx.fill(path);
      const byColor = new Map(), w = e.before.width;
      e.ek.forEach((k, j) => {
        if (!byColor.has(e.ev[j])) byColor.set(e.ev[j], new Path2D());
        byColor.get(e.ev[j]).rect(e.x + k % w, e.y + (k / w | 0), 1, 1);
      });
      for (const [v, px] of byColor) { ctx.fillStyle = rgb(v); ctx.fill(px); }
      e.undone = false;
      return;
    }
  }
  let im = e.before;
  if (e.undone) {
    im = new ImageData(new Uint8ClampedArray(e.before.data), e.before.width, e.before.height);
    const u32 = new Uint32Array(im.data.buffer);
    for (let k = 0; k < u32.length; k++) if (e.bits[k >> 3] & (1 << (k & 7))) u32[k] = e.color;
    e.ek.forEach((k, j) => { u32[k] = e.ev[j]; });
  }
  ctx.putImageData(im, e.x, e.y);
  e.undone = !e.undone;
}
// The set bits of a w x h row-major mask as a Path2D of rects at (ox, oy): one per run of set bits
// in a row, merged down while the next row has the same run. Null past 100k rects (noise-like
// masks), where putting the pixels is cheaper.
function fillRuns(bits, w, h, ox, oy) {
  const path = new Path2D();
  let open = new Map(), n = 0; // run start x -> {x, y, w} still growing downwards
  const flush = (r) => { path.rect(ox + r.x, oy + r.y, r.w, r.h); n++; };
  for (let y = 0; y < h; y++) {
    const next = new Map(), row = y * w, end = row + w;
    const run = (x0, x1) => {
      const r = open.get(x0);
      if (r && r.w === x1 - x0) { r.h++; open.delete(x0); next.set(x0, r); }
      else next.set(x0, { x: x0, y, w: x1 - x0, h: 1 });
    };
    let start = -1;
    for (let k = row; k < end;) {
      if ((k & 7) === 0 && k + 8 <= end) { // whole bytes: skip or extend 8 at a time
        const b = bits[k >> 3];
        if (b === 0) { if (start >= 0) { run(start - row, k - row); start = -1; } k += 8; continue; }
        if (b === 255) { if (start < 0) start = k; k += 8; continue; }
      }
      if (bits[k >> 3] & (1 << (k & 7))) { if (start < 0) start = k; }
      else if (start >= 0) { run(start - row, k - row); start = -1; }
      k++;
    }
    if (start >= 0) run(start - row, end - row);
    for (const r of open.values()) flush(r);
    if (n > 100000) return null;
    open = next;
  }
  for (const r of open.values()) flush(r);
  return path;
}

export { applyFill, doFill, filling };
