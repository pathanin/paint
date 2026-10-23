import Core from './core.js';
import { base, docOp, img, setDoc } from './doc.js';
import { $, clamp, cloneCanvas, makeCanvas, vp } from './dom.js';
import { composite, deleteObj, objs, sceneVer, selList, selectObj } from './objects.js';
import { deleteSelection, dropSelection } from './selection.js';
import { S, isClear, sel, setSel, sizeProblem } from './state.js';
import { commitText } from './text.js';
import { encodeBlob } from './libs.js';
import { errText, flash } from './toast.js';
import { drawObj, setTool } from './tools.js';
import { fitZoom, requestRender, updateChrome } from './view.js';

// ---------- clipboard ----------
function selectionCanvas() {
  const list = sel ? [] : selList();
  if (list.length) { // the selected objects, alone, in their order, over their union box
    const { x, y, w, h } = Core.unionBox(list.map((o) => Core.objBox(o)));
    const c = makeCanvas(w, h), g = c.getContext('2d');
    g.translate(-x, -y);
    for (const o of list) drawObj(g, o);
    return c;
  }
  if (!sel) return composite(); // encodeBlob() encodes a snapshot, so later edits can't leak in
  if (sel.float) return sel.float;
  const c = makeCanvas(sel.w, sel.h);
  c.getContext('2d').drawImage(composite(), sel.x, sel.y, sel.w, sel.h, 0, 0, sel.w, sel.h); // copy what is seen
  return c;
}
async function copySel(cut) {
  commitText();
  const c = selectionCanvas();
  // The whole image is the live #image: the encoder's fallback must not copy a picture changed since.
  const v0 = sceneVer, b0 = base, d0 = S.docId;
  const blob = encodeBlob(c, 'image/png', undefined, c === img ? () => sceneVer === v0 && base === b0 && S.docId === d0 : undefined);
  const some = !!sel || selList().length > 0;
  const didCut = cut && some; // with nothing selected, ⌘X copies the whole image and keeps it
  const sel0 = sel, ids0 = selList().map((o) => o.id).join();
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); // started in the gesture
    // Cut deletes only once the copy is safe, and only what was copied: not a selection made since.
    const same = sel === sel0 && selList().map((o) => o.id).join() === ids0;
    if (didCut && same && !deleteObj()) deleteSelection();
    flash(didCut ? (same ? 'Cut' : 'Copied: the selection changed, so nothing was cut') : some ? 'Copied' : 'Copied the whole image');
  } catch (e) {
    const err = (await blob.then(() => null, (x) => x)) || e; // WebKit's ClipboardItem reports a failed encode as AbortError
    flash('Copy failed: ' + (err && err.name === 'SourceChanged' ? 'the image changed while it was copied. Copy again' : errText(err, 'the browser blocked clipboard access')), true);
  }
}
function pasteImage(bmp) {
  const tw = S.pristine ? bmp.width : Math.max(img.width, bmp.width);
  const th = S.pristine ? bmp.height : Math.max(img.height, bmp.height);
  const why = sizeProblem(tw, th);
  if (why) { flash(`Can't paste: ${why}`, true); return; }
  commitText();
  dropSelection();
  selectObj(null);
  if (S.pristine) { docOp(cloneCanvas(bmp)); fitZoom(true); return; }
  // Grow the canvas to fit the paste (each axis only as needed). No history entry yet:
  // finishFloat() records grow + paste as a single undo step.
  let growFrom = null;
  if (bmp.width > img.width || bmp.height > img.height) {
    growFrom = base; // kept as is for the undo entry; the grown canvas replaces it
    const c = makeCanvas(Math.max(img.width, bmp.width), Math.max(img.height, bmp.height));
    const g = c.getContext('2d');
    if (!isClear(S.secondary)) { g.fillStyle = S.secondary; g.fillRect(0, 0, c.width, c.height); } // else the new area stays transparent
    g.drawImage(base, 0, 0);
    setDoc(c);
  }
  if (growFrom) flash(`Canvas enlarged to ${img.width} × ${img.height} to fit the paste`);
  // Drop it at the top-left of what's visible.
  const r = img.getBoundingClientRect(), v = vp.getBoundingClientRect();
  const x = clamp(Math.floor((v.left - r.left) / S.zoom), 0, img.width - bmp.width);
  const y = clamp(Math.floor((v.top - r.top) / S.zoom), 0, img.height - bmp.height);
  setTool('select');
  setSel({ x, y, w: bmp.width, h: bmp.height, float: cloneCanvas(bmp), growFrom, before: objs });
  updateChrome();
  requestRender();
}

export { copySel, pasteImage };
