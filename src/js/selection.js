import Core from './core.js';
import { ctx, docOp, img, pushDocHist } from './doc.js';
import { makeCanvas } from './dom.js';
import { selectObj } from './objects.js';
import { S, isClear, sel, setSel } from './state.js';
import { commitText } from './text.js';
import { beginOp, dropOp, endOp, touch } from './tiles.js';
import { flash } from './toast.js';
import { setTool } from './tools.js';
import { requestRender, updateChrome } from './view.js';

// ---------- selection ----------
const inside = (p, r) => p.x >= r.x && p.y >= r.y && p.x < r.x + r.w && p.y < r.y + r.h;
// What a lift or Delete leaves behind: colour 2, or transparency.
function clearTo2(r) {
  if (isClear(S.secondary)) { ctx.clearRect(r.x, r.y, r.w, r.h); return; }
  ctx.fillStyle = S.secondary;
  ctx.fillRect(r.x, r.y, r.w, r.h);
}
function liftSelection() {
  beginOp();
  const f = makeCanvas(sel.w, sel.h);
  f.getContext('2d').drawImage(img, sel.x, sel.y, sel.w, sel.h, 0, 0, sel.w, sel.h);
  touch(sel.x, sel.y, sel.w, sel.h);
  clearTo2(sel);
  sel.float = f;
  updateChrome();
}
function commitSelection() {
  if (!sel || !sel.float) return;
  touch(sel.x, sel.y, sel.w, sel.h);
  ctx.drawImage(sel.float, sel.x, sel.y);
  sel.float = null;
  finishFloat();
  requestRender();
}
// Close the undo step of a floating selection. A paste that grew the canvas becomes one
// whole-document step (original canvas -> grown + pasted), so a single undo reverts both.
function finishFloat() {
  if (!sel.growFrom) { endOp(); return; }
  const before = sel.growFrom;
  sel.growFrom = null;
  dropOp();
  pushDocHist(before);
}
function dropSelection() {
  commitSelection();
  if (sel) { setSel(null); requestRender(); }
}
function deleteSelection() {
  if (!sel) return;
  if (sel.float) { sel.float = null; finishFloat(); }
  else {
    beginOp();
    touch(sel.x, sel.y, sel.w, sel.h);
    clearTo2(sel);
    endOp();
  }
  setSel(null);
  requestRender();
}
function selectAll() {
  commitText();
  dropSelection();
  setTool('select');
  selectObj(null);
  setSel({ x: 0, y: 0, w: img.width, h: img.height, float: null });
  requestRender();
}
function nudge(dx, dy) {
  if (!sel) return;
  if (!sel.float) liftSelection();
  sel.x += dx; sel.y += dy;
  requestRender();
}
function crop() {
  if (!sel) { flash('Select an area to crop first'); return; }
  commitSelection();
  const r = Core.clampRect(sel, img.width, img.height);
  if (!r) { flash('Selection is outside the image'); return; }
  const c = makeCanvas(r.w, r.h);
  c.getContext('2d').drawImage(img, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
  docOp(c, (o) => Core.moveObj(o, -r.x, -r.y));
}

export { commitSelection, crop, deleteSelection, dropSelection, inside, liftSelection, nudge, selectAll };
