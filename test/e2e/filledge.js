// Fill next to anti-aliased edges e2e test (Playwright + installed Chrome). Dev-only, like smoke.js.
// usage: node filledge.js [url]   exit 0 = all pass
// Black brush strokes (several sizes and angles, one closed loop) on white, then a black fill
// outside and a red fill inside the loop at the default tolerance. Every pixel must end up a blend
// of black ink and the fill colour: no light fringe left along the stroke edges.
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
    const box = () => page.locator('#overlay').boundingBox();
    const at = async (ix, iy) => { // image px -> page px
      const b = await box(); const W = await P(() => document.querySelector('#image').width);
      const z = b.width / W; return [b.x + ix * z, b.y + iy * z];
    };
    async function stroke(size, pts) {
      await P((s) => { window.__paint.setTool('brush'); window.__paint.S.sizes.brush = s; }, size);
      const [x0, y0] = await at(...pts[0]);
      await page.mouse.move(x0, y0);
      await page.mouse.down();
      for (const p of pts.slice(1)) { const [x, y] = await at(...p); await page.mouse.move(x, y, { steps: 6 }); }
      await page.mouse.up();
      await frame();
    }
    async function fill(x, y, color) {
      await P((c) => { window.__paint.setTool('fill'); window.__paint.S.tolerance = 10; window.__paint.S.primary = c; }, color);
      const [px, py] = await at(x + 0.5, y + 0.5);
      await page.mouse.click(px, py);
      await frame();
    }
    // Pixels with a light (white) component left: neither channel 1 nor 2 of a black/red blend is set.
    const residue = () => P(() => {
      const c = document.querySelector('#image');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let n = 0, worst = 0;
      for (let i = 0; i < d.length; i += 4) { const m = Math.max(d[i + 1], d[i + 2]); if (m > 24) n++; if (m > worst) worst = m; }
      return { n, worst };
    });
    const arc = (cx, cy, r, a0, a1, k) => Array.from({ length: k + 1 }, (_, i) => {
      const a = a0 + (a1 - a0) * i / k; return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
    });

    await P(() => { const p = window.__paint; p.newDoc(640, 420); p.S.primary = '#000000'; p.S.smoothing = 2; p.fitZoom(false); });
    await frame();
    // Strokes that don't cross each other, so the outside is one region and the loop encloses one.
    await stroke(2, [[20, 20], [200, 30]]);
    await stroke(6, [[20, 60], [130, 170]]);
    await stroke(12, [[230, 20], [330, 30], [380, 90], [360, 160]]);
    await stroke(30, [[40, 260], [120, 300], [220, 380]]);
    await stroke(6, [[420, 30], [600, 80]]);
    await stroke(3, [[260, 220], [300, 250], [280, 300], [330, 340]]);
    await stroke(8, arc(500, 260, 90, -0.3, Math.PI * 2 + 0.3, 24));
    const before = await residue();
    ok(before.n > 1000, `strokes drawn (${before.n} non-black/red px before fills)`);

    await fill(2, 2, '#000000');
    await fill(500, 260, '#ff0000');
    const after = await residue();
    console.log(`fringe after fills: ${after.n} px (worst channel ${after.worst})`);
    ok(after.n === 0, `no light fringe left next to strokes after fills (${after.n} px, worst ${after.worst})`);
    if (process.argv[3]) { // usage: node filledge.js url shot.png  (the filled strokes at 300%)
      await P(() => window.__paint.setZoom(3)); await frame();
      await page.screenshot({ path: process.argv[3] });
      await P(() => window.__paint.fitZoom(false)); await frame();
    }

    // Undo/redo of the edge-aware fills is pixel-exact.
    const hash = () => P(() => {
      const c = document.querySelector('#image');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let h = 2166136261;
      for (let i = 0; i < d.length; i++) h = Math.imul(h ^ d[i], 16777619);
      return h >>> 0;
    });
    const h2 = await hash();
    await P(() => window.__paint.undo()); await frame();
    await P(() => window.__paint.undo()); await frame();
    const h0 = await hash();
    await P(() => window.__paint.redo()); await frame();
    await P(() => window.__paint.redo()); await frame();
    ok(await hash() === h2, 'redo of both fills restores the filled pixels exactly');
    await P(() => window.__paint.undo()); await frame();
    await P(() => window.__paint.undo()); await frame();
    ok(await hash() === h0, 'undo again restores the strokes exactly');

    // A stroke committed over many pointer moves equals its segments drawn as one path: no edge
    // pixel is inked twice where batches of segments meet.
    for (const size of [3, 8, 20]) {
      await P((s) => { const p = window.__paint; p.newDoc(400, 300); p.setTool('brush'); p.S.sizes.brush = s; p.S.primary = '#000000'; p.fitZoom(false); }, size);
      await frame();
      const pts = arc(200, 150, 100, 0, Math.PI * 1.5, 30);
      const [x0, y0] = await at(...pts[0]);
      await page.mouse.move(x0, y0);
      await page.mouse.down();
      for (const q of pts.slice(1)) { const [x, y] = await at(...q); await page.mouse.move(x, y, { steps: 3 }); }
      const diff = await P(() => {
        const segs = window.__paint.drag.all, s = window.__paint.drag.size;
        const im = document.querySelector('#image');
        const c = document.createElement('canvas'); c.width = im.width; c.height = im.height;
        const g = c.getContext('2d');
        g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
        g.lineWidth = s; g.lineCap = g.lineJoin = 'round'; g.beginPath();
        let end = null;
        for (const { a, c: q, b } of segs) {
          if (!end || end.x !== a.x || end.y !== a.y) g.moveTo(a.x, a.y);
          if (q) g.quadraticCurveTo(q.x, q.y, b.x, b.y); else g.lineTo(b.x, b.y);
          end = b;
        }
        g.stroke();
        const A = im.getContext('2d').getImageData(0, 0, c.width, c.height).data, B = g.getImageData(0, 0, c.width, c.height).data;
        let n = 0, max = 0;
        for (let i = 0; i < A.length; i++) { const d = Math.abs(A[i] - B[i]); if (d > 2) n++; if (d > max) max = d; }
        return { n, max, segs: segs.length };
      });
      await page.mouse.up();
      await frame();
      ok(diff.segs > 20 && diff.n === 0, `size ${size}: stroke over many moves = one path (${diff.segs} segments, ${diff.n} px differ, max ${diff.max})`);
    }

    ok(errs.length === 0, 'no page errors: ' + errs.join(' | '));
  } finally {
    await browser.close();
  }
  console.log(`${passes} passed, ${fails} failed`);
  process.exit(fails ? 1 : 0);
})();
