import Core from './core.js';
import { docOp, hist, img } from './doc.js';
import { $, makeCanvas } from './dom.js';
import { loadPica, used } from './libs.js';
import { dropSelection } from './selection.js';
import { S, drag, sel, sizeProblem } from './state.js';
import { commitText, textAt } from './text.js';
import { flash } from './toast.js';

// ---------- transforms ----------
function transformDoc(kind) {
  commitText();
  dropSelection();
  const w = img.width, h = img.height;
  const dims = Core.rotateDims(w, h, kind === 'rotL' ? -90 : kind === 'rotR' ? 90 : 0);
  const c = makeCanvas(dims.w, dims.h), g = c.getContext('2d');
  if (kind === 'rotR') { g.translate(dims.w, 0); g.rotate(Math.PI / 2); }
  else if (kind === 'rotL') { g.translate(0, dims.h); g.rotate(-Math.PI / 2); }
  else if (kind === 'flipH') { g.translate(w, 0); g.scale(-1, 1); }
  else if (kind === 'flipV') { g.translate(0, h); g.scale(1, -1); }
  g.drawImage(img, 0, 0);
  docOp(c, (o) => Core.transformObj(o, kind, w, h));
}
// Scale with pica's Lanczos-3 filter (in workers); past its budget, or if it fails, the built-in
// halving resampler. On a zone plate ÷3, Lanczos-3 had ~40% less moiré and kept low
// frequencies ~9× closer to the signal; upscaled, it was closer too. pica's default mks2013 filter
// adds sharpening, which overshoots in both directions, so it isn't used.
// pica is CPU-bound and its downscale cost grows faster than the pixel count (source + result:
// 45 MP took 0.8 s, 80 MP 2.3 s, 125 MP 5.2 s on an M4), while the built-in path is a few GPU
// draws. Past PICA_MAX_PIXELS the built-in path runs.
const PICA_MAX_PIXELS = 50e6;
let picaInst = null;
async function scaleImage(src, w, h) {
  try {
    if (src.width * src.height + w * h > PICA_MAX_PIXELS) throw new Error('too large for pica');
    picaInst = picaInst || (await loadPica())(); // loaded and created on first use, so boot starts no workers
    const out = makeCanvas(w, h);
    await picaInst.resize(src, out, { filter: 'lanczos3' });
    used.resize = 'pica';
    return out;
  } catch {
    used.resize = 'builtin';
    return resample(src, w, h);
  }
}
// Built-in high-quality downscale: halve repeatedly, then one final smooth draw.
function resample(src, w, h) {
  let cur = src;
  while (cur.width >= w * 2 || cur.height >= h * 2) {
    const nw = Math.max(w, Math.ceil(cur.width / 2)), nh = Math.max(h, Math.ceil(cur.height / 2));
    const t = makeCanvas(nw, nh), g = t.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(cur, 0, 0, nw, nh);
    cur = t;
  }
  const out = makeCanvas(w, h), g = out.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(cur, 0, 0, w, h);
  return out;
}
// Scaling is async (pica works off the main thread). If the
// document changes meanwhile, the result is stale: drop it rather than overwrite the newer edit.
let scaling = null;
async function scaleDoc(w, h) {
  if (scaling) { flash('Still resizing'); return; }
  const src = img, top = hist.top();
  let shown = false; // say so only if it takes a noticeable time, then confirm when done
  const slow = setTimeout(() => { shown = true; flash('Resizing…'); }, 300);
  try {
    const out = await (scaling = scaleImage(src, w, h));
    if (img !== src || hist.top() !== top || drag || (sel && sel.float) || textAt) {
      out.width = 0;
      flash('Resize failed: the image changed while it ran', true);
      return;
    }
    docOp(out, (o) => Core.scaleObj(o, w / src.width, h / src.height));
    if (shown) flash(`Resized to ${w} × ${h} px`);
  } finally {
    clearTimeout(slow);
    scaling = null;
  }
}
function resizeDoc(w, h, mode, anchor) {
  const why = sizeProblem(w, h);
  if (why) { flash(`Can't resize: ${why}`, true); return; }
  if (w === img.width && h === img.height) { flash('Size unchanged'); return; }
  commitText();
  dropSelection();
  if (mode === 'scale') return scaleDoc(w, h);
  const c = makeCanvas(w, h), g = c.getContext('2d');
  g.fillStyle = S.secondary;
  g.fillRect(0, 0, w, h);
  const { dx, dy } = Core.anchorOffset(img.width, img.height, w, h, anchor);
  g.drawImage(img, dx, dy);
  docOp(c, (o) => Core.moveObj(o, dx, dy));
}

export { resample, resizeDoc, scaleImage, transformDoc };
