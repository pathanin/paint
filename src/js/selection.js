import Core from './core.js';
import { base, docOp, img, pushDocHist } from './doc.js';
import { makeCanvas } from './dom.js';
import { makeAsset } from './assets.js';
import { composite, newObjId, objs, selectObj, setObjs, showObjs } from './objects.js';
import { S, sel, setSel } from './state.js';
import { commitText } from './text.js';
import { flash } from './toast.js';
import { setTool } from './tools.js';
import { requestRender, updateChrome } from './view.js';

// ---------- selection ----------
const inside = (p, r) => p.x >= r.x && p.y >= r.y && p.x < r.x + r.w && p.y < r.y + r.h;
// A colour-2 rectangle over r: what a lift leaves behind and what Delete paints (decision 7a). A
// filled rect on whole pixels (even width, so no half-pixel offset): crisp, the same as fillRect.
const patchObj = (r) => ({ t: 'rect', a: { x: r.x, y: r.y }, b: { x: r.x + r.w, y: r.y + r.h }, color: S.secondary, alt: S.secondary, size: 2, mode: 'fill' });
// Lift what is seen under the selection into a float, leaving a colour-2 patch object (shown at once,
// recorded with the float's commit as one undo step).
function liftSelection() {
  const f = makeCanvas(sel.w, sel.h);
  f.getContext('2d').drawImage(composite(), sel.x, sel.y, sel.w, sel.h, 0, 0, sel.w, sel.h);
  sel.before = objs;
  const patch = { ...patchObj(sel), id: newObjId(), z: Core.zBetween(objs.length ? objs[objs.length - 1].z : null, null) };
  showObjs(objs.concat(patch));
  sel.float = f;
  updateChrome();
}
// Commit a float: it becomes an image object on top (docs/objects.md, item 10), in one undo step
// with its lift's patch. A paste that grew the canvas becomes one whole-document step (original
// canvas and objects -> grown + pasted), so a single undo reverts both.
function commitSelection() {
  if (!sel || !sel.float) return;
  const img2 = { t: 'image', x: sel.x, y: sel.y, w: sel.w, h: sel.h, asset: makeAsset(sel.float) };
  sel.float = null;
  finishFloat([img2]);
  requestRender();
}
function finishFloat(add) {
  const before = sel.before || objs, now = objs;
  let top = now.length ? now[now.length - 1].z : null;
  const extra = add.map((o) => { top = Core.zBetween(top, null); return { ...o, id: newObjId(), z: top }; });
  const next = now.concat(extra);
  sel.before = null;
  if (sel.growFrom) {
    const from = sel.growFrom;
    sel.growFrom = null;
    showObjs(next);
    pushDocHist(from, before);
    return;
  }
  showObjs(before); // the patch was only shown: record lift + commit from the list before it
  if (next !== before) setObjs(next);
}
function dropSelection() {
  commitSelection();
  if (sel) { setSel(null); requestRender(); }
}
function deleteSelection() {
  if (!sel) return;
  if (sel.float) { sel.float = null; finishFloat([]); } // a lift: just its patch; a paste: nothing
  else setObjs(objs.concat({ ...patchObj(sel), id: newObjId(), z: Core.zBetween(objs.length ? objs[objs.length - 1].z : null, null) }));
  setSel(null);
  requestRender();
}
// Esc during the drag that lifted it: take the patch away again, no history entry.
function unlift() {
  if (sel.before) showObjs(sel.before);
  sel.before = null;
  sel.float = null;
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
  c.getContext('2d').drawImage(base, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
  docOp(c, (o) => Core.moveObj(o, -r.x, -r.y));
}

export { commitSelection, crop, deleteSelection, dropSelection, inside, liftSelection, nudge, selectAll, unlift };
