// The paint bucket's fill, off the main thread (fill.js): the page's pixels arrive as a transferred
// buffer, are filled in place by Core.fillPlan and go back with the undo data.
import Core from './core.js';

self.onmessage = (e) => {
  const { buf, w, h, x, y, color, tolerance } = e.data;
  try {
    const plan = Core.fillPlan(new Uint32Array(buf), w, h, x, y, color, tolerance);
    const transfer = [buf];
    if (plan) transfer.push(plan.before.buffer, plan.bits.buffer, plan.ek.buffer, plan.ev.buffer);
    self.postMessage({ buf, plan }, transfer);
  } catch (err) {
    self.postMessage({ error: String(err && err.message || err) });
  }
};
