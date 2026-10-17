// Performance benchmark (Playwright + installed Chrome). Dev-only, like smoke.js.
// usage: node bench.js [url] [--headed] [--runs N] [--only substr] [--json out.json]
// Per scenario, median over N fresh browser runs:
//   task/script/layout/style: renderer main-thread ms (CDP Performance.getMetrics deltas);
//   p95/max/long: in-page rAF frame intervals (catches raster/GPU stalls the main-thread numbers miss).
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
      window.__benchFlush = () => { g.drawImage(document.querySelector('#image'), 0, 0, 1, 1); g.getImageData(0, 0, 1, 1); };
      window.__frames = null;
      const tick = (t) => { if (window.__frames) window.__frames.push(t); requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    });
    // two frames after any fill still running in its worker has landed
    const settle = () => P(async () => { await window.__paint.filling; await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => { window.__benchFlush(); r(); }))); });
    const gc = async () => { await P(() => window.gc && window.gc()); await page.waitForTimeout(300); };

    async function run(name, fn) {
      if (only && !name.includes(only)) return;
      await settle();
      await P(() => { window.__frames = []; });
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
      results[name] = {
        task: ms('TaskDuration'), script: ms('ScriptDuration'), layout: ms('LayoutDuration'), style: ms('RecalcStyleDuration'),
        layouts: b.LayoutCount - a.LayoutCount, styles: b.RecalcStyleCount - a.RecalcStyleCount,
        p95: iv.length ? iv[Math.floor(iv.length * 0.95)] : 0, max: iv.length ? iv[iv.length - 1] : 0, long: iv.filter((x) => x > 20).length,
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
    // one early on (each move plus the repaint it queues). It should stay flat as the stroke grows.
    if (!only || '4000x3000 long stroke'.includes(only) || only.includes('long stroke')) {
      await P(() => { window.__paint.newDoc(4000, 3000); window.__paint.fitZoom(false); window.__paint.setTool('pencil'); window.__paint.S.sizes.pencil = 3; });
      await settle();
      results['4000x3000 long stroke ms/move'] = await P(async () => {
        const ov = document.querySelector('#overlay'), r = ov.getBoundingClientRect();
        const ev = (type, x, y) => ov.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: r.left + x, clientY: r.top + y, isPrimary: true }));
        const at = (i) => [r.width / 2 + r.width * 0.45 * Math.sin(i / 97) * Math.cos(i / 31), r.height / 2 + r.height * 0.45 * Math.sin(i / 53)];
        const N = 10000, t = new Float64Array(N);
        ev('pointerdown', ...at(0));
        for (let i = 1; i < N; i++) { const t0 = performance.now(); ev('pointermove', ...at(i)); await null; t[i] = performance.now() - t0; }
        ev('pointerup', ...at(N));
        const avg = (a, b) => { let s = 0; for (let i = a; i < b; i++) s += t[i]; return s / (b - a); };
        return { early: avg(1, 1001), late: avg(N - 1000, N) };
      });
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
