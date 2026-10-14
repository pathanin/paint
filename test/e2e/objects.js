// Live shapes (objects above the pixels, docs/objects.md) e2e test. Dev-only, like smoke.js.
// usage: node objects.js [url]   exit 0 = all pass
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
    const hash = () => P(() => {
      const c = document.querySelector('#image');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let h = 2166136261;
      for (let i = 0; i < d.length; i++) h = Math.imul(h ^ d[i], 16777619);
      return `${c.width}x${c.height}:${h >>> 0}`;
    });
    const at = async (ix, iy) => { // image px -> page px
      const b = await page.locator('#overlay').boundingBox(); const W = await P(() => document.querySelector('#image').width);
      const z = b.width / W; return [b.x + (ix + 0.5) * z, b.y + (iy + 0.5) * z];
    };
    async function drag(pts, mid) {
      const [x0, y0] = await at(...pts[0]);
      await page.mouse.move(x0, y0);
      await page.mouse.down();
      for (const p of pts.slice(1)) { const [x, y] = await at(...p); await page.mouse.move(x, y, { steps: 4 }); }
      if (mid) await mid();
      await page.mouse.up();
      await frame();
    }
    const objs = () => P(() => window.__paint.objs.map(({ id, t, a, b, color, size, mode }) => ({ id, t, a, b, color, size, mode })));
    const objSel = () => P(() => window.__paint.objSel);
    const depth = () => P(() => window.__paint.hist.undoStack.length);
    // RGBA of what is seen at an image px: the pixels with the objects drawn over them.
    const seen = (x, y) => P(([x, y]) => [...window.__paint.composite().getContext('2d').getImageData(x, y, 1, 1).data], [x, y]);
    const pixel = (x, y) => P(([x, y]) => [...document.querySelector('#image').getContext('2d').getImageData(x, y, 1, 1).data], [x, y]);
    const isBlack = (c) => c[0] < 60 && c[1] < 60 && c[2] < 60 && c[3] === 255;
    const isWhite = (c) => c[0] === 255 && c[1] === 255 && c[2] === 255;

    await P(() => { const p = window.__paint; p.newDoc(300, 200); p.setZoom(2); });
    await frame();
    const blank = await hash();

    // ---- Editable is off by default: a rectangle is pixels at once ----
    await page.keyboard.press('KeyR');
    ok(!(await page.locator('#liveShapes').isChecked()), 'Editable is off by default');
    await drag([[10, 10], [40, 30]]);
    ok((await objs()).length === 0 && isBlack(await pixel(10, 20)), 'with Editable off the rectangle is baked into the pixels');
    await page.keyboard.press('Meta+KeyZ');
    ok(await hash() === blank, 'undo removes it');

    // ---- 1. draw: an object, not pixels; selected, with handles ----
    await page.locator('#liveShapes').check();
    await frame();
    ok(await P(() => window.__paint.S.liveShapes), 'the Editable checkbox turns live shapes on');
    const d0 = await depth();
    await drag([[20, 20], [100, 80]]);
    let o = await objs();
    ok(o.length === 1 && o[0].t === 'rect' && o[0].a.x === 20 && o[0].b.x === 100 && o[0].b.y === 80, 'the rectangle became an object');
    ok(await hash() === blank, 'drawing an object leaves the pixels untouched');
    ok(isBlack(await seen(20, 50)) && isWhite(await seen(60, 50)), 'the composite shows the outline, hollow inside');
    ok(await objSel() === o[0].id, 'a new object is selected');
    ok(await page.locator('#objsel').isVisible() && await page.locator('#objsel .handle:not([hidden])').count() === 8, 'outline with 8 handles shown');
    ok(await depth() === d0 + 1 && await page.locator('#docDirty').isVisible(), 'one undo step; the document is unsaved');
    ok((await page.locator('#stSel').textContent()) === '80 × 60 px', 'the status bar shows the object size');
    // the preview canvas really draws it (not just the composite)
    const shot = await page.screenshot({ clip: await (async () => { const [x, y] = await at(20, 50); return { x: x - 1, y: y - 1, width: 2, height: 2 }; })() });
    ok(shot.length > 0, 'screenshot of the outline taken');

    // ---- 2. the shape tool edits the selected object: move by its body, resize by a handle ----
    await drag([[20, 35], [30, 40]]); // on the outline, clear of the west handle at (20, 50)
    o = await objs();
    ok(o.length === 1 && o[0].a.x === 30 && o[0].a.y === 25 && o[0].b.x === 110, 'dragging the outline with the rectangle tool moves it');
    ok(await hash() === blank, 'moving it leaves the pixels untouched');
    await drag([[110, 85], [130, 95]]);
    o = await objs();
    ok(o[0].a.x === 30 && o[0].b.x === 130 && o[0].b.y === 95, 'dragging the corner handle resizes it');
    const d1 = await depth();
    ok(d1 === d0 + 3, 'move and resize are one undo step each');
    await page.keyboard.press('Meta+KeyZ');
    o = await objs();
    ok(o[0].b.x === 110 && o[0].b.y === 85, 'undo reverts the resize');
    await page.keyboard.press('Meta+Shift+KeyZ');
    o = await objs();
    ok(o[0].b.x === 130, 'redo reapplies it');

    // ---- 3. Esc mid-drag cancels ----
    await drag([[30, 50], [60, 70]], () => page.keyboard.press('Escape'));
    o = await objs();
    ok(o[0].a.x === 30 && o[0].a.y === 25 && await depth() === d1, 'Esc mid-move puts it back, with no undo step');

    // ---- 4. select tool: click picks objects; empty canvas falls back to the marquee ----
    await page.keyboard.press('KeyS');
    await page.keyboard.press('Escape');
    await frame();
    ok(await objSel() === null && !(await page.locator('#objsel').isVisible()), 'Esc deselects the object');
    const [hx, hy] = await at(80, 60);
    await page.mouse.click(hx, hy);
    ok(await objSel() === null, 'clicking the hollow middle of an outline does not pick it');
    await page.mouse.click(...await at(30, 60));
    ok(await objSel() === o[0].id, 'clicking the outline with the select tool picks it');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Shift+ArrowDown');
    o = await objs();
    ok(o[0].a.x === 31 && o[0].a.y === 35, 'arrows nudge the object (⇧ = 10 px)');

    // ---- 5. restyle from the options bar and palette ----
    await page.locator('#palette button[data-color="#ed1c24"]').click();
    o = await objs();
    ok(o[0].color === '#ed1c24', 'a palette click recolours the selected object');
    await page.keyboard.press('Meta+KeyZ');
    ok((await objs())[0].color === '#000000', 'undo restores its colour');
    await page.keyboard.press('KeyR');
    ok(await objSel() === o[0].id, 'switching to a shape tool keeps the object selected');
    await page.locator('input[name=fillMode][value=fill]').check({ force: true });
    ok((await objs())[0].mode === 'fill', 'the Fill style applies to the selected object');
    ok(isBlack(await seen(80, 60)), 'it is filled now');

    // ---- 6. duplicate, reorder, delete ----
    await page.keyboard.press('Meta+KeyD');
    o = await objs();
    ok(o.length === 2 && o[1].a.x === o[0].a.x + 10 && await objSel() === o[1].id, '⌘D duplicates, offset by 10 px, and selects the copy');
    await page.keyboard.press('Meta+BracketLeft');
    const o2 = await objs();
    ok(o2[0].id === o[1].id && o2[1].id === o[0].id, '⌘[ sends it backward');
    await page.keyboard.press('Meta+BracketRight');
    ok((await objs())[1].id === o[1].id, '⌘] brings it forward again');
    await page.keyboard.press('Delete');
    ok((await objs()).length === 1 && await objSel() === null, 'Delete removes the selected object');

    // ---- 7. pixel tools paint under the objects ----
    await page.keyboard.press('KeyP');
    ok(await objSel() === null, 'a pixel tool drops the object selection');
    await drag([[5, 60], [200, 60]]);
    ok(!isWhite(await pixel(5, 60)) && (await objs()).length === 1, 'the pencil paints the pixels; the object stays'); // colour 1 is still the palette red
    await P(() => { window.__paint.S.primary = '#00a2e8'; });
    await page.keyboard.press('KeyI');
    await page.mouse.click(...await at(80, 70));
    ok(await P(() => window.__paint.S.primary) === '#000000', 'the picker samples what is seen (the filled object)');

    // ---- 8. flatten (⌘E): pixels + objects in one undo step ----
    const before = await hash();
    await page.keyboard.press('Meta+KeyE');
    ok((await objs()).length === 0 && isBlack(await pixel(80, 70)), '⌘E bakes the objects into the pixels');
    await page.keyboard.press('Meta+KeyZ');
    ok((await objs()).length === 1 && await hash() === before, 'one undo brings the object back and un-bakes its pixels');
    await page.keyboard.press('Meta+Shift+KeyZ');
    ok((await objs()).length === 0 && isBlack(await pixel(80, 70)), 'redo flattens again');
    await page.keyboard.press('Meta+KeyZ');

    // ---- 9. whole-image ops flatten first ----
    await P(() => window.__paint.transformDoc('rotR'));
    ok((await objs()).length === 0 && await P(() => document.querySelector('#image').width) === 200, 'rotate flattens, then rotates');
    await page.keyboard.press('Meta+KeyZ');
    await page.keyboard.press('Meta+KeyZ');
    ok((await objs()).length === 1 && await hash() === before, 'two undos: unrotated, then objects back');

    // ---- 10. a line object: two end handles ----
    await page.keyboard.press('KeyL');
    await drag([[150, 150], [250, 150]]);
    o = await objs();
    const line = o[o.length - 1];
    ok(line.t === 'line' && await page.locator('#objsel .handle:not([hidden])').count() === 2, 'a line object has two end handles');
    await drag([[250, 150], [260, 180]]);
    const l2 = (await objs()).find((x) => x.id === line.id);
    ok(l2.b.x === 260 && l2.b.y === 180 && l2.a.x === 150, 'dragging an end moves only that end');

    // ---- 11. another shape tool drops the selection, so setting it up can't restyle the last shape ----
    ok(await objSel() === line.id, 'the line is still selected in the line tool');
    await page.keyboard.press('KeyO');
    ok(await objSel() === null, 'switching to a different shape tool deselects it');
    await page.locator('#palette button[data-color="#22b14c"]').click();
    ok((await objs()).find((x) => x.id === line.id).color !== '#22b14c', 'so a colour picked for the next shape leaves it alone');

    // ---- 12. new document clears objects ----
    await P(() => window.__paint.newDoc(100, 100));
    ok((await objs()).length === 0 && await objSel() === null, 'New clears the objects');

    ok(errs.length === 0, 'no page errors: ' + errs.join(' | '));
  } catch (e) {
    fails++; console.log('FAIL: threw', e);
  } finally {
    await browser.close();
    console.log(`${passes} passed, ${fails} failed`);
    process.exit(fails ? 1 : 0);
  }
})();
