import Core from './core.js';
import { bctx, hist, img, pushHist } from './doc.js';
import { flushRedraw, sceneSwap } from './scene.js';
import { commitSelection } from './selection.js';
import { commitText } from './text.js';
import { beginOp, endOp, touch } from './tiles.js';
import { announce } from './toast.js';
import { requestRender } from './view.js';

// ---------- objects ----------
// Immutable objects (docs/objects.md, docs/total-objects.md), bottom to top, each with a fractional
// z-key (o.z, Core.zBetween) that sorts like the list, so the scene's R-tree hits sort into z order
// and an undo entry can put an object back without knowing its index. They are drawn into #image's
// cache over the base (scene.js), and are pixels only once flattened. objSel is the selected
// object's id; objVer bumps on every change.
let objs = [], objSel = null, objVer = 0, nextObjId = 1;
const selObj = () => (objSel == null ? null : objs.find((o) => o.id === objSel) || null);
// Every change of the list goes through here: the scene's index and redraw follow it.
// pairs: the change as [now, then] pairs when the caller knows it (an add), so a scene of thousands
// isn't walked to find it.
function install(next, pairs) {
  const prev = objs;
  objs = next; objVer++;
  sceneSwap(prev, next, pairs);
}
// History entries hold diffs, not lists (Core.diffObjs / applyPairs), so an entry's size is per
// object changed, not per object in the scene.
const { diffObjs, applyPairs } = Core;
const pairBytes = (n) => 64 + 64 * n;
// Replace the object list as one undo step. Edits that arrive as a stream (held arrows, a colour
// well being dragged, [ and ]) pass a key: while the newest entry is the one pushed with that key,
// they fold into it, so a gesture is one step and can't push other history out. Not on the save
// point, or isDirty() would lie.
let objRun = null; // {key, entry} of the last keyed push
function setObjs(next, key, known) {
  const pairs = known || diffObjs(objs, next);
  if (!pairs.length) return;
  const top = hist.top();
  if (key && objRun && objRun.key === key && objRun.entry === top && !hist.isClean()) {
    const e = objRun.entry, at = new Map(e.pairs.map((p) => [(p[0] || p[1]).id, p]));
    for (const [n, t] of pairs) {
      const p = at.get((n || t).id);
      if (p) p[0] = n; else e.pairs.push([n, t]);
    }
    e.pairs = e.pairs.filter(([n, t]) => n || t);
    install(next, pairs);
    requestRender();
    return;
  }
  const entry = { type: 'obj', pairs, bytes: pairBytes(pairs.length) };
  pushHist(entry);
  objRun = key ? { key, entry } : null;
  install(next, pairs);
  requestRender();
}
// The list changed under a gesture or an Esc (no history entry of its own). sel: the id to select.
function showObjs(next, sel) { install(next); if (sel !== undefined) objSel = sel; }
const newObjId = () => nextObjId++;
// A z-key just above o (between it and the next object up), for a copy placed over its original.
function zAbove(o) {
  const i = objs.indexOf(o);
  return Core.zBetween(o.z, i + 1 < objs.length ? objs[i + 1].z : null);
}
// A whole-image op (crop, resize, rotate, flip): map every object to its place in the new w × h image.
// One left wholly outside is dropped. Returns the list before (for the doc entry), or null if empty.
function mapObjs(map, w, h) {
  if (!objs.length) return null;
  const before = objs;
  install(objs.map(map).filter((o) => { const b = Core.objBox(o); return b.x < w && b.y < h && b.x + b.w > 0 && b.y + b.h > 0; }));
  if (!selObj()) objSel = null;
  return before;
}
function resetObjs() { install([]); objSel = null; }
// Undo/redo of an obj entry (a diff), or of a flatten's region entry or a whole-image op's doc entry
// (a whole list, swapped in).
function applyObjHist(e) {
  objRun = null;
  if (e.pairs) {
    const back = e.pairs.map(([n, t]) => [t, n]); // after applying, what the entry holds to go back
    install(applyPairs(objs, e.pairs), back);
    e.pairs = back;
  } else if (e.objs) {
    const o = objs; install(e.objs); e.objs = o;
  } else return;
  if (!selObj()) objSel = null;
}
// The end of a move or resize drag: one undo step from the list before it.
function commitObjDrag(before) {
  const pairs = diffObjs(before, objs);
  if (!pairs.length) return;
  objRun = null;
  pushHist({ type: 'obj', pairs, bytes: pairBytes(pairs.length) });
}
const withObj = (o) => objs.map((x) => (x.id === o.id ? o : x));
// A new object goes on top.
function addObj(o) {
  o = { ...o, id: nextObjId++, z: Core.zBetween(objs.length ? objs[objs.length - 1].z : null, null) };
  setObjs(objs.concat(o), undefined, [[o, null]]);
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
// Move the selected object one step up (dir 1) or down (-1) the stack: it trades z-keys with the
// neighbour it passes.
function reorderObj(dir) {
  const o = selObj(), i = objs.indexOf(o), j = i + dir;
  if (!o || j < 0 || j >= objs.length) return;
  const nb = objs[j], next = objs.slice();
  next[i] = { ...nb, z: o.z }; next[j] = { ...o, z: nb.z };
  setObjs(next);
}
// Bake every object into the pixels as one undo step: a region entry that also keeps the object
// list, so undo brings the objects back and un-bakes their pixels together. The pixels are copied
// from the cache, so the base gets exactly what is on screen (drawing the objects again, in another
// batch, could anti-alias their edges differently: see scene.js).
function flattenObjs() {
  if (!objs.length) return;
  commitText();
  commitSelection(); // a floating selection sits under the objects
  flushRedraw();
  beginOp();
  const W = img.width, H = img.height;
  for (const o of objs) {
    const r = Core.clampRect(Core.objBox(o), W, H);
    if (!r) continue;
    touch(r.x, r.y, r.w, r.h);
    bctx.clearRect(r.x, r.y, r.w, r.h);
    bctx.drawImage(img, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
  }
  const before = objs;
  install([]); objSel = null;
  endOp({ objs: before });
  requestRender();
}
// What the document looks like: #image, the scene's cache, once any pending redraw has landed.
function composite() {
  flushRedraw();
  return img;
}

export { addObj, applyObjHist, commitObjDrag, composite, cycleObj, deleteObj, duplicateObj, flattenObjs, mapObjs, newObjId, nudgeObj, objs, objSel, objVer, reorderObj, resetObjs, restyleObj, selectObj, selObj, showObjs, zAbove };
