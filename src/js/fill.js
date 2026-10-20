import Core from './core.js';
import { cellAsset } from './assets.js';
import { base, img } from './doc.js';
import { hexToU32, pixelAt } from './dom.js';
import { startWorker, used, workerCall } from './libs.js';
import { addObj, composite, sceneVer } from './objects.js';
import { TILE } from './scene.js';
import { S, sel } from './state.js';
import { flash } from './toast.js';
import { kickFrame } from './view.js';

// ---------- fill ----------
// The flood fill and its soft edge (Core.fillPlan) run in fill-worker.js, so a big fill (~0.9 s at
// 100 MP) doesn't freeze the page. Reading the pixels happens there too: the page sends a snapshot of
// what is seen (createImageBitmap, a GPU copy), since getImageData here took ~280 ms of the click at
// 100 MP. The worker also cuts the result along the scene's tiles (Core.fillCells), so the page only
// wraps it in an asset (cellAsset): building the paths here took ~60 ms at 16 MP, and the pixels and
// undo data that used to come back were 800 MB at 100 MP. If the worker can't start or fails, the
// same functions run on the main thread. A fill reads what is seen (every object) and becomes a fill
// object on top, frozen at fill time (decision 5a). The page stays live meanwhile, so a fill whose
// picture changed before it finished is dropped, like a resize.
const CELL_MAX = 2048; // rects + soft edge pixels in a tile past which it is drawn from its pixels
let worker = null; // created on the first fill; false once it has failed
let filling = null; // the running fill's promise (for the tests)
function doFill(p, color) {
  const src = composite(), W = src.width, H = src.height;
  if (p.x < 0 || p.y < 0 || p.x >= W || p.y >= H) return;
  if (filling) { flash('Still filling'); return; }
  const c = hexToU32(color);
  // Exact-match fill on a pixel that already has the colour changes nothing: skip the full readback.
  if (Math.round(S.tolerance * 255 / 100) === 0 && new Uint32Array(pixelAt(src, p.x, p.y).buffer)[0] === c) return;
  filling = runFill(p, c, S.tolerance).finally(() => { filling = null; });
}
async function runFill(p, c, tolerance) {
  const src = base, v0 = sceneVer, float = sel && sel.float;
  const W = img.width, H = img.height;
  // Every way the picture changes shows here: an object added, changed or removed bumps sceneVer, a
  // lift makes a float, crop/resize/New swap the base. What changes nothing seen doesn't count: a
  // pan, a marquee, selecting or deselecting objects, a stroke still being drawn (it lands on top later).
  const changed = () => base !== src || sceneVer !== v0 || (sel && sel.float) !== float;
  const job = (pixels) => ({ ...pixels, w: W, h: H, x: p.x, y: p.y, color: c, tolerance, cell: TILE, max: CELL_MAX });
  const read = () => composite().getContext('2d').getImageData(0, 0, W, H).data.buffer;
  let shown = false; // say so only if it takes a noticeable time
  const slow = setTimeout(() => { shown = true; flash('Filling…'); }, 300);
  try {
    let res = null;
    if (worker !== false) {
      try {
        const snap = createImageBitmap(composite());
        kickFrame();
        const bmp = await snap;
        worker = worker || startWorker('fill-worker');
        res = await workerCall(worker, job({ bmp }), [bmp]);
        used.fill = 'worker';
      } catch {
        if (worker) worker.terminate();
        worker = false;
      }
    }
    if (!res) { // no worker: the same work here (the buffer sent to a failed worker is gone)
      if (changed()) return dropped();
      res = { plan: Core.fillPlan(new Uint32Array(read()), W, H, p.x, p.y, c, tolerance) };
      used.fill = 'main';
    }
    const { plan } = res;
    if (!plan) { if (shown) flash('Nothing to fill'); return; }
    if (changed()) return dropped();
    const { x, y, w, h } = plan.box, sx = x % TILE, sy = y % TILE;
    const cells = plan.cells || Core.fillCells(plan.bits, w, h, plan.ek, plan.ev, c, sx, sy, TILE, CELL_MAX);
    addObj({ t: 'fill', x, y, w, h, asset: cellAsset({ cells, bits: plan.bits, w, h, sx, sy, C: TILE, color: c }) }, { keepSel: true });
    if (shown) flash('Filled');
  } finally {
    clearTimeout(slow);
  }
}
const dropped = () => flash('Fill cancelled: the image changed while it ran', true);

export { doFill, filling };
