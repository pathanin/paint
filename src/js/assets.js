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
// Keep cv's pixels on the CPU (read in strips at idle) and refill cv from them when its context comes back.
function keep(cv) {
  const w = cv.width, h = cv.height, g = cv.getContext('2d');
  let data = null, done;
  const ready = new Promise((r) => { done = r; });
  if (!w || !h) done();
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
  const bytes = cvs.reduce((n, c) => n + c.width * c.height * 4 * 2, 0); // each canvas and its CPU copy
  return { cv, bytes, ...extra, ready: Promise.all(cvs.map(keep)) };
}

// A fill drawn from paths ([[css colour, Path2D]], opaque whole-pixel rects): nothing on the GPU, so
// nothing to lose on a context reset. cv draws them into a fresh canvas when one is needed (saving).
function pathAsset(paths, w, h, bits, bytes, banded) {
  const a = { paths, bits, bytes, banded, ready: Promise.resolve() }; // banded: the main colour's rects by 256-px band of the fill's rows
  Object.defineProperty(a, 'cv', { get() {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d');
    for (const [col, p] of paths) { g.fillStyle = col; g.fill(p); }
    return c;
  } });
  return a;
}

export { makeAsset, onRestored, pathAsset };
