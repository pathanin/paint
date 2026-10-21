import Core from './core.js';
import { img } from './doc.js';
import { $, MAC, clamp, ov, ring, setProp, stage, textBox, vp } from './dom.js';
import { doFill } from './fill.js';
import { endCanvasDrag } from './handles.js';
import { addObj, commitObjDrag, fillShape, groupBox, multi, newObjId, objSel, objs, restoreSel, selectMany, selObj, selectObj, showObjs, zAbove } from './objects.js';
import { endLive, flushRedraw, frameOf, growLive, hitAt, objsIn, setLive } from './scene.js';
import { dropSelection, inside, liftSelection, unlift } from './selection.js';
import { S, SHAPES, drag, isClear, sel, setDrag, setSel } from './state.js';
import { commitText, startText } from './text.js';
import { flash } from './toast.js';
import { pick, shapeObj } from './tools.js';
import { imgPt, requestRender, setCursor, setHover, setZoom, updateChrome, updateStatus, visible } from './view.js';

// ---------- pointer ----------
// Object editing under the pointer, for the move tool (any object; elsewhere it pans) and the shape
// tools (the selected one; elsewhere they draw a new shape). The select tool is for pixels only, so
// a marquee can start over a shape. Tolerances are screen px.
// A box side shorter than objGap() shows no midpoint handle, so its corners stay apart.
const objTol = () => 4 / S.zoom, objGap = () => 24 / S.zoom;
function objTarget(p) {
  const gb = S.tool === 'move' && groupBox();
  if (gb) { const h = Core.handleAt(gb, p, objTol() + 1 / S.zoom, objGap()); if (h) return { o: gb, h, group: true }; }
  const o = selObj();
  if (o && (S.tool === 'move' || SHAPES.has(S.tool))) {
    const h = Core.handleAt(o, p, objTol() + 1 / S.zoom, objGap());
    if (h) return { o, h };
    if (Core.hitsObject(o, p, objTol())) return { o, h: null };
  }
  if (S.tool === 'eraser' && S.altKey) { const o3 = hitAt(p, S.sizes.eraser / 2 + objTol()); return o3 ? { o: o3, h: null, erase: true } : null; }
  if (S.tool !== 'move') return null;
  const o2 = hitAt(p, objTol());
  return o2 ? { o: o2, h: null } : null;
}
const HANDLE_CURSORS = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', a: 'move', b: 'move' };
// ⌥ over a shape with the Move tool: a drag duplicates it (copy cursor).
function objCursor(hit) {
  if (hit && hit.erase) return 'crosshair';
  return hit ? (hit.h ? HANDLE_CURSORS[hit.h] : S.altKey && S.tool === 'move' ? 'copy' : 'move') : '';
}
// The selection as it was when a gesture began: Esc puts it back (cancelDrag).
const selNow = () => ({ objSel, multi: multi.slice() });
function objPointerDown(p, e) {
  const hit = objTarget(p);
  if (hit && hit.erase) return false; // the eraser's ⌥-drag takes it
  if (!hit) {
    if ((objSel != null || multi.length) && !(S.tool === 'move' && e.shiftKey)) selectObj(null);
    return false;
  }
  if (hit.group) { // a handle of a selected group's box: scale them all with it
    setDrag({ t: 'objsize', h: hit.h, o: hit.o, src: hit.o, group: new Set(multi), box: hit.o, p, q: p, sx: e.clientX, sy: e.clientY, moved: false, shift: e.shiftKey, before: objs, selWas: selNow() });
    return true;
  }
  // ⇧ on an object with the Move tool: a drag moves along one axis as ever; a click (no movement)
  // adds the object to the selection or takes it out (finishDrag).
  const toggle = S.tool === 'move' && e.shiftKey && !hit.h;
  if ((multi.includes(hit.o.id) || toggle) && !hit.h && (multi.length || objSel != null)) { // a drag on a selected group moves it all
    const ids = multi.length ? multi.slice() : [objSel];
    const group = ids.includes(hit.o.id) ? ids : [hit.o.id];
    setDrag({ t: 'objmove', group: new Set(group), toggle, o: hit.o, src: hit.o, p, q: p, sx: e.clientX, sy: e.clientY, moved: false, shift: e.shiftKey, before: objs, selWas: selNow() });
    return true;
  }
  dropSelection();
  selectObj(hit.o.id);
  // q: the pointer now. Nothing moves until it has gone 3 screen px (moved), so a click only selects.
  // ⌥-drag on the body (Move tool, as in Figma) moves a copy, put just above the original.
  const dup = !hit.h && e.altKey && S.tool === 'move' ? { ...hit.o, id: newObjId(), z: zAbove(hit.o) } : null;
  setDrag({ t: hit.h ? 'objsize' : 'objmove', h: hit.h, o: dup || hit.o, src: hit.o, dup: !!dup, p, q: p, sx: e.clientX, sy: e.clientY, moved: false, shift: e.shiftKey, before: objs, selWas: selNow() });
  return true;
}
// Snapping (Core.snapMove, snapResize): a move or resize lines up the edges and centres of what it
// drags with those of the objects in view and of the canvas, within 8 screen px, and shows guides
// where they line up. ⌘ (Ctrl elsewhere) held suspends it. The lines are worked out once per drag,
// on its first real move (a duplicate being dragged may snap to its original).
const snapTol = () => 8 / S.zoom;
const snapOff = (e) => (MAC ? e.metaKey : e.ctrlKey);
function snapTargets(d) {
  const v = visible(), moving = d.group || new Set([d.o.id]), fs = [{ x: 0, y: 0, w: img.width, h: img.height }];
  for (const o of objsIn({ x: v.x0, y: v.y0, w: v.x1 - v.x0, h: v.y1 - v.y0 })) if (!moving.has(o.id)) fs.push(frameOf(o));
  return Core.snapLines(fs);
}
// The frame a move drags: one object's, or the box around a group's.
function dragFrame(d) {
  if (!d.group || d.group.size < 2) return frameOf(d.o);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const o of d.before) {
    if (!d.group.has(o.id)) continue;
    const f = frameOf(o);
    x0 = Math.min(x0, f.x); y0 = Math.min(y0, f.y); x1 = Math.max(x1, f.x + f.w); y1 = Math.max(y1, f.y + f.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
// Apply an object drag: the live list (one undo step on release). Shift locks a move to its main
// axis (the other still snaps), keeps a box's aspect ratio and snaps a line end to 45° (Core.resizeObj;
// a resize then doesn't snap to objects).
function objDragUpdate(d) {
  if (!d.moved) return;
  let dx = d.q.x - d.p.x, dy = d.q.y - d.p.y;
  const lock = d.shift && d.t === 'objmove' ? (Math.abs(Math.round(dx)) >= Math.abs(Math.round(dy)) ? 'y' : 'x') : null;
  if (lock === 'y') dy = 0; else if (lock === 'x') dx = 0;
  d.guides = null;
  if (!d.free && !(d.shift && d.t === 'objsize')) {
    if (!d.snap) { d.snap = snapTargets(d); d.frame = dragFrame(d); }
    const s = d.t === 'objmove' ? Core.snapMove(d.snap, d.frame, dx, dy, snapTol(), lock) : Core.snapResize(d.snap, d.box || d.o, d.h, dx, dy, snapTol());
    dx = s.dx; dy = s.dy; d.guides = s.guides;
  }
  dx = Math.round(dx); dy = Math.round(dy);
  if (d.box) { // scale the group from its box's old place and size to the dragged one
    const a = Core.normRect(d.box.a, d.box.b), b = Core.normRect(...(({ a: p, b: q }) => [p, q])(Core.resizeObj(d.box, d.h, dx, dy, d.shift)));
    if (b.w < 1 || b.h < 1 || !a.w || !a.h) { d.guides = null; return; }
    const sx = b.w / a.w, sy = b.h / a.h;
    showObjs(d.before.map((x) => (d.group.has(x.id) ? Core.moveObj(Core.scaleObj(Core.moveObj(x, -a.x, -a.y), sx, sy), b.x, b.y) : x)));
    return;
  }
  if (d.group && d.group.size > 1) { showObjs(d.before.map((x) => (d.group.has(x.id) ? Core.moveObj(x, dx, dy) : x))); return; }
  const o = d.t === 'objmove' ? Core.moveObj(d.o, dx, dy) : Core.resizeObj(d.o, d.h, dx, dy, d.shift);
  if (d.dup) {
    const i = d.before.indexOf(d.src) + 1;
    showObjs(d.before.slice(0, i).concat(o, d.before.slice(i)), o.id);
  } else showObjs(d.before.map((x) => (x.id === o.id ? o : x)));
}

ov.addEventListener('pointerdown', (e) => {
  if (drag) return;
  if (e.button === 0 && !S.panKey && S.tool === 'move' && !objTarget(imgPt(e))) {
    // A drag on empty canvas with the Move tool selects the objects it touches (⇧: adds them); a
    // click there deselects (decision 7b; Space or the middle button pans).
    const p = imgPt(e);
    ov.setPointerCapture(e.pointerId);
    setDrag({ t: 'objbox', start: p, end: p, sx: e.clientX, sy: e.clientY, add: e.shiftKey });
    requestRender();
    return;
  }
  if (e.button === 1 || (e.button === 0 && S.panKey)) {
    e.preventDefault();
    ov.setPointerCapture(e.pointerId);
    setDrag({ t: 'pan', sx: e.clientX, sy: e.clientY, sl: vp.scrollLeft, st: vp.scrollTop });
    stage.classList.add('panning', 'dragging');
    ring.hidden = true;
    return;
  }
  if (e.button !== 0 && e.button !== 2) return;
  commitText();
  // mousedown is suppressed on the canvas, so drop focus from toolbar fields ourselves (else shortcuts stay dead).
  if (document.activeElement && document.activeElement !== textBox) document.activeElement.blur();
  ov.setPointerCapture(e.pointerId);
  const p = imgPt(e), ip = { x: Math.floor(p.x), y: Math.floor(p.y) };
  const right = e.button === 2;
  const color = right ? S.secondary : S.primary, alt = right ? S.primary : S.secondary;
  const t = S.tool;
  if (t !== 'select') dropSelection();
  if (!right && objPointerDown(p, e)) { requestRender(); return; }
  const textHit = t === 'text' ? hitAt(p, objTol()) : null, onText = textHit && textHit.t === 'text'; // editing one keeps its colour
  if ((SHAPES.has(t) || (t === 'text' && !onText)) && isClear(color)) { // nothing to see: the pixel tools erase with it instead
    flash(`Color ${right ? 2 : 1} is Transparent: pick a color to draw ${t === 'text' ? 'text' : 'shapes'}`);
    return;
  }
  switch (t) {
    case 'eraser': if (e.altKey) { // ⌥-drag: delete whole objects it crosses (decision 4b), one undo step
      setDrag({ t: 'erase', last: p, before: objs, gone: new Set() });
      eraseAlong(drag, p);
      break;
    } // falls through: a plain eraser stroke
    case 'pencil': {
      // A stroke is one object (docs/total-objects.md): drawn live on top as it grows, added on release.
      const o = { t, pts: [ip.x, ip.y], color: t === 'eraser' ? S.secondary : color, size: S.sizes[t] };
      setDrag({ t, last: ip, o });
      setLive(o);
      break;
    }
    case 'brush': {
      // Smoothing radius is in screen px (2 per step), fixed for the stroke even if the zoom changes.
      const o = { t, segs: [{ a: p, c: null, b: { x: p.x + 1e-3, y: p.y } }], color, size: S.sizes.brush }; // the dot under the pointer (a 0-length line draws nothing)
      setDrag({ t, color, size: o.size, ptr: p, o, stroke: brushStroke(p) });
      setLive(o);
      break;
    }
    case 'fill': { // inside a closed shape on top: set that shape's fill (decision 5b); else flood fill
      // In Transparent: an outlined shape loses its fill; otherwise it clears what is seen, like a flood fill.
      const top = objsIn({ x: p.x, y: p.y, w: 0, h: 0 }).reverse().find((o) => Core.insideShape(o, p) || Core.hitsObject(o, p, 0));
      if (top && Core.insideShape(top, p) && !(isClear(color) && top.mode !== 'both')) { fillShape(top, color); break; }
      doFill(ip, color);
      break;
    }
    case 'picker': pick(ip, right); break;
    case 'line': case 'rect': case 'ellipse':
      setDrag({ t, start: ip, end: ip, shift: e.shiftKey, color, alt });
      break;
    case 'text': // on a text object: edit it again
      startText(ip, color, onText ? textHit : null);
      break;
    case 'move': break; // right button: nothing
    case 'select': {
      const rp = { x: clamp(Math.round(p.x), 0, img.width), y: clamp(Math.round(p.y), 0, img.height) };
      if (objSel != null) selectObj(null);
      if (sel && inside(p, sel)) {
        // Lift on the first real movement, so a plain click inside the selection changes nothing.
        setDrag({ t: 'move', gx: p.x - sel.x, gy: p.y - sel.y, ox: sel.x, oy: sel.y, lifted: false });
      } else {
        dropSelection();
        setDrag({ t: 'select', start: rp, end: rp });
      }
      break;
    }
  }
  requestRender();
});

ov.addEventListener('pointermove', (e) => {
  const r = img.getBoundingClientRect();
  const p = imgPt(e, r);
  setCursor({ x: Math.floor(p.x), y: Math.floor(p.y) });
  S.altKey = e.altKey;
  setHover(p);
  if (!drag) { requestRender(); return; }
  const d = drag;
  if (d.t === 'pan') {
    vp.scrollLeft = d.sl - (e.clientX - d.sx);
    vp.scrollTop = d.st - (e.clientY - d.sy);
    return;
  }
  if (d.t === 'pencil' || d.t === 'eraser' || d.t === 'brush') {
    let evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    if (!evs.length) evs = [e];
    for (const ev of evs) {
      const q = imgPt(ev, r);
      if (d.t === 'brush') { addSegs(d, d.stroke.add(q)); d.ptr = q; }
      else {
        const iq = { x: Math.floor(q.x), y: Math.floor(q.y) };
        if (iq.x === d.last.x && iq.y === d.last.y) continue;
        d.o.pts.push(iq.x, iq.y);
        growLive();
        d.last = iq;
      }
    }
  } else if (d.t === 'erase') {
    eraseAlong(d, p);
  } else if (d.t === 'objbox') {
    d.end = p;
  } else if (SHAPES.has(d.t)) {
    d.end = { x: Math.floor(p.x), y: Math.floor(p.y) };
    d.shift = e.shiftKey;
  } else if (d.t === 'select') {
    d.end = { x: clamp(Math.round(p.x), 0, img.width), y: clamp(Math.round(p.y), 0, img.height) };
  } else if (d.t === 'objmove' || d.t === 'objsize') {
    d.q = p; d.shift = e.shiftKey; d.free = snapOff(e);
    d.moved = d.moved || Math.hypot(e.clientX - d.sx, e.clientY - d.sy) >= 3;
    objDragUpdate(d);
  } else if (d.t === 'move') {
    if (!sel) { setDrag(null); return; }
    const nx = Math.round(p.x - d.gx), ny = Math.round(p.y - d.gy);
    if (nx === sel.x && ny === sel.y) return;
    if (!sel.float) { liftSelection(); d.lifted = true; }
    sel.x = nx; sel.y = ny;
  }
  requestRender();
});

// ⌥-erase: every object within the eraser's reach of the path from the last point to p goes (shown at
// once; one undo step on release). Samples the path every half reach, so a fast drag skips nothing.
function eraseAlong(d, p) {
  const reach = S.sizes.eraser / 2 + objTol(), n = Math.max(1, Math.ceil(Math.hypot(p.x - d.last.x, p.y - d.last.y) / Math.max(1, reach / 2)));
  let hit = false;
  for (let i = 0; i <= n; i++) {
    const q = { x: d.last.x + (p.x - d.last.x) * i / n, y: d.last.y + (p.y - d.last.y) * i / n };
    for (let o = hitAt(q, reach); o; o = hitAt(q, reach)) { d.gone.add(o.id); hit = true; showObjs(objs.filter((x) => x.id !== o.id)); }
  }
  d.last = p;
  return hit;
}

// Smoothing n (screen px, so it feels the same at every zoom): a lazy radius of 2n, then an average over
// 6n either side, on points 2 px apart. 0 follows every sample (≥ 0.5 px apart).
function brushStroke(p) {
  const n = S.smoothing;
  return n ? new Core.Stroke(p, 2 * n / S.zoom, 2 / S.zoom, 3 * n) : new Core.Stroke(p, 0, 0.5 / S.zoom);
}

// Settled brush segments join the live stroke; only their boxes are repainted.
function addSegs(d, segs) {
  if (!segs.length) return;
  for (const g of segs) d.o.segs.push(g);
  growLive();
}

// Outline of the brush footprint, so big sizes show what they'll cover.
const RING_TOOLS = new Set(['pencil', 'brush', 'eraser']);
let ringSize = '', ringTf = '';
function updateRing(p) {
  const size = S.sizes[S.tool], px = size * S.zoom;
  if (!p || !RING_TOOLS.has(S.tool) || S.panKey || (drag && drag.t === 'pan') || px < 4) { setProp(ring, 'hidden', true); return; }
  let x, y;
  if (S.tool === 'brush') { x = p.x - size / 2; y = p.y - size / 2; }
  else { const off = Math.floor(size / 2); x = Math.floor(p.x) - off; y = Math.floor(p.y) - off; }
  ring.classList.toggle('round', S.tool === 'brush');
  // Compare with what we wrote last, not with ring.style: CSSOM re-serialises fractional px,
  // so a read-back never matches and the size would be rewritten (a layout) every frame.
  const sz = px + 'px', tf = `translate(${x * S.zoom}px, ${y * S.zoom}px)`;
  if (ringSize !== sz) { ringSize = ring.style.width = ring.style.height = sz; }
  if (ringTf !== tf) { ringTf = ring.style.transform = tf; }
  setProp(ring, 'hidden', false);
}

// Esc mid-gesture: put everything back as it was before the pointer went down.
function cancelDrag() {
  const d = drag;
  if (d.t === 'canvas') { endCanvasDrag(false); return; }
  if (d.t === 'pan' || d.t === 'pencil' || d.t === 'eraser' || d.t === 'brush') return; // strokes finish normally
  setDrag(null);
  if (d.t === 'objmove' || d.t === 'objsize') { showObjs(d.before); restoreSel(d.selWas); }
  if (d.t === 'erase') showObjs(d.before);
  if (d.t === 'move' && sel) {
    if (d.lifted) unlift(); // undo the lift this drag made: no patch, no float, no history entry
    sel.x = d.ox; sel.y = d.oy;
    updateChrome();
  }
  requestRender();
}

function finishDrag(e) {
  const d = drag;
  if (!d) return;
  setDrag(null);
  if (d.t === 'pan') { stage.classList.remove('dragging'); if (!S.panKey) stage.classList.remove('panning'); }
  else if (d.t === 'brush' || d.t === 'pencil' || d.t === 'eraser') {
    // The brush ends exactly where the pointer lifted (pointercancel carries no reliable position).
    if (d.t === 'brush') addSegs(d, d.stroke.finish(e && e.type === 'pointerup' ? imgPt(e) : d.ptr));
    flushRedraw(); // the last piece on screen, so the object can join without a repaint
    endLive();
    addObj(d.o, { keepSel: true }); // on top of everything (decision 10)
  }
  else if (d.t === 'objmove' && d.toggle && !d.moved) {
    const ids = multi.length ? multi.slice() : objSel != null ? [objSel] : [];
    const i = ids.indexOf(d.src.id);
    if (i < 0) ids.push(d.src.id); else ids.splice(i, 1);
    selectMany(ids);
  }
  else if (d.t === 'objmove' || d.t === 'objsize' || d.t === 'erase') commitObjDrag(d.before);
  else if (d.t === 'objbox') {
    const r = Core.normRect(d.start, d.end), click = Math.hypot(e ? e.clientX - d.sx : 0, e ? e.clientY - d.sy : 0) < 3;
    const meets = (f) => f.x <= r.x + r.w && f.x + f.w >= r.x && f.y <= r.y + r.h && f.y + f.h >= r.y;
    const ids = click ? [] : objsIn(r).filter((o) => meets(Core.objFrame(o))).map((o) => o.id);
    const had = d.add ? (multi.length ? multi : objSel != null ? [objSel] : []) : [];
    if (ids.length || had.length) selectMany(had.concat(ids)); else selectObj(null);
  }
  else if (SHAPES.has(d.t)) {
    if (d.t !== 'line' && d.start.x === d.end.x && d.start.y === d.end.y) { requestRender(); return; } // a click, not a shape
    addObj(shapeObj(d)); // a live object above the pixels until flattened (docs/objects.md)
  } else if (d.t === 'select') {
    const r = Core.normRect(d.start, d.end);
    setSel(r.w > 0 && r.h > 0 ? { ...r, float: null } : null);
  }
  requestRender();
}
ov.addEventListener('pointerup', finishDrag);
ov.addEventListener('pointercancel', finishDrag);
ov.addEventListener('pointerleave', () => { setHover(null); ring.hidden = true; if (!drag) { setCursor(null); updateStatus(); } });
ov.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus where we put it (text box)
vp.addEventListener('contextmenu', (e) => e.preventDefault());

// Safari sends a trackpad pinch as gesture events (scale since gesturestart), and zooms the page
// unless they are cancelled. It may send ctrl+wheel as well: during a gesture that is ignored, so the
// pinch zooms once.
let pinch = null;
vp.addEventListener('gesturestart', (e) => { e.preventDefault(); pinch = { z: S.zoom }; });
vp.addEventListener('gesturechange', (e) => { e.preventDefault(); if (pinch) setZoom(pinch.z * e.scale, e.clientX, e.clientY); });
vp.addEventListener('gestureend', (e) => { e.preventDefault(); pinch = null; });
window.addEventListener('blur', () => { pinch = null; }); // a gestureend missed while away mustn't block ctrl+wheel
vp.addEventListener('wheel', (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  e.preventDefault(); // trackpad pinch arrives as ctrl+wheel; zoom the image, not the page
  if (!pinch) setZoom(S.zoom * Math.exp(-clamp(e.deltaY, -100, 100) * 0.005), e.clientX, e.clientY);
}, { passive: false });

export { cancelDrag, objCursor, objDragUpdate, objGap, objTarget, updateRing };
