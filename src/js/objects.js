import Core from './core.js';
import { base, hist, img, pushDocHist, pushHist, setDoc } from './doc.js';
import { cloneCanvas, makeCanvas } from './dom.js';
import { makeAsset } from './assets.js';
import { S } from './state.js';
import { drawObj } from './tools.js';
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
// The box around a selected group, as a rectangle shape (its handles resize the group), or null.
function groupBox() {
  if (multi.length < 2) return null;
  const fs = selList().map((o) => Core.objFrame(o));
  const x0 = Math.floor(Math.min(...fs.map((f) => f.x))), y0 = Math.floor(Math.min(...fs.map((f) => f.y)));
  const x1 = Math.ceil(Math.max(...fs.map((f) => f.x + f.w))), y1 = Math.ceil(Math.max(...fs.map((f) => f.y + f.h)));
  return { t: 'rect', id: -1, a: { x: x0, y: y0 }, b: { x: x1, y: y1 }, size: 2, mode: 'outline' };
}
const selList = () => (multi.length ? objs.filter((o) => multi.includes(o.id)) : selObj() ? [selObj()] : []);
function selectMany(ids) {
  ids = [...new Set(ids)].filter((id) => objs.some((o) => o.id === id));
  if (ids.length === 1) { multi = []; objSel = ids[0]; } else { multi = ids; objSel = null; }
  objVer++;
  requestRender();
}
// The opened picture is the bottom object (decision 6): {t: 'base', locked, x: 0, y: 0, w, h, asset} over
// the base canvas, with a z-key below every other (Core.BASE_Z, so the keys above it stay short).
// Locked: never hit, picked, box-selected, moved, reordered or deleted. It's replaced whenever the
// base canvas is (syncBase(), from doc.js). A saved list with keys not above it is re-keyed on load.
const BASE_Z = Core.BASE_Z;
const isBase = (o) => o.t === 'base';
const baseRec = () => ({ t: 'base', id: 0, z: BASE_Z, locked: true, x: 0, y: 0, w: base.width, h: base.height, asset: { cv: base, bytes: 0 } }); // the base canvas itself: no copy (it'd be the whole picture again)
const hasObjs = () => objs.some((o) => !isBase(o));
function syncBase() {
  if (objs[0] && isBase(objs[0]) && objs[0].asset.cv === base) return;
  install([baseRec()].concat(objs.filter((o) => !isBase(o))));
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
  if (!hasObjs()) return null;
  const before = objs;
  install(objs.map((o) => (isBase(o) ? o : map(o))).filter((o) => { const b = Core.objBox(o); return isBase(o) || (b.x < w && b.y < h && b.x + b.w > 0 && b.y + b.h > 0); }));
  if (!selObj()) objSel = null;
  multi = [];
  return before;
}
function resetObjs() { install([baseRec()]); objSel = null; multi = []; }
// Objects read back from a saved file (persist.js): the list as it was, ids from where it left off.
function loadObjs(list, nextId) { install([baseRec()].concat(Core.zAboveBase(list))); objSel = null; multi = []; nextObjId = Math.max(nextId || 1, ...list.map((o) => o.id + 1)); }
const objIdNext = () => nextObjId;
const userObjs = () => objs.filter((o) => !isBase(o));
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
  const objs = userObjs();
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
// Arrange the selection (one object or a group) in the stack: dir 1 / -1 one step up / down past the
// next object that isn't selected, 'front' / 'back' to the top / just above the base. One undo step.
function reorderObj(dir) {
  const list = selList();
  if (!list.length) return;
  const rest = objs.filter((o) => !list.includes(o));
  let at; // index in rest after which the selection goes
  if (dir === 'front') at = rest.length - 1;
  else if (dir === 'back') at = 0; // just above the base
  else {
    const first = objs.indexOf(list[0]), last = objs.indexOf(list[list.length - 1]);
    const below = rest.filter((o) => objs.indexOf(o) < first).length - 1; // the one under the lowest selected
    if (dir > 0) { const above = rest.findIndex((o) => objs.indexOf(o) > last); if (above < 0) return; at = above; }
    else { if (below < 1) return; at = below - 1; }
  }
  const lo = rest[at] ? rest[at].z : null, hi = rest[at + 1] ? rest[at + 1].z : null;
  let z = lo;
  const moved = list.map((o) => { z = Core.zBetween(z, hi); return { ...o, z }; });
  setObjs(rest.slice(0, at + 1).concat(moved, rest.slice(at + 1)));
}
// The Fill tool inside a closed shape: the shape takes the colour as its fill (one undo step).
function fillShape(o, c) {
  const next = o.mode === 'fill' ? { ...o, color: c } : { ...o, mode: 'both', alt: c };
  setObjs(objs.map((x) => (x.id === o.id ? next : x)));
}
// ⌘E with objects selected: just those become one image object, in place of the topmost of them.
function flattenSelected() {
  const list = selList();
  if (!list.length) return false;
  const bs = list.map((o) => Core.objBox(o)), x = Math.min(...bs.map((b) => b.x)), y = Math.min(...bs.map((b) => b.y));
  const c = makeCanvas(Math.max(...bs.map((b) => b.x + b.w)) - x, Math.max(...bs.map((b) => b.y + b.h)) - y), g = c.getContext('2d');
  g.translate(-x, -y);
  for (const o of list) drawObj(g, o);
  const top = list[list.length - 1];
  const im = { t: 'image', x, y, w: c.width, h: c.height, asset: makeAsset(c), id: nextObjId++, z: top.z };
  setObjs(objs.filter((o) => !list.includes(o) || o === top).map((o) => (o === top ? im : o)));
  selectObj(im.id);
  return true;
}
// Bake every object into the pixels (⌘E) as one undo step: the base becomes a copy of the cache, so it
// gets exactly what is on screen (drawing the objects again, in another batch, could anti-alias their
// edges differently: see scene.js). A whole-document step, like a crop: it keeps the old base and the
// object list, so undo brings both back.
function flattenObjs() {
  if (!hasObjs() || (S.tool === 'move' && flattenSelected())) return;
  commitText();
  commitSelection(); // a floating selection is about to become an object too
  flushRedraw();
  const before = base, list = objs;
  setDoc(cloneCanvas(img));
  install(objs.filter(isBase)); objSel = null; multi = [];
  pushDocHist(before, list);
  requestRender();
}
// What the document looks like: #image, the scene's cache, once any pending redraw has landed.
function composite() {
  flushRedraw();
  return img;
}

export { addObj, groupBox, hasObjs, isBase, syncBase, userObjs, fillShape, loadObjs, multi, objIdNext, selectMany, selList, applyObjHist, commitObjDrag, composite, cycleObj, deleteObj, duplicateObj, flattenObjs, mapObjs, newObjId, nudgeObj, objs, objSel, objVer, reorderObj, resetObjs, restyleObj, selectObj, selObj, setObjs, showObjs, zAbove };
