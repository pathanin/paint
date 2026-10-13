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

  // 4-connected scanline fill. tolerance is 0..100 (% of 255).
  // Mutates u32; returns changed bbox {x,y,w,h} or null.
  function floodFill(u32, w, h, x, y, color, tolerance) {
    if (x < 0 || y < 0 || x >= w || y >= h) return null;
    const target = u32[y * w + x];
    const thr = Math.round((tolerance || 0) * 255 / 100);
    if (thr === 0 && target === color) return null;
    const match = thr === 0
      ? (i) => u32[i] === target
      : (i) => colorDistance(u32[i], target) <= thr;
    const seen = new Uint8Array(w * h);
    const stack = [x, y];
    let minX = x, maxX = x, minY = y, maxY = y, changed = false;
    while (stack.length) {
      const sy = stack.pop(), sx = stack.pop();
      const row = sy * w;
      if (seen[row + sx] || !match(row + sx)) continue;
      let l = sx, r = sx;
      while (l > 0 && !seen[row + l - 1] && match(row + l - 1)) l--;
      while (r < w - 1 && !seen[row + r + 1] && match(row + r + 1)) r++;
      for (let i = l; i <= r; i++) {
        if (u32[row + i] !== color) changed = true;
        u32[row + i] = color;
        seen[row + i] = 1;
      }
      if (l < minX) minX = l;
      if (r > maxX) maxX = r;
      if (sy < minY) minY = sy;
      if (sy > maxY) maxY = sy;
      for (const ny of [sy - 1, sy + 1]) {
        if (ny < 0 || ny >= h) continue;
        const nrow = ny * w;
        let inRun = false;
        for (let i = l; i <= r; i++) {
          const ok = !seen[nrow + i] && match(nrow + i);
          if (ok && !inRun) stack.push(i, ny);
          inRun = ok;
        }
      }
    }
    return changed ? { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } : null;
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

  function rotateDims(w, h, deg) {
    return Math.abs(deg) % 180 === 90 ? { w: h, h: w } : { w, h };
  }

  // Undo/redo stacks bounded by entry count and total bytes (both stacks). Newest entry always survives.
  // The save point is the entry on top of the undo stack when the document was last saved
  // (null = the base state). It becomes LOST once that state can no longer be reached.
  const LOST = {};
  class History {
    constructor({ maxBytes = 256 * 1024 * 1024, maxCount = 100 } = {}) {
      this.maxBytes = maxBytes; this.maxCount = maxCount;
      this.clear();
    }
    top() { return this.undoStack.length ? this.undoStack[this.undoStack.length - 1] : null; }
    push(entry) {
      for (const e of this.redoStack) {
        this.bytes -= e.bytes || 0;
        if (e === this.saved) this.saved = LOST;
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
    clear() { this.undoStack = []; this.redoStack = []; this.bytes = 0; this.saved = null; }
  }

  const Core = { rgbaToU32, colorDistance, floodFill, line, normRect, clampRect, constrainShape, fitDims, anchorOffset, dragResize, sizeError, saveName, stepSize, rotateDims, History };
  if (typeof module !== 'undefined' && module.exports) module.exports = Core;
  else root.Core = Core;
})(typeof window !== 'undefined' ? window : globalThis);
