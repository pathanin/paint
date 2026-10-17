import Core from './core.js';
import { $ } from './dom.js';
import { applyObjHist, mapObjs, resetObjs, syncBase } from './objects.js';
import { commitSelection } from './selection.js';
import { S, drag, sel, setDrag, setSel } from './state.js';
import { commitText } from './text.js';
import { gpuLost } from './gpu.js';
import { markAll } from './scene.js';
import { flash } from './toast.js';
import { fitZoom, layout, requestRender, updateChrome } from './view.js';

// ---------- document & history ----------
// Two document-sized canvases. base holds the pixels (the opened picture and pixel edits); #image
// (img) is what you see, save, copy and pick from: base with every object drawn over it, a cache
// that only scene.js's redraw() writes. Whole-image ops (crop, rotate, resize...) swap in a new
// base canvas rather than copying pixels, and undo swaps it back, so base and bctx are reassigned
// by adoptImage(); img is always the #image element.
const img = $('#image');
const ctx = img.getContext('2d');
let base = document.createElement('canvas');
let bctx = base.getContext('2d');
base.addEventListener('contextlost', () => gpuLost());
img.addEventListener('contextrestored', () => markAll()); // it comes back blank: repaint the scene

// Dropped doc entries hold whole canvases: free them now (width 0) rather than at some later GC.
const hist = new Core.History({ maxBytes: 256 * 1024 * 1024, maxCount: 100, onDrop: (e) => {
  if (e.type === 'doc') e.canvas.width = 0;
} });

// Make canvas c the base, without copying it; #image takes its size and is repainted.
function adoptImage(c) {
  if (c === base) return;
  base = c;
  bctx = c.getContext('2d');
  c.addEventListener('contextlost', gpuLost);
  fitView();
}
function fitView() {
  if (img.width !== base.width || img.height !== base.height) { img.width = base.width; img.height = base.height; }
  markAll();
}
// source: a canvas to adopt as the base, a bitmap to draw into it, or null for white.
function setDoc(source, w, h) {
  if (source instanceof HTMLCanvasElement) adoptImage(source);
  else {
    base.width = w; base.height = h; // also clears it
    if (source) bctx.drawImage(source, 0, 0);
    else { bctx.fillStyle = '#ffffff'; bctx.fillRect(0, 0, w, h); }
    fitView();
  }
  setSel(null); setDrag(null);
  syncBase();
  layout();
  requestRender();
}

// Replace the whole document (crop/resize/rotate/...) as one undo step. The entry keeps the old
// canvas element itself; undo and redo swap it with the live one. No pixels are copied.
// map (crop, resize, rotate, flip): where each object goes in the new image. Objects stay objects;
// one left wholly outside the new image is dropped. The entry keeps the old list, so one undo
// restores both (applyObjHist swaps e.objs like an obj entry's).
function docOp(next, map) {
  commitText();
  commitSelection();
  const before = base;
  setDoc(next);
  const objsBefore = map ? mapObjs(map, base.width, base.height) : null;
  pushDocHist(before, objsBefore);
}
const pushDocHist = (before, objs) => pushHist({ type: 'doc', canvas: before, bytes: before.width * before.height * 4, ...(objs && { objs }) });
function pushHist(e) {
  if (hist.push(e) && !S.trimWarned) {
    S.trimWarned = true;
    flash('Oldest undo steps were dropped to save memory');
  }
  S.pristine = false;
  updateChrome();
}
// Each entry holds the pixels of the *other* state (before when on the undo stack, after when on
// the redo stack); applying it swaps them with what's on the canvas, so one copy serves both ways.
function applyHist(e) {
  applyObjHist(e); // obj entries, a flatten's region entry, and a crop/resize/rotate/flip's doc entry
  if (e.type === 'doc') {
    const other = e.canvas;
    e.canvas = base;
    setDoc(other);
  }
  updateChrome();
  requestRender();
}
function undo() {
  if (drag) return;
  commitText();
  commitSelection();
  if (sel) { setSel(null); requestRender(); } // the marquee would outline pixels that just changed
  const e = hist.undo();
  if (e) applyHist(e);
}
function redo() {
  if (drag) return;
  commitText();
  commitSelection();
  if (sel) { setSel(null); requestRender(); }
  const e = hist.redo();
  if (e) applyHist(e);
}

function newDoc(w, h) {
  commitText();
  setDoc(null, w, h);
  hist.clear();
  resetObjs();
  Object.assign(S, { fileHandle: null, fileName: 'untitled.png', pristine: true, trimWarned: false });
  fitZoom(true);
  updateChrome();
}

export { base, bctx, ctx, docOp, hist, img, newDoc, pushDocHist, pushHist, redo, setDoc, undo };
