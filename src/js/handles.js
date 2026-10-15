import Core from './core.js';
import { img } from './doc.js';
import { $ } from './dom.js';
import { MAX_DIM, MAX_PIXELS, S, drag, setDrag } from './state.js';
import { commitText } from './text.js';
import { resizeDoc } from './transforms.js';
import { requestRender, updateStatus } from './view.js';

// ---------- canvas resize handles (Paint-style: right, bottom, corner; top-left stays put) ----------
const ghost = $('#resizeGhost');
let ghostSize = '';
function showGhost(d) { // runs every frame of a handle drag: write only on change
  ghost.hidden = false;
  const sz = d.w * S.zoom + 'px ' + d.h * S.zoom + 'px';
  if (sz === ghostSize) return;
  ghostSize = sz;
  ghost.style.width = d.w * S.zoom + 'px';
  ghost.style.height = d.h * S.zoom + 'px';
}
function endCanvasDrag(apply) {
  const d = drag;
  setDrag(null);
  ghost.hidden = true;
  if (apply) resizeDoc(d.w, d.h, 'canvas', 'tl');
  updateStatus();
}
document.querySelectorAll('.handle[data-edge]').forEach((h) => {
  h.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || drag) return;
    e.preventDefault();
    e.stopPropagation();
    commitText();
    if (document.activeElement) document.activeElement.blur();
    try { h.setPointerCapture(e.pointerId); } catch { /* inactive pointer: drag still works while over the handle */ }
    setDrag({ t: 'canvas', edge: h.dataset.edge, sx: e.clientX, sy: e.clientY, w: img.width, h: img.height });
    showGhost(drag);
    updateStatus();
  });
  h.addEventListener('pointermove', (e) => {
    if (!drag || drag.t !== 'canvas') return;
    const n = Core.dragResize(img.width, img.height, e.clientX - drag.sx, e.clientY - drag.sy, drag.edge, S.zoom, e.shiftKey, MAX_DIM, MAX_PIXELS);
    drag.w = n.w; drag.h = n.h;
    requestRender(); // ghost and status are written in render()
  });
  h.addEventListener('pointerup', () => { if (drag && drag.t === 'canvas') endCanvasDrag(true); });
  h.addEventListener('pointercancel', () => { if (drag && drag.t === 'canvas') endCanvasDrag(false); });
});

export { endCanvasDrag, showGhost };
