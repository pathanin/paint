// Parity harness (Playwright + installed Chrome): replay one scripted session on two builds and
// compare what they show, pixel for pixel, after every step. Dev-only, like bench.js.
// usage: node parity.js <reference url> [candidate url] [--flatten-ref]   exit 0 = identical
//   reference: usually a build of master; candidate: this branch (default http://localhost:8765/).
//   --flatten-ref: flatten each shape on the reference as soon as it's drawn (⌘E), so both sides
//   stack marks in drawing order. Needed once new marks go on top of shapes (docs/total-objects.md).
// It compares decoded pixels (getImageData of what is seen), never file bytes: the PNG encoder and
// a private chunk change the bytes without changing the picture.
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
  ['fill inside ellipse', (s) => s.click('fill', { primary: '#99d9ea', tolerance: 10 }, [510, 330])],
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
  // What is seen: the composite's pixels, as a hash plus the raw bytes for a diff on mismatch.
  const shot = () => P(async () => {
    const p = window.__paint, c = p.composite(), g = c.getContext('2d');
    const d = g.getImageData(0, 0, c.width, c.height).data;
    const h = await crypto.subtle.digest('SHA-256', d);
    return { w: c.width, h: c.height, hash: [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join(''), b64: null };
  });
  const pixels = () => P(() => {
    const c = window.__paint.composite();
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let s = ''; for (let i = 0; i < d.length; i += 0x8000) s += String.fromCharCode.apply(null, d.subarray(i, i + 0x8000));
    return btoa(s);
  });
  return { page, s, shot, pixels, errs };
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome' });
  let fails = 0;
  try {
    const A = await session(browser, ref, flattenRef), B = await session(browser, cand, false);
    for (const [name, step] of STEPS) {
      await step(A.s); await step(B.s);
      const a = await A.shot(), b = await B.shot();
      if (a.w === b.w && a.h === b.h && a.hash === b.hash) { console.log('same  ', name); continue; }
      fails++;
      let msg = `${a.w}x${a.h} vs ${b.w}x${b.h}`;
      if (a.w === b.w && a.h === b.h) {
        const pa = Buffer.from(await A.pixels(), 'base64'), pb = Buffer.from(await B.pixels(), 'base64');
        let n = 0, worst = 0, first = null;
        for (let i = 0; i < pa.length; i += 4) {
          let d = 0;
          for (let k = 0; k < 4; k++) d = Math.max(d, Math.abs(pa[i + k] - pb[i + k]));
          if (d) { n++; worst = Math.max(worst, d); if (!first) first = [(i / 4) % a.w, Math.floor(i / 4 / a.w)]; }
        }
        msg = `${n} px differ, worst channel ${worst}, first at ${first}`;
      }
      console.log('FAIL: ', name, '-', msg);
    }
    for (const [k, X] of [['reference', A], ['candidate', B]]) if (X.errs.length) { fails++; console.log(`FAIL: page errors (${k}):`, X.errs); }
  } finally {
    await browser.close();
  }
  console.log(fails ? `${fails} step(s) differ` : `all ${STEPS.length} steps identical`);
  process.exit(fails ? 1 : 0);
})();
