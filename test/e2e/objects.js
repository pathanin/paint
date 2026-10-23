// Live shapes (objects above the pixels, docs/objects.md) e2e test. Dev-only, like smoke.js.
// usage: node objects.js [url]   exit 0 = all pass
const { engine, launch } = require('./browser.js');
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
    const objs = () => P(() => window.__paint.userObjs.map(({ id, t, a, b, color, alt, size, mode }) => ({ id, t, a, b, color, alt, size, mode })));
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

    // ---- 4. move tool (V): click picks objects, Space-drag pans (a plain drag box-selects: 27); the select tool is pixels only ----
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
    await page.mouse.move(px0, py0); await page.keyboard.down('Space'); await page.mouse.down(); await page.mouse.move(px0 - 120, py0 - 80, { steps: 4 }); await page.mouse.up(); await page.keyboard.up('Space');
    const sc1 = await P(() => [document.querySelector('#viewport').scrollLeft, document.querySelector('#viewport').scrollTop]);
    ok(sc1[0] - sc0[0] === 120 && sc1[1] - sc0[1] === 80, 'Space-dragging with the move tool pans: ' + JSON.stringify([sc0, sc1]));
    ok(await depth() === before4 && (await objs())[0].a.x === 30, 'panning changes nothing');
    await page.mouse.click(px0, py0);
    ok(await objSel() === null, 'a click on empty canvas deselects');
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
    ok(JSON.stringify((await objs()).filter((x) => x.a).map((x) => x.a)) === JSON.stringify(o9.filter((x) => x.a).map((x) => ({ x: x.a.x + 50, y: x.a.y + 50 }))) && await P(() => window.__paint.userObjs[1].pts[0]) === 55, 'canvas size (centred) shifts the shapes and the stroke with the pixels');
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
      await P(() => window.__paint.userObjs[0].t === 'pencil' && window.__paint.userObjs[0].pts[0] === -136), 'crop (from 141, 21) shifts the shapes and the stroke that crosses it, and drops one left wholly outside: ' + JSON.stringify(o.map((x) => [x.t, x.a])));
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
    const dj = await depth(), a0 = JSON.stringify((await objs())[0].a); // where the drag put it
    // WebKit's input is whole CSS px, so at 25% the corner lands within 4 image px of 200, 200
    if (engine !== 'webkit') ok(a0 === '{"x":200,"y":200}', 'at 25% the drag puts the corner at 200, 200: ' + a0);
    { const [x, y] = await at(200, 500); await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 1, y + 1); await page.mouse.up(); await frame(); }
    o = await objs();
    ok(JSON.stringify(o[0].a) === a0 && await depth() === dj && await objSel() === o[0].id, 'at 25% a 1 px wobble while clicking selects the shape and leaves it put: ' + JSON.stringify(o[0].a));
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
    ok(/Objects/.test(helpTxt) && /Duplicate by dragging/.test(helpTxt) && /Flatten \(with Move: just the selection\)/.test(helpTxt) && /Delete what the Eraser crosses/.test(helpTxt) && (macHelp ? /⌘E/ : /Ctrl\+E/).test(helpTxt) && (macHelp ? /⌥/ : /Alt/).test(helpTxt), 'help has an Objects section with ⌘D, ⌥-drag, ⌘E and the ⌥-drag eraser (platform key names)');
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
    // announce() clears the live region, then fills it 50 ms later: wait for it (a fixed wait was flaky under load)
    await page.waitForFunction(() => document.querySelector('#srStatus').textContent !== '', null, { timeout: 1000 }).catch(() => {});
    ok(/Rectangle, 60 × 40 px at 20, 20\. Shape 1 of 2/.test(await P(() => document.querySelector('#srStatus').textContent)), 'and announces it to screen readers: ' + await P(() => JSON.stringify(document.querySelector('#srStatus').textContent)));
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
    await P(() => { const p = window.__paint; p.selectObj(p.userObjs[150].id); document.querySelector('#viewport').focus(); });
    await page.keyboard.press('ArrowLeft');
    ok(await P(() => { const e = window.__paint.hist.top(); return e.type === 'obj' && e.pairs.length === 1 && e.bytes <= 256 && !e.objs; }),
      'a nudge among 300 shapes is a one-object diff entry, not a copy of the list');
    // random edits by keyboard and pointer: nudge, restyle, reorder, duplicate, delete, move, undo, redo
    await P(() => document.querySelector('#viewport').focus());
    const keys = ['ArrowRight', 'Shift+ArrowDown', 'Meta+BracketRight', 'Delete', 'Meta+BracketLeft', 'Meta+KeyD', 'Delete', 'Meta+KeyZ', 'Meta+Shift+KeyZ', 'Delete', 'Meta+KeyZ'];
    for (let i = 0; i < 60; i++) {
      await P((i) => { const p = window.__paint, o = p.userObjs[(i * 37) % p.userObjs.length]; if (o) p.selectObj(o.id); }, i);
      if (i % 5 === 4) { // drag the selected one with the Move tool
        const c = await P(() => { const o = window.__paint.userObjs.find((x) => x.id === window.__paint.objSel); return o && { x: (o.a.x + o.b.x) / 2, y: o.a.y }; });
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
      const p = window.__paint, list = p.userObjs; let s = 5; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
      for (let i = 0; i < 400; i++) {
        const q = { x: rnd() * 900, y: rnd() * 600 }, tol = 2;
        const j = p.Core.hitObject(list, q, tol), h = p.hitAt(q, tol);
        if ((j < 0 ? null : list[j]) !== h) return false;
      }
      return true;
    }), 'the R-tree hit test agrees with a linear scan, topmost first');
    ok(await P(() => { const p = window.__paint; for (let i = 1; i < p.userObjs.length; i++) if (!(p.userObjs[i - 1].z < p.userObjs[i].z)) return false; return true; }), 'the object list stays in z-key order');

    // ---- 24. text, pasted images and the select tool make objects (docs/total-objects.md, Phase 2) ----
    await P(() => { const p = window.__paint; p.newDoc(300, 200); p.setZoom(2); p.S.pristine = false; p.S.primary = '#000000'; p.S.fontSize = 24;
      const v = document.querySelector('#viewport'); v.scrollLeft = v.scrollTop = 0; });
    await frame();
    await page.keyboard.press('KeyT');
    await page.mouse.click(...await at(20, 20));
    await page.keyboard.type('Hello');
    await page.keyboard.press('Enter');
    await frame();
    let tx = await P(() => window.__paint.userObjs.map((o) => ({ t: o.t, lines: o.lines, id: o.id })));
    ok(tx.length === 1 && tx[0].t === 'text' && tx[0].lines[0] === 'Hello' && await hash() === await P(() => { const c = document.createElement('canvas'); c.width = 300; c.height = 200; const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 300, 200); const d = g.getImageData(0, 0, 300, 200).data; let h = 2166136261; for (let i = 0; i < d.length; i++) h = Math.imul(h ^ d[i], 16777619); return `300x200:${h >>> 0}`; }) && await P(() => { const p = window.__paint, o = p.userObjs[0], b = p.Core.objBox(o), d = p.composite().getContext('2d').getImageData(b.x, b.y, b.w, b.h).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] < 128) n++; return n > 30; }),
      'typed text becomes a text object (shown, not in the pixels)');
    const seenText = await chash();
    await page.mouse.click(...await at(30, 30)); // the text tool on that text: edit it again
    ok(await P(() => !document.querySelector('#textInput').hidden && document.querySelector('#textInput').value === 'Hello' && window.__paint.userObjs.length === 0),
      'clicking it with the text tool reopens it (hidden from the canvas while editing)');
    await page.keyboard.press('End'); await page.keyboard.type(' you');
    await page.keyboard.press('Enter');
    await frame();
    tx = await P(() => window.__paint.userObjs.map((o) => ({ t: o.t, lines: o.lines, id: o.id })));
    ok(tx.length === 1 && tx[0].lines[0] === 'Hello you' && tx[0].id === (await P(() => window.__paint.hist.top().pairs[0][1].id)), 'Enter replaces it: same object, one undo step');
    await page.keyboard.press('Meta+KeyZ'); await frame();
    ok(await P(() => window.__paint.userObjs.length === 1 && window.__paint.userObjs[0].lines[0] === 'Hello') && await chash() === seenText, 'one undo brings the old text back exactly');
    await page.mouse.click(...await at(30, 30)); await page.keyboard.press('Escape'); await frame();
    ok(await P(() => window.__paint.userObjs.length === 1 && window.__paint.userObjs[0].lines[0] === 'Hello') && await chash() === seenText, 'Esc while editing it puts it back unchanged');
    // turned text (it carries a transform, m) is edited the same way, and keeps its transform
    const d24 = await depth();
    await P(() => { window.__paint.transformDoc('rotR'); window.__paint.transformDoc('rotR'); });
    await frame();
    const turned = await P(() => { const o = window.__paint.userObjs[0], b = window.__paint.Core.objFrame(o); return { id: o.id, m: o.m, cx: b.x + b.w / 2, cy: b.y + b.h / 2 }; });
    const seenTurned = await chash();
    await page.mouse.click(...await at(Math.floor(turned.cx), Math.floor(turned.cy)));
    ok(turned.m && await P(() => !document.querySelector('#textInput').hidden && document.querySelector('#textInput').value === 'Hello' && window.__paint.userObjs.length === 0 && /matrix/.test(document.querySelector('#textInput').style.transform)),
      'a turned text reopens with the text tool, the box turned like it: ' + JSON.stringify(turned.m));
    await page.keyboard.press('Enter'); await frame();
    ok(await chash() === seenTurned && await P(([id, m]) => { const o = window.__paint.userObjs[0]; return o.id === id && JSON.stringify(o.m) === JSON.stringify(m); }, [turned.id, turned.m]),
      'Enter with no change: it looks the same, same object, same transform');
    await page.mouse.click(...await at(Math.floor(turned.cx), Math.floor(turned.cy)));
    await page.keyboard.press('End'); await page.keyboard.type(' you'); await page.keyboard.press('Enter'); await frame();
    ok(await P(([id, m]) => { const o = window.__paint.userObjs[0]; return o.lines[0] === 'Hello you' && o.id === id && JSON.stringify(o.m) === JSON.stringify(m); }, [turned.id, turned.m]), 'an edit keeps its transform');
    await page.mouse.click(...await at(5, 5)); await frame(); // empty canvas: a new text box
    ok(await P(() => !document.querySelector('#textInput').hidden && !/matrix/.test(document.querySelector('#textInput').style.transform)), 'a new text box is not turned');
    await page.keyboard.press('Escape');
    while (await depth() > d24) { await page.keyboard.press('Meta+KeyZ'); await frame(); }
    ok(await chash() === seenText, 'undo takes it all back');
    // a paste: a float, then an image object; the Move tool moves it; undo removes it
    await P(() => { const c = document.createElement('canvas'); c.width = 40; c.height = 30; const g = c.getContext('2d'); g.fillStyle = '#ed1c24'; g.fillRect(0, 0, 40, 30); window.__paint.pasteImage(c); });
    await P(() => { window.__paint.selectAll(); window.__paint.setTool('move'); }); // commits the float
    await frame();
    let im = await P(() => window.__paint.userObjs.filter((o) => o.t === 'image').map((o) => [o.x, o.y, o.w, o.h]));
    ok(im.length === 1 && im[0][2] === 40 && isWhite(await pixel(im[0][0] + 5, im[0][1] + 5)) && !isWhite(await seen(im[0][0] + 5, im[0][1] + 5)), 'a committed paste is an image object: ' + JSON.stringify(im));
    await drag([[im[0][0] + 20, im[0][1] + 15], [im[0][0] + 120, im[0][1] + 95]]);
    const im2 = await P(() => window.__paint.userObjs.filter((o) => o.t === 'image').map((o) => [o.x, o.y]));
    ok(im2[0][0] === im[0][0] + 100 && im2[0][1] === im[0][1] + 80 && isWhite(await seen(im[0][0] + 5, im[0][1] + 5)), 'the Move tool moves the pasted image later');
    await page.keyboard.press('Meta+KeyZ'); await page.keyboard.press('Meta+KeyZ'); await frame();
    ok(await P(() => window.__paint.userObjs.length === 1) && await chash() === seenText, 'undo moves it back, then removes it');
    // the select tool: a lift leaves a colour-2 patch object and commits an image object, one step
    await P(() => { window.__paint.S.secondary = '#ffc90e'; });
    const dS = await depth();
    await page.keyboard.press('KeyS');
    await drag([[10, 10], [80, 50]]);
    await drag([[20, 20], [140, 120]]);
    await page.keyboard.press('Escape'); await frame();
    const ks = await P(() => window.__paint.userObjs.map((o) => o.t + (o.t === 'rect' ? ':' + o.color + ':' + o.mode : '')));
    ok(ks.join() === 'text,rect:#ffc90e:fill,image' && await depth() === dS + 1, 'lift + move + commit: a colour-2 patch and an image object, in one undo step: ' + ks.join());
    ok(isWhite(await pixel(15, 15)), 'and the pixels underneath are untouched');
    await page.keyboard.press('Meta+KeyZ'); await frame();
    ok(await chash() === seenText, 'one undo takes back the whole move');
    await drag([[100, 100], [150, 150]]);
    const sr = await P(() => { const q = window.__paint.sel; return q && [q.x, q.y, q.w, q.h]; });
    await page.keyboard.press('Delete'); await frame();
    ok(sr && await P((r) => { const p = window.__paint, o = p.userObjs[p.userObjs.length - 1]; return !p.sel && o.t === 'rect' && o.mode === 'fill' && o.color === '#ffc90e' && o.a.x === r[0] && o.a.y === r[1] && o.b.x === r[0] + r[2] && o.b.y === r[1] + r[3]; }, sr),
      'Delete clears the selection with a colour-2 patch object over exactly the selection');

    // ---- 25. a PNG keeps the objects (private chunk); another app's re-encode drops them safely ----
    await P(() => { const p = window.__paint; p.newDoc(300, 200); p.setZoom(2); p.S.pristine = false; p.S.primary = '#3f48cc'; p.S.secondary = '#ffffff';
      const v = document.querySelector('#viewport'); v.scrollLeft = v.scrollTop = 0; });
    await page.keyboard.press('KeyB'); await drag([[20, 150], [120, 120], [200, 170]]);
    await page.keyboard.press('KeyR'); await drag([[30, 30], [120, 90]]);
    await page.keyboard.press('KeyP'); await drag([[250, 140], [290, 190], [260, 195]]);
    await page.keyboard.press('KeyT'); await page.mouse.click(...await at(150, 20)); await page.keyboard.type('Saved'); await page.keyboard.press('Enter');
    await P(() => { window.__paint.setTool('fill'); window.__paint.S.primary = '#ffc90e'; window.__paint.S.tolerance = 10; });
    await page.mouse.click(...await at(250, 100)); await P(() => window.__paint.filling); await frame(); // the background, outside the shapes
    await P(() => { const c = document.createElement('canvas'); c.width = 30; c.height = 20; const g = c.getContext('2d'); g.fillStyle = 'rgba(237, 28, 36, 0.5)'; g.fillRect(0, 0, 30, 20); window.__paint.pasteImage(c); window.__paint.selectAll(); window.__paint.setTool('move'); });
    await frame();
    const kinds = await P(() => window.__paint.userObjs.map((o) => o.t).join());
    const seen25 = await chash();
    const b64 = await P(async () => { const b = await window.__paint.encodeFor('scene.png'); const u = new Uint8Array(await b.arrayBuffer()); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); });
    ok(kinds === 'brush,rect,pencil,text,fill,image' && Buffer.from(b64, 'base64').includes(Buffer.from('paNt')), 'the PNG carries a paNt chunk for ' + kinds);
    await P(() => { const p = window.__paint; p.setTool('move'); p.selectAll && p.setTool('move'); });
    await P(() => { const p = window.__paint; p.selectMany(p.userObjs.map((o) => o.id)); }); // a group selected before opening
    ok(await P(() => window.__paint.selList().length) === 6, 'all six selected');
    await P(() => { window.__clip = null; navigator.clipboard.write = async (items) => { window.__clip = await items[0].getType('image/png'); }; });
    await page.keyboard.press('Meta+KeyC');
    await page.waitForFunction(() => window.__clip);
    const cp = await P(async () => {
      const p = window.__paint, bs = p.selList().map((o) => p.Core.objBox(o));
      const x = Math.min(...bs.map((b) => b.x)), y = Math.min(...bs.map((b) => b.y));
      const bmp = await createImageBitmap(window.__clip);
      return [bmp.width, bmp.height, Math.max(...bs.map((b) => b.x + b.w)) - x, Math.max(...bs.map((b) => b.y + b.h)) - y];
    });
    ok(cp[0] === cp[2] && cp[1] === cp[3], '⌘C copies the selected group (their union box), not the whole image: ' + cp);
    await P(() => window.__paint.newDoc(50, 50));
    await page.setInputFiles('#fileInput', { name: 'scene.png', mimeType: 'image/png', buffer: Buffer.from(b64, 'base64') });
    await page.waitForFunction(() => window.__paint.S.fileName === 'scene.png'); await frame();
    ok(await P(() => window.__paint.userObjs.map((o) => o.t).join()) === kinds && await chash() === seen25 && await P(() => !window.__paint.hist.canUndo()),
      'reopened, the objects come back and the picture is identical');
    ok(await P(() => window.__paint.selList().length) === 0, 'and nothing is selected (no stale group from before)');
    await P(() => { const p = window.__paint; p.setTool('move'); const o = p.userObjs.find((x) => x.t === 'rect'); p.selectObj(o.id); document.querySelector('#viewport').focus(); });
    await page.keyboard.press('Delete'); await frame();
    ok(await P(() => window.__paint.userObjs.length === 5 && !window.__paint.userObjs.some((o) => o.t === 'rect')), 'and they are editable (the rectangle can be deleted on its own)');
    // the same picture re-encoded elsewhere: a chunk copied along no longer matches its image data
    const other = await P(async (b64) => {
      const bin = atob(b64), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      const bmp = await createImageBitmap(new Blob([u], { type: 'image/png' })), c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
      const g = c.getContext('2d'); g.drawImage(bmp, 0, 0); g.fillStyle = '#000'; g.fillRect(0, 0, 1, 1); // an edit elsewhere
      const fresh = new Uint8Array(await (await new Promise((r) => c.toBlob(r, 'image/png'))).arrayBuffer());
      const P2 = window.__paint.Core, chunk = P2.readChunk(u, 'paNt'), out = P2.withChunk(fresh, 'paNt', chunk); // a tool that copies unknown chunks
      let s = ''; for (let i = 0; i < out.length; i += 0x8000) s += String.fromCharCode.apply(null, out.subarray(i, i + 0x8000)); return btoa(s);
    }, b64);
    await page.setInputFiles('#fileInput', { name: 'edited.png', mimeType: 'image/png', buffer: Buffer.from(other, 'base64') });
    await page.waitForFunction(() => window.__paint.S.fileName === 'edited.png'); await frame();
    ok(await P(() => window.__paint.userObjs.length === 0 && window.__paint.base.width === 300), 'a PNG edited elsewhere opens as its pixels, without stale objects');
    const jpg = await P(async () => { const p = window.__paint; p.newDoc(40, 40); p.setTool('rect'); return 0; });
    await page.keyboard.press('KeyR'); await drag([[5, 5], [30, 30]]);
    ok(await P(async () => { const u = new Uint8Array(await (await window.__paint.encodeFor('x.jpg')).arrayBuffer()); return u[0] === 0xff && u[1] === 0xd8; }) && jpg === 0, 'JPEG saves just the picture');

    // ---- 26. ⌥-drag with the Eraser deletes whole objects it crosses (decision 4b) ----
    await P(() => { const p = window.__paint; p.newDoc(300, 200); p.setZoom(2); p.S.pristine = false; p.S.primary = '#000000'; p.S.sizes.eraser = 8;
      const v = document.querySelector('#viewport'); v.scrollLeft = v.scrollTop = 0; });
    await page.keyboard.press('KeyR'); await drag([[20, 20], [80, 60]]);
    await page.keyboard.press('KeyP'); await drag([[150, 20], [150, 120]]);
    await page.keyboard.press('KeyO'); await drag([[200, 140], [280, 190]]);
    const seen26 = await chash(), d26 = await depth();
    await page.keyboard.press('KeyE');
    await page.keyboard.down('Alt');
    await page.mouse.move(...await at(150, 70)); await frame(); await frame();
    ok(await page.locator('#objhover').isVisible(), '⌥ over an object with the Eraser outlines what it would delete');
    await page.mouse.move(...await at(10, 40));
    await page.mouse.down();
    await page.mouse.move(...await at(170, 40), { steps: 3 }); // a fast drag across the rectangle's edge and the stroke
    await page.mouse.up();
    await page.keyboard.up('Alt');
    await frame();
    ok(await P(() => window.__paint.userObjs.map((o) => o.t).join()) === 'ellipse' && await depth() === d26 + 1, '⌥-drag deleted the two objects it crossed, in one undo step');
    ok(isWhite(await pixel(20, 40)), 'and painted nothing');
    await page.keyboard.press('Meta+KeyZ'); await frame();
    ok(await P(() => window.__paint.userObjs.length) === 3 && await chash() === seen26, 'one undo brings both back exactly');
    await page.mouse.move(...await at(10, 40));
    await page.mouse.down();
    await page.mouse.move(...await at(170, 40), { steps: 3 });
    await page.mouse.up();
    ok(await P(() => window.__paint.userObjs.map((o) => o.t).join()) === 'rect,pencil,ellipse,eraser', 'without ⌥ the Eraser draws a colour-2 stroke object on top');

    // ---- 27. Move tool: a drag on empty canvas selects every object it touches; group move, delete ----
    await P(() => { const p = window.__paint; p.newDoc(300, 200); p.setZoom(2); p.S.pristine = false; p.S.primary = '#000000';
      const v = document.querySelector('#viewport'); v.scrollLeft = v.scrollTop = 0; });
    await page.keyboard.press('KeyR'); await drag([[20, 20], [60, 50]]);
    await page.keyboard.press('KeyP'); await drag([[100, 30], [140, 60]]);
    await page.keyboard.press('KeyO'); await drag([[200, 120], [260, 170]]);
    await page.keyboard.press('KeyV');
    await drag([[10, 10], [120, 40]]); // touches the rectangle and the stroke, not the ellipse
    const ms = await P(() => [window.__paint.objSel, window.__paint.userObjs.filter((o) => window.__paint.selList().includes(o)).map((o) => o.t).join()]);
    ok(ms[0] === null && ms[1] === 'rect,pencil', 'a box drag on empty canvas selects the objects it touches: ' + JSON.stringify(ms));
    await page.keyboard.down('Shift'); await page.mouse.click(...await at(200, 145)); await page.keyboard.up('Shift');
    ok(await P(() => window.__paint.selList().length) === 3, '⇧-click adds one');
    await page.keyboard.down('Shift'); await page.mouse.click(...await at(200, 145)); await page.keyboard.up('Shift');
    ok(await P(() => window.__paint.selList().length) === 2, '⇧-click again takes it out');
    const g0 = await P(() => window.__paint.userObjs.map((o) => JSON.stringify(o.a || o.pts))), dg = await depth();
    await drag([[20, 35], [70, 85]]); // on the rectangle: both move
    const g1 = await P(() => window.__paint.userObjs.map((o) => o.a ? [o.a.x, o.a.y] : [o.pts[0], o.pts[1]]));
    ok(JSON.stringify(g1) === JSON.stringify([[70, 70], [150, 80], [200, 120]]) && await depth() === dg + 1, 'dragging one of them moves the group, one undo step: ' + JSON.stringify(g1));
    await P(() => document.querySelector('#viewport').focus());
    await page.keyboard.press('ArrowRight');
    ok(await P(() => window.__paint.userObjs[0].a.x === 71 && window.__paint.userObjs[1].pts[0] === 151), 'arrows nudge the group');
    await page.keyboard.press('Delete');
    ok(await P(() => window.__paint.userObjs.map((o) => o.t).join()) === 'ellipse', 'Delete removes the group');
    await page.keyboard.press('Meta+KeyZ');
    ok(await P(() => window.__paint.userObjs.length) === 3, 'one undo brings it back');
    // Esc mid-drag puts the group back, and the selection as it was: the group, no single object
    await P(() => { const p = window.__paint; p.selectMany(p.userObjs.map((o) => o.id)); });
    const e0 = await P(() => JSON.stringify(window.__paint.userObjs)), de = await depth();
    await drag([[71 + 1, 85], [120, 120]], () => page.keyboard.press('Escape'));
    const esc = await P(() => ({ same: JSON.stringify(window.__paint.userObjs), objSel: window.__paint.objSel, sel: window.__paint.selList().map((o) => o.id).join() }));
    ok(esc.same === e0 && await depth() === de, 'Esc during a group drag puts the objects back, no undo step');
    ok(esc.objSel === null && esc.sel === (await P(() => window.__paint.userObjs.map((o) => o.id).join())), 'and keeps the group selected, with no single object selected too: ' + JSON.stringify([esc.objSel, esc.sel]));
    // ⇧-drag on an unselected object, then Esc: the selection is the one before (not that object)
    const first = await P(() => { const p = window.__paint, id = p.userObjs[0].id; p.selectObj(id); return id; });
    await page.keyboard.down('Shift');
    await drag([[200, 145], [220, 150]], () => page.keyboard.press('Escape'));
    await page.keyboard.up('Shift');
    ok(await P(() => [window.__paint.objSel, window.__paint.selList().length].join()) === `${first},1`, 'Esc during a ⇧-drag keeps the selection it started with');
    await page.mouse.click(...await at(290, 10));
    ok(await P(() => window.__paint.selList().length) === 0, 'a click on empty canvas deselects them');
    void g0;

    // ---- 28. Fill inside a closed shape sets its fill (decision 5b); ⌘E with a selection flattens just it ----
    await P(() => { const p = window.__paint; p.newDoc(300, 200); p.setZoom(2); p.S.pristine = false; p.S.primary = '#000000'; p.S.fillMode = 'outline';
      const v = document.querySelector('#viewport'); v.scrollLeft = v.scrollTop = 0; });
    await page.keyboard.press('KeyR'); await drag([[20, 20], [100, 80]]);
    await page.keyboard.press('KeyO'); await drag([[150, 20], [250, 100]]);
    await P(() => { window.__paint.setTool('fill'); window.__paint.S.primary = '#ed1c24'; });
    await page.mouse.click(...await at(60, 50)); await P(() => window.__paint.filling); await frame();
    ok(await P(() => { const o = window.__paint.userObjs; return o.length === 2 && o[0].mode === 'both' && o[0].alt === '#ed1c24'; }), 'a fill click inside a closed shape sets its fill, adding no fill object');
    await page.mouse.click(...await at(280, 180)); await P(() => window.__paint.filling); await frame();
    ok(await P(() => window.__paint.userObjs.map((o) => o.t).join()) === 'rect,ellipse,fill', 'outside the shapes it is a flood fill as before');
    await page.keyboard.press('KeyV');
    await page.mouse.click(...await at(150, 60)); // the ellipse's outline
    const seen28 = await chash();
    await page.keyboard.press('Meta+KeyE'); await frame();
    ok(await P(() => window.__paint.userObjs.map((o) => o.t).join()) === 'rect,image,fill', '⌘E with a selection flattens just it into one image object, in its place');
    await page.keyboard.press('Meta+KeyZ'); await frame();
    ok(await P(() => window.__paint.userObjs.map((o) => o.t).join()) === 'rect,ellipse,fill' && await chash() === seen28, 'one undo brings the ellipse back exactly');
    // ⌘E on a selection with an unselected object between its members: what is seen stays the same.
    // Filled rects with even widths, so their pixels are exact however they are drawn.
    const gap = async (bx) => {
      await P(() => { const p = window.__paint; p.newDoc(300, 200); p.setZoom(2); p.S.fillMode = 'fill'; p.S.sizes.rect = 2;
        const v = document.querySelector('#viewport'); v.scrollLeft = v.scrollTop = 0; });
      await page.keyboard.press('KeyR');
      await P(() => { window.__paint.selectObj(null); window.__paint.S.primary = '#ed1c24'; }); await drag([[20, 20], [80, 80]]); // A
      await P(() => { window.__paint.selectObj(null); window.__paint.S.primary = '#3f48cc'; }); await drag([[bx, 40], [bx + 60, 100]]); // B (a fresh shape, not a move of A)
      await P(() => { window.__paint.selectObj(null); window.__paint.S.primary = '#22b14c'; }); await drag([[200, 20], [260, 80]]); // C
      await page.keyboard.press('KeyV');
      await P(() => { const p = window.__paint, u = p.userObjs; p.selectMany([u[0].id, u[2].id]); });
      const before = await chash(), d0 = await depth();
      await page.keyboard.press('Meta+KeyE'); await frame();
      return { same: await chash() === before, kinds: await P(() => window.__paint.userObjs.map((o) => o.t).join()), steps: await depth() - d0, sel: await P(() => window.__paint.selList().map((o) => o.t).join()) };
    };
    const g28 = await gap(50); // B covers part of A
    ok(g28.same && g28.kinds === 'image,rect,image' && g28.steps === 1 && g28.sel === 'image,image', '⌘E keeps an unselected object over a selected one on top: one image per run, one step: ' + JSON.stringify(g28));
    const f28 = await gap(110); // B touches neither
    ok(f28.same && f28.kinds === 'rect,image' && f28.steps === 1, 'with nothing between them in the way, the selection is one image: ' + JSON.stringify(f28));
    const again = await depth(), ids28 = await P(() => window.__paint.userObjs.map((o) => o.id).join());
    await page.keyboard.press('Meta+KeyE'); await frame();
    ok(await depth() === again && await P(() => window.__paint.userObjs.map((o) => o.id).join()) === ids28, 'a second ⌘E on the image a ⌘E made changes nothing and adds no step');

    // ---- 29. the opened picture is the bottom object, locked (decision 6) ----
    await P(() => { const p = window.__paint; p.newDoc(120, 80); p.setZoom(2); const v = document.querySelector('#viewport'); v.scrollLeft = v.scrollTop = 0; });
    ok(await P(() => { const o = window.__paint.objs[0]; return window.__paint.objs.length === 1 && o.t === 'base' && o.locked && o.w === 120 && o.h === 80 && o.asset.cv === window.__paint.base; }),
      'the picture is the bottom object: a locked base over the base canvas');
    await page.keyboard.press('KeyV');
    await page.mouse.click(...await at(60, 40));
    ok(await objSel() === null && await P(() => window.__paint.selList().length === 0), 'the Move tool does not pick it');
    await P(() => window.__paint.transformDoc('rotR'));
    ok(await P(() => { const o = window.__paint.objs[0]; return o.t === 'base' && o.w === 80 && o.h === 120 && o.asset.cv === window.__paint.base; }), 'a whole-image op gives it the new picture');
    await page.keyboard.press('Meta+KeyZ');
    ok(await P(() => window.__paint.objs[0].w === 120), 'and undo the old one');

    // ---- 30. a selected group resizes by its box's handles; z-order buttons and keys ----
    await P(() => { const p = window.__paint; p.newDoc(300, 200); p.setZoom(2); p.S.pristine = false; p.S.primary = '#000000'; p.S.fillMode = 'outline'; p.S.sizes.rect = 2;
      const v = document.querySelector('#viewport'); v.scrollLeft = v.scrollTop = 0; });
    await page.keyboard.press('KeyR'); await drag([[20, 20], [60, 40]]);
    await drag([[80, 50], [100, 70]]);
    const keys30 = await P(() => window.__paint.objs.map((o) => o.z));
    ok(keys30.slice(1).every((z, i) => z > keys30[i] && z.length <= 4), 'z-keys above the picture are short and in order: ' + keys30.join(' '));
    await page.keyboard.press('KeyV');
    await P(() => { const p = window.__paint; p.selectMany(p.userObjs.map((o) => o.id)); });
    await frame();
    ok(await page.locator('#objsel').isVisible() && await page.locator('#objsel .handle:not([hidden])').count() >= 4, 'a selected group shows one box with handles');
    const dz = await depth();
    await drag([[100, 70], [180, 120]]); // its south-east corner: twice the size, from the north-west corner
    const rs = await P(() => window.__paint.userObjs.map((o) => [o.a.x, o.a.y, o.b.x, o.b.y]));
    ok(JSON.stringify(rs) === JSON.stringify([[20, 20, 100, 60], [140, 80, 180, 120]]) && await depth() === dz + 1,
      'dragging the corner scales every object in the group (one undo step): ' + JSON.stringify(rs));
    await page.keyboard.press('Meta+KeyZ');
    ok(await P(() => window.__paint.userObjs[1].b.x) === 100, 'undo puts them back');
    await P(() => { const p = window.__paint; p.selectObj(p.userObjs[0].id); });
    await frame();
    ok(!(await page.locator('[data-cmd="toFront"]').isDisabled()), 'the arrange buttons are enabled with a selection');
    await page.locator('[data-cmd="toFront"]').click();
    ok(await P(() => window.__paint.userObjs[1].a.x) === 20, 'Bring to front puts it on top');
    await P(() => document.querySelector('#viewport').focus());
    await page.keyboard.press('Meta+Shift+BracketLeft');
    ok(await P(() => window.__paint.userObjs[0].a.x === 20 && window.__paint.objs[0].t === 'base'), '⌘⇧[ sends it to the back, still above the picture');
    await P(() => window.__paint.selectObj(null)); await frame();
    ok(await page.locator('[data-cmd="toFront"]').isDisabled(), 'and disabled with nothing selected');

    // ---- 31. a pasted image survives a GPU context loss of its canvas (its asset keeps a CPU copy where one can happen) ----
    await P(() => { const p = window.__paint; p.newDoc(200, 150); p.S.pristine = false; const c = document.createElement('canvas'); c.width = 50; c.height = 40; const g = c.getContext('2d');
      g.fillStyle = '#3f48cc'; g.fillRect(0, 0, 50, 40); g.fillStyle = '#ffc90e'; g.fillRect(10, 10, 20, 15); p.pasteImage(c); p.selectAll(); p.setTool('move'); });
    await P(() => window.__paint.userObjs.find((x) => x.t === 'image').asset.ready); // its copy is read at idle, in strips
    // A browser that can't lose a 2D context (no contextlost event: WebKit) keeps no copy.
    const loses = await P(() => 'oncontextlost' in HTMLCanvasElement.prototype);
    ok(await P(() => window.__paint.userObjs.find((x) => x.t === 'image').asset.bytes) === 50 * 40 * 4 * (loses ? 2 : 1), `an image asset is charged for its canvas${loses ? ' and its CPU copy' : ' only'}`);
    if (loses) {
      const seen31 = await chash();
      await P(() => { const o = window.__paint.userObjs.find((x) => x.t === 'image'), cv = o.asset.cv; cv.getContext('2d').clearRect(0, 0, cv.width, cv.height); window.__paint.markAll(); });
      await frame();
      ok(await chash() !== seen31, 'a blanked asset canvas shows as blank once repainted (the loss is real)');
      await P(() => window.__paint.userObjs.find((x) => x.t === 'image').asset.cv.dispatchEvent(new Event('contextrestored')));
      await frame();
      ok(await chash() === seen31, 'after its canvas comes back blank, the image object is refilled and repainted exactly');
    }

    // ---- 32. a fill keeps nothing a GPU context loss could blank, but the small canvases of dense cells ----
    // A black disc drawn on a transparent picture: filling it recolours its anti-aliased rim, which
    // stays partly transparent, so the fill clears those pixels first. It is all paths (assets.js).
    await P(() => { const p = window.__paint; p.newDoc(200, 150); p.S.pristine = false; p.setZoom(2); const v = document.querySelector('#viewport'); v.scrollLeft = v.scrollTop = 0;
      const g = p.base.getContext('2d'); g.clearRect(0, 0, 200, 150); g.fillStyle = '#000000'; g.beginPath(); g.ellipse(100, 75, 50, 40, 0, 0, Math.PI * 2); g.fill(); p.markAll(); });
    await P(() => { const p = window.__paint; p.setTool('fill'); p.S.tolerance = 0; p.S.primary = '#ed1c24'; });
    await page.mouse.click(...await at(100, 75)); await P(() => window.__paint.filling); await frame();
    const soft32 = await P(() => { const a = window.__paint.userObjs.find((x) => x.t === 'fill').asset; return { cells: a.cells.length, paths: a.cells.every((c) => !c.px), clears: a.clears }; });
    ok(soft32.cells === 1 && soft32.paths && soft32.clears, 'the fill over transparency is paths in one cell, clearing its soft rim first: ' + JSON.stringify(soft32));
    const seen32 = await chash();
    await P(() => window.__paint.markAll()); await frame(); // what a lost #image does: the scene repainted from scratch
    ok(await chash() === seen32, 'repainted from scratch, it gives the same pixels (nothing of it was on the GPU)');
    // Noise: a fill of the white in it is one rect per run of each row, too many for a path, so its cell is
    // drawn from a canvas of its pixels. A context loss blanks that canvas; it comes back from the pixels.
    await P(() => { const p = window.__paint; p.newDoc(200, 150); p.S.pristine = false;
      const g = p.base.getContext('2d'), im = g.getImageData(0, 0, 200, 150), d = new Uint32Array(im.data.buffer);
      let s = 9; for (let i = 0; i < d.length; i++) { s = (s * 1103515245 + 12345) >>> 0; d[i] = (s >>> 16) % 10 < 7 || i < 200 ? 0xffffffff : 0xff000000; } // a white top row joins it up
      g.putImageData(im, 0, 0); p.markAll(); p.S.primary = '#22b14c'; });
    await page.mouse.click(...await at(3, 0)); await P(() => window.__paint.filling); await frame();
    const dense = await P(() => { const a = window.__paint.userObjs.find((x) => x.t === 'fill').asset; return a.cells.map((c) => !!c.px).join(); });
    ok(dense === 'true', 'the noise fill is one dense cell, drawn from its pixels: ' + dense);
    const seen32b = await chash();
    await P(() => { const c = window.__paint.userObjs.find((x) => x.t === 'fill').asset.cells[0]; window.__lost = c.cv; c.cv.getContext('2d').clearRect(0, 0, c.w, c.h); window.__paint.markAll(); });
    await frame();
    ok(await chash() !== seen32b, 'a blanked cell canvas shows (the loss is real)');
    await P(() => window.__lost.dispatchEvent(new Event('contextrestored')));
    await frame();
    ok(await chash() === seen32b, 'after its canvas comes back blank, the cell is rebuilt from its pixels and repaints exactly');

    // ---- 32b. a tile repaint draws only the cells of a fill that the tile meets: one, for a fill that hasn't moved ----
    const cells32 = await P(async () => {
      const p = window.__paint; p.newDoc(2048, 1024); p.fitZoom(false); p.S.pristine = false;
      p.setTool('fill'); p.S.tolerance = 0; p.S.primary = '#22b14c';
      return true;
    });
    await page.mouse.click(...await at(3, 3)); await P(() => window.__paint.filling); await frame();
    const fills32 = await P(() => {
      const p = window.__paint, proto = CanvasRenderingContext2D.prototype, fill = proto.fill;
      let n = 0;
      proto.fill = function (...a) { if (this.fillStyle === '#22b14c') n++; return fill.apply(this, a); };
      try { p.markAll(); p.flushRedraw(); } finally { proto.fill = fill; }
      return { n, cells: p.userObjs.at(-1).asset.cells.length };
    });
    ok(cells32 && fills32.cells === 8 && fills32.n === 8, 'a whole-image fill is one cell per tile, and repainting the 8 tiles fills 8 times: ' + JSON.stringify(fills32));

    // ---- 33. a long stroke, drawn live piece by piece: the cache equals the scene drawn fresh, during and after ----
    for (const tool of ['pencil', 'brush', 'eraser']) {
      const r33 = await P(async (tool) => {
        const p = window.__paint, ov = document.querySelector('#overlay');
        p.newDoc(900, 600); p.setZoom(1); p.S.pristine = false; p.setTool(tool); p.S.sizes[tool] = 5; p.S.primary = '#3f48cc'; p.S.secondary = '#ffc90e';
        const v = document.querySelector('#viewport'); v.scrollLeft = v.scrollTop = 0;
        const r = ov.getBoundingClientRect();
        const ev = (type, x, y) => ov.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: r.left + x, clientY: r.top + y, isPrimary: true }));
        const h = (c) => { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let k = 2166136261; for (let i = 0; i < d.length; i++) k = Math.imul(k ^ d[i], 16777619); return k >>> 0; };
        const at = (i) => [450 + 400 * Math.sin(i / 97) * Math.cos(i / 31), 300 + 260 * Math.sin(i / 53)]; // crosses itself and many tiles
        ev('pointerdown', ...at(0));
        for (let i = 1; i < 1000; i++) { ev('pointermove', ...at(i)); if (i % 50 === 0) await null; }
        await null;
        const mid = h(p.img) === h(p.freshRender());
        for (let i = 1000; i < 2000; i++) { ev('pointermove', ...at(i)); if (i % 50 === 0) await null; }
        ev('pointerup', ...at(2000));
        await null;
        return { mid, after: h(p.img) === h(p.freshRender()), kinds: p.userObjs.map((o) => o.t).join(), n: (p.userObjs[0] && (p.userObjs[0].pts || p.userObjs[0].segs).length) || 0 };
      }, tool);
      ok(r33.mid && r33.after && r33.kinds === tool && r33.n > 500, `a long ${tool} stroke: cache == fresh render while drawn and once joined: ` + JSON.stringify(r33));
    }

    // ---- 34. Move tool cursors: the arrow its button shows, move over an object, the hand only for panning ----
    await P(() => { const p = window.__paint; p.newDoc(300, 200); p.setZoom(2); const v = document.querySelector('#viewport'); v.scrollLeft = v.scrollTop = 0; });
    await frame();
    await page.keyboard.press('KeyR');
    await drag([[20, 20], [100, 80]]);
    await page.keyboard.press('KeyV');
    const cur = async () => { await frame(); return P(() => getComputedStyle(document.querySelector('#overlay')).cursor); };
    const hover = async (ix, iy) => { const [x, y] = await at(ix, iy); await page.mouse.move(x, y); return cur(); };
    ok(await hover(200, 150) === 'default', 'Move tool over empty canvas: the arrow, not a hand');
    ok(await hover(20, 35) === 'move', 'Move tool over an object: the move cursor');
    await page.mouse.down();
    { const [x, y] = await at(40, 45); await page.mouse.move(x, y, { steps: 4 }); }
    ok(await cur() === 'move', 'dragging an object keeps the move cursor');
    await page.mouse.up();
    ok(await hover(200, 150) === 'default', 'back to the arrow once off it');
    await page.mouse.down();
    { const [x, y] = await at(250, 180); await page.mouse.move(x, y, { steps: 4 }); }
    ok(await cur() === 'default', 'a box-select drag keeps the arrow');
    await page.mouse.up();
    await hover(40, 45);
    await page.keyboard.down('Space');
    ok(await cur() === 'grab', 'Space held over an object: the open hand, not move');
    await page.mouse.down();
    { const [x, y] = await at(60, 60); await page.mouse.move(x, y, { steps: 4 }); }
    ok(await cur() === 'grabbing', 'Space-dragging: the closed hand');
    await page.mouse.up();
    ok(await cur() === 'grab', 'released, Space still held: the open hand again');
    await page.keyboard.up('Space');
    ok(await hover(200, 150) === 'default', 'Space released: the arrow again');
    await page.mouse.down({ button: 'middle' });
    ok(await cur() === 'grabbing', 'a middle-button pan: the closed hand');
    await page.mouse.up({ button: 'middle' });
    ok(await hover(200, 150) === 'default', 'after the middle-button pan: the arrow');

    // ---- 35. snapping: a move or resize lines up with other objects and the canvas; ⌘ held suspends it ----
    // At 200% the reach is 8 screen px = 4 image px. Canvas 400 × 320: its lines are x 0, 200, 400 and y 0, 160, 320.
    await P(() => { const p = window.__paint; p.newDoc(400, 320); p.setZoom(2); const v = document.querySelector('#viewport'); v.scrollLeft = v.scrollTop = 0; });
    await frame();
    const mod = await P(() => (/Mac|iPhone|iPad/.test(navigator.platform) ? 'Meta' : 'Control'));
    const guides = () => P(() => (window.__paint.drag && window.__paint.drag.guides) || []);
    const shownGuides = async () => { await frame(); return page.locator('#guides div:not([hidden]):not(.m)').count(); };
    const shownMarks = async () => { await frame(); return page.locator('#guides .m:not([hidden])').count(); };
    const byId = async (id) => (await objs()).find((x) => x.id === id);
    await page.keyboard.press('KeyR');
    await drag([[40, 40], [100, 100]]); // A: x 40..100, y 40..100
    const A = await objSel();
    await drag([[220, 200], [280, 240]]); // B: x 220..280, y 200..240
    const B = await objSel();
    await page.keyboard.press('KeyV');
    let g35 = null, n35 = 0, m35 = 0;
    const d35 = await depth();
    await drag([[235, 200], [117, 200]], async () => { g35 = await guides(); n35 = await shownGuides(); m35 = await shownMarks(); }); // left edge 102 → A's right, 100
    o = await byId(B);
    ok(o.a.x === 100 && o.b.x === 160 && o.a.y === 200, 'a move 2 px from another object\'s edge snaps onto it: ' + JSON.stringify([o.a, o.b]));
    ok(JSON.stringify(g35) === JSON.stringify([{ x: 100, lo: 40, hi: 240, at: [40, 100, 200, 240] }]) && n35 === 1, 'one guide while it lines up, through the corners on it: ' + JSON.stringify(g35) + ' ' + n35);
    ok(m35 === 4, 'a × on each of those four corners: ' + m35);
    ok(await shownGuides() === 0 && await shownMarks() === 0, 'the guide and its marks go on release');
    ok(await depth() === d35 + 1, 'a snapped move is one undo step');
    await page.keyboard.press('Meta+KeyZ');
    ok((await byId(B)).a.x === 220, 'undo puts it back');
    await page.keyboard.press('Meta+Shift+KeyZ');
    ok((await byId(B)).a.x === 100, 'redo snaps it again');
    // ⌘ (Ctrl elsewhere) held: no snapping; pressed or released mid-drag, it takes effect without a move.
    {
      await page.keyboard.down(mod);
      const [x0, y0] = await at(115, 200); await page.mouse.move(x0, y0); await page.mouse.down();
      const [x1, y1] = await at(117, 200); await page.mouse.move(x1, y1, { steps: 4 });
      await frame();
      const free = (await byId(B)).a.x, gFree = await guides();
      await page.keyboard.up(mod); await frame();
      const snapped = (await byId(B)).a.x, gSnap = await guides();
      await page.keyboard.down(mod); await frame();
      const freeAgain = (await byId(B)).a.x;
      await page.mouse.up(); await page.keyboard.up(mod); await frame();
      ok(free === 102 && gFree.length === 0, `${mod} held: the move is exact, no guide: ` + free);
      ok(snapped === 100 && gSnap.length === 1, `${mod} released mid-drag: it snaps at once: ` + snapped);
      ok(freeAgain === 102 && (await byId(B)).a.x === 102, `${mod} pressed again: free again, and it stays where it was dropped`);
    }
    // Shift locks the axis; the free one still snaps (centre 198 → the canvas centre, 200).
    await page.keyboard.down('Shift');
    await drag([[117, 200], [183, 203]], async () => { g35 = await guides(); });
    await page.keyboard.up('Shift');
    o = await byId(B);
    ok(o.a.x === 170 && o.a.y === 200, 'Shift: along x only, centre snapped to the canvas centre: ' + JSON.stringify(o.a));
    ok(JSON.stringify(g35) === JSON.stringify([{ x: 200, lo: 160, hi: 220, at: [160, 220] }]), 'a centre guide runs from the canvas centre to its centre: ' + JSON.stringify(g35));
    // A resize handle snaps the edge it drags (bottom 318 → the canvas bottom, 320).
    await drag([[200, 240], [201, 318]], async () => { g35 = await guides(); });
    o = await byId(B);
    ok(o.a.x === 170 && o.b.x === 230 && o.b.y === 320, 'the bottom handle snaps to the canvas edge: ' + JSON.stringify([o.a, o.b]));
    ok(JSON.stringify(g35) === JSON.stringify([{ y: 320, lo: 0, hi: 400, at: [0, 170, 230, 400] }]), 'a guide along the canvas edge, through the dragged side\'s corners: ' + JSON.stringify(g35));
    // ⌥-drag: the copy keeps in line with its original when dragged about straight down.
    const count35 = (await objs()).length;
    await page.keyboard.down('Alt');
    await drag([[40, 55], [42, 175]]);
    await page.keyboard.up('Alt');
    const all35 = await objs(), sel35 = await objSel(), dup35 = all35.find((x) => x.id === sel35);
    ok(all35.length === count35 + 1 && dup35.id !== A && dup35.a.x === 40 && dup35.a.y === 160 && (await byId(A)).a.y === 40,
      'a copy dragged 2 px off its original snaps back in line (and its top to the canvas middle): ' + JSON.stringify(dup35 && dup35.a));
    // Esc mid-drag: the guides go with the drag.
    await drag([[40, 175], [42, 200]], async () => {
      ok((await guides()).length > 0 && await shownGuides() > 0, 'guides while lined up');
      await page.keyboard.press('Escape');
      ok(await shownGuides() === 0 && await shownMarks() === 0, 'Esc mid-drag hides the guides and marks');
    });
    ok((await byId(dup35.id)).a.y === 160, 'Esc put the copy back');
    // A group snaps by the box around it: A and the copy, bottom 218 → 320 (B's bottom and the canvas edge).
    await drag([[20, 20], [120, 230]]); // box-select A and the copy (not B, from x 170)
    ok(JSON.stringify((await P(() => window.__paint.selList().map((x) => x.id))).sort()) === JSON.stringify([A, dup35.id].sort()), 'A and the copy selected');
    await drag([[40, 55], [40, 153]], async () => { g35 = await guides(); });
    ok((await byId(A)).a.y === 140 && (await byId(dup35.id)).a.y === 260, 'the group moved until its box\'s bottom met 320');
    ok(JSON.stringify(g35) === JSON.stringify([{ y: 320, lo: 0, hi: 400, at: [0, 40, 100, 170, 230, 400] }]), 'one guide for the two lines at 320: ' + JSON.stringify(g35));
    // The group box's side handle snaps too (right 167 → B's left, 170); with Shift (keep proportions) a resize doesn't snap.
    await drag([[100, 230], [167, 230]], async () => { g35 = await guides(); });
    ok((await byId(A)).b.x === 170 && g35.length === 1 && g35[0].x === 170, 'the group box\'s right side snaps to B\'s left: ' + JSON.stringify(await byId(A)));
    await page.keyboard.press('Meta+KeyZ');
    await page.keyboard.down('Shift');
    await drag([[100, 230], [167, 230]], async () => { g35 = await guides(); });
    await page.keyboard.up('Shift');
    ok((await byId(A)).b.x === 167 && g35.length === 0, 'Shift: kept proportions, no snapping: ' + JSON.stringify(await byId(A)));
    await page.keyboard.press('Meta+KeyZ');
    ok((await byId(A)).b.x === 100 && (await byId(A)).a.y === 140, 'both undone');
    // A line's end snaps its point: (350, 60) → (398, 138) → x 400 (the canvas edge), y 140 (A's top).
    await page.keyboard.press('KeyL');
    await drag([[300, 20], [350, 60]]);
    const L35 = await objSel();
    await drag([[350, 60], [398, 138]], async () => { g35 = await guides(); });
    o = await byId(L35);
    ok(o.a.x === 300 && o.a.y === 20 && o.b.x === 400 && o.b.y === 140, 'a line end snaps on both axes: ' + JSON.stringify([o.a, o.b]));
    ok(g35.length === 2 && g35[0].x === 400 && g35[1].y === 140, 'a guide on each: ' + JSON.stringify(g35));

    // ---- 36. review findings 7–9: no-op restyles, Cut after the copy, focus after box-select ----
    await P(() => { const p = window.__paint; p.newDoc(300, 200); p.setZoom(2); p.S.pristine = false; p.S.primary = '#000000';
      const v = document.querySelector('#viewport'); v.scrollLeft = v.scrollTop = 0; });
    await P(() => { const c = document.createElement('canvas'); c.width = 30; c.height = 20; c.getContext('2d').fillRect(0, 0, 30, 20);
      const p = window.__paint; p.pasteImage(c); p.setTool('move'); p.selectObj(p.userObjs[0].id); });
    let d36 = await depth();
    await P(() => { window.__paint.setColor('primary', '#ed1c24'); window.__paint.setColor('secondary', '#22b14c'); });
    ok(await depth() === d36, 'colour picks with an image selected add no undo steps (an image draws with no colour)');
    await page.keyboard.press('KeyP'); await drag([[150, 50], [200, 50]]);
    await P(() => { const p = window.__paint; p.setTool('move'); p.selectObj(p.userObjs[1].id); });
    d36 = await depth();
    await P(() => window.__paint.setColor('secondary', '#3f48cc'));
    ok(await depth() === d36, 'colour 2 with a pencil stroke selected adds no undo step');
    await P(() => window.__paint.setColor('primary', '#3f48cc'));
    ok(await depth() === d36 + 1 && (await objs())[1].color === '#3f48cc', 'colour 1 still restyles the stroke');
    // Cut: a refused clipboard write leaves the selection; an accepted one deletes it.
    await P(() => { navigator.clipboard.write = async () => { throw new DOMException('no', 'NotAllowedError'); }; });
    await P(() => window.__paint.copySel(true));
    ok((await objs()).length === 2 && /^Copy failed/.test(await page.locator('#toast').textContent()), 'a Cut whose clipboard write fails deletes nothing');
    await P(() => { navigator.clipboard.write = async () => {}; });
    await P(() => window.__paint.copySel(true));
    ok((await objs()).length === 1 && /^Cut/.test(await page.locator('#toast').textContent()), 'a Cut that copied deletes the selection');
    // Box-select after keyboard-activating the Move button: focus leaves the toolbar, so Delete reaches the objects.
    await page.keyboard.press('KeyR'); await drag([[20, 120], [60, 160]]);
    await P(() => document.querySelector('[data-tool="move"]').focus());
    await page.keyboard.press('Enter');
    ok(await P(() => document.activeElement.dataset.tool) === 'move', 'Enter on the Move button keeps focus there');
    await drag([[290, 190], [10, 10]]); // from empty canvas, over the image and the rect
    const f36 = await P(() => [window.__paint.selList().length, document.activeElement.tagName, document.activeElement.id, document.activeElement.dataset.tool].join());
    ok(/^2,BODY/.test(f36), 'box-select selects both and releases focus: ' + f36);
    await page.keyboard.press('Delete'); await frame();
    ok((await objs()).length === 0, 'so Delete deletes them');

    ok(errs.length === 0, 'no page errors: ' + errs.join(' | '));
  } catch (e) {
    fails++; console.log('FAIL: threw', e);
  } finally {
    await browser.close();
    console.log(`${passes} passed, ${fails} failed`);
    process.exit(fails ? 1 : 0);
  }
})();
