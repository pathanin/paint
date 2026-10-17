// Parity harness (Playwright + installed Chrome): replay one scripted session on two builds and
// compare what they show, pixel for pixel, after every step. Dev-only, like bench.js.
// usage: node parity.js <reference url> [candidate url] [--flatten-ref]   exit 0 = identical
//   reference: usually a build of master; candidate: this branch (default http://localhost:8765/).
//   --flatten-ref: flatten each shape on the reference as soon as it's drawn (⌘E), so both sides
//   stack marks in drawing order. Needed once new marks go on top of shapes (docs/total-objects.md).
// It compares decoded pixels, never file bytes (the PNG encoder and a private chunk change the bytes
// without changing the picture). Before the switch (no --flatten-ref) the raster and the object
// records must be identical; what is seen must be identical or within anti-aliasing (see below).
const { chromium } = require('playwright');
const args = process.argv.slice(2);
const urls = args.filter((a) => !a.startsWith('--'));
const ref = urls[0], cand = urls[1] || 'http://localhost:8765/';
const flattenRef = args.includes('--flatten-ref');
if (!ref) { console.log('usage: node parity.js <reference url> [candidate url] [--flatten-ref]'); process.exit(2); }

// One step: [name, async (s) => {...}], where s holds helpers bound to the page.
const STEPS = [
  ['pencil 3 red', (s) => s.drag('pencil', { primary: '#ed1c24', size: 3 }, [[40, 40], [200, 120], [260, 60]])],
  ['brush 12 blue', (s) => s.drag('brush', { primary: '#3f48cc', size: 12 }, [[60, 200], [180, 260], [300, 180], [380, 260]])],
  ['rect both', (s) => s.drag('rect', { primary: '#000000', secondary: '#ffc90e', size: 3, fillMode: 'both' }, [[300, 60], [460, 160]])],
  ['eraser 12', (s) => s.drag('eraser', { secondary: '#ffffff', size: 12 }, [[100, 230], [340, 230]])],
  ['ellipse outline', (s) => s.drag('ellipse', { primary: '#22b14c', size: 5, fillMode: 'outline' }, [[420, 220], [600, 360]])],
  ['pencil over shapes', (s) => s.drag('pencil', { primary: '#a349a4', size: 4 }, [[320, 40], [640, 300]])],
  ['brush over shapes', (s) => s.drag('brush', { primary: '#ff7f27', size: 20 }, [[350, 120], [520, 300], [700, 200]])],
  // (A fill click inside a closed shape now sets that shape's fill, decision 5b: not master's behaviour.)
  ['fill between strokes', (s) => s.click('fill', { primary: '#99d9ea', tolerance: 10 }, [650, 60])],
  ['fill background', (s) => s.click('fill', { primary: '#efe4b0', tolerance: 10 }, [760, 560])],
  ['text', (s) => s.text([60, 420], 'Parity 1', { primary: '#000000', fontSize: 28 })],
  ['line', (s) => s.drag('line', { primary: '#880015', size: 2 }, [[20, 580], [780, 380]])],
  ['select + move', (s) => s.selectMove([40, 30, 220, 120], [60, 340])],
  ['select + delete', (s) => s.selectDelete([500, 400, 120, 80], '#b5e61d')],
  ['undo', (s) => s.cmd('undo')],
  ['redo', (s) => s.cmd('redo')],
  ['rotate right', (s) => s.cmd('rotR')],
  ['flip horizontal', (s) => s.cmd('flipH')],
  ['canvas size', (s) => s.cmd('canvas')],
  ['crop', (s) => s.cmd('crop')],
  ['open PNG with alpha', (s) => s.openAlpha()],
  ['fill over alpha', (s) => s.click('fill', { primary: '#ed1c24', tolerance: 10 }, [10, 10])],
  ['brush over alpha', (s) => s.drag('brush', { primary: '#000000', size: 9 }, [[5, 30], [60, 50], [110, 20]])],
  ['fill over alpha edge', (s) => s.click('fill', { primary: '#3f48cc', tolerance: 30 }, [100, 60])],
];

async function session(browser, url, flatten) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('dialog', (d) => d.accept());
  await page.goto(url);
  await page.waitForTimeout(300);
  const P = (f, a) => page.evaluate(f, a);
  const settle = () => P(async () => { await window.__paint.filling; await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); });
  await P(() => { window.__paint.newDoc(800, 600); window.__paint.setZoom(1); document.querySelector('#viewport').scrollTo(0, 0); });
  await settle();
  const at = async (ix, iy) => {
    const b = await page.locator('#overlay').boundingBox();
    const W = await P(() => window.__paint.img.width);
    const z = b.width / W;
    return [b.x + (ix + 0.5) * z, b.y + (iy + 0.5) * z];
  };
  const setup = (tool, o) => P(([tool, o]) => {
    const p = window.__paint;
    p.setTool(tool);
    if (o.primary) p.S.primary = o.primary;
    if (o.secondary) p.S.secondary = o.secondary;
    if (o.size) p.S.sizes[tool] = o.size;
    if (o.fillMode) p.S.fillMode = o.fillMode;
    if (o.tolerance != null) p.S.tolerance = o.tolerance;
    if (o.fontSize) p.S.fontSize = o.fontSize;
  }, [tool, o]);
  const s = {
    async drag(tool, o, pts) {
      await setup(tool, o);
      await page.mouse.move(...await at(...pts[0]));
      await page.mouse.down();
      for (const p of pts.slice(1)) await page.mouse.move(...await at(...p), { steps: 8 });
      await page.mouse.up();
      await settle();
      if (flatten && ['line', 'rect', 'ellipse'].includes(tool)) await P(() => window.__paint.flattenObjs());
    },
    async click(tool, o, p) {
      await setup(tool, o);
      await page.mouse.click(...await at(...p));
      await settle();
    },
    async text(p, str, o) {
      await setup('text', o);
      await page.mouse.click(...await at(...p));
      await page.keyboard.type(str);
      await page.keyboard.press('Enter');
      await settle();
    },
    async selectMove(r, to) {
      await setup('select', {});
      await page.mouse.move(...await at(r[0], r[1]));
      await page.mouse.down();
      await page.mouse.move(...await at(r[0] + r[2], r[1] + r[3]), { steps: 4 });
      await page.mouse.up();
      await page.mouse.move(...await at(r[0] + 10, r[1] + 10));
      await page.mouse.down();
      await page.mouse.move(...await at(to[0] + 10, to[1] + 10), { steps: 6 });
      await page.mouse.up();
      await P(() => window.__paint.selectAll()); // commits the float
      await P(() => window.__paint.setTool('pencil'));
      await settle();
    },
    async selectDelete(r, color2) {
      await setup('select', { secondary: color2 });
      await page.mouse.move(...await at(r[0], r[1]));
      await page.mouse.down();
      await page.mouse.move(...await at(r[0] + r[2], r[1] + r[3]), { steps: 4 });
      await page.mouse.up();
      await page.keyboard.press('Delete');
      await settle();
    },
    async cmd(c) {
      await P((c) => {
        const p = window.__paint;
        if (c === 'undo') p.undo();
        else if (c === 'redo') p.redo();
        else if (c === 'rotR' || c === 'flipH') p.transformDoc(c);
        else if (c === 'canvas') { p.S.secondary = '#c3c3c3'; p.resizeDoc(700, 820, 'canvas', 'c'); }
        else if (c === 'crop') { p.setTool('select'); p.selectAll(); p.sel.x = 30; p.sel.y = 40; p.sel.w = 500; p.sel.h = 600; p.crop(); }
      }, c);
      await settle();
    },
    async openAlpha() {
      // A 120 x 80 PNG: transparent, with a half-transparent band and an opaque disc.
      const b64 = await P(() => {
        const c = document.createElement('canvas'); c.width = 120; c.height = 80;
        const g = c.getContext('2d');
        g.fillStyle = 'rgba(0, 128, 255, 0.5)'; g.fillRect(0, 40, 120, 20);
        g.fillStyle = '#ff00ff'; g.beginPath(); g.arc(90, 40, 18, 0, Math.PI * 2); g.fill();
        return c.toDataURL('image/png').split(',')[1];
      });
      await page.setInputFiles('#fileInput', { name: 'alpha.png', mimeType: 'image/png', buffer: Buffer.from(b64, 'base64') });
      await page.waitForFunction(() => window.__paint.S.fileName === 'alpha.png');
      await P(() => { window.__paint.setZoom(4); document.querySelector('#viewport').scrollTo(0, 0); });
      await settle();
    },
  };
  // which: 'composite' (what is seen) or 'raster' (the pixels without objects: the base canvas where
  // there is one, else #image, which on builds before the scene cache held only pixels).
  const grab = (which) => P((which) => {
    const p = window.__paint, c = which === 'raster' ? (p.base || p.img) : p.composite();
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let s = ''; for (let i = 0; i < d.length; i += 0x8000) s += String.fromCharCode.apply(null, d.subarray(i, i + 0x8000));
    return { w: c.width, h: c.height, b64: btoa(s) };
  }, which);
  const records = () => P(() => JSON.stringify(window.__paint.userObjs.map(({ z, ...o }) => o)));
  s.page = page;
  return { page, s, grab, records, errs };
}

// Compare the change from pa to a with the change from pb to b (same sizes only), or null.
function changed(pa, a, pb, b) {
  if (!pa || !pb || pa.w !== a.w || pa.h !== a.h || pb.w !== b.w || pb.h !== b.h || a.w !== b.w || a.h !== b.h) return null;
  const A0 = Buffer.from(pa.b64, 'base64'), A1 = Buffer.from(a.b64, 'base64'), B0 = Buffer.from(pb.b64, 'base64'), B1 = Buffer.from(b.b64, 'base64');
  const moved = (x, y, i) => { for (let k = 0; k < 4; k++) if (Math.abs(x[i + k] - y[i + k]) > 32) return true; return false; };
  let union = 0, xor = 0;
  for (let i = 0; i < A1.length; i += 4) {
    const ma = moved(A0, A1, i), mb = moved(B0, B1, i);
    if (ma || mb) union++;
    if (ma !== mb) xor++;
  }
  return { bad: union > 0 && xor > 0.1 * union, msg: `${xor} of ${union} changed px differ` };
}
// null when equal, else {size, n, worst, msg}.
function diff(a, b) {
  if (a.w !== b.w || a.h !== b.h) return { size: true, msg: `${a.w}x${a.h} vs ${b.w}x${b.h}` };
  if (a.b64 === b.b64) return null;
  const pa = Buffer.from(a.b64, 'base64'), pb = Buffer.from(b.b64, 'base64');
  let n = 0, worst = 0, first = null, at = null, inkA = 0, inkB = 0;
  for (let i = 0; i < pa.length; i++) if ((i & 3) !== 3) { inkA += 255 - pa[i]; inkB += 255 - pb[i]; }
  for (let i = 0; i < pa.length; i += 4) {
    let d = 0;
    for (let k = 0; k < 4; k++) d = Math.max(d, Math.abs(pa[i + k] - pb[i + k]));
    if (d) {
      n++;
      if (!first) first = [(i / 4) % a.w, Math.floor(i / 4 / a.w)];
      if (d > worst) { worst = d; at = `${(i / 4) % a.w},${Math.floor(i / 4 / a.w)} (${[...pa.subarray(i, i + 4)]} vs ${[...pb.subarray(i, i + 4)]})`; }
    }
  }
  const ink = Math.abs(inkA - inkB) / Math.max(1, inkA);
  return { size: false, n, worst, ink, msg: `${n} px differ, ink ${(ink * 100).toFixed(2)}% apart, worst channel ${worst} at ${at}, first at ${first}` };
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome' });
  let fails = 0;
  try {
    const A = await session(browser, ref, flattenRef), B = await session(browser, cand, false);
    for (const [name, step] of STEPS) {
      await step(A.s); await step(B.s);
      if (process.env.FRESH) console.log('   cache vs fresh render:', await B.s.page.evaluate(() => { const p = window.__paint, A = p.composite().getContext('2d').getImageData(0, 0, p.img.width, p.img.height).data, F = p.freshRender().getContext('2d').getImageData(0, 0, p.img.width, p.img.height).data; let n = 0, w = 0, f = null; for (let i = 0; i < A.length; i++) { const d = Math.abs(A[i] - F[i]); if (d) { n++; if (d > w) { w = d; f = [(i >> 2) % p.img.width, (i >> 2) / p.img.width | 0]; } } } return n + ' differ, worst ' + w + ' at ' + f; }));
      const bad = [], notes = [];
      // Exact: the raster and the object records (before the switch: --flatten-ref is off).
      if (!flattenRef) {
        const ra = await A.grab('raster'), rb = await B.grab('raster');
        const d = diff(ra, rb);
        if (d) bad.push('raster ' + d.msg);
        if (await A.records() !== await B.records()) bad.push('object records differ');
      }
      // What is seen: equal, or within anti-aliasing. Chrome's GPU canvas anti-aliases a path differently
      // depending on what else is in its batch (task.md, Phase 0): once a batch switches to multisampling,
      // an edge pixel of a 5 px ellipse comes out 58 instead of 200. So a composite with path objects can't
      // match another build's bit for bit, nor within a fixed channel limit. Edges only, then: at most 1% of
      // the pixels differ, and the total ink agrees within 0.5%. A mark missing, doubled or a pixel off
      // fails both (a 1 px shift of one shape moves its whole outline).
      const ca = await A.grab('composite'), cb = await B.grab('composite');
      const d = diff(ca, cb);
      // What the step changed, on each side: the pixels that moved by more than 32 from the step before.
      // Anti-aliasing noise sits on the edges of marks both sides made; a mark one side lacks (or put
      // elsewhere) shows up as its whole area. So the two changes must agree on 90% of their union.
      const ch = changed(A.prev, ca, B.prev, cb);
      if (ch && ch.bad) bad.push(`what the step changed differs: ${ch.msg}`);
      A.prev = ca; B.prev = cb;
      if (d && (d.size || d.n > 0.01 * ca.w * ca.h || d.ink > 0.005)) bad.push('composite ' + d.msg);
      else if (d) notes.push('composite within anti-aliasing: ' + d.msg);
      if (bad.length) { fails++; console.log('FAIL: ', name, '-', bad.join('; ')); }
      else console.log(notes.length ? 'aa    ' : 'same  ', name, notes.length ? '- ' + notes.join('; ') : '');
    }
    for (const [k, X] of [['reference', A], ['candidate', B]]) if (X.errs.length) { fails++; console.log(`FAIL: page errors (${k}):`, X.errs); }
  } finally {
    await browser.close();
  }
  console.log(fails ? `${fails} step(s) differ` : `all ${STEPS.length} steps match`);
  process.exit(fails ? 1 : 0);
})();
