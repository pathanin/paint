// ---------- assets ----------
// The bitmaps behind image and fill objects: immutable, shared by every version of the object
// (a move or a restyle keeps the same asset), and charged to the undo entry that brought them in.
// asset: {cv: canvas, bytes, bits?: a fill's region as a bitset (hit tests), maskCv?: canvas
// (a fill that isn't opaque everywhere clears its pixels with it first, so it replaces them)}.
// A GPU context loss blanks every canvas: each bitmap asset keeps a CPU copy of its pixels (read
// once, at idle), and when its canvas comes back it is refilled from it and the scene repainted.
// (Fills drawn from paths keep nothing on the GPU.)
const onIdle = window.requestIdleCallback || ((f) => setTimeout(f, 0));
let restored = () => {};
const onRestored = (f) => { restored = f; };
function makeAsset(cv, extra) {
  const a = { cv, bytes: cv.width * cv.height * 4, data: null, ...extra };
  onIdle(() => { if (!a.data && cv.width) a.data = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height); });
  cv.addEventListener('contextrestored', () => {
    if (a.data) cv.getContext('2d').putImageData(a.data, 0, 0);
    restored();
  });
  return a;
}

// A fill drawn from paths ([[css colour, Path2D]], opaque whole-pixel rects): nothing on the GPU, so
// nothing to lose on a context reset. cv draws them into a fresh canvas when one is needed (saving).
function pathAsset(paths, w, h, bits, bytes, banded) {
  const a = { paths, bits, bytes, banded }; // banded: the main colour's rects by 512-px band of image y
  Object.defineProperty(a, 'cv', { get() {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d');
    for (const [col, p] of paths) { g.fillStyle = col; g.fill(p); }
    return c;
  } });
  return a;
}

export { makeAsset, onRestored, pathAsset };
