import Core from './core.js';
import { img } from './doc.js';
import { $, clamp, ov, ring, setProp, stage, textBox, vp } from './dom.js';
import { doFill } from './fill.js';
import { endCanvasDrag } from './handles.js';
import { addObj, commitObjDrag, newObjId, objSel, objs, selObj, selectObj, showObjs } from './objects.js';
import { dropSelection, inside, liftSelection } from './selection.js';
import { S, SHAPES, drag, isClear, sel, setDrag, setSel } from './state.js';
import { commitText, startText } from './text.js';
import { beginOp, dropOp, endOp } from './tiles.js';
import { flash } from './toast.js';
import { brushCommit, pick, shapeObj, stampLine } from './tools.js';
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
  if (S.tool !== 'move') return null;
  const i = Core.hitObject(objs, p, objTol());
  return i < 0 ? null : { o: objs[i], h: null };
}
const HANDLE_CURSORS = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', a: 'move', b: 'move' };
// ⌥ over a shape with the Move tool: a drag duplicates it (copy cursor).
function objCursor(hit) {
  return hit ? (hit.h ? HANDLE_CURSORS[hit.h] : S.altKey && S.tool === 'move' ? 'copy' : 'move') : '';
}
function objPointerDown(p, e) {
  const hit = objTarget(p);
  if (!hit) {
    if (objSel != null) selectObj(null);
    return false;
  }
  dropSelection();
  selectObj(hit.o.id);
  // q: the pointer now. Nothing moves until it has gone 3 screen px (moved), so a click only selects.
  // ⌥-drag on the body (Move tool, as in Figma) moves a copy, put just above the original.
  const dup = !hit.h && e.altKey && S.tool === 'move' ? { ...hit.o, id: newObjId() } : null;
  setDrag({ t: hit.h ? 'objsize' : 'objmove', h: hit.h, o: dup || hit.o, src: hit.o, dup: !!dup, p, q: p, sx: e.clientX, sy: e.clientY, moved: false, shift: e.shiftKey, before: objs });
  return true;
}
// Apply an object drag: the live list (one undo step on release). Shift locks a move to its main
// axis, keeps a box's aspect ratio and snaps a line end to 45° (Core.resizeObj).
function objDragUpdate(d) {
  if (!d.moved) return;
  let dx = Math.round(d.q.x - d.p.x), dy = Math.round(d.q.y - d.p.y);
  if (d.shift && d.t === 'objmove') { if (Math.abs(dx) >= Math.abs(dy)) dy = 0; else dx = 0; }
  const o = d.t === 'objmove' ? Core.moveObj(d.o, dx, dy) : Core.resizeObj(d.o, d.h, dx, dy, d.shift);
  if (d.dup) {
    const i = d.before.indexOf(d.src) + 1;
    showObjs(d.before.slice(0, i).concat(o, d.before.slice(i)), o.id);
  } else showObjs(d.before.map((x) => (x.id === o.id ? o : x)));
}

ov.addEventListener('pointerdown', (e) => {
  if (drag) return;
  if (e.button === 1 || (e.button === 0 && S.panKey) || (e.button === 0 && S.tool === 'move' && !objTarget(imgPt(e)))) {
    if (S.tool === 'move' && objSel != null) selectObj(null); // a click on empty canvas deselects
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
  if ((SHAPES.has(t) || t === 'text') && isClear(color)) { // nothing to see: the pixel tools erase with it instead
    flash(`Color ${right ? 2 : 1} is Transparent: pick a color to draw ${t === 'text' ? 'text' : 'shapes'}`);
    return;
  }
  switch (t) {
    case 'pencil': case 'eraser': {
      const c = t === 'eraser' ? S.secondary : color;
      beginOp(true);
      setDrag({ t, last: ip, color: c });
      stampLine(ip, ip, c, S.sizes[t]);
      break;
    }
    case 'brush': {
      // Smoothing radius is in screen px (2 per step), fixed for the stroke even if the zoom changes.
      beginOp(true);
      const size = S.sizes.brush;
      setDrag({ t, color, size, ptr: p, all: [], stroke: new Core.Stroke(p, S.smoothing * 2 / S.zoom, 0.5 / S.zoom) });
      brushCommit(drag, [{ a: p, c: null, b: { x: p.x + 1e-3, y: p.y } }]); // the dot under the pointer (a 0-length line draws nothing)
      break;
    }
    case 'fill': doFill(ip, color); break;
    case 'picker': pick(ip, right); break;
    case 'line': case 'rect': case 'ellipse':
      setDrag({ t, start: ip, end: ip, shift: e.shiftKey, color, alt });
      break;
    case 'text': startText(ip, color); break;
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
      if (d.t === 'brush') { d.segs = (d.segs || []).concat(d.stroke.add(q)); d.ptr = q; }
      else {
        const iq = { x: Math.floor(q.x), y: Math.floor(q.y) };
        stampLine(d.last, iq, d.color, S.sizes[d.t]);
        d.last = iq;
      }
    }
    if (d.segs) { brushCommit(d, d.segs); d.segs = null; }
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
  if (d.t === 'move' && sel) {
    if (d.lifted) { // undo the lift this drag made: restore the pixels, drop the float, no history entry
      dropOp(true);
      sel.float = null;
    }
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
  else if (d.t === 'brush') {
    // The stroke ends exactly where the pointer lifted (pointercancel carries no reliable position).
    const q = e && e.type === 'pointerup' ? imgPt(e) : d.ptr;
    brushCommit(d, d.stroke.finish(q));
    endOp();
  }
  else if (d.t === 'pencil' || d.t === 'eraser') endOp();
  else if (d.t === 'objmove' || d.t === 'objsize') commitObjDrag(d.before);
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
