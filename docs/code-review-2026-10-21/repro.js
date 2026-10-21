// Code-review repros. Run from the repo root: node <this file> [url] [only]
// Each case runs in a fresh page and prints observed values; nothing here asserts.
const path = require('path');
const { launch } = require(path.resolve('test/e2e/browser.js'));
const url = process.argv[2] || 'http://localhost:8765/';
const only = process.argv[3];

// ROOT=<dist dir>: serve that build through Playwright's router (no server), as http://localhost:9999/.
const fs = require('fs');
const TYPES = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.map': 'application/json' };
async function newPage(browser) {
  if (!process.env.ROOT) return browser.newPage({ viewport: { width: 1280, height: 800 } });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
  await ctx.route('http://localhost:9999/**', (route) => {
    let f = new URL(route.request().url()).pathname.slice(1) || 'index.html';
    const file = path.join(process.env.ROOT, f);
    if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
    route.fulfill({ status: 200, body: fs.readFileSync(file), contentType: TYPES[path.extname(f)] || 'application/octet-stream' });
  });
  return ctx.newPage();
}
async function withPage(browser, fn) {
  const page = await newPage(browser);
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
  page.on('dialog', (d) => d.accept());
  await page.goto(url);
  await page.waitForTimeout(300);
  try { await fn(page); } finally { if (errs.length) console.log('  page errors:', errs); await page.context().close().catch(() => {}); await page.close().catch(() => {}); }
}
const P = (page, f, a) => page.evaluate(f, a);
const frame = (page) => P(page, () => new Promise((r) => requestAnimationFrame(() => r())));
async function at(page, ix, iy) {
  const b = await page.locator('#overlay').boundingBox();
  const W = await P(page, () => document.querySelector('#image').width);
  const z = b.width / W;
  return [b.x + (ix + 0.5) * z, b.y + (iy + 0.5) * z];
}
async function drag(page, pts) {
  const [x0, y0] = await at(page, ...pts[0]);
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  for (const p of pts.slice(1)) { const [x, y] = await at(page, ...p); await page.mouse.move(x, y, { steps: 6 }); }
  await page.mouse.up();
  await frame(page);
}
const seen = (page, x, y) => P(page, ([x, y]) => [...window.__paint.composite().getContext('2d').getImageData(x, y, 1, 1).data], [x, y]);
const snapshot = (page) => P(page, () => {
  const c = window.__paint.composite();
  return Array.from(c.getContext('2d').getImageData(0, 0, c.width, c.height).data);
});
function diff(a, b) {
  let n = 0, worst = 0;
  for (let i = 0; i < a.length; i += 4) {
    let m = 0;
    for (let k = 0; k < 4; k++) m = Math.max(m, Math.abs(a[i + k] - b[i + k]));
    if (m) { n++; worst = Math.max(worst, m); }
  }
  return { pixels: n, worst };
}

const CASES = {
  // A Resize (scale) still running when New replaces the document: does its result land on the new one?
  async resizeAfterNew(page) {
    const r = await P(page, async () => {
      const p = window.__paint;
      p.newDoc(5000, 5000);
      const run = p.resizeDoc(2500, 2500, 'scale', 'mc');
      p.newDoc(300, 300); // what the New dialog's submit does
      const right = { w: p.img.width, h: p.img.height };
      await run;
      await new Promise((r) => setTimeout(r, 50));
      return { afterNew: right, afterResize: { w: p.img.width, h: p.img.height }, undo: p.hist.undoStack.length, used: p.used.resize };
    });
    console.log('  ', JSON.stringify(r));
  },

  // The same with Open: a file loaded while the resize runs.
  async resizeAfterOpen(page) {
    const r = await P(page, async () => {
      const p = window.__paint;
      p.newDoc(5000, 5000);
      const run = p.resizeDoc(2500, 2500, 'scale', 'mc');
      const c = document.createElement('canvas'); c.width = 400; c.height = 300;
      const g = c.getContext('2d'); g.fillStyle = '#ff0000'; g.fillRect(0, 0, 400, 300);
      const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
      await p.loadFile(new File([blob], 'red.png', { type: 'image/png' }), null);
      const opened = { w: p.img.width, h: p.img.height, name: p.S.fileName };
      await run;
      await new Promise((r) => setTimeout(r, 50));
      const px = [...p.composite().getContext('2d').getImageData(10, 10, 1, 1).data];
      return { opened, afterResize: { w: p.img.width, h: p.img.height }, pixel: px, used: p.used.resize };
    });
    console.log('  ', JSON.stringify(r));
  },

  // ⌘E with the Move tool on a selected Transparent (clearing) stroke.
  async flattenClearStroke(page) {
    await P(page, () => { const p = window.__paint; p.newDoc(300, 200); p.setZoom(2); p.S.sizes.pencil = 20; });
    await frame(page);
    await page.keyboard.press('KeyP');
    await drag(page, [[40, 100], [260, 100]]); // black bar
    await page.click('#palette button.clear'); // colour 1 = Transparent
    await drag(page, [[150, 50], [150, 150]]); // a clearing stroke across the bar
    const before = await seen(page, 150, 100);
    await page.keyboard.press('KeyV');
    const [x, y] = await at(page, 150, 60);
    await page.mouse.click(x, y); // select the clearing stroke
    const sel = await P(page, () => window.__paint.selList().map((o) => [o.t, o.color]));
    await page.keyboard.press('Control+KeyE');
    await frame(page);
    const after = await seen(page, 150, 100);
    const objs = await P(page, () => window.__paint.userObjs.map((o) => o.t));
    console.log('   selected', JSON.stringify(sel), 'pixel (150,100) before ⌘E', before, 'after', after, 'objects', objs);
  },

  // ⌘E with the Move tool on an anti-aliased shape: does what is seen change?
  async flattenAA(page) {
    await P(page, () => { const p = window.__paint; p.newDoc(300, 200); p.setZoom(2); p.S.sizes.ellipse = 3; p.S.sizes.line = 3; });
    await frame(page);
    await page.keyboard.press('KeyO');
    await drag(page, [[40, 30], [200, 170]]);
    await page.keyboard.press('KeyL');
    await drag(page, [[20, 20], [280, 180]]);
    await page.keyboard.press('KeyV');
    const a = await snapshot(page);
    const [x, y] = await at(page, 40, 100); // the ellipse's left edge
    await page.mouse.click(x, y);
    const sel = await P(page, () => window.__paint.selList().map((o) => o.t));
    await page.keyboard.press('Control+KeyE');
    await frame(page);
    const b = await snapshot(page);
    console.log('   selected', JSON.stringify(sel), 'changed after ⌘E:', JSON.stringify(diff(a, b)));
    // and the whole-scene flatten, for comparison (it copies the cache instead of redrawing)
    await P(page, () => { const p = window.__paint; p.undo(); p.setTool('pencil'); p.flattenObjs(); });
    const c = await snapshot(page);
    console.log('   whole-scene ⌘E changed:', JSON.stringify(diff(a, c)));
  },

  // A save still writing when New replaces the document: whose file does the new one get?
  async saveThenNew(page) {
    const r = await P(page, async () => {
      const p = window.__paint;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const writes = [];
      const handle = (name) => ({
        name, kind: 'file',
        queryPermission: async () => 'granted', requestPermission: async () => 'granted',
        createWritable: async () => ({ write: async (b) => { await sleep(500); writes.push([name, b.size]); }, close: async () => {} }),
      });
      window.showSaveFilePicker = async () => handle('photo.png');
      p.newDoc(200, 100);
      p.S.pristine = false;
      const saving = p.save(true);
      await sleep(150); // the write is in flight
      p.newDoc(100, 100); // New (the dialog's submit)
      const afterNew = { handle: p.S.fileHandle && p.S.fileHandle.name, name: p.S.fileName };
      await saving;
      const afterSave = { handle: p.S.fileHandle && p.S.fileHandle.name, name: p.S.fileName, size: [p.img.width, p.img.height] };
      window.showSaveFilePicker = async () => { throw new Error('the picker should not open'); };
      await p.save(false); // plain ⌘S on the new document
      return { afterNew, afterSave, writes, title: document.title };
    });
    console.log('  ', JSON.stringify(r));
  },

  // The same with Open (loadFile) during the save.
  async saveThenOpen(page) {
    const r = await P(page, async () => {
      const p = window.__paint;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const writes = [];
      const handle = (name) => ({
        name, kind: 'file',
        queryPermission: async () => 'granted', requestPermission: async () => 'granted',
        createWritable: async () => ({ write: async (b) => { await sleep(500); writes.push([name, b.size]); }, close: async () => {} }),
      });
      window.showSaveFilePicker = async () => handle('first.png');
      p.newDoc(200, 100);
      const saving = p.save(true);
      await sleep(150);
      const c = document.createElement('canvas'); c.width = 64; c.height = 64;
      const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
      await p.loadFile(new File([blob], 'second.png', { type: 'image/png' }), handle('second.png'));
      const afterOpen = p.S.fileHandle.name;
      await saving;
      const afterSave = p.S.fileHandle.name;
      await p.save(false);
      return { afterOpen, afterSave, writes };
    });
    console.log('  ', JSON.stringify(r));
  },

  // Cut when the clipboard write fails: is the selection already gone?
  async cutFails(page) {
    await P(page, () => { const p = window.__paint; p.newDoc(300, 200); p.setZoom(2); });
    await frame(page);
    await page.keyboard.press('KeyR');
    await drag(page, [[20, 20], [100, 80]]);
    await page.keyboard.press('KeyV');
    const r = await P(page, async () => {
      const p = window.__paint;
      navigator.clipboard.write = async () => { throw Object.assign(new Error('denied'), { name: 'NotAllowedError' }); };
      const before = p.userObjs.length, sel = p.selList().length;
      document.querySelector('#overlay').focus();
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', code: 'KeyX', ctrlKey: true, bubbles: true }));
      await new Promise((r) => setTimeout(r, 300));
      return { selected: sel, before, after: p.userObjs.length, toast: document.querySelector('#toast').textContent };
    });
    console.log('  ', JSON.stringify(r));
  },

  // A keyboard-activated toolbar button keeps focus; a Move-tool box-select then leaves it there.
  async boxSelectFocus(page) {
    await P(page, () => { const p = window.__paint; p.newDoc(300, 200); p.setZoom(2); });
    await frame(page);
    await page.keyboard.press('KeyR');
    await drag(page, [[20, 20], [100, 80]]);
    await drag(page, [[150, 20], [250, 80]]);
    await P(page, () => document.querySelector('button[data-tool="move"]').focus());
    await page.keyboard.press('Enter'); // keyboard activation: focus stays on the button
    await drag(page, [[5, 5], [290, 190]]); // box-select both
    const r1 = await P(page, () => ({ sel: window.__paint.selList().length, focus: document.activeElement.dataset.tool || document.activeElement.tagName }));
    await page.keyboard.press('Delete');
    const left = await P(page, () => window.__paint.userObjs.length);
    // the same, but clicking an object instead of box-selecting
    await P(page, () => document.querySelector('button[data-tool="move"]').focus());
    await page.keyboard.press('Enter');
    const [x, y] = await at(page, 20, 50);
    await page.mouse.click(x, y);
    const r2 = await P(page, () => ({ sel: window.__paint.selList().length, focus: document.activeElement.dataset.tool || document.activeElement.tagName }));
    console.log('   box-select:', JSON.stringify(r1), 'objects left after Delete:', left, '| click-select:', JSON.stringify(r2));
  },
};

(async () => {
  const browser = await launch();
  try {
    for (const [name, fn] of Object.entries(CASES)) {
      if (only && !only.split(',').includes(name)) continue;
      console.log(name);
      try { await withPage(browser, fn); } catch (e) { console.log('   ERROR', e.message); }
    }
  } finally { await browser.close(); }
})();
