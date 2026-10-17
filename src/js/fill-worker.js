// The paint bucket's fill, off the main thread (fill.js): the page's pixels arrive as a snapshot
// (an ImageBitmap, read back here, so the 400 MB readback at 10000² doesn't hold up the page) or, from
// an older page, as a transferred buffer; they are filled in place by Core.fillPlan and go back with
// the undo data.
import Core from './core.js';

self.onmessage = (e) => {
  let { buf, bmp, w, h, x, y, color, tolerance } = e.data;
  try {
    if (bmp) {
      const g = new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true });
      g.drawImage(bmp, 0, 0);
      bmp.close();
      buf = g.getImageData(0, 0, w, h).data.buffer;
    }
    const plan = Core.fillPlan(new Uint32Array(buf), w, h, x, y, color, tolerance);
    const transfer = [buf];
    if (plan) transfer.push(plan.before.buffer, plan.bits.buffer, plan.ek.buffer, plan.ev.buffer);
    self.postMessage({ buf, plan }, transfer);
  } catch (err) {
    self.postMessage({ error: String(err && err.message || err) });
  }
};
