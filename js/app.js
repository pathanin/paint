(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const img = $('#image'), ov = $('#overlay'), stage = $('#stage'), vp = $('#viewport'), textBox = $('#textInput');
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
    dirty: false, pristine: true, panKey: false,
  };
  const hist = new Core.History({ maxBytes: 256 * 1024 * 1024, maxCount: 100 });
  const SHAPES = new Set(['line', 'rect', 'ellipse']);
  const TOOL_KEYS = {
    KeyS: 'select', KeyP: 'pencil', KeyB: 'brush', KeyE: 'eraser', KeyF: 'fill',
    KeyI: 'picker', KeyT: 'text', KeyL: 'line', KeyR: 'rect', KeyO: 'ellipse',
  };
  const PALETTE = [
    '#000000', '#7f7f7f', '#880015', '#ed1c24', '#ff7f27', '#fff200', '#22b14c', '#00a2e8', '#3f48cc', '#a349a4',
    '#ffffff', '#c3c3c3', '#b97a57', '#ffaec9', '#ffc90e', '#efe4b0', '#b5e61d', '#99d9ea', '#7092be', '#c8bfe7',
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
  function flash(msg) {
    $('#stMsg').textContent = msg;
    clearTimeout(msgTimer);
    msgTimer = setTimeout(() => { $('#stMsg').textContent = ''; }, 3000);
  }

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
    S.dirty = true; S.pristine = false;
    updateChrome();
  }
  function applyHist(e, which) {
    if (e.type === 'region') ctx.putImageData(e[which], e.x, e.y);
    else setDoc(e[which], e[which].width, e[which].height);
    S.dirty = true;
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
    Object.assign(S, { fileHandle: null, fileName: 'untitled.png', dirty: false, pristine: true });
    fitZoom(true);
    updateChrome();
  }

  // ---------- view ----------
  function layout() {
    stage.style.width = img.width * S.zoom + 'px';
    stage.style.height = img.height * S.zoom + 'px';
    stage.classList.toggle('pixelated', S.zoom * devicePixelRatio >= 1); // hard pixels, incl. 100% on Retina
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
  function fitZoom(capAt1) {
    const z = Math.min((vp.clientWidth - 32) / img.width, (vp.clientHeight - 32) / img.height);
    S.zoom = clamp(capAt1 ? Math.min(1, z) : z, 0.05, 32);
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
    $('#stSel').textContent = r ? `▭ ${r.w} × ${r.h}` : '';
    $('#stSize').textContent = drag && drag.t === 'canvas'
      ? `${img.width} × ${img.height} → ${drag.w} × ${drag.h}`
      : `${img.width} × ${img.height}`;
    $('#stZoom').textContent = Math.round(S.zoom * 100) + '%';
  }
  function updateChrome() {
    document.title = (S.dirty ? '● ' : '') + S.fileName + ' — Paint';
    $('#undoBtn').disabled = !hist.canUndo();
    $('#redoBtn').disabled = !hist.canRedo();
  }

  // ---------- tools ----------
  function setTool(t) {
    commitText();
    if (t !== 'select') dropSelection();
    if (t === 'picker' && S.tool !== 'picker') S.prevTool = S.tool;
    S.tool = t;
    stage.dataset.tool = t;
    document.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
    document.querySelectorAll('.opts [data-for]').forEach((l) => { l.hidden = !l.dataset.for.split(' ').includes(t); });
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
  }
  function commitText() {
    if (!textAt) return;
    const t = textAt; textAt = null;
    textBox.hidden = true;
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
    if (cut && sel) deleteSelection();
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      flash(cut ? 'Cut' : 'Copied');
    } catch (err) {
      flash('Copy failed: ' + err.message);
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
    // Drop it at the top-left of what's visible.
    const r = img.getBoundingClientRect(), v = vp.getBoundingClientRect();
    const x = clamp(Math.floor((v.left - r.left) / S.zoom), 0, img.width - bmp.width);
    const y = clamp(Math.floor((v.top - r.top) / S.zoom), 0, img.height - bmp.height);
    setTool('select');
    beginOp();
    sel = { x, y, w: bmp.width, h: bmp.height, float: cloneCanvas(bmp), growFrom };
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
    if (w === img.width && h === img.height) return;
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
  const confirmDiscard = () => !S.dirty || confirm('Discard unsaved changes?');

  async function openFile() {
    if (!confirmDiscard()) return;
    if (!window.showOpenFilePicker) { $('#fileInput').click(); return; }
    try {
      const [h] = await window.showOpenFilePicker({ types: IMAGE_TYPES });
      await loadFile(await h.getFile(), h);
    } catch (err) {
      if (err.name !== 'AbortError') flash(err.message);
    }
  }
  async function loadFile(file, handle) {
    let bmp;
    try { bmp = await createImageBitmap(file); }
    catch { flash('Not an image: ' + file.name); return; }
    cancelText();
    setDoc(bmp, bmp.width, bmp.height);
    bmp.close();
    hist.clear();
    Object.assign(S, { fileHandle: handle || null, fileName: file.name, dirty: false, pristine: false });
    fitZoom(true);
    updateChrome();
  }

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
    let h = as ? null : S.fileHandle;
    try {
      if (h && (await h.queryPermission({ mode: 'readwrite' })) !== 'granted' &&
          (await h.requestPermission({ mode: 'readwrite' })) !== 'granted') h = null;
      if (!h) {
        if (!window.showSaveFilePicker) {
          const a = document.createElement('a');
          a.href = URL.createObjectURL(await encode(mimeFor(S.fileName)));
          a.download = S.fileName;
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 10000);
          S.dirty = false; updateChrome();
          return;
        }
        h = await window.showSaveFilePicker({
          suggestedName: S.fileName,
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
      Object.assign(S, { fileHandle: h, fileName: h.name, dirty: false });
      updateChrome();
      flash('Saved ' + h.name);
    } catch (err) {
      if (err.name !== 'AbortError') flash('Save failed: ' + err.message);
    }
  }

  // ---------- dialogs ----------
  function openNewDialog() {
    $('#newW').value = img.width;
    $('#newH').value = img.height;
    $('#newDlg').showModal();
  }
  // Apply on submit (synchronous), not 'close' (async): a fast follow-up action must see the result.
  $('#newDlg form').addEventListener('submit', (e) => {
    if (!e.submitter || e.submitter.value !== 'ok') return;
    const w = +$('#newW').value, h = +$('#newH').value;
    if (w >= 1 && h >= 1 && w <= MAX_DIM && h <= MAX_DIM && confirmDiscard()) newDoc(w, h);
  });

  const rForm = $('#resizeDlg form');
  function resizeMode() { return rForm.rmode.value; }
  function openResize(mode) {
    rForm.rmode.value = mode === 'canvas' ? 'canvas' : 'scale';
    $('#rLock').checked = mode !== 'canvas'; // adding canvas space usually means growing one side
    $('#rUnit').value = 'px';
    $('#rW').value = img.width;
    $('#rH').value = img.height;
    $('#rAnchor').disabled = resizeMode() !== 'canvas';
    $('#resizeDlg').showModal();
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
  $('#rW').addEventListener('input', () => syncResize('w'));
  $('#rH').addEventListener('input', () => syncResize('h'));
  $('#rUnit').addEventListener('change', () => {
    const pct = $('#rUnit').value === 'pct';
    $('#rW').value = pct ? 100 : img.width;
    $('#rH').value = pct ? 100 : img.height;
  });
  rForm.addEventListener('change', (e) => { if (e.target.name === 'rmode') $('#rAnchor').disabled = resizeMode() !== 'canvas'; });
  document.querySelectorAll('dialog [data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
  rForm.addEventListener('submit', (e) => {
    if (!e.submitter || e.submitter.value !== 'ok') return;
    let w = +$('#rW').value, h = +$('#rH').value;
    if (!(w > 0 && h > 0)) return;
    if ($('#rUnit').value === 'pct') {
      w = Math.max(1, Math.round(img.width * w / 100));
      h = Math.max(1, Math.round(img.height * h / 100));
    }
    resizeDoc(Math.round(w), Math.round(h), resizeMode(), rForm.anchor.value);
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
      stage.classList.add('panning');
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

  function finishDrag() {
    const d = drag;
    if (!d) return;
    drag = null;
    if (d.t === 'pan') stage.classList.remove('panning');
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
  ov.addEventListener('pointerleave', () => { if (!drag) { cursor = null; updateStatus(); } });
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
    if (e.key === 'Escape') { e.preventDefault(); cancelText(); }
    else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitText(); }
  });
  textBox.addEventListener('blur', commitText);

  window.addEventListener('keydown', (e) => {
    if (document.querySelector('dialog[open]') || isTyping(e.target)) return;
    const mod = e.metaKey || e.ctrlKey, k = e.code;
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
        Digit1: () => setZoom(1),
        Equal: () => setZoom(S.zoom * 1.25),
        Minus: () => setZoom(S.zoom / 1.25),
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
    if (e.key === '?') { $('#helpDlg').showModal(); return; }
    if (TOOL_KEYS[k] && !e.shiftKey) { setTool(TOOL_KEYS[k]); return; }
    const step = e.shiftKey ? 10 : 1;
    switch (k) {
      case 'KeyX': { const p = S.primary; setColor('primary', S.secondary); setColor('secondary', p); break; }
      case 'Delete': case 'Backspace': e.preventDefault(); deleteSelection(); break;
      case 'Escape':
        if (drag && drag.t === 'canvas') endCanvasDrag(false);
        else if (drag && (SHAPES.has(drag.t) || drag.t === 'select')) { drag = null; requestRender(); }
        else dropSelection();
        break;
      case 'BracketLeft': setSize(S.sizes[S.tool] - (S.sizes[S.tool] > 10 ? 2 : 1)); break;
      case 'BracketRight': setSize(S.sizes[S.tool] + (S.sizes[S.tool] >= 10 ? 2 : 1)); break;
      case 'Equal': setZoom(S.zoom * 1.25); break;
      case 'Minus': setZoom(S.zoom / 1.25); break;
      case 'Space': e.preventDefault(); S.panKey = true; stage.classList.add('panning'); break;
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
  window.addEventListener('paste', async (e) => {
    if (isTyping(e.target)) return;
    const item = [...(e.clipboardData ? e.clipboardData.items : [])].find((i) => i.type.startsWith('image/'));
    if (!item) return;
    e.preventDefault();
    try {
      const bmp = await createImageBitmap(item.getAsFile());
      pasteImage(bmp);
      bmp.close();
    } catch (err) {
      flash('Paste failed: ' + err.message);
    }
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    const item = [...e.dataTransfer.items].find((i) => i.kind === 'file');
    if (!item) return;
    // Both must be requested synchronously, before the DataTransfer expires.
    const hp = item.getAsFileSystemHandle ? item.getAsFileSystemHandle() : null;
    const file = item.getAsFile();
    if (!confirmDiscard()) return;
    let handle = null;
    try { handle = hp ? await hp : null; } catch { handle = null; }
    loadFile(file, handle && handle.kind === 'file' ? handle : null);
  });
  $('#fileInput').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (f) loadFile(f, null);
    e.target.value = '';
  });
  window.addEventListener('beforeunload', (e) => {
    if (S.dirty) { e.preventDefault(); e.returnValue = ''; }
  });
  window.addEventListener('resize', () => updateStatus());

  // ---------- toolbar wiring ----------
  const CMDS = {
    new: openNewDialog, open: openFile, save: () => save(false), saveAs: () => save(true),
    undo, redo, crop, resize: () => openResize('scale'), canvasSize: () => openResize('canvas'),
    rotL: () => transformDoc('rotL'), rotR: () => transformDoc('rotR'),
    flipH: () => transformDoc('flipH'), flipV: () => transformDoc('flipV'),
    zoomIn: () => setZoom(S.zoom * 1.25), zoomOut: () => setZoom(S.zoom / 1.25),
    fit: () => fitZoom(false), zoom100: () => setZoom(1),
    help: () => $('#helpDlg').showModal(),
  };
  $('#toolbar').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.cmd) CMDS[b.dataset.cmd]();
    else if (b.dataset.tool) setTool(b.dataset.tool);
    b.blur(); // keep Space/Enter from re-triggering the button
  });
  // After using a toolbar control, hand focus back so single-key shortcuts work.
  $('#toolbar').addEventListener('change', (e) => { if (e.target.type !== 'number') e.target.blur(); });

  $('#size').addEventListener('input', (e) => setSize(+e.target.value));
  $('#tolerance').addEventListener('input', (e) => { S.tolerance = +e.target.value; $('#tolOut').textContent = S.tolerance; });
  $('#fillMode').addEventListener('change', (e) => { S.fillMode = e.target.value; });
  $('#font').addEventListener('change', (e) => { S.font = e.target.value; if (textAt) placeTextBox(); });
  $('#fontSize').addEventListener('input', (e) => {
    const v = +e.target.value;
    if (v >= 1) { S.fontSize = v; if (textAt) placeTextBox(); }
  });
  $('#primary').addEventListener('input', (e) => { S.primary = e.target.value; });
  $('#secondary').addEventListener('input', (e) => { S.secondary = e.target.value; });

  const pal = $('#palette');
  for (const c of PALETTE) {
    const b = document.createElement('button');
    b.style.background = c;
    b.title = c;
    b.dataset.color = c;
    pal.appendChild(b);
  }
  pal.addEventListener('click', (e) => { if (e.target.dataset.color) setColor('primary', e.target.dataset.color); });
  pal.addEventListener('contextmenu', (e) => {
    if (!e.target.dataset.color) return;
    e.preventDefault();
    setColor('secondary', e.target.dataset.color);
  });

  // ---------- boot ----------
  newDoc(800, 600);
  setTool('pencil');

  // Handle for scripted smoke tests in the console.
  window.__paint = { S, hist, img, get sel() { return sel; }, setTool, undo, redo, crop, resizeDoc, transformDoc, selectAll, pasteImage, setZoom, fitZoom };
})();
