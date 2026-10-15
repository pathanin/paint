import Core from './core.js';
import { ctx, img, pushHist } from './doc.js';
import { $, hexToU32 } from './dom.js';
import { S } from './state.js';
import { blit } from './tiles.js';

// ---------- fill ----------
function doFill(p, color) {
  const W = img.width, H = img.height;
  if (p.x < 0 || p.y < 0 || p.x >= W || p.y >= H) return;
  const c = hexToU32(color);
  // Exact-match fill on a pixel that already has the colour changes nothing: skip the full readback.
  if (Math.round(S.tolerance * 255 / 100) === 0 && new Uint32Array(ctx.getImageData(p.x, p.y, 1, 1).data.buffer)[0] === c) return;
  const data = ctx.getImageData(0, 0, W, H);
  const u32 = new Uint32Array(data.data.buffer);
  const region = Core.floodMask(u32, W, H, p.x, p.y, S.tolerance), mask = region.mask;
  // The soft (anti-aliased) edge around the region is recoloured too, so no light fringe is left.
  const edge = Core.fillEdge(u32, W, H, region, u32[p.y * W + p.x], c, S.tolerance), box = edge.box;
  // The undo entry: the box's pixels before, the region as a bit mask and the edge pixels' new
  // values. "After" is those pixels with the masked ones set to c and the edge ones to theirs, so
  // neither undo nor redo has to read the canvas back.
  const before = new ImageData(box.w, box.h);
  blit(data, box.x, box.y, before, 0, 0, box.w, box.h);
  const bits = new Uint8Array(Math.ceil(box.w * box.h / 8));
  let changed = false;
  for (let y = 0, k = 0; y < box.h; y++) {
    for (let i = (box.y + y) * W + box.x, e = i + box.w; i < e; i++, k++) {
      if (!mask[i]) continue;
      bits[k >> 3] |= 1 << (k & 7);
      if (u32[i] !== c) { u32[i] = c; changed = true; }
    }
  }
  const ek = new Uint32Array(edge.idx.length);
  edge.idx.forEach((i, k) => { u32[i] = edge.val[k]; ek[k] = ((i / W | 0) - box.y) * box.w + i % W - box.x; });
  if (!changed && !ek.length) return;
  ctx.putImageData(data, 0, 0, box.x, box.y, box.w, box.h);
  pushHist({ type: 'fill', x: box.x, y: box.y, before, bits, color: c, ek, ev: edge.val, undone: false, bytes: before.data.length + bits.length + ek.length * 8 });
}
// Undo/redo of a fill entry: put back the pixels before, or recompute the filled ones.
function applyFill(e) {
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

export { applyFill, doFill };
