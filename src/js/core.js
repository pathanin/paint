// Pure, DOM-free helpers. CommonJS (module.exports), so node tests require() it as is and the app's
// modules import it through the bundler.
(function () {
  'use strict';

  // Pack RGBA into the u32 layout of a Uint32Array view over ImageData (platform endianness).
  const LITTLE = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
  function rgbaToU32(r, g, b, a) {
    return LITTLE
      ? ((a << 24) | (b << 16) | (g << 8) | r) >>> 0
      : ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
  }

  // Max per-channel difference (0..255); channel order doesn't matter.
  function colorDistance(a, b) {
    let m = 0;
    for (let s = 0; s < 32; s += 8) {
      const d = Math.abs(((a >>> s) & 255) - ((b >>> s) & 255));
      if (d > m) m = d;
    }
    return m;
  }

  // 4-connected scanline flood region from (x, y). tolerance is 0..100 (% of 255, max channel diff).
  // Doesn't touch u32. Returns {mask, box, edge}: mask[i] = 1 for every pixel in the region (w*h
  // bytes), box = its bounding box, edge = the pixels outside it that touch it (8-way) and aren't
  // near target, each once (for fillEdge; found while scanning, so it costs the perimeter, not the
  // area). null when (x, y) is outside the image.
  // Typed-array stacks of pixel indices; no per-span allocation.
  function floodMask(u32, w, h, x, y, tolerance) {
    if (x < 0 || y < 0 || x >= w || y >= h) return null;
    const target = u32[y * w + x];
    const thr = Math.round((tolerance || 0) * 255 / 100);
    const t0 = target & 255, t1 = (target >>> 8) & 255, t2 = (target >>> 16) & 255, t3 = target >>> 24;
    const near = (v) => {
      if (v === target) return true;
      if (thr === 0) return false;
      let d = (v & 255) - t0; if (d > thr || -d > thr) return false;
      d = ((v >>> 8) & 255) - t1; if (d > thr || -d > thr) return false;
      d = ((v >>> 16) & 255) - t2; if (d > thr || -d > thr) return false;
      d = (v >>> 24) - t3; return d <= thr && -d <= thr;
    };
    const mask = new Uint8Array(w * h);
    let stack = new Int32Array(1024), sp = 0;
    const push = (i) => {
      if (sp === stack.length) { const n = new Int32Array(sp * 2); n.set(stack); stack = n; }
      stack[sp++] = i;
    };
    // Edge pixels are marked 2 in mask while flooding (never near, so the flood never wants them).
    let edge = new Int32Array(1024), ep = 0;
    const mark = (i) => {
      if (mask[i]) return;
      if (ep === edge.length) { const n = new Int32Array(ep * 2); n.set(edge); edge = n; }
      mask[i] = 2; edge[ep++] = i;
    };
    push(y * w + x);
    let minX = x, maxX = x, minY = y, maxY = y;
    while (sp) {
      const i = stack[--sp];
      if (mask[i]) continue;
      const sy = (i / w) | 0, row = sy * w;
      let l = i, r = i;
      while (l > row && !mask[l - 1] && near(u32[l - 1])) l--;
      while (r < row + w - 1 && !mask[r + 1] && near(u32[r + 1])) r++;
      mask.fill(1, l, r + 1);
      if (l > row && !mask[l - 1]) mark(l - 1); // stopped by a pixel that isn't near
      if (r < row + w - 1 && !mask[r + 1]) mark(r + 1);
      if (l - row < minX) minX = l - row;
      if (r - row > maxX) maxX = r - row;
      if (sy < minY) minY = sy;
      if (sy > maxY) maxY = sy;
      for (let k = 0; k < 2; k++) {
        const ny = k ? sy + 1 : sy - 1;
        if (ny < 0 || ny >= h) continue;
        const off = (ny - sy) * w;
        let inRun = false;
        for (let j = l; j <= r; j++) {
          const m = mask[j + off], ok = !m && near(u32[j + off]);
          if (ok && !inRun) push(j + off);
          else if (!m && !ok) mark(j + off);
          inRun = ok;
        }
        // the corners touch the span diagonally: edge pixels, but not part of the 4-connected flood
        if (l > row && !mask[l - 1 + off] && !near(u32[l - 1 + off])) mark(l - 1 + off);
        if (r < row + w - 1 && !mask[r + 1 + off] && !near(u32[r + 1 + off])) mark(r + 1 + off);
      }
    }
    for (let k = 0; k < ep; k++) mask[edge[k]] = 0;
    return { mask, box: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }, edge: edge.subarray(0, ep) };
  }

  // The anti-aliased ring around a flood region ({mask, box, edge} from floodMask, seeded on colour
  // target), for a fill with color. Without it, the soft edge pixels of brush strokes, ellipses and
  // text stay a blend with the old colour: a light fringe. Each edge pixel (outside the mask,
  // touching it 8-way, not near target) is taken as a blend a*target + (1-a)*ink, where ink is the
  // colour farthest from target in its 5x5 neighbourhood outside the mask; it becomes
  // a*color + (1-a)*ink, i.e. as if drawn over color. Pixels that aren't on that line (hard-edged
  // art, another colour) are left alone. Soft pixels behind soft pixels (the narrow wedge where two
  // strokes cross, the inside of an M) are reached by growing the ring up to EDGE_DEPTH more pixels
  // through pixels that were recoloured, never onto one that touches another region (a pixel near
  // target outside the mask). Doesn't touch u32 (mask is restored). Returns {idx, val, box}: the
  // pixels that change (indices into u32) and their new values, and the region's box grown to cover
  // them. Straight RGBA lerp: exact for opaque pixels and for ink over transparency.
  const EDGE_DEPTH = 8;
  function fillEdge(u32, w, h, region, target, color, tolerance) {
    const { mask, box, edge } = region;
    const thr = Math.round((tolerance || 0) * 255 / 100);
    const T = [target & 255, (target >>> 8) & 255, (target >>> 16) & 255, target >>> 24];
    const F = [color & 255, (color >>> 8) & 255, (color >>> 16) & 255, color >>> 24];
    const ch = (v, c) => (v >>> (c * 8)) & 255;
    const dist2 = (v) => { let s = 0; for (let c = 0; c < 4; c++) { const d = ch(v, c) - T[c]; s += d * d; } return s; };
    const near = (v) => { for (let c = 0; c < 4; c++) if (Math.abs(ch(v, c) - T[c]) > thr) return false; return true; };
    // Pixels queued for a look are marked 2 in mask (the region is 1) and unmarked at the end.
    const queue = Array.from(edge), depth = new Array(queue.length).fill(0);
    for (const i of queue) mask[i] = 2;
    const idx = [], val = [];
    let bx0 = box.x, by0 = box.y, bx1 = box.x + box.w - 1, by1 = box.y + box.h - 1;
    for (let q = 0; q < queue.length; q++) {
      const i = queue[q], x = i % w, y = (i / w) | 0, p = u32[i];
      let ink = p, far = dist2(p);
      for (let yy = Math.max(0, y - 2); yy <= Math.min(h - 1, y + 2); yy++) {
        for (let xx = Math.max(0, x - 2); xx <= Math.min(w - 1, x + 2); xx++) {
          const j = yy * w + xx;
          if (mask[j] === 1) continue;
          const d = dist2(u32[j]);
          if (d > far) { far = d; ink = u32[j]; }
        }
      }
      // a = (p - ink).(target - ink) / |target - ink|^2, then p must lie on that line.
      let dot = 0;
      for (let c = 0; c < 4; c++) dot += (ch(p, c) - ch(ink, c)) * (T[c] - ch(ink, c));
      const a = Math.min(1, dot / far);
      if (!(a > 0.004)) continue; // under 1/255: nothing to change
      let on = true, out = 0;
      for (let c = 0; c < 4 && on; c++) {
        const v = ch(p, c);
        if (Math.abs(v - (ch(ink, c) + a * (T[c] - ch(ink, c)))) > 12) on = false;
        out |= Math.max(0, Math.min(255, Math.round(v + a * (F[c] - T[c])))) << (c * 8);
      }
      out >>>= 0;
      if (!on || out === p) continue;
      idx.push(i); val.push(out);
      if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y;
      if (depth[q] === EDGE_DEPTH) continue;
      for (let yy = Math.max(0, y - 1); yy <= Math.min(h - 1, y + 1); yy++) {
        for (let xx = Math.max(0, x - 1); xx <= Math.min(w - 1, x + 1); xx++) {
          const j = yy * w + xx;
          if (mask[j] || near(u32[j])) continue;
          let other = false; // touches another region: its soft edge is that region's, not ours
          for (let y2 = Math.max(0, yy - 1); y2 <= Math.min(h - 1, yy + 1) && !other; y2++) {
            for (let x2 = Math.max(0, xx - 1); x2 <= Math.min(w - 1, xx + 1); x2++) {
              const k = y2 * w + x2;
              if (!mask[k] && near(u32[k])) { other = true; break; }
            }
          }
          if (other) continue;
          mask[j] = 2; queue.push(j); depth.push(depth[q] + 1);
        }
      }
    }
    for (const i of queue) mask[i] = 0;
    return { idx: Uint32Array.from(idx), val: Uint32Array.from(val), box: { x: bx0, y: by0, w: bx1 - bx0 + 1, h: by1 - by0 + 1 } };
  }

  // Flood fill in place: mutates u32; returns the changed bbox {x,y,w,h}, or null if no pixel changed.
  function floodFill(u32, w, h, x, y, color, tolerance) {
    if (x < 0 || y < 0 || x >= w || y >= h) return null;
    if (Math.round((tolerance || 0) * 255 / 100) === 0 && u32[y * w + x] === color) return null;
    const { mask, box } = floodMask(u32, w, h, x, y, tolerance);
    let changed = false;
    for (let yy = box.y; yy < box.y + box.h; yy++) {
      for (let i = yy * w + box.x, e = i + box.w; i < e; i++) {
        if (mask[i] && u32[i] !== color) { u32[i] = color; changed = true; }
      }
    }
    return changed ? box : null;
  }

  // The paint bucket's fill: the region of (x, y) and its soft edge (fillEdge) in color, in place in
  // u32. Returns its undo data, or null if no pixel changed: box, the box's pixels before (before,
  // row-major box.w x box.h), the region as a bit mask over the box (bits) and the edge pixels'
  // box indices (ek) and new values (ev). "After" is before with the masked pixels set to color and
  // the edge ones to ev, so neither undo nor redo has to read the canvas back. Runs in a worker
  // (fill-worker.js), or on the main thread if the worker can't start.
  function fillPlan(u32, w, h, x, y, color, tolerance) {
    if (x < 0 || y < 0 || x >= w || y >= h) return null;
    if (Math.round((tolerance || 0) * 255 / 100) === 0 && u32[y * w + x] === color) return null;
    const region = floodMask(u32, w, h, x, y, tolerance), mask = region.mask;
    const edge = fillEdge(u32, w, h, region, u32[y * w + x], color, tolerance), box = edge.box;
    const before = new Uint32Array(box.w * box.h);
    const bits = new Uint8Array(Math.ceil(box.w * box.h / 8));
    let changed = false;
    for (let yy = 0, k = 0; yy < box.h; yy++) {
      const row = (box.y + yy) * w + box.x;
      before.set(u32.subarray(row, row + box.w), yy * box.w);
      for (let i = row, e = i + box.w; i < e; i++, k++) {
        if (!mask[i]) continue;
        bits[k >> 3] |= 1 << (k & 7);
        if (u32[i] !== color) { u32[i] = color; changed = true; }
      }
    }
    const ek = new Uint32Array(edge.idx.length);
    edge.idx.forEach((i, k) => { u32[i] = edge.val[k]; ek[k] = ((i / w | 0) - box.y) * box.w + i % w - box.x; });
    if (!changed && !ek.length) return null;
    return { box, before, bits, ek, ev: edge.val };
  }

  // Bresenham integer line, inclusive of both ends.
  function line(x0, y0, x1, y1) {
    x0 |= 0; y0 |= 0; x1 |= 0; y1 |= 0;
    const pts = [];
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      pts.push([x0, y0]);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
    return pts;
  }

  function normRect(a, b) {
    return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
  }

  // Intersect rect with [0,W)x[0,H); null if empty.
  function clampRect(r, W, H) {
    const x0 = Math.max(0, r.x), y0 = Math.max(0, r.y);
    const x1 = Math.min(W, r.x + r.w), y1 = Math.min(H, r.y + r.h);
    if (x1 <= x0 || y1 <= y0) return null;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  // Shift-constraint: square for rect/ellipse, 0/45/90° snap for line. Returns adjusted end point.
  function constrainShape(start, end, shift, kind) {
    if (!shift) return { x: end.x, y: end.y };
    const dx = end.x - start.x, dy = end.y - start.y;
    const ax = Math.abs(dx), ay = Math.abs(dy);
    const sx = dx < 0 ? -1 : 1, sy = dy < 0 ? -1 : 1;
    if (kind === 'line') {
      const ang = Math.atan2(ay, ax) * 180 / Math.PI;
      if (ang < 22.5) return { x: end.x, y: start.y };
      if (ang > 67.5) return { x: start.x, y: end.y };
      const d = Math.round((ax + ay) / 2); // nearest point on the diagonal
      return { x: start.x + sx * d, y: start.y + sy * d };
    }
    const d = Math.max(ax, ay);
    return { x: start.x + sx * d, y: start.y + sy * d };
  }

  function fitDims(w, h, o) {
    let nw, nh;
    if (o.pct != null) { nw = w * o.pct / 100; nh = h * o.pct / 100; }
    else if (o.lockAspect && o.w != null) { nw = o.w; nh = o.w * h / w; }
    else if (o.lockAspect && o.h != null) { nh = o.h; nw = o.h * w / h; }
    else { nw = o.w != null ? o.w : w; nh = o.h != null ? o.h : h; }
    return { w: Math.max(1, Math.round(nw)), h: Math.max(1, Math.round(nh)) };
  }

  // anchor = vertical (t|m|b) + horizontal (l|c|r). Returns where the old image sits in the new canvas.
  function anchorOffset(oldW, oldH, newW, newH, anchor) {
    const v = anchor[0], hz = anchor[1];
    const dx = hz === 'l' ? 0 : hz === 'r' ? newW - oldW : Math.floor((newW - oldW) / 2);
    const dy = v === 't' ? 0 : v === 'b' ? newH - oldH : Math.floor((newH - oldH) / 2);
    return { dx, dy };
  }

  // New canvas size from dragging a resize handle by (dx, dy) screen px at `zoom`.
  // edge: 'e' (width), 's' (height), 'se' (both; keepAspect follows the larger relative change).
  // maxPixels (optional) caps width x height; the result never rounds over it.
  function dragResize(w, h, dx, dy, edge, zoom, keepAspect, max, maxPixels = Infinity) {
    let nw = edge === 's' ? w : w + dx / zoom;
    let nh = edge === 'e' ? h : h + dy / zoom;
    if (edge === 'se' && keepAspect) {
      const fw = nw / w, fh = nh / h;
      const f = Math.abs(fw - 1) >= Math.abs(fh - 1) ? fw : fh;
      nw = w * f; nh = h * f;
    }
    nw = Math.min(max, Math.max(1, Math.round(nw)));
    nh = Math.min(max, Math.max(1, Math.round(nh)));
    if (nw * nh > maxPixels) {
      if (edge === 'e') nw = Math.max(1, Math.floor(maxPixels / nh));
      else if (edge === 's') nh = Math.max(1, Math.floor(maxPixels / nw));
      else {
        const f = Math.sqrt(maxPixels / (nw * nh));
        nw = Math.max(1, Math.floor(nw * f)); nh = Math.max(1, Math.floor(nh * f));
        while (nw * nh > maxPixels) { if (nw >= nh) nw--; else nh--; } // float error guard
      }
    }
    return { w: nw, h: nh };
  }

  // Why a w x h document can't be created: null if it can. field = the offending side ('w'|'h'),
  // or null when only the total-pixel cap is exceeded.
  function sizeError(w, h, maxDim, maxPixels) {
    if (!(w >= 1 && w <= maxDim)) return { field: 'w', reason: 'range' };
    if (!(h >= 1 && h <= maxDim)) return { field: 'h', reason: 'range' };
    if (w * h > maxPixels) return { field: null, reason: 'area' };
    return null;
  }

  // A file name typed for a download: sanitised the way browsers do, ending in a format we can write.
  // A dot alone isn't an extension ("report v1.2" -> "report v1.2.png"); known unwritable image types become .png.
  // null when nothing usable is left.
  function saveName(typed) {
    if (typeof typed !== 'string') return null;
    typed = typed.trim().replace(/^\.+(?=(png|jpe?g|webp|gif|bmp|tiff?|ico|svg|avif|heic|heif)$)/i, 'untitled.'); // ".png"
    const n = typed.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '').replace(/[. ]+$/, '');
    if (!n) return null;
    if (/\.(png|jpe?g|webp)$/i.test(n)) return n;
    if (/\.(gif|bmp|tiff?|ico|svg|avif|heic|heif)$/i.test(n)) return n.replace(/\.[^.]*$/, '.png');
    return n + '.png';
  }

  // Brush size for [ (dir -1) and ] (dir +1): steps of 1 below 10 px, 2 from there; the two are inverses.
  function stepSize(s, dir) {
    return dir > 0 ? s + (s >= 10 ? 2 : 1) : s - (s > 11 ? 2 : 1);
  }

  // Split rect (grown outward to whole pixels, clipped to the W x H image) into its pieces on a
  // T x T tile grid. key identifies the tile (row-major). Used for copy-on-write undo snapshots.
  function tileParts(r, W, H, T) {
    const x0 = Math.max(0, Math.floor(r.x)), y0 = Math.max(0, Math.floor(r.y));
    const x1 = Math.min(W, Math.ceil(r.x + r.w)), y1 = Math.min(H, Math.ceil(r.y + r.h));
    const out = [];
    if (x1 <= x0 || y1 <= y0) return out;
    const cols = Math.ceil(W / T);
    for (let ty = Math.floor(y0 / T); ty * T < y1; ty++) {
      for (let tx = Math.floor(x0 / T); tx * T < x1; tx++) {
        const px = Math.max(x0, tx * T), py = Math.max(y0, ty * T);
        out.push({ key: ty * cols + tx, tx, ty, x: px, y: py, w: Math.min(x1, (tx + 1) * T) - px, h: Math.min(y1, (ty + 1) * T) - py });
      }
    }
    return out;
  }

  // Batch rects for readback: canvas readbacks have a large fixed cost each, so one read of a
  // bigger box beats many small ones, up to a point. Greedily merges rects (taken top to bottom)
  // while a group's bounding box stays within slack x the area of the rects in it.
  // Returns [{x, y, w, h, items: [rect indices]}].
  function groupRects(rects, slack) {
    const order = rects.map((r, i) => i).sort((a, b) => rects[a].y - rects[b].y || rects[a].x - rects[b].x);
    const groups = [];
    let g = null;
    for (const i of order) {
      const r = rects[i];
      if (g) {
        const x0 = Math.min(g.x, r.x), y0 = Math.min(g.y, r.y);
        const x1 = Math.max(g.x + g.w, r.x + r.w), y1 = Math.max(g.y + g.h, r.y + r.h);
        if ((x1 - x0) * (y1 - y0) <= slack * (g.area + r.w * r.h)) {
          Object.assign(g, { x: x0, y: y0, w: x1 - x0, h: y1 - y0, area: g.area + r.w * r.h });
          g.items.push(i);
          continue;
        }
      }
      g = { x: r.x, y: r.y, w: r.w, h: r.h, area: r.w * r.h, items: [i] };
      groups.push(g);
    }
    return groups.map(({ area, ...rest }) => rest);
  }

  function rotateDims(w, h, deg) {
    return Math.abs(deg) % 180 === 90 ? { w: h, h: w } : { w, h };
  }

  // Smoothed freehand path for the brush. Two ideas combined:
  // - lazy-brush stabiliser: the brush stays put while the pointer is within `radius`, then is pulled
  //   along by (distance - radius). Position-based, so it doesn't depend on the event rate or drift when idle.
  // - midpoint quadratic chain (as tldraw renders freehand): curves run through the midpoints of
  //   consecutive points, with the points as control points, so there are no polyline corners.
  // add() returns segments that will never change (commit them); tail() is the rest of the path if the
  // stroke ended at q now, and finish() returns the same. The path starts at the pointerdown point and
  // ends exactly at the release point; in between it stays within radius (+ minStep) of every sample.
  // Segments are { a, c, b }: a quadratic from a to b with control c, or a straight line when c is null.
  const mid = (p, q) => ({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 });
  class Stroke {
    constructor(p, radius = 0, minStep = 0) {
      this.radius = radius; this.minStep = minStep;
      this.pts = [{ x: p.x, y: p.y }];
      this.brush = { x: p.x, y: p.y };
    }
    // Segment k of the chain over points X: ends at the midpoint of X[k-1] and X[k].
    static seg(X, k) {
      return { a: k === 2 ? X[0] : mid(X[k - 2], X[k - 1]), c: X[k - 1], b: mid(X[k - 1], X[k]) };
    }
    add(q) {
      const b = this.brush, dx = q.x - b.x, dy = q.y - b.y, d = Math.hypot(dx, dy);
      if (d <= this.radius) return [];
      const k = (d - this.radius) / d;
      b.x += dx * k; b.y += dy * k;
      const last = this.pts[this.pts.length - 1];
      const step = Math.hypot(b.x - last.x, b.y - last.y);
      if (!step || step < this.minStep) return [];
      this.pts.push({ x: b.x, y: b.y });
      return this.pts.length >= 3 ? [Stroke.seg(this.pts, this.pts.length - 1)] : [];
    }
    tail(q) {
      const P = this.pts, last = P[P.length - 1];
      const X = q.x === last.x && q.y === last.y ? P : P.concat({ x: q.x, y: q.y });
      const m = X.length - 1;
      if (m === 0) return [];
      const out = [];
      for (let k = Math.max(2, P.length); k <= m; k++) out.push(Stroke.seg(X, k));
      out.push({ a: m >= 2 ? mid(X[m - 1], X[m]) : X[0], c: null, b: X[m] });
      return out;
    }
    finish(q) { return this.tail(q); }
  }

  // Undo/redo stacks bounded by entry count and total bytes (both stacks). Newest entry always survives.
  // The save point is the entry on top of the undo stack when the document was last saved
  // (null = the base state). It becomes LOST once that state can no longer be reached.
  const LOST = {};
  class History {
    // onDrop(entry) runs for each entry that becomes unreachable (evicted, discarded redo, cleared),
    // so the owner can free big buffers now instead of at the next GC.
    constructor({ maxBytes = 256 * 1024 * 1024, maxCount = 100, onDrop = null } = {}) {
      this.maxBytes = maxBytes; this.maxCount = maxCount; this.onDrop = onDrop;
      this.undoStack = []; this.redoStack = [];
      this.clear();
    }
    top() { return this.undoStack.length ? this.undoStack[this.undoStack.length - 1] : null; }
    push(entry) {
      for (const e of this.redoStack) {
        this.bytes -= e.bytes || 0;
        if (e === this.saved) this.saved = LOST;
        if (this.onDrop) this.onDrop(e);
      }
      this.redoStack = [];
      this.undoStack.push(entry);
      this.bytes += entry.bytes || 0;
      let evicted = 0;
      while (this.undoStack.length > 1 &&
             (this.undoStack.length > this.maxCount || this.bytes > this.maxBytes)) {
        const gone = this.undoStack.shift();
        this.bytes -= gone.bytes || 0;
        if (this.saved === null) this.saved = LOST; // the base state is gone
        else if (gone === this.saved) this.saved = null; // the saved state is the new base
        if (this.onDrop) this.onDrop(gone);
        evicted++;
      }
      return evicted;
    }
    undo() {
      const e = this.undoStack.pop();
      if (!e) return null;
      this.redoStack.push(e);
      return e;
    }
    redo() {
      const e = this.redoStack.pop();
      if (!e) return null;
      this.undoStack.push(e);
      return e;
    }
    canUndo() { return this.undoStack.length > 0; }
    canRedo() { return this.redoStack.length > 0; }
    markSaved(entry = this.top()) { this.saved = entry; }
    isClean() { return this.saved !== LOST && this.top() === this.saved; }
    // Drop the entries whose stored state is gone (isLost(entry)), and with them every entry that can
    // only be reached by stepping through one: all older undo entries, all further redo entries.
    // Returns the number dropped.
    dropLost(isLost) {
      const u = this.undoStack.map(isLost).lastIndexOf(true) + 1;
      const r = this.redoStack.map(isLost).lastIndexOf(true) + 1; // redoStack[0] is the furthest redo
      const gone = [...this.undoStack.splice(0, u), ...this.redoStack.splice(0, r)];
      if (u && this.saved === null) this.saved = LOST;
      for (const e of gone) {
        this.bytes -= e.bytes || 0;
        if (e === this.saved) this.saved = LOST;
        if (this.onDrop) this.onDrop(e);
      }
      return gone.length;
    }
    clear() {
      if (this.onDrop) for (const e of [...this.undoStack, ...this.redoStack]) this.onDrop(e);
      this.undoStack = []; this.redoStack = []; this.bytes = 0; this.saved = null;
    }
  }

  // ---------- objects: live shapes drawn above the raster ----------
  // An object {id, t: 'rect' | 'ellipse' | 'line', a, b, color, alt, size, mode} is immutable: an
  // edit makes a new one with the same id. a and b are image px: the corners of the box (rect,
  // ellipse; either order) or the ends (line).
  // Everything drawing o can paint (as the shape tools' box).
  // Other kinds (docs/total-objects.md):
  //  - pencil, eraser: {pts: [x0, y0, x1, y1, ...] integer px, color, size}: square stamps along each
  //    Bresenham line between consecutive points, as the tools paint (the eraser in colour 2);
  //  - brush: {segs: [{a, c, b}] (Core.Stroke segments; c null for a straight one), color, size};
  //  - text: {x, y, lines, font, fs, color, base (px from a line's top to its baseline), w};
  //  - image, fill: {x, y, w, h, asset} (a canvas held by asset.cv; a fill's asset also keeps its
  //    region's bitset, bits, for hit tests).
  //  text, image and fill may carry m = [a, b, c, d], a linear map about (x, y) (rotate, flip, scale).
  const STROKES = new Set(['pencil', 'eraser', 'brush']), SHAPE_KINDS = new Set(['line', 'rect', 'ellipse']);
  // The content rect of a text, image or fill before m: (x, y) is its origin.
  function frameSize(o) {
    if (o.t === 'text') return { x: -o.fs / 2, y: -o.fs / 2, w: o.w + o.fs, h: o.lines.length * o.fs * 1.2 + o.fs };
    return { x: 0, y: 0, w: o.w, h: o.h };
  }
  // Integer bounding box of r = {x, y, w, h} (relative to o.x, o.y) after o.m.
  function mappedBox(o, r) {
    const m = o.m || [1, 0, 0, 1];
    const xs = [], ys = [];
    for (const [px, py] of [[r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h]]) {
      xs.push(o.x + m[0] * px + m[2] * py); ys.push(o.y + m[1] * px + m[3] * py);
    }
    const x = Math.floor(Math.min(...xs)), y = Math.floor(Math.min(...ys));
    return { x, y, w: Math.ceil(Math.max(...xs)) - x, h: Math.ceil(Math.max(...ys)) - y };
  }
  function objBox(o) {
    if (o.t === 'pencil' || o.t === 'eraser') {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let i = 0; i < o.pts.length; i += 2) {
        x0 = Math.min(x0, o.pts[i]); x1 = Math.max(x1, o.pts[i]); y0 = Math.min(y0, o.pts[i + 1]); y1 = Math.max(y1, o.pts[i + 1]);
      }
      const off = Math.floor(o.size / 2);
      return { x: x0 - off, y: y0 - off, w: x1 - x0 + o.size, h: y1 - y0 + o.size };
    }
    if (o.t === 'brush') {
      const b = segsBox(o.segs, o.size / 2 + 1), x = Math.floor(b.x), y = Math.floor(b.y);
      return { x, y, w: Math.ceil(b.x + b.w) - x, h: Math.ceil(b.y + b.h) - y };
    }
    if (!SHAPE_KINDS.has(o.t)) return mappedBox(o, frameSize(o));
    const r = normRect(o.a, o.b), lw = o.size;
    return { x: r.x - lw, y: r.y - lw, w: r.w + 2 * lw + 1, h: r.h + 2 * lw + 1 };
  }
  // The outline the selection shows: a shape's drawn box, else the content's box.
  function objFrame(o) {
    if (SHAPE_KINDS.has(o.t)) { const g = drawnObj(o); return normRect(g.a, g.b); }
    if (STROKES.has(o.t)) return objBox(o);
    return mappedBox(o, o.t === 'text' ? { x: 0, y: 0, w: o.w, h: o.lines.length * o.fs * 1.2 } : frameSize(o));
  }
  // Bounding box of brush segments grown by h (a quadratic stays inside the hull of its points).
  function segsBox(segs, h) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const g of segs) {
      for (const q of g.c ? [g.a, g.b, g.c] : [g.a, g.b]) {
        if (q.x < x0) x0 = q.x; if (q.y < y0) y0 = q.y; if (q.x > x1) x1 = q.x; if (q.y > y1) y1 = q.y;
      }
    }
    return { x: x0 - h, y: y0 - h, w: x1 - x0 + 2 * h, h: y1 - y0 + 2 * h };
  }
  function segDist(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y, n = dx * dx + dy * dy;
    const t = n ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / n)) : 0;
    return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
  }
  // o as drawn: an odd stroke width is drawn on pixel centres (+0.5, see drawObj in objects.js) and an
  // even one on the points themselves. Hit tests and handles use this, so they sit on the stroke.
  function drawnObj(o) {
    if (!SHAPE_KINDS.has(o.t) || !(o.size % 2)) return o;
    return { ...o, a: { x: o.a.x + 0.5, y: o.a.y + 0.5 }, b: { x: o.b.x + 0.5, y: o.b.y + 0.5 } };
  }
  // Is p on o? tol is extra reach in image px (callers pass a few screen px over the zoom), so thin
  // outlines stay clickable at any zoom. Filled shapes hit inside; outlines only near their edge.
  function hitsObject(o, p, tol) {
    if (o.locked) return false; // the base (the opened picture) can't be picked
    if (!SHAPE_KINDS.has(o.t)) return hitsOther(o, p, tol);
    o = drawnObj(o);
    const half = o.size / 2 + tol, filled = o.mode !== 'outline';
    if (o.t === 'line') return segDist(p, o.a, o.b) <= half;
    const r = normRect(o.a, o.b);
    if (o.t === 'ellipse' && r.w > 0 && r.h > 0) {
      const rx = r.w / 2, ry = r.h / 2, cx = r.x + rx, cy = r.y + ry;
      const k = Math.hypot((p.x - cx) / rx, (p.y - cy) / ry), c = Math.hypot(p.x - cx, p.y - cy);
      if (k < 1 && filled) return true;
      return k === 0 ? Math.min(rx, ry) <= half : Math.abs((k - 1) * c / k) <= half; // radial distance to the edge
    }
    if (o.t === 'ellipse') return segDist(p, { x: r.x, y: r.y }, { x: r.x + r.w, y: r.y + r.h }) <= half; // flat: a line
    const dx = Math.max(r.x - p.x, p.x - r.x - r.w), dy = Math.max(r.y - p.y, p.y - r.y - r.h);
    if (dx <= 0 && dy <= 0) return filled || -Math.max(dx, dy) <= half; // inside: distance to the nearest edge
    return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) <= half;
  }
  function hitsOther(o, p, tol) {
    const half = o.size / 2 + tol;
    if (o.t === 'pencil' || o.t === 'eraser') {
      const c = (o.size % 2 ? 0.5 : 0); // a stamp's centre: odd sizes centre on the pixel
      const q = (i) => ({ x: o.pts[i] + c, y: o.pts[i + 1] + c });
      if (o.pts.length === 2) return segDist(p, q(0), q(0)) <= half;
      for (let i = 0; i + 3 < o.pts.length; i += 2) if (segDist(p, q(i), q(i + 2)) <= half) return true;
      return false;
    }
    if (o.t === 'brush') {
      for (const g of o.segs) {
        if (g.c ? segDist(p, g.a, g.c) <= half || segDist(p, g.c, g.b) <= half : segDist(p, g.a, g.b) <= half) return true;
      }
      return false;
    }
    // text, image, fill: inside the content (mapped back through m), a fill only on its pixels
    const m = o.m || [1, 0, 0, 1], det = m[0] * m[3] - m[1] * m[2], dx = p.x - o.x, dy = p.y - o.y;
    const u = (m[3] * dx - m[2] * dy) / det, v = (-m[1] * dx + m[0] * dy) / det;
    const f = frameSize(o), t = tol / Math.sqrt(Math.abs(det));
    if (u < f.x - t || v < f.y - t || u > f.x + f.w + t || v > f.y + f.h + t) return false;
    if (o.t !== 'fill' || !o.asset.bits) return true;
    const x = Math.floor(u), y = Math.floor(v);
    if (x < 0 || y < 0 || x >= o.w || y >= o.h) return true; // the tolerance band around it
    const k = y * o.w + x;
    return !!(o.asset.bits[k >> 3] & (1 << (k & 7))); // the filled region (its soft edge is next to it)
  }
  // Is p inside the closed shape o (a rectangle or an ellipse, any fill mode)?
  function insideShape(o, p) {
    if (o.t !== 'rect' && o.t !== 'ellipse') return false;
    const r = normRect(drawnObj(o).a, drawnObj(o).b);
    if (r.w <= 0 || r.h <= 0) return false;
    if (o.t === 'rect') return p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h;
    return Math.hypot((p.x - r.x - r.w / 2) / (r.w / 2), (p.y - r.y - r.h / 2) / (r.h / 2)) < 1;
  }
  // Index of the topmost object (the list runs bottom to top) at p, or -1.
  function hitObject(objs, p, tol) {
    for (let i = objs.length - 1; i >= 0; i--) if (hitsObject(objs[i], p, tol)) return i;
    return -1;
  }
  // Resize handles: the two ends of a line; the corners, then the edge midpoints, of a box. gap (image
  // px) leaves out the midpoints of a side shorter than it, where they'd crowd the corners.
  const objHandles = (o, gap = 0) => (SHAPE_KINDS.has(o.t) ? handlesOf(drawnObj(o), gap) : []);
  function handlesOf(o, gap) { // o: as drawn
    if (o.t === 'line') return [{ h: 'a', x: o.a.x, y: o.a.y }, { h: 'b', x: o.b.x, y: o.b.y }];
    const r = normRect(o.a, o.b), x1 = r.x + r.w, y1 = r.y + r.h, mx = r.x + r.w / 2, my = r.y + r.h / 2;
    const hs = [{ h: 'nw', x: r.x, y: r.y }, { h: 'ne', x: x1, y: r.y }, { h: 'se', x: x1, y: y1 }, { h: 'sw', x: r.x, y: y1 }];
    if (r.w >= gap) hs.push({ h: 'n', x: mx, y: r.y });
    if (r.h >= gap) hs.push({ h: 'e', x: x1, y: my });
    if (r.w >= gap) hs.push({ h: 's', x: mx, y: y1 });
    if (r.h >= gap) hs.push({ h: 'w', x: r.x, y: my });
    return hs;
  }
  // The nearest handle within tol of p (on a tie a corner, so a tiny box stays resizable), or null.
  // Inside the shape a handle reaches at most a quarter of its short side, so the middle of a small
  // box (or a short line) is left free for moving it.
  function handleAt(o, p, tol, gap = 0) {
    if (!SHAPE_KINDS.has(o.t)) return null;
    o = drawnObj(o);
    let reach = tol;
    if (o.t === 'line') {
      const dx = o.b.x - o.a.x, dy = o.b.y - o.a.y, n = dx * dx + dy * dy;
      const t = n ? ((p.x - o.a.x) * dx + (p.y - o.a.y) * dy) / n : -1;
      if (t > 0 && t < 1) reach = Math.min(tol, Math.sqrt(n) / 4);
    } else {
      const r = normRect(o.a, o.b);
      if (p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h) reach = Math.min(tol, Math.min(r.w, r.h) / 4);
    }
    let best = null, bd = Infinity;
    for (const q of handlesOf(o, gap)) {
      const d = Math.max(Math.abs(q.x - p.x), Math.abs(q.y - p.y));
      if (d <= reach && d < bd) { best = q.h; bd = d; }
    }
    return best;
  }
  // o with handle h dragged by (dx, dy). A box keeps its other edges, so it can flip past them.
  // keep (Shift): a corner scales the box from the opposite corner and an edge scales it about its
  // middle, both keeping the aspect ratio; a line end snaps to 0°, 45° or 90° from the other end.
  function resizeObj(o, h, dx, dy, keep = false) {
    if (h === 'a' || h === 'b') {
      const q = { x: o[h].x + dx, y: o[h].y + dy };
      return { ...o, [h]: keep ? constrainShape(o[h === 'a' ? 'b' : 'a'], q, true, 'line') : q };
    }
    const r = normRect(o.a, o.b);
    let x0 = r.x, y0 = r.y, x1 = r.x + r.w, y1 = r.y + r.h;
    if (h.includes('w')) x0 += dx;
    if (h.includes('e')) x1 += dx;
    if (h.includes('n')) y0 += dy;
    if (h.includes('s')) y1 += dy;
    if (keep && r.w > 0 && r.h > 0) {
      const sx = (x1 - x0) / r.w, sy = (y1 - y0) / r.h; // signed: negative once flipped
      const corner = h.length === 2;
      const s = corner ? Math.max(Math.abs(sx), Math.abs(sy)) : Math.abs(h === 'e' || h === 'w' ? sx : sy);
      const w = Math.round(s * r.w), ht = Math.round(s * r.h);
      const fx = (h === 'n' || h === 's' ? 1 : sx) < 0 ? -1 : 1, fy = (h === 'e' || h === 'w' ? 1 : sy) < 0 ? -1 : 1;
      if (h.includes('w')) x0 = x1 - fx * w; else if (h.includes('e')) x1 = x0 + fx * w;
      else { x0 = Math.round(r.x + r.w / 2 - w / 2); x1 = x0 + w; }
      if (h.includes('n')) y0 = y1 - fy * ht; else if (h.includes('s')) y1 = y0 + fy * ht;
      else { y0 = Math.round(r.y + r.h / 2 - ht / 2); y1 = y0 + ht; }
    }
    return { ...o, a: { x: x0, y: y0 }, b: { x: x1, y: y1 } };
  }
  const mapPts = (pts, f) => { const out = []; for (let i = 0; i < pts.length; i += 2) { const q = f({ x: pts[i], y: pts[i + 1] }); out.push(q.x, q.y); } return out; };
  const mapSegs = (segs, f) => segs.map((g) => ({ a: f(g.a), c: g.c && f(g.c), b: f(g.b) }));
  function moveObj(o, dx, dy) {
    const f = (q) => ({ x: q.x + dx, y: q.y + dy });
    if (o.t === 'pencil' || o.t === 'eraser') return { ...o, pts: mapPts(o.pts, f) };
    if (o.t === 'brush') return { ...o, segs: mapSegs(o.segs, f) };
    if (!SHAPE_KINDS.has(o.t)) return { ...o, x: o.x + dx, y: o.y + dy };
    return { ...o, a: f(o.a), b: f(o.b) };
  }
  // o after a whole-image rotate or flip of a W × H image (Core.rotateDims gives the new size). Odd
  // stroke widths are drawn on pixel centres and even ones on pixel edges, so pixel x mirrors to
  // W - 1 - x for the first and W - x for the second: the shape lands on the pixels the image's did.
  // Pencil and eraser stamps are squares of size px from (x - floor(size / 2)), so they map like a shape
  // of the same width: k = 1 for odd sizes. A brush is continuous geometry (k = 0). Text, images and
  // fills map their origin continuously and compose the turn or flip into m.
  function transformObj(o, kind, W, H) {
    const k = SHAPE_KINDS.has(o.t) || o.t === 'pencil' || o.t === 'eraser' ? (o.size % 2 ? 1 : 0) : 0;
    const f = kind === 'rotR' ? (p) => ({ x: H - k - p.y, y: p.x })
      : kind === 'rotL' ? (p) => ({ x: p.y, y: W - k - p.x })
      : kind === 'flipH' ? (p) => ({ x: W - k - p.x, y: p.y })
      : (p) => ({ x: p.x, y: H - k - p.y });
    if (o.t === 'pencil' || o.t === 'eraser') return { ...o, pts: mapPts(o.pts, f) };
    if (o.t === 'brush') return { ...o, segs: mapSegs(o.segs, f) };
    if (!SHAPE_KINDS.has(o.t)) {
      const L = kind === 'rotR' ? [0, 1, -1, 0] : kind === 'rotL' ? [0, -1, 1, 0] : kind === 'flipH' ? [-1, 0, 0, 1] : [1, 0, 0, -1];
      const m = o.m || [1, 0, 0, 1], q = f({ x: o.x, y: o.y });
      return { ...o, x: q.x, y: q.y, m: [L[0] * m[0] + L[2] * m[1], L[1] * m[0] + L[3] * m[1], L[0] * m[2] + L[2] * m[3], L[1] * m[2] + L[3] * m[3]] };
    }
    return { ...o, a: f(o.a), b: f(o.b) };
  }
  // o after scaling the image by (sx, sy): the drawn geometry scales, and so does the stroke (by the
  // geometric mean, at least 1 px), as it would have had the shape been pixels.
  function scaleObj(o, sx, sy) {
    if (!SHAPE_KINDS.has(o.t) && !STROKES.has(o.t)) {
      const m = o.m || [1, 0, 0, 1];
      return { ...o, x: o.x * sx, y: o.y * sy, m: [m[0] * sx, m[1] * sy, m[2] * sx, m[3] * sy] };
    }
    const size = Math.max(1, Math.round(o.size * Math.sqrt(sx * sy)));
    if (o.t === 'brush') return { ...o, size, segs: mapSegs(o.segs, (p) => ({ x: p.x * sx, y: p.y * sy })) };
    if (o.t === 'pencil' || o.t === 'eraser') {
      const c = o.size % 2 ? 0.5 : 0, c2 = size % 2 ? 0.5 : 0;
      return { ...o, size, pts: mapPts(o.pts, (p) => ({ x: Math.round((p.x + c) * sx - c2), y: Math.round((p.y + c) * sy - c2) })) };
    }
    const off = o.size % 2 ? 0.5 : 0, off2 = size % 2 ? 0.5 : 0;
    const f = (p) => ({ x: Math.round((p.x + off) * sx - off2), y: Math.round((p.y + off) * sy - off2) });
    return { ...o, a: f(o.a), b: f(o.b), size };
  }

  // Fractional z-keys (as Figma and tldraw order siblings): strings that sort in stacking order, so
  // an object can go between two others without renumbering the rest. zBetween(a, b) is a key
  // strictly between a and b (null: no bound on that side). The scheme is David Greenspan's
  // "fractional indexing" (also in tldraw): an integer part whose first character gives its length
  // (a0..az, b00.., and downwards Zz..), then a fraction. So appending or prepending stays short (5,000
  // appends: 4 characters) and only inserting into one gap again and again makes keys longer.
  // Digits are 0-9A-Za-z, in ASCII order, so plain string comparison sorts them.
  const ZD = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  function zMid(a, b) { // fractions a < b (b null: 1), no trailing zeros
    if (b != null) {
      let n = 0;
      while ((a[n] || '0') === b[n]) n++;
      if (n > 0) return b.slice(0, n) + zMid(a.slice(n), b.slice(n));
    }
    const da = a ? ZD.indexOf(a[0]) : 0, db = b != null ? ZD.indexOf(b[0]) : ZD.length;
    if (db - da > 1) return ZD[Math.round((da + db) / 2)];
    if (b && b.length > 1) return b.slice(0, 1);
    return ZD[da] + zMid(a.slice(1), null);
  }
  function zIntLen(h) {
    if (h >= 'a' && h <= 'z') return h.charCodeAt(0) - 95;
    if (h >= 'A' && h <= 'Z') return 92 - h.charCodeAt(0);
    throw new Error('bad z-key head ' + h);
  }
  const zInt = (k) => k.slice(0, zIntLen(k[0]));
  function zInc(x) {
    const ds = x.slice(1).split('');
    let i = ds.length - 1;
    for (; i >= 0; i--) { const d = ZD.indexOf(ds[i]) + 1; if (d < ZD.length) { ds[i] = ZD[d]; break; } ds[i] = '0'; }
    if (i >= 0) return x[0] + ds.join('');
    if (x[0] === 'Z') return 'a0';
    if (x[0] === 'z') return null;
    const h = String.fromCharCode(x.charCodeAt(0) + 1);
    if (h > 'a') ds.push('0'); else ds.pop();
    return h + ds.join('');
  }
  function zDec(x) {
    const ds = x.slice(1).split('');
    let i = ds.length - 1;
    for (; i >= 0; i--) { const d = ZD.indexOf(ds[i]) - 1; if (d >= 0) { ds[i] = ZD[d]; break; } ds[i] = 'z'; }
    if (i >= 0) return x[0] + ds.join('');
    if (x[0] === 'a') return 'Zz';
    if (x[0] === 'A') return null;
    const h = String.fromCharCode(x.charCodeAt(0) - 1);
    if (h < 'Z') ds.push('z'); else ds.pop();
    return h + ds.join('');
  }
  function zBetween(a, b) {
    if (a != null && b != null && !(a < b)) throw new Error(`zBetween: ${a} is not below ${b}`);
    if (a == null && b == null) return 'a0';
    if (a == null) {
      const ib = zInt(b), fb = b.slice(ib.length);
      if (ib === 'A' + '0'.repeat(26)) return ib + zMid('', fb);
      if (ib < b) return ib;
      const r = zDec(ib);
      if (r == null) throw new Error('zBetween: no key below ' + b);
      return r;
    }
    const ia = zInt(a), fa = a.slice(ia.length);
    if (b == null) { const r = zInc(ia); return r == null ? ia + zMid(fa, null) : r; }
    const ib = zInt(b), fb = b.slice(ib.length);
    if (ia === ib) return ia + zMid(fa, fb);
    const r = zInc(ia);
    return r != null && r < b ? r : ia + zMid(fa, null);
  }
  // Undo entries for objects are diffs: pairs [now, then] by id, where now is the object in the live
  // list (null: absent) and then the one to put back (null: none). diffObjs(prev, next) gives the
  // pairs that turn next back into prev; applyPairs(list, pairs) does it, keeping z order (lists are
  // sorted by o.z), and the swapped pairs [then, now] undo that again. Same ids in the same order (a
  // move, a restyle) is one reference walk; otherwise a map by id.
  function diffObjs(prev, next) {
    const pairs = [];
    if (prev.length === next.length) {
      let same = true;
      for (let i = 0; i < prev.length && same; i++) same = prev[i].id === next[i].id;
      if (same) {
        for (let i = 0; i < prev.length; i++) if (prev[i] !== next[i]) pairs.push([next[i], prev[i]]);
        return pairs;
      }
    }
    const was = new Map(prev.map((o) => [o.id, o]));
    for (const o of next) { const p = was.get(o.id); was.delete(o.id); if (p !== o) pairs.push([o, p || null]); }
    for (const p of was.values()) pairs.push([null, p]);
    return pairs;
  }
  function applyPairs(list, pairs) {
    const ids = new Set(pairs.map(([n, t]) => (n || t).id));
    const out = list.filter((o) => !ids.has(o.id));
    for (const [, t] of pairs) {
      if (!t) continue;
      let lo = 0, hi = out.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (out[m].z < t.z) lo = m + 1; else hi = m; }
      out.splice(lo, 0, t);
    }
    return out;
  }

  // PNG chunks, for saving the objects inside a PNG (docs/total-objects.md, Phase 5): every other app
  // sees the picture; Paint finds its private chunk, paNt (ancillary, private, safe to copy: the case of
  // each letter says so), and restores the objects.
  let CRC_T = null;
  function crc32(u8) {
    if (!CRC_T) {
      CRC_T = new Uint32Array(256);
      for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC_T[n] = c >>> 0; }
    }
    let c = 0xffffffff;
    for (let i = 0; i < u8.length; i++) c = CRC_T[(c ^ u8[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];
  // [{type, start (of the length field), len (of the data), crcOk}], or null if u8 isn't a PNG.
  function pngChunks(u8) {
    if (u8.length < 8 || PNG_SIG.some((b, i) => u8[i] !== b)) return null;
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), out = [];
    for (let i = 8; i + 12 <= u8.length;) {
      const len = dv.getUint32(i), type = String.fromCharCode(u8[i + 4], u8[i + 5], u8[i + 6], u8[i + 7]);
      if (i + 12 + len > u8.length) break;
      out.push({ type, start: i, len, crcOk: crc32(u8.subarray(i + 4, i + 8 + len)) === dv.getUint32(i + 8 + len) });
      i += 12 + len;
      if (type === 'IEND') break;
    }
    return out;
  }
  // The data of the first chunk of this type with a good CRC, or null.
  function readChunk(u8, type) {
    const c = (pngChunks(u8) || []).find((x) => x.type === type && x.crcOk);
    return c ? u8.slice(c.start + 8, c.start + 8 + c.len) : null;
  }
  // u8 with chunk (type, data) just before IEND, and no other chunk of that type.
  function withChunk(u8, type, data) {
    const cs = pngChunks(u8), parts = [u8.subarray(0, 8)];
    for (const c of cs) {
      if (c.type === type) continue;
      if (c.type === 'IEND') {
        const ch = new Uint8Array(12 + data.length), dv = new DataView(ch.buffer);
        dv.setUint32(0, data.length);
        for (let k = 0; k < 4; k++) ch[4 + k] = type.charCodeAt(k);
        ch.set(data, 8);
        dv.setUint32(8 + data.length, crc32(ch.subarray(4, 8 + data.length)));
        parts.push(ch);
      }
      parts.push(u8.subarray(c.start, c.start + 12 + c.len));
    }
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let i = 0;
    for (const p of parts) { out.set(p, i); i += p.length; }
    return out;
  }

  // Strokes in the saved chunk (persist.js): pencil and eraser points as deltas from the previous
  // point (small integers), brush segments as one flat array [ax, ay, cx, cy, bx, by, ...] (c: null,
  // null). Exact both ways: the brush's float coordinates are kept as they are, not delta-coded.
  function packObj(o) {
    if (o.pts) {
      const { pts, ...rest } = o, pd = pts.map((v, i) => (i < 2 ? v : v - pts[i - 2]));
      return { ...rest, pd };
    }
    if (o.segs) {
      const { segs, ...rest } = o, sg = [];
      for (const g of segs) sg.push(g.a.x, g.a.y, g.c ? g.c.x : null, g.c ? g.c.y : null, g.b.x, g.b.y);
      return { ...rest, sg };
    }
    return o;
  }
  function unpackObj(o) {
    if (o.pd) {
      const { pd, ...rest } = o, pts = [];
      pd.forEach((d, i) => pts.push(i < 2 ? d : pts[i - 2] + d));
      return { ...rest, pts };
    }
    if (o.sg) {
      const { sg, ...rest } = o, segs = [];
      for (let i = 0; i < sg.length; i += 6) segs.push({ a: { x: sg[i], y: sg[i + 1] }, c: sg[i + 2] == null ? null : { x: sg[i + 2], y: sg[i + 3] }, b: { x: sg[i + 4], y: sg[i + 5] } });
      return { ...rest, segs };
    }
    return o;
  }

  // The tiles redraw() repaints for dirty rects: every T x T grid tile of the W x H image that a rect
  // (grown to whole pixels) touches, once each, as {key, x, y, w, h} (edge tiles are clipped).
  function dirtyTiles(rects, W, H, T) {
    const seen = new Map();
    for (const r of rects) {
      for (const p of tileParts(r, W, H, T)) {
        if (seen.has(p.key)) continue;
        const x = p.tx * T, y = p.ty * T;
        seen.set(p.key, { key: p.key, x, y, w: Math.min(T, W - x), h: Math.min(T, H - y) });
      }
    }
    return [...seen.values()];
  }

  const Core = { rgbaToU32, colorDistance, floodMask, fillEdge, floodFill, fillPlan, line, normRect, clampRect, constrainShape, fitDims, anchorOffset, dragResize, sizeError, saveName, stepSize, tileParts, groupRects, rotateDims, Stroke, History, zBetween, dirtyTiles, diffObjs, applyPairs, crc32, pngChunks, readChunk, withChunk, packObj, unpackObj,
    objBox, objFrame, insideShape, segsBox, drawnObj, hitsObject, hitObject, objHandles, handleAt, resizeObj, moveObj, transformObj, scaleObj };
  module.exports = Core;
})();
