// The paint bucket's fill, off the main thread (fill.js): the page's pixels arrive as a snapshot
// (an ImageBitmap, read back here, so the 400 MB readback at 10000² doesn't hold up the page) or, from
// an older page, as a transferred buffer; they are filled in place by Core.fillPlan and go back with
// the undo data.
import Core from './core.js';

const STRIP_PX = 1 << 21; // 2 MP (8 MB) per readback

self.onmessage = (e) => {
  let { buf, bmp, w, h, x, y, color, tolerance } = e.data;
  try {
    if (bmp) { // read back in strips: one 400 MB readback holds the GPU process for ~100 ms, and no frame
      // can be shown meanwhile; between strips it can. Each strip is cut out on the GPU first (a GPU canvas:
      // a CPU one would read the whole bitmap back for every strip).
      const out = new Uint8ClampedArray(w * h * 4), rows = Math.max(1, Math.floor(STRIP_PX / w));
      const g = new OffscreenCanvas(w, rows).getContext('2d');
      g.globalCompositeOperation = 'copy';
      for (let y0 = 0; y0 < h; y0 += rows) {
        const n = Math.min(rows, h - y0);
        g.drawImage(bmp, 0, y0, w, n, 0, 0, w, n);
        out.set(g.getImageData(0, 0, w, n).data, y0 * w * 4);
      }
      bmp.close();
      buf = out.buffer;
    }
    const plan = Core.fillPlan(new Uint32Array(buf), w, h, x, y, color, tolerance);
    const transfer = [buf];
    if (plan) transfer.push(plan.before.buffer, plan.bits.buffer, plan.ek.buffer, plan.ev.buffer);
    self.postMessage({ buf, plan }, transfer);
  } catch (err) {
    self.postMessage({ error: String(err && err.message || err) });
  }
};
