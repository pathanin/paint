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
    const settle = () => P(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => { window.__benchFlush(); r(); }))));
    const gc = async () => { await P(() => window.gc && window.gc()); await page.waitForTimeout(300); };

    async function run(name, fn) {
      if (only && !name.includes(only)) return;
      await settle();
      await P(() => { window.__frames = []; });
      const a = await metrics();
      await fn();
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
