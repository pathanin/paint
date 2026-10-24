// Follow-ups: where finding 4's changed pixels are, and finding 2's pixels across the whole result.
const path = require('path');
const { launch } = require(path.resolve('test/e2e/browser.js'));
const url = process.argv[2] || 'http://localhost:8765/';
(async () => {
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('dialog', (d) => d.accept());
  await page.goto(url); await page.waitForTimeout(300);
  const P = (f, a) => page.evaluate(f, a);
  const frame = () => P(() => new Promise((r) => requestAnimationFrame(() => r())));
  const at = async (ix, iy) => { const b = await page.locator('#overlay').boundingBox(); const W = await P(() => document.querySelector('#image').width); const z = b.width / W; return [b.x + (ix + 0.5) * z, b.y + (iy + 0.5) * z]; };
  async function drag(pts) { const [x0, y0] = await at(...pts[0]); await page.mouse.move(x0, y0); await page.mouse.down(); for (const p of pts.slice(1)) { const [x, y] = await at(...p); await page.mouse.move(x, y, { steps: 6 }); } await page.mouse.up(); await frame(); }
  const snap = () => P(() => Array.from(window.__paint.composite().getContext('2d').getImageData(0, 0, 300, 200).data));
  // Changed pixels, split by what is near them: the line (within 4 px of its segment) or not.
  function where(a, b) {
    const seg = (x, y) => { const ax = 20, ay = 20, bx = 280, by = 180, dx = bx - ax, dy = by - ay; const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy))); return Math.hypot(x - ax - t * dx, y - ay - t * dy); };
    let nearLine = 0, elsewhere = 0, worstLine = 0, worstElse = 0;
    for (let i = 0; i < a.length; i += 4) {
      let m = 0; for (let k = 0; k < 4; k++) m = Math.max(m, Math.abs(a[i + k] - b[i + k]));
      if (!m) continue;
      const x = (i / 4) % 300, y = Math.floor(i / 4 / 300);
      if (seg(x + 0.5, y + 0.5) <= 4) { nearLine++; worstLine = Math.max(worstLine, m); } else { elsewhere++; worstElse = Math.max(worstElse, m); }
    }
    return { nearLine, worstLine, elsewhere, worstElse };
  }
  for (const withLine of [true, false]) {
    await P(() => { const p = window.__paint; p.newDoc(300, 200); p.setZoom(2); p.S.sizes.ellipse = 3; p.S.sizes.line = 3; });
    await frame();
    await page.keyboard.press('KeyO'); await drag([[40, 30], [200, 170]]);
    if (withLine) { await page.keyboard.press('KeyL'); await drag([[20, 20], [280, 180]]); }
    await page.keyboard.press('KeyV');
    const a = await snap();
    const [x, y] = await at(40, 100); await page.mouse.click(x, y);
    await page.keyboard.press('Control+KeyE'); await frame();
    const b = await snap();
    console.log(withLine ? 'ellipse + line, flatten the ellipse:' : 'ellipse alone, flatten it:        ', JSON.stringify(where(a, b)));
  }
  // Finding 2: the result's pixels across the whole 2500² image, after Open of a red 400x300 PNG mid-resize.
  const r = await P(async () => {
    const p = window.__paint;
    p.newDoc(5000, 5000);
    const run = p.resizeDoc(2500, 2500, 'scale', 'mc');
    const c = document.createElement('canvas'); c.width = 400; c.height = 300;
    const g = c.getContext('2d'); g.fillStyle = '#ff0000'; g.fillRect(0, 0, 400, 300);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    await p.loadFile(new File([blob], 'red.png', { type: 'image/png' }), null);
    await run;
    const im = p.composite(), d = im.getContext('2d').getImageData(0, 0, im.width, im.height).data;
    const counts = {};
    for (let i = 0; i < d.length; i += 4 * 97) { const k = d.slice(i, i + 4).join(','); counts[k] = (counts[k] || 0) + 1; }
    const top = Object.entries(counts).sort((p, q) => q[1] - p[1]).slice(0, 4);
    return { size: [im.width, im.height], name: p.S.fileName, sampledColours: top, corners: [[10, 10], [2490, 10], [10, 2490], [2490, 2490], [1250, 1250]].map(([x, y]) => [...im.getContext('2d').getImageData(x, y, 1, 1).data].join(',')) };
  });
  console.log('finding 2, whole result:', JSON.stringify(r));
  await browser.close();
})();
