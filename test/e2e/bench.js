// Performance benchmark (Playwright + installed Chrome). Dev-only, like smoke.js.
// usage: node bench.js [url] [--headed] [--runs N] [--only substr] [--json out.json]
// Per scenario, median over N fresh browser runs:
//   task/script/layout/style: renderer main-thread ms (CDP Performance.getMetrics deltas);
//   p95/max/long: in-page rAF frame intervals (catches raster/GPU stalls the main-thread numbers miss);
//   ints/inp/inpMain/inp200/longMax: Event Timing (Core Web Vitals' INP): trusted interactions seen, the worst
//   one's duration (input to next paint; 0 = none at or over 16 ms) and its main-thread part (input delay +
//   handlers; the rest is rendering and presenting the frame, e.g. GPU work queued), how many took over
//   200 ms, and the longest main-thread task. Only real input (page.mouse, page.keyboard) counts: rows driven by evaluate() or
//   synthetic dispatchEvent() show ints 0. INP sees the synchronous work and its microtasks, not what
//   runs after an await in a later task (a fill's worker, pica, encoding); longMax catches that.
// Memory: JS heap and macOS phys_footprint (footprint(1)) of the GPU and renderer processes and the whole tree.
// Compare two result files with bench-compare.js.
const { chromium } = require('playwright');
const { execSync } = require('child_process');
const fs = require('fs');
const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const VALUED = new Set(['--runs', '--only', '--json']);
const url = args.find((a, i) => !a.startsWith('--') && !VALUED.has(args[i - 1])) || 'http://localhost:8765/';
const headed = args.includes('--headed');
const runs = +opt('--runs', 3);
const only = opt('--only', '');
const jsonOut = opt('--json', null);

function procTree(rootPid) {
  const rows = execSync('ps -A -o pid=,ppid=,command=').toString().trim().split('\n').map((l) => {
    const m = l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    return { pid: +m[1], ppid: +m[2], cmd: m[3] };
  });
  const out = []; const stack = [rootPid];
  while (stack.length) {
    const p = stack.pop();
    const r = rows.find((x) => x.pid === p);
    if (r) out.push(r);
    stack.push(...rows.filter((x) => x.ppid === p).map((x) => x.pid));
  }
  return out;
}
function footprintMB(pids) {
  const txt = execSync('footprint -f bytes ' + pids.map((p) => '-p ' + p).join(' ') + ' 2>/dev/null').toString();
  const by = {};
  for (const m of txt.matchAll(/\[(\d+)\]: \d+-bit\s+Footprint: (\d+) B/g)) by[+m[1]] = +m[2] / 1048576;
  return by;
}

async function once() {
  const tag = '--bench-tag=' + process.pid + '-' + Math.random().toString(36).slice(2); // finds the browser's root process in ps
  const browser = await chromium.launch({ channel: 'chrome', headless: !headed, args: ['--enable-precise-memory-info', '--js-flags=--expose-gc', tag] });
  const rootPid = Number(execSync('ps -A -o pid=,command=').toString().split('\n').find((l) => l.includes(tag) && !l.includes('--type=')).trim().split(/\s+/)[0]);
  const results = {};
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    page.on('dialog', (d) => d.accept());
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
    await page.goto(url);
    await page.waitForTimeout(500);
    const P = (f, a) => page.evaluate(f, a);
    // Flush pending canvas/GPU work through a 1x1 scratch canvas, so the app's own canvas is never read back by the bench.
    await P(() => {
      const c = document.createElement('canvas'); c.width = c.height = 1;
      const g = c.getContext('2d', { willReadFrequently: true });
      // The readback waits for the GPU; the long task it makes is the bench's, so longMax leaves it out.
      window.__flushes = [];
      window.__benchFlush = () => { const t = performance.now(); g.drawImage(document.querySelector('#image'), 0, 0, 1, 1); g.getImageData(0, 0, 1, 1); window.__flushes.push([t, performance.now()]); };
      window.__frames = null;
      const tick = (t) => { if (window.__frames) window.__frames.push(t); requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
      // Event Timing and long tasks, from boot; each run() takes the entries that start after its t0.
      window.__ev = []; window.__lt = [];
      new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.interactionId) window.__ev.push(e); })
        .observe({ type: 'event', durationThreshold: 16, buffered: true });
      new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push(e); }).observe({ type: 'longtask' });
      window.__ints = 0; // trusted presses (a drag is one): the entries above leave out anything under 16 ms
      for (const t of ['pointerdown', 'keydown']) addEventListener(t, (e) => { if (e.isTrusted && !e.repeat) window.__ints++; }, true);
      window.__inp = (t0) => {
        // per interaction: its longest event (and the frame it ends at), and how much of that was main thread
        // (input delay + handlers) rather than rendering and presenting the frame after it
        const by = new Map();
        for (const e of window.__ev) {
          if (e.startTime < t0) continue;
          const o = by.get(e.interactionId) || { d: 0, end: 0, main: 0 };
          if (e.duration > o.d) { o.d = e.duration; o.end = e.startTime + e.duration; }
          o.main = Math.max(o.main, e.processingEnd - e.startTime);
          by.set(e.interactionId, o);
        }
        const d = [...by.values()].sort((x, y) => y.d - x.d), lt = window.__lt.filter((e) => e.startTime >= t0 && !window.__flushes.some(([a, b]) => e.startTime <= a && e.startTime + e.duration >= b)).map((e) => e.duration);
        window.__flushes = [];
        window.__ev = window.__ev.filter((e) => e.startTime >= t0); window.__lt = window.__lt.filter((e) => e.startTime >= t0);
        // inpMain: the longest main-thread part among the interactions presented in the worst one's frame
        // (durations are rounded to 8 ms). A ⌘C press is two interactions, the Meta keydown and the c keydown,
        // and both wait for the frame that c's handler holds up: their durations tie, and the Meta one,
        // whose own main part is ~0, would otherwise be the one reported.
        const inpMain = d.filter((x) => Math.abs(x.end - d[0]?.end) <= 8).reduce((m, x) => Math.max(m, x.main), 0);
        return { inp: d.length ? d[0].d : 0, inpMain, inp200: d.filter((x) => x.d > 200).length, longMax: lt.length ? Math.max(...lt) : 0 };
      };
    });
    // two frames after any fill still running in its worker has landed
    const settle = () => P(async () => { await window.__paint.filling; await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => { window.__benchFlush(); r(); }))); });
    const gc = async () => { await P(() => window.gc && window.gc()); await page.waitForTimeout(300); };

    async function run(name, fn) {
      if (only && !name.includes(only)) return;
      await settle();
      const t0 = await P(() => { window.__frames = []; window.__ints = 0; return performance.now(); });
      const a = await metrics();
      await fn();
      // Undo data is read back from the GPU at idle, a second after the edit (flushToData): charge
      // that work to the scenario that caused it, not to whichever one runs next.
      await P(() => window.__paint.flushToData && window.__paint.flushToData());
      await settle();
      const b = await metrics();
      const f = await P(() => { const t = window.__frames; window.__frames = null; return t; });
      const iv = f.slice(1).map((t, i) => t - f[i]).sort((x, y) => x - y);
      const ms = (k) => (b[k] - a[k]) * 1000;
      // event entries are delivered after the paint they end at, so give them a moment
      const ev = await P(async (t0) => { await new Promise((r) => setTimeout(r, 60)); return { ints: window.__ints, ...window.__inp(t0) }; }, t0);
      results[name] = {
        task: ms('TaskDuration'), script: ms('ScriptDuration'), layout: ms('LayoutDuration'), style: ms('RecalcStyleDuration'),
        layouts: b.LayoutCount - a.LayoutCount, styles: b.RecalcStyleCount - a.RecalcStyleCount,
        p95: iv.length ? iv[Math.floor(iv.length * 0.95)] : 0, max: iv.length ? iv[iv.length - 1] : 0, long: iv.filter((x) => x > 20).length,
        ...ev,
      };
    }
    async function mem(name) {
      if (only && !name.includes(only)) return;
      await gc();
      const m = await metrics();
      const tree = procTree(rootPid);
      const fp = footprintMB(tree.map((p) => p.pid));
      const sum = (pred) => tree.filter(pred).reduce((s, p) => s + (fp[p.pid] || 0), 0);
      results[name] = {
        heapMB: m.JSHeapUsedSize / 1048576,
        gpuMB: sum((p) => p.cmd.includes('--type=gpu-process')),
        rendererMB: sum((p) => p.cmd.includes('--type=renderer') && !p.cmd.includes('--extension-process')),
        totalMB: sum(() => true),
      };
    }
    const box = async () => page.locator('#overlay').boundingBox();
    const area = async () => {
      const b = await box();
      const x0 = Math.max(b.x, 60), y0 = Math.max(b.y, 100);
      return { x: x0, y: y0, w: Math.min(b.x + b.width, 1220) - x0, h: Math.min(b.y + b.height, 740) - y0 };
    };
    async function stroke(steps, scale = 0.8) {
      const vb = await area();
      await page.mouse.move(vb.x + vb.w * 0.1, vb.y + vb.h * 0.1);
      await page.mouse.down();
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        await page.mouse.move(vb.x + vb.w * (0.1 + scale * t), vb.y + vb.h * (0.5 + 0.4 * Math.sin(t * 12)));
      }
      await page.mouse.up();
    }
    async function hover(steps) {
      const b = await area();
      for (let i = 0; i < steps; i++) await page.mouse.move(b.x + 20 + (i % 200) * 2, b.y + 20 + (i % 100));
    }

    await mem('mem: load 800x600');
    await run('idle 2s', () => page.waitForTimeout(2000));
    await run('hover statusbar 300 (floor)', async () => {
      const r = await page.locator('#status').boundingBox();
      for (let i = 0; i < 300; i++) await page.mouse.move(r.x + 300 + (i % 200), r.y + r.height / 2);
    });
    await run('hover 300 (pencil)', () => hover(300));
    await P(() => window.__paint.setZoom(0.05));
    await run('hover 300 (zoom 5%)', () => hover(300));
    await P(() => window.__paint.fitZoom(false));
    await P(() => window.__paint.setTool('text'));
    await run('text typing 50 chars', async () => {
      const b = await area(); await page.mouse.click(b.x + 50, b.y + 50);
      await page.keyboard.type('the quick brown fox jumps over the lazy dog 012345');
      await page.keyboard.press('Escape');
    });

    for (const [w, h] of [[800, 600], [4000, 3000], [10000, 10000]]) {
      const tag = `${w}x${h}`;
      await P(([w, h]) => { window.__paint.newDoc(w, h); window.__paint.fitZoom(false); }, [w, h]);
      await mem(`mem: new ${tag}`);
      await P(() => window.__paint.setTool('pencil'));
      await run(`${tag} pencil stroke 300`, () => stroke(300));
      await P(() => { window.__paint.setTool('brush'); window.__paint.S.sizes.brush = 30; });
      await run(`${tag} brush30 stroke 300`, () => stroke(300));
      await P(() => window.__paint.setTool('rect'));
      await run(`${tag} rect drag 200`, () => stroke(200));
      await P(() => window.__paint.setTool('select'));
      await run(`${tag} marquee drag 200`, () => stroke(200));
      await run(`${tag} hover with selection 200`, () => hover(200));
      await run(`${tag} move selection 100`, async () => {
        const b = await box(); const s = await P(() => window.__paint.sel);
        if (!s) return;
        const z = b.width / (await P(() => window.__paint.img.width));
        const sx = b.x + (s.x + s.w / 2) * z, sy = b.y + (s.y + s.h / 2) * z;
        await page.mouse.move(sx, sy); await page.mouse.down();
        for (let i = 1; i <= 100; i++) await page.mouse.move(sx + i, sy + i / 2);
        await page.mouse.up();
      });
      await P(() => window.__paint.setTool('fill'));
      await run(`${tag} flood fill x2`, async () => {
        const b = await box();
        await page.mouse.click(b.x + 5, b.y + 5); await settle();
        await P(() => { window.__paint.S.primary = '#ff0000'; });
        await page.mouse.click(b.x + 5, b.y + 5);
      });
      await run(`${tag} undo+redo x5`, async () => { for (let i = 0; i < 5; i++) { await P(() => window.__paint.undo()); await settle(); await P(() => window.__paint.redo()); await settle(); } });
      await run(`${tag} rotate x2`, async () => { await P(() => window.__paint.transformDoc('rotR')); await settle(); await P(() => window.__paint.transformDoc('rotL')); });
      await P(() => { window.__paint.setTool('select'); window.__paint.selectAll(); });
      await run(`${tag} pinch zoom 60 (with selection)`, async () => {
        const b = await area(); await page.mouse.move(b.x + b.w / 2, b.y + b.h / 2);
        await page.keyboard.down('Control');
        for (let i = 0; i < 60; i++) await page.mouse.wheel(0, i < 30 ? -40 : 40);
        await page.keyboard.up('Control');
      });
      await P(() => window.__paint.setZoom(1));
      await run(`${tag} space-pan 100 (with selection)`, async () => {
        const b = await area(); await page.mouse.move(b.x + b.w / 2, b.y + b.h / 2);
        await page.keyboard.down('Space'); await page.mouse.down();
        for (let i = 0; i < 100; i++) await page.mouse.move(b.x + b.w / 2 - i * 3, b.y + b.h / 2 - i * 2);
        await page.mouse.up(); await page.keyboard.up('Space');
      });
      await P(() => { window.__paint.fitZoom(false); window.__paint.setTool('pencil'); });
      for (let i = 0; i < 10; i++) await stroke(20);
      await mem(`mem: ${tag} after edits`);
      await run(`${tag} undo all`, async () => { while (await P(() => window.__paint.hist.canUndo())) { await P(() => window.__paint.undo()); } });
      results[`${tag} undo steps kept`] = { steps: await P(() => window.__paint.hist.canRedo() ? window.__paint.hist.redoStack.length : 0) };
    }
    // A long pencil stroke (10,000 points), drawn live: the cost of a move late in the stroke against
    // one early on (each move plus the repaint it queues). A zigzag that leaves each tile behind should
    // stay flat (a move repaints its tile's pieces, not the whole stroke); a curve that keeps crossing
    // the same tiles still grows, since a tile is composed from scratch with every piece in it.
    if (!only || '4000x3000 long stroke'.includes(only) || only.includes('long stroke')) {
      for (const shape of ['zigzag', 'curve']) {
        await P(() => { window.__paint.newDoc(4000, 3000); window.__paint.fitZoom(false); window.__paint.setTool('pencil'); window.__paint.S.sizes.pencil = 3; });
        await settle();
        results[`4000x3000 long stroke ms/move (${shape})`] = await P(async (shape) => {
          const ov = document.querySelector('#overlay'), r = ov.getBoundingClientRect();
          const ev = (type, x, y) => ov.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: r.left + x, clientY: r.top + y, isPrimary: true }));
          const at = shape === 'zigzag' ? (i) => { const row = Math.floor(i / 1000), t = (i % 1000) / 1000; return [2 + r.width * 0.98 * (row % 2 ? 1 - t : t), 5 + row * r.height * 0.098]; }
            : (i) => [r.width / 2 + r.width * 0.45 * Math.sin(i / 97) * Math.cos(i / 31), r.height / 2 + r.height * 0.45 * Math.sin(i / 53)];
          const N = 10000, t = new Float64Array(N);
          ev('pointerdown', ...at(0));
          for (let i = 1; i < N; i++) { const t0 = performance.now(); ev('pointermove', ...at(i)); await null; t[i] = performance.now() - t0; }
          ev('pointerup', ...at(N));
          const avg = (a, b) => { let s = 0; for (let i = a; i < b; i++) s += t[i]; return s / (b - a); };
          return { early: avg(1, 1001), late: avg(N - 1000, N) };
        }, shape);
      }
    }
    // A big paste (12 MP of noise, the canvas's size) committed, then the idle time after it: the longest main-thread task
    // while the asset's CPU copy is read (one 48 MB read stalls the page; strips shouldn't).
    if (!only || '4000x3000 paste idle'.includes(only) || only.includes('paste idle')) {
      await P(() => { window.__paint.newDoc(4000, 3000); window.__paint.fitZoom(false); window.__paint.S.pristine = false; }); // else the paste becomes the document
      await settle();
      await P(() => { // the setup (12 MP of noise, the paste, its commit) is its own task, not counted
        const p = window.__paint, c = document.createElement('canvas'); c.width = 4000; c.height = 3000;
        const g = c.getContext('2d'), im = g.createImageData(4000, 3000), u = new Uint32Array(im.data.buffer);
        let s = 7; for (let i = 0; i < u.length; i++) { s = (s * 1103515245 + 12345) >>> 0; u[i] = s | 0xff000000; }
        g.putImageData(im, 0, 0);
        window.__longs = [];
        window.__po = new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__longs.push(e); });
        window.__po.observe({ type: 'longtask' }); // from now, so an idle read between the two calls is seen
        p.pasteImage(c); p.selectAll(); // selectAll commits the float: the image object and its asset
        window.__t0 = performance.now(); // tasks starting after this are the idle work, not this setup
      });
      results['4000x3000 paste idle'] = await P(async () => {
        const a = window.__paint.userObjs.find((o) => o.t === 'image').asset;
        await (a.ready || new Promise((r) => setTimeout(r, 3000)));
        await new Promise((r) => setTimeout(r, 300));
        window.__po.disconnect();
        const lt = window.__longs.filter((e) => e.startTime >= window.__t0).map((e) => e.duration);
        return { maxLongMs: lt.length ? Math.max(...lt) : 0, longTasks: lt.length };
      });
    }
    // A dense scene (docs/total-objects.md): 5,000 short rectangle outlines, drawn by synthetic pointer
    // events in one task (so on any build they are objects made by the tools themselves), then one
    // dragged across them, a brush stroke over them and a full rebuild (rotate).
    for (const [w, h] of [[4000, 3000], [10000, 10000]]) {
      const tag = `${w}x${h}`;
      if (only && !`${tag} 5k`.includes(only) && !only.includes('5k')) continue;
      await P(([w, h]) => { window.__paint.newDoc(w, h); window.__paint.fitZoom(false); }, [w, h]);
      await run(`${tag} scene 5k objects`, () => P(() => {
        const p = window.__paint, ov = document.querySelector('#overlay'), r = ov.getBoundingClientRect();
        p.setTool('rect'); p.S.sizes.rect = 2; p.S.fillMode = 'outline';
        const ev = (type, x, y) => ov.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: r.left + x, clientY: r.top + y, isPrimary: true }));
        let s = 7;
        const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
        for (let i = 0; i < 5000; i++) {
          const x = rnd() * r.width * 0.9, y = rnd() * r.height * 0.9;
          ev('pointerdown', x, y); ev('pointermove', x + 4 + rnd() * 30, y + 4 + rnd() * 30); ev('pointerup', x + 4 + rnd() * 30, y + 4 + rnd() * 30);
        }
        p.setTool('pencil');
      }));
      await run(`${tag} move one in 5k`, async () => {
        await P(() => window.__paint.setTool('move'));
        const o = await P(() => { const o = window.__paint.userObjs[2500]; return o && { x: o.a.x, y: o.a.y }; });
        const W = await P(() => window.__paint.img.width), bx = await box(), z = bx.width / W;
        const sx = bx.x + o.x * z, sy = bx.y + o.y * z;
        await page.mouse.move(sx, sy); await page.mouse.down();
        for (let i = 1; i <= 60; i++) await page.mouse.move(sx + i * 4, sy + i * 2);
        await page.mouse.up();
        await P(() => window.__paint.setTool('pencil'));
      });
      // All 5,000 selected (a box drag over everything): the selection is looked up on every frame
      // (status, group box, outlines, hover) and by every nudge.
      await run(`${tag} select 5k, nudge`, async () => {
        await P(() => { const p = window.__paint; p.setTool('move'); p.selectMany(p.userObjs.map((o) => o.id)); document.querySelector('#viewport').focus(); });
        for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowRight');
      });
      await run(`${tag} hover with 5k selected`, async () => {
        const bx = await box();
        for (let i = 0; i < 40; i++) await page.mouse.move(bx.x + 20 + i * 7, bx.y + 20 + i * 3);
        await P(() => { window.__paint.selectObj(null); window.__paint.setTool('pencil'); });
      });
      await P(() => { window.__paint.setTool('brush'); window.__paint.S.sizes.brush = 30; });
      await run(`${tag} stroke over 5k`, () => stroke(300));
      await run(`${tag} rebuild 5k (rotate)`, () => P(() => window.__paint.transformDoc('rotR')));
    }
    // INP (Interaction to Next Paint, Core Web Vitals' responsiveness metric: good is at most 200 ms): the heavy
    // synchronous actions, each fired by real input (a click or a key) on a big picture with objects on it.
    // Setup goes through evaluate(), which Event Timing doesn't see.
    if (!only || only.startsWith('inp')) {
      await P(() => {
        window.__benchNoise = (w, h) => {
          const c = document.createElement('canvas'); c.width = w; c.height = h;
          const g = c.getContext('2d'), im = g.createImageData(w, h), u = new Uint32Array(im.data.buffer);
          let s = 7; for (let i = 0; i < u.length; i++) { s = (s * 1103515245 + 12345) >>> 0; u[i] = s | 0xff000000; }
          g.putImageData(im, 0, 0);
          return c;
        };
        // n small rectangle outlines and a 2000x1500 noise image, as objects made by the tools themselves
        window.__benchScene = async (w, h, n) => {
          const p = window.__paint;
          p.newDoc(w, h); p.fitZoom(false); p.S.pristine = false; // else the paste becomes the document
          const ov = document.querySelector('#overlay'), r = ov.getBoundingClientRect();
          p.setTool('rect'); p.S.sizes.rect = 2; p.S.fillMode = 'outline';
          const ev = (type, x, y) => ov.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: r.left + x, clientY: r.top + y, isPrimary: true }));
          let s = 7;
          const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
          for (let i = 0; i < n; i++) {
            const x = rnd() * r.width * 0.85, y = rnd() * r.height * 0.85;
            ev('pointerdown', x, y); ev('pointermove', x + 4 + rnd() * 30, y + 4 + rnd() * 30); ev('pointerup', x + 4 + rnd() * 30, y + 4 + rnd() * 30);
          }
          p.pasteImage(window.__benchNoise(2000, 1500)); p.setTool('pencil'); // the tool switch commits it
          const a = p.userObjs.find((o) => o.t === 'image').asset;
          await (a.ready || new Promise((res) => setTimeout(res, 3000))); // its CPU copy is read at idle
          p.hist.markSaved();
        };
        // Save without a picker: a handle that writes nowhere (the picker would wait for a person).
        window.showSaveFilePicker = async (o) => ({ name: o.suggestedName, createWritable: async () => ({ write: async () => {}, close: async () => {} }) });
        navigator.clipboard.write = async (items) => { await items[0].getType('image/png'); }; // still waits for the encode
      });
      const press = (k) => page.keyboard.press(k);
      const click = (sel) => page.click(sel);
      const marquee = async () => { // a selection over the middle of the picture, by mouse (untimed)
        await P(() => window.__paint.setTool('select'));
        const b = await box();
        await page.mouse.move(b.x + b.width * 0.2, b.y + b.height * 0.2); await page.mouse.down();
        await page.mouse.move(b.x + b.width * 0.6, b.y + b.height * 0.6, { steps: 4 }); await page.mouse.up();
      };
      const undoAll = () => P(() => { const p = window.__paint; while (p.hist.canUndo() && !p.hist.isClean()) p.undo(); p.setTool('pencil'); });

      // A scenario whose action silently didn't happen would show a fast INP: check each one's effect.
      const check = async (what, f, arg) => { if (!(await P(f, arg))) errs.push(`bench: ${what} had no effect`); };

      // --only picks single rows too: a row left out skips its untimed setup and its check as well.
      const want = (name) => !only || name.includes(only);
      for (const [w, h, n] of [[4000, 3000, 300], [10000, 10000, 2000]]) {
        const tag = `${w}x${h}`;
        if (only && !`inp ${tag}`.includes(only) && !only.startsWith(`inp ${tag}`)) continue;
        await P(([w, h, n]) => window.__benchScene(w, h, n), [w, h, n]);
        await settle();
        if (want(`inp ${tag} rotate (button)`)) {
          await run(`inp ${tag} rotate (button)`, () => click('[data-cmd=rotR]'));
          await check(`${tag} rotate`, (h) => window.__paint.base.width === h, h);
        }
        await run(`inp ${tag} flip (button)`, () => click('[data-cmd=flipH]'));
        if (want(`inp ${tag} undo doc step (⌘Z)`)) {
          if (!(await P(() => window.__paint.hist.canUndo() && !window.__paint.hist.isClean()))) await click('[data-cmd=rotR]'); // a doc step to undo
          await run(`inp ${tag} undo doc step (⌘Z)`, () => press('Meta+z'));
          await check(`${tag} undo`, () => window.__paint.hist.canRedo());
        }
        await undoAll();
        if (want(`inp ${tag} flatten (⌘E)`) || want(`inp ${tag} undo flatten (⌘Z)`)) {
          await (want(`inp ${tag} flatten (⌘E)`) ? run(`inp ${tag} flatten (⌘E)`, () => press('Meta+e')) : press('Meta+e'));
          await check(`${tag} flatten`, () => window.__paint.userObjs.length === 0);
          await run(`inp ${tag} undo flatten (⌘Z)`, () => press('Meta+z'));
          if (want(`inp ${tag} undo flatten (⌘Z)`)) await check(`${tag} undo flatten`, () => window.__paint.userObjs.length > 0);
          await undoAll();
        }
        if (want(`inp ${tag} crop (⌘⇧X)`)) {
          await marquee();
          await run(`inp ${tag} crop (⌘⇧X)`, () => press('Meta+Shift+x'));
          await check(`${tag} crop`, (w) => window.__paint.base.width < w, w);
          await undoAll();
        }
        // resize to half: the dialog opened and filled untimed, then Apply. Scale runs pica (or, past its
        // budget, the GPU resampler) after an await, so its result lands in a later task (longMax); canvas size
        // is synchronous.
        for (const mode of ['scale', 'canvas']) {
          if (!want(`inp ${tag} resize ${mode} (Apply)`)) continue;
          await press(mode === 'scale' ? 'Shift+R' : 'Shift+C');
          await page.fill('#rW', String(w / 2)); // fires input, which keeps the aspect
          await run(`inp ${tag} resize ${mode} (Apply)`, async () => {
            await click('#resizeDlg button[value=ok]');
            await P((w) => new Promise((res) => { const t0 = Date.now(), t = setInterval(() => { if (window.__paint.base.width === w || Date.now() - t0 > 20000) { clearInterval(t); res(); } }, 5); }), w / 2);
          });
          if ((await P(() => window.__paint.base.width)) !== w / 2) errs.push(`bench: ${tag} resize ${mode} had no effect`);
          await undoAll();
        }
        if (want(`inp ${tag} copy (⌘C)`)) {
          await run(`inp ${tag} copy (⌘C)`, async () => { await press('Meta+c'); await page.waitForFunction(() => /Cop/.test(document.querySelector('#toast').textContent)); });
          await check(`${tag} copy`, () => /Copied/.test(document.querySelector('#toast').textContent));
        }
        if (want(`inp ${tag} save (⌘S)`)) {
          await run(`inp ${tag} save (⌘S)`, async () => { await press('Meta+s'); await P(() => window.__paint.saving); });
          await check(`${tag} save`, () => /Saved/.test(document.querySelector('#toast').textContent));
        }
        if (want(`inp ${tag} fill click`)) {
          await P(() => window.__paint.setTool('fill'));
          await run(`inp ${tag} fill click`, async () => { const b = await box(); await page.mouse.click(b.x + b.width - 4, b.y + b.height - 4); });
          await check(`${tag} fill`, () => window.__paint.userObjs.at(-1).t === 'fill');
          await undoAll();
        }
        // a 12 MP paste: decoding a real ⌘V runs after an await, so time the key that commits the float instead
        if (want(`inp ${tag} commit 12MP paste (P key)`)) {
          await P(() => window.__paint.pasteImage(window.__benchNoise(4000, 3000)));
          await run(`inp ${tag} commit 12MP paste (P key)`, () => press('p'));
          await check(`${tag} paste commit`, () => !window.__paint.sel && window.__paint.userObjs.at(-1).t === 'image');
          await undoAll();
        }
      }
      // Save under a 4K screen also reads the pixels back for UPNG (getImageData) before the encoders run.
      if (want('inp 3840x2160 save (⌘S, with UPNG)')) {
        await P(() => window.__benchScene(3840, 2160, 300));
        await settle();
        await run('inp 3840x2160 save (⌘S, with UPNG)', async () => { await press('Meta+s'); await P(() => window.__paint.saving); });
        await check('3840x2160 save with UPNG', () => window.__paint.used.png === 'upng' || window.__paint.used.png === 'builtin');
      }

      // 10000x10000 with 5,000 objects at 100%: a repaint of over 64 tiles paints the visible ones, then the
      // rest in ~12 ms slices; clicks meanwhile should wait at most a slice. markAll() starts it untimed, and
      // the clicks go straight to the tool buttons' centres (page.click's checks would wait out the repaint).
      if (want('inp 10000x10000 click during repaint')) {
        await P(() => window.__benchScene(10000, 10000, 5000));
        await P(() => window.__paint.setZoom(1));
        await settle();
        const at = await page.$$eval('[data-tool=brush], [data-tool=pencil]', (bs) => bs.map((b) => { const r = b.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; }));
        await P(() => { window.__clickAt = []; addEventListener('pointerdown', () => window.__clickAt.push(window.__paint.redrawCount), true); });
        const r0 = await P(() => window.__paint.redrawCount);
        let mid = [];
        await run('inp 10000x10000 click during repaint', async () => {
          await P(() => window.__paint.markAll());
          for (let i = 0; i < 5; i++) await page.mouse.click(...at[i % 2]);
          mid = await P(() => window.__clickAt);
        });
        const r1 = await P(() => { window.__paint.flushRedraw(); return window.__paint.redrawCount; });
        // clicks that came in before the repaint's last tile. The slices only queue draws (all 400 tiles took
        // ~11 ms on an M4) and the GPU does the work after, so this tends to be 0: the clicks then wait on the GPU
        // for their frame (inp well above inpMain), which slicing on the main thread can't help.
        results['inp 10000x10000 click during repaint'].midClicks = mid.filter((n) => n < r1).length;
        if (r1 - r0 <= 64) errs.push('bench: the 10000x10000 repaint was not sliced');
      }
    }
    if (errs.length) { console.error('PAGE ERRORS:', errs); process.exitCode = 1; }
  } finally {
    await browser.close();
  }
  return results;
}

(async () => {
  const all = [];
  for (let i = 0; i < runs; i++) { all.push(await once()); process.stderr.write(`run ${i + 1}/${runs} done\n`); }
  const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor((s.length - 1) / 2)]; };
  const out = {};
  for (const name of Object.keys(all[0])) {
    out[name] = {};
    for (const k of Object.keys(all[0][name])) out[name][k] = +med(all.map((r) => r[name][k])).toFixed(1);
  }
  for (const [name, r] of Object.entries(out)) {
    console.log(name.padEnd(34), Object.entries(r).map(([k, v]) => `${k} ${v}`).join('  '));
  }
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(out, null, 2));
})();
