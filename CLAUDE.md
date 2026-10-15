# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A small MS-Paint-style image editor written in plain HTML, CSS and JS. The source is in `src/`: ES modules in `src/js/`, built by esbuild (`build.mjs`) into `dist/`. The built app is served over http(s) (`npm run serve`, `npm run dev`, GitHub Pages) and works offline once loaded, through the service worker. The output is ES modules (`format: 'esm'`, `splitting: true`): `app.js`, the two workers `fill-worker.js` and `png-worker.js`, and `chunks/`, where the libraries load with `import()` on first use. Opened from `file://`, where ES modules don't load, the page only shows a message to serve it. Icons are inline `<symbol>`s in `src/index.html`. `dist/` is not committed.

Third-party code comes from npm and is bundled in: pica (resize), UTIF (open TIFF) and UPNG (smaller PNG saves), with pako for the last two. See "Libraries" below.

## Commands

```bash
npm ci                                      # esbuild, the bundled libraries, Playwright (no browser download)
npm run build                               # src/ -> dist/ (minified, source map)
npm run dev                                 # unminified, rebuilds on change, serves dist/ on http://localhost:8765/ (edits to
                                            # non-JS files in src/ are copied on the next JS rebuild: touch a module)
npm run serve                               # serve an existing dist/ on :8765 (python3)
npm test                                    # unit tests for src/js/core.js (no build needed)
node --test --test-name-pattern="History" test/*.test.js   # single test by name
```

The e2e scripts test the **built** app: run `npm run build` (or keep `npm run dev` running) first. They drive an installed Google Chrome (`channel: 'chrome'`). End-to-end smoke test: `test/e2e/smoke.js` runs about 290 checks in one sequential script, and later sections depend on state from earlier ones.

```bash
node test/e2e/smoke.js                      # http://localhost:8765/
node test/e2e/shots.js /tmp/pw/shot         # light/dark/dialog/narrow screenshots
node test/e2e/history.js                    # pixel-exact undo/redo, undo depth
node test/e2e/preview.js                    # previews on screen at several zooms
node test/e2e/filledge.js                   # brush = one path; fill leaves no fringe at soft edges
node test/e2e/objects.js                    # live shapes: draw, move, resize, restyle, flatten (docs/objects.md)
node test/e2e/alpha.js                      # Transparent colour: tools clear, shapes refuse it, PNG keeps alpha
node test/e2e/libs.js                       # libraries: lazy, each path runs, round trips, fallbacks when a chunk won't load
node test/e2e/pwa.js                        # installable app: manifest, offline reload + lazy parts, launched files, file:// notice
node test/e2e/bench.js --json /tmp/pw/a.json   # perf benchmark (3 runs, medians)
node test/e2e/bench-compare.js /tmp/pw/before.json /tmp/pw/a.json   # deltas; exit 1 on a regression
```

CI (`.github/workflows/ci.yml`, GitHub Actions) runs the unit tests, builds, and runs smoke, history, preview, filledge, objects, alpha, libs and pwa on every push to master and every PR, in the runner's installed Chrome. The benchmark isn't in CI: shared runners are too noisy to gate on. After a push to master that passes, CI's `deploy` job publishes `dist/` to GitHub Pages (https://pathanin.github.io/paint/). The repo's Settings → Pages → Source is "GitHub Actions"; the deploy fails without it.

The benchmark's `task` (CDP main-thread time) varies by about ±15% between runs. For sub-millisecond per-frame changes, compare Chrome traces instead.

When smoke fails, read the **first** `FAIL` line, because later failures often cascade from it. The tests drive the app through `window.__paint`, a test handle defined at the bottom of `src/js/main.js`. Add to it rather than reaching into the DOM for internal state.

## Architecture

- **`src/js/core.js`** holds pure, DOM-free helpers, exported through `module.exports` (Node's tests `require()` it; the modules import it through esbuild). They cover flood fill, Bresenham line, rect/resize/anchor math, the smoothed brush path (`Stroke`) and `History`. `History` is the bounded undo stack: it evicts by count and bytes and tracks a save point with `markSaved()`/`isClean()`. `push()` returns the number of entries it evicted. Anything testable without a canvas belongs here, test-first.
- **`src/js/*.js`** are the app's ES modules, one per area: `dom` (element handles, write-if-changed setters, `keyLabel`), `state` (`S`, `drag`, `sel`, constants), `toast`, `libs` (lazy libraries, workers), `doc` (document & history), `tiles` (undo tiles), `view` (zoom, `render()`, status), `tools`, `fill`, `objects`, `text`, `selection`, `clipboard`, `transforms`, `fileio`, `dialogs`, `handles`, `pointer`, `keyboard`, `paste` (paste, drop, unload), `toolbar`, `tooltips`, `help`, `pwa` (manifest, service worker, launched files), and `main` (boot, `__paint`). Most modules wire their listeners when they load; `main.js` imports every one. The modules import each other in cycles; that's fine because load-time code only registers listeners and never calls into another module (boot calls happen in `main.js`).
  - **Each piece of mutable state is owned by one module**, which exports it as a live binding. Other modules read it directly but change it only through the owner's functions, since an ES module can't assign another's binding (esbuild fails the build if one tries): `setDrag()`/`setSel()` (`state`), `showObjs()`/`resetObjs()`/`mapObjs()`/`applyObjHist()`/`commitObjDrag()` (`objects`), `setCursor()`/`setHover()` (`view`). `img` and `ctx` change only in `adoptImage()` (`doc`), `op` only in `tiles`, `textAt` only in `text`.
  - The core state:
  - `S` holds settings and the document (tool, colours, sizes, zoom, file handle and name, `pristine`).
  - `drag` is the in-progress pointer gesture, keyed by `drag.t`: `pencil`, `brush`, `move`, `select`, `canvas`, `pan`, `objmove`, `objsize` (the Move tool, V, or a shape tool on its own selected shape), and so on.
  - `sel` is the selection; `sel.float` is a lifted or pasted canvas that hasn't been committed yet.
  - `textAt` is non-null while the text box is open.
  - `objs` is the list of shape objects (line, rect, ellipse), bottom to top, drawn above `#image` on `#preview`; `objSel` is the selected one's id. Objects are immutable (edits make a new one with the same id) and become pixels only through `flattenObjs()` (⌘E). Crop, resize, canvas size, rotate and flip carry them along instead (`docOp(next, map)` with `Core.moveObj` / `scaleObj` / `transformObj`; one left wholly outside is dropped). Pixel tools paint under them; save, copy and the picker use `composite()`. See `docs/objects.md`.
- **Rendering:**
  - `#image` is the document canvas. Whole-image ops swap in a new element (`adoptImage()`), so `img` and `ctx` are reassigned; never cache them.
  - `#overlay` is only the pointer target. It is never drawn on, so it has no backing store.
  - `#preview` draws shape previews and floating selections. It covers only the visible part of the image plus a margin (`placePreview()`), at no more than screen resolution (image px when zoomed in, so they look pixelated).
  - `#ants` is the marching-ants element (CSS gradients, 1 CSS px, on its own layer), placed by `placeAnts()` in device px, so it stays crisp at every zoom.
  - `#ring` is a DOM brush-footprint cursor.
  - `render()` is rAF-throttled through `requestRender()`. It redraws the preview only when its inputs change (`ovKey`) and clears only the last drawn box (`ovBox`).
  - Pointer handlers only record state. All DOM writes happen in `render()`, through the write-if-changed setters (`setText`, `setAttr`, `setProp`). A DOM write inside `pointermove` forces a layout in Chrome's hit test.
- **Undo** is copy-on-write and keeps one buffer per entry, which is swapped with the canvas on undo and redo. There are four entry types.
  - `region` entries come from `beginOp()`, then `touch(rect)` called **before** each draw into `rect`, then `endOp()`. Only the touched part of each 256² tile is stored.
    - Tiles are snapshotted on the GPU (`drawImage`, no readback): strokes (`beginOp(true)`) one small canvas per tile as the stroke reaches it; other ops one canvas per contiguous block of each `touch()`. A stroke with more than 512 live tiles reads them back early, which bounds GPU memory.
    - Undo/redo (`swapParts()`) snapshots the current pixels the same way, then writes the stored ones. Nothing reads the document back; parts held on the GPU are read back to `ImageData` at idle, a second after the last history change, ~64 MB per callback (`queueToData()`; `__paint.flushToData()` forces it). An open op's tiles (e.g. under a floating selection) are queued too; only a pointer gesture postpones the readback. One copy per entry at all times.
    - GPU context loss (`contextlost` on the document or a snapshot canvas) erases anything not yet read back: `gpuLost()` drops those entries, plus every entry only reachable through them (`History.dropLost()`), and abandons an open op on the GPU, with a flash.
    - Chrome makes each `drawImage` to or from a large canvas costly (1600 tile draws ~130–540 ms at 100 MP, one whole-image draw ~15 ms): snapshot and draw back per contiguous block (`Core.groupRects(…, 1)`), never per tile.
    - Never read back the document while a stroke is in progress; each readback stalls the next frame. `dropOp(true)` restores the tiles.
    - The brush (`brushCommit()`) draws each batch of segments by restoring its box from the op's tiles and stroking every segment that reaches it as one clipped path, so batches never ink an edge pixel twice. It `touch()`es the box first, so every tile it restores from exists.
  - The fill itself (`Core.fillPlan`: region, soft edge and undo data) runs in `fill-worker.js` on a transferred copy of the pixels; the page stays live, so `runFill()` drops the result, with a flash, if the image changed meanwhile (an open op, a float, `img` or the history top changed), like `scaleDoc()`; a pan or other pixel-free drag doesn't count. One fill at a time. Tests `await __paint.filling` before reading pixels.
  - `fill` entries store the before pixels, a bit mask and the new values of the anti-aliased ring around the region (`Core.fillEdge`, `ek`/`ev`), so neither undo nor redo reads the canvas. Redo paints the mask's runs as one `Path2D` fill (exact for the opaque fill colour), then the ring pixels one path per colour; masks with over 100k runs, or a ring that isn't opaque, fall back to recomputing and putting the pixels.
  - `obj` entries hold the other object list and swap it on apply. Streams of edits (held arrows, a colour-well drag) coalesce into one entry via `setObjs(next, key)`, except across the save point. A flatten is a `region` entry that also carries the object list, so one undo un-bakes the pixels and brings the objects back.
  - `doc` entries hold the previous `#image` element itself (crop, resize, rotate, a paste that grows the canvas), plus the previous object list when the op moved objects. `History`'s `onDrop` frees dropped canvases.
  - Unsaved state is `isDirty()` = `!hist.isClean()` OR a floating selection OR non-empty open text. Never keep a separate dirty flag.
- **UI wiring** is mostly data-driven from attributes in `src/index.html`:
  - `data-tool` and `data-cmd` buttons are dispatched by one document-level click handler, which looks commands up in `CMDS`.
  - `.opts [data-for="tool1 tool2"]` elements show or hide per tool in `setTool()`.
  - `data-tip` / `data-kbd` / `data-hint` feed the custom tooltip. Shortcut labels are written Mac-style (`⌘⇧`), and `keyLabel()` converts them for other platforms. `aria-keyshortcuts` and `aria-description` are generated from the same attributes at boot.
  - The shortcuts dialog is generated from the `HELP` table. Keep `HELP`, the `data-kbd` attributes, the README table and the keydown handler in sync.
- **Keyboard:**
  - `keyId(e)` maps keys by the character on the user's layout and falls back to the physical key for non-Latin letters. Digits stay physical.
  - Order in the keydown handler: a focus tooltip swallows the first Esc; dialogs and text fields return; while `drag` is set only Esc (cancel) and Shift (constrain shapes) act; then come modifier shortcuts, then single keys.
  - Arrows nudge the selection only when focus is on the canvas. Toolbars use roving tabindex through `rove()`.
- **Focus rules:** after a pointer click on a toolbar control, focus is released so single-letter shortcuts work. Keyboard activation keeps focus. The text box doesn't commit when focus moves into `.chrome`. `releaseFocus()` returns focus to an open text box.

## Libraries

- pica, utif2, upng-js and pako are npm dependencies pinned to exact versions in `package.json`. esbuild splits each into a chunk under `dist/chunks/` (about 180 KB together), which loads on first use: `loadPica()` and `loadUTIF()` in `src/js/libs.js`, and UPNG inside `png-worker.js`. Boot loads none of them (`libs.js` checks). UTIF and UPNG `require('pako')`, which esbuild resolves. pica's own workers run from blob URLs.
- Workers are entries in `build.mjs`, started by name with `startWorker()` (the URL is relative to the page, since the calling module may land in a chunk). `workerCall()` runs one job and rejects if the worker didn't load or threw. Worker names aren't content-hashed, so after a deploy a tab still running the old build starts the new worker: keep each worker's message format backward-compatible (or hash their names).
- `picaInst` is created on first use, so boot starts no workers.
- Each caller keeps a built-in path, for inputs past the library's budget and in case it throws: `scaleImage()` falls back to `resample()`, `encodePng()` to `toBlob`, and the fill to running `Core.fillPlan` on the main thread. TIFF has no built-in decoder, so a UTIF chunk that won't load says to reload. A chunk can fail to load in a tab left open across a deploy, without a service worker; `libs.js` blocks them all and checks each path. `__paint.used` records which path ran, and `libs.js` asserts it so that a silent fallback can't pass.
- To bump a version: `npm i --save-exact <pkg>@<ver>`, rebuild, and run `libs.js`.
- Scaling is async. `scaleDoc()` drops its result if the document changed while it ran.
- The budgets come from measurements on an M4 (the numbers are in the code comments):
  - pica is CPU-bound and gets superlinear on large downscales, so past `PICA_MAX_PIXELS` (50 MP, source plus result) the built-in GPU path runs.
  - UPNG runs in `png-worker.js` (one per save), so the page doesn't freeze, but Save waits for it. It runs only up to `UPNG_MAX_PIXELS` (one 4K screen) and when `upngMs()` estimates it within `UPNG_BUDGET_MS` (750 ms). The estimate uses the browser PNG's size as an entropy proxy.
  - Both encoders run, and the smaller blob is kept.

## Installable app (PWA)

- `pwa.js` (`setUpPwa()`, on `load`) links `manifest.webmanifest` and registers `sw.js`.
- `sw.js` is network-first with a cached fallback (offline, or after `NET_WAIT_MS`). Cache-first would keep serving an old build, and would shadow `npm run dev` on the same origin. `build.mjs` stamps it with the file list (the static files and every script esbuild wrote, from its metafile, so the lazy chunks work offline) and a content hash, so each build gets a fresh cache. The previous build's cache is kept, and a 404 is answered from it: a tab still running that build asks for chunks only it knew (`test/e2e/pwa.js`).
- A dev build (`define: { DEV }`) unregisters any service worker instead of registering one.
- `manifest.webmanifest` `file_handlers` make the installed app an "Open with" target for images. Launches arrive through `launchQueue`, whose consumer `main.js` sets after boot (`openLaunched()`). The file handle is kept, so ⌘S writes back.
- Any new file the page loads must live in `src/` (outside `src/js/`), so it's copied to `dist/` and into the service worker's list.

## Constraints and conventions

- `confirmDiscard()` uses the synchronous native `confirm()` on purpose. Open must call `showOpenFilePicker` within the user gesture, and New applies on the synchronous `submit`, not `close`. An async in-app dialog would break both.
- Saving writes PNG, JPEG or WebP according to the file extension. Any other format (GIF, BMP) is saved as a PNG copy and never overwritten.
- Design decisions made during the UI polish, and why, are tabled in `task.md` along with the remaining backlog. Check it before changing UX behaviour.
