import Core from './core.js';
import { ctx, hist, img, pushHist } from './doc.js';
import { cloneCanvas } from './dom.js';
import { commitSelection } from './selection.js';
import { commitText } from './text.js';
import { beginOp, endOp, touch } from './tiles.js';
import { drawObj } from './tools.js';
import { announce } from './toast.js';
import { requestRender } from './view.js';

// ---------- objects ----------
// Live shapes (docs/objects.md): immutable objects drawn above #image, bottom to top. They are
// pixels only once flattened. objSel is the selected object's id; objVer bumps on every change.
let objs = [], objSel = null, objVer = 0, nextObjId = 1;
const selObj = () => (objSel == null ? null : objs.find((o) => o.id === objSel) || null);
// Replace the object list as one undo step (the entry keeps the list before, and swaps on apply).
// Edits that arrive as a stream (held arrows, a colour well being dragged, [ and ]) pass a key:
// while the newest entry is the one pushed with that key, they update in place, so a gesture is
// one step and can't push pixel history out. Not on the save point, or isDirty() would lie.
let objRun = null; // {key, entry} of the last keyed push
function setObjs(next, key) {
  const top = hist.top();
  if (key && objRun && objRun.key === key && objRun.entry === top && !hist.isClean()) {
    objs = next; objVer++;
    requestRender();
    return;
  }
  const entry = { type: 'obj', objs, bytes: 128 * (objs.length + 1) };
  pushHist(entry);
  objRun = key ? { key, entry } : null;
  objs = next; objVer++;
  requestRender();
}
// The list changed under a gesture or an Esc (no history entry of its own). sel: the id to select.
function showObjs(next, sel) { objs = next; if (sel !== undefined) objSel = sel; objVer++; }
const newObjId = () => nextObjId++;
// A whole-image op (crop, resize, rotate, flip): map every object to its place in the new w × h image.
// One left wholly outside is dropped. Returns the list before (for the doc entry), or null if empty.
function mapObjs(map, w, h) {
  if (!objs.length) return null;
  const before = objs;
  objs = objs.map(map).filter((o) => { const b = Core.objBox(o); return b.x < w && b.y < h && b.x + b.w > 0 && b.y + b.h > 0; });
  objVer++;
  if (!selObj()) objSel = null;
  return before;
}
function resetObjs() { objs = []; objSel = null; objVer++; }
// Undo/redo of an obj entry, or of a flatten's region entry: swap in the list the entry keeps.
function applyObjHist(e) {
  objRun = null;
  if (e.objs) {
    const o = objs; objs = e.objs; e.objs = o; objVer++;
    if (!selObj()) objSel = null;
  }
}
// The end of a move or resize drag: one undo step from the list before it.
function commitObjDrag(before) {
  if (objs !== before) { const after = objs; objs = before; setObjs(after); }
}
const withObj = (o) => objs.map((x) => (x.id === o.id ? o : x));
function addObj(o) {
  o = { ...o, id: nextObjId++ };
  setObjs(objs.concat(o));
  objSel = o.id;
}
function selectObj(id) {
  if (objSel === id) return;
  objSel = id; objVer++;
  requestRender();
}
// Tab / ⇧Tab on the canvas with the Move tool: the next or previous shape, in drawing order. Past
// either end it deselects and returns false, so the key moves focus on as usual (no focus trap).
const OBJ_NAMES = { line: 'Line', rect: 'Rectangle', ellipse: 'Ellipse' };
function cycleObj(dir) {
  const i = objs.findIndex((o) => o.id === objSel), j = i < 0 ? (dir > 0 ? 0 : -1) : i + dir;
  if (j < 0 || j >= objs.length) { if (objSel != null) selectObj(null); return false; }
  const o = objs[j], r = Core.normRect(o.a, o.b);
  selectObj(o.id);
  announce(`${OBJ_NAMES[o.t]}, ${r.w} × ${r.h} px at ${r.x}, ${r.y}. Shape ${j + 1} of ${objs.length}`);
  return true;
}
function deleteObj() {
  const o = selObj();
  if (!o) return false;
  objSel = null;
  setObjs(objs.filter((x) => x !== o));
  return true;
}
function nudgeObj(dx, dy) { const o = selObj(); if (o) setObjs(withObj(Core.moveObj(o, dx, dy)), 'nudge:' + o.id); }
// key: coalesce a stream of the same restyle (see setObjs).
function restyleObj(props, key) {
  const o = selObj();
  if (!o || Object.keys(props).every((k) => o[k] === props[k])) return;
  setObjs(withObj({ ...o, ...props }), key && key + ':' + o.id);
}
function duplicateObj() {
  const o = selObj();
  if (!o) return;
  addObj(Core.moveObj(o, 10, 10));
}
// Move the selected object one step up (dir 1) or down (-1) the stack.
function reorderObj(dir) {
  const o = selObj(), i = objs.indexOf(o), j = i + dir;
  if (!o || j < 0 || j >= objs.length) return;
  const next = objs.slice();
  next[i] = next[j]; next[j] = o;
  setObjs(next);
}
// Bake every object into the pixels as one undo step: a region entry that also keeps the object
// list, so undo brings the objects back and un-bakes their pixels together.
function flattenObjs() {
  if (!objs.length) return;
  commitText();
  commitSelection(); // a floating selection sits under the objects
  beginOp();
  for (const o of objs) { const b = Core.objBox(o); touch(b.x, b.y, b.w, b.h); }
  for (const o of objs) drawObj(ctx, o);
  const before = objs;
  objs = []; objSel = null; objVer++;
  endOp({ objs: before });
  requestRender();
}
// What the document looks like: #image, or a copy with the objects drawn over it.
function composite() {
  if (!objs.length) return img;
  const c = cloneCanvas(img), g = c.getContext('2d');
  for (const o of objs) drawObj(g, o);
  return c;
}

export { addObj, applyObjHist, commitObjDrag, composite, cycleObj, deleteObj, duplicateObj, flattenObjs, mapObjs, newObjId, nudgeObj, objs, objSel, objVer, reorderObj, resetObjs, restyleObj, selectObj, selObj, showObjs };
