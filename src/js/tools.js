import Core from './core.js';
import { $, clamp, makeCanvas, ring, setAttr, setData, stage, toHex } from './dom.js';
import { composite, restyleObj, selObj, selectObj } from './objects.js';
import { dropSelection } from './selection.js';
import { S } from './state.js';
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
function setColor(which, hex, key) {
  S[which] = hex;
  if (key !== false) restyleObj(which === 'primary' ? { color: hex } : { alt: hex }, key);
  $('#' + which).value = hex;
  if (textAt && which === 'primary') { textAt.color = hex; placeTextBox(); }
  document.querySelectorAll('#palette button').forEach((b) => {
    b.classList.toggle('is1', b.dataset.color === S.primary);
    b.classList.toggle('is2', b.dataset.color === S.secondary);
    setAttr(b, 'aria-pressed', b.dataset.color === S.primary);
    setData(b, 'tip', b.dataset.name + (b.dataset.color === S.secondary ? ' (color 2)' : ''));
    setAttr(b, 'aria-label', b.dataset.tip);
  });
}

// Pencil and eraser: square stamps along the Bresenham line between each pair of points, as one
// path (whole-pixel rects in one opaque colour: the same pixels as stamping them one by one).
// r: only the segments whose stamps reach r (a tile being repainted).
function drawStamps(c, o, r) {
  const off = Math.floor(o.size / 2), s = o.size, pts = o.pts;
  c.fillStyle = o.color;
  c.beginPath();
  const n = pts.length;
  for (let i = 0; i < n; i += 2) {
    const ax = pts[i], ay = pts[i + 1], bx = i + 2 < n ? pts[i + 2] : ax, by = i + 2 < n ? pts[i + 3] : ay;
    if (i + 2 >= n && n > 2) break; // the last point ends the previous segment
    if (r && (Math.max(ax, bx) - off + s <= r.x || Math.min(ax, bx) - off >= r.x + r.w || Math.max(ay, by) - off + s <= r.y || Math.min(ay, by) - off >= r.y + r.h)) continue;
    for (const [x, y] of Core.line(ax, ay, bx, by)) c.rect(x - off, y - off, s, s);
  }
  c.fill();
}
// Brush: Core.Stroke segments ({a, c, b}, c = quadratic control or null) as one path, so joins blend
// once; a segment that doesn't start where the last one ended starts a new subpath (same shape:
// round caps meet like a round join). Draws the live tail on the preview, and brush objects (with r,
// only the segments that reach r: as brushCommit used to, so a tile never inks an edge twice).
function brushPath(c, segs, color, size) {
  if (!segs.length) return;
  c.save();
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
function segsIn(o, r) {
  if (!r) return o.segs;
  const h = o.size / 2 + 1;
  return o.segs.filter((g) => {
    let b = segBoxes.get(g);
    if (!b || b.h0 !== h) { b = Core.segsBox([g], h); b.h0 = h; segBoxes.set(g, b); }
    return b.x < r.x + r.w && b.x + b.w > r.x && b.y < r.y + r.h && b.y + b.h > r.y;
  });
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
  } else {
    const bd = o.asset.banded;
    if (bd && r) { // a tile: only the bands (in the fill's own rows, through m) that it overlaps
      const m = o.m || [1, 0, 0, 1], det = m[0] * m[3] - m[1] * m[2], ys = [];
      for (const [px, py] of [[r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h]]) ys.push((-m[1] * (px - o.x) + m[0] * (py - o.y)) / det);
      for (let k = Math.floor(Math.min(...ys) / 256); k * 256 < Math.max(...ys); k++) {
        const b = bd.bands.get(k);
        if (b) for (const [col, p] of b) { c.fillStyle = col || bd.color; c.fill(p); }
      }
    } else if (o.asset.paths) for (const [col, p] of o.asset.paths) { c.fillStyle = col; c.fill(p); }
    else if (o.asset.maskCv) { // a fill that isn't opaque everywhere replaces its pixels: clear them first
      c.globalCompositeOperation = 'destination-out';
      c.drawImage(o.asset.maskCv, 0, 0);
      c.globalCompositeOperation = 'source-over';
    }
    if (!o.asset.paths) c.drawImage(o.asset.cv, 0, 0);
  }
  c.restore();
}

function pick(p, right) {
  const c = composite(); // what is seen: pixels + objects
  if (p.x < 0 || p.y < 0 || p.x >= c.width || p.y >= c.height) return;
  const one = makeCanvas(1, 1), g = one.getContext('2d', { willReadFrequently: true });
  g.drawImage(c, p.x, p.y, 1, 1, 0, 0, 1, 1);
  const d = g.getImageData(0, 0, 1, 1).data;
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
    if (o.mode !== 'outline') { c.fillStyle = o.mode === 'fill' ? o.color : o.alt; c.fill(); }
    if (o.mode !== 'fill') c.stroke();
  }
  c.restore();
}

export { brushPath, drawObj, drawShape, pick, segsBox, setColor, setSize, setTool, shapeObj };
