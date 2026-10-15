// Installable-app e2e test (Playwright + installed Chrome). Dev-only, like smoke.js.
// usage: node pwa.js [url]   exit 0 = all pass; url must be http(s) (default http://localhost:8765/)
// Over http(s): the manifest is linked and Chrome reports no installability errors, the service
// worker caches the app so a reload works with the network off, and a file handed to the installed
// app (launchQueue) opens with its handle, so Save writes back to it. Offline, the parts that load
// on first use (library chunks, the fill and PNG workers) work too, and a file only the previous
// build's cache has is still served. From file:// (dist/index.html next to this repo's build), which
// can't load ES modules, the page says how to run it instead.
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const os = require('os');
const url = process.argv[2] || 'http://localhost:8765/';
const fileUrl = 'file://' + path.join(__dirname, '..', '..', 'dist', 'index.html');
let fails = 0, passes = 0;
const ok = (c, m) => { if (c) passes++; else { fails++; console.log('FAIL:', m); } };
let at = 'start';
setTimeout(() => { console.log(`FAIL: timed out during ${at}`); console.log(`${passes} passed, ${fails + 1} failed`); process.exit(1); }, 90000).unref();

(async () => {
  const browser = await chromium.launch({ channel: 'chrome' });
  // A real profile: Chrome won't install from an incognito-like context, which newContext() gives.
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'paint-pwa-'));
  try {
    at = 'http';
    const context = await chromium.launchPersistentContext(profile, { channel: 'chrome', viewport: { width: 1000, height: 700 } });
    const page = context.pages()[0] || await context.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    page.on('dialog', (d) => d.accept());
    await page.goto(url);
    await page.waitForFunction(() => window.__paint);
    const P = (f, a) => page.evaluate(f, a);

    // ---- manifest: linked, served, and enough for Chrome to offer an install
    await page.waitForFunction(() => document.querySelector('link[rel=manifest]'), null, { timeout: 5000 }).catch(() => {});
    const m = await P(async () => {
      const link = document.querySelector('link[rel=manifest]');
      if (!link) return null;
      return (await fetch(link.href)).json();
    });
    ok(m && m.name === 'Paint' && m.display === 'standalone', 'manifest linked and served: ' + JSON.stringify(m && { name: m.name, display: m.display }));
    const accepts = m ? Object.values(m.file_handlers[0].accept).flat() : [];
    ok(['.png', '.jpg', '.webp', '.tif'].every((e) => accepts.includes(e)), 'manifest handles image files: ' + accepts.join(' '));
    const cdp = await context.newCDPSession(page);
    const inst = await cdp.send('Page.getInstallabilityErrors');
    ok(inst.installabilityErrors.length === 0, 'no installability errors: ' + JSON.stringify(inst.installabilityErrors));

    // ---- service worker: active, controls the page after a reload, and serves it offline
    const active = await P(() => Promise.race([
      navigator.serviceWorker.ready.then((r) => !!r.active),
      new Promise((res) => setTimeout(() => res(false), 10000)),
    ]));
    ok(active, 'service worker installed and active');
    await page.reload();
    await page.waitForFunction(() => window.__paint);
    ok(await P(() => !!navigator.serviceWorker.controller), 'service worker controls the page after a reload');
    await context.setOffline(true);
    const off = await page.reload().then(() => page.waitForFunction(() => window.__paint, null, { timeout: 5000 })).then(() => true, () => false);
    ok(off, 'reload with the network off still opens the app');
    if (off) {
      const box = await page.locator('#overlay').boundingBox();
      await page.keyboard.press('p');
      await page.mouse.move(box.x + 50, box.y + 50);
      await page.mouse.down();
      await page.mouse.move(box.x + 120, box.y + 80);
      await page.mouse.up();
      ok(await P(() => window.__paint.hist.canUndo()), 'offline: drawing works');
      const r = await P(async () => { const p = window.__paint; await p.resizeDoc(400, 300, 'scale'); return [p.used.resize, p.img.width]; });
      ok(r.join() === 'pica,400', `offline: resize uses the bundled pica (${r})`);
      await P(() => { const p = window.__paint; p.newDoc(300, 200); p.fitZoom(false); p.setTool('fill'); p.S.tolerance = 0; p.S.primary = '#ff0000'; });
      const b2 = await page.locator('#overlay').boundingBox();
      await page.mouse.click(b2.x + 3, b2.y + 3);
      const f = await P(async () => { const p = window.__paint; await p.filling; return [p.used.fill, ...p.img.getContext('2d').getImageData(0, 0, 1, 1).data].join(); });
      ok(f === 'worker,255,0,0,255', `offline: fill runs in its worker (${f})`);
      const tif = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'rgba-deflate.tif')).toString('base64');
      const t = await P(async (b64) => {
        const p = window.__paint, bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const bmp = await p.decodeFile(new File([bytes], 'a.tif', { type: 'image/tiff' }));
        return [p.used.open, bmp.width].join();
      }, tif);
      ok(t === 'utif,4', `offline: TIFF opens through UTIF (${t})`);
      const png = await P(async () => {
        const p = window.__paint, g = p.img.getContext('2d');
        g.fillStyle = '#00f'; g.fillRect(10, 10, 50, 50);
        let blob = null;
        p.S.fileName = 'out.png';
        p.S.fileHandle = { name: 'out.png', queryPermission: async () => 'granted', requestPermission: async () => 'granted',
          createWritable: async () => ({ write: async (x) => { blob = x; }, close: async () => {} }) };
        await p.save(false);
        return [p.used.png, !!blob].join();
      });
      ok(png === 'upng,true', `offline: PNG save runs UPNG in its worker (${png})`);
    }
    await context.setOffline(false);

    // ---- a file the server no longer has (an old build's chunk) comes from the previous build's cache
    at = 'previous cache';
    const prev = await P(async () => {
      const c = await caches.open('paint-test-previous');
      await c.put(new URL('chunks/old-build-chunk.js', location.href).href, new Response('export const x = 1;', { headers: { 'content-type': 'text/javascript' } }));
      const r = await fetch('chunks/old-build-chunk.js');
      const body = await r.text();
      await caches.delete('paint-test-previous');
      return [r.status, body].join(' ');
    });
    ok(prev === '200 export const x = 1;', 'a 404 is answered from the previous build’s cache: ' + prev);

    // ---- a file handed to the installed app opens, and keeps its handle for Save
    at = 'launch';
    const launched = await P(async () => {
      const c = document.createElement('canvas'); c.width = 30; c.height = 20;
      c.getContext('2d').fillRect(0, 0, 30, 20);
      const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
      const h = { kind: 'file', name: 'launched.png', getFile: async () => new File([blob], 'launched.png', { type: 'image/png' }) };
      const p = window.__paint;
      p.newDoc(800, 600); // a clean document: no discard prompt
      await p.openLaunched({ files: [h] });
      return { name: p.S.fileName, w: p.img.width, sameHandle: p.S.fileHandle === h };
    });
    ok(launched.name === 'launched.png' && launched.w === 30 && launched.sameHandle, 'launched file opens with its handle: ' + JSON.stringify(launched));
    const bad = await P(async () => {
      const p = window.__paint;
      await p.openLaunched({ files: [{ kind: 'file', name: 'gone.png', getFile: async () => { throw new Error('file was moved'); } }] });
      return [p.S.fileName, document.querySelector('#toast').textContent];
    });
    ok(bad[0] === 'launched.png' && /Can't open gone\.png: file was moved/.test(bad[1]), 'a launched file that can’t be read says why: ' + bad.join(' / '));
    ok(errs.length === 0, 'no page errors: ' + errs.join(' | '));
    await context.close();

    // ---- file://: ES modules don't load there, so the page says how to run the app instead
    at = 'file';
    const fpage = await browser.newPage();
    await fpage.goto(fileUrl);
    await fpage.waitForTimeout(300);
    const f = await fpage.evaluate(() => ({ app: !!window.__paint, toast: document.querySelector('#toast').textContent, shown: document.querySelector('#toast').classList.contains('show') }));
    ok(!f.app && f.shown && /served over http: run npm run serve/.test(f.toast), 'file://: the page says to serve it over http: ' + JSON.stringify(f));
    await fpage.close();
  } finally {
    await browser.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
  console.log(`${passes} passed, ${fails} failed`);
  process.exit(fails || !passes ? 1 : 0);
})().catch((e) => { console.log(`FAIL: ${at}: ${e.message.split('\n')[0]}`); process.exit(1); });
