import Core from './core.js';
import { makeAsset } from './assets.js';
import { base } from './doc.js';
import { makeCanvas } from './dom.js';
import { encodeBlob } from './libs.js';

// ---------- objects inside a PNG ----------
// A PNG saved with objects carries them in a private chunk, paNt (docs/total-objects.md, Phase 5):
// every other app sees the picture, and Paint reopens the objects. The chunk holds a 4-byte length,
// then JSON (the objects, with each bitmap as an index into the blobs), then the blobs: the base and
// each asset as a nested PNG. It also records a hash of the file's own IDAT bytes: an app that
// re-encodes the picture (any edit elsewhere) leaves a chunk that no longer matches, so it's ignored.
// Strokes are packed compactly (Core.packObj: pencil points as deltas, brush segments flat).
const CHUNK = 'paNt';
const idatHash = (u8) => {
  let h = 2166136261;
  for (const c of Core.pngChunks(u8)) {
    if (c.type !== 'IDAT') continue;
    for (let i = c.start + 8, e = i + c.len; i < e; i++) h = Math.imul(h ^ u8[i], 16777619);
  }
  return h >>> 0;
};
const toPng = (cv) => encodeBlob(cv, 'image/png').then((b) => b.arrayBuffer()).then((a) => new Uint8Array(a));

// The PNG bytes png (the picture) with the scene of objs and base spliced in.
async function withScene(png, objs, nextId) {
  const blobs = [await toPng(base)], at = new Map();
  for (const o of objs) {
    if (!o.asset || at.has(o.asset)) continue;
    at.set(o.asset, blobs.length);
    blobs.push(await toPng(o.asset.cv));
  }
  const list = objs.map((o) => Core.packObj(o.asset ? { ...o, asset: at.get(o.asset) } : o));
  const head = new TextEncoder().encode(JSON.stringify({ v: 1, w: base.width, h: base.height, idat: idatHash(png), nextId, objs: list, blobs: blobs.map((b) => b.length) }));
  const data = new Uint8Array(4 + head.length + blobs.reduce((n, b) => n + b.length, 0));
  new DataView(data.buffer).setUint32(0, head.length);
  data.set(head, 4);
  let i = 4 + head.length;
  for (const b of blobs) { data.set(b, i); i += b.length; }
  return Core.withChunk(png, CHUNK, data);
}
// The scene in PNG bytes u8: {base: canvas, objs, nextId}, or null (no chunk, or a stale one).
async function readScene(u8) {
  const data = Core.readChunk(u8, CHUNK);
  if (!data) return null;
  try {
    const n = new DataView(data.buffer, data.byteOffset).getUint32(0);
    const head = JSON.parse(new TextDecoder().decode(data.subarray(4, 4 + n)));
    if (head.v !== 1 || head.idat !== idatHash(u8)) return null;
    let i = 4 + n;
    const cvs = [];
    for (const len of head.blobs) {
      const bmp = await createImageBitmap(new Blob([data.subarray(i, i + len)], { type: 'image/png' }));
      i += len;
      const cv = makeCanvas(bmp.width, bmp.height);
      cv.getContext('2d').drawImage(bmp, 0, 0);
      bmp.close();
      cvs.push(cv);
    }
    const assets = cvs.map((cv, k) => (k ? makeAsset(cv) : null));
    const fillOf = new Set(head.objs.filter((o) => o.t === 'fill').map((o) => o.asset));
    for (const k of fillOf) assets[k] = fillAsset(cvs[k]);
    return { base: cvs[0], objs: head.objs.map((p) => { const o = Core.unpackObj(p); return o.asset != null ? { ...o, asset: assets[o.asset] } : o; }), nextId: head.nextId };
  } catch {
    return null;
  }
}
// A fill's asset from its bitmap: its pixels are where alpha > 0 (the hit-test bits), and it needs
// a clearing mask if any of them isn't opaque (see fill.js).
function fillAsset(cv) {
  const w = cv.width, h = cv.height, d = new Uint32Array(cv.getContext('2d').getImageData(0, 0, w, h).data.buffer);
  const bits = new Uint8Array((w * h + 7) >> 3);
  let soft = false;
  for (let k = 0; k < d.length; k++) {
    const a = d[k] >>> 24;
    if (a) { bits[k >> 3] |= 1 << (k & 7); if (a !== 255) soft = true; }
  }
  let maskCv = null;
  if (soft) {
    const im = new ImageData(w, h), m = new Uint32Array(im.data.buffer);
    for (let k = 0; k < d.length; k++) if (d[k] >>> 24) m[k] = 0xff000000;
    maskCv = makeCanvas(w, h);
    maskCv.getContext('2d').putImageData(im, 0, 0);
  }
  return makeAsset(cv, { bits, maskCv });
}

export { readScene, withScene };
