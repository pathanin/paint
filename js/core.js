// Pure, DOM-free helpers. Loaded as a classic script (window.Core) and by node tests (module.exports).
(function (root) {
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
  function objBox(o) {
    const r = normRect(o.a, o.b), lw = o.size;
    return { x: r.x - lw, y: r.y - lw, w: r.w + 2 * lw + 1, h: r.h + 2 * lw + 1 };
  }
  function segDist(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y, n = dx * dx + dy * dy;
    const t = n ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / n)) : 0;
    return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
  }
  // o as drawn: an odd stroke width is drawn on pixel centres (+0.5, see drawObj in app.js) and an
  // even one on the points themselves. Hit tests and handles use this, so they sit on the stroke.
  function drawnObj(o) {
    if (!(o.size % 2)) return o;
    return { ...o, a: { x: o.a.x + 0.5, y: o.a.y + 0.5 }, b: { x: o.b.x + 0.5, y: o.b.y + 0.5 } };
  }
  // Is p on o? tol is extra reach in image px (callers pass a few screen px over the zoom), so thin
  // outlines stay clickable at any zoom. Filled shapes hit inside; outlines only near their edge.
  function hitsObject(o, p, tol) {
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
  // Index of the topmost object (the list runs bottom to top) at p, or -1.
  function hitObject(objs, p, tol) {
    for (let i = objs.length - 1; i >= 0; i--) if (hitsObject(objs[i], p, tol)) return i;
    return -1;
  }
  // Resize handles: the two ends of a line; the corners, then the edge midpoints, of a box. gap (image
  // px) leaves out the midpoints of a side shorter than it, where they'd crowd the corners.
  const objHandles = (o, gap = 0) => handlesOf(drawnObj(o), gap);
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
  const moveObj = (o, dx, dy) => ({ ...o, a: { x: o.a.x + dx, y: o.a.y + dy }, b: { x: o.b.x + dx, y: o.b.y + dy } });
  // o after a whole-image rotate or flip of a W × H image (Core.rotateDims gives the new size). Odd
  // stroke widths are drawn on pixel centres and even ones on pixel edges, so pixel x mirrors to
  // W - 1 - x for the first and W - x for the second: the shape lands on the pixels the image's did.
  function transformObj(o, kind, W, H) {
    const k = o.size % 2 ? 1 : 0;
    const f = kind === 'rotR' ? (p) => ({ x: H - k - p.y, y: p.x })
      : kind === 'rotL' ? (p) => ({ x: p.y, y: W - k - p.x })
      : kind === 'flipH' ? (p) => ({ x: W - k - p.x, y: p.y })
      : (p) => ({ x: p.x, y: H - k - p.y });
    return { ...o, a: f(o.a), b: f(o.b) };
  }
  // o after scaling the image by (sx, sy): the drawn geometry scales, and so does the stroke (by the
  // geometric mean, at least 1 px), as it would have had the shape been pixels.
  function scaleObj(o, sx, sy) {
    const size = Math.max(1, Math.round(o.size * Math.sqrt(sx * sy)));
    const off = o.size % 2 ? 0.5 : 0, off2 = size % 2 ? 0.5 : 0;
    const f = (p) => ({ x: Math.round((p.x + off) * sx - off2), y: Math.round((p.y + off) * sy - off2) });
    return { ...o, a: f(o.a), b: f(o.b), size };
  }

  const Core = { rgbaToU32, colorDistance, floodMask, fillEdge, floodFill, line, normRect, clampRect, constrainShape, fitDims, anchorOffset, dragResize, sizeError, saveName, stepSize, tileParts, groupRects, rotateDims, Stroke, History,
    objBox, drawnObj, hitsObject, hitObject, objHandles, handleAt, resizeObj, moveObj, transformObj, scaleObj };
  if (typeof module !== 'undefined' && module.exports) module.exports = Core;
  else root.Core = Core;
})(typeof window !== 'undefined' ? window : globalThis);
