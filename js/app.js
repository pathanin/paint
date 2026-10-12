(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const img = $('#image'), ov = $('#overlay'), stage = $('#stage'), vp = $('#viewport'), textBox = $('#textInput');
  const ring = $('#ring');
  const ctx = img.getContext('2d');
  const octx = ov.getContext('2d');
  // GPU-side copy of the canvas taken at the start of each op; undo regions are read from it at the end.
  const backup = document.createElement('canvas');
  const bctx = backup.getContext('2d');

  const S = {
    tool: 'pencil', prevTool: 'pencil',
    primary: '#000000', secondary: '#ffffff',
    sizes: { pencil: 1, brush: 6, eraser: 12, line: 2, rect: 2, ellipse: 2 },
    fillMode: 'outline', tolerance: 10,
    font: 'system-ui, sans-serif', fontSize: 24,
    zoom: 1,
    fileHandle: null, fileName: 'untitled.png',
    pristine: true, panKey: false,
  };
  const hist = new Core.History({ maxBytes: 256 * 1024 * 1024, maxCount: 100 });
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

  let drag = null;   // in-progress pointer interaction
  let sel = null;    // {x, y, w, h, float: canvas|null}
  let op = null;     // dirty bbox of the current undoable region op
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
  const toHex = (r, g, b) => '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  let msgTimer = 0;
  function flash(msg, isError) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.toggle('error', !!isError);
    t.classList.add('show');
    clearTimeout(msgTimer);
    msgTimer = setTimeout(() => t.classList.remove('show'), isError ? 5000 : 2200);
  }

  // Shortcut labels are written Mac-style in the markup; show Ctrl/Shift elsewhere.
  const MAC = /Mac|iPhone|iPad/.test(navigator.platform);
  const keyLabel = (k) => (MAC ? k.replace(/Alt\+/g, '⌥')
    : k === '⌘' ? 'Ctrl' : k === '⇧' ? 'Shift' : k === '⌫' ? 'Backspace'
    : k.replace(/⌘/g, 'Ctrl+').replace(/⇧([- ])/g, 'Shift$1').replace(/⇧/g, 'Shift+').replace(/\+\+$/, '+Plus'));

  // ---------- document & history ----------
  function setDoc(source, w, h) {
    img.width = ov.width = backup.width = w;
    img.height = ov.height = backup.height = h;
    if (source) ctx.drawImage(source, 0, 0);
    else { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h); }
    sel = null; drag = null; op = null;
    layout();
    requestRender();
  }

  function beginOp() {
    bctx.clearRect(0, 0, backup.width, backup.height);
    bctx.drawImage(img, 0, 0);
    op = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  }
  function touch(x, y, w, h) {
    if (!op) return;
    op.x0 = Math.min(op.x0, Math.floor(x));
    op.y0 = Math.min(op.y0, Math.floor(y));
    op.x1 = Math.max(op.x1, Math.ceil(x + w));
    op.y1 = Math.max(op.y1, Math.ceil(y + h));
  }
  function endOp() {
    const o = op; op = null;
    if (!o || o.x1 <= o.x0 || o.y1 <= o.y0) return;
    const r = Core.clampRect({ x: o.x0, y: o.y0, w: o.x1 - o.x0, h: o.y1 - o.y0 }, img.width, img.height);
    if (!r) return;
    const before = bctx.getImageData(r.x, r.y, r.w, r.h);
    const after = ctx.getImageData(r.x, r.y, r.w, r.h);
    pushHist({ type: 'region', x: r.x, y: r.y, before, after, bytes: r.w * r.h * 8 });
  }
  // Replace the whole document (crop/resize/rotate/...) as one undo step.
  function docOp(next) {
    commitText();
    commitSelection();
    const before = cloneCanvas(img);
    setDoc(next, next.width, next.height);
    pushDocHist(before, next);
  }
  function pushDocHist(before, after) {
    pushHist({ type: 'doc', before, after, bytes: (before.width * before.height + after.width * after.height) * 4 });
  }
  function pushHist(e) {
    hist.push(e);
    S.pristine = false;
    updateChrome();
  }
  function applyHist(e, which) {
    if (e.type === 'region') ctx.putImageData(e[which], e.x, e.y);
    else setDoc(e[which], e[which].width, e[which].height);
    updateChrome();
    requestRender();
  }
  function undo() {
    if (drag) return;
    commitText();
    commitSelection();
    const e = hist.undo();
    if (e) applyHist(e, 'before');
  }
  function redo() {
    if (drag) return;
    commitText();
    commitSelection();
    const e = hist.redo();
    if (e) applyHist(e, 'after');
  }

  function newDoc(w, h) {
    commitText();
    setDoc(null, w, h);
    hist.clear();
    Object.assign(S, { fileHandle: null, fileName: 'untitled.png', pristine: true });
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

  let rafPending = false, overlayDirty = false;
  function requestRender() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(render);
  }
  function render() {
    rafPending = false;
    const shape = drag && SHAPES.has(drag.t);
    const marquee = drag && drag.t === 'select';
    if (!overlayDirty && !shape && !marquee && !sel) { updateStatus(); return; }
    octx.clearRect(0, 0, ov.width, ov.height);
    overlayDirty = false;
    if (shape) { drawShape(octx, drag); overlayDirty = true; }
    if (marquee) { ants(Core.normRect(drag.start, drag.end)); overlayDirty = true; }
    if (sel) {
      if (sel.float) octx.drawImage(sel.float, sel.x, sel.y);
      ants(sel);
      overlayDirty = true;
    }
    updateStatus();
  }
  function ants(r) {
    const lw = 1 / S.zoom;
    octx.save();
    octx.lineWidth = lw;
    octx.setLineDash([4 * lw, 4 * lw]);
    octx.strokeStyle = '#000';
    octx.strokeRect(r.x + lw / 2, r.y + lw / 2, r.w - lw, r.h - lw);
    octx.lineDashOffset = 4 * lw;
    octx.strokeStyle = '#fff';
    octx.strokeRect(r.x + lw / 2, r.y + lw / 2, r.w - lw, r.h - lw);
    octx.restore();
  }

  let cursor = null;
  function updateStatus() {
    $('#stPos').textContent = cursor ? `${cursor.x}, ${cursor.y} px` : '—';
    const r = drag && drag.t === 'select' ? Core.normRect(drag.start, drag.end) : sel;
    $('#stSelWrap').hidden = !r;
    $('#stSel').textContent = r ? `${r.w} × ${r.h} px` : '';
    $('#stSize').textContent = drag && drag.t === 'canvas'
      ? `${img.width} × ${img.height} → ${drag.w} × ${drag.h} px · Esc to cancel`
      : `${img.width} × ${img.height} px`;
    const pct = Math.round(S.zoom * 100) + '%';
    $('#zoomBtn').textContent = pct;
    $('#zoomBtn').setAttribute('aria-label', `Zoom ${pct}. Activate for actual size`);
    // aria-disabled (not disabled) keeps Crop focusable, so keyboard users can reach the explanation.
    const cb = $('#cropBtn');
    cb.setAttribute('aria-disabled', !sel);
    cb.dataset.hint = sel ? '' : 'Select an area first';
    if (sel) cb.removeAttribute('aria-description'); else cb.setAttribute('aria-description', 'Select an area first');
  }
  function updateChrome() {
    const dirty = isDirty();
    document.title = (dirty ? '● ' : '') + S.fileName + ' — Paint';
    if ($('#docTitle').textContent !== S.fileName) $('#docTitle').textContent = S.fileName;
    $('#docDirty').hidden = !dirty;
    $('#undoBtn').disabled = !hist.canUndo() && !(sel && sel.float); // undo drops a floating paste/move
    $('#redoBtn').disabled = !hist.canRedo();
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
    if (S.sizes[t] != null) { $('#size').value = S.sizes[t]; $('#sizeOut').textContent = S.sizes[t]; }
  }
  function setSize(v) {
    if (S.sizes[S.tool] == null) return;
    S.sizes[S.tool] = clamp(v, 1, 100);
    $('#size').value = S.sizes[S.tool];
    $('#sizeOut').textContent = S.sizes[S.tool];
  }
  function setColor(which, hex) {
    S[which] = hex;
    $('#' + which).value = hex;
    if (textAt && which === 'primary') { textAt.color = hex; placeTextBox(); }
    document.querySelectorAll('#palette button').forEach((b) => {
      b.classList.toggle('is1', b.dataset.color === S.primary);
      b.classList.toggle('is2', b.dataset.color === S.secondary);
      b.setAttribute('aria-pressed', b.dataset.color === S.primary);
      b.setAttribute('aria-label', b.dataset.tip + (b.dataset.color === S.secondary ? ' (color 2)' : ''));
    });
  }

  function stampLine(a, b, color, size) {
    const off = Math.floor(size / 2);
    ctx.fillStyle = color;
    ctx.beginPath();
    for (const [x, y] of Core.line(a.x, a.y, b.x, b.y)) ctx.rect(x - off, y - off, size, size);
    ctx.fill();
    touch(Math.min(a.x, b.x) - off, Math.min(a.y, b.y) - off, Math.abs(b.x - a.x) + size, Math.abs(b.y - a.y) + size);
  }
  function brushSeg(a, b, color, size) {
    ctx.fillStyle = ctx.strokeStyle = color;
    ctx.lineWidth = size;
    ctx.lineCap = ctx.lineJoin = 'round';
    ctx.beginPath();
    if (a.x === b.x && a.y === b.y) { ctx.arc(a.x, a.y, size / 2, 0, Math.PI * 2); ctx.fill(); }
    else { ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
    const h = size / 2 + 1;
    touch(Math.min(a.x, b.x) - h, Math.min(a.y, b.y) - h, Math.abs(b.x - a.x) + 2 * h, Math.abs(b.y - a.y) + 2 * h);
  }

  function doFill(p, color) {
    const W = img.width, H = img.height;
    if (p.x < 0 || p.y < 0 || p.x >= W || p.y >= H) return;
    const data = ctx.getImageData(0, 0, W, H);
    const box = Core.floodFill(new Uint32Array(data.data.buffer), W, H, p.x, p.y, hexToU32(color), S.tolerance);
    if (!box) return;
    beginOp();
    ctx.putImageData(data, 0, 0, box.x, box.y, box.w, box.h);
    touch(box.x, box.y, box.w, box.h);
    endOp();
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
    const r = Core.normRect(a, b);
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
  }
  function commitText() {
    if (!textAt) return;
    const t = textAt; textAt = null;
    textBox.hidden = true;
    $('#stHint').hidden = true;
    const lines = textBox.value.split('\n');
    textBox.value = '';
    if (!lines.join('').trim()) return;
    const fs = S.fontSize, lh = fs * 1.2;
    beginOp();
    ctx.save();
    ctx.font = `${fs}px ${S.font}`;
    ctx.fillStyle = t.color;
    ctx.textBaseline = 'top';
    let w = 0;
    lines.forEach((ln, i) => {
      ctx.fillText(ln, t.x, t.y + i * lh + (lh - fs) / 2);
      w = Math.max(w, ctx.measureText(ln).width);
    });
    ctx.restore();
    touch(t.x - fs / 2, t.y - fs / 2, w + fs, lines.length * lh + fs);
    endOp();
  }
  function cancelText() {
    textAt = null;
    textBox.hidden = true;
    $('#stHint').hidden = true;
    textBox.value = '';
  }

  // ---------- selection ----------
  const inside = (p, r) => p.x >= r.x && p.y >= r.y && p.x < r.x + r.w && p.y < r.y + r.h;
  function liftSelection() {
    beginOp();
    const f = makeCanvas(sel.w, sel.h);
    f.getContext('2d').drawImage(img, sel.x, sel.y, sel.w, sel.h, 0, 0, sel.w, sel.h);
    ctx.fillStyle = S.secondary;
    ctx.fillRect(sel.x, sel.y, sel.w, sel.h);
    touch(sel.x, sel.y, sel.w, sel.h);
    sel.float = f;
    updateChrome();
  }
  function commitSelection() {
    if (!sel || !sel.float) return;
    ctx.drawImage(sel.float, sel.x, sel.y);
    touch(sel.x, sel.y, sel.w, sel.h);
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
    op = null;
    pushDocHist(before, cloneCanvas(img));
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
      ctx.fillStyle = S.secondary;
      ctx.fillRect(sel.x, sel.y, sel.w, sel.h);
      touch(sel.x, sel.y, sel.w, sel.h);
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
    if (!sel) return cloneCanvas(img);
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
      flash('Copy failed: ' + err.message, true);
    }
  }
  function pasteImage(bmp) {
    commitText();
    dropSelection();
    if (S.pristine) { docOp(cloneCanvas(bmp)); fitZoom(true); return; }
    // Grow the canvas to fit the paste (each axis only as needed). No history entry yet:
    // finishFloat() records grow + paste as a single undo step.
    let growFrom = null;
    if (bmp.width > img.width || bmp.height > img.height) {
      growFrom = cloneCanvas(img);
      const c = makeCanvas(Math.max(img.width, bmp.width), Math.max(img.height, bmp.height));
      const g = c.getContext('2d');
      g.fillStyle = S.secondary;
      g.fillRect(0, 0, c.width, c.height);
      g.drawImage(img, 0, 0);
      setDoc(c, c.width, c.height);
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
    if (w > MAX_DIM || h > MAX_DIM) { flash(`Max size is ${MAX_DIM}px`); return; }
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
      if (err.name !== 'AbortError') flash(err.message, true);
    }
  }
  async function loadFile(file, handle, decoded) {
    let bmp = decoded;
    if (!bmp) {
      try { bmp = await createImageBitmap(file); }
      catch { flash('Not an image: ' + file.name, true); return; }
    }
    cancelText();
    setDoc(bmp, bmp.width, bmp.height);
    bmp.close();
    hist.clear();
    Object.assign(S, { fileHandle: handle || null, fileName: file.name, pristine: false });
    fitZoom(true);
    updateChrome();
  }

  // Formats we can encode. Anything else (GIF, BMP, ...) is saved as a new PNG rather than overwritten.
  const canWrite = (name) => /\.(png|jpe?g|webp)$/i.test(name);
  const asPng = (name) => name.replace(/\.[^.]*$/, '') + '.png';
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
  async function save(as) {
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
      if (err.name !== 'AbortError') flash('Save failed: ' + err.message, true);
    }
  }

  // ---------- dialogs ----------
  function openNewDialog() {
    if (!confirmDiscard()) return;
    $('#newW').value = img.width;
    $('#newH').value = img.height;
    $('#newDlg').showModal();
    $('#newW').select();
  }
  // Apply on submit (synchronous), not 'close' (async): a fast follow-up action must see the result.
  $('#newDlg form').addEventListener('submit', (e) => {
    if (!e.submitter || e.submitter.value !== 'ok') return;
    const w = +$('#newW').value, h = +$('#newH').value;
    if (w >= 1 && h >= 1 && w <= MAX_DIM && h <= MAX_DIM) newDoc(w, h);
  });

  const rForm = $('#resizeDlg form');
  function resizeMode() { return rForm.rmode.value; }
  function openResize(mode) {
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
    $('#rNote').classList.remove('error');
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
    if (!(w >= 1 && h >= 1 && w <= MAX_DIM && h <= MAX_DIM)) {
      e.preventDefault();
      $('#rNote').textContent = `Width and height must be between 1 and ${MAX_DIM} px` +
        (w >= 1 && h >= 1 ? ` (this would be ${w} × ${h} px).` : '.');
      $('#rNote').classList.add('error');
      return;
    }
    resizeDoc(w, h, resizeMode(), rForm.anchor.value);
  });

  // ---------- canvas resize handles (Paint-style: right, bottom, corner; top-left stays put) ----------
  const ghost = $('#resizeGhost');
  function showGhost(d) {
    ghost.hidden = false;
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
      const n = Core.dragResize(img.width, img.height, e.clientX - drag.sx, e.clientY - drag.sy, drag.edge, S.zoom, e.shiftKey, MAX_DIM);
      drag.w = n.w; drag.h = n.h;
      showGhost(drag);
      updateStatus();
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
        beginOp();
        drag = { t, last: ip, color: c };
        stampLine(ip, ip, c, S.sizes[t]);
        break;
      }
      case 'brush':
        beginOp();
        drag = { t, last: p, color };
        brushSeg(p, p, color, S.sizes.brush);
        break;
      case 'fill': doFill(ip, color); break;
      case 'picker': pick(ip, right); break;
      case 'line': case 'rect': case 'ellipse':
        drag = { t, start: ip, end: ip, shift: e.shiftKey, color, alt };
        break;
      case 'text': startText(ip, color); break;
      case 'select': {
        const rp = { x: clamp(Math.round(p.x), 0, img.width), y: clamp(Math.round(p.y), 0, img.height) };
        if (sel && inside(p, sel)) {
          if (!sel.float) liftSelection();
          drag = { t: 'move', gx: p.x - sel.x, gy: p.y - sel.y };
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
    updateRing(p);
    if (!drag) {
      ov.style.cursor = S.tool === 'select' && sel && inside(p, sel) ? 'move' : '';
      updateStatus();
      return;
    }
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
        if (d.t === 'brush') { brushSeg(d.last, q, d.color, S.sizes.brush); d.last = q; }
        else {
          const iq = { x: Math.floor(q.x), y: Math.floor(q.y) };
          stampLine(d.last, iq, d.color, S.sizes[d.t]);
          d.last = iq;
        }
      }
    } else if (SHAPES.has(d.t)) {
      d.end = { x: Math.floor(p.x), y: Math.floor(p.y) };
      d.shift = e.shiftKey;
    } else if (d.t === 'select') {
      d.end = { x: clamp(Math.round(p.x), 0, img.width), y: clamp(Math.round(p.y), 0, img.height) };
    } else if (d.t === 'move') {
      sel.x = Math.round(p.x - d.gx);
      sel.y = Math.round(p.y - d.gy);
    }
    requestRender();
  });

  // Outline of the brush footprint, so big sizes show what they'll cover.
  const RING_TOOLS = new Set(['pencil', 'brush', 'eraser']);
  function updateRing(p) {
    const size = S.sizes[S.tool], px = size * S.zoom;
    if (!RING_TOOLS.has(S.tool) || S.panKey || (drag && drag.t === 'pan') || px < 4) { ring.hidden = true; return; }
    let x, y;
    if (S.tool === 'brush') { x = p.x - size / 2; y = p.y - size / 2; }
    else { const off = Math.floor(size / 2); x = Math.floor(p.x) - off; y = Math.floor(p.y) - off; }
    ring.classList.toggle('round', S.tool === 'brush');
    ring.style.width = ring.style.height = px + 'px';
    ring.style.transform = `translate(${x * S.zoom}px, ${y * S.zoom}px)`;
    ring.hidden = false;
  }

  function finishDrag() {
    const d = drag;
    if (!d) return;
    drag = null;
    if (d.t === 'pan') { stage.classList.remove('dragging'); if (!S.panKey) stage.classList.remove('panning'); }
    else if (d.t === 'pencil' || d.t === 'eraser' || d.t === 'brush') endOp();
    else if (SHAPES.has(d.t)) {
      beginOp();
      const b = drawShape(ctx, d);
      touch(b.x, b.y, b.w, b.h);
      endOp();
    } else if (d.t === 'select') {
      const r = Core.normRect(d.start, d.end);
      sel = r.w > 0 && r.h > 0 ? { ...r, float: null } : null;
    }
    requestRender();
  }
  ov.addEventListener('pointerup', finishDrag);
  ov.addEventListener('pointercancel', finishDrag);
  ov.addEventListener('pointerleave', () => { ring.hidden = true; if (!drag) { cursor = null; updateStatus(); } });
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
    if (e.relatedTarget && e.relatedTarget.closest('#optbar')) return;
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
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !tip.hidden) { hideTip(); e.preventDefault(); return; }
    if (document.querySelector('dialog[open]') || isTyping(e.target)) return;
    // Space/Enter on a focused control activate it (keyboard users); they are not shortcuts there.
    if ((e.code === 'Space' || e.key === 'Enter') && e.target.closest && e.target.closest('button, input, select')) return;
    const mod = e.metaKey || e.ctrlKey;
    const k = keyId(e);
    if (mod) {
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
    switch (k) {
      case 'KeyX': swapColors(); break;
      case 'Delete': case 'Backspace': e.preventDefault(); deleteSelection(); break;
      case 'Escape':
        if (drag && drag.t === 'canvas') endCanvasDrag(false);
        else if (drag && (SHAPES.has(drag.t) || drag.t === 'select')) { drag = null; requestRender(); }
        else dropSelection();
        break;
      case 'BracketLeft': setSize(S.sizes[S.tool] - (S.sizes[S.tool] > 10 ? 2 : 1)); break;
      case 'BracketRight': setSize(S.sizes[S.tool] + (S.sizes[S.tool] >= 10 ? 2 : 1)); break;
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
    if (e.code === 'Space') { S.panKey = false; if (!drag || drag.t !== 'pan') stage.classList.remove('panning'); }
  });

  // ---------- paste / drop / unload ----------
  const modalOpen = () => !!document.querySelector('dialog[open]');
  window.addEventListener('paste', async (e) => {
    if (isTyping(e.target) || modalOpen()) return;
    const item = [...(e.clipboardData ? e.clipboardData.items : [])].find((i) => i.type.startsWith('image/'));
    if (!item) return;
    e.preventDefault();
    try {
      const bmp = await createImageBitmap(item.getAsFile());
      pasteImage(bmp);
      bmp.close();
    } catch (err) {
      flash('Paste failed: ' + err.message, true);
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
    catch { flash('Not an image: ' + file.name, true); return; }
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
    b.style.background = c;
    b.dataset.color = c;
    b.dataset.tip = name;
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
  let tipTimer = 0, tipWarmUntil = 0, tipFor = null;
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
    let x = side ? r.right + 8 : r.left + r.width / 2 - t.width / 2;
    let y = side ? r.top + r.height / 2 - t.height / 2 : r.bottom + 6;
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
    tipTimer = setTimeout(() => showTip(el), performance.now() < tipWarmUntil ? 0 : 450);
  });
  document.addEventListener('pointerdown', hideTip, true);
  document.documentElement.addEventListener('mouseleave', hideTip);
  document.addEventListener('focusin', (e) => {
    const el = e.target.closest && e.target.closest('.chrome [data-tip]');
    if (el && e.target.matches(':focus-visible')) { hideTip(); showTip(el); }
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
    ['Edit', [['Undo', '⌘Z'], ['Redo', '⌘⇧Z', '⌘Y'], ['Select all', '⌘A'], ['Deselect', 'Esc'], ['Clear selection to color 2', 'Delete', '⌫'],
      ['Nudge selection (⇧ = 10px)', '←', '↑', '→', '↓'], ['Copy, cut, paste', '⌘C', '⌘X', '⌘V'], ['Crop to selection', '⌘⇧X']]],
    ['Drawing', [['Draw with color 1 / color 2', '~Left / right click'], ['Swap colors', 'X'], ['Smaller / bigger size', '[', ']'],
      ['Square, circle, 45° line', '⇧', '~drag'], ['Pick color 2 from a swatch', '~right-click / ⇧-click'],
      ['Apply text', 'Enter'], ['New line in text', '⇧Enter'], ['Cancel text', 'Esc']]],
    ['Image', [['Resize image', '⇧R'], ['Canvas size', '⇧C'], ['Canvas: keep aspect', '⇧', '~drag corner'], ['Cancel canvas drag', 'Esc'], ['Cancel shape or selection drag', 'Esc']]],
    ['File', [['New', 'Alt+N'], ['Open', '⌘O'], ['Save', '⌘S'], ['Save as', '⌘⇧S']]],
    ['View', [['Zoom in / out', '+', '−', '⌘+', '⌘−'], ['Zoom at pointer', '⌘', '~scroll'], ['Fit to window', '⇧1', '⌘0'], ['Actual size', '⇧0'],
      ['Pan', 'Space', '~drag / middle-drag'], ['This list', '?']]],
  ];
  function openHelp() {
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
  newDoc(800, 600);
  setTool('pencil');

  // Handle for scripted smoke tests in the console.
  window.__paint = { S, hist, img, flash, save, get sel() { return sel; }, setTool, undo, redo, crop, resizeDoc, transformDoc, selectAll, pasteImage, setZoom, fitZoom };
})();
