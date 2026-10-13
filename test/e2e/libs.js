// Optional-library e2e test (Playwright + installed Chrome). Dev-only, like smoke.js.
// usage: node libs.js [url]   exit 0 = all pass
// pica (resize), UTIF (open TIFF) and UPNG (smaller PNG) load from a CDN when the page is idle after
// boot; each feature has a built-in path. Checks three network conditions: online (the library path
// must actually run), offline (CDN blocked, then context.setOffline: the built-in paths run, a notice
// says so once, TIFF says why it can't open) and a CDN that never answers (the load times out, falls
// back, and a late arrival is still used). Then, with a persistent profile on file://: libraries
// loaded once come from the HTTP cache after a restart while offline. Request routing turns the HTTP
// cache off, so that part uses none.
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const os = require('os');
const url = process.argv[2] || 'http://localhost:8765/';
const FIX = path.join(__dirname, '..', 'fixtures');
let fails = 0, passes = 0;
const ok = (c, m) => { if (c) passes++; else { fails++; console.log('FAIL:', m); } };
// A load that never settles would hang the run (page.evaluate has no timeout): fail instead.
let at = 'start';
setTimeout(() => { console.log(`FAIL: timed out during ${at}`); console.log(`${passes} passed, ${fails + 1} failed`); process.exit(1); }, 150000).unref();

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
  const aliasBy = {}; // zone-plate moiré per mode, compared at the end
  try {
    for (const mode of ['online', 'offline', 'hang']) {
      const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
      const page = await context.newPage();
      const errs = [], cdn = [];
      page.on('pageerror', (e) => errs.push(e.message));
      page.on('dialog', (d) => d.accept());
      page.on('request', (r) => { if (r.url().includes('cdn.jsdelivr.net')) cdn.push(r.url()); });
      // One route for the whole page, so no request slips through while the behaviour changes. It is
      // in place before the page loads, so the boot preload can't win a race with going offline.
      let cdnMode = mode === 'hang' ? 'hang' : 'abort'; // hang: never answers; abort: unreachable; pass: the real CDN
      const parked = []; // stalled requests, released when the CDN comes back
      if (mode !== 'online') await page.route('https://cdn.jsdelivr.net/**', (rt) => (cdnMode === 'hang' ? parked.push(rt) : cdnMode === 'abort' ? rt.abort() : rt.continue()));
      await page.goto(url);
      await page.waitForFunction(() => window.__paint);
      if (mode === 'offline') await context.setOffline(true); // navigator.onLine false: the notice says "offline"
      const P = (f, a) => page.evaluate(f, a);
      const toast = () => page.locator('#toast').textContent();
      const tag = (m) => `[${mode}] ${m}`;
      at = mode;

      const NOTE = mode === 'offline' ? 'Working offline: resize and PNG saves use the built-in versions'
        : 'Libraries couldn’t be loaded: resize and PNG saves use the built-in versions';
      // Boot preloads every library at idle, without any user action.
      if (mode === 'online') {
        await page.waitForFunction(() => ['pica', 'upng', 'utif', 'pako'].every((n) => window.__paint.libState[n] === 'ok'), null, { timeout: 10000 }).catch(() => {});
        const st = await P(() => window.__paint.libState);
        ok(['pica', 'upng', 'utif', 'pako'].every((n) => st[n] === 'ok'), tag('all libraries preloaded after boot: ' + JSON.stringify(st)));
      } else {
        await page.waitForTimeout(300);
        ok(cdn.length >= 2, tag(`boot tries to preload the libraries (${cdn.length} requests)`));
      }

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
        return { sized, want: [Math.round(w0 / 3), Math.round(h0 / 3)], back: [p.img.width, p.img.height], orig: [w0, h0], used: p.used.resize, state: p.libState.pica, dark, red };
      });
      const took = Date.now() - t0;
      ok(r.used === (mode === 'online' ? 'pica' : 'builtin'), tag(`resize ran ${r.used} (pica state ${r.state})`));
      ok(r.sized.join() === r.want.join(), tag(`resize gives ${r.want} (got ${r.sized})`));
      ok(r.back.join() === r.orig.join(), tag('undo restores the size'));
      ok(r.dark === 0, tag(`no dark fringe on a transparent edge (${r.dark} px)`));
      ok(r.red > 3000, tag(`square still solid red (${r.red} px)`));
      if (mode === 'hang') {
        ok(took >= 2000 && took < 8000, tag(`fell back once the preload timed out (${took} ms)`));
        ok((await toast()).startsWith(`Resized to ${r.want[0]} × ${r.want[1]} px. ${NOTE}.`), tag('slow fallback resize confirms and explains: ' + await toast()));
      } else if (mode === 'offline') {
        ok(await toast() === NOTE, tag('first fallback explains itself: ' + await toast()));
      } else {
        ok(!/built-in versions/.test(await toast()), tag('no fallback notice online: ' + await toast()));
      }
      // A failed load is remembered: the next resize doesn't wait or ask the network again.
      if (mode !== 'online') {
        const n = cdn.length, t1 = Date.now();
        await P(() => { document.querySelector('#toast').textContent = ''; return window.__paint.resizeDoc(400, 300, 'scale'); });
        ok(cdn.length === n && Date.now() - t1 < 1500, tag(`second resize doesn't retry the load (${cdn.length - n} requests, ${Date.now() - t1} ms)`));
        ok(!/built-in versions/.test(await toast()), tag('the notice is shown once: ' + await toast()));
        await P(() => window.__paint.undo());
      }

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
      ok(big.used === 'builtin' && big.w === 100 && big.ms < 2000, tag(`50 MP resize uses the built-in path (${big.used}, ${Math.round(big.ms)} ms)`));
      if (mode === 'online') ok(!/built-in versions/.test(await toast()), tag('skipping pica by size shows no notice: ' + await toast()));

      // ---- resize quality: moiré on a zone plate ÷3 (ideal output beyond the new Nyquist = flat gray)
      aliasBy[mode] = await P(async () => {
        const p = window.__paint, W = 1500, K = 900, F = 3, w = W / F;
        await p.resizeDoc(W, W, 'canvas', 'tl');
        const g = p.img.getContext('2d'), id = g.createImageData(W, W);
        for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
          const i = (y * W + x) * 4;
          id.data[i] = id.data[i + 1] = id.data[i + 2] = 127.5 + 127.5 * Math.cos(((x + 0.5 - W / 2) ** 2 + (y + 0.5 - W / 2) ** 2) / K);
          id.data[i + 3] = 255;
        }
        g.putImageData(id, 0, 0);
        await p.resizeDoc(w, w, 'scale');
        const d = p.img.getContext('2d').getImageData(0, 0, w, w).data, rNyq = Math.PI * K / (2 * F);
        let e = 0, n = 0;
        for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) {
          const r = Math.hypot((x + 0.5) * F - W / 2, (y + 0.5) * F - W / 2);
          if (r > rNyq * 1.15 && r < W / 2) { e += (d[(y * w + x) * 4] - 127.5) ** 2; n++; }
        }
        return Math.sqrt(e / n);
      });

      // ---- a resize whose source changes while it runs is dropped, not applied over the edit
      if (mode === 'hang') {
        await P(() => window.dispatchEvent(new Event('online'))); // forget the failure: the next load hangs again
        const s = await P(async () => {
          const p = window.__paint, before = [p.img.width, p.img.height];
          const run = p.resizeDoc(50, 40, 'scale');
          p.transformDoc('rotR');
          await run;
          return { before, after: [p.img.width, p.img.height], toast: document.querySelector('#toast').textContent };
        });
        ok(s.after.join() === [s.before[1], s.before[0]].join(), tag(`stale resize dropped; the rotate stays (${s.before} -> ${s.after})`));
        ok(/^Resize failed: the image changed/.test(s.toast), tag('stale resize says so: ' + s.toast));
        cdnMode = 'abort'; // the rest of this mode: unreachable
      }

      // ---- open TIFF: UTIF online; offline, a clear reason and the document stays
      await P(() => window.__paint.resizeDoc(321, 123, 'canvas', 'tl')); // not 4 × 2, so an open shows
      for (const [f, want] of [['rgba-raw.tif', RGBA], ['rgba-deflate.tif', RGBA], ['rgb-lzw.tif', RGB]]) {
        await page.setInputFiles('#fileInput', path.join(FIX, f));
        await page.waitForFunction((f) => window.__paint.S.fileName === f || /TIFF/.test(document.querySelector('#toast').textContent), f, { timeout: 8000 }).catch(() => {});
        const got = await P(() => { const p = window.__paint; return { name: p.S.fileName, w: p.img.width, h: p.img.height, px: [...p.img.getContext('2d').getImageData(0, 0, p.img.width, p.img.height).data].join(',') }; });
        if (mode === 'online') {
          ok(got.name === f && got.w === 4 && got.h === 2, tag(`${f} opens at 4 × 2 (${got.name} ${got.w}×${got.h})`));
          ok(got.px === flat(want), tag(`${f} pixels exact: ${got.px.slice(0, 80)}`));
        } else {
          ok(got.name !== f, tag(`${f} not opened without the library`));
          ok(/Can't open .*\.tif: the TIFF reader couldn’t be downloaded/.test(await toast()), tag('TIFF offline reason: ' + await toast()));
        }
      }
      if (mode === 'online') {
        // Saving a TIFF writes a PNG copy: there's no TIFF encoder.
        const log = await P(async () => {
          const p = window.__paint, log = [];
          window.showSaveFilePicker = async (o) => { log.push(o.suggestedName); return { name: o.suggestedName, createWritable: async () => ({ write: async () => {}, close: async () => {} }) }; };
          await p.save(false);
          return log;
        });
        ok(log.join() === 'rgb-lzw.png', tag(`saving a TIFF asks for a PNG copy (${log})`));
        await page.setInputFiles('#fileInput', { name: 'big.tif', mimeType: 'image/tiff', buffer: hugeTiff() });
        await page.waitForTimeout(500);
        ok(/Can't open big\.tif: .*144 MP.*limit/.test(await toast()), tag('huge TIFF refused before decoding: ' + await toast()));
        await page.setInputFiles('#fileInput', { name: 'fake.tif', mimeType: 'image/tiff', buffer: Buffer.from('not a tiff at all') });
        await page.waitForTimeout(500);
        ok(/Can't open fake\.tif: it isn’t a TIFF image/.test(await toast()), tag('bad TIFF explained: ' + await toast()));
        // the drop path decodes TIFF too
        const b64 = require('fs').readFileSync(path.join(FIX, 'rgba-deflate.tif')).toString('base64');
        await P((b64) => {
          const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
          const dt = new DataTransfer(); dt.items.add(new File([bytes], 'dropped.tif', { type: 'image/tiff' }));
          window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
        }, b64);
        await page.waitForFunction(() => window.__paint.S.fileName === 'dropped.tif', null, { timeout: 5000 }).catch(() => {});
        ok(await P(() => window.__paint.S.fileName + ' ' + window.__paint.img.width) === 'dropped.tif 4', tag('dropped TIFF opens'));
      }
      // Formats the browser decodes still open in every mode.
      const pngBuf = Buffer.from(await P(async () => {
        const c = document.createElement('canvas'); c.width = 30; c.height = 20;
        const g = c.getContext('2d'); g.fillStyle = '#22b14c'; g.fillRect(0, 0, 30, 20);
        const b = await new Promise((r) => c.toBlob(r, 'image/png'));
        return [...new Uint8Array(await b.arrayBuffer())];
      }));
      await page.setInputFiles('#fileInput', { name: 'green.png', mimeType: 'image/png', buffer: pngBuf });
      await page.waitForFunction(() => window.__paint.S.fileName === 'green.png', null, { timeout: 5000 }).catch(() => {});
      ok(await P(() => window.__paint.S.fileName + ' ' + window.__paint.img.width) === 'green.png 30', tag('PNG still opens'));

      // ---- PNG save: UPNG online (smaller, lossless), built-in otherwise; the file decodes to the canvas.
      // UPNG writes a palette PNG (with tRNS) for <= 256 colours and truecolour + alpha otherwise: one
      // scene each, both with transparent and semi-transparent pixels. Noisy scenes are slow for UPNG:
      // a small one is within its time budget, a large one isn't. The last is over the size cap.
      const PNG_CASES = [
        // [label, w, h, scene, colours: 'palette' | 'truecolor', UPNG expected when online]
        ['palette', 640, 400, 'flat', 'palette', true],
        ['truecolor + alpha', 640, 400, 'soft', 'truecolor', true],
        ['small noisy', 1600, 1000, 'noise', 'truecolor', true],
        ['noisy, over the time budget', 3000, 2000, 'noise', 'truecolor', false],
        ['over the size cap', 4000, 2200, 'flat', 'palette', false],
      ];
      for (const [label, w, h, scene, kind, upngOnline] of PNG_CASES) {
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
        if (s.err) { ok(false, tag(`${label}: save failed: ${s.err}`)); continue; }
        const wantUpng = mode === 'online' && upngOnline;
        ok((kind === 'palette') === (s.colours <= 256), tag(`${label}: scene has ${s.colours > 256 ? '> 256' : s.colours} colours`));
        ok(s.used === (wantUpng ? 'upng' : 'builtin'), tag(`${label}: PNG encoded by ${s.used}`));
        // colour type: 3 = palette (+ tRNS), 6 = RGBA, 2 = RGB (the noisy scenes are opaque)
        if (wantUpng) ok(s.ctype === (kind === 'palette' ? 3 : scene === 'noise' ? 2 : 6), tag(`${label}: UPNG wrote colour type ${s.ctype}`));
        ok(s.dims.join() === [w, h].join() && s.diff === 0, tag(`${label}: saved PNG decodes to the same pixels (${s.diff} bytes differ)`));
        ok(wantUpng ? s.size < s.native : s.size === s.native, tag(`${label}: ${s.size} B vs the browser's ${s.native} B`));
        ok(s.clean, tag(`${label}: saved state is clean`));
      }

      // ---- recovery. Offline: back online, failed libraries are tried again. Hang: the stalled
      // scripts arrive after their timeout, and are used without any online event.
      if (mode === 'offline') {
        await context.setOffline(false);
        cdnMode = 'pass';
        await P(() => window.dispatchEvent(new Event('online')));
        const u = await P(async () => { const p = window.__paint; await p.resizeDoc(100, 80, 'scale'); return p.used.resize; });
        ok(u === 'pica', tag(`after coming back online, resize uses pica (${u})`));
      } else if (mode === 'hang') {
        cdnMode = 'pass';
        for (const rt of parked.splice(0)) await rt.continue();
        await page.waitForFunction(() => !!window.pica, null, { timeout: 8000 }).catch(() => {});
        const u = await P(async () => { const p = window.__paint; await p.resizeDoc(100, 80, 'scale'); return p.used.resize; });
        ok(u === 'pica', tag(`a library that arrived after its timeout is used (${u})`));
      }

      ok(errs.length === 0, tag('no page errors: ' + errs.join(' | ')));
      await context.close();
    }
    ok(aliasBy.online < aliasBy.offline * 0.8, `pica has less moiré than the built-in resampler (${aliasBy.online.toFixed(1)} vs ${aliasBy.offline.toFixed(1)})`);

    // ---- one stalled library doesn't hold back the others (scripts must not run in insertion order)
    at = 'stall';
    {
      const page = await browser.newPage();
      await page.route('**/pica@*/**', () => {}); // only pica never answers
      await page.goto(url);
      await page.waitForFunction(() => ['upng', 'utif'].every((n) => window.__paint && window.__paint.libState[n] === 'ok'), null, { timeout: 10000 }).catch(() => {});
      const st = await page.evaluate(() => window.__paint.libState);
      ok(st.upng === 'ok' && st.utif === 'ok' && st.pica !== 'ok', `[stall] UPNG and UTIF load while pica stalls: ${JSON.stringify(st)}`);
      await page.close();
    }

    // ---- the notice: once a session, also when a PNG save is the first fallback
    at = 'notice';
    {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.route('https://cdn.jsdelivr.net/**', (rt) => rt.abort());
      await page.goto(url);
      await page.waitForFunction(() => window.__paint && window.__paint.libState.upng === 'failed', null, { timeout: 8000 }).catch(() => {});
      await context.setOffline(true);
      const t = await page.evaluate(async () => {
        const p = window.__paint, out = [];
        p.S.fileName = 'n.png';
        p.S.fileHandle = { name: 'n.png', queryPermission: async () => 'granted', createWritable: async () => ({ write: async () => {}, close: async () => {} }) };
        p.img.getContext('2d').fillRect(0, 0, 9, 9);
        await p.save(false); out.push(document.querySelector('#toast').textContent);
        await p.save(false); out.push(document.querySelector('#toast').textContent);
        p.S.fileName = 'n.jpg'; p.S.fileHandle = { ...p.S.fileHandle, name: 'n.jpg' };
        await p.resizeDoc(300, 200, 'scale'); out.push(document.querySelector('#toast').textContent);
        return out;
      });
      ok(t[0] === 'Saved n.png. Working offline: resize and PNG saves use the built-in versions.', '[notice] first fallback save explains itself: ' + t[0]);
      ok(t[1] === 'Saved n.png' && !/built-in/.test(t[2]), `[notice] shown once a session: ${t[1]} / ${t[2]}`);
      await context.close();
    }
  } finally {
    await browser.close();
  }

  // ---- HTTP cache: loaded once online, the libraries still work offline after a browser restart.
  // file:// only (offline emulation would block a localhost server too). No routes: they bypass the cache.
  at = 'cache';
  const fileUrl = url.startsWith('file:') ? url : 'file://' + path.join(__dirname, '..', '..', 'index.html');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'paint-libs-'));
  try {
    const launch = (offline) => chromium.launchPersistentContext(profile, { channel: 'chrome', offline });
    let ctx = await launch(false);
    let page = ctx.pages()[0] || await ctx.newPage();
    await page.goto(fileUrl);
    await page.waitForFunction(() => ['pica', 'upng', 'utif'].every((n) => window.__paint && window.__paint.libState[n] === 'ok'), null, { timeout: 10000 }).catch(() => {});
    ok(await page.evaluate(() => window.__paint.libState.pica === 'ok'), '[cache] libraries load online (priming the cache)');
    await ctx.close();
    ctx = await launch(true);
    page = ctx.pages()[0] || await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.goto(fileUrl);
    ok(await page.evaluate(() => navigator.onLine === false), '[cache] the restarted browser is offline');
    await page.waitForFunction(() => ['pica', 'upng', 'utif'].every((n) => window.__paint && window.__paint.libState[n] !== 'loading' && window.__paint.libState[n]), null, { timeout: 10000 }).catch(() => {});
    ok(await page.evaluate(() => ['pica', 'upng', 'utif'].every((n) => window.__paint.libState[n] === 'ok')), '[cache] offline after a restart, the libraries load from the cache: ' + await page.evaluate(() => JSON.stringify(window.__paint.libState)));
    const u = await page.evaluate(async () => { const p = window.__paint; await p.resizeDoc(200, 150, 'scale'); return [p.used.resize, document.querySelector('#toast').textContent]; });
    ok(u[0] === 'pica' && !/built-in/.test(u[1]), `[cache] offline resize uses pica, no notice (${u})`);
    await page.setInputFiles('#fileInput', path.join(FIX, 'rgba-deflate.tif'));
    await page.waitForFunction(() => window.__paint.S.fileName === 'rgba-deflate.tif', null, { timeout: 5000 }).catch(() => {});
    ok(await page.evaluate(() => window.__paint.S.fileName) === 'rgba-deflate.tif', '[cache] offline, a TIFF opens');
    ok(errs.length === 0, '[cache] no page errors: ' + errs.join(' | '));
    await ctx.close();
  } finally {
    fs.rmSync(profile, { recursive: true, force: true });
  }
  console.log(`${passes} passed, ${fails} failed`);
  process.exit(fails || !passes ? 1 : 0);
})().catch((e) => { console.log(`FAIL: ${at}: ${e.message.split('\n')[0]}`); process.exit(1); });
