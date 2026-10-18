// Fill next to anti-aliased edges e2e test (Playwright + installed Chrome). Dev-only, like smoke.js.
// usage: node filledge.js [url]   exit 0 = all pass
// 1. Black brush strokes (several sizes and angles, one closed loop), an outline ellipse and text on
//    white, then a black fill outside and red fills inside the loop and the ellipse, at the default
//    tolerance. Every pixel must end up a blend of black ink and a fill colour: no light fringe.
// 2. A brush stroke committed over many pointer moves equals its segments drawn as one path, also
//    once a long stroke on a big image has had its undo tiles read back mid-stroke.
const { launch } = require('./browser.js');
const url = process.argv[2] || 'http://localhost:8765/';
let fails = 0, passes = 0;
const ok = (c, m) => { if (c) passes++; else { fails++; console.log('FAIL:', m); } };
(async () => {
  const browser = await launch();
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
      const where = [];
      for (let i = 0; i < d.length; i += 4) {
        const m = Math.max(d[i + 1], d[i + 2]);
        if (m > 24) { n++; if (where.length < 12) where.push(`(${i / 4 % c.width},${i / 4 / c.width | 0}) ${d.slice(i, i + 3).join('/')}`); }
        if (m > worst) worst = m;
      }
      return { n, worst, where: where.join(' ') };
    });
    const arc = (cx, cy, r, a0, a1, k) => Array.from({ length: k + 1 }, (_, i) => {
      const a = a0 + (a1 - a0) * i / k; return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
    });

    await P(() => { const p = window.__paint; p.newDoc(640, 620); p.S.primary = '#000000'; p.S.smoothing = 2; p.fitZoom(false); });
    await frame();
    // Strokes that don't cross each other, so the outside is one region and the loop encloses one.
    await stroke(2, [[20, 20], [200, 30]]);
    await stroke(6, [[20, 60], [130, 170]]);
    await stroke(12, [[230, 20], [330, 30], [380, 90], [360, 160]]);
    await stroke(30, [[40, 260], [120, 300], [220, 380]]);
    await stroke(6, [[420, 30], [600, 80]]);
    await stroke(3, [[260, 220], [300, 250], [280, 300], [330, 340]]);
    await stroke(8, arc(500, 260, 90, -0.3, Math.PI * 2 + 0.3, 24));
    // two strokes crossing at a shallow angle: narrow wedges of soft pixels near the crossing
    await stroke(6, [[180, 545], [620, 595]]);
    await stroke(4, [[180, 595], [620, 545]]);
    await P(() => { const p = window.__paint; p.setTool('ellipse'); p.S.fillMode = 'outline'; p.S.sizes.ellipse = 3; });
    { const [x, y] = await at(300, 410), [x2, y2] = await at(420, 500); await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x2, y2, { steps: 5 }); await page.mouse.up(); await frame(); }
    await P(() => window.__paint.flattenObjs()); // shapes are objects until flattened; the fill works on pixels
    // text with no enclosed counters (an 'o' would leave a white island no fill reaches)
    await P(() => { const p = window.__paint; p.setTool('text'); p.S.fontSize = 40; });
    { const [x, y] = await at(30, 430); await page.mouse.click(x, y); await page.keyboard.type('SMILE'); }
    await P(() => window.__paint.setTool('brush')); // commits the text
    await frame();
    const before = await residue();
    ok(before.n > 1000, `strokes drawn (${before.n} non-black/red px before fills)`);

    await fill(2, 2, '#000000');
    await fill(500, 260, '#ff0000');
    await fill(360, 455, '#ff0000');
    const after = await residue();
    console.log(`fringe after fills: ${after.n} px (worst channel ${after.worst})`);
    ok(after.n === 0, `no light fringe left next to strokes after fills (${after.n} px, worst ${after.worst}) ${after.where}`);
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
    // pixel is inked twice where batches of segments meet. With GPU canvases that is exact. Chrome's
    // CPU raster (e.g. CI without a GPU) shades a pixel's coverage differently when the path around
    // it differs, so redrawing part of a stroke there moves edge pixels both ways (on average ~1-4
    // levels darker), while inking them twice makes them ~20-35 levels darker on average. So: exact,
    // or less than 8 levels darker on average over the pixels that differ.
    for (const size of [3, 8, 20]) {
      await P((s) => { const p = window.__paint; p.newDoc(400, 300); p.setTool('brush'); p.S.sizes.brush = s; p.S.primary = '#000000'; p.fitZoom(false); }, size);
      await frame();
      const pts = arc(200, 150, 100, 0, Math.PI * 1.5, 30);
      const [x0, y0] = await at(...pts[0]);
      await page.mouse.move(x0, y0);
      await page.mouse.down();
      for (const q of pts.slice(1)) { const [x, y] = await at(...q); await page.mouse.move(x, y, { steps: 3 }); }
      const diff = await P(() => {
        const segs = window.__paint.drag.o.segs, s = window.__paint.drag.size;
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
        let n = 0, max = 0, dark = 0;
        for (let i = 0; i < A.length; i += 4) { const d = B[i] - A[i]; if (Math.abs(d) > 2) n++; if (Math.abs(d) > max) max = Math.abs(d); dark += d; }
        return { n, max, dark: n ? dark / n : 0, segs: segs.length };
      });
      await page.mouse.up();
      await frame();
      ok(diff.segs > 20 && (diff.n === 0 || diff.dark < 8), `size ${size}: stroke over many moves = one path (${diff.segs} segments, ${diff.n} px differ, max ${diff.max}, darker by ${diff.dark.toFixed(1)} on average)`);
      // the stroke is one object: moved away and back, its tiles repainted, it is the same pixels
      const h1 = await P(() => { const p = window.__paint; return [p.userObjs.length, p.userObjs[0] && p.userObjs[0].t, p.img.getContext('2d').getImageData(0, 0, 400, 300).data.join()]; });
      await P(() => { const p = window.__paint; p.setTool('move'); p.selectObj(p.userObjs[0].id); document.querySelector('#viewport').focus(); });
      for (const k of ['Shift+ArrowRight', 'Shift+ArrowDown', 'Shift+ArrowLeft', 'Shift+ArrowUp']) await page.keyboard.press(k);
      await frame();
      const h2 = await P(() => window.__paint.img.getContext('2d').getImageData(0, 0, 400, 300).data.join());
      ok(h1[0] === 1 && h1[1] === 'brush' && h2 === h1[2], `size ${size}: the stroke is one brush object, and moving it away and back repaints it exactly`);
    }

    // A long stroke over a big image: it is drawn live through the tile repaint, with no undo tiles,
    // and its last part still equals the stroke drawn as one path. Zigzag across a 6000 px image.
    {
      await P(() => { const p = window.__paint; p.newDoc(6000, 6000); p.setTool('brush'); p.S.sizes.brush = 30; p.S.primary = '#000000'; p.fitZoom(false); });
      await frame();
      const zig = [];
      for (let k = 0; k < 24; k++) zig.push([k % 2 ? 5900 : 100, 128 + k * 250], [k % 2 ? 100 : 5900, 128 + k * 250 + 120]);
      const [x0, y0] = await at(...zig[0]);
      await page.mouse.move(x0, y0);
      await page.mouse.down();
      for (const q of zig.slice(1)) { const [x, y] = await at(...q); await page.mouse.move(x, y, { steps: 12 }); }
      const r = await P(() => {
        const p = window.__paint, segs = p.drag.o.segs, s = p.drag.size;
        const noOp = !p.op;
        const lb = p.Core.segsBox(segs.slice(-40), s / 2 + 1); // the box around the last segments
        let x0 = lb.x, y0 = lb.y, x1 = lb.x + lb.w, y1 = lb.y + lb.h;
        x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
        const w = Math.min(6000, Math.ceil(x1)) - x0, h = Math.min(6000, Math.ceil(y1)) - y0;
        // the reference is as big as the image: a translated smaller canvas rasterises a few edge
        // pixels differently
        const c = document.createElement('canvas'); c.width = 6000; c.height = 6000;
        const g = c.getContext('2d');
        g.fillStyle = '#fff'; g.fillRect(0, 0, 6000, 6000);
        g.lineWidth = s; g.lineCap = g.lineJoin = 'round'; g.beginPath();
        let end = null;
        for (const { a, c: q, b } of segs) {
          if (!end || end.x !== a.x || end.y !== a.y) g.moveTo(a.x, a.y);
          if (q) g.quadraticCurveTo(q.x, q.y, b.x, b.y); else g.lineTo(b.x, b.y);
          end = b;
        }
        g.stroke();
        const A = p.img.getContext('2d').getImageData(x0, y0, w, h).data, B = g.getImageData(x0, y0, w, h).data;
        c.width = 0;
        let n = 0, max = 0, ink = 0, dark = 0;
        for (let i = 0; i < A.length; i += 4) { const d = B[i] - A[i]; if (Math.abs(d) > 2) n++; if (Math.abs(d) > max) max = Math.abs(d); dark += d; }
        for (let i = 0; i < A.length; i += 4) if (A[i] < 128) ink++;
        return { noOp, n, max, dark: n ? dark / n : 0, ink, segs: segs.length };
      });
      await page.mouse.up();
      await frame();
      ok(r.noOp, 'a long stroke keeps no undo tiles (it is an object)');
      ok(r.ink > 1000 && (r.n === 0 || r.dark < 8), `at the end of a long stroke, batches still equal one path (${r.segs} segments, ${r.n} px differ, max ${r.max}, darker by ${r.dark.toFixed(1)} on average, ${r.ink} ink px)`);
    }

    ok(errs.length === 0, 'no page errors: ' + errs.join(' | '));
  } finally {
    await browser.close();
  }
  console.log(`${passes} passed, ${fails} failed`);
  process.exit(fails ? 1 : 0);
})();
