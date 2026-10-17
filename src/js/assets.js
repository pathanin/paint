// ---------- assets ----------
// The bitmaps behind image and fill objects: immutable, shared by every version of the object
// (a move or a restyle keeps the same asset), and charged to the undo entry that brought them in.
// asset: {cv: canvas, bytes, bits?: a fill's region as a bitset (hit tests), maskCv?: canvas
// (a fill that isn't opaque everywhere clears its pixels with it first, so it replaces them)}.
function makeAsset(cv, extra) {
  return { cv, bytes: cv.width * cv.height * 4, ...extra };
}

export { makeAsset };
