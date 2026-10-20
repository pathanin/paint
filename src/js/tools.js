import Core from './core.js';
import { drawCells } from './assets.js';
import { $, clamp, pixelAt, ring, setAttr, setData, stage, toHex } from './dom.js';
import { composite, restyleObj, selObj, selectObj } from './objects.js';
import { dropSelection } from './selection.js';
import { S, isClear } from './state.js';
import { commitText, placeTextBox, textAt } from './text.js';
import { flash } from './toast.js';
import { requestRender } from './view.js';

// ---------- tools ----------
function setTool(t) {
  commitText();
  if (t !== 'select') dropSelection();
  // The selection stays only for tools that edit it: move, and the object's own shape tool (its
  // size and style controls). Otherwise setting up the next shape would restyle the last one.
  const so = selObj();
  if (so && t !== 'move' && t !== so.t) selectObj(null);
  if (t === 'picker' && S.tool !== 'picker') S.prevTool = S.tool;
  S.tool = t;
  stage.dataset.tool = t;
  document.querySelectorAll('button[data-tool]').forEach((b) => {
    const on = b.dataset.tool === t;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', on);
    b.tabIndex = on ? 0 : -1;
    if (on) $('#toolName').textContent = b.dataset.tip;
  });
  document.querySelectorAll('.opts [data-for]').forEach((l) => { l.hidden = !l.dataset.for.split(' ').includes(t); });
  ring.hidden = true;
  requestRender(); // cursor and hover outline follow the tool even if the pointer doesn't move
  if (S.sizes[t] != null) { $('#size').value = S.sizes[t]; $('#sizeOut').textContent = S.sizes[t]; $('#size').setAttribute('aria-valuetext', S.sizes[t] + ' px'); }
}
function setSize(v) {
  if (S.sizes[S.tool] == null) return;
  S.sizes[S.tool] = clamp(v, 1, 100);
  $('#size').value = S.sizes[S.tool];
  $('#sizeOut').textContent = S.sizes[S.tool];
  $('#size').setAttribute('aria-valuetext', S.sizes[S.tool] + ' px');
}
// key: as restyleObj's (a colour well streams input events); false leaves the selected object alone.
// Transparent never goes into the <input type=color> (Chrome would turn it into black): the well
// keeps its last colour and shows a checkerboard over it. A shape's line or text can't be
// transparent, so it then restyles only a shape's fill (colour 2).
function setColor(which, hex, key) {
  S[which] = hex;
  const clear = isClear(hex), well = $('#' + which), label = which === 'primary' ? 'Color 1' : 'Color 2';
  if (key !== false && !(clear && which === 'primary')) restyleObj(which === 'primary' ? { color: hex } : { alt: hex }, key);
  if (!clear) well.value = hex;
  well.classList.toggle('clear', clear);
  setAttr(well, 'aria-label', clear ? label + ': Transparent' : label);
  setData(well, 'tip', clear ? label + ': Transparent' : label);
  if (textAt && which === 'primary' && !clear) { textAt.color = hex; placeTextBox(); }
  document.querySelectorAll('#palette button').forEach((b) => {
    b.classList.toggle('is1', b.dataset.color === S.primary);
    b.classList.toggle('is2', b.dataset.color === S.secondary);
    setAttr(b, 'aria-pressed', b.dataset.color === S.primary);
    setData(b, 'tip', b.dataset.name + (b.dataset.color === S.secondary ? ' (color 2)' : ''));
    setAttr(b, 'aria-label', b.dataset.tip);
  });
}

// Pencil and eraser: square stamps along the Bresenham line between each pair of points, as one
// path (whole-pixel rects in one opaque colour: the same pixels as stamping them one by one; each run
// of a line's row or column is one rect, Core.stampRects). In Transparent they clear what is under
// them instead, exactly (whole pixels). Whole-pixel rects come out the same whatever else is drawn
// with them, so the live stroke can be drawn a piece at a time (scene.js).
// Piece i (an even index into pts) is the line from that point to the next; a lone point is piece 0.
// r: only the pieces whose stamps reach r (a tile being repainted); idx: just these pieces (new pieces
// of the live stroke in a tile, scene.js).
const meets = (b, r) => b.x < r.x + r.w && b.x + b.w > r.x && b.y < r.y + r.h && b.y + b.h > r.y;
const stampEnd = (pts, i) => (i + 2 < pts.length ? i + 2 : i); // the lone point is a line to itself
function stampBox(o, i) { // what piece i's stamps cover
  const off = Math.floor(o.size / 2), p = o.pts, j = stampEnd(p, i);
  return { x: Math.min(p[i], p[j]) - off, y: Math.min(p[i + 1], p[j + 1]) - off, w: Math.abs(p[j] - p[i]) + o.size, h: Math.abs(p[j + 1] - p[i + 1]) + o.size };
}
const stampPieces = (o) => (o.pts.length > 2 ? o.pts.length - 2 : 1); // pieces are i = 0, 2, ... below this
function drawStamps(c, o, r, idx) {
  const pts = o.pts, rect = (x, y, w, h) => c.rect(x, y, w, h);
  c.save();
  if (isClear(o.color)) c.globalCompositeOperation = 'destination-out';
  c.fillStyle = isClear(o.color) ? '#000' : o.color;
  c.beginPath();
  const piece = (i) => { const j = stampEnd(pts, i); Core.stampRects(pts[i], pts[i + 1], pts[j], pts[j + 1], o.size, rect); };
  if (idx) for (const i of idx) piece(i);
  else for (let i = 0, n = stampPieces(o); i < n; i += 2) if (!r || meets(stampBox(o, i), r)) piece(i);
  c.fill();
  c.restore();
}
// Brush: Core.Stroke segments ({a, c, b}, c = quadratic control or null) as one path, so joins blend
// once; a segment that doesn't start where the last one ended starts a new subpath (same shape:
// round caps meet like a round join). Draws the live tail on the preview, and brush objects (with r,
// only the segments that reach r: as brushCommit used to, so a tile never inks an edge twice).
function brushPath(c, segs, color, size) {
  if (!segs.length) return;
  c.save();
  if (isClear(color)) { c.globalCompositeOperation = 'destination-out'; color = '#000'; } // erases, soft edge and all
  c.strokeStyle = color;
  c.lineWidth = size;
  c.lineCap = c.lineJoin = 'round';
  c.beginPath();
  let end = null;
  for (const { a, c: q, b } of segs) {
    if (!end || end.x !== a.x || end.y !== a.y) c.moveTo(a.x, a.y);
    if (q) c.quadraticCurveTo(q.x, q.y, b.x, b.y); else c.lineTo(b.x, b.y);
    end = b;
  }
  c.stroke();
  c.restore();
}
const segBoxes = new WeakMap(); // segment -> its box grown by the half width (segments are immutable)
function segBox(o, g) {
  const h = o.size / 2 + 1;
  let b = segBoxes.get(g);
  if (!b || b.h0 !== h) { b = Core.segsBox([g], h); b.h0 = h; segBoxes.set(g, b); }
  return b;
}
const segsIn = (o, r) => (r ? o.segs.filter((g) => meets(segBox(o, g), r)) : o.segs);
// The live stroke's pieces that reach a tile (scene.js): stamp pieces by index, brush segments.
function drawPieces(c, o, pieces) {
  if (o.segs) brushPath(c, pieces, o.color, o.size);
  else drawStamps(c, o, null, pieces);
}
const segsBox = Core.segsBox;
// Text, images and fills draw at (x, y) through m.
function drawFramed(c, o, r) {
  c.save();
  const m = o.m || [1, 0, 0, 1];
  c.transform(m[0], m[1], m[2], m[3], o.x, o.y);
  if (o.t === 'text') {
    c.font = `${o.fs}px ${o.font}`;
    c.fillStyle = o.color;
    c.textBaseline = 'alphabetic';
    o.lines.forEach((ln, i) => c.fillText(ln, 0, i * o.fs * 1.2 + o.base));
  } else if (o.asset.cells) { // a fill from the worker: with r, only the cells the tile meets, in the fill's own px through m
    let lb = null;
    if (r) {
      const det = m[0] * m[3] - m[1] * m[2], xs = [], ys = [];
      for (const [px, py] of [[r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h]]) {
        const dx = px - o.x, dy = py - o.y;
        xs.push((m[3] * dx - m[2] * dy) / det); ys.push((-m[1] * dx + m[0] * dy) / det);
      }
      lb = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    }
    drawCells(c, o.asset, lb);
  } else {
    if (o.asset.maskCv) { // a fill that isn't opaque everywhere replaces its pixels: clear them first
      c.globalCompositeOperation = 'destination-out';
      c.drawImage(o.asset.maskCv, 0, 0);
      c.globalCompositeOperation = 'source-over';
    }
    c.drawImage(o.asset.cv, 0, 0);
  }
  c.restore();
}

function pick(p, right) {
  const c = composite(); // what is seen: pixels + objects
  if (p.x < 0 || p.y < 0 || p.x >= c.width || p.y >= c.height) return;
  const d = pixelAt(c, p.x, p.y);
  if (d[3] === 0) { flash('That pixel is transparent. No color picked.'); return; }
  setColor(right ? 'secondary' : 'primary', toHex(d[0], d[1], d[2]));
  setTool(S.prevTool);
}

// The shape a shape drag d describes, as an object (without an id).
function shapeObj(d) {
  return { t: d.t, a: d.start, b: Core.constrainShape(d.start, d.end, d.shift, d.t), color: d.color, alt: d.alt, size: S.sizes[d.t], mode: S.fillMode };
}
function drawShape(c, d) { const o = shapeObj(d); drawObj(c, o); return Core.objBox(o); }
// Draw object o into c. r: the tile being repainted (strokes then draw only what reaches it).
function drawObj(c, o, r) {
  if (o.t === 'pencil' || o.t === 'eraser') { drawStamps(c, o, r); return; }
  if (o.t === 'brush') { brushPath(c, segsIn(o, r), o.color, o.size); return; }
  if (o.t === 'text' || o.t === 'image' || o.t === 'fill') { drawFramed(c, o, r); return; }
  const a = o.a, b = o.b, lw = o.size, off = lw % 2 ? 0.5 : 0;
  c.save();
  c.lineWidth = lw;
  c.strokeStyle = o.color;
  c.beginPath();
  if (o.t === 'line') {
    c.lineCap = 'round';
    c.moveTo(a.x + off, a.y + off);
    c.lineTo(b.x + off, b.y + off);
    c.stroke();
  } else {
    const q = Core.normRect(a, b);
    if (o.t === 'rect') c.rect(q.x + off, q.y + off, q.w, q.h);
    else c.ellipse(q.x + q.w / 2 + off, q.y + q.h / 2 + off, q.w / 2, q.h / 2, 0, 0, Math.PI * 2);
    // A fill in Transparent: none for a shape's inside (alt), but a fill-mode rect in it (a lift's or
    // Delete's patch with colour 2 Transparent) clears what is under it.
    if (o.mode === 'fill' && isClear(o.color)) { c.save(); c.globalCompositeOperation = 'destination-out'; c.fillStyle = '#000'; c.fill(); c.restore(); }
    else if (o.mode !== 'outline') { c.fillStyle = o.mode === 'fill' ? o.color : o.alt; c.fill(); }
    if (o.mode !== 'fill') c.stroke();
  }
  c.restore();
}

export { brushPath, drawPieces, segBox, stampBox, stampPieces, drawObj, drawShape, pick, segsBox, setColor, setSize, setTool, shapeObj };
