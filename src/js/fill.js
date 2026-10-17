import Core from './core.js';
import { makeAsset } from './assets.js';
import { base, ctx, img } from './doc.js';
import { hexToU32, makeCanvas } from './dom.js';
import { startWorker, used, workerCall } from './libs.js';
import { addObj, composite, objVer } from './objects.js';
import { S, sel } from './state.js';
import { flash } from './toast.js';

// ---------- fill ----------
// The flood fill and its soft edge (Core.fillPlan) run in fill-worker.js, so a big fill (~0.9 s at
// 100 MP) doesn't freeze the page; only reading the pixels and building the result stay here. If
// the worker can't start or fails, the same function runs on the main thread. A fill reads what is
// seen (every object) and becomes a fill object on top: a bitmap of the pixels it changed, frozen
// at fill time (decision 5a). The page stays live meanwhile, so a fill whose picture changed before
// it finished is dropped, like a resize.
let worker = null; // created on the first fill; false once it has failed
let filling = null; // the running fill's promise (for the tests)
function doFill(p, color) {
  const src = composite(), W = src.width, H = src.height;
  if (p.x < 0 || p.y < 0 || p.x >= W || p.y >= H) return;
  if (filling) { flash('Still filling'); return; }
  const c = hexToU32(color);
  // Exact-match fill on a pixel that already has the colour changes nothing: skip the full readback.
  if (Math.round(S.tolerance * 255 / 100) === 0 && new Uint32Array(ctx.getImageData(p.x, p.y, 1, 1).data.buffer)[0] === c) return;
  filling = runFill(p, c, S.tolerance).finally(() => { filling = null; });
}
async function runFill(p, c, tolerance) {
  const src = base, v0 = objVer, float = sel && sel.float;
  const W = img.width, H = img.height;
  // Every way the picture changes shows here: an object added, changed or removed bumps objVer, a
  // lift makes a float, crop/resize/New swap the base. Drags that change nothing yet (pan, marquee,
  // a stroke still being drawn: it lands on top later) don't count.
  const changed = () => base !== src || objVer !== v0 || (sel && sel.float) !== float;
  const job = (buf) => ({ buf, w: W, h: H, x: p.x, y: p.y, color: c, tolerance });
  const read = () => composite().getContext('2d').getImageData(0, 0, W, H).data.buffer;
  let shown = false; // say so only if it takes a noticeable time
  const slow = setTimeout(() => { shown = true; flash('Filling…'); }, 300);
  try {
    let res = null;
    if (worker !== false) {
      const buf = read();
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
      const buf = read();
      res = { buf, plan: Core.fillPlan(new Uint32Array(buf), W, H, p.x, p.y, c, tolerance) };
      used.fill = 'main';
    }
    const { buf, plan } = res;
    if (!plan) { if (shown) flash('Nothing to fill'); return; }
    if (changed()) return dropped();
    addObj(fillObj(new Uint32Array(buf), W, { ...plan, color: c }), { keepSel: true });
    if (shown) flash('Filled');
  } finally {
    clearTimeout(slow);
  }
}
const dropped = () => flash('Fill cancelled: the image changed while it ran', true);
// The fill object for a plan: a bitmap of the box with the pixels the fill changed (the region's
// bits and the soft edge ring, plan.ek / ev), transparent elsewhere. The region is all one opaque
// colour, so it is drawn as one path of its runs (no 400 MB upload at 100 MP), then the ring one
// path per colour. Past 100k runs (noise-like masks) or with a ring pixel that isn't opaque (a soft
// edge over transparency), the pixels are put instead; a fill that isn't opaque everywhere also gets
// a mask that clears its pixels first, so it replaces them.
function fillObj(after, W, plan) {
  const { x, y, w, h } = plan.box, bits = plan.bits, color = plan.color;
  const cv = makeCanvas(w, h), g = cv.getContext('2d');
  const rgb = (v) => `rgb(${v & 255}, ${(v >>> 8) & 255}, ${(v >>> 16) & 255})`;
  const opaque = (color >>> 24) === 255 && plan.ev.every((v) => (v >>> 24) === 255);
  const path = opaque && plan.ek.length <= 100000 ? fillRuns(bits, w, h, 0, 0) : null;
  let maskCv = null;
  if (path) {
    g.fillStyle = rgb(color);
    g.fill(path);
    const byColor = new Map();
    plan.ek.forEach((k, j) => {
      if (!byColor.has(plan.ev[j])) byColor.set(plan.ev[j], new Path2D());
      byColor.get(plan.ev[j]).rect(k % w, k / w | 0, 1, 1);
    });
    for (const [v, px] of byColor) { g.fillStyle = rgb(v); g.fill(px); }
  } else {
    const im = new ImageData(w, h), out = new Uint32Array(im.data.buffer);
    const ring = new Uint8Array(w * h);
    for (const k of plan.ek) ring[k] = 1;
    for (let r = 0, k = 0; r < h; r++) {
      const src = (y + r) * W + x;
      for (let c = 0; c < w; c++, k++) if ((bits[k >> 3] & (1 << (k & 7))) || ring[k]) out[k] = after[src + c];
    }
    g.putImageData(im, 0, 0);
    if (!opaque) { // alpha 255 wherever the fill wrote, so destination-out clears exactly those pixels
      for (let k = 0; k < out.length; k++) out[k] = (bits[k >> 3] & (1 << (k & 7))) || ring[k] ? 0xff000000 : 0;
      maskCv = makeCanvas(w, h);
      maskCv.getContext('2d').putImageData(im, 0, 0);
    }
  }
  return { t: 'fill', x, y, w, h, asset: makeAsset(cv, { bits, maskCv }) };
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


export { doFill, filling };
