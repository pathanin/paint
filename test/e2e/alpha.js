// Transparent as a colour (option "Transparent" in the palette) e2e test. Dev-only, like smoke.js.
// The pixel tools clear with it, a lift / Delete / grown canvas leave transparency, shapes and text
// refuse it, and PNG keeps the alpha it makes.
// usage: node alpha.js [url]   exit 0 = all pass
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
    // What is seen: #image, the scene's cache (__paint.img finishes any pending repaint first).
    const hash = () => P(() => {
      const c = window.__paint.img;
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let h = 2166136261;
      for (let i = 0; i < d.length; i++) h = Math.imul(h ^ d[i], 16777619);
      return `${c.width}x${c.height}:${h >>> 0}`;
    });
    const at = async (ix, iy) => { // image px -> page px
      const b = await page.locator('#overlay').boundingBox(); const W = await P(() => document.querySelector('#image').width);
      const z = b.width / W; return [b.x + (ix + 0.5) * z, b.y + (iy + 0.5) * z];
    };
    async function drag(pts, button = 'left') {
      const [x0, y0] = await at(...pts[0]);
      await page.mouse.move(x0, y0);
      await page.mouse.down({ button });
      for (const p of pts.slice(1)) { const [x, y] = await at(...p); await page.mouse.move(x, y, { steps: 6 }); }
      await page.mouse.up({ button });
      await frame();
    }
    const pixel = (x, y) => P(([x, y]) => [...window.__paint.img.getContext('2d').getImageData(x, y, 1, 1).data], [x, y]);
    const alphaIn = (x, y, w, h) => P(([x, y, w, h]) => { // [min, max] alpha over a rect
      const d = window.__paint.img.getContext('2d').getImageData(x, y, w, h).data;
      let lo = 255, hi = 0;
      for (let i = 3; i < d.length; i += 4) { lo = Math.min(lo, d[i]); hi = Math.max(hi, d[i]); }
      return [lo, hi];
    }, [x, y, w, h]);
    const toast = () => page.locator('#toast').textContent();
    const fresh = async (w = 80, h = 60) => { await P(([w, h]) => { const p = window.__paint; p.newDoc(w, h); p.setZoom(4); }, [w, h]); await frame(); };
    const swatch = page.locator('#palette button[data-color="transparent"]');

    // ---- 1. the swatch sets colour 2 without breaking the well ----
    await fresh();
    ok(await swatch.count() === 1, 'the palette has a Transparent swatch');
    await swatch.click({ button: 'right' });
    let st = await P(() => ({ c2: window.__paint.S.secondary, c1: window.__paint.S.primary, v: document.querySelector('#secondary').value,
      cls: document.querySelector('#secondary').className, label: document.querySelector('#secondary').getAttribute('aria-label'),
      is2: document.querySelector('#palette button.clear').classList.contains('is2') }));
    ok(st.c2 === 'transparent' && st.c1 === '#000000', 'right-click sets colour 2 to transparent, colour 1 unchanged');
    ok(st.v === '#ffffff' && st.cls.includes('clear') && st.label === 'Color 2: Transparent', 'the colour input keeps a valid value and shows the transparent state');
    ok(st.is2, 'the swatch is marked as colour 2');
    // The well is drawn as a checkerboard, not black (Chrome would show black for an invalid value).
    const wellPx = await (async () => {
      const b = await page.locator('#secondary').boundingBox();
      const png = await page.screenshot({ clip: { x: b.x + b.width - 10, y: b.y + b.height - 10, width: 6, height: 6 } });
      return P(async (b64) => {
        const bmp = await createImageBitmap(await (await fetch('data:image/png;base64,' + b64)).blob());
        const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
        const g = c.getContext('2d'); g.drawImage(bmp, 0, 0);
        const d = g.getImageData(0, 0, c.width, c.height).data, seen = new Set();
        let dark = 0;
        for (let i = 0; i < d.length; i += 4) { seen.add(d[i] + ',' + d[i + 1] + ',' + d[i + 2]); if (d[i] + d[i + 1] + d[i + 2] < 150) dark++; }
        return { colours: seen.size, dark };
      }, png.toString('base64'));
    })();
    ok(wellPx.dark === 0 && wellPx.colours >= 2, `the colour 2 well shows a checkerboard (${JSON.stringify(wellPx)})`);

    // ---- 2. eraser clears; undo puts the pixels back exactly ----
    const white = await hash();
    await page.keyboard.press('KeyE');
    await drag([[10, 10], [60, 10]]);
    ok((await pixel(30, 10))[3] === 0, 'the eraser clears to transparent');
    ok((await pixel(30, 30))[3] === 255, 'pixels the eraser did not touch stay opaque');
    await page.keyboard.press('Meta+KeyZ');
    ok(await hash() === white, 'undo of an erase restores the pixels exactly');
    await page.keyboard.press('Meta+Shift+KeyZ');
    ok((await pixel(30, 10))[3] === 0, 'redo clears them again');

    // ---- 3. right-click pencil and brush erase with colour 2 ----
    await fresh();
    await page.keyboard.press('KeyP');
    await drag([[10, 20], [60, 20]], 'right');
    ok((await pixel(30, 20))[3] === 0 && (await pixel(30, 22))[3] === 255, 'right-click pencil clears exactly its pixels');
    await page.keyboard.press('KeyB');
    await drag([[10, 40], [60, 40]], 'right');
    const [lo, hi] = await alphaIn(20, 34, 30, 13);
    ok((await pixel(35, 40))[3] === 0, 'right-click brush clears the middle of its stroke');
    ok(lo === 0 && hi === 255, 'and fades out at its soft edge');
    let soft = await P(() => { // the brush's soft edge keeps the white it fades, never darkened
      const d = window.__paint.img.getContext('2d').getImageData(0, 30, 80, 20).data;
      for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 0 && d[i + 3] < 255 && (d[i] < 250 || d[i + 1] < 250 || d[i + 2] < 250)) return [...d.slice(i, i + 4)];
      return null;
    });
    ok(soft === null, `the brush's soft edge is white at partial alpha (${soft})`);

    // ---- 4. fill with transparent clears the region (and undo/redo, which take the slow path) ----
    await fresh();
    await P(() => { const p = window.__paint, g = p.base.getContext('2d'); g.fillStyle = '#000'; g.fillRect(40, 0, 2, 60); p.markAll(); }); // the picture's pixels (#image is a cache of the scene)
    const split = await hash();
    await page.keyboard.press('KeyF');
    const [fx, fy] = await at(10, 10);
    await page.mouse.click(fx, fy, { button: 'right' });
    await P(() => window.__paint.filling);
    ok((await pixel(10, 10))[3] === 0 && (await pixel(39, 59))[3] === 0, 'right-click fill clears the region');
    ok((await pixel(41, 10))[3] === 255 && (await pixel(60, 10))[3] === 255, 'the fill stops at the wall');
    await page.keyboard.press('Meta+KeyZ');
    ok(await hash() === split, 'undo of a transparent fill restores the pixels');
    await page.keyboard.press('Meta+Shift+KeyZ');
    ok((await pixel(10, 10))[3] === 0 && (await pixel(60, 10))[3] === 255, 'redo clears the region again');

    // ---- 5. Delete and a lift leave transparency ----
    await fresh();
    await page.keyboard.press('KeyS');
    await drag([[10, 10], [30, 30]]);
    await page.keyboard.press('Delete');
    ok((await pixel(15, 15))[3] === 0 && (await pixel(35, 35))[3] === 255, 'Delete clears the selection to transparent');
    await drag([[50, 10], [70, 30]]);
    await drag([[55, 15], [55, 45]]); // move it down: the hole it leaves
    await page.keyboard.press('Escape'); // deselect: the float is committed
    await frame();
    ok((await pixel(55, 12))[3] === 0, 'moving a selection leaves a transparent hole');
    ok((await pixel(55, 45))[3] === 255, 'the moved pixels are opaque where they land');

    // ---- 6. a grown canvas is transparent in its new area ----
    await fresh();
    await P(() => window.__paint.resizeDoc(100, 60, 'canvas', 'tl'));
    ok((await pixel(90, 30))[3] === 0 && (await pixel(10, 30))[3] === 255, 'Canvas size: the new area is transparent');
    await P(async () => { // a paste bigger than the image grows it the same way
      const p = window.__paint, c = document.createElement('canvas'); c.width = 20; c.height = 120;
      const g = c.getContext('2d'); g.fillStyle = '#f00'; g.fillRect(0, 0, 20, 120);
      p.pasteImage(await createImageBitmap(c));
    });
    await page.keyboard.press('Escape');
    await frame();
    ok(await P(() => window.__paint.img.height) === 120, 'the paste grew the canvas');
    ok((await pixel(90, 100))[3] === 0, 'a paste that grows the canvas leaves the new area transparent');

    // ---- 7. shapes and text refuse a transparent colour; a shape's fill in it is no fill ----
    await fresh();
    await page.keyboard.press('KeyR');
    await drag([[10, 10], [40, 40]], 'right');
    ok(await P(() => window.__paint.userObjs.length) === 0, 'right-click rectangle in transparent draws no object');
    ok((await toast()).includes('Transparent'), 'and says why');
    await page.locator('input[name=fillMode][value=both]').check({ force: true });
    await drag([[10, 10], [40, 40]]);
    let o = await P(() => window.__paint.userObjs.map(({ color, alt, mode }) => ({ color, alt, mode })));
    ok(o.length === 1 && o[0].alt === 'transparent' && o[0].mode === 'both', 'outline + fill with fill colour transparent makes a shape');
    const inside = await P(() => [...window.__paint.composite().getContext('2d').getImageData(25, 25, 1, 1).data]);
    ok(inside.join() === '255,255,255,255', 'its fill draws nothing: the pixels show through');
    await page.locator('input[name=fillMode][value=outline]').check({ force: true });
    await page.keyboard.press('KeyT');
    const [tx, ty] = await at(50, 50);
    await page.mouse.click(tx, ty, { button: 'right' });
    ok(await page.locator('#textInput').isHidden(), 'right-click text in transparent opens no text box');
    // colour 1 transparent: left-click swatch; the pencil erases, the selected shape keeps its line colour
    await page.keyboard.press('KeyV');
    const [ox, oy] = await at(10, 25); // on the rectangle's left edge
    await page.mouse.click(ox, oy);
    ok(await P(() => window.__paint.objSel) === await P(() => window.__paint.userObjs[0].id), 'the shape is selected for the restyle checks');
    await swatch.click();
    ok(await P(() => window.__paint.S.primary) === 'transparent', 'left-click sets colour 1 to transparent');
    ok(await P(() => window.__paint.userObjs[0].color) === '#000000', "a selected shape's line colour doesn't become transparent");
    await page.keyboard.press('KeyX');
    st = await P(() => [window.__paint.S.primary, window.__paint.S.secondary, document.querySelector('#primary').value]);
    ok(st[0] === 'transparent' && st[1] === 'transparent' && st[2] === '#000000', 'swap with both transparent keeps the wells valid');
    await page.locator('#palette button[data-color="#ed1c24"]').click({ button: 'right' }); // colour 2 red, colour 1 still transparent
    await page.keyboard.press('KeyX'); // colour 1 red, colour 2 transparent
    await page.keyboard.press('KeyX'); // back: colour 1 transparent; the shape's line must not follow
    o = await P(() => window.__paint.userObjs.map(({ color, alt }) => ({ color, alt })));
    ok(o[0].color !== 'transparent' && o[0].alt === '#ed1c24', `swap never makes a selected shape's line transparent (${JSON.stringify(o)})`);
    await page.locator('#palette button[data-color="#000000"]').click();
    st = await P(() => [window.__paint.S.primary, document.querySelector('#primary').className]);
    ok(st[0] === '#000000' && !st[1].includes('clear'), 'picking a colour leaves the transparent state');

    // ---- 8. the picker still ignores fully transparent pixels ----
    await fresh();
    await P(() => window.__paint.img.getContext('2d').clearRect(0, 0, 10, 10));
    await page.keyboard.press('KeyI');
    const [px, py] = await at(5, 5);
    await page.mouse.click(px, py);
    ok((await toast()).includes('transparent') && await P(() => window.__paint.S.primary) === '#000000', 'the picker picks nothing on a transparent pixel');

    // ---- 9. saving: PNG keeps the alpha, JPEG puts it on white ----
    await fresh();
    await swatch.click({ button: 'right' });
    await page.keyboard.press('KeyB');
    await drag([[10, 30], [60, 30]], 'right');
    const saved = await P(async () => {
      const p = window.__paint, before = p.img.getContext('2d').getImageData(0, 0, p.img.width, p.img.height).data;
      const out = {};
      for (const name of ['out.png', 'out.jpg']) {
        let blob = null;
        p.S.fileName = name;
        p.S.fileHandle = { name, queryPermission: async () => 'granted', requestPermission: async () => 'granted',
          createWritable: async () => ({ write: async (x) => { blob = x; }, close: async () => {} }) };
        await p.save(false);
        const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
        const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
        const g = c.getContext('2d'); g.drawImage(bmp, 0, 0);
        const d = g.getImageData(0, 0, c.width, c.height).data;
        let diff = 0, soft = 0;
        for (let i = 0; i < d.length; i++) if (Math.abs(d[i] - before[i]) > 1) diff++;
        for (let i = 3; i < before.length; i += 4) if (before[i] > 0 && before[i] < 255) soft++;
        out[name] = { diff, soft, mid: [...d.slice((30 * c.width + 35) * 4, (30 * c.width + 35) * 4 + 4)] };
      }
      return out;
    });
    ok(saved['out.png'].diff === 0 && saved['out.png'].soft > 0, `PNG round trip keeps every pixel, soft alpha included (${saved['out.png'].diff} differ)`);
    ok(saved['out.jpg'].mid[0] > 245 && saved['out.jpg'].mid[3] === 255, `JPEG puts the cleared pixels on white (${saved['out.jpg'].mid})`);

    // ---- 10. the brush tail while erasing is drawn (with the checkerboard), not invisible ----
    await fresh();
    await page.keyboard.press('KeyB');
    const [bx, by] = await at(10, 30);
    await page.mouse.move(bx, by);
    await page.mouse.down({ button: 'right' });
    const [ex, ey] = await at(50, 30);
    await page.mouse.move(ex, ey, { steps: 8 });
    await frame(); await frame();
    const tailInk = await P(() => {
      const pv = document.querySelector('#preview'), d = pv.getContext('2d').getImageData(0, 0, pv.width, pv.height).data;
      let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++;
      return n;
    });
    await page.mouse.up({ button: 'right' });
    ok(tailInk > 0, 'the live tail of an erasing brush stroke is drawn on the preview');

    // ---- 11. the wider palette (Transparent column) leaves every tool's options unclipped ----
    // Just above each breakpoint is the tightest spot; this runs in CI's fonts, not just macOS's.
    // Hints are left out: they ellipsize by design.
    for (const w of [600, 725, 785, 845, 961, 1280]) {
      await page.setViewportSize({ width: w, height: 700 }); await page.waitForTimeout(60);
      for (const t of ['KeyR', 'KeyB', 'KeyF', 'KeyT', 'KeyE', 'KeyI', 'KeyS', 'KeyV', 'KeyP', 'KeyL']) {
        await page.keyboard.press(t); await frame();
        const room = await P(() => {
          const o = document.querySelector('.opts').getBoundingClientRect(), bar = document.querySelector('#optbar').getBoundingClientRect();
          const opts = [...document.querySelectorAll('.opts > :not([hidden]):not(.hint)')].map((k) => o.right - k.getBoundingClientRect().right);
          return Math.min(bar.right - document.querySelector('.colors').getBoundingClientRect().right, ...opts);
        });
        ok(room >= 0, `${t.slice(3)} tool's options fit at ${w}px (${Math.round(room)} px spare)`);
      }
    }
    await page.setViewportSize({ width: 1280, height: 800 });

    // ---- 12. every mark is an object (docs/total-objects.md): a stroke in Transparent is one that clears ----
    await fresh();
    await P(() => { const p = window.__paint; p.S.fillMode = 'fill'; p.S.primary = '#ed1c24'; p.S.secondary = 'transparent'; p.S.sizes.rect = 2; p.S.sizes.pencil = 3; });
    await page.keyboard.press('KeyR'); await drag([[10, 10], [50, 40]]); // a red rectangle object
    await page.keyboard.press('KeyP'); await drag([[5, 25], [70, 25]], 'right'); // colour 2: Transparent
    const fr = () => P(() => { const h = (c) => { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let k = 2166136261; for (let i = 0; i < d.length; i++) k = Math.imul(k ^ d[i], 16777619); return k >>> 0; }; return h(window.__paint.img) === h(window.__paint.freshRender()); });
    let k12 = await P(() => window.__paint.userObjs.map((o) => o.t + ':' + o.color).join());
    ok(k12 === 'rect:#ed1c24,pencil:transparent' && (await pixel(30, 25))[3] === 0 && (await pixel(60, 25))[3] === 0 && (await pixel(30, 15)).join() === '237,28,36,255',
      'a pencil stroke in Transparent is an object that clears what is under it, objects included: ' + k12);
    ok(await fr(), 'the cache still equals the scene drawn fresh');
    await page.keyboard.press('KeyV'); await drag([[60, 25], [60, 35]]); // the stroke moves; so does the hole
    ok((await pixel(30, 25)).join() === '237,28,36,255' && (await pixel(30, 35))[3] === 0 && await fr(), 'moving the stroke moves the hole');
    // Fill in Transparent inside a shape: an outlined one loses its fill; inside a filled one it clears what is seen
    await fresh();
    await P(() => { const p = window.__paint; p.S.primary = '#000000'; p.S.secondary = '#ed1c24'; p.S.fillMode = 'both'; p.S.sizes.rect = 2; });
    await page.keyboard.press('KeyR'); await drag([[10, 10], [40, 40]]); // black outline, red fill
    await P(() => { window.__paint.S.fillMode = 'fill'; }); await drag([[50, 10], [75, 40]]); // all black
    await P(() => { const p = window.__paint; p.setTool('fill'); p.S.primary = 'transparent'; p.S.tolerance = 0; });
    await page.mouse.click(...await at(25, 25)); await P(() => window.__paint.filling); await frame();
    let m12 = await P(() => window.__paint.userObjs.map((o) => o.t + ':' + (o.mode || '')).join());
    ok(m12 === 'rect:outline,rect:fill' && (await pixel(25, 25)).join() === '255,255,255,255', 'Fill in Transparent inside an outlined shape removes its fill: ' + m12);
    await page.mouse.click(...await at(62, 25)); await P(() => window.__paint.filling); await frame();
    m12 = await P(() => window.__paint.userObjs.map((o) => o.t).join());
    ok(m12 === 'rect,rect,fill' && (await pixel(62, 25))[3] === 0, 'inside a filled shape it clears what is seen, as a fill object: ' + m12);
    // an existing text can still be edited while colour 1 is Transparent (it keeps its own colour)
    await fresh();
    await P(() => { window.__paint.S.primary = '#000000'; window.__paint.S.fontSize = 16; });
    await page.keyboard.press('KeyT'); await page.mouse.click(...await at(5, 30)); await page.keyboard.type('Hi'); await page.keyboard.press('Enter'); await frame();
    await P(() => { window.__paint.S.primary = 'transparent'; });
    await page.mouse.click(...await at(10, 36));
    ok(await P(() => !document.querySelector('#textInput').hidden && document.querySelector('#textInput').value === 'Hi'), 'a text can be edited again while colour 1 is Transparent');
    await page.keyboard.press('Escape');

    ok(errs.length === 0, 'no page errors: ' + errs.join(' | '));
  } finally {
    await browser.close();
  }
  console.log(`${passes} passed, ${fails} failed`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
