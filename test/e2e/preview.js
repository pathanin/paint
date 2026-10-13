// Preview-layer e2e test (Playwright + installed Chrome). Dev-only, like smoke.js.
// usage: node preview.js [url]   exit 0 = all pass
// #preview only covers the visible part of the image, so check by screen pixels that floating
// selections, marching ants and shape previews show up where they should at several zooms and
// scroll positions, and that a new float always replaces the old one on screen.
const { chromium } = require('playwright');
const url = process.argv[2] || 'http://localhost:8765/';
let fails = 0, passes = 0;
const ok = (c, m) => { if (c) passes++; else { fails++; console.log('FAIL:', m); } };
(async () => {
  const browser = await chromium.launch({ channel: 'chrome' });
  try {
    for (const dpr of [1, 2]) {
      const page = await browser.newPage({ viewport: { width: 1000, height: 700 }, deviceScaleFactor: dpr });
      const errs = [];
      page.on('pageerror', (e) => errs.push(e.message));
      await page.goto(url);
      await page.waitForTimeout(300);
      const P = (f, a) => page.evaluate(f, a);
      const frame = () => P(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      // Screen colour at image pixel (ix, iy), or null when that pixel is scrolled out of view.
      async function colorAt(ix, iy) {
        await frame();
        const pt = await P(([ix, iy]) => {
          const r = document.querySelector('#image').getBoundingClientRect(), v = document.querySelector('#viewport');
          const vr = v.getBoundingClientRect(), z = window.__paint.S.zoom;
          const x = r.left + (ix + 0.5) * z, y = r.top + (iy + 0.5) * z;
          return x > vr.left && y > vr.top && x < vr.left + v.clientWidth && y < vr.top + v.clientHeight ? [x, y] : null;
        }, [ix, iy]);
        if (!pt) return null;
        const buf = await page.screenshot({ clip: { x: Math.floor(pt[0]), y: Math.floor(pt[1]), width: 1, height: 1 } });
        const px = await P(async (b64) => {
          const im = new Image(); im.src = 'data:image/png;base64,' + b64; await im.decode();
          const c = document.createElement('canvas'); c.width = im.width; c.height = im.height;
          const g = c.getContext('2d'); g.drawImage(im, 0, 0);
          return [...g.getImageData(0, 0, 1, 1).data.slice(0, 3)];
        }, buf.toString('base64'));
        return px[0] > 200 && px[1] < 60 && px[2] < 60 ? 'red' : px[2] > 200 && px[0] < 60 && px[1] < 60 ? 'blue'
          : px.every((v) => v > 230) ? 'white' : px.every((v) => v < 40) ? 'black' : px.join(',');
      }
      const square = (color, n) => P(([color, n]) => {
        const c = document.createElement('canvas'); c.width = c.height = n;
        const g = c.getContext('2d'); g.fillStyle = color; g.fillRect(0, 0, n, n);
        window.__paint.pasteImage(c);
      }, [color, n]);
      const tag = `dpr ${dpr}`;

      await P(() => { const p = window.__paint; p.newDoc(3000, 2000); p.S.pristine = false; p.fitZoom(false); });
      await square('red', 300);
      ok(await colorAt(150, 150) === 'red', `${tag}: float shows at fit zoom`);
      ok(await colorAt(1500, 1000) === 'white', `${tag}: nothing outside the float at fit zoom`);
      // a second same-size paste replaces the first one on screen
      await square('blue', 300);
      ok(await colorAt(150, 150) === 'blue', `${tag}: second same-size paste is drawn`);
      for (const z of [1, 4, 0.5]) {
        await P((z) => { window.__paint.setZoom(z); const v = document.querySelector('#viewport'); v.scrollLeft = v.scrollTop = 0; }, z);
        { const c = await colorAt(50, 50); ok(c === 'blue', `${tag}: float shows at ${z * 100}% (scrolled top-left), got ${c}`); }
      }
      // move the float far away, scroll to it: the preview follows the view
      await P(() => { window.__paint.setZoom(1); });
      await P(() => { const s = window.__paint.sel; s.x = 2600; s.y = 1600; });
      await P(() => { const v = document.querySelector('#viewport'); v.scrollLeft = v.scrollWidth; v.scrollTop = v.scrollHeight; });
      ok(await colorAt(2800, 1800) === 'blue', `${tag}: float shows after scrolling to the far corner`);
      ok(await colorAt(2550, 1800) === 'white', `${tag}: no float left at the old place`);
      await P(() => { const v = document.querySelector('#viewport'); v.scrollLeft = 0; v.scrollTop = 0; });
      { const c = await colorAt(150, 150); ok(c === 'red', `${tag}: back at top-left, only the committed first paste is there (no stale float), got ${c}`); }
      // commit, then a rectangle preview mid-drag at fit zoom
      await P(() => { window.__paint.setTool('rect'); window.__paint.S.sizes.rect = 40; window.__paint.S.fillMode = 'fill'; window.__paint.fitZoom(false); });
      const b = await page.locator('#overlay').boundingBox();
      const z = await P(() => window.__paint.S.zoom);
      await page.mouse.move(b.x + 1000 * z, b.y + 500 * z);
      await page.mouse.down();
      await page.mouse.move(b.x + 2000 * z, b.y + 1500 * z, { steps: 5 });
      ok(await colorAt(1500, 1000) === 'black', `${tag}: filled rect preview mid-drag`);
      await page.mouse.move(b.x + 1100 * z, b.y + 600 * z, { steps: 5 });
      ok(await colorAt(1500, 1000) === 'white', `${tag}: shrunk preview leaves nothing behind`);
      await page.mouse.up();
      ok(await colorAt(1050, 550) === 'black', `${tag}: rect committed to the image`);
      if (errs.length) { fails++; console.log('FAIL: page errors', errs); }
      await page.close();
    }
  } finally {
    await browser.close();
  }
  console.log(`${passes} passed, ${fails} failed`);
  process.exit(fails ? 1 : 0);
})();
