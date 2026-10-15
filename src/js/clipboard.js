import Core from './core.js';
import { docOp, img, setDoc } from './doc.js';
import { $, clamp, cloneCanvas, makeCanvas, vp } from './dom.js';
import { composite, deleteObj, objs, selObj, selectObj } from './objects.js';
import { deleteSelection, dropSelection } from './selection.js';
import { S, isClear, sel, setSel, sizeProblem } from './state.js';
import { commitText } from './text.js';
import { beginOp } from './tiles.js';
import { errText, flash } from './toast.js';
import { drawObj, setTool } from './tools.js';
import { fitZoom, requestRender, updateChrome } from './view.js';

// ---------- clipboard ----------
function selectionCanvas() {
  const o = !sel && selObj();
  if (o) { // the selected object, alone
    const b = Core.objBox(o), c = makeCanvas(b.w, b.h), g = c.getContext('2d');
    g.translate(-b.x, -b.y);
    drawObj(g, o);
    return c;
  }
  if (!sel) return composite(); // toBlob() encodes a snapshot, so later edits can't leak in
  if (sel.float) return sel.float;
  const c = makeCanvas(sel.w, sel.h), g = c.getContext('2d');
  g.drawImage(img, sel.x, sel.y, sel.w, sel.h, 0, 0, sel.w, sel.h);
  g.translate(-sel.x, -sel.y);
  for (const ob of objs) drawObj(g, ob); // copy what is seen
  return c;
}
async function copySel(cut) {
  commitText();
  const c = selectionCanvas();
  const blob = new Promise((res) => c.toBlob(res, 'image/png'));
  const some = !!sel || !!selObj();
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
    growFrom = img; // kept as is for the undo entry; the grown canvas replaces it
    const c = makeCanvas(Math.max(img.width, bmp.width), Math.max(img.height, bmp.height));
    const g = c.getContext('2d');
    if (!isClear(S.secondary)) { g.fillStyle = S.secondary; g.fillRect(0, 0, c.width, c.height); }
    g.drawImage(img, 0, 0);
    setDoc(c);
  }
  if (growFrom) flash(`Canvas enlarged to ${img.width} × ${img.height} to fit the paste`);
  // Drop it at the top-left of what's visible.
  const r = img.getBoundingClientRect(), v = vp.getBoundingClientRect();
  const x = clamp(Math.floor((v.left - r.left) / S.zoom), 0, img.width - bmp.width);
  const y = clamp(Math.floor((v.top - r.top) / S.zoom), 0, img.height - bmp.height);
  setTool('select');
  beginOp();
  setSel({ x, y, w: bmp.width, h: bmp.height, float: cloneCanvas(bmp), growFrom });
  updateChrome();
  requestRender();
}

export { copySel, pasteImage };
