// Compare two bench.js result files: node bench-compare.js before.json after.json [--tol 0.15]
// Prints per-scenario deltas for the headline metrics; exits 1 if any regresses by more than tol
// (and by more than a small absolute floor, so 0.4 ms -> 0.6 ms noise doesn't count).
const fs = require('fs');
const [a, b] = process.argv.slice(2, 4).map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
const tol = process.argv.includes('--tol') ? +process.argv[process.argv.indexOf('--tol') + 1] : 0.15;
// key -> absolute noise floor. Event durations are rounded to 8 ms, so INP's floor is three of those; a new
// interaction over 200 ms (inp200) always counts.
const KEYS = { task: 15, p95: 4, long: 2, heapMB: 2, gpuMB: 20, rendererMB: 20, totalMB: 40, inp: 24, inpMain: 15, inp200: 0, longMax: 30 };
const BIGGER_IS_BETTER = new Set(['steps']);
let bad = 0;
for (const name of Object.keys(b)) {
  if (!a[name]) continue;
  const parts = [];
  for (const k of Object.keys(b[name])) {
    if (!(k in KEYS) && !BIGGER_IS_BETTER.has(k)) continue;
    const x = a[name][k], y = b[name][k];
    if (x === undefined) { parts.push(`${k} ${y} (new)`); continue; } // a baseline from before the field existed
    const pct = x ? ((y - x) / x) * 100 : 0;
    const worse = BIGGER_IS_BETTER.has(k) ? y < x : y - x > Math.max(KEYS[k], x * tol);
    if (worse) bad++;
    parts.push(`${k} ${x}→${y}${x ? ` (${pct >= 0 ? '+' : ''}${pct.toFixed(0)}%)` : ''}${worse ? ' REGRESSED' : ''}`);
  }
  console.log(name.padEnd(34), parts.join('  '));
}
console.log(bad ? `${bad} regression(s)` : 'no regressions');
process.exit(bad ? 1 : 0);
