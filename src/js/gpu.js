import { hist } from './doc.js';
import { unlift } from './selection.js';
import { sel, setSel } from './state.js';
import { flash } from './toast.js';
import { requestRender, updateChrome } from './view.js';

// ---------- GPU context loss ----------
// Nothing in history holds pixels on the GPU except whole-document steps (doc entries keep the
// previous base canvas: crop, resize, rotate, ⌘E...). Every other edit is an object (docs/total-
// objects.md), so a lost #image is simply repainted from the scene (doc.js, contextrestored).
// When the base or a kept canvas loses its context (driver reset, GPU process crash), its pixels
// are gone: drop the doc entries, and those only reachable through them, rather than let undo
// paint blanks; an open float's canvas is blank too, so it is abandoned with its patch.
function gpuLost() {
  let n = hist.dropLost((e) => e.type === 'doc');
  if (sel && sel.float) { unlift(); setSel(null); n++; }
  if (!n) return;
  flash('Graphics were reset; some undo steps were lost');
  updateChrome();
  requestRender();
}

export { gpuLost };
