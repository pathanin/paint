import Core from './core.js';
import { hist, img, redo, undo } from './doc.js';
import { $, antsEl, clamp, makeCanvas, ov, setAttr, setData, setProp, setText, stage, vp } from './dom.js';
import { isDirty, save } from './fileio.js';
import { showGhost } from './handles.js';
import { groupBox, hasObjs, multi, objSel, objVer, objs, selList, selObj } from './objects.js';
import { objCursor, objGap, objTarget, updateRing } from './pointer.js';
import { crop, inside } from './selection.js';
import { S, SHAPES, drag, isClear, sel } from './state.js';
import { placeTextBox, textAt } from './text.js';
import { brushPath, drawShape, segsBox } from './tools.js';

// ---------- view ----------
// #overlay is only the pointer target (never drawn, so it has no backing store). Objects are in
// #image's cache (scene.js), so pan and zoom redraw nothing. Shape previews, the brush tail and
// floating selections are drawn on #preview, which covers just the visible part of the image
// (marching ants are the #ants element, at screen resolution). A document-sized overlay costs
// 400 MB at 100 MP, and twice that once shown.
const pv = $('#preview');
const octx = pv.getContext('2d');
// A snapshot of #image (createImageBitmap, the fill) leaves GPU work queued that only a frame with a
// changed canvas sends off; until one comes, the compositor's next frame waits for it (a fill click at
// 10000² showed nothing for ~300 ms). A transparent 1 px draw on the preview is such a change, and
// leaves its pixels as they are.
const blank = makeCanvas(1, 1);
const kickFrame = () => { octx.drawImage(blank, 0, 0); requestRender(); };

function layout() {
  stage.style.width = img.width * S.zoom + 'px';
  stage.style.height = img.height * S.zoom + 'px';
  stage.classList.toggle('pixelated', S.zoom * devicePixelRatio >= 1); // hard pixels, incl. 100% on Retina
  stage.classList.toggle('tiny', img.width * S.zoom < 48 || img.height * S.zoom < 48); // corner handle only
  if (textAt) placeTextBox();
  updateStatus();
  requestRender(); // the preview follows the view
}
function setZoom(z, cx, cy) {
  z = clamp(z, 0.05, 32);
  const r = img.getBoundingClientRect();
  if (cx == null) {
    const v = vp.getBoundingClientRect();
    cx = v.left + v.width / 2; cy = v.top + v.height / 2;
  }
  const ix = (cx - r.left) / S.zoom, iy = (cy - r.top) / S.zoom;
  S.zoom = z;
  layout();
  const r2 = img.getBoundingClientRect();
  vp.scrollLeft += r2.left + ix * z - cx;
  vp.scrollTop += r2.top + iy * z - cy;
}
// Buttons and keys step through familiar percentages (wheel/pinch stay continuous).
const ZOOMS = [0.05, 0.1, 0.25, 0.33, 0.5, 0.67, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32];
function zoomStep(dir) {
  const z = dir > 0 ? ZOOMS.find((v) => v > S.zoom * 1.001) : [...ZOOMS].reverse().find((v) => v < S.zoom / 1.001);
  if (z) setZoom(z);
}
function fitZoom(capAt1) {
  const pad = 2 * parseFloat(getComputedStyle(vp).paddingLeft);
  const z = Math.min((vp.clientWidth - pad) / img.width, (vp.clientHeight - pad) / img.height);
  // On open: never upscale, except icon-sized images, which get a whole-number zoom (crisp pixels).
  const small = img.width <= 64 && img.height <= 64;
  S.zoom = clamp(!capAt1 ? z : small ? clamp(Math.floor(z), 1, 8) : Math.min(1, z), 0.05, 32);
  layout();
}
function imgPt(e, r) {
  r = r || img.getBoundingClientRect();
  return { x: (e.clientX - r.left) * img.width / r.width, y: (e.clientY - r.top) * img.height / r.height };
}

let rafPending = false;
// The preview is redrawn only when what it shows changes (ovKey), and only the area drawn last
// time is cleared (ovBox): a static selection costs no canvas work. Moving or resizing the preview
// wipes it, so placePreview() resets both.
let ovKey = '', ovBox = null;
// pvAt: the image-px rect #preview covers, and k = its backing px per image px. k is 1 when the
// view is zoomed in (image px, CSS-scaled like #image), and screen resolution when zoomed out.
let pvAt = null;
function placePreview() {
  const z = S.zoom, k = Math.min(1, z * devicePixelRatio);
  const v = vp.getBoundingClientRect(), r = stage.getBoundingClientRect();
  const L = v.left + vp.clientLeft - r.left, T = v.top + vp.clientTop - r.top;
  const vis = { // visible image px
    x0: clamp(Math.floor(L / z), 0, img.width), y0: clamp(Math.floor(T / z), 0, img.height),
    x1: clamp(Math.ceil((L + vp.clientWidth) / z), 0, img.width), y1: clamp(Math.ceil((T + vp.clientHeight) / z), 0, img.height),
  };
  const a = pvAt;
  if (a && a.z === z && a.k === k && a.W === img.width && a.H === img.height &&
      vis.x0 >= a.x && vis.y0 >= a.y && vis.x1 <= a.x + a.w && vis.y1 <= a.y + a.h) return;
  // A quarter view of margin on each side, so short scrolls don't need a move (a reallocation and
  // redraw), while the backing stays near screen size.
  const mx = Math.ceil((vis.x1 - vis.x0) / 4) + 1, my = Math.ceil((vis.y1 - vis.y0) / 4) + 1;
  const x = Math.max(0, vis.x0 - mx), y = Math.max(0, vis.y0 - my);
  const w = Math.max(1, Math.min(img.width, vis.x1 + mx) - x), h = Math.max(1, Math.min(img.height, vis.y1 + my) - y);
  pvAt = { x, y, w, h, z, k, W: img.width, H: img.height };
  pv.width = Math.ceil(w * k); pv.height = Math.ceil(h * k); // also clears it
  Object.assign(pv.style, { left: x * z + 'px', top: y * z + 'px', width: w * z + 'px', height: h * z + 'px' });
  octx.setTransform(pv.width / w, 0, 0, pv.height / h, -x * pv.width / w, -y * pv.height / h);
  ovKey = ''; ovBox = null;
}
pv.addEventListener('contextrestored', () => { pvAt = null; ovKey = ''; ovBox = null; requestRender(); });
vp.addEventListener('scroll', () => requestRender(), { passive: true });
// The view can also grow (window resize, fullscreen) or change DPR (browser zoom, another monitor)
// with no scroll or pointer event: re-place the preview, and redo the pixelated/smooth choice.
new ResizeObserver(() => requestRender()).observe(vp);
(function watchDpr() {
  matchMedia(`(resolution: ${devicePixelRatio}dppx)`).addEventListener('change', () => { layout(); watchDpr(); }, { once: true });
})();
const floatIds = new WeakMap(); // canvas -> id, so a new float with the same geometry still redraws
let nFloats = 0;
const floatId = (c) => { if (!floatIds.has(c)) floatIds.set(c, ++nFloats); return floatIds.get(c); };
// The brush tail of an erasing (Transparent) stroke can't cut a hole in the preview, so it's
// painted with what the hole will show: #stage's checkerboard, at the same 16 CSS px period.
// Built once per colour scheme: reading the colours each frame would force a style recalc.
let checker = null;
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { checker = null; });
function checkerInk() {
  if (!checker) {
    const cs = getComputedStyle(stage), c = makeCanvas(16, 16), g = c.getContext('2d');
    g.fillStyle = cs.getPropertyValue('--check-a').trim(); g.fillRect(0, 0, 16, 16);
    g.fillStyle = cs.getPropertyValue('--check-b').trim(); g.fillRect(8, 0, 8, 8); g.fillRect(0, 8, 8, 8); // as repeating-conic-gradient(b 0 25%, a 0 50%)
    checker = octx.createPattern(c, 'repeat');
  }
  checker.setTransform(new DOMMatrix().scale(1 / S.zoom)); // image px -> CSS px
  return checker;
}
function requestRender() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(render);
}
// DOM writes for pointer feedback happen here, once per frame, never in the pointermove handler:
// a write there dirties layout, and Chrome's hit test for the follow-up mouse events then forces it.
function render() {
  rafPending = false;
  updateRing(hoverPt);
  const hit = !drag && hoverPt && hasObjs() ? objTarget(hoverPt) : null;
  if (!drag) setProp(ov.style, 'cursor', objCursor(hit) || (S.tool === 'move' ? 'grab' : '') || (S.tool === 'select' && sel && hoverPt && inside(hoverPt, sel) ? 'move' : ''));
  // The Move tool outlines the shape a click would pick (not the selected one: it has its own).
  placeObjHover(hit && !hit.h && (hit.erase || (S.tool === 'move' && hit.o.id !== objSel)) ? hit.o : null); // ⌥ + Eraser: what a click would delete
  if (drag && drag.t === 'canvas') showGhost(drag);
  const shape = drag && SHAPES.has(drag.t);
  const marquee = drag && (drag.t === 'select' || drag.t === 'objbox');
  const mq = marquee ? Core.normRect(drag.start, drag.end) : null;
  // Live end of a brush stroke: what release would add, so the ink always reaches the pointer.
  const tail = drag && drag.t === 'brush' ? drag.stroke.tail(drag.ptr) : null;
  const key = JSON.stringify([
    S.zoom,
    tail ? [tail, drag.color, drag.size] : 0,
    shape ? [drag.t, drag.start, drag.end, drag.shift, drag.color, drag.alt, S.sizes[drag.t], S.fillMode] : 0,
    mq || 0,
    sel && sel.float ? [sel.x, sel.y, sel.w, sel.h, floatId(sel.float)] : 0,
    multi.length ? [multi.join(), objVer] : 0,
  ]);
  placeAnts(mq || sel);
  placeObjSel(groupBox() || selObj());
  if (shape || (sel && sel.float) || (tail && tail.length) || multi.length) placePreview();
  if (key !== ovKey) {
    ovKey = key;
    if (ovBox) octx.clearRect(ovBox.x, ovBox.y, ovBox.w, ovBox.h);
    let box = null;
    const add = (r) => {
      const pad = 2 / S.zoom + 2; // stroke half-widths and antialiasing
      const b = { x: Math.floor(r.x - pad), y: Math.floor(r.y - pad), w: Math.ceil(r.w + 2 * pad) + 1, h: Math.ceil(r.h + 2 * pad) + 1 };
      if (!box) { box = b; return; }
      const x1 = Math.max(box.x + box.w, b.x + b.w), y1 = Math.max(box.y + box.h, b.y + b.h);
      box.x = Math.min(box.x, b.x); box.y = Math.min(box.y, b.y); box.w = x1 - box.x; box.h = y1 - box.y;
    };
    // Pixels-to-be (a floating selection, the brush tail), then a shape being drawn, over the image.
    if (sel && sel.float) { octx.drawImage(sel.float, sel.x, sel.y); add(sel); }
    if (tail && tail.length) { brushPath(octx, tail, isClear(drag.color) ? checkerInk() : drag.color, drag.size); add(segsBox(tail, drag.size / 2 + 1)); }
    if (shape) add(drawShape(octx, drag));
    if (multi.length) { // several selected: each one's outline, batched into one path (as tldraw does)
      const path = new Path2D(), lw = 1 / S.zoom;
      for (const o of selList()) { const f = Core.objFrame(o); path.rect(f.x, f.y, f.w, f.h); add(f); }
      octx.save(); octx.lineWidth = Math.max(lw, 1 / pvAt.k); octx.strokeStyle = '#0d99ff'; octx.stroke(path); octx.restore();
    }
    ovBox = box;
  }
  updateStatus();
}
// Marching ants around image rect r (or none), snapped to device px so they stay crisp.
let antsKey = '';
function placeAnts(r) {
  const z = S.zoom, d = devicePixelRatio, px = (v) => Math.round(v * z * d) / d;
  const key = r ? [px(r.x), px(r.y), px(r.x + r.w) - px(r.x), px(r.y + r.h) - px(r.y)].join() : '';
  if (key === antsKey) return;
  antsKey = key;
  antsEl.hidden = !r;
  if (!r) return;
  const [x, y, w, h] = key.split(',');
  Object.assign(antsEl.style, { left: x + 'px', top: y + 'px', width: Math.max(1, w) + 'px', height: Math.max(1, h) + 'px' });
}

// Outline and handles of the selected object, in device px like the ants (crisp at every zoom).
const objSelEl = $('#objsel');
const HANDLE_IDS = ['nw', 'ne', 'se', 'sw', 'n', 'e', 's', 'w', 'a', 'b'];
const handleEls = Object.fromEntries(HANDLE_IDS.map((h) => {
  const el = document.createElement('div');
  el.className = 'handle';
  objSelEl.appendChild(el);
  return [h, el];
}));
let objSelKey = '';
function placeObjSel(o) {
  const z = S.zoom, d = devicePixelRatio, px = (v) => Math.round(v * z * d) / d;
  const g = o && Core.drawnObj(o); // on the stroke, not half a pixel off it (odd widths)
  const r = o && Core.objFrame(o), ends = o && o.a ? [px(g.a.x), px(g.a.y), px(g.b.x), px(g.b.y)] : [];
  const key = o ? [z, o.t, px(r.x), px(r.y), px(r.x + r.w), px(r.y + r.h), ...ends].join() : '';
  if (key === objSelKey) return;
  objSelKey = key;
  objSelEl.hidden = !o;
  if (!o) return;
  const x = px(r.x), y = px(r.y);
  Object.assign(objSelEl.style, { left: x + 'px', top: y + 'px', width: px(r.x + r.w) - x + 'px', height: px(r.y + r.h) - y + 'px' });
  objSelEl.classList.toggle('line', o.t === 'line');
  const shown = new Map(Core.objHandles(o, objGap()).map((h) => [h.h, h]));
  for (const id of HANDLE_IDS) {
    const h = shown.get(id), el = handleEls[id];
    el.hidden = !h;
    if (h) el.style.transform = `translate(${px(h.x) - x}px, ${px(h.y) - y}px)`;
  }
}

// Outline of the shape under the pointer (Move tool): its box, its ellipse, or a bar along a line.
const objHoverEl = $('#objhover');
let objHoverKey = '';
function placeObjHover(o) {
  const z = S.zoom, d = devicePixelRatio, px = (v) => Math.round(v * z * d) / d;
  const f = o && Core.objFrame(o);
  const key = o ? [z, o.t, o.id, f.x, f.y, f.w, f.h].join() : '';
  if (key === objHoverKey) return;
  objHoverKey = key;
  objHoverEl.hidden = !o;
  if (!o) return;
  o = Core.drawnObj(o);
  objHoverEl.className = o.t === 'line' || o.t === 'ellipse' ? o.t : 'rect';
  if (o.t === 'line') {
    const ax = o.a.x * z, ay = o.a.y * z, len = Math.hypot(o.b.x - o.a.x, o.b.y - o.a.y) * z;
    Object.assign(objHoverEl.style, { left: ax + 'px', top: ay - 1 + 'px', width: len + 'px', height: '2px',
      transform: `rotate(${Math.atan2(o.b.y - o.a.y, o.b.x - o.a.x)}rad)` });
    return;
  }
  const r = f, x = px(r.x), y = px(r.y);
  Object.assign(objHoverEl.style, { left: x + 'px', top: y + 'px', width: px(r.x + r.w) - x + 'px', height: px(r.y + r.h) - y + 'px', transform: '' });
}

let cursor = null;  // integer image px under the pointer, for the status bar
let hoverPt = null; // the same point unrounded (null when the pointer is off the canvas); render() places the ring there
const setCursor = (c) => { cursor = c; };
const setHover = (p) => { hoverPt = p; };
const ZBTNS = [...document.querySelectorAll('.zorder button')];
const EL = {
  stPos: $('#stPos'), stSelWrap: $('#stSelWrap'), stSel: $('#stSel'), stSize: $('#stSize'),
  zoomBtn: $('#zoomBtn'), zoomIn: $('[data-cmd="zoomIn"]'), zoomOut: $('[data-cmd="zoomOut"]'), crop: $('#cropBtn'),
  docTitle: $('#docTitle'), docDirty: $('#docDirty'), save: $('[data-cmd="save"]'), undo: $('#undoBtn'), redo: $('#redoBtn'), stIntro: $('#stIntro'),
};
// Runs every frame and pointermove; everything is write-if-changed, so a still image costs ~nothing.
function updateStatus() {
  setText(EL.stPos, cursor ? `${cursor.x}, ${cursor.y} px` : '—');
  const so = selObj();
  const r = drag && drag.t === 'select' ? Core.normRect(drag.start, drag.end) : sel || (so && Core.objFrame(so));
  setProp(EL.stSelWrap, 'hidden', !r);
  setText(EL.stSel, r ? `${Math.round(r.w)} × ${Math.round(r.h)} px` : '');
  setAttr(img, 'aria-label', `Image, ${img.width} × ${img.height} px`);
  setText(EL.stSize, drag && drag.t === 'canvas'
    ? `${img.width} × ${img.height} → ${drag.w} × ${drag.h} px · Esc to cancel`
    : `${img.width} × ${img.height} px`);
  const pct = Math.round(S.zoom * 100) + '%';
  setText(EL.zoomBtn, pct);
  const none = !selList().length;
  for (const b of ZBTNS) setProp(b, 'disabled', none);
  setProp(EL.zoomIn, 'disabled', S.zoom >= ZOOMS[ZOOMS.length - 1] - 1e-9);
  setProp(EL.zoomOut, 'disabled', S.zoom <= ZOOMS[0] + 1e-9);
  setAttr(EL.zoomBtn, 'aria-label', `Zoom ${pct}. Activate for actual size`);
  // aria-disabled (not disabled) keeps Crop focusable, so keyboard users can reach the explanation.
  setAttr(EL.crop, 'aria-disabled', !sel);
  setData(EL.crop, 'hint', sel ? '' : 'Select an area first');
  setAttr(EL.crop, 'aria-description', sel ? null : 'Select an area first');
}
function updateChrome() {
  const dirty = isDirty();
  setProp(document, 'title', (dirty ? '● ' : '') + S.fileName + ' — Paint');
  setText(EL.docTitle, S.fileName);
  setProp(EL.docDirty, 'hidden', !dirty);
  document.body.classList.toggle('dirty', dirty);
  setAttr(EL.save, 'aria-label', dirty ? 'Save (unsaved changes)' : 'Save');
  setData(EL.save, 'hint', dirty ? 'Unsaved changes' : '');
  setProp(EL.undo, 'disabled', !hist.canUndo() && !(sel && sel.float)); // undo drops a floating paste/move
  setProp(EL.stIntro, 'hidden', !S.pristine || !!textAt);
  setProp(EL.redo, 'disabled', !hist.canRedo());
}

export { fitZoom, imgPt, kickFrame, layout, requestRender, setCursor, setHover, setZoom, updateChrome, updateStatus, zoomStep };
