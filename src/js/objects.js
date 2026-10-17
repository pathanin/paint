import Core from './core.js';
import { base, hist, img, pushDocHist, pushHist, setDoc } from './doc.js';
import { cloneCanvas } from './dom.js';
import { flushRedraw, sceneSwap } from './scene.js';
import { commitSelection } from './selection.js';
import { commitText } from './text.js';
import { announce } from './toast.js';
import { requestRender } from './view.js';

// ---------- objects ----------
// Immutable objects (docs/objects.md, docs/total-objects.md), bottom to top, each with a fractional
// z-key (o.z, Core.zBetween) that sorts like the list, so the scene's R-tree hits sort into z order
// and an undo entry can put an object back without knowing its index. They are drawn into #image's
// cache over the base (scene.js), and are pixels only once flattened. objSel is the selected
// object's id; objVer bumps on every change.
let objs = [], objSel = null, objVer = 0, nextObjId = 1;
// Several objects selected at once (a box drag or ⇧-click with the Move tool): their ids, with objSel
// null. One selected object is objSel alone, with its handles.
let multi = [];
const selList = () => (multi.length ? objs.filter((o) => multi.includes(o.id)) : selObj() ? [selObj()] : []);
function selectMany(ids) {
  ids = [...new Set(ids)].filter((id) => objs.some((o) => o.id === id));
  if (ids.length === 1) { multi = []; objSel = ids[0]; } else { multi = ids; objSel = null; }
  objVer++;
  requestRender();
}
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
// An entry costs ~64 bytes per object changed, plus the bitmap of any asset it brings in.
const pairBytes = (pairs) => pairs.reduce((b, [n, t]) => b + 64 + (n && n.asset && (!t || t.asset !== n.asset) ? n.asset.bytes : 0), 64);
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
  const entry = { type: 'obj', pairs, bytes: pairBytes(pairs) };
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
  multi = [];
  return before;
}
function resetObjs() { install([]); objSel = null; multi = []; }
// Objects read back from a saved file (persist.js): the list as it was, ids from where it left off.
function loadObjs(list, nextId) { install(list); objSel = null; multi = []; nextObjId = Math.max(nextId || 1, ...list.map((o) => o.id + 1)); }
const objIdNext = () => nextObjId;
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
  multi = multi.filter((id) => objs.some((o) => o.id === id));
}
// The end of a move or resize drag: one undo step from the list before it.
function commitObjDrag(before) {
  const pairs = diffObjs(before, objs);
  if (!pairs.length) return;
  objRun = null;
  pushHist({ type: 'obj', pairs, bytes: pairBytes(pairs) });
}
const withObj = (o) => objs.map((x) => (x.id === o.id ? o : x));
// A new object goes on top, selected (opt.keepSel: a stroke leaves the selection as it was).
function addObj(o, opt) {
  o = { ...o, id: nextObjId++, z: Core.zBetween(objs.length ? objs[objs.length - 1].z : null, null) };
  setObjs(objs.concat(o), undefined, [[o, null]]);
  if (!(opt && opt.keepSel)) objSel = o.id;
  return o;
}
function selectObj(id) {
  if (objSel === id && !multi.length) return;
  objSel = id; multi = []; objVer++;
  requestRender();
}
// Tab / ⇧Tab on the canvas with the Move tool: the next or previous shape, in drawing order. Past
// either end it deselects and returns false, so the key moves focus on as usual (no focus trap).
const OBJ_NAMES = { line: 'Line', rect: 'Rectangle', ellipse: 'Ellipse', pencil: 'Pencil stroke', eraser: 'Eraser stroke', brush: 'Brush stroke', text: 'Text', image: 'Image', fill: 'Fill' };
function cycleObj(dir) {
  const i = objs.findIndex((o) => o.id === objSel), j = i < 0 ? (dir > 0 ? 0 : -1) : i + dir;
  if (j < 0 || j >= objs.length) { if (objSel != null) selectObj(null); return false; }
  const o = objs[j], r = Core.objFrame(o);
  selectObj(o.id);
  announce(`${OBJ_NAMES[o.t]}, ${Math.round(r.w)} × ${Math.round(r.h)} px at ${Math.round(r.x)}, ${Math.round(r.y)}. Shape ${j + 1} of ${objs.length}`);
  return true;
}
function deleteObj() {
  const list = selList();
  if (!list.length) return false;
  objSel = null; multi = [];
  setObjs(objs.filter((x) => !list.includes(x)));
  return true;
}
function nudgeObj(dx, dy) {
  const list = selList();
  if (!list.length) return;
  setObjs(objs.map((x) => (list.includes(x) ? Core.moveObj(x, dx, dy) : x)), 'nudge:' + list.map((o) => o.id).join());
}
// key: coalesce a stream of the same restyle (see setObjs).
function restyleObj(props, key) {
  const o = selObj();
  if (!o || Object.keys(props).every((k) => o[k] === props[k])) return;
  setObjs(withObj({ ...o, ...props }), key && key + ':' + o.id);
}
function duplicateObj() {
  const list = selList();
  if (!list.length) return;
  let top = objs[objs.length - 1].z;
  const copies = list.map((o) => { top = Core.zBetween(top, null); return { ...Core.moveObj(o, 10, 10), id: nextObjId++, z: top }; });
  setObjs(objs.concat(copies));
  selectMany(copies.map((o) => o.id));
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
// Bake every object into the pixels (⌘E) as one undo step: the base becomes a copy of the cache, so it
// gets exactly what is on screen (drawing the objects again, in another batch, could anti-alias their
// edges differently: see scene.js). A whole-document step, like a crop: it keeps the old base and the
// object list, so undo brings both back.
function flattenObjs() {
  if (!objs.length) return;
  commitText();
  commitSelection(); // a floating selection is about to become an object too
  flushRedraw();
  const before = base, list = objs;
  setDoc(cloneCanvas(img));
  install([]); objSel = null; multi = [];
  pushDocHist(before, list);
  requestRender();
}
// What the document looks like: #image, the scene's cache, once any pending redraw has landed.
function composite() {
  flushRedraw();
  return img;
}

export { addObj, loadObjs, multi, objIdNext, selectMany, selList, applyObjHist, commitObjDrag, composite, cycleObj, deleteObj, duplicateObj, flattenObjs, mapObjs, newObjId, nudgeObj, objs, objSel, objVer, reorderObj, resetObjs, restyleObj, selectObj, selObj, setObjs, showObjs, zAbove };
