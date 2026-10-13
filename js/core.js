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
  // Doesn't touch u32. Returns {mask, box}: mask[i] = 1 for every pixel in the region (w*h bytes),
  // box = its bounding box. null when (x, y) is outside the image.
  // Typed-array stack of pixel indices; no per-span allocation.
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
          const ok = !mask[j + off] && near(u32[j + off]);
          if (ok && !inRun) push(j + off);
          inRun = ok;
        }
      }
    }
    return { mask, box: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } };
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
    clear() {
      if (this.onDrop) for (const e of [...this.undoStack, ...this.redoStack]) this.onDrop(e);
      this.undoStack = []; this.redoStack = []; this.bytes = 0; this.saved = null;
    }
  }

  const Core = { rgbaToU32, colorDistance, floodMask, floodFill, line, normRect, clampRect, constrainShape, fitDims, anchorOffset, dragResize, sizeError, saveName, stepSize, tileParts, groupRects, rotateDims, History };
  if (typeof module !== 'undefined' && module.exports) module.exports = Core;
  else root.Core = Core;
})(typeof window !== 'undefined' ? window : globalThis);
