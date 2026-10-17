// History correctness and memory e2e test (Playwright + installed Chrome). Dev-only, like smoke.js.
// usage: node history.js [url]   exit 0 = all pass
// 1. Every kind of edit, on an image full of semi-transparent noise, undoes and redoes pixel-exactly.
// 2. Undo depth on a large photo: many strokes must stay undoable (they used to evict each other,
//    because each region entry stored before+after of the whole stroke bbox).
const { chromium } = require('playwright');
const url = process.argv[2] || 'http://localhost:8765/';
let fails = 0, passes = 0;
const ok = (c, m) => { if (c) passes++; else { fails++; console.log('FAIL:', m); } };
(async () => {
  const browser = await chromium.launch({ channel: 'chrome' });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
    page.on('dialog', (d) => d.accept());
    await page.goto(url);
    await page.waitForTimeout(300);
    const P = (f, a) => page.evaluate(f, a);
    // the next frame, after any fill still running in its worker has landed
    const frame = () => P(async () => { await window.__paint.filling; await new Promise((r) => requestAnimationFrame(() => r())); });
    // FNV-1a over the whole image plus its size: equal hashes = identical pixels.
    const hash = () => P(() => {
      const c = document.querySelector('#image');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let h = 2166136261;
      for (let i = 0; i < d.length; i++) h = Math.imul(h ^ d[i], 16777619);
      return `${c.width}x${c.height}:${h >>> 0}`;
    });
    const box = () => page.locator('#overlay').boundingBox();
    const at = async (ix, iy) => { // image px -> page px
      const b = await box(); const W = await P(() => document.querySelector('#image').width);
      const z = b.width / W; return [b.x + (ix + 0.5) * z, b.y + (iy + 0.5) * z];
    };
    async function drag(tool, pts, opts = {}) {
      await P((t) => window.__paint.setTool(t), tool);
      const [x0, y0] = await at(...pts[0]);
      await page.mouse.move(x0, y0);
      await page.mouse.down({ button: opts.button || 'left' });
      for (const p of pts.slice(1)) { const [x, y] = await at(...p); await page.mouse.move(x, y, { steps: 4 }); }
      await page.mouse.up({ button: opts.button || 'left' });
      await frame();
    }

    // ---- 1. pixel-exact undo/redo over every edit kind ----
    await P(() => {
      const p = window.__paint;
      p.newDoc(300, 200);
      const c = p.base, g = c.getContext('2d'); // the pixels; #image shows them once repainted
      const im = g.createImageData(c.width, c.height);
      let s = 12345; const rnd = () => ((s = Math.imul(s, 1103515245) + 12345 >>> 0) >>> 16) & 255;
      for (let i = 0; i < im.data.length; i += 4) { im.data[i] = rnd(); im.data[i + 1] = rnd(); im.data[i + 2] = rnd(); im.data[i + 3] = (i / 4) % 7 === 0 ? 0 : rnd(); }
      g.putImageData(im, 0, 0);
      p.markAll();
      p.hist.clear(); p.fitZoom(false);
    });
    await frame();
    const states = [await hash()];
    const steps = [];
    const record = async (name) => { states.push(await hash()); steps.push(name); };
    const n0 = await P(() => window.__paint.hist.undoStack.length);
    await drag('pencil', [[10, 10], [120, 60], [40, 150]]); await record('pencil');
    await P(() => { window.__paint.S.sizes.brush = 17; window.__paint.S.primary = '#3366cc'; });
    await drag('brush', [[200, 20], [280, 180], [150, 100]]); await record('brush');
    await drag('eraser', [[60, 60], [250, 70]]); await record('eraser');
    await P(() => { window.__paint.S.fillMode = 'both'; });
    // Shapes are objects above the pixels (docs/objects.md): drawing one leaves the pixels as they
    // were, and flattening (⌘E) is the step that changes them. Both are steps of their own.
    const shape = async (name) => { await record(name + ' object'); await P(() => window.__paint.flattenObjs()); await frame(); await record(name + ' flatten'); };
    await drag('rect', [[20, 120], [90, 190]]); await shape('rect');
    await drag('ellipse', [[100, 20], [190, 90]], { button: 'right' }); await shape('ellipse');
    await drag('line', [[5, 195], [295, 5]]); await shape('line');
    await P(() => { window.__paint.S.tolerance = 40; window.__paint.setTool('fill'); });
    { const [x, y] = await at(150, 150); await page.mouse.click(x, y); await frame(); } await record('fill');
    await P(() => window.__paint.setTool('text'));
    { const [x, y] = await at(30, 30); await page.mouse.click(x, y); await page.keyboard.type('Hi there'); await page.keyboard.press('Enter'); await frame(); } await record('text');
    // selection lifted and moved, then committed by switching tool
    await drag('select', [[40, 40], [140, 110]]);
    await drag('select', [[90, 75], [150, 120]]);
    await P(() => window.__paint.setTool('pencil')); await frame(); await record('move selection');
    // selection cleared to color 2
    await drag('select', [[200, 120], [260, 170]]);
    await page.keyboard.press('Delete'); await frame(); await record('delete selection');
    // a cancelled move leaves no trace and no history entry
    await drag('select', [[10, 10], [60, 60]]);
    { const [x, y] = await at(30, 30); const [x2, y2] = await at(80, 90); await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x2, y2, { steps: 4 }); await page.keyboard.press('Escape'); await page.mouse.up(); await frame(); }
    ok(await hash() === states[states.length - 1], 'cancelled move restores the pixels');
    await P(() => window.__paint.setTool('pencil'));
    ok(await hash() === states[states.length - 1], 'cancelled move: nothing committed on deselect');
    // whole-document ops
    for (const k of ['rotR', 'flipH', 'rotL', 'flipV']) { await P((k) => window.__paint.transformDoc(k), k); await frame(); await record(k); }
    await P(() => window.__paint.resizeDoc(330, 210, 'canvas', 'mc')); await frame(); await record('canvas size');
    await P(() => window.__paint.resizeDoc(165, 105, 'scale')); await frame(); await record('scale');
    await drag('select', [[10, 10], [100, 80]]);
    await P(() => window.__paint.crop()); await frame(); await record('crop');
    await drag('pencil', [[3, 3], [80, 60]]); await record('pencil after crop');
    // paste larger than the canvas: grows it; one undo step for grow + paste
    await P(() => {
      const c = document.createElement('canvas'); c.width = 140; c.height = 50;
      const g = c.getContext('2d'); g.fillStyle = 'rgba(200, 30, 90, 0.5)'; g.fillRect(0, 0, 140, 50);
      window.__paint.pasteImage(c);
    });
    await P(() => window.__paint.setTool('pencil')); await frame(); await record('paste that grows');
    const nEntries = await P(() => window.__paint.hist.undoStack.length);
    ok(nEntries - n0 === steps.length, `one history entry per edit: ${nEntries - n0} vs ${steps.length}`);
    for (let i = steps.length; i > 0; i--) {
      await P(() => window.__paint.undo()); await frame();
      ok(await hash() === states[i - 1], `undo of ${steps[i - 1]} is pixel-exact`);
    }
    for (let i = 1; i <= steps.length; i++) {
      await P(() => window.__paint.redo()); await frame();
      ok(await hash() === states[i], `redo of ${steps[i - 1]} is pixel-exact`);
    }
    // undo again after a redo pass (entries are reusable both ways)
    for (let i = steps.length; i > steps.length - 4; i--) { await P(() => window.__paint.undo()); await frame(); ok(await hash() === states[i - 1], `second undo of ${steps[i - 1]}`); }
    // save point survives undo/redo
    await P(() => { window.__paint.hist.markSaved(); window.__paint.updateChrome(); });
    await P(() => window.__paint.undo()); ok(await P(() => !window.__paint.hist.isClean()), 'dirty after undo past save');
    await P(() => window.__paint.redo()); ok(await P(() => window.__paint.hist.isClean()), 'clean again after redo to save point');

    // ---- 1b. entries held on the GPU (undo/redo snapshot) vs read back at idle, mixed ----
    // swapParts() snapshots onto GPU canvases and reads them back about a second later; every mix of
    // the two states must stay pixel-exact, on multi-tile edits over semi-transparent noise.
    await P(() => {
      const p = window.__paint;
      p.newDoc(1000, 700);
      const c = p.base, g = c.getContext('2d'); // the pixels; #image shows them once repainted
      const im = g.createImageData(c.width, c.height);
      let s = 777; const rnd = () => ((s = Math.imul(s, 1103515245) + 12345 >>> 0) >>> 16) & 255;
      for (let i = 0; i < im.data.length; i += 4) { im.data[i] = rnd(); im.data[i + 1] = rnd(); im.data[i + 2] = rnd(); im.data[i + 3] = (i / 4) % 5 === 0 ? 0 : rnd(); }
      g.putImageData(im, 0, 0);
      p.markAll();
      p.hist.clear(); p.fitZoom(false); p.S.fillMode = 'both'; p.S.primary = 'rgba(0,0,0,1)';
    });
    await frame();
    const g1 = [await hash()];
    // A shape is two steps: the object (pixels unchanged), then flattening it (a multi-tile region).
    const flat = async () => { g1.push(await hash()); await P(() => window.__paint.flattenObjs()); await frame(); g1.push(await hash()); };
    await drag('rect', [[30, 40], [900, 650]]); await flat();
    await drag('ellipse', [[100, 100], [700, 500]]); await flat();
    await drag('select', [[300, 200], [800, 600]]); await page.keyboard.press('Delete'); await frame(); g1.push(await hash());
    const flush = () => P(() => window.__paint.flushToData());
    const pending = () => P(() => window.__paint.pendingParts);
    ok(await pending() > 0, 'fresh edits are held on the GPU until idle');
    await flush();
    ok(await pending() === 0, 'flushToData reads everything back');
    // states: 0 start, 1 rect object, 2 rect flattened, 3 ellipse object, 4 ellipse flattened, 5 deleted
    const seq = [['undo', 4, false], ['undo', 3, true], ['undo', 2, false], ['redo', 3, false], ['redo', 4, true], ['undo', 3, false], ['undo', 2, false],
      ['undo', 1, true], ['undo', 0, false], ['redo', 1, true], ['redo', 2, false], ['redo', 3, false], ['redo', 4, false], ['redo', 5, false], ['undo', 4, true], ['redo', 5, true]];
    for (const [f, want, fl] of seq) {
      await P((f) => window.__paint[f](), f); await frame();
      if (fl) await flush();
      ok(await hash() === g1[want], `GPU/CPU mix: ${f} to state ${want}${fl ? ' then read back' : ''} is pixel-exact`);
    }
    // the idle readback itself (no flush): wait for it, then undo
    await page.waitForTimeout(2500);
    ok(await pending() === 0, 'idle readback drains the GPU-held parts');
    await P(() => window.__paint.undo()); await frame();
    ok(await hash() === g1[4], 'undo after the idle readback is pixel-exact');
    // entries dropped while their readback is pending: freed, and nothing left to read
    await P(() => window.__paint.undo()); await frame();
    ok(await pending() > 0, 'undo leaves a pending readback');
    await P(() => window.__paint.newDoc(100, 100));
    ok(await pending() === 0, 'clearing history drops pending readbacks');
    await flush();
    await page.waitForTimeout(1500);
    ok(!errs.length, `no errors from pending readbacks of dropped entries: ${errs.join('; ')}`);

    // ---- 1c. undo data must not sit on the GPU indefinitely, and a lost GPU context drops it honestly ----
    const noise = () => P(() => {
      const p = window.__paint;
      p.newDoc(1000, 700);
      const c = p.base, g = c.getContext('2d'); // the pixels; #image shows them once repainted
      const im = g.createImageData(c.width, c.height);
      let s = 4242; const rnd = () => ((s = Math.imul(s, 1103515245) + 12345 >>> 0) >>> 16) & 255;
      for (let i = 0; i < im.data.length; i += 4) { im.data[i] = rnd(); im.data[i + 1] = rnd(); im.data[i + 2] = rnd(); im.data[i + 3] = (i / 4) % 5 === 0 ? 0 : rnd(); }
      g.putImageData(im, 0, 0);
      p.markAll();
      p.hist.clear(); p.fitZoom(false); p.S.fillMode = 'both'; p.S.primary = 'rgba(0,0,0,1)';
    });
    await noise(); await frame();
    const f0 = await hash();
    await drag('select', [[100, 100], [600, 500]]);
    await drag('select', [[300, 300], [450, 380]]); // lift and move: the op stays open under the float
    ok(await P(() => !!(window.__paint.op && window.__paint.sel && window.__paint.sel.float)), 'moved selection floats with its op open');
    ok(await pending() > 0, 'the open op\'s tiles are queued for readback');
    await page.waitForTimeout(2500);
    ok(await pending() === 0, 'idle readback drains an open op\'s tiles while the float stays up');
    await drag('select', [[950, 650], [960, 660]]); // commits the float
    const f1 = await hash();
    ok(f1 !== f0, 'the move changed the pixels');
    await P(() => window.__paint.undo()); await frame();
    ok(await hash() === f0, 'undo of a move read back while floating is pixel-exact');
    await P(() => window.__paint.redo()); await frame();
    ok(await hash() === f1, 'redo of a move read back while floating is pixel-exact');

    // committed before its queued readback ran: the tiles' canvases now belong to the entry
    await drag('select', [[520, 20], [560, 60]]); // inside one tile: a single-tile canvas
    await drag('select', [[530, 30], [580, 90]]);
    await drag('select', [[950, 650], [960, 660]]);
    const f2 = await hash();
    await flush();
    await P(() => window.__paint.undo()); await frame();
    ok(await hash() === f1, 'undo of a move committed before its readback is pixel-exact');
    await P(() => window.__paint.redo()); await frame();
    ok(await hash() === f2, 'redo of a move committed before its readback is pixel-exact');

    // context loss: B (on the GPU) is lost, so B and the older A go; C (a fill: CPU data) survives
    await noise(); await frame();
    await drag('rect', [[30, 40], [500, 400]]); await P(() => window.__paint.flattenObjs()); await flush(); // A: read back
    await drag('ellipse', [[200, 100], [900, 650]]); await P(() => window.__paint.flattenObjs()); // B: on the GPU
    const lb = await hash();
    await P(() => { window.__paint.S.primary = 'rgba(200,30,30,1)'; });
    await drag('fill', [[350, 250]]); // C, inside A and B
    ok(await pending() > 0, 'B is still on the GPU');
    await P(() => window.__paint.base.dispatchEvent(new Event('contextlost'))); // the base holds the pixels undo swaps
    await frame();
    ok(await P(() => window.__paint.hist.undoStack.length) === 1, 'context loss drops the lost step and those behind it');
    ok(await P(() => document.body.innerText.includes('undo steps were lost')), 'context loss is reported');
    ok(await pending() === 0, 'nothing left to read back after context loss');
    await P(() => window.__paint.undo()); await frame();
    ok(await hash() === lb, 'the surviving step still undoes pixel-exactly');
    ok(await P(() => !window.__paint.hist.canUndo()), 'nothing to undo past the lost step');
    // context loss with a float up and its op on the GPU: both are abandoned, no errors
    await drag('select', [[100, 100], [300, 300]]);
    await drag('select', [[150, 150], [400, 420]]);
    await P(() => window.__paint.base.dispatchEvent(new Event('contextlost')));
    await frame();
    ok(await P(() => !window.__paint.op && !window.__paint.sel), 'context loss abandons a float whose op was on the GPU');
    // #image is only a cache: when its context comes back (blank), the scene is repainted into it
    {
      const before = await hash();
      const n0 = await P(() => window.__paint.redrawCount);
      await P(() => { const c = document.querySelector('#image'); c.getContext('2d').clearRect(0, 0, c.width, c.height); c.dispatchEvent(new Event('contextrestored')); });
      await frame();
      ok(await P(() => window.__paint.redrawCount) > n0 && await hash() === before, 'a restored #image is repainted from the scene');
    }
    await page.waitForTimeout(1500);
    ok(!errs.length, `no errors after context loss: ${errs.join('; ')}`);

    // ---- 2. undo depth on a 4000 x 3000 photo ----
    await P(() => { window.__paint.newDoc(4000, 3000); window.__paint.fitZoom(false); });
    await P(() => { window.__paint.S.sizes.brush = 20; });
    const big = [];
    for (let i = 0; i < 20; i++) {
      const y = 100 + i * 140;
      await drag('brush', [[100, y], [1300, y + 900], [2600, y], [3900, y + 900]]);
      if (i % 5 === 4) big.push(await hash());
    }
    const kept = await P(() => window.__paint.hist.undoStack.length);
    ok(kept === 20, `20 wavy strokes on 4000x3000 all stay undoable, kept ${kept}`);
    await P(() => { for (let i = 0; i < 5; i++) window.__paint.undo(); }); await frame();
    ok(await hash() === big[2], '4000x3000: undo 5 strokes is pixel-exact');
    // a fill that changes nothing adds no history entry
    await P(() => { window.__paint.newDoc(200, 200); window.__paint.S.primary = '#ffffff'; window.__paint.S.tolerance = 0; window.__paint.setTool('fill'); });
    { const n = await P(() => window.__paint.hist.undoStack.length); const [x, y] = await at(50, 50); await page.mouse.click(x, y); await frame();
      ok(await P(() => window.__paint.hist.undoStack.length) === n, 'no-op fill adds no undo step'); }
    await P(() => { window.__paint.S.primary = '#000000'; });
    // ---- 3. one big scribble is one object: a small undo entry, and undo/redo are pixel-exact ----
    await P(() => { window.__paint.newDoc(8000, 6000); window.__paint.fitZoom(false); window.__paint.S.sizes.brush = 100; });
    const before = await hash();
    const zig = [];
    for (let r = 0; r <= 24; r++) zig.push([r % 2 ? 7900 : 100, r * 245 + 50]);
    await drag('brush', zig);
    const top = await P(() => { const e = window.__paint.hist.top(); return { type: e.type, n: e.pairs && e.pairs.length, bytes: e.bytes, t: e.pairs && e.pairs[0][0].t }; });
    ok(top.type === 'obj' && top.n === 1 && top.t === 'brush' && top.bytes < 1024, `the scribble is one brush object in a ${top.bytes}-byte entry (it covered most of 8000 × 6000)`);
    const after = await hash();
    await P(() => window.__paint.undo()); await frame();
    ok(await hash() === before, 'big scribble: undo is pixel-exact');
    await P(() => window.__paint.redo()); await frame();
    ok(await hash() === after, 'big scribble: redo is pixel-exact');
    if (errs.length) { fails++; console.log('FAIL: page errors', errs); }
  } finally {
    await browser.close();
  }
  console.log(`${passes} passed, ${fails} failed`);
  process.exit(fails ? 1 : 0);
})();
