import Core from './core.js';
import { base, docOp, img, setDoc } from './doc.js';
import { $, clamp, cloneCanvas, makeCanvas, vp } from './dom.js';
import { composite, deleteObj, objs, selList, selectObj } from './objects.js';
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
    const bs = list.map((o) => Core.objBox(o)), x = Math.min(...bs.map((b) => b.x)), y = Math.min(...bs.map((b) => b.y));
    const c = makeCanvas(Math.max(...bs.map((b) => b.x + b.w)) - x, Math.max(...bs.map((b) => b.y + b.h)) - y), g = c.getContext('2d');
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
  const blob = encodeBlob(c, 'image/png');
  const some = !!sel || selList().length > 0;
  const didCut = cut && some; // with nothing selected, ⌘X copies the whole image and keeps it
  if (didCut && !deleteObj()) deleteSelection();
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    flash(didCut ? 'Cut' : some ? 'Copied' : 'Copied the whole image');
  } catch (err) {
    flash('Copy failed: ' + errText(err, 'the browser blocked clipboard access'), true);
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
