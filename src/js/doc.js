import Core from './core.js';
import { $ } from './dom.js';
import { applyFill } from './fill.js';
import { applyObjHist, resetObjs } from './objects.js';
import { commitSelection } from './selection.js';
import { S, drag, sel, setDrag, setSel } from './state.js';
import { commitText } from './text.js';
import { dropOp, gpuLost, release, swapParts } from './tiles.js';
import { flash } from './toast.js';
import { fitZoom, layout, requestRender, updateChrome } from './view.js';

// ---------- document & history ----------
// The document canvas. Whole-image ops (crop, rotate, resize...) swap in a new element rather than
// copying pixels, and undo swaps it back, so these are reassigned by adoptImage().
let img = $('#image');
let ctx = img.getContext('2d');
img.addEventListener('contextlost', () => gpuLost());

// Dropped doc entries hold whole canvases: free them now (width 0) rather than at some later GC.
const hist = new Core.History({ maxBytes: 256 * 1024 * 1024, maxCount: 100, onDrop: (e) => {
  if (e.type === 'doc') e.canvas.width = 0;
  else if (e.type === 'region') e.parts.forEach(release);
} });

// Make canvas c the document, without copying it: it replaces #image in the page.
function adoptImage(c) {
  if (c === img) return;
  c.id = 'image';
  c.setAttribute('role', 'img');
  img.replaceWith(c);
  img.removeAttribute('id');
  img = c;
  ctx = c.getContext('2d');
  c.addEventListener('contextlost', gpuLost);
}
// source: a canvas to adopt as the document, a bitmap to draw into it, or null for white.
function setDoc(source, w, h) {
  if (source instanceof HTMLCanvasElement) adoptImage(source);
  else {
    img.width = w; img.height = h; // also clears it
    if (source) ctx.drawImage(source, 0, 0);
    else { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h); }
  }
  dropOp();
  setSel(null); setDrag(null);
  layout();
  requestRender();
}

// Replace the whole document (crop/resize/rotate/...) as one undo step. The entry keeps the old
// canvas element itself; undo and redo swap it with the live one. No pixels are copied.
function docOp(next) {
  commitText();
  commitSelection();
  const before = img;
  setDoc(next);
  pushDocHist(before);
}
const pushDocHist = (before) => pushHist({ type: 'doc', canvas: before, bytes: before.width * before.height * 4 });
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
  applyObjHist(e); // obj entries, and a flatten's region entry
  if (e.type === 'region') swapParts(e.parts);
  else if (e.type === 'fill') applyFill(e);
  else if (e.type === 'doc') {
    const other = e.canvas;
    e.canvas = img;
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

export { ctx, docOp, hist, img, newDoc, pushDocHist, pushHist, redo, setDoc, undo };
