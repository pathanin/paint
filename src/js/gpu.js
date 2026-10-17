import { hist, setDoc } from './doc.js';
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
  if (sel && sel.float) { abandonFloat(); n++; }
  if (!n) return;
  flash('Graphics were reset; some undo steps were lost');
  updateChrome();
  requestRender();
}
// A paste that grew the canvas has already swapped in the grown one; only its commit would have
// recorded that. So the canvas goes back to the one before the paste, with the objects as they were;
// if that one lost its pixels too, the grown canvas stays, and the document can't count as saved.
function abandonFloat() {
  const from = sel.growFrom;
  unlift(); // the objects as they were before the lift or paste
  setSel(null);
  if (!from) return;
  const g = from.getContext('2d');
  if (g.isContextLost && g.isContextLost()) { hist.forgetSave(); return; }
  setDoc(from); // syncs the base object too
}

export { gpuLost };
