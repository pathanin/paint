import Core from './core.js';
import { base, bctx } from './doc.js';
import { $, clamp, makeCanvas, ring, setAttr, setData, stage, toHex } from './dom.js';
import { composite, restyleObj, selObj, selectObj } from './objects.js';
import { dropSelection } from './selection.js';
import { S } from './state.js';
import { commitText, placeTextBox, textAt } from './text.js';
import { TILE, op, touch } from './tiles.js';
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

function stampLine(a, b, color, size) {
  const off = Math.floor(size / 2);
  touch(Math.min(a.x, b.x) - off, Math.min(a.y, b.y) - off, Math.abs(b.x - a.x) + size, Math.abs(b.y - a.y) + size);
  bctx.fillStyle = color;
  bctx.beginPath();
  for (const [x, y] of Core.line(a.x, a.y, b.x, b.y)) bctx.rect(x - off, y - off, size, size);
  bctx.fill();
}
// Brush: Core.Stroke segments ({a, c, b}, c = quadratic control or null) as one path, so joins blend
// once; a segment that doesn't start where the last one ended starts a new subpath (same shape:
// round caps meet like a round join). Draws the live tail on the preview; brushCommit() the image.
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
// Add segments to the brush stroke d and draw them into the image. Stroking each batch over the
// last would ink the soft edge pixels where batches overlap twice: darker bumps along the edge,
// and a fringe the fill can't match. So the batch's box is put back as it was before the stroke
// (from the op's tiles) and every segment of the stroke that reaches it is stroked again as one
// path, clipped to the box: the image always matches the stroke so far drawn as one path.
function brushCommit(d, segs) {
  if (!segs.length) return;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const g of segs) {
    g.box = segsBox([g], d.size / 2 + 1);
    d.all.push(g);
    x0 = Math.min(x0, g.box.x); y0 = Math.min(y0, g.box.y);
    x1 = Math.max(x1, g.box.x + g.box.w); y1 = Math.max(y1, g.box.y + g.box.h);
  }
  x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
  x1 = Math.min(base.width, Math.ceil(x1)); y1 = Math.min(base.height, Math.ceil(y1));
  if (x1 <= x0 || y1 <= y0) return;
  const r = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  touch(r.x, r.y, r.w, r.h); // before drawing
  if (!op) { brushPath(bctx, segs, d.color, d.size); return; } // the op was abandoned (GPU context lost)
  for (const p of Core.tileParts(r, base.width, base.height, TILE)) {
    const t = op.tiles.get(p.key);
    if (t.cv) {
      bctx.clearRect(p.x, p.y, p.w, p.h);
      bctx.drawImage(t.cv, t.cx + p.x - t.x, t.cy + p.y - t.y, p.w, p.h, p.x, p.y, p.w, p.h);
    } else bctx.putImageData(t.data, t.x, t.y, p.x - t.x, p.y - t.y, p.w, p.h);
  }
  const hit = d.all.filter(({ box: b }) => b.x < x1 && b.x + b.w > x0 && b.y < y1 && b.y + b.h > y0);
  bctx.save();
  bctx.beginPath();
  bctx.rect(r.x, r.y, r.w, r.h);
  bctx.clip();
  brushPath(bctx, hit, d.color, d.size);
  bctx.restore();
}
// Bounding box of segments grown by h (a quadratic stays inside the hull of its points).
function segsBox(segs, h) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const g of segs) {
    for (const q of g.c ? [g.a, g.b, g.c] : [g.a, g.b]) {
      if (q.x < x0) x0 = q.x; if (q.y < y0) y0 = q.y; if (q.x > x1) x1 = q.x; if (q.y > y1) y1 = q.y;
    }
  }
  return { x: x0 - h, y: y0 - h, w: x1 - x0 + 2 * h, h: y1 - y0 + 2 * h };
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
function drawObj(c, o) {
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
    const r = Core.normRect(a, b);
    if (o.t === 'rect') c.rect(r.x + off, r.y + off, r.w, r.h);
    else c.ellipse(r.x + r.w / 2 + off, r.y + r.h / 2 + off, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
    if (o.mode !== 'outline') { c.fillStyle = o.mode === 'fill' ? o.color : o.alt; c.fill(); }
    if (o.mode !== 'fill') c.stroke();
  }
  c.restore();
}

export { brushCommit, brushPath, drawObj, drawShape, pick, segsBox, setColor, setSize, setTool, shapeObj, stampLine };
