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
// Strokes are packed compactly (Core.packObj: pencil points as deltas, brush segments flat). A fill
// that clears or replaces pixels that aren't opaque (Transparent, a soft edge over transparency) also
// carries its mask (mask: the blob of a PNG opaque wherever it replaces a pixel): its pixels alone
// can't tell a pixel it clears from one it leaves alone.
const CHUNK = 'paNt';
const idatHash = (u8) => {
  let h = 2166136261;
  for (const c of Core.pngChunks(u8)) {
    if (c.type !== 'IDAT') continue;
    for (let i = c.start + 8, e = i + c.len; i < e; i++) h = Math.imul(h ^ u8[i], 16777619);
  }
  return h >>> 0;
};
const toPng = (cv, still) => encodeBlob(cv, 'image/png', undefined, still).then((b) => b.arrayBuffer()).then((a) => new Uint8Array(a));

// The picture's PNG bytes (pngBytes, a promise: the scene's own PNGs encode meanwhile) with the scene
// of objs and base spliced in. still (encodeBlob): whether the base canvas still holds this document
// (the assets' canvases are the objects' own, so they can't change).
async function withScene(pngBytes, objs, nextId, still) {
  const blobs = [await toPng(base, still)], at = new Map(), masks = new Map();
  for (const o of objs) {
    if (!o.asset || at.has(o.asset)) continue;
    at.set(o.asset, blobs.length);
    blobs.push(await toPng(o.asset.cv));
    if (o.t === 'fill' && o.asset.clears) { masks.set(o.asset, blobs.length); blobs.push(await toPng(o.asset.maskCv)); }
  }
  const png = await pngBytes, list = objs.map((o) => Core.packObj(o.asset ? { ...o, asset: at.get(o.asset), ...(masks.has(o.asset) && { mask: masks.get(o.asset) }) } : o));
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
    if (!Array.isArray(head.blobs) || !Array.isArray(head.objs)) return null;
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
    const list = head.objs.map((p) => Core.unpackObj(p));
    if (!list.every((o) => Core.validObj(o, cvs.length)) || new Set(list.map((o) => o.id)).size !== list.length) return null; // opens as its pixels
    const fills = new Map(head.objs.filter((o) => o.t === 'fill').map((o) => [o.asset, o.mask])); // its pixels -> its mask, if any
    const masks = new Set([...fills.values()].filter((k) => k != null));
    const assets = cvs.map((cv, k) => (!k || masks.has(k) ? null : fills.has(k) ? fillAsset(cv, cvs[fills.get(k)]) : makeAsset(cv)));
    return { base: cvs[0], objs: list.map(({ mask, ...o }) => (o.asset != null ? { ...o, asset: assets[o.asset] } : o)), nextId: Number.isInteger(head.nextId) ? head.nextId : 1 };
  } catch {
    return null;
  }
}
// A fill's asset from its bitmap and its mask (null: where alpha > 0, as a file without one says):
// the pixels it replaces are the hit-test bits, and it needs the mask to clear them first if any of
// them isn't opaque (see assets.js).
function fillAsset(cv, mask) {
  const w = cv.width, h = cv.height, d = new Uint32Array(cv.getContext('2d').getImageData(0, 0, w, h).data.buffer);
  const m = mask && new Uint32Array(mask.getContext('2d').getImageData(0, 0, w, h).data.buffer);
  const bits = new Uint8Array((w * h + 7) >> 3);
  let soft = false;
  for (let k = 0; k < d.length; k++) {
    if (!(m ? m[k] >>> 24 : d[k] >>> 24)) continue;
    bits[k >> 3] |= 1 << (k & 7);
    if (d[k] >>> 24 !== 255) soft = true;
  }
  let maskCv = null;
  if (soft) {
    const im = new ImageData(w, h), mm = new Uint32Array(im.data.buffer);
    for (let k = 0; k < d.length; k++) if (bits[k >> 3] & (1 << (k & 7))) mm[k] = 0xff000000;
    maskCv = makeCanvas(w, h);
    maskCv.getContext('2d').putImageData(im, 0, 0);
  }
  return makeAsset(cv, { bits, maskCv, clears: soft });
}

export { readScene, withScene };
