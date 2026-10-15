// Builds dist/ from src/: the modules in src/js bundled (with the npm libraries) into one classic
// script, dist/app.js, so the page still works from file:// and offline; the other files in src/
// are copied as they are. sw.js gets the build's file list and a version (a hash of the files), so
// an installed copy updates when anything changes.
//   node build.mjs           production build (minified, with a source map)
//   node build.mjs --dev     unminified, rebuilt on change, served on http://localhost:8765/
import * as esbuild from 'esbuild';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const dev = process.argv.includes('--dev');
const SRC = 'src', OUT = 'dist';

const options = {
  entryPoints: [`${SRC}/js/main.js`],
  bundle: true,
  format: 'iife', // a classic script: ES modules don't load from file://
  target: 'chrome110',
  outfile: `${OUT}/app.js`,
  minify: !dev,
  sourcemap: dev ? 'inline' : 'linked',
  legalComments: 'linked', // the libraries' licence headers, in app.js.LEGAL.txt
  define: { DEV: String(dev) }, // pwa.js: no service worker in a dev build
  logLevel: 'warning',
  plugins: [{ name: 'static', setup: (b) => b.onEnd((r) => { if (!r.errors.length) copyStatic(); }) }],
};

// Every file under src/ except the modules, copied to dist/; then sw.js stamped with the file list.
function copyStatic() {
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name), rel = path.relative(SRC, p);
      if (e.isDirectory()) { if (rel !== 'js') walk(p); continue; }
      fs.mkdirSync(path.dirname(path.join(OUT, rel)), { recursive: true });
      fs.copyFileSync(p, path.join(OUT, rel));
      files.push(rel);
    }
  };
  walk(SRC);
  const sw = path.join(OUT, 'sw.js');
  if (!fs.existsSync(sw)) return;
  const cached = files.filter((f) => f !== 'sw.js').concat('app.js').sort();
  const hash = createHash('sha256');
  for (const f of cached) hash.update(f).update(fs.readFileSync(path.join(OUT, f)));
  const text = fs.readFileSync(sw, 'utf8')
    .replace('__VERSION__', hash.digest('hex').slice(0, 12))
    .replace('[/* __FILES__ */]', JSON.stringify(['./'].concat(cached)));
  fs.writeFileSync(sw, text);
}

fs.rmSync(OUT, { recursive: true, force: true });
if (dev) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  // Static files are copied on each rebuild; touch a module to pick up an edit to index.html or style.css.
  const { port } = await ctx.serve({ servedir: OUT, port: 8765 });
  console.log(`http://localhost:${port}/`);
} else {
  await esbuild.build(options);
}
