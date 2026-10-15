// Bundled-library e2e test (Playwright + installed Chrome). Dev-only, like smoke.js.
// usage: node libs.js [url]   exit 0 = all pass
// pica (resize), UTIF (open TIFF) and UPNG (smaller PNG, in png-worker.js) are bundled into chunks
// that load on first use, from the app's own server (and offline, from the service worker). Checks
// that boot loads none of them, that each library path actually runs (a silent fallback must not
// pass), that each feature keeps its built-in path past the library's budget, the results
// (pixel-exact TIFF and PNG round trips, less moiré than the built-in resampler), that the page
// asks no other server for anything, and that the paint bucket runs in its worker. Then, with the
// chunks and workers blocked (a tab left open across a deploy), that each feature still works or
// says why not.
const { chromium } = require('playwright');
const path = require('path');
const url = process.argv[2] || 'http://localhost:8765/';
const FIX = path.join(__dirname, '..', 'fixtures');
let fails = 0, passes = 0;
const ok = (c, m) => { if (c) passes++; else { fails++; console.log('FAIL:', m); } };
// A load that never settles would hang the run (page.evaluate has no timeout): fail instead.
let at = 'start';
setTimeout(() => { console.log(`FAIL: timed out during ${at}`); console.log(`${passes} passed, ${fails + 1} failed`); process.exit(1); }, 120000).unref();

// The fixtures' pixels as written by the generator (PIL), row by row: red, green, blue, white at
// alpha 128; black, white, transparent, yellow. rgb-lzw.tif has no alpha channel, so it's opaque.
const RGBA = [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255], [255, 255, 255, 128],
  [0, 0, 0, 255], [255, 255, 255, 255], [0, 0, 0, 0], [255, 255, 0, 255]];
const RGB = RGBA.map(([r, g, b, a]) => (a === 0 ? [0, 0, 0, 255] : [r, g, b, 255]));
const flat = (px) => px.flat().join(',');

// A TIFF header that claims 12000 × 12000 px (144 MP) and holds no pixel data.
function hugeTiff() {
  const tags = [[256, 4, 12000], [257, 4, 12000], [258, 3, 8], [259, 3, 1], [262, 3, 2], [273, 4, 0], [277, 3, 3], [279, 4, 0]];
  const b = Buffer.alloc(8 + 2 + tags.length * 12 + 4);
  b.write('II', 0); b.writeUInt16LE(42, 2); b.writeUInt32LE(8, 4); b.writeUInt16LE(tags.length, 8);
  tags.forEach(([tag, type, v], i) => {
    const o = 10 + i * 12;
    b.writeUInt16LE(tag, o); b.writeUInt16LE(type, o + 2); b.writeUInt32LE(1, o + 4);
    if (type === 3) b.writeUInt16LE(v, o + 8); else b.writeUInt32LE(v, o + 8);
  });
  return b;
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome' });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    const errs = [], remote = [];
    page.on('pageerror', (e) => errs.push(e.message));
    page.on('dialog', (d) => d.accept());
    const requested = [];
    page.on('request', (r) => { requested.push(r.url()); if (!/^(blob:|data:|http:\/\/localhost[:/])/.test(r.url())) remote.push(r.url()); });
    await page.goto(url);
    await page.waitForFunction(() => window.__paint);
    await page.waitForTimeout(300); // past the load event
    const P = (f, a) => page.evaluate(f, a);
    const toast = () => page.locator('#toast').textContent();
    at = 'checks';
    const LAZY = /\/(chunks\/(pica|UTIF)-[^/]*|fill-worker|png-worker)\.js$/;
    ok(!requested.some((u) => LAZY.test(u)), 'boot loads no library chunk or worker: ' + requested.filter((u) => LAZY.test(u)).join(' '));

    // ---- resize: pica online, built-in otherwise; a clean result either way
    const t0 = Date.now();
    const r = await P(async () => {
      const p = window.__paint, g = p.img.getContext('2d');
      g.clearRect(0, 0, p.img.width, p.img.height);
      g.fillStyle = '#ff0000'; g.fillRect(100, 100, 200, 200); // opaque red on transparent
      const w0 = p.img.width, h0 = p.img.height;
      await p.resizeDoc(Math.round(w0 / 3), Math.round(h0 / 3), 'scale');
      const d = p.img.getContext('2d').getImageData(0, 0, p.img.width, p.img.height).data;
      let dark = 0, red = 0;
      for (let i = 0; i < d.length; i += 4) { if (d[i + 3] > 8 && d[i] < 200) dark++; if (d[i] === 255 && d[i + 3] === 255) red++; }
      const sized = [p.img.width, p.img.height];
      p.undo();
      return { sized, want: [Math.round(w0 / 3), Math.round(h0 / 3)], back: [p.img.width, p.img.height], orig: [w0, h0], used: p.used.resize, dark, red };
    });
    const took = Date.now() - t0;
    ok(r.used === 'pica', `resize ran ${r.used}`);
    ok(r.sized.join() === r.want.join(), `resize gives ${r.want} (got ${r.sized})`);
    ok(r.back.join() === r.orig.join(), 'undo restores the size');
    ok(r.dark === 0, `no dark fringe on a transparent edge (${r.dark} px)`);
    ok(r.red > 3000, `square still solid red (${r.red} px)`);
    ok(took < 8000, `resize took ${took} ms`);

    // ---- past pica's size budget, the built-in path runs even online
    const big = await P(async () => {
      const p = window.__paint;
      await p.resizeDoc(7100, 7100, 'canvas', 'tl'); // 50.4 MP + the result: over the 50 MP budget
      const t = performance.now();
      await p.resizeDoc(100, 100, 'scale');
      const r = { used: p.used.resize, ms: performance.now() - t, w: p.img.width };
      p.undo(); p.undo();
      return r;
    });
    ok(big.used === 'builtin' && big.w === 100 && big.ms < 2000, `50 MP resize uses the built-in path (${big.used}, ${Math.round(big.ms)} ms)`);

    // ---- resize quality: moiré on a zone plate ÷3 (ideal output beyond the new Nyquist = flat gray),
    // pica against the built-in resampler on the same source
    const alias = await P(async () => {
      const p = window.__paint, W = 1500, K = 900, F = 3, w = W / F;
      const src = document.createElement('canvas'); src.width = src.height = W;
      const g = src.getContext('2d'), id = g.createImageData(W, W);
      for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        id.data[i] = id.data[i + 1] = id.data[i + 2] = 127.5 + 127.5 * Math.cos(((x + 0.5 - W / 2) ** 2 + (y + 0.5 - W / 2) ** 2) / K);
        id.data[i + 3] = 255;
      }
      g.putImageData(id, 0, 0);
      const rms = (c) => {
        const d = c.getContext('2d').getImageData(0, 0, w, w).data, rNyq = Math.PI * K / (2 * F);
        let e = 0, n = 0;
        for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) {
          const r = Math.hypot((x + 0.5) * F - W / 2, (y + 0.5) * F - W / 2);
          if (r > rNyq * 1.15 && r < W / 2) { e += (d[(y * w + x) * 4] - 127.5) ** 2; n++; }
        }
        return Math.sqrt(e / n);
      };
      const lanczos = await p.scaleImage(src, w, w), viaPica = p.used.resize;
      return { pica: rms(lanczos), builtin: rms(p.resample(src, w, w)), viaPica };
    });
    ok(alias.viaPica === 'pica' && alias.pica < alias.builtin * 0.8, `pica has less moiré than the built-in resampler (${alias.pica.toFixed(1)} vs ${alias.builtin.toFixed(1)}, ${alias.viaPica})`);

    // ---- a resize whose source changes while it runs is dropped, not applied over the edit
    {
      const s = await P(async () => {
        const p = window.__paint, before = [p.img.width, p.img.height];
        const run = p.resizeDoc(50, 40, 'scale');
        p.transformDoc('rotR');
        await run;
        return { before, after: [p.img.width, p.img.height], toast: document.querySelector('#toast').textContent };
      });
      ok(s.after.join() === [s.before[1], s.before[0]].join(), `stale resize dropped; the rotate stays (${s.before} -> ${s.after})`);
      ok(/^Resize failed: the image changed/.test(s.toast), 'stale resize says so: ' + s.toast);
    }

    // ---- open TIFF with UTIF
    await P(() => window.__paint.resizeDoc(321, 123, 'canvas', 'tl')); // not 4 × 2, so an open shows
    for (const [f, want] of [['rgba-raw.tif', RGBA], ['rgba-deflate.tif', RGBA], ['rgb-lzw.tif', RGB]]) {
      await page.setInputFiles('#fileInput', path.join(FIX, f));
      await page.waitForFunction((f) => window.__paint.S.fileName === f || /TIFF/.test(document.querySelector('#toast').textContent), f, { timeout: 8000 }).catch(() => {});
      const got = await P(() => { const p = window.__paint; return { name: p.S.fileName, w: p.img.width, h: p.img.height, px: [...p.img.getContext('2d').getImageData(0, 0, p.img.width, p.img.height).data].join(',') }; });
      ok(got.name === f && got.w === 4 && got.h === 2, `${f} opens at 4 × 2 (${got.name} ${got.w}×${got.h})`);
      ok(got.px === flat(want), `${f} pixels exact: ${got.px.slice(0, 80)}`);
    }
    {
      // Saving a TIFF writes a PNG copy: there's no TIFF encoder.
      const log = await P(async () => {
        const p = window.__paint, log = [];
        window.showSaveFilePicker = async (o) => { log.push(o.suggestedName); return { name: o.suggestedName, createWritable: async () => ({ write: async () => {}, close: async () => {} }) }; };
        await p.save(false);
        return log;
      });
      ok(log.join() === 'rgb-lzw.png', `saving a TIFF asks for a PNG copy (${log})`);
      await page.setInputFiles('#fileInput', { name: 'big.tif', mimeType: 'image/tiff', buffer: hugeTiff() });
      await page.waitForTimeout(500);
      ok(/Can't open big\.tif: .*144 MP.*limit/.test(await toast()), 'huge TIFF refused before decoding: ' + await toast());
      await page.setInputFiles('#fileInput', { name: 'fake.tif', mimeType: 'image/tiff', buffer: Buffer.from('not a tiff at all') });
      await page.waitForTimeout(500);
      ok(/Can't open fake\.tif: it isn’t a TIFF image/.test(await toast()), 'bad TIFF explained: ' + await toast());
      // the drop path decodes TIFF too
      const b64 = require('fs').readFileSync(path.join(FIX, 'rgba-deflate.tif')).toString('base64');
      await P((b64) => {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const dt = new DataTransfer(); dt.items.add(new File([bytes], 'dropped.tif', { type: 'image/tiff' }));
        window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
      }, b64);
      await page.waitForFunction(() => window.__paint.S.fileName === 'dropped.tif', null, { timeout: 5000 }).catch(() => {});
      ok(await P(() => window.__paint.S.fileName + ' ' + window.__paint.img.width) === 'dropped.tif 4', 'dropped TIFF opens');
    }
    // Formats the browser decodes open as before.
    const pngBuf = Buffer.from(await P(async () => {
      const c = document.createElement('canvas'); c.width = 30; c.height = 20;
      const g = c.getContext('2d'); g.fillStyle = '#22b14c'; g.fillRect(0, 0, 30, 20);
      const b = await new Promise((r) => c.toBlob(r, 'image/png'));
      return [...new Uint8Array(await b.arrayBuffer())];
    }));
    await page.setInputFiles('#fileInput', { name: 'green.png', mimeType: 'image/png', buffer: pngBuf });
    await page.waitForFunction(() => window.__paint.S.fileName === 'green.png', null, { timeout: 5000 }).catch(() => {});
    ok(await P(() => window.__paint.S.fileName + ' ' + window.__paint.img.width) === 'green.png 30', 'PNG still opens');

    // ---- PNG save: UPNG within its budgets (smaller, lossless), built-in otherwise; the file decodes to the canvas.
    // UPNG writes a palette PNG (with tRNS) for <= 256 colours and truecolour + alpha otherwise: one
    // scene each, both with transparent and semi-transparent pixels. Noisy scenes are slow for UPNG:
    // a small one is within its time budget, a large one isn't. The last is over the size cap.
    const PNG_CASES = [
      // [label, w, h, scene, colours: 'palette' | 'truecolor', UPNG expected]
      ['palette', 640, 400, 'flat', 'palette', true],
      ['truecolor + alpha', 640, 400, 'soft', 'truecolor', true],
      ['small noisy', 1600, 1000, 'noise', 'truecolor', true],
      ['noisy, over the time budget', 3000, 2000, 'noise', 'truecolor', false],
      ['over the size cap', 4000, 2200, 'flat', 'palette', false],
    ];
    for (const [label, w, h, scene, kind, wantUpng] of PNG_CASES) {
      const s = await P(async ([w, h, scene]) => {
        const p = window.__paint;
        await p.resizeDoc(w, h, 'canvas', 'tl');
        const g = p.img.getContext('2d');
        if (scene === 'flat') { // a few exact colours: no antialiasing
          g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h);
          g.clearRect(0, 0, 120, 80);
          g.fillStyle = 'rgba(63, 72, 204, 0.5)'; g.fillRect(60, 40, 200, 120);
          g.fillStyle = '#ed1c24'; g.fillRect(300, 100, 50, 250);
        } else if (scene === 'soft') { // gradients and antialiased text, with varying alpha
          const gr = g.createLinearGradient(0, 0, w, h); gr.addColorStop(0, 'rgba(255,0,0,0.2)'); gr.addColorStop(1, 'rgba(0,0,255,1)');
          g.clearRect(0, 0, w, h); g.fillStyle = gr; g.fillRect(40, 0, w - 40, h);
          g.font = '16px sans-serif'; g.fillStyle = '#222';
          for (let y = 20; y < h; y += 20) g.fillText('The quick brown fox jumps over the lazy dog', 10, y);
        } else { // photo-like: smooth colour plus per-pixel noise, opaque
          const id = g.createImageData(w, h), d = id.data;
          let r = 1;
          for (let i = 0; i < d.length; i += 4) {
            r = (r * 1103515245 + 12345) & 0x7fffffff;
            const x = (i / 4) % w, y = (i / 4 / w) | 0, n = ((r >> 16) % 24) - 12;
            d[i] = 120 + 80 * Math.sin(x / 90) + n; d[i + 1] = 110 + 70 * Math.cos(y / 70) + n; d[i + 2] = 100 + 60 * Math.sin((x + y) / 130) + n; d[i + 3] = 255;
          }
          g.putImageData(id, 0, 0);
        }
        const b = g.getImageData(0, 0, w, h).data, colours = new Set(), u32 = new Uint32Array(b.buffer);
        for (let i = 0; i < u32.length && colours.size <= 256; i++) colours.add(u32[i]);
        let blob = null;
        p.S.fileName = 'out.png';
        p.S.fileHandle = { name: 'out.png', queryPermission: async () => 'granted', requestPermission: async () => 'granted',
          createWritable: async () => ({ write: async (x) => { blob = x; }, close: async () => {} }) };
        await p.save(false);
        const native = await new Promise((r) => p.img.toBlob(r, 'image/png'));
        if (!blob) return { err: document.querySelector('#toast').textContent };
        const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
        const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
        const cg = c.getContext('2d'); cg.drawImage(bmp, 0, 0);
        const a = cg.getImageData(0, 0, c.width, c.height).data;
        let diff = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
        const head = new Uint8Array(await blob.slice(0, 33).arrayBuffer()); // IHDR colour type: 3 = palette, 6 = RGBA
        return { used: p.used.png, size: blob.size, native: native.size, dims: [bmp.width, bmp.height], diff, clean: p.hist.isClean(), colours: colours.size, ctype: head[25] };
      }, [w, h, scene]);
      if (s.err) { ok(false, `${label}: save failed: ${s.err}`); continue; }
      ok((kind === 'palette') === (s.colours <= 256), `${label}: scene has ${s.colours > 256 ? '> 256' : s.colours} colours`);
      ok(s.used === (wantUpng ? 'upng' : 'builtin'), `${label}: PNG encoded by ${s.used}`);
      // colour type: 3 = palette (+ tRNS), 6 = RGBA, 2 = RGB (the noisy scenes are opaque)
      if (wantUpng) ok(s.ctype === (kind === 'palette' ? 3 : scene === 'noise' ? 2 : 6), `${label}: UPNG wrote colour type ${s.ctype}`);
      ok(s.dims.join() === [w, h].join() && s.diff === 0, `${label}: saved PNG decodes to the same pixels (${s.diff} bytes differ)`);
      ok(wantUpng ? s.size < s.native : s.size === s.native, `${label}: ${s.size} B vs the browser's ${s.native} B`);
      ok(s.clean, `${label}: saved state is clean`);
    }

    // ---- the paint bucket: filled in its worker, and undoes exactly
    const fillAt = async (pg, color) => {
      const b = await pg.locator('#overlay').boundingBox();
      await pg.evaluate((c) => { const p = window.__paint; p.setTool('fill'); p.S.tolerance = 0; p.S.primary = c; }, color);
      await pg.mouse.click(b.x + 3, b.y + 3);
      return pg.evaluate(async () => {
        const p = window.__paint;
        await p.filling;
        const d = p.img.getContext('2d').getImageData(0, 0, 1, 1).data;
        return { used: p.used.fill, px: [...d].join(), steps: p.hist.undoStack.length };
      });
    };
    await P(() => { const p = window.__paint; p.newDoc(300, 200); p.fitZoom(false); });
    const f1 = await fillAt(page, '#ff0000');
    ok(f1.used === 'worker' && f1.px === '255,0,0,255' && f1.steps === 1, 'fill runs in its worker: ' + JSON.stringify(f1));
    ok(await P(() => { window.__paint.undo(); return [...window.__paint.img.getContext('2d').getImageData(0, 0, 1, 1).data].join(); }) === '255,255,255,255', 'undo of the worker fill restores white');
    // the page stays live during a fill: an edit that lands first wins, and the fill is dropped
    await P(() => { const p = window.__paint; p.newDoc(6000, 4000); p.fitZoom(false); });
    await fillAt(page, '#ff0000');
    await P(() => { window.__paint.S.primary = '#0000ff'; });
    const ob = await page.locator('#overlay').boundingBox();
    await page.mouse.click(ob.x + 3, ob.y + 3);
    const race = await P(async () => {
      const p = window.__paint, running = !!p.filling;
      p.undo(); // the red fill, while the blue one is still in its worker
      await p.filling;
      return { running, px: [...p.img.getContext('2d').getImageData(0, 0, 1, 1).data].join(), undo: p.hist.undoStack.length, redo: p.hist.redoStack.length, toast: document.querySelector('#toast').textContent };
    });
    ok(race.running, 'the 24 MP fill was still running when undo came');
    // ...but panning around while it runs changes no pixels: the fill lands
    await P(() => { window.__paint.S.primary = '#00ff00'; document.querySelector('#toast').textContent = ''; }); // the race's toast may still show
    await page.mouse.click(ob.x + 3, ob.y + 3);
    await page.mouse.move(ob.x + 200, ob.y + 200);
    await page.keyboard.down('Space');
    await page.mouse.down();
    await page.mouse.move(ob.x + 150, ob.y + 170, { steps: 3 });
    const pan = await P(async () => {
      const p = window.__paint, running = !!p.filling, during = p.drag && p.drag.t;
      await p.filling;
      return { running, during, steps: p.hist.undoStack.length, toast: document.querySelector('#toast').textContent };
    });
    await page.mouse.up();
    await page.keyboard.up('Space');
    const panPx = await P(() => [...window.__paint.img.getContext('2d').getImageData(0, 0, 1, 1).data].join());
    ok(pan.running && pan.during === 'pan', 'the fill was still running during the pan: ' + JSON.stringify(pan));
    ok(pan.steps === 1 && panPx === '0,255,0,255' && !/cancelled/.test(pan.toast), 'a fill lands under a pan: ' + JSON.stringify({ ...pan, panPx }));
    ok(race.px === '255,255,255,255' && race.undo === 0 && race.redo === 1 && /Fill cancelled: the image changed/.test(race.toast), 'a fill whose image changed meanwhile is dropped: ' + JSON.stringify(race));

    ok(remote.length === 0, 'no requests leave the machine: ' + remote.slice(0, 3).join(' '));
    ok(errs.length === 0, 'no page errors: ' + errs.join(' | '));

    // ---- chunks and workers that don't load: the built-in paths, or a reason
    at = 'blocked';
    const bctx = await browser.newContext({ viewport: { width: 1000, height: 700 } }); // its own HTTP cache
    await bctx.route(LAZY, (r) => r.fulfill({ status: 404, body: 'gone' })); // the workers' requests too
    const bp = await bctx.newPage();
    const berrs = [];
    bp.on('pageerror', (e) => berrs.push(e.message));
    await bp.goto(url);
    await bp.waitForFunction(() => window.__paint);
    await bp.evaluate(() => { const p = window.__paint; p.newDoc(300, 200); p.fitZoom(false); });
    const f2 = await fillAt(bp, '#0000ff');
    ok(f2.used === 'main' && f2.px === '0,0,255,255' && f2.steps === 1, 'fill without its worker runs on the main thread: ' + JSON.stringify(f2));
    const f3 = await fillAt(bp, '#00ff00');
    ok(f3.used === 'main' && f3.px === '0,255,0,255' && f3.steps === 2, 'a second fill goes straight to the main thread: ' + JSON.stringify(f3));
    const rz = await bp.evaluate(async () => { const p = window.__paint; await p.resizeDoc(100, 50, 'scale'); return [p.used.resize, p.img.width, p.img.height].join(); });
    ok(rz === 'builtin,100,50', 'resize without the pica chunk uses the built-in resampler: ' + rz);
    const tif = require('fs').readFileSync(path.join(FIX, 'rgba-deflate.tif')).toString('base64');
    await bp.evaluate((b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer(); dt.items.add(new File([bytes], 'nochunk.tif', { type: 'image/tiff' }));
      window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    }, tif);
    await bp.waitForFunction(() => /nochunk/.test(document.querySelector('#toast').textContent), null, { timeout: 5000 }).catch(() => {});
    const tt = await bp.locator('#toast').textContent();
    ok(/Can't open nochunk\.tif: the TIFF reader didn’t load\. Reload the page/.test(tt), 'TIFF without its chunk says to reload: ' + tt);
    const png = await bp.evaluate(async () => {
      const p = window.__paint;
      p.newDoc(200, 100);
      let blob = null;
      p.S.fileName = 'out.png';
      p.S.fileHandle = { name: 'out.png', queryPermission: async () => 'granted', requestPermission: async () => 'granted',
        createWritable: async () => ({ write: async (x) => { blob = x; }, close: async () => {} }) };
      await p.save(false);
      return { used: p.used.png, ok: !!blob && blob.type === 'image/png' && blob.size > 0 };
    });
    ok(png.used === 'builtin' && png.ok, 'PNG save without its worker uses the browser encoder: ' + JSON.stringify(png));
    ok(berrs.length === 0, 'blocked: no page errors: ' + berrs.join(' | '));
    await bctx.close();
  } finally {
    await browser.close();
  }
  console.log(`${passes} passed, ${fails} failed`);
  process.exit(fails || !passes ? 1 : 0);
})().catch((e) => { console.log(`FAIL: ${at}: ${e.message.split('\n')[0]}`); process.exit(1); });
