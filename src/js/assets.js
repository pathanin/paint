// ---------- assets ----------
// The bitmaps behind image and fill objects: immutable, shared by every version of the object
// (a move or a restyle keeps the same asset), and charged to the undo entry that brought them in.
// asset: {cv: canvas, bytes, bits?: a fill's region as a bitset (hit tests), maskCv?: canvas
// (a fill that isn't opaque everywhere clears its pixels with it first, so it replaces them)}.
// A GPU context loss blanks every canvas: each canvas an asset holds (cv, and a fill's maskCv) keeps
// a CPU copy of its pixels, and when it comes back it is refilled from it and the scene repainted.
// The copy is read at idle in strips of rows (one read of a whole 100 MP canvas would stall the page
// for a long moment), and charged to bytes like the canvas itself. asset.ready settles once every
// copy is complete. (Fills drawn from paths keep nothing on the GPU.)
const STRIP_PX = 1 << 20; // pixels read per step: ~4 MB, a few ms
const onIdle = window.requestIdleCallback ? (f) => window.requestIdleCallback(f, { timeout: 2000 })
  : (f) => setTimeout(() => { // Safari has no requestIdleCallback: an 8 ms slice that counts down
    const t0 = performance.now();
    f({ timeRemaining: () => Math.max(0, 8 - (performance.now() - t0)) });
  }, 0);
let restored = () => {};
const onRestored = (f) => { restored = f; };
// A browser that never loses a 2D context has no contextlost event on canvases (Safari; Chrome has it
// since 99, Firefox since 125): there the copy would be memory and idle readbacks for nothing.
const LOSES = 'oncontextlost' in HTMLCanvasElement.prototype;
// Keep cv's pixels on the CPU (read in strips at idle) and refill cv from them when its context comes back.
function keep(cv) {
  const w = cv.width, h = cv.height, g = cv.getContext('2d');
  let data = null, done;
  const ready = new Promise((r) => { done = r; });
  if (!w || !h || !LOSES) done();
  else {
    const buf = new Uint8ClampedArray(w * h * 4);
    let y = 0;
    const step = (deadline) => {
      if (g.isContextLost && g.isContextLost()) { done(); return; } // lost before it was read: nothing to keep
      do {
        const rows = Math.min(h - y, Math.max(1, Math.floor(STRIP_PX / w)));
        buf.set(g.getImageData(0, y, w, rows).data, y * w * 4);
        y += rows;
      } while (y < h && deadline.timeRemaining() > 2);
      if (y < h) onIdle(step);
      else { data = new ImageData(buf, w, h); done(); }
    };
    onIdle(step);
  }
  cv.addEventListener('contextrestored', () => {
    if (!data) return;
    g.putImageData(data, 0, 0);
    restored();
  });
  return ready;
}
function makeAsset(cv, extra) {
  const cvs = [cv, extra && extra.maskCv].filter(Boolean);
  const bytes = cvs.reduce((n, c) => n + c.width * c.height * 4 * (LOSES ? 2 : 1), 0); // each canvas and its CPU copy
  return { cv, bytes, ...extra, ready: Promise.all(cvs.map(keep)) };
}

// A fill drawn from its cells (Core.fillCells, cut in the fill worker along the scene's tiles): a tile
// repaint draws only the cells it meets, one for a fill that hasn't moved. A cell is drawn from paths
// of whole-pixel rects: the region in the fill's colour (cleared, in Transparent) and the soft edge
// one path per colour; a soft edge pixel that isn't opaque is cleared first, so it replaces what is
// under it (an rgba() rect over a cleared pixel gives what putImageData would). A dense cell (noise-like
// masks) is drawn from a canvas of its pixels instead. The paths and canvases are built the first time
// a tile draws the cell, and a canvas comes back from its pixels after a context loss, so the asset
// keeps nothing else: no box-sized bitmap and no CPU copy of one.
// a: {cells, bits (the region, for hit tests), w, h, sx, sy, C (the cells' grid: see Core.fillCells), color}.
const css = (v) => {
  const r = v & 255, g = (v >>> 8) & 255, b = (v >>> 16) & 255, al = v >>> 24;
  return al === 255 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${al / 255})`;
};
function cellAsset({ cells, bits, w, h, sx, sy, C, color }) {
  const at = new Map(), cols = Math.floor((w - 1 + sx) / C) + 1, rows = Math.floor((h - 1 + sy) / C) + 1;
  let bytes = bits.byteLength + 64, clears = (color >>> 24) !== 255;
  for (const c of cells) {
    at.set(c.j * cols + c.i, c);
    for (const v of [c.r, c.rk, c.rv, c.px, c.mk]) if (v) bytes += v.byteLength;
    if (c.px) bytes += c.w * c.h * 4 * (c.mk ? 2 : 1); // its canvases, once drawn
    if (c.mk || (c.rv && c.rv.some((v) => (v >>> 24) !== 255))) clears = true;
  }
  const a = { cells, at, cols, rows, bits, w, h, sx, sy, C, color, bytes, clears, ready: Promise.resolve() };
  Object.defineProperty(a, 'cv', { get() { // the fill's pixels, for saving
    const c = makeCv(w, h);
    drawCells(c.getContext('2d'), a, null);
    return c;
  } });
  Object.defineProperty(a, 'maskCv', { get() { // opaque wherever it replaces a pixel, for saving
    const im = new ImageData(w, h), m = new Uint32Array(im.data.buffer);
    for (let k = 0; k < w * h; k++) if (bits[k >> 3] & (1 << (k & 7))) m[k] = 0xff000000;
    for (const c of cells) {
      if (c.rk) for (let i = 0; i < c.rk.length; i += 2) m[c.rk[i + 1] * w + c.rk[i]] = 0xff000000;
      else for (let k = 0; k < c.px.length; k++) if (c.mk ? c.mk[k] : c.px[k]) m[(c.y + (k / c.w | 0)) * w + c.x + k % c.w] = 0xff000000;
    }
    const c = makeCv(w, h);
    c.getContext('2d').putImageData(im, 0, 0);
    return c;
  } });
  return a;
}
const makeCv = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
function cellPaths(a, c) {
  if (c.paths) return c.paths;
  const clear = (a.color >>> 24) === 0, soft = new Path2D(), byColor = new Map();
  let anySoft = clear;
  const main = new Path2D();
  for (let i = 0; i < c.r.length; i += 4) (clear ? soft : main).rect(c.r[i], c.r[i + 1], c.r[i + 2], c.r[i + 3]);
  for (let n = 0; n < c.rv.length; n++) {
    const v = c.rv[n], x = c.rk[2 * n], y = c.rk[2 * n + 1];
    if ((v >>> 24) !== 255) { soft.rect(x, y, 1, 1); anySoft = true; }
    if (!(v >>> 24)) continue;
    let p = byColor.get(v);
    if (!p) byColor.set(v, (p = new Path2D()));
    p.rect(x, y, 1, 1);
  }
  c.paths = { soft: anySoft ? soft : null, main: !clear && c.r.length ? main : null, ring: [...byColor].map(([v, p]) => [css(v), p]) };
  return c.paths;
}
function cellCanvases(c) {
  if (c.cv) return c;
  const put = (u32) => {
    const cv = makeCv(c.w, c.h);
    cv.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(u32.buffer, u32.byteOffset, u32.length * 4), c.w, c.h), 0, 0);
    cv.addEventListener('contextrestored', () => { c.cv = c.maskCv = null; restored(); }); // blank now: rebuilt from px
    return cv;
  };
  c.cv = put(c.px);
  if (c.mk) {
    const m = new Uint32Array(c.mk.length);
    for (let k = 0; k < m.length; k++) if (c.mk[k]) m[k] = 0xff000000;
    c.maskCv = put(m);
  }
  return c;
}
// Draw fill asset a's cells into g (in the fill's own px): those that meet lb (a rect in them, the tile
// being repainted mapped back through the object's m), or all of them.
function drawCells(g, a, lb) {
  let list = a.cells;
  if (lb) {
    list = [];
    // the cells lb overlaps: its far edges are exclusive (a tile that ends where a cell starts doesn't meet it)
    const i0 = Math.max(0, Math.floor((lb.x + a.sx) / a.C)), i1 = Math.min(a.cols - 1, Math.ceil((lb.x + lb.w + a.sx) / a.C) - 1);
    const j0 = Math.max(0, Math.floor((lb.y + a.sy) / a.C)), j1 = Math.min(a.rows - 1, Math.ceil((lb.y + lb.h + a.sy) / a.C) - 1);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) { const c = a.at.get(j * a.cols + i); if (c) list.push(c); }
  }
  const fill = (p, style, op) => { g.globalCompositeOperation = op; g.fillStyle = style; g.fill(p); };
  for (const c of list) {
    if (c.px) {
      cellCanvases(c);
      if (c.maskCv) { g.globalCompositeOperation = 'destination-out'; g.drawImage(c.maskCv, c.x, c.y); }
      g.globalCompositeOperation = 'source-over';
      g.drawImage(c.cv, c.x, c.y);
      continue;
    }
    const p = cellPaths(a, c);
    if (p.soft) fill(p.soft, '#000', 'destination-out');
    if (p.main) fill(p.main, css(a.color), 'source-over');
    for (const [style, q] of p.ring) fill(q, style, 'source-over');
  }
  g.globalCompositeOperation = 'source-over';
}

export { cellAsset, drawCells, LOSES, makeAsset, onRestored };
