// Is #image (the cache) still equal to __paint.freshRender() after a live stroke over anti-aliased objects?
const path = require('path');
const { launch } = require(path.resolve('test/e2e/browser.js'));
const url = process.argv[2] || 'http://localhost:8765/';
(async () => {
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('dialog', (d) => d.accept());
  await page.goto(url); await page.waitForTimeout(300); await page.evaluate(() => { window.NOISE = true; });
  const P = (f, a) => page.evaluate(f, a);
  const frame = () => P(() => new Promise((r) => requestAnimationFrame(() => r())));
  const at = async (ix, iy) => { const b = await page.locator('#overlay').boundingBox(); const W = await P(() => document.querySelector('#image').width); const z = b.width / W; return [b.x + (ix + 0.5) * z, b.y + (iy + 0.5) * z]; };
  async function drag(pts) { const [x0, y0] = await at(...pts[0]); await page.mouse.move(x0, y0); await page.mouse.down(); for (const p of pts.slice(1)) { const [x, y] = await at(...p); await page.mouse.move(x, y, { steps: 8 }); } await page.mouse.up(); await frame(); }
  const cmp = () => P(() => {
    const p = window.__paint, a = p.img, b = p.freshRender();
    const read = (c) => { const k = document.createElement('canvas'); k.width = c.width; k.height = c.height; k.getContext('2d').drawImage(c, 0, 0); return k.getContext('2d').getImageData(0, 0, c.width, c.height).data; };
    const x = read(a), y = read(b);
    let n = 0, worst = 0;
    for (let i = 0; i < x.length; i += 4) { let m = 0; for (let k = 0; k < 4; k++) m = Math.max(m, Math.abs(x[i + k] - y[i + k])); if (m) { n++; worst = Math.max(worst, m); } }
    return { pixels: n, worst };
  });
  for (const [label, tool2] of [['pencil over an ellipse', 'KeyP'], ['eraser over an ellipse', 'KeyE'], ['brush over an ellipse', 'KeyB'], ['pencil on its own', null]]) {
    await P(() => { const p = window.__paint; p.newDoc(300, 200); p.setZoom(2);
      if (window.NOISE) { const g = p.base.getContext('2d'), im = g.createImageData(300, 200); let s = 12345; const rnd = () => ((s = Math.imul(s, 1103515245) + 12345 >>> 0) >>> 16) & 255;
        for (let i = 0; i < im.data.length; i += 4) { im.data[i] = rnd(); im.data[i + 1] = rnd(); im.data[i + 2] = rnd(); im.data[i + 3] = (i / 4) % 7 === 0 ? 0 : rnd(); }
        g.putImageData(im, 0, 0); p.markAll(); } p.S.sizes.ellipse = 3; p.S.sizes.pencil = 6; p.S.sizes.eraser = 6; p.S.sizes.brush = 6; });
    await frame();
    if (tool2) { await page.keyboard.press('KeyO'); await drag([[40, 30], [220, 170]]); }
    await page.keyboard.press(tool2 || 'KeyP');
    await drag([[20, 100], [280, 110], [150, 20]]);
    const live = await cmp();
    await P(() => { window.__paint.markAll(); }); await frame();
    const after = await cmp();
    console.log(label.padEnd(24), 'cache vs fresh render, right after the stroke:', JSON.stringify(live), '| after a full repaint:', JSON.stringify(after));
  }
  await browser.close();
})();
