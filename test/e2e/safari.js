// Checks in the real Safari, through Apple's safaridriver (WebDriver over plain HTTP; Playwright can't
// drive Safari itself). Once: Safari → Settings → Advanced → "Show features for web developers", then
// Settings → Developer → "Allow remote automation". Then, with the built app served:
//   safaridriver -p 4445 &   node test/e2e/safari.js [url]
// Covers what Playwright's WebKit can't vouch for: Safari's own focus, keyboard, clipboard and canvas
// behaviour, and how long big edits block the page. usage exit 0 = all pass
const url = process.argv[2] || 'http://localhost:8765/';
const WD = 'http://localhost:4445';
let fails = 0, passes = 0, sid = null;
const ok = (c, m) => { if (c) passes++; else { fails++; console.log('FAIL:', m); } };

async function wd(method, path, body) {
  const r = await fetch(WD + path, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  const j = await r.json();
  if (j.value && j.value.error) throw new Error(`${path}: ${j.value.error}: ${j.value.message}`);
  return j.value;
}
const S = (p) => `/session/${sid}${p}`;
// Runs f(...args) in the page; f may be async.
const P = (f, ...args) => wd('POST', S('/execute/async'), {
  script: `const done = arguments[arguments.length - 1]; Promise.resolve((${f}).apply(null, Array.from(arguments).slice(0, -1))).then((v) => done({ v }), (e) => done({ e: String(e && e.stack || e) }));`,
  args,
}).then((r) => { if (r.e) throw new Error(r.e); return r.v; });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const actions = (list) => wd('POST', S('/actions'), { actions: list }).then(() => wd('DELETE', S('/actions')));
const KEY = { Meta: '', Shift: '', Enter: '', Backspace: '', Escape: '' };
// keys: e.g. ['Meta', 'c'] pressed together, or a string typed
async function press(...keys) {
  const k = keys.map((x) => KEY[x] || x), seq = [];
  for (const x of k) seq.push({ type: 'keyDown', value: x });
  for (const x of k.slice().reverse()) seq.push({ type: 'keyUp', value: x });
  await actions([{ type: 'key', id: 'kb', actions: seq }]);
}
const type = (text) => actions([{ type: 'key', id: 'kb', actions: [...text].flatMap((c) => [{ type: 'keyDown', value: c }, { type: 'keyUp', value: c }]) }]);
// a pointer drag through viewport points [[x, y], ...]
const drag = (pts) => actions([{ type: 'pointer', id: 'm', parameters: { pointerType: 'mouse' }, actions: [
  { type: 'pointerMove', x: Math.round(pts[0][0]), y: Math.round(pts[0][1]), duration: 0 }, { type: 'pointerDown', button: 0 },
  ...pts.slice(1).map(([x, y]) => ({ type: 'pointerMove', x: Math.round(x), y: Math.round(y), duration: 16 })), { type: 'pointerUp', button: 0 }] }]);
const click = (x, y) => drag([[x, y]]);
const box = (sel) => P((s) => { const r = document.querySelector(s).getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; }, sel);
const px = (x, y) => P((x, y) => { const c = document.createElement('canvas'); c.width = c.height = 1; const g = c.getContext('2d'); g.drawImage(window.__paint.img, x, y, 1, 1, 0, 0, 1, 1); return [...g.getImageData(0, 0, 1, 1).data].join(); }, x, y);
const toast = () => P(() => document.querySelector('#toast').textContent);

(async () => {
  sid = (await wd('POST', '/session', { capabilities: { alwaysMatch: { browserName: 'safari' } } })).sessionId;
  try {
    await wd('POST', S('/window/rect'), { width: 1280, height: 860, x: 40, y: 40 });
    await wd('POST', S('/url'), { url });
    await pause(800);
    await P(() => { window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(e.message)); window.addEventListener('unhandledrejection', (e) => window.__errs.push(String(e.reason))); });
    const env = await P(() => ({ ua: navigator.userAgent, paint: !!window.__paint, webp: document.createElement('canvas').toDataURL('image/webp').startsWith('data:image/webp'),
      ric: typeof requestIdleCallback, fieldSizing: CSS.supports('field-sizing', 'content'), gesture: typeof GestureEvent, coalesced: typeof PointerEvent.prototype.getCoalescedEvents, fsa: typeof showSaveFilePicker }));
    console.log('Safari:', JSON.stringify(env));
    ok(env.paint && /Safari/.test(env.ua) && !/Chrome/.test(env.ua), 'the app boots in Safari');

    // ---- text: Enter commits and gives focus back, so letters are shortcuts again
    const ov = await box('#overlay'), cx = ov.x + ov.w / 2, cy = ov.y + ov.h / 2;
    await press('t'); await click(cx - 150, cy - 120); await type('Hi'); await press('Enter'); await pause(100);
    ok(await P(() => document.querySelector('#textInput').hidden && document.activeElement.id !== 'textInput'), 'Enter commits the text and focus leaves the box');
    await press('b');
    ok(await P(() => window.__paint.S.tool) === 'brush', 'a letter shortcut works right after committing text');
    // ---- text: a toolbar button click keeps it open; toolbar background commits it
    await press('t'); await click(cx - 150, cy - 40); await type('ok');
    const zi = await box('[data-cmd="zoomIn"]'); await click(zi.x + zi.w / 2, zi.y + zi.h / 2); await pause(100);
    ok(await P(() => !document.querySelector('#textInput').hidden && document.activeElement.id === 'textInput'), 'clicking a toolbar button while typing keeps the text open and focused');
    const tb = await box('#topbar'); await click(tb.x + tb.w / 2, tb.y + tb.h - 3); await pause(100);
    ok(await P(() => document.querySelector('#textInput').hidden), 'clicking toolbar background while typing commits the text');
    await P(() => window.__paint.fitZoom(false));
    // ---- Backspace on a focused toolbar button keeps the page
    await P(() => document.querySelector('#palette button').focus()); await press('Backspace'); await pause(300);
    ok(await P(() => !!window.__paint && location.href) === url, 'Backspace on a focused button keeps the page');
    await P(() => document.activeElement.blur());

    // ---- drawing, fill, shortcuts Safari might keep for its menus
    await P(() => { window.__paint.newDoc(800, 600); window.__paint.setZoom(1); window.__paint.setTool('pencil'); });
    const im = await box('#image');
    await drag([[im.x + 20, im.y + 20], [im.x + 200, im.y + 120], [im.x + 300, im.y + 40]]); await pause(100);
    ok(await px(20, 20) === '0,0,0,255', 'a pencil stroke draws');
    await P(() => { window.__paint.S.primary = '#ff0000'; window.__paint.setTool('fill'); });
    await click(im.x + 600, im.y + 500); await P(() => window.__paint.filling); await pause(100);
    ok(await px(700, 550) === '255,0,0,255', 'a fill fills');
    const n0 = await P(() => window.__paint.hist.undoStack.length);
    await press('Meta', 'z'); await pause(100);
    ok(await px(700, 550) === '255,255,255,255', '⌘Z undoes in Safari');
    await press('Meta', 'y'); await pause(100);
    ok(await px(700, 550) === '255,0,0,255', '⌘Y redoes (not Safari\'s History menu)');
    const z1 = await P(() => window.__paint.S.zoom); await press('Meta', '='); await pause(100);
    ok(await P(() => window.__paint.S.zoom) > z1, '⌘= zooms the image');
    await press('Meta', '-'); await pause(100); await press('Meta', '0'); await pause(100);
    ok(await P(() => window.__paint.S.zoom) <= 1, '⌘0 fits the image');
    await P(() => window.__paint.setTool('rect'));
    await drag([[im.x + 50, im.y + 300], [im.x + 150, im.y + 380]]); await pause(100);
    await press('v'); await click(im.x + 50, im.y + 340); await pause(50);
    await press('Meta', 'd'); await pause(100);
    ok(await P(() => window.__paint.userObjs.length) === 2, '⌘D duplicates the selected shape (not a bookmark)');
    await press('Meta', 'e'); await pause(100);
    ok(await P(() => window.__paint.userObjs.length) === 0 || await P(() => window.__paint.userObjs.length) === 1, '⌘E flattens');
    ok(await P(() => window.__paint.hist.undoStack.length) > n0, 'the edits are in history');

    // ---- pinch: Safari's gesture events must be cancelled (else the page zooms)
    const pz = await P(() => {
      const vp = document.querySelector('#viewport'), r = vp.getBoundingClientRect();
      const g = (t, scale) => { const e = new Event(t, { bubbles: true, cancelable: true }); Object.assign(e, { scale, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }); vp.dispatchEvent(e); return e.defaultPrevented; };
      window.__paint.setZoom(1);
      const a = g('gesturestart', 1), b = g('gesturechange', 2), z = window.__paint.S.zoom, c = g('gestureend', 2);
      window.__paint.setZoom(1);
      return { a, b, c, z };
    });
    ok(pz.a && pz.b && pz.c && pz.z === 2, 'gesture events zoom the image and are cancelled: ' + JSON.stringify(pz));

    // ---- copy with the real clipboard
    await P(() => window.__paint.setTool('select')); await press('Meta', 'a'); await press('Meta', 'c'); await pause(1500);
    ok(/Copied/.test(await toast()), 'copy reaches the system clipboard: ' + await toast());

    // ---- saving: .webp becomes a PNG copy; the file is what its name says
    const saved = await P(async () => {
      let got = null;
      const click0 = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () { got = { name: this.download, href: this.href }; };
      window.prompt = () => 'pic.webp';
      await window.__paint.save(true);
      HTMLAnchorElement.prototype.click = click0;
      const head = new Uint8Array(await (await fetch(got.href)).arrayBuffer()).slice(0, 4);
      return { name: got.name, head: [...head].map((b) => b.toString(16).padStart(2, '0')).join('') };
    });
    ok(saved.name === 'pic.png' && saved.head === '89504e47', 'Save As pic.webp downloads a PNG named pic.png: ' + JSON.stringify(saved));

    // ---- 10000²: big edits don't block the page for long, and nothing goes blank
    const big = await P(async () => {
      const p = window.__paint, blocks = [];
      p.newDoc(10000, 10000); p.flushRedraw();
      await new Promise((r) => setTimeout(r, 1000));
      let last = performance.now();
      const iv = setInterval(() => { const n = performance.now(); if (n - last > 50) blocks.push(Math.round(n - last)); last = n; }, 5);
      for (let i = 0; i < 4; i++) { p.transformDoc('rotR'); await new Promise((r) => setTimeout(r, 400)); }
      await new Promise((r) => setTimeout(r, 1500));
      clearInterval(iv);
      const c = document.createElement('canvas'); c.width = c.height = 1; const g = c.getContext('2d'); g.drawImage(p.img, 9999, 9999, 1, 1, 0, 0, 1, 1);
      return { blocks, corner: [...g.getImageData(0, 0, 1, 1).data].join(), fits: p.canvasFits(10000, 10000) };
    });
    console.log('rotate ×4 at 10000², main-thread blocks over 50 ms:', JSON.stringify(big.blocks));
    ok(big.corner === '255,255,255,255' && big.fits, '10000² document draws and fits: ' + JSON.stringify(big));
    ok(big.blocks.filter((b) => b > 100).length <= 1, 'at most one block over 100 ms in four rotates at 10000² (the fence turns itself off after it): ' + JSON.stringify(big.blocks));
    const enc = await P(async () => { const t = performance.now(); const b = await window.__paint.encodeFor('big.png'); return { ms: Math.round(performance.now() - t), size: b.size, via: window.__paint.used.encode }; });
    console.log('encode 10000² PNG:', JSON.stringify(enc));
    ok(enc.size > 1000 && enc.via === 'worker', 'a 10000² PNG encodes in the worker: ' + JSON.stringify(enc));

    const errs = await P(() => window.__errs);
    ok(!errs.length, 'no page errors: ' + errs.join(' | '));
  } finally {
    await wd('DELETE', S('')).catch(() => {});
  }
  console.log(`${passes} passed, ${fails} failed`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('FAIL:', e.message); if (sid) wd('DELETE', S('')).catch(() => {}); process.exit(1); });
