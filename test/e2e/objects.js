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
    const hash = () => P(() => { // the pixels (the base), without the objects
      const c = window.__paint.base;
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
    const objs = () => P(() => window.__paint.objs.map(({ id, t, a, b, color, alt, size, mode }) => ({ id, t, a, b, color, alt, size, mode })));
    const objSel = () => P(() => window.__paint.objSel);
    const depth = () => P(() => window.__paint.hist.undoStack.length);
    // RGBA of what is seen at an image px: the pixels with the objects drawn over them.
    const seen = (x, y) => P(([x, y]) => [...window.__paint.composite().getContext('2d').getImageData(x, y, 1, 1).data], [x, y]);
    const pixel = (x, y) => P(([x, y]) => [...window.__paint.base.getContext('2d').getImageData(x, y, 1, 1).data], [x, y]);
    const isBlack = (c) => c[0] < 60 && c[1] < 60 && c[2] < 60 && c[3] === 255;
    const isWhite = (c) => c[0] === 255 && c[1] === 255 && c[2] === 255;

    await P(() => { const p = window.__paint; p.newDoc(300, 200); p.setZoom(2); });
    await frame();
    const blank = await hash();

    // ---- 1. draw: an object, not pixels; selected, with handles ----
    await page.keyboard.press('KeyR');
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

    // ---- 4. move tool (V): click picks objects, empty canvas pans; the select tool is pixels only ----
    await page.keyboard.press('KeyS');
    await frame();
    ok(await objSel() === null && !(await page.locator('#objsel').isVisible()), 'the select tool drops the object selection');
    await drag([[25, 40], [60, 70]]);
    ok(await objSel() === null && await P(() => !!window.__paint.sel && window.__paint.sel.w > 30) && (await objs())[0].a.x === 30, 'a marquee starts on top of a shape with the select tool; the shape stays put');
    await page.keyboard.press('Escape');
    await page.keyboard.press('KeyV');
    ok(await P(() => window.__paint.S.tool) === 'move' && await P(() => !window.__paint.sel), 'V picks the move tool (and drops the pixel selection)');
    await page.mouse.click(...await at(80, 60));
    ok(await objSel() === null, 'clicking the hollow middle of an outline does not pick it');
    await page.mouse.click(...await at(30, 60));
    ok(await objSel() === o[0].id, 'clicking the outline with the move tool picks it');
    await page.keyboard.press('Escape');
    await frame();
    ok(await objSel() === null && !(await page.locator('#objsel').isVisible()), 'Esc deselects the object');
    await page.mouse.click(...await at(30, 60));
    const before4 = await depth();
    await P(() => window.__paint.setZoom(8)); await frame();
    const sc0 = await P(() => [document.querySelector('#viewport').scrollLeft, document.querySelector('#viewport').scrollTop]);
    const [px0, py0] = [400, 500];
    await page.mouse.move(px0, py0); await page.mouse.down(); await page.mouse.move(px0 - 120, py0 - 80, { steps: 4 }); await page.mouse.up();
    const sc1 = await P(() => [document.querySelector('#viewport').scrollLeft, document.querySelector('#viewport').scrollTop]);
    ok(sc1[0] - sc0[0] === 120 && sc1[1] - sc0[1] === 80, 'dragging empty canvas with the move tool pans: ' + JSON.stringify([sc0, sc1]));
    ok(await objSel() === null && await depth() === before4 && (await objs())[0].a.x === 30, 'panning deselects and changes nothing');
    await P(() => window.__paint.setZoom(2)); await frame();
    await page.mouse.click(...await at(30, 60));
    ok(await objSel() === o[0].id, 'picked again');
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

    // ---- 7. strokes are objects too, and new marks go on top (docs/total-objects.md, decision 10) ----
    await page.keyboard.press('KeyP');
    ok(await objSel() === null, 'a pixel tool drops the object selection');
    await drag([[5, 60], [200, 60]]);
    { const ob = await objs(), at60 = await P(() => [...window.__paint.composite().getContext('2d').getImageData(85, 60, 1, 1).data]), red = await P(() => window.__paint.S.primary);
      ok(isWhite(await pixel(5, 60)) && !isWhite(await seen(5, 60)) && ob.length === 2 && ob[1].t === 'pencil' && ob[1].color === red,
        'the pencil makes a stroke object on top; the pixels underneath are untouched'); // colour 1 is still the palette red
      ok(!isBlack(at60) || red === '#000000', 'the stroke shows over the filled shape it crosses: ' + at60); }
    await P(() => { window.__paint.S.primary = '#00a2e8'; });
    await page.keyboard.press('KeyI');
    await page.mouse.click(...await at(80, 70));
    ok(await P(() => window.__paint.S.primary) === '#000000', 'the picker samples what is seen (the filled object)');

    // ---- 8. flatten (⌘E): pixels + objects in one undo step ----
    const before = await hash();
    await page.keyboard.press('Meta+KeyE');
    ok((await objs()).length === 0 && isBlack(await pixel(80, 70)), '⌘E bakes the objects into the pixels');
    await page.keyboard.press('Meta+KeyZ');
    ok((await objs()).length === 2 && await hash() === before, 'one undo brings the objects back and un-bakes their pixels');
    await page.keyboard.press('Meta+Shift+KeyZ');
    ok((await objs()).length === 0 && isBlack(await pixel(80, 70)), 'redo flattens again');
    await page.keyboard.press('Meta+KeyZ');

    // ---- 9. whole-image ops carry the objects along: still objects, one undo step ----
    const chash = () => P(() => {
      const c = window.__paint.composite(), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let h = 2166136261;
      for (let i = 0; i < d.length; i++) h = Math.imul(h ^ d[i], 16777619);
      return `${c.width}x${c.height}:${h >>> 0}`;
    });
    // add an odd-width line and an even-width ellipse, so both pixel grids are covered
    await P(() => { const p = window.__paint; p.S.sizes.line = 3; p.S.sizes.ellipse = 4; });
    await page.keyboard.press('KeyL'); await drag([[150, 30], [250, 90]]);
    await page.keyboard.press('KeyO'); await drag([[160, 110], [270, 180]]);
    await page.keyboard.press('Escape');
    const o9 = await objs(), seen9 = await chash(), pix9 = await hash();
    for (const k of ['rotR', 'rotL', 'flipH', 'flipV']) {
      await page.keyboard.press('Meta+KeyE');
      await P((k) => { window.__paint.transformDoc(k); const c = window.__paint.composite(); window.__ref = c.getContext('2d').getImageData(0, 0, c.width, c.height); }, k);
      await page.keyboard.press('Meta+KeyZ'); await page.keyboard.press('Meta+KeyZ');
      const dk = await depth();
      await P((k) => window.__paint.transformDoc(k), k);
      ok((await objs()).length === 4 && await depth() === dk + 1, k + ' keeps the shapes and the stroke as objects, in one undo step');
      // What is seen vs flatten-then-transform. Not bit-exact: Chrome anti-aliases a shape's edge a
      // little differently when it is drawn turned than when its pixels are turned (up to ~110 on a
      // few edge pixels of the ellipse). A shape one pixel off would differ by 255 along the filled
      // rectangle's crisp edges, so: no value differs by half the range, and the ink agrees.
      const diff = await P(() => {
        const c = window.__paint.composite(), A = window.__ref, B = c.getContext('2d').getImageData(0, 0, c.width, c.height);
        if (A.width !== B.width || A.height !== B.height) return { size: false };
        let mx = 0, inkA = 0, inkB = 0;
        for (let i = 0; i < A.data.length; i++) {
          mx = Math.max(mx, Math.abs(A.data[i] - B.data[i]));
          if ((i & 3) === 0) { inkA += 255 - A.data[i]; inkB += 255 - B.data[i]; }
        }
        return { size: true, mx, ink: Math.abs(inkA - inkB) / inkA };
      });
      ok(diff.size && diff.mx < 128 && diff.ink < 0.005, k + ': what is seen matches flatten-then-' + k + ' (same place, edges within anti-aliasing): ' + JSON.stringify(diff));
      await page.keyboard.press('Meta+KeyZ');
      ok(JSON.stringify(await objs()) === JSON.stringify(o9) && await hash() === pix9 && await chash() === seen9, 'undo puts the image and the shapes back');
    }
    await P(() => window.__paint.resizeDoc(400, 300, 'canvas', 'c'));
    ok(JSON.stringify((await objs()).filter((x) => x.a).map((x) => x.a)) === JSON.stringify(o9.filter((x) => x.a).map((x) => ({ x: x.a.x + 50, y: x.a.y + 50 }))) && await P(() => window.__paint.objs[1].pts[0]) === 55, 'canvas size (centred) shifts the shapes and the stroke with the pixels');
    await page.keyboard.press('Meta+KeyZ');
    await P(() => window.__paint.resizeDoc(150, 100, 'scale'));
    await P(() => new Promise((r) => { const t = () => (window.__paint.img.width === 150 ? r() : setTimeout(t, 50)); t(); }));
    o = (await objs()).filter((x) => x.a); // the shapes (the pencil stroke is checked by its own kind)
    ok(o.length === 3 && o[0].a.x === 15 && o[0].size === 1 && o[2].size === 2, 'resize scales the shapes and their strokes (a 2 px edge at 31 is a 1 px one centred on 15.5): ' + JSON.stringify(o.map((x) => [x.a, x.size])));
    await page.keyboard.press('Meta+KeyZ');
    ok(JSON.stringify(await objs()) === JSON.stringify(o9), 'undo restores them');
    await page.keyboard.press('KeyS');
    await drag([[140, 20], [299, 199]]);
    await P(() => window.__paint.crop && document.querySelector('#cropBtn').click());
    o = (await objs()).filter((x) => x.a);
    ok(await P(() => window.__paint.img.width) === 159 && o.length === 2 && o.every((x) => x.t !== 'rect') && o[0].a.x === 9 && o[0].a.y === 9 &&
      await P(() => window.__paint.objs[0].t === 'pencil' && window.__paint.objs[0].pts[0] === -136), 'crop (from 141, 21) shifts the shapes and the stroke that crosses it, and drops one left wholly outside: ' + JSON.stringify(o.map((x) => [x.t, x.a])));
    await page.keyboard.press('Meta+KeyZ');
    ok(JSON.stringify(await objs()) === JSON.stringify(o9) && await hash() === pix9, 'one undo brings the crop and the dropped shape back');
    // leave the rest of the run as it was: just the filled rectangle
    await page.keyboard.press('Meta+KeyZ'); await page.keyboard.press('Meta+KeyZ');
    await P(() => { const p = window.__paint; p.S.sizes.line = 2; p.S.sizes.ellipse = 2; });
    ok((await objs()).length === 2 && await hash() === before, 'back to one shape and the stroke');

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

    // ---- 12. streams of edits are one undo step, so they can't push pixel history out ----
    await page.keyboard.press('KeyP');
    await drag([[5, 190], [100, 190]]);
    const strokeAt = await depth();
    await page.keyboard.press('KeyV');
    await page.mouse.click(...await at(150, 150));
    ok(await objSel() === line.id, 'the line is picked again');
    for (let i = 0; i < 150; i++) await page.keyboard.press('ArrowRight');
    ok(await depth() === strokeAt + 1 && (await objs()).find((x) => x.id === line.id).a.x === 300, '150 arrow presses are one undo step');
    await P(() => { const w = document.querySelector('#primary'); for (const c of ['#111111', '#222222', '#333333']) { w.value = c; w.dispatchEvent(new Event('input', { bubbles: true })); } });
    ok(await depth() === strokeAt + 2 && (await objs()).find((x) => x.id === line.id).color === '#333333', 'a colour well drag (many input events) is one more step');
    await page.keyboard.press('KeyX');
    const sw = (await objs()).find((x) => x.id === line.id);
    ok(await depth() === strokeAt + 3 && sw.color === '#ffffff' && sw.alt === '#333333', 'X swaps both colours of the object in one step');
    await page.keyboard.press('Meta+KeyZ'); await page.keyboard.press('Meta+KeyZ'); await page.keyboard.press('Meta+KeyZ');
    ok((await objs()).find((x) => x.id === line.id).a.x === 150, 'three undos undo swap, recolour and the whole nudge');
    await page.keyboard.press('Meta+KeyZ');
    ok(isWhite(await pixel(50, 190)), 'and the pencil stroke before them is still undoable');
    // a nudge right after a save is a new step: the save point must not move with it
    await P(() => window.__paint.hist.markSaved(window.__paint.hist.top()));
    await page.keyboard.press('ArrowRight');
    ok(await page.locator('#docDirty').isVisible(), 'a nudge after saving marks the document unsaved');

    // ---- 13. with nothing to act on, ⌘D ⌘E ⌘[ ⌘] stay the browser's ----
    await page.keyboard.press('Escape');
    const prevented = (key) => P((key) => { const e = new KeyboardEvent('keydown', { key, metaKey: true, ctrlKey: true, bubbles: true, cancelable: true }); document.body.dispatchEvent(e); return e.defaultPrevented; }, key);
    ok(!(await prevented('d')) && !(await prevented('[')) && !(await prevented(']')), '⌘D, ⌘[ and ⌘] pass through with no object selected');
    await P(() => window.__paint.newDoc(100, 100));
    ok(!(await prevented('e')), '⌘E passes through with no objects');

    // ---- 14. new document clears objects ----
    await P(() => window.__paint.newDoc(100, 100));
    ok((await objs()).length === 0 && await objSel() === null, 'New clears the objects');

    // ---- 15. a click doesn't move: a shape moves only once the pointer has gone 3 screen px ----
    await P(() => { const p = window.__paint; p.newDoc(2000, 1500); p.setZoom(0.25); });
    await page.keyboard.press('KeyR');
    await drag([[200, 200], [1000, 800]]);
    await page.keyboard.press('KeyV');
    await page.keyboard.press('Escape');
    const dj = await depth();
    { const [x, y] = await at(200, 500); await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 1, y + 1); await page.mouse.up(); await frame(); }
    o = await objs();
    ok(o[0].a.x === 200 && o[0].a.y === 200 && await depth() === dj && await objSel() === o[0].id, 'at 25% a 1 px wobble while clicking selects the shape and leaves it put: ' + JSON.stringify(o[0].a));
    await drag([[200, 500], [240, 500]]);
    ok((await objs())[0].a.x === 240 && await depth() === dj + 1, 'a real drag still moves it, by the whole distance');

    // ---- 16. Shift: axis-locked move, kept aspect ratio, 45° line ends; pressed or released mid-drag ----
    await P(() => { const p = window.__paint; p.newDoc(300, 200); p.setZoom(2); });
    await page.keyboard.press('KeyR');
    await drag([[20, 20], [80, 60]]); // 60 × 40
    await page.keyboard.press('KeyV');
    await page.keyboard.down('Shift');
    await drag([[20, 30], [60, 37]]); // on the outline, clear of the handles
    await page.keyboard.up('Shift');
    o = await objs();
    ok(o[0].a.x === 60 && o[0].a.y === 20, '⇧-drag moves along the main axis only: ' + JSON.stringify(o[0].a));
    await drag([[60, 30], [70, 42]], async () => {
      await page.keyboard.down('Shift'); await frame();
      const mid = (await objs())[0];
      ok(mid.a.x === 60 && mid.a.y === 32, 'pressing ⇧ mid-drag locks the axis at once: ' + JSON.stringify(mid.a));
      await page.keyboard.up('Shift'); await frame();
      ok((await objs())[0].a.x === 70, 'releasing it frees the axis again');
    });
    o = await objs();
    const box = () => ({ x: Math.min(o[0].a.x, o[0].b.x), y: Math.min(o[0].a.y, o[0].b.y), w: Math.abs(o[0].b.x - o[0].a.x), h: Math.abs(o[0].b.y - o[0].a.y) });
    const b0 = box();
    await page.keyboard.down('Shift');
    await drag([[b0.x + b0.w, b0.y + b0.h], [b0.x + b0.w + 60, b0.y + b0.h + 5]]);
    await page.keyboard.up('Shift');
    o = await objs();
    const b1 = box();
    ok(b1.x === b0.x && b1.y === b0.y && b1.w === 120 && b1.h === 80, '⇧ on a corner handle keeps the aspect ratio: ' + JSON.stringify(b1));
    await page.keyboard.press('KeyL');
    await drag([[30, 180], [130, 180]]);
    await page.keyboard.down('Shift');
    await drag([[130, 180], [120, 95]]); // 40° from the other end
    await page.keyboard.up('Shift');
    const ln = (await objs()).at(-1);
    ok(ln.t === 'line' && ln.b.x - ln.a.x === ln.a.y - ln.b.y, '⇧ on a line end snaps it to 45°: ' + JSON.stringify([ln.a, ln.b]));

    // ---- 17. a tiny shape: corner handles only, and its middle moves it ----
    await page.keyboard.press('KeyR');
    await drag([[260, 20], [264, 24]]);
    ok(await page.locator('#objsel .handle:not([hidden])').count() === 4, 'a tiny box shows only its 4 corner handles');
    await page.keyboard.press('KeyV');
    await drag([[262, 22], [272, 42]]);
    const t = (await objs()).at(-1);
    ok(Math.min(t.a.x, t.b.x) === 270 && Math.abs(t.b.x - t.a.x) === 4 && Math.abs(t.b.y - t.a.y) === 4, 'dragging its middle moves it, at the same size: ' + JSON.stringify([t.a, t.b]));

    // ---- 18. Move tool hover: the shape a click would pick is outlined ----
    await P(() => { const p = window.__paint; p.newDoc(300, 200); p.setZoom(2); });
    await page.keyboard.press('KeyR');
    await drag([[20, 20], [80, 60]]);
    await page.keyboard.press('KeyO');
    await drag([[120, 20], [180, 60]]);
    await page.keyboard.press('KeyL');
    await drag([[20, 120], [180, 160]]);
    await page.keyboard.press('KeyV');
    await page.keyboard.press('Escape');
    const hov = () => P(() => { const h = document.querySelector('#objhover'); return h.hidden ? null : h.className; });
    await page.mouse.move(...await at(35, 20)); await frame();
    ok(await hov() === 'rect', 'hovering a rectangle with the Move tool outlines it');
    await page.mouse.move(...await at(150, 20)); await frame();
    ok(await hov() === 'ellipse', '...an ellipse gets a round outline');
    await page.mouse.move(...await at(100, 140)); await frame();
    ok(await hov() === 'line', '...a line a bar along it');
    await page.mouse.move(...await at(250, 100)); await frame();
    ok(await hov() === null, 'empty canvas: no outline');
    await page.mouse.click(...await at(35, 20));
    await page.mouse.move(...await at(35, 21)); await frame();
    ok(await hov() === null, 'the selected shape is not outlined again (it has its handles)');
    await page.mouse.move(...await at(150, 20)); await frame();
    ok(await hov() === 'ellipse', 'hovering the ellipse again');
    await page.keyboard.press('KeyR'); await frame();
    ok(await hov() === null && await P(() => document.querySelector('#overlay').style.cursor) === '', 'switching to a shape tool by key drops the outline and the move cursor at once');

    // ---- 19. ⌥-drag duplicates (Move tool); a ⌥-click doesn't ----
    await page.keyboard.press('KeyV');
    const n0 = (await objs()).length, d19 = await depth(), rectId = (await objs())[0].id;
    await page.keyboard.down('Alt');
    await page.mouse.move(...await at(35, 20)); await frame();
    ok(await P(() => document.querySelector('#overlay').style.cursor) === 'copy', '⌥ over a shape shows the copy cursor');
    await drag([[35, 20], [35, 90]]);
    await page.keyboard.up('Alt');
    o = await objs();
    ok(o.length === n0 + 1 && o[1].t === 'rect' && o[1].a.y === 90 && o[0].a.y === 20, '⌥-drag leaves the original and moves a copy, just above it: ' + JSON.stringify(o.map((x) => [x.t, x.a])));
    ok(await objSel() === o[1].id && await depth() === d19 + 1, 'the copy is selected; one undo step');
    await page.keyboard.press('Meta+KeyZ');
    ok((await objs()).length === n0, 'undo removes the copy');
    await page.keyboard.down('Alt');
    await page.mouse.click(...await at(35, 20));
    await drag([[35, 20], [35, 90]], () => page.keyboard.press('Escape'));
    await page.keyboard.up('Alt');
    ok((await objs()).length === n0 && await objSel() === rectId && await depth() === d19, 'a ⌥-click and an Esc-cancelled ⌥-drag add nothing; the original stays selected');

    // ---- 20. the help dialog lists the shape shortcuts, and still fits ----
    await page.keyboard.press('Escape');
    await page.keyboard.press('Shift+Slash');
    await page.locator('#helpDlg[open]').waitFor();
    const helpTxt = await page.locator('#helpBody').textContent();
    const macHelp = await P(() => /Mac|iPhone|iPad/.test(navigator.platform)); // keyLabel(): Ctrl+ off a Mac (CI runs Linux)
    ok(/Shapes/.test(helpTxt) && /Duplicate by dragging/.test(helpTxt) && /Flatten into pixels/.test(helpTxt) && (macHelp ? /⌘E/ : /Ctrl\+E/).test(helpTxt) && (macHelp ? /⌥/ : /Alt/).test(helpTxt), 'help has a Shapes section with ⌘D, ⌥-drag and ⌘E (platform key names)');
    ok(await P(() => { const b = document.querySelector('#helpBody'); return b.scrollHeight <= b.clientHeight + 1 && b.children.length === 3; }), 'help fits at 1280×800 in three columns');
    await page.keyboard.press('Escape');

    // ---- 21. Tab / ⇧Tab cycle through the shapes (Move tool, canvas focused), then let focus move on ----
    await P(() => { const p = window.__paint; p.newDoc(300, 200); p.setZoom(2); });
    await page.keyboard.press('KeyR'); await drag([[20, 20], [80, 60]]);
    await page.keyboard.press('KeyO'); await drag([[120, 20], [180, 60]]);
    await page.keyboard.press('KeyV');
    await page.keyboard.press('Escape');
    await P(() => document.querySelector('#viewport').focus());
    o = await objs();
    await page.keyboard.press('Tab');
    ok(await objSel() === o[0].id && await P(() => document.activeElement.id) === 'viewport', 'Tab selects the first shape; focus stays on the canvas');
    await page.waitForTimeout(100);
    ok(/Rectangle, 60 × 40 px at 20, 20\. Shape 1 of 2/.test(await P(() => document.querySelector('#srStatus').textContent)), 'and announces it to screen readers');
    await page.keyboard.press('Tab');
    ok(await objSel() === o[1].id, 'Tab again: the next shape');
    await page.keyboard.press('ArrowRight');
    ok((await objs())[1].a.x === 121, 'arrows nudge the shape picked with Tab');
    await page.keyboard.press('Shift+Tab');
    ok(await objSel() === o[0].id, '⇧Tab: the previous one');
    await page.keyboard.press('Shift+Tab');
    ok(await objSel() === null && await P(() => document.activeElement.id) !== 'viewport', '⇧Tab past the first deselects and moves focus out (no trap)');
    await P(() => document.querySelector('#viewport').focus());
    await page.keyboard.press('Tab'); await page.keyboard.press('Tab'); await page.keyboard.press('Tab');
    ok(await objSel() === null && await P(() => document.activeElement.id) !== 'viewport', 'Tab past the last does the same');
    await page.keyboard.press('KeyP');
    await P(() => document.querySelector('#viewport').focus());
    await page.keyboard.press('Tab');
    ok(await objSel() === null, 'other tools leave Tab alone');

    // ---- 22. odd stroke widths: hit area, outline and handles sit on the drawn stroke (1600%) ----
    await P(() => { const p = window.__paint; p.newDoc(60, 40); p.setZoom(16); p.S.sizes.line = 1; p.S.sizes.rect = 3; p.S.fillMode = 'outline'; });
    await P(() => { const v = document.querySelector('#viewport'); v.scrollLeft = 0; v.scrollTop = 0; });
    const at16 = async (ix, iy) => { const b = await page.locator('#overlay').boundingBox(); return [b.x + ix * 16, b.y + iy * 16]; };
    const drag16 = async (a, b) => { await page.mouse.move(...await at16(...a)); await page.mouse.down(); await page.mouse.move(...await at16(...b), { steps: 5 }); await page.mouse.up(); await frame(); };
    await page.keyboard.press('KeyL'); await drag16([5.5, 10.5], [35.5, 10.5]); // a 1 px line on pixel row 10 (y 10..11)
    await page.keyboard.press('KeyR'); await drag16([5.5, 20.5], [25.5, 30.5]); // a 3 px rectangle
    await page.keyboard.press('KeyV'); await page.keyboard.press('Escape');
    await page.mouse.move(...await at16(20, 10.9)); await frame();
    ok(await hov() === 'line', 'the bottom of a 1 px line\'s pixel row hits it');
    await page.mouse.move(...await at16(20, 9.5)); await frame();
    ok(await hov() === null, 'half a pixel above it does not');
    await page.mouse.click(...await at16(5.5, 25)); await frame();
    const selBox = await page.locator('#objsel').boundingBox(), [sx0, sy0] = await at16(5.5, 20.5), [sx1, sy1] = await at16(25.5, 30.5);
    ok(Math.abs(selBox.x - sx0) <= 1 && Math.abs(selBox.y - sy0) <= 1 && Math.abs(selBox.x + selBox.width - sx1) <= 1 && Math.abs(selBox.y + selBox.height - sy1) <= 1,
      'the outline of a 3 px rectangle runs along the middle of its stroke: ' + JSON.stringify([selBox, [sx0, sy0, sx1, sy1]]));

    // ---- 23. the scene cache (docs/total-objects.md): #image = base + objects, repainted by tile ----
    await P(() => { const p = window.__paint; p.newDoc(900, 600); p.fitZoom(false); p.S.pristine = false; });
    await P(() => { // 300 shapes of every kind and mode, by synthetic pointer events (the tools make them)
      const p = window.__paint, ov = document.querySelector('#overlay'), r = ov.getBoundingClientRect(), z = r.width / 900;
      const ev = (type, x, y) => ov.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: r.left + x * z, clientY: r.top + y * z, isPrimary: true }));
      let s = 11; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
      const kinds = ['line', 'rect', 'ellipse'], modes = ['outline', 'fill', 'both'];
      for (let i = 0; i < 300; i++) {
        p.setTool(kinds[i % 3]); p.S.fillMode = modes[(i / 3 | 0) % 3]; p.S.sizes[kinds[i % 3]] = 1 + (i % 7);
        p.S.primary = ['#000000', '#ed1c24', '#3f48cc', '#22b14c'][i % 4];
        const x = rnd() * 860, y = rnd() * 560;
        ev('pointerdown', x, y); ev('pointermove', x + 5 + rnd() * 80, y + 5 + rnd() * 60); ev('pointerup', x + 5 + rnd() * 80, y + 5 + rnd() * 60);
      }
      p.setTool('move');
    });
    await frame();
    const cacheDiff = () => P(() => {
      const p = window.__paint, W = p.img.width, H = p.img.height;
      const a = p.img.getContext('2d').getImageData(0, 0, W, H).data, b = p.freshRender().getContext('2d').getImageData(0, 0, W, H).data;
      let n = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
      return n;
    });
    ok((await objs()).length === 300 && await cacheDiff() === 0, 'the cache equals a fresh render of 300 shapes');
    ok(await P(() => { const c = document.querySelector('#preview'); if (!c.width) return true; const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; for (let i = 3; i < d.length; i += 4) if (d[i]) return false; return true; }),
      'objects are not drawn on #preview');
    await P(() => { const p = window.__paint; p.selectObj(p.objs[150].id); document.querySelector('#viewport').focus(); });
    await page.keyboard.press('ArrowLeft');
    ok(await P(() => { const e = window.__paint.hist.top(); return e.type === 'obj' && e.pairs.length === 1 && e.bytes <= 256 && !e.objs; }),
      'a nudge among 300 shapes is a one-object diff entry, not a copy of the list');
    // random edits by keyboard and pointer: nudge, restyle, reorder, duplicate, delete, move, undo, redo
    await P(() => document.querySelector('#viewport').focus());
    const keys = ['ArrowRight', 'Shift+ArrowDown', 'Meta+BracketRight', 'Delete', 'Meta+BracketLeft', 'Meta+KeyD', 'Delete', 'Meta+KeyZ', 'Meta+Shift+KeyZ', 'Delete', 'Meta+KeyZ'];
    for (let i = 0; i < 60; i++) {
      await P((i) => { const p = window.__paint, o = p.objs[(i * 37) % p.objs.length]; if (o) p.selectObj(o.id); }, i);
      if (i % 5 === 4) { // drag the selected one with the Move tool
        const c = await P(() => { const o = window.__paint.objs.find((x) => x.id === window.__paint.objSel); return o && { x: (o.a.x + o.b.x) / 2, y: o.a.y }; });
        if (c) await drag([[c.x, c.y], [c.x + (i % 2 ? 310 : -280), c.y + (i % 3 ? 170 : -150)]]);
      } else if (i % 7 === 3) await page.locator('#palette [data-color="#ffc90e"]').click();
      else await page.keyboard.press(keys[i % keys.length]);
      if (i % 3 === 0) await P(() => document.querySelector('#viewport').focus());
    }
    await frame();
    ok((await objs()).length < 300 && await cacheDiff() === 0, 'after 60 random edits (long moves, deletes), undos and redos the cache still equals a fresh render (exact)');
    const rc0 = await P(() => window.__paint.redrawCount);
    await P(() => { window.__paint.setZoom(0.25); window.__paint.setZoom(4); const v = document.querySelector('#viewport'); v.scrollLeft = 900; v.scrollTop = 600; });
    await frame(); await frame();
    ok(await P(() => window.__paint.redrawCount) === rc0, 'zooming and scrolling repaint nothing');
    ok(await P(() => {
      const p = window.__paint, list = p.objs; let s = 5; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
      for (let i = 0; i < 400; i++) {
        const q = { x: rnd() * 900, y: rnd() * 600 }, tol = 2;
        const j = p.Core.hitObject(list, q, tol), h = p.hitAt(q, tol);
        if ((j < 0 ? null : list[j]) !== h) return false;
      }
      return true;
    }), 'the R-tree hit test agrees with a linear scan, topmost first');
    ok(await P(() => { const p = window.__paint; for (let i = 1; i < p.objs.length; i++) if (!(p.objs[i - 1].z < p.objs[i].z)) return false; return true; }), 'the object list stays in z-key order');

    // ---- 24. text, pasted images and the select tool make objects (docs/total-objects.md, Phase 2) ----
    await P(() => { const p = window.__paint; p.newDoc(300, 200); p.setZoom(2); p.S.pristine = false; p.S.primary = '#000000'; p.S.fontSize = 24;
      const v = document.querySelector('#viewport'); v.scrollLeft = v.scrollTop = 0; });
    await frame();
    await page.keyboard.press('KeyT');
    await page.mouse.click(...await at(20, 20));
    await page.keyboard.type('Hello');
    await page.keyboard.press('Enter');
    await frame();
    let tx = await P(() => window.__paint.objs.map((o) => ({ t: o.t, lines: o.lines, id: o.id })));
    ok(tx.length === 1 && tx[0].t === 'text' && tx[0].lines[0] === 'Hello' && await hash() === await P(() => { const c = document.createElement('canvas'); c.width = 300; c.height = 200; const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 300, 200); const d = g.getImageData(0, 0, 300, 200).data; let h = 2166136261; for (let i = 0; i < d.length; i++) h = Math.imul(h ^ d[i], 16777619); return `300x200:${h >>> 0}`; }) && !isWhite(await seen(25, 35)),
      'typed text becomes a text object (shown, not in the pixels)');
    const seenText = await chash();
    await page.mouse.click(...await at(30, 30)); // the text tool on that text: edit it again
    ok(await P(() => !document.querySelector('#textInput').hidden && document.querySelector('#textInput').value === 'Hello' && window.__paint.objs.length === 0),
      'clicking it with the text tool reopens it (hidden from the canvas while editing)');
    await page.keyboard.press('End'); await page.keyboard.type(' you');
    await page.keyboard.press('Enter');
    await frame();
    tx = await P(() => window.__paint.objs.map((o) => ({ t: o.t, lines: o.lines, id: o.id })));
    ok(tx.length === 1 && tx[0].lines[0] === 'Hello you' && tx[0].id === (await P(() => window.__paint.hist.top().pairs[0][1].id)), 'Enter replaces it: same object, one undo step');
    await page.keyboard.press('Meta+KeyZ'); await frame();
    ok(await P(() => window.__paint.objs.length === 1 && window.__paint.objs[0].lines[0] === 'Hello') && await chash() === seenText, 'one undo brings the old text back exactly');
    await page.mouse.click(...await at(30, 30)); await page.keyboard.press('Escape'); await frame();
    ok(await P(() => window.__paint.objs.length === 1 && window.__paint.objs[0].lines[0] === 'Hello') && await chash() === seenText, 'Esc while editing it puts it back unchanged');
    // a paste: a float, then an image object; the Move tool moves it; undo removes it
    await P(() => { const c = document.createElement('canvas'); c.width = 40; c.height = 30; const g = c.getContext('2d'); g.fillStyle = '#ed1c24'; g.fillRect(0, 0, 40, 30); window.__paint.pasteImage(c); });
    await P(() => { window.__paint.selectAll(); window.__paint.setTool('move'); }); // commits the float
    await frame();
    let im = await P(() => window.__paint.objs.filter((o) => o.t === 'image').map((o) => [o.x, o.y, o.w, o.h]));
    ok(im.length === 1 && im[0][2] === 40 && isWhite(await pixel(im[0][0] + 5, im[0][1] + 5)) && !isWhite(await seen(im[0][0] + 5, im[0][1] + 5)), 'a committed paste is an image object: ' + JSON.stringify(im));
    await drag([[im[0][0] + 20, im[0][1] + 15], [im[0][0] + 120, im[0][1] + 95]]);
    const im2 = await P(() => window.__paint.objs.filter((o) => o.t === 'image').map((o) => [o.x, o.y]));
    ok(im2[0][0] === im[0][0] + 100 && im2[0][1] === im[0][1] + 80 && isWhite(await seen(im[0][0] + 5, im[0][1] + 5)), 'the Move tool moves the pasted image later');
    await page.keyboard.press('Meta+KeyZ'); await page.keyboard.press('Meta+KeyZ'); await frame();
    ok(await P(() => window.__paint.objs.length === 1) && await chash() === seenText, 'undo moves it back, then removes it');
    // the select tool: a lift leaves a colour-2 patch object and commits an image object, one step
    await P(() => { window.__paint.S.secondary = '#ffc90e'; });
    const dS = await depth();
    await page.keyboard.press('KeyS');
    await drag([[10, 10], [80, 50]]);
    await drag([[20, 20], [140, 120]]);
    await page.keyboard.press('Escape'); await frame();
    const ks = await P(() => window.__paint.objs.map((o) => o.t + (o.t === 'rect' ? ':' + o.color + ':' + o.mode : '')));
    ok(ks.join() === 'text,rect:#ffc90e:fill,image' && await depth() === dS + 1, 'lift + move + commit: a colour-2 patch and an image object, in one undo step: ' + ks.join());
    ok(isWhite(await pixel(15, 15)), 'and the pixels underneath are untouched');
    await page.keyboard.press('Meta+KeyZ'); await frame();
    ok(await chash() === seenText, 'one undo takes back the whole move');
    await drag([[100, 100], [150, 150]]);
    const sr = await P(() => { const q = window.__paint.sel; return q && [q.x, q.y, q.w, q.h]; });
    await page.keyboard.press('Delete'); await frame();
    ok(sr && await P((r) => { const p = window.__paint, o = p.objs[p.objs.length - 1]; return !p.sel && o.t === 'rect' && o.mode === 'fill' && o.color === '#ffc90e' && o.a.x === r[0] && o.a.y === r[1] && o.b.x === r[0] + r[2] && o.b.y === r[1] + r[3]; }, sr),
      'Delete clears the selection with a colour-2 patch object over exactly the selection');

    ok(errs.length === 0, 'no page errors: ' + errs.join(' | '));
  } catch (e) {
    fails++; console.log('FAIL: threw', e);
  } finally {
    await browser.close();
    console.log(`${passes} passed, ${fails} failed`);
    process.exit(fails ? 1 : 0);
  }
})();
