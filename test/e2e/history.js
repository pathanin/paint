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
    const frame = () => P(() => new Promise((r) => requestAnimationFrame(() => r())));
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
      const c = document.querySelector('#image'), g = c.getContext('2d');
      const im = g.createImageData(c.width, c.height);
      let s = 12345; const rnd = () => ((s = Math.imul(s, 1103515245) + 12345 >>> 0) >>> 16) & 255;
      for (let i = 0; i < im.data.length; i += 4) { im.data[i] = rnd(); im.data[i + 1] = rnd(); im.data[i + 2] = rnd(); im.data[i + 3] = (i / 4) % 7 === 0 ? 0 : rnd(); }
      g.putImageData(im, 0, 0);
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
    await drag('rect', [[20, 120], [90, 190]]); await record('rect');
    await drag('ellipse', [[100, 20], [190, 90]], { button: 'right' }); await record('ellipse');
    await drag('line', [[5, 195], [295, 5]]); await record('line');
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
    if (errs.length) { fails++; console.log('FAIL: page errors', errs); }
  } finally {
    await browser.close();
  }
  console.log(`${passes} passed, ${fails} failed`);
  process.exit(fails ? 1 : 0);
})();
