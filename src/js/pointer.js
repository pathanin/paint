import Core from './core.js';
import { img } from './doc.js';
import { $, clamp, ov, ring, setProp, stage, textBox, vp } from './dom.js';
import { doFill } from './fill.js';
import { endCanvasDrag } from './handles.js';
import { addObj, commitObjDrag, fillShape, multi, newObjId, objSel, objs, selectMany, selObj, selectObj, showObjs, zAbove } from './objects.js';
import { endLive, flushRedraw, hitAt, markDirty, objsIn, setLive } from './scene.js';
import { dropSelection, inside, liftSelection, unlift } from './selection.js';
import { S, SHAPES, drag, sel, setDrag, setSel } from './state.js';
import { commitText, startText } from './text.js';
import { pick, shapeObj } from './tools.js';
import { imgPt, requestRender, setCursor, setHover, setZoom, updateChrome, updateStatus } from './view.js';

// ---------- pointer ----------
// Object editing under the pointer, for the move tool (any object; elsewhere it pans) and the shape
// tools (the selected one; elsewhere they draw a new shape). The select tool is for pixels only, so
// a marquee can start over a shape. Tolerances are screen px.
// A box side shorter than objGap() shows no midpoint handle, so its corners stay apart.
const objTol = () => 4 / S.zoom, objGap = () => 24 / S.zoom;
function objTarget(p) {
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
function objPointerDown(p, e) {
  const hit = objTarget(p);
  if (hit && hit.erase) return false; // the eraser's ⌥-drag takes it
  if (!hit) {
    if ((objSel != null || multi.length) && !(S.tool === 'move' && e.shiftKey)) selectObj(null);
    return false;
  }
  // ⇧ on an object with the Move tool: a drag moves along one axis as ever; a click (no movement)
  // adds the object to the selection or takes it out (finishDrag).
  const toggle = S.tool === 'move' && e.shiftKey && !hit.h;
  if ((multi.includes(hit.o.id) || toggle) && !hit.h && (multi.length || objSel != null)) { // a drag on a selected group moves it all
    const ids = multi.length ? multi.slice() : [objSel];
    const group = ids.includes(hit.o.id) ? ids : [hit.o.id];
    setDrag({ t: 'objmove', group, toggle, o: hit.o, src: hit.o, p, q: p, sx: e.clientX, sy: e.clientY, moved: false, shift: e.shiftKey, before: objs });
    return true;
  }
  dropSelection();
  selectObj(hit.o.id);
  // q: the pointer now. Nothing moves until it has gone 3 screen px (moved), so a click only selects.
  // ⌥-drag on the body (Move tool, as in Figma) moves a copy, put just above the original.
  const dup = !hit.h && e.altKey && S.tool === 'move' ? { ...hit.o, id: newObjId(), z: zAbove(hit.o) } : null;
  setDrag({ t: hit.h ? 'objsize' : 'objmove', h: hit.h, o: dup || hit.o, src: hit.o, dup: !!dup, p, q: p, sx: e.clientX, sy: e.clientY, moved: false, shift: e.shiftKey, before: objs });
  return true;
}
// Apply an object drag: the live list (one undo step on release). Shift locks a move to its main
// axis, keeps a box's aspect ratio and snaps a line end to 45° (Core.resizeObj).
function objDragUpdate(d) {
  if (!d.moved) return;
  let dx = Math.round(d.q.x - d.p.x), dy = Math.round(d.q.y - d.p.y);
  if (d.shift && d.t === 'objmove') { if (Math.abs(dx) >= Math.abs(dy)) dy = 0; else dx = 0; }
  if (d.group && d.group.length > 1) { showObjs(d.before.map((x) => (d.group.includes(x.id) ? Core.moveObj(x, dx, dy) : x))); return; }
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
      markDirty(Core.objBox(o));
      break;
    }
    case 'brush': {
      // Smoothing radius is in screen px (2 per step), fixed for the stroke even if the zoom changes.
      const o = { t, segs: [{ a: p, c: null, b: { x: p.x + 1e-3, y: p.y } }], color, size: S.sizes.brush }; // the dot under the pointer (a 0-length line draws nothing)
      setDrag({ t, color, size: o.size, ptr: p, o, stroke: new Core.Stroke(p, S.smoothing * 2 / S.zoom, 0.5 / S.zoom) });
      setLive(o);
      markDirty(Core.objBox(o));
      break;
    }
    case 'fill': { // inside a closed shape on top: set that shape's fill (decision 5b); else flood fill
      const top = objsIn({ x: p.x, y: p.y, w: 0, h: 0 }).reverse().find((o) => Core.insideShape(o, p) || Core.hitsObject(o, p, 0));
      if (top && Core.insideShape(top, p)) { fillShape(top, color); break; }
      doFill(ip, color);
      break;
    }
    case 'picker': pick(ip, right); break;
    case 'line': case 'rect': case 'ellipse':
      setDrag({ t, start: ip, end: ip, shift: e.shiftKey, color, alt });
      break;
    case 'text': { // on a text object: edit it again
      const hit = hitAt(p, objTol());
      startText(ip, color, hit && hit.t === 'text' ? hit : null);
      break;
    }
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
        markDirty(Core.objBox({ ...d.o, pts: [d.last.x, d.last.y, iq.x, iq.y] }));
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
    d.q = p; d.shift = e.shiftKey;
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

// Settled brush segments join the live stroke; only their box is repainted.
function addSegs(d, segs) {
  if (!segs.length) return;
  for (const g of segs) d.o.segs.push(g);
  markDirty(Core.objBox({ ...d.o, segs }));
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
  if (d.t === 'objmove' || d.t === 'objsize') showObjs(d.before, d.src.id);
  if (d.t === 'erase') showObjs(d.before);
  if (d.t === 'objmove' && d.group) showObjs(d.before);
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

vp.addEventListener('wheel', (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  e.preventDefault(); // trackpad pinch arrives as ctrl+wheel; zoom the image, not the page
  setZoom(S.zoom * Math.exp(-clamp(e.deltaY, -100, 100) * 0.005), e.clientX, e.clientY);
}, { passive: false });

export { cancelDrag, objCursor, objDragUpdate, objGap, objTarget, updateRing };
