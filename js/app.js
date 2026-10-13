(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const ov = $('#overlay'), stage = $('#stage'), vp = $('#viewport'), textBox = $('#textInput');
  const ring = $('#ring'), antsEl = $('#ants');
  // The document canvas. Whole-image ops (crop, rotate, resize...) swap in a new element rather than
  // copying pixels, and undo swaps it back, so these are reassigned by adoptImage().
  let img = $('#image');
  let ctx = img.getContext('2d');
  // #overlay is only the pointer target (never drawn, so it has no backing store). Shape previews
  // and floating selections are drawn on #preview, which covers just the visible part of the image
  // (marching ants are the #ants element, at screen resolution). A document-sized overlay costs 400 MB at 100 MP, and twice that once shown.
  const pv = $('#preview');
  const octx = pv.getContext('2d');

  const S = {
    tool: 'pencil', prevTool: 'pencil',
    primary: '#000000', secondary: '#ffffff',
    sizes: { pencil: 1, brush: 6, eraser: 12, line: 2, rect: 2, ellipse: 2 },
    fillMode: 'outline', tolerance: 10, smoothing: 2,
    font: 'system-ui, sans-serif', fontSize: 24,
    zoom: 1,
    fileHandle: null, fileName: 'untitled.png',
    pristine: true, panKey: false,
  };
  // Dropped doc entries hold whole canvases: free them now (width 0) rather than at some later GC.
  const hist = new Core.History({ maxBytes: 256 * 1024 * 1024, maxCount: 100, onDrop: (e) => {
    if (e.type === 'doc') e.canvas.width = 0;
    else if (e.type === 'region') e.parts.forEach(release);
  } });
  const SHAPES = new Set(['line', 'rect', 'ellipse']);
  const TOOL_KEYS = {
    KeyS: 'select', KeyP: 'pencil', KeyB: 'brush', KeyE: 'eraser', KeyF: 'fill',
    KeyI: 'picker', KeyT: 'text', KeyL: 'line', KeyR: 'rect', KeyO: 'ellipse',
  };
  const PALETTE = [
    ['#000000', 'Black'], ['#7f7f7f', 'Gray'], ['#880015', 'Dark red'], ['#ed1c24', 'Red'], ['#ff7f27', 'Orange'],
    ['#fff200', 'Yellow'], ['#22b14c', 'Green'], ['#00a2e8', 'Turquoise'], ['#3f48cc', 'Indigo'], ['#a349a4', 'Purple'],
    ['#ffffff', 'White'], ['#c3c3c3', 'Light gray'], ['#b97a57', 'Brown'], ['#ffaec9', 'Rose'], ['#ffc90e', 'Gold'],
    ['#efe4b0', 'Light yellow'], ['#b5e61d', 'Lime'], ['#99d9ea', 'Light turquoise'], ['#7092be', 'Blue-gray'], ['#c8bfe7', 'Lavender'],
  ];
  const MAX_DIM = 16384;
  const MAX_PIXELS = 100e6; // ~400 MB per canvas; history keeps several
  const megapixels = (w, h) => +(w * h / 1e6).toFixed(1);
  // User-facing reason a w x h document can't exist, or null.
  function sizeProblem(w, h) {
    const e = Core.sizeError(w, h, MAX_DIM, MAX_PIXELS);
    if (!e) return null;
    return e.reason === 'range' ? `sides must be between 1 and ${MAX_DIM} px`
      : `${w} × ${h} px (${megapixels(w, h)} MP) is over the ${MAX_PIXELS / 1e6} MP limit`;
  }

  let drag = null;   // in-progress pointer interaction
  let sel = null;    // {x, y, w, h, float: canvas|null}
  let op = null;     // the current undoable region op: {tiles} (see touch())
  let textAt = null; // {x, y, color} while the text box is open

  // ---------- helpers ----------
  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }
  function cloneCanvas(src) {
    const c = makeCanvas(src.width, src.height);
    c.getContext('2d').drawImage(src, 0, 0);
    return c;
  }
  function hexToU32(hex) {
    const n = parseInt(hex.slice(1), 16);
    return Core.rgbaToU32((n >> 16) & 255, (n >> 8) & 255, n & 255, 255);
  }
  // Write-if-changed DOM setters for paths that run on every pointermove or frame. Rewriting an
  // identical value isn't free: textContent replaces the text node (layout), and attribute or
  // `disabled` writes queue mutation records (the topbar's MutationObserver then forces a layout).
  function setText(el, v) { if (el.textContent !== v) el.textContent = v; }
  function setAttr(el, k, v) {
    if (v == null) { if (el.hasAttribute(k)) el.removeAttribute(k); return; }
    v = String(v);
    if (el.getAttribute(k) !== v) el.setAttribute(k, v);
  }
  function setProp(el, k, v) { if (el[k] !== v) el[k] = v; }
  function setData(el, k, v) { if (el.dataset[k] !== v) el.dataset[k] = v; }
  const toHex = (r, g, b) => '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  let msgTimer = 0;
  const toastX = document.createElement('button');
  toastX.className = 'toast-x';
  toastX.tabIndex = -1; // the toast is aria-hidden (live regions announce it); this is a pointer convenience
  toastX.innerHTML = '<svg><use href="#i-x"/></svg>';
  toastX.addEventListener('click', () => { clearTimeout(msgTimer); $('#toast').classList.remove('show'); });
  // Errors stay while the pointer is over them, so they can be read to the end.
  $('#toast').addEventListener('pointerenter', () => { if ($('#toast').classList.contains('error')) clearTimeout(msgTimer); });
  $('#toast').addEventListener('pointerleave', () => {
    if (!$('#toast').classList.contains('error') || !$('#toast').classList.contains('show')) return;
    clearTimeout(msgTimer);
    msgTimer = setTimeout(() => $('#toast').classList.remove('show'), 2500);
  });
  // Plain words for the errors people actually hit; anything else keeps the browser's own message.
  const errText = (err, denied) => (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError') ? denied
    : err && err.name === 'InvalidStateError' ? 'the file is busy or was changed elsewhere'
    : (err && err.message) || 'unknown error');
  function flash(msg, isError) {
    const t = $('#toast');
    t.textContent = msg;
    if (isError) t.appendChild(toastX);
    // Screen readers: errors are assertive; clear first so a repeated message is announced again.
    const live = $(isError ? '#srAlert' : '#srStatus');
    live.textContent = '';
    setTimeout(() => { live.textContent = msg; }, 50);
    t.classList.toggle('error', !!isError);
    t.classList.add('show');
    clearTimeout(msgTimer);
    msgTimer = setTimeout(() => t.classList.remove('show'), isError ? 5000 : 2200);
  }

  // Shortcut labels are written Mac-style in the markup; show Ctrl/Shift elsewhere.
  const MAC = /Mac|iPhone|iPad/.test(navigator.platform);
  const keyLabel = (k) => (MAC ? k.replace(/Alt\+/g, '⌥')
    : k === '⌘' ? 'Ctrl' : k === '⇧' ? 'Shift' : k === '⌫' ? 'Backspace'
    : k.replace(/⌘/g, 'Ctrl+').replace(/⇧([- ])/g, 'Shift$1').replace(/⇧/g, 'Shift+').replace(/\+\+$/, '+Plus').replace(/\+−$/, '+Minus'));

  // ---------- document & history ----------
  // Make canvas c the document, without copying it: it replaces #image in the page.
  function adoptImage(c) {
    if (c === img) return;
    c.id = 'image';
    c.setAttribute('role', 'img');
    img.replaceWith(c);
    img.removeAttribute('id');
    img = c;
    ctx = c.getContext('2d');
  }
  // source: a canvas to adopt as the document, a bitmap to draw into it, or null for white.
  function setDoc(source, w, h) {
    if (source instanceof HTMLCanvasElement) adoptImage(source);
    else {
      img.width = w; img.height = h; // also clears it
      if (source) ctx.drawImage(source, 0, 0);
      else { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h); }
    }
    dropOp();
    sel = null; drag = null;
    layout();
    requestRender();
  }

  // Undo is copy-on-write. Every edit calls touch(rect) *before* drawing into rect; the first touch
  // of each TILE x TILE tile saves its pixels. endOp() keeps only the touched part of each tile.
  // So no op copies the whole image, and a long diagonal stroke stores a thin band of tiles, not
  // its whole bounding box. Tiles are saved on the GPU (drawImage, no readback):
  //  - strokes (beginOp(true)): each tile into a small canvas of its own, as the stroke reaches it
  //    (past 512 live tile canvases, 128 MB, they are read back mid-stroke to bound GPU memory);
  //  - everything else: the tiles of each touch() packed into one atlas canvas.
  // The stored pixels stay on the GPU until an idle callback reads them back (toData(), batched
  // through one atlas per 256 parts); undo/redo before that draws them straight back.
  // Two Chrome gotchas shape this (measured on a 10000 px canvas):
  //  - No readback (getImageData) of the document, or of anything drawn from it, while a stroke is in
  //    progress: each one costs ~10 ms per frame, as the next frame then copies the whole canvas.
  //  - No reusing snapshot canvases after they were read back: Chrome may move a canvas that was
  //    read to the CPU, and then drawing the document into it is a readback too. So snapshot
  //    canvases are fresh, and freed (width 0) once nothing refers to them.
  // A tile or part {w, h} holds its pixels either as data (ImageData, w x h) or as cv/cx/cy: the
  // block at (cx, cy) in canvas cv, which counts its users in cv.refs.
  const TILE = 256;
  function beginOp(stroke) {
    dropOp();
    op = { tiles: new Map(), stroke: !!stroke, live: 0 };
  }
  function release(t) {
    if (t.cv && --t.cv.refs === 0) t.cv.width = 0;
    t.cv = null;
  }
  // Snapshot the document's pixels under each item {x, y, w, h} without a readback; sets each item's
  // cv/cx/cy. Chrome makes each drawImage to or from a large canvas costly (1600 tile draws ~130 ms
  // at 100 MP, one whole-image draw ~15 ms), so items that tile a rectangle share one canvas.
  function snapshot(items) {
    for (const g of Core.groupRects(items, 1)) {
      const cv = makeCanvas(g.w, g.h);
      cv.getContext('2d').drawImage(img, g.x, g.y, g.w, g.h, 0, 0, g.w, g.h); // onto transparent: exact, alpha too
      cv.refs = g.items.length;
      for (const i of g.items) { const t = items[i]; t.cv = cv; t.cx = t.x - g.x; t.cy = t.y - g.y; }
    }
  }
  // Group items by the canvas holding them: [[cv, items]].
  function byCanvas(items) {
    const m = new Map();
    for (const t of items) { if (!m.has(t.cv)) m.set(t.cv, []); m.get(t.cv).push(t); }
    return [...m];
  }
  // Write the GPU-held block of each item (or the part (sx, sy, w, h) of it given by rect(t)) back to
  // the document: one draw per canvas when its items tile a rectangle at matching offsets.
  function drawBack(items, rect) {
    for (const [cv, ts] of byCanvas(items)) {
      const rs = ts.map((t) => rect(t));
      const x0 = Math.min(...rs.map((r) => r.x)), y0 = Math.min(...rs.map((r) => r.y));
      const x1 = Math.max(...rs.map((r) => r.x + r.w)), y1 = Math.max(...rs.map((r) => r.y + r.h));
      const area = rs.reduce((n, r) => n + r.w * r.h, 0), dx = rs[0].sx - rs[0].x, dy = rs[0].sy - rs[0].y;
      const one = area === (x1 - x0) * (y1 - y0) && rs.every((r) => r.sx - r.x === dx && r.sy - r.y === dy);
      for (const r of one ? [{ x: x0, y: y0, w: x1 - x0, h: y1 - y0, sx: x0 + dx, sy: y0 + dy }] : rs) {
        ctx.clearRect(r.x, r.y, r.w, r.h);
        ctx.drawImage(cv, r.sx, r.sy, r.w, r.h, r.x, r.y, r.w, r.h);
      }
    }
  }
  function touch(x, y, w, h) {
    if (!op) return;
    const fresh = [];
    for (const p of Core.tileParts({ x, y, w, h }, img.width, img.height, TILE)) {
      const t = op.tiles.get(p.key);
      if (t) {
        t.x0 = Math.min(t.x0, p.x); t.y0 = Math.min(t.y0, p.y);
        t.x1 = Math.max(t.x1, p.x + p.w); t.y1 = Math.max(t.y1, p.y + p.h);
        continue;
      }
      const ox = p.tx * TILE, oy = p.ty * TILE;
      const t2 = { cv: null, cx: 0, cy: 0, data: null, x: ox, y: oy, w: Math.min(TILE, img.width - ox), h: Math.min(TILE, img.height - oy), x0: p.x, y0: p.y, x1: p.x + p.w, y1: p.y + p.h };
      op.tiles.set(p.key, t2);
      fresh.push(t2);
    }
    if (!fresh.length) return;
    if (!op.stroke) { snapshot(fresh); return; }
    for (const t of fresh) {
      if (op.live >= 512) { toData([...op.tiles.values()].filter((x) => x.cv)); op.live = 0; }
      op.live++;
      snapshot([t]);
    }
  }
  function endOp() {
    const o = op; op = null;
    if (!o || !o.tiles.size) return;
    const parts = [];
    let bytes = 0;
    for (const t of o.tiles.values()) {
      const w = t.x1 - t.x0, h = t.y1 - t.y0, dx = t.x0 - t.x, dy = t.y0 - t.y;
      const part = { x: t.x0, y: t.y0, w, h, cv: t.cv, cx: t.cx + dx, cy: t.cy + dy, data: t.data };
      if (t.data && (w !== t.w || h !== t.h)) { part.data = new ImageData(w, h); blit(t.data, dx, dy, part.data, 0, 0, w, h); }
      parts.push(part);
      bytes += w * h * 4; // a part on the GPU may sit in a larger tile until toData() crops it
    }
    pushHist({ type: 'region', parts, bytes });
    queueToData(parts);
  }
  // Items on the GPU -> data (w x h ImageData each). Each readback has a large fixed cost, so a
  // canvas holding many items is read once over their bounding box, and canvases holding one item
  // each (stroke tiles) are first drawn into atlases of up to 16 x 16 tiles, each read once.
  function toData(items) {
    const singles = [];
    for (const [cv, ts] of byCanvas(items)) {
      if (cv.refs === 1) { singles.push(...ts); continue; }
      const x0 = Math.min(...ts.map((t) => t.cx)), y0 = Math.min(...ts.map((t) => t.cy));
      const all = cv.getContext('2d').getImageData(x0, y0, Math.max(...ts.map((t) => t.cx + t.w)) - x0, Math.max(...ts.map((t) => t.cy + t.h)) - y0);
      for (const t of ts) {
        t.data = new ImageData(t.w, t.h);
        blit(all, t.cx - x0, t.cy - y0, t.data, 0, 0, t.w, t.h);
        release(t);
      }
    }
    for (let i = 0; i < singles.length; i += 256) {
      const batch = singles.slice(i, i + 256);
      const cols = Math.ceil(Math.sqrt(batch.length)), rows = Math.ceil(batch.length / cols);
      const atlas = makeCanvas(cols * TILE, rows * TILE), g = atlas.getContext('2d');
      batch.forEach((t, j) => { g.drawImage(t.cv, t.cx, t.cy, t.w, t.h, (j % cols) * TILE, Math.floor(j / cols) * TILE, t.w, t.h); release(t); });
      const all = g.getImageData(0, 0, atlas.width, atlas.height);
      atlas.width = 0;
      batch.forEach((t, j) => {
        t.data = new ImageData(t.w, t.h);
        blit(all, (j % cols) * TILE, Math.floor(j / cols) * TILE, t.data, 0, 0, t.w, t.h);
      });
    }
  }
  // Read history parts back to the CPU when the app is idle, up to 256 parts (~64 MB) per callback,
  // never while a gesture or op is in progress (see the gotchas above). It starts a second after the
  // last history change, so a run of undo/redo doesn't pay a readback per step.
  const pendingParts = new Set();
  let toDataGen = 0;
  const onIdle = window.requestIdleCallback || ((f) => setTimeout(f, 0));
  function queueToData(parts) {
    for (const p of parts) if (p.cv) pendingParts.add(p);
    if (!pendingParts.size) return;
    const gen = ++toDataGen;
    setTimeout(() => onIdle(() => idleToData(gen)), 1000);
  }
  function idleToData(gen) {
    if (gen !== toDataGen) return;
    if (drag || op) { queueToData([]); return; }
    const batch = [];
    for (const p of pendingParts) {
      pendingParts.delete(p);
      if (p.cv) batch.push(p);
      if (batch.length === 256) break;
    }
    toData(batch);
    if (pendingParts.size) onIdle(() => idleToData(gen));
  }
  function flushToData() { const all = [...pendingParts].filter((p) => p.cv); pendingParts.clear(); toData(all); }
  // Abandon the current op. With restore, first put back every pixel it changed.
  function dropOp(restore) {
    const o = op; op = null;
    if (!o) return;
    const tiles = [...o.tiles.values()];
    if (restore) {
      drawBack(tiles.filter((t) => t.cv), (t) => ({ x: t.x0, y: t.y0, w: t.x1 - t.x0, h: t.y1 - t.y0, sx: t.cx + t.x0 - t.x, sy: t.cy + t.y0 - t.y }));
      for (const t of tiles) if (t.data) ctx.putImageData(t.data, t.x, t.y, t.x0 - t.x, t.y0 - t.y, t.x1 - t.x0, t.y1 - t.y0);
    }
    tiles.forEach(release);
  }
  // Copy a w x h block between ImageData buffers (u32 rows).
  function blit(src, sx, sy, dst, dx, dy, w, h) {
    const s32 = new Uint32Array(src.data.buffer), d32 = new Uint32Array(dst.data.buffer);
    for (let r = 0; r < h; r++) d32.set(s32.subarray((sy + r) * src.width + sx, (sy + r) * src.width + sx + w), (dy + r) * dst.width + dx);
  }
  // Swap a region entry's pixels with the canvas, with no readback: snapshot what's there now into
  // fresh atlases (GPU), then write the stored pixels, then read the snapshot back at idle.
  // One copy of the pixels at a time, so the entry's bytes don't change.
  function swapParts(parts) {
    const old = parts.map((p) => ({ x: p.x, y: p.y, w: p.w, h: p.h, cv: p.cv, cx: p.cx, cy: p.cy, data: p.data }));
    snapshot(parts);
    drawBack(old.filter((o) => o.cv), (o) => ({ x: o.x, y: o.y, w: o.w, h: o.h, sx: o.cx, sy: o.cy }));
    for (const o of old) { if (o.data) ctx.putImageData(o.data, o.x, o.y); release(o); }
    for (const p of parts) p.data = null;
    queueToData(parts);
  }
  // Replace the whole document (crop/resize/rotate/...) as one undo step. The entry keeps the old
  // canvas element itself; undo and redo swap it with the live one. No pixels are copied.
  function docOp(next) {
    commitText();
    commitSelection();
    const before = img;
    setDoc(next);
    pushDocHist(before);
  }
  const pushDocHist = (before) => pushHist({ type: 'doc', canvas: before, bytes: before.width * before.height * 4 });
  function pushHist(e) {
    if (hist.push(e) && !S.trimWarned) {
      S.trimWarned = true;
      flash('Oldest undo steps were dropped to save memory');
    }
    S.pristine = false;
    updateChrome();
  }
  // Each entry holds the pixels of the *other* state (before when on the undo stack, after when on
  // the redo stack); applying it swaps them with what's on the canvas, so one copy serves both ways.
  function applyHist(e) {
    if (e.type === 'region') swapParts(e.parts);
    else if (e.type === 'fill') applyFill(e);
    else {
      const other = e.canvas;
      e.canvas = img;
      setDoc(other);
    }
    updateChrome();
    requestRender();
  }
  function undo() {
    if (drag) return;
    commitText();
    commitSelection();
    if (sel) { sel = null; requestRender(); } // the marquee would outline pixels that just changed
    const e = hist.undo();
    if (e) applyHist(e);
  }
  function redo() {
    if (drag) return;
    commitText();
    commitSelection();
    if (sel) { sel = null; requestRender(); }
    const e = hist.redo();
    if (e) applyHist(e);
  }

  function newDoc(w, h) {
    commitText();
    setDoc(null, w, h);
    hist.clear();
    Object.assign(S, { fileHandle: null, fileName: 'untitled.png', pristine: true, trimWarned: false });
    fitZoom(true);
    updateChrome();
  }

  // ---------- view ----------
  function layout() {
    stage.style.width = img.width * S.zoom + 'px';
    stage.style.height = img.height * S.zoom + 'px';
    stage.classList.toggle('pixelated', S.zoom * devicePixelRatio >= 1); // hard pixels, incl. 100% on Retina
    stage.classList.toggle('tiny', img.width * S.zoom < 48 || img.height * S.zoom < 48); // corner handle only
    if (textAt) placeTextBox();
    updateStatus();
    requestRender(); // the preview follows the view
  }
  function setZoom(z, cx, cy) {
    z = clamp(z, 0.05, 32);
    const r = img.getBoundingClientRect();
    if (cx == null) {
      const v = vp.getBoundingClientRect();
      cx = v.left + v.width / 2; cy = v.top + v.height / 2;
    }
    const ix = (cx - r.left) / S.zoom, iy = (cy - r.top) / S.zoom;
    S.zoom = z;
    layout();
    const r2 = img.getBoundingClientRect();
    vp.scrollLeft += r2.left + ix * z - cx;
    vp.scrollTop += r2.top + iy * z - cy;
  }
  // Buttons and keys step through familiar percentages (wheel/pinch stay continuous).
  const ZOOMS = [0.05, 0.1, 0.25, 0.33, 0.5, 0.67, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32];
  function zoomStep(dir) {
    const z = dir > 0 ? ZOOMS.find((v) => v > S.zoom * 1.001) : [...ZOOMS].reverse().find((v) => v < S.zoom / 1.001);
    if (z) setZoom(z);
  }
  function fitZoom(capAt1) {
    const pad = 2 * parseFloat(getComputedStyle(vp).paddingLeft);
    const z = Math.min((vp.clientWidth - pad) / img.width, (vp.clientHeight - pad) / img.height);
    // On open: never upscale, except icon-sized images, which get a whole-number zoom (crisp pixels).
    const small = img.width <= 64 && img.height <= 64;
    S.zoom = clamp(!capAt1 ? z : small ? clamp(Math.floor(z), 1, 8) : Math.min(1, z), 0.05, 32);
    layout();
  }
  function imgPt(e, r) {
    r = r || img.getBoundingClientRect();
    return { x: (e.clientX - r.left) * img.width / r.width, y: (e.clientY - r.top) * img.height / r.height };
  }

  let rafPending = false;
  // The preview is redrawn only when what it shows changes (ovKey), and only the area drawn last
  // time is cleared (ovBox): a static selection costs no canvas work. Moving or resizing the preview
  // wipes it, so placePreview() resets both.
  let ovKey = '', ovBox = null;
  // pvAt: the image-px rect #preview covers, and k = its backing px per image px. k is 1 when the
  // view is zoomed in (image px, CSS-scaled like #image), and screen resolution when zoomed out.
  let pvAt = null;
  function placePreview() {
    const z = S.zoom, k = Math.min(1, z * devicePixelRatio);
    const v = vp.getBoundingClientRect(), r = stage.getBoundingClientRect();
    const L = v.left + vp.clientLeft - r.left, T = v.top + vp.clientTop - r.top;
    const vis = { // visible image px
      x0: clamp(Math.floor(L / z), 0, img.width), y0: clamp(Math.floor(T / z), 0, img.height),
      x1: clamp(Math.ceil((L + vp.clientWidth) / z), 0, img.width), y1: clamp(Math.ceil((T + vp.clientHeight) / z), 0, img.height),
    };
    const a = pvAt;
    if (a && a.z === z && a.k === k && a.W === img.width && a.H === img.height &&
        vis.x0 >= a.x && vis.y0 >= a.y && vis.x1 <= a.x + a.w && vis.y1 <= a.y + a.h) return;
    // A quarter view of margin on each side, so short scrolls don't need a move (a reallocation and
    // redraw), while the backing stays near screen size.
    const mx = Math.ceil((vis.x1 - vis.x0) / 4) + 1, my = Math.ceil((vis.y1 - vis.y0) / 4) + 1;
    const x = Math.max(0, vis.x0 - mx), y = Math.max(0, vis.y0 - my);
    const w = Math.max(1, Math.min(img.width, vis.x1 + mx) - x), h = Math.max(1, Math.min(img.height, vis.y1 + my) - y);
    pvAt = { x, y, w, h, z, k, W: img.width, H: img.height };
    pv.width = Math.ceil(w * k); pv.height = Math.ceil(h * k); // also clears it
    Object.assign(pv.style, { left: x * z + 'px', top: y * z + 'px', width: w * z + 'px', height: h * z + 'px' });
    octx.setTransform(pv.width / w, 0, 0, pv.height / h, -x * pv.width / w, -y * pv.height / h);
    ovKey = ''; ovBox = null;
  }
  pv.addEventListener('contextrestored', () => { pvAt = null; ovKey = ''; ovBox = null; requestRender(); });
  vp.addEventListener('scroll', () => requestRender(), { passive: true });
  // The view can also grow (window resize, fullscreen) or change DPR (browser zoom, another monitor)
  // with no scroll or pointer event: re-place the preview, and redo the pixelated/smooth choice.
  new ResizeObserver(() => requestRender()).observe(vp);
  (function watchDpr() {
    matchMedia(`(resolution: ${devicePixelRatio}dppx)`).addEventListener('change', () => { layout(); watchDpr(); }, { once: true });
  })();
  const floatIds = new WeakMap(); // canvas -> id, so a new float with the same geometry still redraws
  let nFloats = 0;
  const floatId = (c) => { if (!floatIds.has(c)) floatIds.set(c, ++nFloats); return floatIds.get(c); };
  function requestRender() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(render);
  }
  // DOM writes for pointer feedback happen here, once per frame, never in the pointermove handler:
  // a write there dirties layout, and Chrome's hit test for the follow-up mouse events then forces it.
  function render() {
    rafPending = false;
    updateRing(hoverPt);
    if (!drag) setProp(ov.style, 'cursor', S.tool === 'select' && sel && hoverPt && inside(hoverPt, sel) ? 'move' : '');
    if (drag && drag.t === 'canvas') showGhost(drag);
    const shape = drag && SHAPES.has(drag.t);
    const marquee = drag && drag.t === 'select';
    const mq = marquee ? Core.normRect(drag.start, drag.end) : null;
    // Live end of a brush stroke: what release would add, so the ink always reaches the pointer.
    const tail = drag && drag.t === 'brush' ? drag.stroke.tail(drag.ptr) : null;
    const key = JSON.stringify([
      S.zoom,
      tail ? [tail, drag.color, drag.size] : 0,
      shape ? [drag.t, drag.start, drag.end, drag.shift, drag.color, drag.alt, S.sizes[drag.t], S.fillMode] : 0,
      mq || 0,
      sel && sel.float ? [sel.x, sel.y, sel.w, sel.h, floatId(sel.float)] : 0,
    ]);
    placeAnts(mq || sel);
    if (shape || (sel && sel.float) || (tail && tail.length)) placePreview();
    if (key !== ovKey) {
      ovKey = key;
      if (ovBox) octx.clearRect(ovBox.x, ovBox.y, ovBox.w, ovBox.h);
      let box = null;
      const add = (r) => {
        const pad = 2 / S.zoom + 2; // stroke half-widths and antialiasing
        const b = { x: Math.floor(r.x - pad), y: Math.floor(r.y - pad), w: Math.ceil(r.w + 2 * pad) + 1, h: Math.ceil(r.h + 2 * pad) + 1 };
        if (!box) { box = b; return; }
        const x1 = Math.max(box.x + box.w, b.x + b.w), y1 = Math.max(box.y + box.h, b.y + b.h);
        box.x = Math.min(box.x, b.x); box.y = Math.min(box.y, b.y); box.w = x1 - box.x; box.h = y1 - box.y;
      };
      if (tail && tail.length) { brushPath(octx, tail, drag.color, drag.size); add(segsBox(tail, drag.size / 2 + 1)); }
      if (shape) add(drawShape(octx, drag));
      if (sel && sel.float) { octx.drawImage(sel.float, sel.x, sel.y); add(sel); }
      ovBox = box;
    }
    updateStatus();
  }
  // Marching ants around image rect r (or none), snapped to device px so they stay crisp.
  let antsKey = '';
  function placeAnts(r) {
    const z = S.zoom, d = devicePixelRatio, px = (v) => Math.round(v * z * d) / d;
    const key = r ? [px(r.x), px(r.y), px(r.x + r.w) - px(r.x), px(r.y + r.h) - px(r.y)].join() : '';
    if (key === antsKey) return;
    antsKey = key;
    antsEl.hidden = !r;
    if (!r) return;
    const [x, y, w, h] = key.split(',');
    Object.assign(antsEl.style, { left: x + 'px', top: y + 'px', width: Math.max(1, w) + 'px', height: Math.max(1, h) + 'px' });
  }

  let cursor = null;  // integer image px under the pointer, for the status bar
  let hoverPt = null; // the same point unrounded (null when the pointer is off the canvas); render() places the ring there
  const EL = {
    stPos: $('#stPos'), stSelWrap: $('#stSelWrap'), stSel: $('#stSel'), stSize: $('#stSize'),
    zoomBtn: $('#zoomBtn'), zoomIn: $('[data-cmd="zoomIn"]'), zoomOut: $('[data-cmd="zoomOut"]'), crop: $('#cropBtn'),
    docTitle: $('#docTitle'), docDirty: $('#docDirty'), save: $('[data-cmd="save"]'), undo: $('#undoBtn'), redo: $('#redoBtn'), stIntro: $('#stIntro'),
  };
  // Runs every frame and pointermove; everything is write-if-changed, so a still image costs ~nothing.
  function updateStatus() {
    setText(EL.stPos, cursor ? `${cursor.x}, ${cursor.y} px` : '—');
    const r = drag && drag.t === 'select' ? Core.normRect(drag.start, drag.end) : sel;
    setProp(EL.stSelWrap, 'hidden', !r);
    setText(EL.stSel, r ? `${r.w} × ${r.h} px` : '');
    setAttr(img, 'aria-label', `Image, ${img.width} × ${img.height} px`);
    setText(EL.stSize, drag && drag.t === 'canvas'
      ? `${img.width} × ${img.height} → ${drag.w} × ${drag.h} px · Esc to cancel`
      : `${img.width} × ${img.height} px`);
    const pct = Math.round(S.zoom * 100) + '%';
    setText(EL.zoomBtn, pct);
    setProp(EL.zoomIn, 'disabled', S.zoom >= ZOOMS[ZOOMS.length - 1] - 1e-9);
    setProp(EL.zoomOut, 'disabled', S.zoom <= ZOOMS[0] + 1e-9);
    setAttr(EL.zoomBtn, 'aria-label', `Zoom ${pct}. Activate for actual size`);
    // aria-disabled (not disabled) keeps Crop focusable, so keyboard users can reach the explanation.
    setAttr(EL.crop, 'aria-disabled', !sel);
    setData(EL.crop, 'hint', sel ? '' : 'Select an area first');
    setAttr(EL.crop, 'aria-description', sel ? null : 'Select an area first');
  }
  function updateChrome() {
    const dirty = isDirty();
    setProp(document, 'title', (dirty ? '● ' : '') + S.fileName + ' — Paint');
    setText(EL.docTitle, S.fileName);
    setProp(EL.docDirty, 'hidden', !dirty);
    document.body.classList.toggle('dirty', dirty);
    setAttr(EL.save, 'aria-label', dirty ? 'Save (unsaved changes)' : 'Save');
    setData(EL.save, 'hint', dirty ? 'Unsaved changes' : '');
    setProp(EL.undo, 'disabled', !hist.canUndo() && !(sel && sel.float)); // undo drops a floating paste/move
    setProp(EL.stIntro, 'hidden', !S.pristine || !!textAt);
    setProp(EL.redo, 'disabled', !hist.canRedo());
  }

  // ---------- tools ----------
  function setTool(t) {
    commitText();
    if (t !== 'select') dropSelection();
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
    if (S.sizes[t] != null) { $('#size').value = S.sizes[t]; $('#sizeOut').textContent = S.sizes[t]; $('#size').setAttribute('aria-valuetext', S.sizes[t] + ' px'); }
  }
  function setSize(v) {
    if (S.sizes[S.tool] == null) return;
    S.sizes[S.tool] = clamp(v, 1, 100);
    $('#size').value = S.sizes[S.tool];
    $('#sizeOut').textContent = S.sizes[S.tool];
    $('#size').setAttribute('aria-valuetext', S.sizes[S.tool] + ' px');
  }
  function setColor(which, hex) {
    S[which] = hex;
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
    ctx.fillStyle = color;
    ctx.beginPath();
    for (const [x, y] of Core.line(a.x, a.y, b.x, b.y)) ctx.rect(x - off, y - off, size, size);
    ctx.fill();
  }
  // Brush: Core.Stroke segments ({a, c, b}, c = quadratic control or null) as one path, so joins blend once.
  // The same call draws committed segments on the image and the live tail on the preview.
  function brushPath(c, segs, color, size) {
    if (!segs.length) return;
    if (c === ctx) for (const g of segs) { const b = segsBox([g], size / 2 + 1); touch(b.x, b.y, b.w, b.h); } // before drawing
    c.save();
    c.strokeStyle = color;
    c.lineWidth = size;
    c.lineCap = c.lineJoin = 'round';
    c.beginPath();
    c.moveTo(segs[0].a.x, segs[0].a.y);
    for (const { c: q, b } of segs) { if (q) c.quadraticCurveTo(q.x, q.y, b.x, b.y); else c.lineTo(b.x, b.y); }
    c.stroke();
    c.restore();
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
  function brushDot(p, color, size) {
    touch(p.x - size / 2 - 1, p.y - size / 2 - 1, size + 2, size + 2);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, size / 2, 0, Math.PI * 2);
    ctx.fill();
  }

  function doFill(p, color) {
    const W = img.width, H = img.height;
    if (p.x < 0 || p.y < 0 || p.x >= W || p.y >= H) return;
    const c = hexToU32(color);
    // Exact-match fill on a pixel that already has the colour changes nothing: skip the full readback.
    if (Math.round(S.tolerance * 255 / 100) === 0 && new Uint32Array(ctx.getImageData(p.x, p.y, 1, 1).data.buffer)[0] === c) return;
    const data = ctx.getImageData(0, 0, W, H);
    const u32 = new Uint32Array(data.data.buffer);
    const { mask, box } = Core.floodMask(u32, W, H, p.x, p.y, S.tolerance);
    // The undo entry: the box's pixels before, plus the region as a bit mask. "After" is those
    // pixels with the masked ones set to c, so neither undo nor redo has to read the canvas back.
    const before = new ImageData(box.w, box.h);
    blit(data, box.x, box.y, before, 0, 0, box.w, box.h);
    const bits = new Uint8Array(Math.ceil(box.w * box.h / 8));
    let changed = false;
    for (let y = 0, k = 0; y < box.h; y++) {
      for (let i = (box.y + y) * W + box.x, e = i + box.w; i < e; i++, k++) {
        if (!mask[i]) continue;
        bits[k >> 3] |= 1 << (k & 7);
        if (u32[i] !== c) { u32[i] = c; changed = true; }
      }
    }
    if (!changed) return;
    ctx.putImageData(data, 0, 0, box.x, box.y, box.w, box.h);
    pushHist({ type: 'fill', x: box.x, y: box.y, before, bits, color: c, undone: false, bytes: before.data.length + bits.length });
  }
  // Undo/redo of a fill entry: put back the pixels before, or recompute the filled ones.
  function applyFill(e) {
    let im = e.before;
    if (e.undone) {
      im = new ImageData(new Uint8ClampedArray(e.before.data), e.before.width, e.before.height);
      const u32 = new Uint32Array(im.data.buffer);
      for (let k = 0; k < u32.length; k++) if (e.bits[k >> 3] & (1 << (k & 7))) u32[k] = e.color;
    }
    ctx.putImageData(im, e.x, e.y);
    e.undone = !e.undone;
  }

  function pick(p, right) {
    if (p.x < 0 || p.y < 0 || p.x >= img.width || p.y >= img.height) return;
    const d = ctx.getImageData(p.x, p.y, 1, 1).data;
    if (d[3] === 0) { flash('That pixel is transparent. No color picked.'); return; }
    setColor(right ? 'secondary' : 'primary', toHex(d[0], d[1], d[2]));
    setTool(S.prevTool);
  }

  function drawShape(c, d) {
    const a = d.start, b = Core.constrainShape(d.start, d.end, d.shift, d.t);
    const lw = S.sizes[d.t], off = lw % 2 ? 0.5 : 0;
    c.save();
    c.lineWidth = lw;
    c.strokeStyle = d.color;
    c.beginPath();
    if (d.t === 'line') {
      c.lineCap = 'round';
      c.moveTo(a.x + off, a.y + off);
      c.lineTo(b.x + off, b.y + off);
      c.stroke();
    } else {
      const r = Core.normRect(a, b);
      if (d.t === 'rect') c.rect(r.x + off, r.y + off, r.w, r.h);
      else c.ellipse(r.x + r.w / 2 + off, r.y + r.h / 2 + off, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
      if (S.fillMode !== 'outline') { c.fillStyle = S.fillMode === 'fill' ? d.color : d.alt; c.fill(); }
      if (S.fillMode !== 'fill') c.stroke();
    }
    c.restore();
    return shapeBox(d);
  }
  // Everything drawShape(d) can paint.
  function shapeBox(d) {
    const r = Core.normRect(d.start, Core.constrainShape(d.start, d.end, d.shift, d.t)), lw = S.sizes[d.t];
    return { x: r.x - lw, y: r.y - lw, w: r.w + 2 * lw + 1, h: r.h + 2 * lw + 1 };
  }

  // ---------- text ----------
  function placeTextBox() {
    Object.assign(textBox.style, {
      left: textAt.x * S.zoom + 'px',
      top: textAt.y * S.zoom + 'px',
      fontSize: S.fontSize * S.zoom + 'px',
      fontFamily: S.font,
      color: textAt.color,
    });
  }
  function startText(p, color) {
    textAt = { x: p.x, y: p.y, color };
    textBox.value = '';
    textBox.hidden = false;
    placeTextBox();
    textBox.focus(); // the overlay's mousedown default is suppressed, so focus sticks immediately
    $('#stHint').hidden = false;
    $('#stIntro').hidden = true;
  }
  function commitText() {
    if (!textAt) return;
    const t = textAt; textAt = null;
    textBox.hidden = true;
    $('#stHint').hidden = true;
    $('#stIntro').hidden = !S.pristine;
    const lines = textBox.value.split('\n');
    textBox.value = '';
    if (!lines.join('').trim()) return;
    const fs = S.fontSize, lh = fs * 1.2;
    beginOp();
    ctx.save();
    ctx.font = `${fs}px ${S.font}`;
    ctx.fillStyle = t.color;
    // Match the editor's CSS line box: half-leading above the font's ascent, then the baseline.
    ctx.textBaseline = 'alphabetic';
    const m = ctx.measureText('Hg');
    const asc = m.fontBoundingBoxAscent, desc = m.fontBoundingBoxDescent;
    const w = lines.reduce((m, ln) => Math.max(m, ctx.measureText(ln).width), 0); // not Math.max(...): huge pastes overflow the stack
    touch(t.x - fs / 2, t.y - fs / 2, w + fs, lines.length * lh + fs);
    lines.forEach((ln, i) => ctx.fillText(ln, t.x, t.y + i * lh + (lh - (asc + desc)) / 2 + asc));
    ctx.restore();
    endOp();
  }
  function cancelText() {
    textAt = null;
    textBox.hidden = true;
    $('#stHint').hidden = true;
    $('#stIntro').hidden = !S.pristine;
    textBox.value = '';
  }

  // ---------- selection ----------
  const inside = (p, r) => p.x >= r.x && p.y >= r.y && p.x < r.x + r.w && p.y < r.y + r.h;
  function liftSelection() {
    beginOp();
    const f = makeCanvas(sel.w, sel.h);
    f.getContext('2d').drawImage(img, sel.x, sel.y, sel.w, sel.h, 0, 0, sel.w, sel.h);
    touch(sel.x, sel.y, sel.w, sel.h);
    ctx.fillStyle = S.secondary;
    ctx.fillRect(sel.x, sel.y, sel.w, sel.h);
    sel.float = f;
    updateChrome();
  }
  function commitSelection() {
    if (!sel || !sel.float) return;
    touch(sel.x, sel.y, sel.w, sel.h);
    ctx.drawImage(sel.float, sel.x, sel.y);
    sel.float = null;
    finishFloat();
    requestRender();
  }
  // Close the undo step of a floating selection. A paste that grew the canvas becomes one
  // whole-document step (original canvas -> grown + pasted), so a single undo reverts both.
  function finishFloat() {
    if (!sel.growFrom) { endOp(); return; }
    const before = sel.growFrom;
    sel.growFrom = null;
    dropOp();
    pushDocHist(before);
  }
  function dropSelection() {
    commitSelection();
    if (sel) { sel = null; requestRender(); }
  }
  function deleteSelection() {
    if (!sel) return;
    if (sel.float) { sel.float = null; finishFloat(); }
    else {
      beginOp();
      touch(sel.x, sel.y, sel.w, sel.h);
      ctx.fillStyle = S.secondary;
      ctx.fillRect(sel.x, sel.y, sel.w, sel.h);
      endOp();
    }
    sel = null;
    requestRender();
  }
  function selectAll() {
    commitText();
    dropSelection();
    setTool('select');
    sel = { x: 0, y: 0, w: img.width, h: img.height, float: null };
    requestRender();
  }
  function nudge(dx, dy) {
    if (!sel) return;
    if (!sel.float) liftSelection();
    sel.x += dx; sel.y += dy;
    requestRender();
  }
  function crop() {
    if (!sel) { flash('Select an area to crop first'); return; }
    commitSelection();
    const r = Core.clampRect(sel, img.width, img.height);
    if (!r) { flash('Selection is outside the image'); return; }
    const c = makeCanvas(r.w, r.h);
    c.getContext('2d').drawImage(img, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
    docOp(c);
  }

  // ---------- clipboard ----------
  function selectionCanvas() {
    if (!sel) return img; // toBlob() encodes a snapshot, so later edits can't leak in
    if (sel.float) return sel.float;
    const c = makeCanvas(sel.w, sel.h);
    c.getContext('2d').drawImage(img, sel.x, sel.y, sel.w, sel.h, 0, 0, sel.w, sel.h);
    return c;
  }
  async function copySel(cut) {
    commitText();
    const c = selectionCanvas();
    const blob = new Promise((res) => c.toBlob(res, 'image/png'));
    const didCut = cut && !!sel; // with nothing selected, ⌘X copies the whole image and keeps it
    if (didCut) deleteSelection();
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      flash(didCut ? 'Cut' : sel ? 'Copied' : 'Copied the whole image');
    } catch (err) {
      flash('Copy failed: ' + errText(err, 'the browser blocked clipboard access'), true);
    }
  }
  function pasteImage(bmp) {
    const tw = S.pristine ? bmp.width : Math.max(img.width, bmp.width);
    const th = S.pristine ? bmp.height : Math.max(img.height, bmp.height);
    const why = sizeProblem(tw, th);
    if (why) { flash(`Can't paste: ${why}`, true); return; }
    commitText();
    dropSelection();
    if (S.pristine) { docOp(cloneCanvas(bmp)); fitZoom(true); return; }
    // Grow the canvas to fit the paste (each axis only as needed). No history entry yet:
    // finishFloat() records grow + paste as a single undo step.
    let growFrom = null;
    if (bmp.width > img.width || bmp.height > img.height) {
      growFrom = img; // kept as is for the undo entry; the grown canvas replaces it
      const c = makeCanvas(Math.max(img.width, bmp.width), Math.max(img.height, bmp.height));
      const g = c.getContext('2d');
      g.fillStyle = S.secondary;
      g.fillRect(0, 0, c.width, c.height);
      g.drawImage(img, 0, 0);
      setDoc(c);
    }
    if (growFrom) flash(`Canvas enlarged to ${img.width} × ${img.height} to fit the paste`);
    // Drop it at the top-left of what's visible.
    const r = img.getBoundingClientRect(), v = vp.getBoundingClientRect();
    const x = clamp(Math.floor((v.left - r.left) / S.zoom), 0, img.width - bmp.width);
    const y = clamp(Math.floor((v.top - r.top) / S.zoom), 0, img.height - bmp.height);
    setTool('select');
    beginOp();
    sel = { x, y, w: bmp.width, h: bmp.height, float: cloneCanvas(bmp), growFrom };
    updateChrome();
    requestRender();
  }

  // ---------- transforms ----------
  function transformDoc(kind) {
    commitText();
    dropSelection();
    const w = img.width, h = img.height;
    const dims = Core.rotateDims(w, h, kind === 'rotL' ? -90 : kind === 'rotR' ? 90 : 0);
    const c = makeCanvas(dims.w, dims.h), g = c.getContext('2d');
    if (kind === 'rotR') { g.translate(dims.w, 0); g.rotate(Math.PI / 2); }
    else if (kind === 'rotL') { g.translate(0, dims.h); g.rotate(-Math.PI / 2); }
    else if (kind === 'flipH') { g.translate(w, 0); g.scale(-1, 1); }
    else if (kind === 'flipV') { g.translate(0, h); g.scale(1, -1); }
    g.drawImage(img, 0, 0);
    docOp(c);
  }
  // High-quality downscale: halve repeatedly, then one final smooth draw.
  function resample(src, w, h) {
    let cur = src;
    while (cur.width >= w * 2 || cur.height >= h * 2) {
      const nw = Math.max(w, Math.ceil(cur.width / 2)), nh = Math.max(h, Math.ceil(cur.height / 2));
      const t = makeCanvas(nw, nh), g = t.getContext('2d');
      g.imageSmoothingQuality = 'high';
      g.drawImage(cur, 0, 0, nw, nh);
      cur = t;
    }
    const out = makeCanvas(w, h), g = out.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(cur, 0, 0, w, h);
    return out;
  }
  function resizeDoc(w, h, mode, anchor) {
    const why = sizeProblem(w, h);
    if (why) { flash(`Can't resize: ${why}`, true); return; }
    if (w === img.width && h === img.height) { flash('Size unchanged'); return; }
    commitText();
    dropSelection();
    if (mode === 'scale') { docOp(resample(img, w, h)); return; }
    const c = makeCanvas(w, h), g = c.getContext('2d');
    g.fillStyle = S.secondary;
    g.fillRect(0, 0, w, h);
    const { dx, dy } = Core.anchorOffset(img.width, img.height, w, h, anchor);
    g.drawImage(img, dx, dy);
    docOp(c);
  }

  // ---------- file I/O ----------
  const IMAGE_TYPES = [{ description: 'Images', accept: { 'image/*': ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'] } }];
  // A floating selection or open text box isn't in history yet, but it is still unsaved work.
  const isDirty = () => !hist.isClean() || !!(sel && sel.float) || !!(textAt && textBox.value.trim());
  const confirmDiscard = () => !isDirty() || confirm(`Discard unsaved changes to ${S.fileName}?`);

  async function openFile() {
    if (!confirmDiscard()) return;
    if (!window.showOpenFilePicker) { $('#fileInput').click(); return; }
    try {
      const [h] = await window.showOpenFilePicker({ types: IMAGE_TYPES });
      await loadFile(await h.getFile(), h);
    } catch (err) {
      if (err.name !== 'AbortError') flash("Can't open the file: " + errText(err, 'permission was denied'), true);
    }
  }
  const cantOpen = (file) => (file.type === 'image/svg+xml' || /\.svg$/i.test(file.name)
    ? "Can't open SVG files. Use PNG, JPEG, WebP, GIF or BMP." : 'Not an image: ' + file.name);
  function tooBigToOpen(file, bmp) {
    const why = sizeProblem(bmp.width, bmp.height);
    if (!why) return false;
    bmp.close();
    flash(`Can't open ${file.name}: ${why}`, true);
    return true;
  }
  async function loadFile(file, handle, decoded) {
    let bmp = decoded;
    if (!bmp) {
      try { bmp = await createImageBitmap(file); }
      catch { flash(cantOpen(file), true); return; }
    }
    if (tooBigToOpen(file, bmp)) return;
    cancelText();
    setDoc(bmp, bmp.width, bmp.height);
    bmp.close();
    hist.clear();
    Object.assign(S, { fileHandle: handle || null, fileName: file.name, pristine: false, trimWarned: false });
    fitZoom(true);
    updateChrome();
  }

  // Formats we can encode. Anything else (GIF, BMP, ...) is saved as a new PNG rather than overwritten.
  const canWrite = (name) => /\.(png|jpe?g|webp)$/i.test(name);
  const asPng = (name) => Core.saveName(name) || 'untitled.png'; // foo.gif -> foo.png
  function mimeFor(name) {
    const ext = name.split('.').pop().toLowerCase();
    return ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png';
  }
  function encode(type) {
    let src = img;
    if (type === 'image/jpeg') { // no alpha in JPEG: flatten onto white instead of black
      src = makeCanvas(img.width, img.height);
      const g = src.getContext('2d');
      g.fillStyle = '#ffffff';
      g.fillRect(0, 0, src.width, src.height);
      g.drawImage(img, 0, 0);
    }
    return new Promise((res, rej) => src.toBlob((b) => (b ? res(b) : rej(new Error('encode failed'))), type, 0.92));
  }
  let saving = false;
  async function save(as) {
    if (saving) return; // one picker/write at a time
    saving = true;
    try { await saveNow(as); } finally { saving = false; }
  }
  async function saveNow(as) {
    commitText();
    commitSelection();
    const savedAt = hist.top(); // edits made while the save is in flight stay unsaved
    let h = as ? null : S.fileHandle;
    let name = S.fileName;
    if (!canWrite(name)) {
      if (h && !as) flash(`Can't write ${name.split('.').pop().toUpperCase()} files. Saving a PNG copy.`);
      h = null;
      name = asPng(name);
    }
    try {
      if (h && (await h.queryPermission({ mode: 'readwrite' })) !== 'granted' &&
          (await h.requestPermission({ mode: 'readwrite' })) !== 'granted') h = null;
      if (!h) {
        if (!window.showSaveFilePicker) {
          if (as) { // no save picker here: ask for the name, so Save As differs from Save
            const typed = Core.saveName(prompt('Save as (PNG, JPEG or WebP; PNG if no extension)', name));
            if (!typed) return;
            name = typed;
          }
          const a = document.createElement('a');
          a.href = URL.createObjectURL(await encode(mimeFor(name)));
          a.download = name;
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 10000);
          S.fileName = name;
          hist.markSaved(savedAt); updateChrome();
          flash('Downloaded ' + name);
          return;
        }
        h = await window.showSaveFilePicker({
          suggestedName: name,
          types: [
            { description: 'PNG', accept: { 'image/png': ['.png'] } },
            { description: 'JPEG', accept: { 'image/jpeg': ['.jpg', '.jpeg'] } },
            { description: 'WebP', accept: { 'image/webp': ['.webp'] } },
          ],
        });
      }
      const blob = await encode(mimeFor(h.name));
      const w = await h.createWritable();
      await w.write(blob);
      await w.close();
      hist.markSaved(savedAt);
      Object.assign(S, { fileHandle: h, fileName: h.name });
      updateChrome();
      flash('Saved ' + h.name);
    } catch (err) {
      if (err.name !== 'AbortError') flash('Save failed: ' + errText(err, 'permission was denied'), true);
    }
  }

  // ---------- dialogs ----------
  // Dialog validation: message in an alert region, the bad field marked and focused.
  function fieldError(note, field, msg) {
    $(note).textContent = msg;
    const f = $(field);
    f.setAttribute('aria-invalid', 'true');
    f.setAttribute('aria-describedby', note.slice(1));
    f.focus();
    f.select();
  }
  // The size field the user typed in last (an area error belongs to the one they just changed).
  let lastSizeField = null;
  document.addEventListener('input', (e) => { if (/^(newW|newH|rW|rH)$/.test(e.target.id)) lastSizeField = '#' + e.target.id; });
  const lastEdited = (a, b) => (lastSizeField === a || lastSizeField === b ? lastSizeField : b);
  function clearFieldErrors(note) {
    $(note).textContent = '';
    $(note).closest('form').querySelectorAll('[aria-invalid]').forEach((f) => f.removeAttribute('aria-invalid'));
  }
  function openNewDialog() {
    commitText(); // a text box left behind a modal would lose its focus and go dead
    if (!confirmDiscard()) return;
    clearFieldErrors('#newNote');
    $('#newW').value = img.width;
    $('#newH').value = img.height;
    $('#newDlg').showModal();
    $('#newW').select();
  }
  // Apply on submit (synchronous), not 'close' (async): a fast follow-up action must see the result.
  $('#newDlg form').addEventListener('submit', (e) => {
    if (!e.submitter || e.submitter.value !== 'ok') return;
    const w = Math.round(+$('#newW').value), h = Math.round(+$('#newH').value);
    const err = Core.sizeError(w, h, MAX_DIM, MAX_PIXELS);
    if (err) {
      e.preventDefault();
      fieldError('#newNote', err.field ? '#new' + err.field.toUpperCase() : lastEdited('#newW', '#newH'),
        err.reason === 'range' ? `Width and height must be between 1 and ${MAX_DIM} px.` : `Too large: ${sizeProblem(w, h)}.`);
      return;
    }
    newDoc(w, h);
    S.pristine = false; // the user chose this size: a paste goes onto it, not in place of it
  });

  const rForm = $('#resizeDlg form');
  function resizeMode() { return rForm.rmode.value; }
  function openResize(mode) {
    commitText();
    rForm.rmode.value = mode === 'canvas' ? 'canvas' : 'scale';
    $('#rLock').checked = mode !== 'canvas'; // adding canvas space usually means growing one side
    $('#rUnit').value = 'px';
    $('#rW').value = img.width;
    $('#rH').value = img.height;
    syncResizeMode();
    syncUnitLabels();
    $('#resizeDlg').showModal();
    $('#rW').select();
  }
  function syncResizeMode() {
    const canvas = resizeMode() === 'canvas';
    $('#rAnchor').disabled = !canvas;
    $('#resizeTitle').textContent = canvas ? 'Canvas size' : 'Resize image';
    $('#rNote').textContent = canvas ? 'Adds or trims space around the image.' : 'Stretches or shrinks the whole image.';
    clearFieldErrors('#rErr');
  }
  function syncUnitLabels() {
    document.querySelectorAll('.rUnitLbl').forEach((u) => { u.textContent = $('#rUnit').value === 'pct' ? '%' : 'px'; });
  }
  function syncResize(changed) {
    if (!$('#rLock').checked) return;
    const pct = $('#rUnit').value === 'pct';
    const v = +$(changed === 'w' ? '#rW' : '#rH').value;
    if (!(v > 0)) return;
    if (pct) { $(changed === 'w' ? '#rH' : '#rW').value = v; return; }
    const d = Core.fitDims(img.width, img.height, changed === 'w' ? { w: v, lockAspect: true } : { h: v, lockAspect: true });
    if (changed === 'w') $('#rH').value = d.h; else $('#rW').value = d.w;
  }
  $('#rW').addEventListener('input', () => { syncResize('w'); syncResizeMode(); });
  ['#newW', '#newH'].forEach((id) => $(id).addEventListener('input', () => clearFieldErrors('#newNote')));
  $('#rH').addEventListener('input', () => { syncResize('h'); syncResizeMode(); });
  $('#rUnit').addEventListener('change', () => {
    const pct = $('#rUnit').value === 'pct';
    $('#rW').value = pct ? 100 : img.width;
    $('#rH').value = pct ? 100 : img.height;
    syncUnitLabels();
  });
  rForm.addEventListener('change', (e) => { if (e.target.name === 'rmode') syncResizeMode(); });
  document.querySelectorAll('dialog [data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
  rForm.addEventListener('submit', (e) => {
    if (!e.submitter || e.submitter.value !== 'ok') return;
    let w = +$('#rW').value, h = +$('#rH').value;
    if ($('#rUnit').value === 'pct') {
      w = Math.max(1, Math.round(img.width * w / 100));
      h = Math.max(1, Math.round(img.height * h / 100));
    }
    w = Math.round(w); h = Math.round(h);
    const err = Core.sizeError(w, h, MAX_DIM, MAX_PIXELS);
    if (err) {
      e.preventDefault();
      fieldError('#rErr', err.field ? '#r' + err.field.toUpperCase() : lastEdited('#rW', '#rH'),
        err.reason === 'range'
          ? `Width and height must be between 1 and ${MAX_DIM} px` + (w >= 1 && h >= 1 ? ` (this would be ${w} × ${h} px).` : '.')
          : `Too large: ${sizeProblem(w, h)}.`);
      return;
    }
    resizeDoc(w, h, resizeMode(), rForm.anchor.value);
  });

  // ---------- canvas resize handles (Paint-style: right, bottom, corner; top-left stays put) ----------
  const ghost = $('#resizeGhost');
  let ghostSize = '';
  function showGhost(d) { // runs every frame of a handle drag: write only on change
    ghost.hidden = false;
    const sz = d.w * S.zoom + 'px ' + d.h * S.zoom + 'px';
    if (sz === ghostSize) return;
    ghostSize = sz;
    ghost.style.width = d.w * S.zoom + 'px';
    ghost.style.height = d.h * S.zoom + 'px';
  }
  function endCanvasDrag(apply) {
    const d = drag;
    drag = null;
    ghost.hidden = true;
    if (apply) resizeDoc(d.w, d.h, 'canvas', 'tl');
    updateStatus();
  }
  document.querySelectorAll('.handle').forEach((h) => {
    h.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || drag) return;
      e.preventDefault();
      e.stopPropagation();
      commitText();
      if (document.activeElement) document.activeElement.blur();
      try { h.setPointerCapture(e.pointerId); } catch { /* inactive pointer: drag still works while over the handle */ }
      drag = { t: 'canvas', edge: h.dataset.edge, sx: e.clientX, sy: e.clientY, w: img.width, h: img.height };
      showGhost(drag);
      updateStatus();
    });
    h.addEventListener('pointermove', (e) => {
      if (!drag || drag.t !== 'canvas') return;
      const n = Core.dragResize(img.width, img.height, e.clientX - drag.sx, e.clientY - drag.sy, drag.edge, S.zoom, e.shiftKey, MAX_DIM, MAX_PIXELS);
      drag.w = n.w; drag.h = n.h;
      requestRender(); // ghost and status are written in render()
    });
    h.addEventListener('pointerup', () => { if (drag && drag.t === 'canvas') endCanvasDrag(true); });
    h.addEventListener('pointercancel', () => { if (drag && drag.t === 'canvas') endCanvasDrag(false); });
  });

  // ---------- pointer ----------
  ov.addEventListener('pointerdown', (e) => {
    if (drag) return;
    if (e.button === 1 || (e.button === 0 && S.panKey)) {
      e.preventDefault();
      ov.setPointerCapture(e.pointerId);
      drag = { t: 'pan', sx: e.clientX, sy: e.clientY, sl: vp.scrollLeft, st: vp.scrollTop };
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
    switch (t) {
      case 'pencil': case 'eraser': {
        const c = t === 'eraser' ? S.secondary : color;
        beginOp(true);
        drag = { t, last: ip, color: c };
        stampLine(ip, ip, c, S.sizes[t]);
        break;
      }
      case 'brush': {
        // Smoothing radius is in screen px (2 per step), fixed for the stroke even if the zoom changes.
        beginOp(true);
        const size = S.sizes.brush;
        drag = { t, color, size, ptr: p, stroke: new Core.Stroke(p, S.smoothing * 2 / S.zoom, 0.5 / S.zoom) };
        brushDot(p, color, size);
        break;
      }
      case 'fill': doFill(ip, color); break;
      case 'picker': pick(ip, right); break;
      case 'line': case 'rect': case 'ellipse':
        drag = { t, start: ip, end: ip, shift: e.shiftKey, color, alt };
        break;
      case 'text': startText(ip, color); break;
      case 'select': {
        const rp = { x: clamp(Math.round(p.x), 0, img.width), y: clamp(Math.round(p.y), 0, img.height) };
        if (sel && inside(p, sel)) {
          // Lift on the first real movement, so a plain click inside the selection changes nothing.
          drag = { t: 'move', gx: p.x - sel.x, gy: p.y - sel.y, ox: sel.x, oy: sel.y, lifted: false };
        } else {
          dropSelection();
          drag = { t: 'select', start: rp, end: rp };
        }
        break;
      }
    }
    requestRender();
  });

  ov.addEventListener('pointermove', (e) => {
    const r = img.getBoundingClientRect();
    const p = imgPt(e, r);
    cursor = { x: Math.floor(p.x), y: Math.floor(p.y) };
    hoverPt = p;
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
      if (d.segs) { brushPath(ctx, d.segs, d.color, d.size); d.segs = null; }
    } else if (SHAPES.has(d.t)) {
      d.end = { x: Math.floor(p.x), y: Math.floor(p.y) };
      d.shift = e.shiftKey;
    } else if (d.t === 'select') {
      d.end = { x: clamp(Math.round(p.x), 0, img.width), y: clamp(Math.round(p.y), 0, img.height) };
    } else if (d.t === 'move') {
      if (!sel) { drag = null; return; }
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
    drag = null;
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
    drag = null;
    if (d.t === 'pan') { stage.classList.remove('dragging'); if (!S.panKey) stage.classList.remove('panning'); }
    else if (d.t === 'brush') {
      // The stroke ends exactly where the pointer lifted (pointercancel carries no reliable position).
      const q = e && e.type === 'pointerup' ? imgPt(e) : d.ptr;
      brushPath(ctx, d.stroke.finish(q), d.color, d.size);
      endOp();
    }
    else if (d.t === 'pencil' || d.t === 'eraser') endOp();
    else if (SHAPES.has(d.t)) {
      if (d.t !== 'line' && d.start.x === d.end.x && d.start.y === d.end.y) { requestRender(); return; } // a click, not a shape
      beginOp();
      const b = shapeBox(d);
      touch(b.x, b.y, b.w, b.h);
      drawShape(ctx, d);
      endOp();
    } else if (d.t === 'select') {
      const r = Core.normRect(d.start, d.end);
      sel = r.w > 0 && r.h > 0 ? { ...r, float: null } : null;
    }
    requestRender();
  }
  ov.addEventListener('pointerup', finishDrag);
  ov.addEventListener('pointercancel', finishDrag);
  ov.addEventListener('pointerleave', () => { hoverPt = null; ring.hidden = true; if (!drag) { cursor = null; updateStatus(); } });
  ov.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus where we put it (text box)
  vp.addEventListener('contextmenu', (e) => e.preventDefault());

  vp.addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault(); // trackpad pinch arrives as ctrl+wheel; zoom the image, not the page
    setZoom(S.zoom * Math.exp(-clamp(e.deltaY, -100, 100) * 0.005), e.clientX, e.clientY);
  }, { passive: false });

  // ---------- keyboard ----------
  const TYPING_INPUTS = new Set(['text', 'number', 'search', 'email', 'url', 'password']);
  function isTyping(t) {
    if (!t || !t.tagName) return false;
    return t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable ||
      (t.tagName === 'INPUT' && TYPING_INPUTS.has(t.type));
  }
  textBox.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.isComposing || e.keyCode === 229) return; // IME is using Enter/Esc to pick a candidate
    if (e.key === 'Escape') { e.preventDefault(); cancelText(); }
    else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitText(); }
  });
  textBox.addEventListener('blur', (e) => {
    // Picking a font, size or color in the toolbars restyles the open text instead of committing it.
    if (e.relatedTarget && e.relatedTarget.closest('.chrome')) return; // toolbar commands commit it themselves when needed
    commitText();
  });

  // Shortcuts follow the characters on the user's layout (AZERTY, Dvorak, German "+"), so the keys
  // match the labels. Non-Latin layouts fall back to the physical letter key; digits stay physical.
  const PUNCT = { '[': 'BracketLeft', ']': 'BracketRight', '+': 'Equal', '=': 'Equal', '-': 'Minus', '_': 'Minus' };
  function keyId(e) {
    if (/^[a-z]$/i.test(e.key)) return 'Key' + e.key.toUpperCase();
    if (PUNCT[e.key]) return PUNCT[e.key];
    if (/^Digit\d$/.test(e.code)) return e.code;
    if (e.key.length === 1 && e.code !== 'Space') return /^Key[A-Z]$/.test(e.code) && e.key.charCodeAt(0) > 127 ? e.code : '';
    return e.code;
  }
  // Esc dismisses a visible error toast first (keyboard path for its ×). Capture phase, so the text box
  // doesn't also cancel (and lose its text) on the same press. Not while a modal is open: the dialog sits
  // above the toast and Esc belongs to it. Mid-drag Esc still cancels the drag.
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || drag || modalOpen() || !$('#toast').classList.contains('error') || !$('#toast').classList.contains('show')) return;
    if (!tip.hidden && tipByKey) return; // a keyboard-focus tooltip takes the first Esc (handled below)
    clearTimeout(msgTimer); $('#toast').classList.remove('show');
    e.preventDefault(); e.stopImmediatePropagation();
  }, true);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !tip.hidden) {
      const fromKeyboard = tipByKey;
      hideTip();
      if (fromKeyboard) { e.preventDefault(); return; } // first Esc dismisses a focus tooltip (WCAG 1.4.13)
    }
    if (document.querySelector('dialog[open]') || isTyping(e.target)) return;
    if (drag) { // mid-gesture, only Esc (cancel) applies; other keys would pull state out from under it
      if (e.key === 'Escape') cancelDrag();
      else if (e.key === 'Shift' && SHAPES.has(drag.t)) { drag.shift = true; requestRender(); }
      if (e.code !== 'Space') e.preventDefault();
      return;
    }
    // Space/Enter on a focused control activate it (keyboard users); they are not shortcuts there.
    if ((e.code === 'Space' || e.key === 'Enter') && e.target.closest && e.target.closest('button, input, select')) return;
    const mod = e.metaKey || e.ctrlKey;
    const k = keyId(e);
    if (mod) {
      if (e.repeat && !['KeyZ', 'KeyY', 'Equal', 'Minus'].includes(k)) { e.preventDefault(); return; }
      const act = {
        KeyZ: () => (e.shiftKey ? redo() : undo()),
        KeyY: redo,
        KeyS: () => save(e.shiftKey),
        KeyO: openFile,
        KeyA: selectAll,
        KeyC: () => copySel(false),
        KeyX: () => (e.shiftKey ? crop() : copySel(true)),
        Digit0: () => fitZoom(false),
        Equal: () => zoomStep(1),
        Minus: () => zoomStep(-1),
      }[k];
      if (act) { e.preventDefault(); act(); }
      return; // ⌘V falls through to the native paste event
    }
    if (e.altKey) {
      if (k === 'KeyN') { e.preventDefault(); openNewDialog(); }
      return;
    }
    if (e.shiftKey && k === 'KeyR') { e.preventDefault(); openResize('scale'); return; }
    if (e.shiftKey && k === 'KeyC') { e.preventDefault(); openResize('canvas'); return; }
    if (e.key === '?') { openHelp(); return; }
    if (e.shiftKey && k === 'Digit0') { setZoom(1); return; }
    if (e.shiftKey && k === 'Digit1') { fitZoom(false); return; }
    if (TOOL_KEYS[k] && !e.shiftKey) { setTool(TOOL_KEYS[k]); return; }
    const step = e.shiftKey ? 10 : 1;
    const onCanvas = e.target === document.body || (e.target.closest && e.target.closest('#viewport'));
    if (k.startsWith('Arrow') && !onCanvas) return; // arrows on a focused control belong to that control
    switch (k) {
      case 'KeyX': swapColors(); break;
      case 'Delete': case 'Backspace': if (!onCanvas) return; e.preventDefault(); deleteSelection(); break;
      case 'Escape': dropSelection(); break;
      case 'BracketLeft': setSize(Core.stepSize(S.sizes[S.tool], -1)); break;
      case 'BracketRight': setSize(Core.stepSize(S.sizes[S.tool], 1)); break;
      case 'Equal': zoomStep(1); break;
      case 'Minus': zoomStep(-1); break;
      case 'Space': e.preventDefault(); S.panKey = true; ring.hidden = true; stage.classList.add('panning'); break;
      case 'ArrowLeft': if (sel) { e.preventDefault(); nudge(-step, 0); } break;
      case 'ArrowRight': if (sel) { e.preventDefault(); nudge(step, 0); } break;
      case 'ArrowUp': if (sel) { e.preventDefault(); nudge(0, -step); } break;
      case 'ArrowDown': if (sel) { e.preventDefault(); nudge(0, step); } break;
    }
  });
  window.addEventListener('keyup', (e) => {
    if (e.key === 'Shift' && drag && SHAPES.has(drag.t)) { drag.shift = false; requestRender(); }
    if (e.code === 'Space') { S.panKey = false; if (!drag || drag.t !== 'pan') stage.classList.remove('panning'); }
  });

  // ---------- paste / drop / unload ----------
  const modalOpen = () => !!document.querySelector('dialog[open]');
  window.addEventListener('paste', async (e) => {
    if (isTyping(e.target) || modalOpen()) return;
    const item = [...(e.clipboardData ? e.clipboardData.items : [])].find((i) => i.type.startsWith('image/'));
    if (!item) { flash('No image on the clipboard'); return; }
    e.preventDefault();
    try {
      const bmp = await createImageBitmap(item.getAsFile());
      pasteImage(bmp);
      bmp.close();
    } catch (err) {
      flash('Paste failed: ' + errText(err, 'the clipboard image couldn’t be read'), true);
    }
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    if (modalOpen()) return;
    const item = [...e.dataTransfer.items].find((i) => i.kind === 'file');
    if (!item) return;
    // Both must be requested synchronously, before the DataTransfer expires.
    const hp = item.getAsFileSystemHandle ? item.getAsFileSystemHandle() : null;
    const file = item.getAsFile();
    if (!file || (file.type && !file.type.startsWith('image/'))) { flash('Not an image: ' + (file ? file.name : 'file'), true); return; }
    // Decode before asking to discard, so a file that isn't an image never prompts.
    let bmp;
    try { bmp = await createImageBitmap(file); }
    catch { flash(cantOpen(file), true); return; }
    if (tooBigToOpen(file, bmp)) return; // before asking to discard: nothing would replace it
    if (!confirmDiscard()) { bmp.close(); return; }
    let handle = null;
    try { handle = hp ? await hp : null; } catch { handle = null; }
    loadFile(file, handle && handle.kind === 'file' ? handle : null, bmp);
  });
  $('#fileInput').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (f) loadFile(f, null);
    e.target.value = '';
  });
  window.addEventListener('beforeunload', (e) => {
    if (isDirty()) { e.preventDefault(); e.returnValue = ''; }
  });
  window.addEventListener('resize', () => updateStatus());

  // ---------- toolbar wiring ----------
  function swapColors() { const p = S.primary; setColor('primary', S.secondary); setColor('secondary', p); }
  const CMDS = {
    new: openNewDialog, open: openFile, save: () => save(false), saveAs: () => save(true),
    undo, redo, crop, resize: () => openResize('scale'), canvasSize: () => openResize('canvas'),
    rotL: () => transformDoc('rotL'), rotR: () => transformDoc('rotR'),
    flipH: () => transformDoc('flipH'), flipV: () => transformDoc('flipV'),
    zoomIn: () => zoomStep(1), zoomOut: () => zoomStep(-1),
    fit: () => fitZoom(false), zoom100: () => setZoom(1),
    help: openHelp, swap: swapColors,
  };
  document.addEventListener('click', (e) => {
    const b = e.target.closest('.chrome button');
    if (!b) return;
    hideTip();
    if (b.dataset.cmd) CMDS[b.dataset.cmd]();
    else if (b.dataset.tool) setTool(b.dataset.tool);
    // After a mouse click, hand focus back so single-key shortcuts (and Space-to-pan) work.
    // Keyboard activation (detail 0) keeps focus on the button so Tab order isn't lost.
    if (e.detail > 0) releaseFocus(b);
    else if (b.disabled) focusNeighbor(b); // e.g. Undo at the start of history
  });
  function focusNeighbor(b) {
    const all = [...b.closest('[role=toolbar]').querySelectorAll('button')];
    const i = all.indexOf(b);
    const next = all.slice(i + 1).concat(all.slice(0, i).reverse()).find((x) => !x.disabled && x.offsetParent !== null);
    if (next) next.focus();
  }
  // Range, radio and select fire 'change' on every arrow key, so only hand focus back after mouse use.
  let pointerUsed = false;
  document.addEventListener('pointerdown', () => { pointerUsed = true; }, true);
  document.addEventListener('keydown', () => { pointerUsed = false; }, true);
  document.addEventListener('change', (e) => {
    if (pointerUsed && e.target.closest('.chrome') && e.target.type !== 'number') releaseFocus(e.target);
  });
  function releaseFocus(el) {
    el.blur();
    if (textAt) textBox.focus(); // still typing: go back to the text
  }
  document.querySelectorAll('.chrome input[type=number]').forEach((i) => i.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && textAt) { i.blur(); commitText(); }
    else if (e.key === 'Enter' || e.key === 'Escape') releaseFocus(i);
  }));

  $('#size').addEventListener('input', (e) => setSize(+e.target.value));
  $('#tolerance').addEventListener('input', (e) => { S.tolerance = +e.target.value; $('#tolOut').textContent = S.tolerance; });
  $('#smoothing').addEventListener('input', (e) => { S.smoothing = +e.target.value; $('#smoothOut').textContent = S.smoothing; });
  document.querySelectorAll('input[name=fillMode]').forEach((r) => r.addEventListener('change', () => { S.fillMode = r.value; }));
  $('#font').addEventListener('change', (e) => { S.font = e.target.value; if (textAt) placeTextBox(); });
  $('#fontSize').addEventListener('input', (e) => {
    const v = +e.target.value;
    if (v >= 1) { S.fontSize = clamp(Math.round(v), 6, 400); if (textAt) placeTextBox(); }
  });
  $('#fontSize').addEventListener('change', (e) => { e.target.value = S.fontSize; });
  $('#primary').addEventListener('input', (e) => { setColor('primary', e.target.value); });
  $('#secondary').addEventListener('input', (e) => { setColor('secondary', e.target.value); });

  const pal = $('#palette');
  for (const [c, name] of PALETTE) {
    const b = document.createElement('button');
    b.style.setProperty('--c', c);
    b.dataset.color = c;
    b.dataset.name = b.dataset.tip = name;
    b.dataset.hint = 'Right-click or Shift-click for color 2';
    b.setAttribute('aria-label', name);
    pal.appendChild(b);
  }
  pal.addEventListener('click', (e) => {
    if (e.target.dataset.color) setColor(e.shiftKey ? 'secondary' : 'primary', e.target.dataset.color);
  });
  pal.addEventListener('contextmenu', (e) => {
    if (!e.target.dataset.color) return;
    e.preventDefault();
    setColor('secondary', e.target.dataset.color);
  });
  pal.addEventListener('keydown', (e) => {
    if (e.target.dataset.color && e.shiftKey && (e.key === 'Enter' || e.code === 'Space')) {
      e.preventDefault();
      e.stopPropagation();
      setColor('secondary', e.target.dataset.color);
    }
  });

  // ---------- roving focus: one Tab stop per toolbar, arrow keys inside ----------
  function rove(box, sel, keys) {
    const items = () => [...box.querySelectorAll(sel)].filter((b) => !b.disabled && b.offsetParent !== null);
    box.addEventListener('keydown', (e) => {
      const list = items(), i = list.indexOf(document.activeElement);
      if (i < 0) return;
      const d = e.key === 'Home' ? -Infinity : e.key === 'End' ? Infinity : keys[e.key];
      if (d == null) return;
      e.preventDefault();
      e.stopPropagation(); // arrows would otherwise nudge the selection
      list[clamp(i + d, 0, list.length - 1)].focus();
    });
    box.addEventListener('focusin', (e) => {
      if (!e.target.matches(sel)) return;
      box.querySelectorAll(sel).forEach((b) => { b.tabIndex = b === e.target ? 0 : -1; });
    });
    const fix = () => {
      const all = [...box.querySelectorAll(sel)];
      const cur = all.find((b) => b.tabIndex === 0);
      if (cur && !cur.disabled && cur.offsetParent !== null) return;
      const next = items()[0];
      all.forEach((b) => { b.tabIndex = b === next ? 0 : -1; });
    };
    fix();
    return fix;
  }
  const fixTopbar = rove($('#topbar'), 'button', { ArrowLeft: -1, ArrowRight: 1 });
  rove($('#rail'), 'button', { ArrowUp: -1, ArrowDown: 1 });
  rove(pal, 'button', { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -10, ArrowDown: 10 });
  new MutationObserver(fixTopbar).observe($('#topbar'), { subtree: true, attributeFilter: ['disabled'] });
  window.addEventListener('resize', fixTopbar);

  // ---------- tooltips ----------
  const tip = $('#tip');
  let tipTimer = 0, tipWarmUntil = 0, tipFor = null, tipByKey = false;
  function showTip(el) {
    tipFor = el;
    tip.textContent = el.dataset.tip;
    if (el.dataset.kbd) {
      const k = document.createElement('kbd');
      k.textContent = keyLabel(el.dataset.kbd);
      tip.appendChild(k);
    }
    if (el.dataset.hint) {
      const h = document.createElement('span');
      h.className = 'hint';
      h.textContent = keyLabel(el.dataset.hint);
      tip.appendChild(h);
    }
    tip.hidden = false;
    const r = el.getBoundingClientRect(), t = tip.getBoundingClientRect();
    const side = el.closest('#rail');
    // Palette: below the whole palette, so a tip never hides the other row of swatches.
    const bottom = el.parentElement === pal ? pal.getBoundingClientRect().bottom : r.bottom;
    let x = side ? r.right + 8 : r.left + r.width / 2 - t.width / 2;
    let y = side ? r.top + r.height / 2 - t.height / 2 : bottom + 6;
    x = clamp(x, 6, innerWidth - t.width - 6);
    y = clamp(y, 6, innerHeight - t.height - 6);
    tip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }
  function hideTip() {
    clearTimeout(tipTimer);
    if (!tip.hidden) tipWarmUntil = performance.now() + 400;
    tip.hidden = true;
    tipFor = null;
  }
  document.addEventListener('pointerover', (e) => {
    const el = e.target.closest('.chrome [data-tip]');
    if (el === tipFor) return;
    hideTip();
    if (!el || e.pointerType === 'touch' || drag) return;
    tipTimer = setTimeout(() => { showTip(el); tipByKey = false; }, performance.now() < tipWarmUntil ? 0 : 450);
  });
  document.addEventListener('pointerdown', hideTip, true);
  document.documentElement.addEventListener('mouseleave', hideTip);
  document.addEventListener('focusin', (e) => {
    const el = e.target.closest && e.target.closest('.chrome [data-tip]');
    if (el && e.target.matches(':focus-visible')) { hideTip(); showTip(el); tipByKey = true; }
  });
  document.addEventListener('focusout', () => { if (tipFor) hideTip(); });
  function resetTransientKeys() {
    hideTip();
    S.panKey = false;
    if (!drag || drag.t !== 'pan') stage.classList.remove('panning');
  }
  window.addEventListener('blur', resetTransientKeys);
  document.addEventListener('visibilitychange', () => { if (document.hidden) resetTransientKeys(); });

  // ---------- help ----------
  const HELP_COL = { Tools: 0, View: 0, File: 0, Edit: 1, Drawing: 1, Image: 1 }; // ~20 rows per column
  const HELP = [
    ['Tools', [['Select', 'S'], ['Pencil', 'P'], ['Brush', 'B'], ['Eraser', 'E'], ['Fill', 'F'], ['Color picker', 'I'],
      ['Text', 'T'], ['Line', 'L'], ['Rectangle', 'R'], ['Ellipse', 'O']]],
    ['Edit', [['Undo', '⌘Z'], ['Redo', '⌘⇧Z', '⌘Y'], ['Select all', '⌘A'], ['Deselect / dismiss error', 'Esc'], ['Cancel shape, selection or move drag', 'Esc'], ['Clear selection to color 2', 'Delete', '⌫'],
      ['Nudge selection (⇧ = 10px)', '←', '↑', '→', '↓'], ['Copy, cut, paste', '⌘C', '⌘X', '⌘V'], ['Crop to selection', '⌘⇧X']]],
    ['Drawing', [['Draw with color 1 / color 2', '~Left / right click'], ['Swap colors', 'X'], ['Smaller / bigger size', '[', ']'],
      ['Square, circle, 45° line', '⇧', '~drag'], ['Pick color 2 from a swatch', '~right-click / ⇧-click'],
      ['Apply text', 'Enter'], ['New line in text', '⇧Enter'], ['Cancel text', 'Esc']]],
    ['Image', [['Resize image', '⇧R'], ['Canvas size', '⇧C'], ['Canvas: keep aspect', '⇧', '~drag corner'], ['Cancel canvas drag', 'Esc']]],
    ['File', [['New', 'Alt+N'], ['Open', '⌘O'], ['Save', '⌘S'], ['Save as', '⌘⇧S']]],
    ['View', [['Zoom in / out', '+', '−', '⌘+', '⌘−'], ['Zoom at pointer', '⌘', '~scroll'], ['Fit to window', '⇧1', '⌘0'], ['Actual size', '⇧0'],
      ['Pan', 'Space', '~drag / middle-drag'], ['This list', '?']]],
  ];
  function openHelp() {
    commitText();
    const body = $('#helpBody');
    if (!body.firstChild) {
      const cols = [document.createElement('div'), document.createElement('div')];
      body.append(...cols);
      HELP.forEach(([title, rows], i) => {
        const sec = document.createElement('section');
        const h = document.createElement('h3');
        h.textContent = title;
        sec.appendChild(h);
        for (const [label, ...keys] of rows) {
          const row = document.createElement('div');
          row.className = 'row';
          const l = document.createElement('span');
          l.textContent = keyLabel(label);
          const k = document.createElement('span');
          k.className = 'keys';
          for (const key of keys) {
            const el = document.createElement(key[0] === '~' ? 'span' : 'kbd');
            el.textContent = key[0] === '~' ? keyLabel(key.slice(1)) : keyLabel(key);
            k.appendChild(el);
          }
          row.append(l, k);
          sec.appendChild(row);
        }
        cols[HELP_COL[title]].appendChild(sec);
      });
    }
    $('#helpDlg').showModal();
  }

  // ---------- drop zone ----------
  let dragDepth = 0;
  const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  window.addEventListener('dragenter', (e) => { if (hasFiles(e) && !modalOpen()) { dragDepth++; $('#dropZone').hidden = false; } });
  window.addEventListener('dragleave', (e) => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; $('#dropZone').hidden = true; } });
  window.addEventListener('drop', () => { dragDepth = 0; $('#dropZone').hidden = true; }, true);

  textBox.addEventListener('input', updateChrome);
  // Anchor grid: Up/Down move between rows (radios alone would step through the DOM order).
  $('.anchor').addEventListener('keydown', (e) => {
    const d = { ArrowUp: -3, ArrowDown: 3 }[e.key];
    if (!d) return;
    const cells = [...document.querySelectorAll('input[name=anchor]')];
    const i = cells.indexOf(document.activeElement) + d;
    e.preventDefault();
    if (i >= 0 && i < 9) { cells[i].checked = true; cells[i].focus(); }
  });

  // ---------- boot ----------
  document.querySelectorAll('[data-hint]').forEach((el) => { if (el.dataset.hint) el.setAttribute('aria-description', keyLabel(el.dataset.hint)); });
  // Expose shortcuts to assistive tech (aria-keyshortcuts uses Control/Meta/Shift names).
  document.querySelectorAll('[data-kbd]').forEach((el) => {
    const k = el.dataset.kbd;
    if (/\s/.test(k)) return;
    el.setAttribute('aria-keyshortcuts', k.replace('⌘', MAC ? 'Meta+' : 'Control+').replace('⇧', 'Shift+').replace('−', 'Minus').replace(/^\+$/, 'Shift+Equal'));
  });
  // Fade the bottom of the shortcut list while more is hidden below.
  const helpBody = $('#helpBody');
  const helpFade = () => helpBody.classList.toggle('more', helpBody.scrollTop + helpBody.clientHeight < helpBody.scrollHeight - 2);
  helpBody.addEventListener('scroll', helpFade);
  $('#helpDlg').addEventListener('toggle', helpFade);
  window.addEventListener('resize', helpFade);
  setColor('primary', S.primary);
  setColor('secondary', S.secondary);
  $('#stIntro').textContent = `Draw, or drop or paste an image · ${keyLabel('⌘O')} opens a file`;
  newDoc(800, 600);
  setTool('pencil');

  // Handle for scripted smoke tests in the console.
  window.__paint = { S, hist, get img() { return img; }, newDoc, flash, save, updateChrome, get drag() { return drag; }, get sel() { return sel; }, setTool, undo, redo, crop, resizeDoc, transformDoc, selectAll, pasteImage, loadFile, setZoom, fitZoom, MAX_PIXELS, flushToData, get pendingParts() { return [...pendingParts].filter((p) => p.cv).length; } };
})();
