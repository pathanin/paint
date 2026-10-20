# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A small MS-Paint-style image editor written in plain HTML, CSS and JS. The source is in `src/`: ES modules in `src/js/`, built by esbuild (`build.mjs`) into `dist/`. The built app is served over http(s) (`npm run serve`, `npm run dev`, GitHub Pages) and works offline once loaded, through the service worker. The output is ES modules (`format: 'esm'`, `splitting: true`): `app.js`, the three workers `fill-worker.js`, `png-worker.js` and `blob-worker.js`, and `chunks/`, where the libraries load with `import()` on first use. Opened from `file://`, where ES modules don't load, the page only shows a message to serve it. Icons are inline `<symbol>`s in `src/index.html`. `dist/` is not committed.

Third-party code comes from npm and is bundled in: pica (resize), UTIF (open TIFF) and UPNG (smaller PNG saves), with pako for the last two, and rbush (the scene's spatial index, loaded at boot). See "Libraries" below.

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

The e2e scripts test the **built** app: run `npm run build` (or keep `npm run dev` running) first. They drive an installed Google Chrome (`channel: 'chrome'`), or Playwright's WebKit (Safari's engine) with `BROWSER=webkit` (`test/e2e/browser.js`; once: `npx playwright install webkit`). smoke, history, preview, filledge, objects, alpha, libs and shots run in both; pwa, bench and parity use CDP or Chrome-only behaviour and stay on Chrome. WebKit's injected mouse input is whole CSS px (truncated), so checks that aim at pixel centres allow for that. End-to-end smoke test: `test/e2e/smoke.js` runs about 300 checks in one sequential script, and later sections depend on state from earlier ones.

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
node test/e2e/parity.js http://localhost:8766/   # same session on a master build (served on :8766) and this one: pixels equal
                                            # after every step (since the switch: --flatten-ref)
node test/e2e/safari.js                     # the real Safari via safaridriver (setup: README "Testing in Safari"; not yet run successfully)
node test/e2e/bench.js --json /tmp/pw/a.json   # perf benchmark (3 runs, medians)
node test/e2e/bench.js --only "inp 10000x10000 fill"   # one row; an inp row's filter must start with "inp <w>x<h>", or it's skipped silently
node test/e2e/bench-compare.js /tmp/pw/before.json /tmp/pw/a.json   # deltas; exit 1 on a regression
```

CI (`.github/workflows/ci.yml`, GitHub Actions) runs the unit tests, builds, and runs smoke, history, preview, filledge, objects, alpha, libs and pwa on every push to master and every PR, in the runner's installed Chrome. The benchmark isn't in CI: shared runners are too noisy to gate on. After a push to master that passes, CI's `deploy` job publishes `dist/` to GitHub Pages (https://pathanin.github.io/paint/). The repo's Settings → Pages → Source is "GitHub Actions"; the deploy fails without it.

The benchmark's `task` (CDP main-thread time) varies by about ±15% between runs. For sub-millisecond per-frame changes, compare Chrome traces instead.

When smoke fails, read the **first** `FAIL` line, because later failures often cascade from it. The tests drive the app through `window.__paint`, a test handle defined at the bottom of `src/js/main.js`. Add to it rather than reaching into the DOM for internal state.

## Architecture

- **`src/js/core.js`** holds pure, DOM-free helpers, exported through `module.exports` (Node's tests `require()` it; the modules import it through esbuild). They cover flood fill, Bresenham line, rect/resize/anchor math, the smoothed brush path (`Stroke`) and `History`. `History` is the bounded undo stack: it evicts by count and bytes and tracks a save point with `markSaved()`/`isClean()`. `push()` returns the number of entries it evicted. Anything testable without a canvas belongs here, test-first.
- **`src/js/*.js`** are the app's ES modules, one per area: `dom` (element handles, write-if-changed setters, `keyLabel`), `state` (`S`, `drag`, `sel`, constants), `toast`, `libs` (lazy libraries, workers), `doc` (document & history), `gpu` (context loss), `scene` (the object index and the `#image` cache), `assets`, `persist` (objects in a PNG), `view` (zoom, `render()`, status), `tools`, `fill`, `objects`, `text`, `selection`, `clipboard`, `transforms`, `fileio`, `dialogs`, `handles`, `pointer`, `keyboard`, `paste` (paste, drop, unload), `toolbar`, `tooltips`, `help`, `pwa` (manifest, service worker, launched files), and `main` (boot, `__paint`). Most modules wire their listeners when they load; `main.js` imports every one. The modules import each other in cycles; that's fine because load-time code only registers listeners and never calls into another module (boot calls happen in `main.js`).
  - **Each piece of mutable state is owned by one module**, which exports it as a live binding. Other modules read it directly but change it only through the owner's functions, since an ES module can't assign another's binding (esbuild fails the build if one tries): `setDrag()`/`setSel()` (`state`), `showObjs()`/`resetObjs()`/`mapObjs()`/`applyObjHist()`/`commitObjDrag()` (`objects`), `setCursor()`/`setHover()` (`view`). `base` and `bctx` change only in `adoptImage()` / `setDoc()` (`doc`), `multi` only in `objects`, `textAt` only in `text`.
  - The core state:
  - `S` holds settings and the document (tool, colours, sizes, zoom, file handle and name, `pristine`).
  - `drag` is the in-progress pointer gesture, keyed by `drag.t`: `pencil`, `brush`, `move`, `select`, `canvas`, `pan`, `objmove`, `objsize` (the Move tool, V, or a shape tool on its own selected shape), and so on.
  - `sel` is the selection; `sel.float` is a lifted or pasted canvas that hasn't been committed yet.
  - `textAt` is non-null while the text box is open.
  - `objs` is the list of objects, bottom to top: shapes (line, rect, ellipse), strokes (pencil, eraser = a colour-2 pencil, brush; in Transparent a stroke clears what is under it, with `destination-out`), text, image (a committed paste or lift) and fill (a frozen bitmap of what a fill changed); see `Core.objBox` for each kind's data. Every tool that marks the picture adds one **on top** (since the switch, 2026-10-17). A stroke is drawn live as the scene's top object (`setLive()`) through the same tile repaint, and joins on release without a repaint; a pencil or eraser stroke (whole-pixel rects, `Core.stampRects`) is drawn a piece at a time onto a canvas per tile it is in (`liveCv`), not composed again each frame, which a brush (one anti-aliased path per tile) still is. A lift leaves a colour-2 patch (a filled rect object; in Transparent it clears) and commits an image object, one undo step; Delete adds a patch. The fill reads what is seen (`composite()`) in its worker. Only whole-image ops, New/Open and ⌘E change the base. They are kept each with a fractional z-key `o.z` (`Core.zBetween`) that sorts like the list; they are drawn into `#image`'s cache over the base. `objSel` is the selected one's id; `multi` holds the ids when several are selected (Move tool box drag or ⇧-click), and `selList()` gives the selection either way. Every change goes through `install()`, which keeps the scene's index and repaint in step. Objects are immutable (edits make a new one with the same id) and become pixels only through `flattenObjs()` (⌘E). Crop, resize, canvas size, rotate and flip carry them along instead (`docOp(next, map)` with `Core.moveObj` / `scaleObj` / `transformObj`; one left wholly outside is dropped). Save, copy and the picker use `composite()`. See `docs/objects.md`.
- **Rendering:**
  - Two document-sized canvases (`doc.js`). `base` (not in the DOM) holds the pixels of the opened picture; since every mark is an object, only New, Open, whole-image ops and ⌘E change it. Whole-image ops swap in a new base canvas (`adoptImage()`), so `base` and `bctx` are reassigned; never cache them.
  - `#image` (`img`, `ctx`; never reassigned) is **a cache of the scene**: the base with every object over it, in z order. Only `scene.js` writes it. Save, copy, the picker and ⌘E read it, through `composite()` / `flushRedraw()`.
    - Replacing the base marks everything dirty, and so does every change of the object list (`sceneSwap()`, from `objects.js`'s `install()`). A microtask repaints the dirty **512² tiles**, each composed from scratch on a tile-sized canvas (`drawTiles()`, runs of 16 on a pool of scratches, so the GPU isn't serialized on one): base, then the objects whose boxes meet it (an `rbush` R-tree), sorted by z-key. So the cache is a pure function of the scene. Chrome's GPU anti-aliases a path differently depending on its batch and canvas offset, so any other split (blocks, drawing straight into `#image`) drifts. `__paint.freshRender()` draws the whole scene the same way, and `objects.js` checks they're equal.
    - The opened picture is the bottom object, `objs[0]` (`t: 'base'`, `locked`; decision 6), over the base canvas. It stays out of the R-tree (the tile repaint draws the base canvas first), never hit-tests, and `syncBase()` replaces it when the base canvas changes. `userObjs()` / `hasObjs()` mean the others. Only whole-image ops, New/Open and ⌘E replace it (as `doc` steps).
    - A repaint of over 64 tiles paints the visible ones first and the rest in slices (≤64 tiles or ~12 ms); `flushRedraw()` finishes them. Its cost is GPU time (~50 ms for 360 tiles at 10000²), so after it a WebGL2 fence (`fenceAfter()`) holds the next big repaint and the slices until the GPU is done: held arrows on 5k selected objects repaint once per GPU round instead of stacking. Small repaints never wait. Pan and zoom repaint nothing (`__paint.redrawCount`).
  - `#overlay` is only the pointer target. It is never drawn on, so it has no backing store.
  - `#preview` draws shape previews and floating selections. It covers only the visible part of the image plus a margin (`placePreview()`), at no more than screen resolution (image px when zoomed in, so they look pixelated).
  - `#ants` is the marching-ants element (CSS gradients, 1 CSS px, on its own layer), placed by `placeAnts()` in device px, so it stays crisp at every zoom.
  - `#ring` is a DOM brush-footprint cursor.
  - `render()` is rAF-throttled through `requestRender()`. It redraws the preview only when its inputs change (`ovKey`) and clears only the last drawn box (`ovBox`).
  - Pointer handlers only record state. All DOM writes happen in `render()`, through the write-if-changed setters (`setText`, `setAttr`, `setProp`). A DOM write inside `pointermove` forces a layout in Chrome's hit test.
- **Undo** (`Core.History`, bounded by count and bytes) has two entry types since the switch to objects (docs/total-objects.md):
  - `obj` entries hold a diff, `pairs` of `[now, then]` objects by id (`Core.diffObjs` / `applyPairs`), and swap it on apply, so an entry's size is per object changed, plus the bitmap of any asset it brings in (a paste, a fill). Streams of edits (held arrows, a colour-well drag) coalesce into one entry via `setObjs(next, key)`, except across the save point. A stroke, text, fill, lift + move or Delete is one such entry. Undo repaints only the changed objects' tiles.
  - `doc` entries hold the previous base canvas itself (crop, resize, rotate, flip, canvas size, a paste that grows the canvas, ⌘E), plus the previous object list (`e.objs`, swapped whole). `History`'s `onDrop` frees dropped canvases.
  - Nothing writes the base in place any more, so there are no undo tiles or idle readbacks. A GPU context loss on the base or a kept canvas drops the `doc` entries and those only reachable through them (`gpu.js`, `History.dropLost()`), and abandons an open float; a lost `#image` is repainted from the scene.
  - Every file the app encodes (save in any format, copy, the objects chunk's base and asset PNGs) goes through `encodeBlob()` (`libs.js`): a snapshot is taken (`createImageBitmap`, then `kickFrame()`) and transferred to `blob-worker.js` (one per call), which reads it back in strips into a CPU canvas and encodes that. `toBlob()` on a GPU canvas reads the whole canvas back on the main thread inside the call (~180 ms at 10000², in the keydown). A canvas of up to 2 MP, or any if the worker fails, is encoded with `src.toBlob()`. `__paint.used.encode` says which path ran.
  - The fill (`Core.fillPlan`: region, soft edge) runs in `fill-worker.js` on a snapshot of what is seen (an `ImageBitmap`, read back in the worker, so the page doesn't spend ~250 ms on `getImageData` at 10000²); the page stays live, so `runFill()` drops the result, with a flash, if the picture changed meanwhile (`sceneVer`, bumped by every change of the object list; the base; a float); a pan, selecting objects or a stroke still being drawn doesn't count. One fill at a time. Tests `await __paint.filling` before reading pixels. The worker also cuts the result along the scene's 512² tiles (`Core.fillCells`) and sends back only that, no pixels: per tile, the region as merged rects and the soft edge pixels, or, for a dense tile (noise-like masks, past `CELL_MAX` pieces), the tile's pixels. The fill object's asset (`cellAsset()`, `assets.js`) draws a tile's cells from paths built the first time it is drawn (a soft edge pixel that isn't opaque, and a Transparent fill's region, cleared first: an `rgba()` rect on a cleared pixel gives what `putImageData` would), so a tile repaint draws one cell, and no box-sized bitmap exists. Its `cv` and `maskCv` getters are for saving: a fill that clears or replaces soft pixels also saves its mask in the `paNt` chunk, so it reopens as it was.
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
- **Focus rules:** after a pointer click on a toolbar control, focus is released so single-letter shortcuts work. Keyboard activation keeps focus. The text box doesn't commit when focus moves into `.chrome`. `releaseFocus()` returns focus to an open text box. Safari differs twice: a focused element that gets hidden keeps focus (so `hideTextBox()` blurs the text box first), and clicking a button doesn't focus it (so the text box's blur takes the pointerdown target as its `relatedTarget`).
- **Pinch:** Chrome and Firefox send a trackpad pinch as ctrl+wheel; Safari sends `gesturestart/change/end` (cumulative `scale`), which `pointer.js` cancels and zooms by, ignoring any ctrl+wheel meanwhile.

## Libraries

- pica, utif2, upng-js and pako are npm dependencies pinned to exact versions in `package.json`. esbuild splits each into a chunk under `dist/chunks/` (about 180 KB together), which loads on first use: `loadPica()` and `loadUTIF()` in `src/js/libs.js`, and UPNG inside `png-worker.js`. Boot loads none of them (`libs.js` checks). UTIF and UPNG `require('pako')`, which esbuild resolves. pica's own workers run from blob URLs.
- Workers are entries in `build.mjs`, started by name with `startWorker()` (the URL is relative to the page, since the calling module may land in a chunk). `workerCall()` runs one job and rejects if the worker didn't load or threw. Worker names aren't content-hashed, so after a deploy a tab still running the old build starts the new worker: keep each worker's message format backward-compatible (or hash their names).
- `picaInst` is created on first use, so boot starts no workers.
- Each caller keeps a built-in path, for inputs past the library's budget and in case it throws: `scaleImage()` falls back to `resample()`, `encodePng()` to the browser's PNG, `encodeBlob()` to `toBlob`, and the fill to running `Core.fillPlan` on the main thread. TIFF has no built-in decoder, so a UTIF chunk that won't load says to reload. A chunk can fail to load in a tab left open across a deploy, without a service worker; `libs.js` blocks them all and checks each path. `__paint.used` records which path ran, and `libs.js` asserts it so that a silent fallback can't pass.
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

- Safari is supported from 16.4 (OffscreenCanvas 2D in workers); `build.mjs` targets `chrome110` and `safari16.4`. Safari has no File System Access API, so Open uses the file input and Save downloads. It decodes TIFF itself (UTIF isn't loaded there). `createImageBitmap(…, { premultiplyAlpha: 'none' })` drawn into a canvas gives wrong colours in WebKit: don't use it. Safari has no `requestIdleCallback` (`assets.js` falls back to 8 ms slices). In WebKit the GPU fence's 1 px upload blocks until the GPU is done, so `fenceAfter()` turns the fence off after two slow uploads. Past a browser's per-canvas cap a canvas draws nothing without throwing (iPadOS: 8192²), so `sizeProblem()` also checks `canvasFits()`.
- `confirmDiscard()` uses the synchronous native `confirm()` on purpose. Open must call `showOpenFilePicker` within the user gesture, and New applies on the synchronous `submit`, not `close`. An async in-app dialog would break both.
- Saving writes PNG, JPEG or WebP according to the file extension. A PNG with objects also carries them in a private `paNt` chunk (`persist.js`, `Core.withChunk`), so they come back on reopen; one re-encoded by another app (its IDAT hash differs) opens as pixels. Any other format (GIF, BMP) is saved as a PNG copy and never overwritten. So is a `.webp` where the browser has no WebP encoder (Safari: `toBlob` quietly returns a PNG), detected once in `fileio.js` (`WEBP`).
- After a main-thread snapshot of `#image` (`createImageBitmap`, or `drawImage` of it into another canvas), call `kickFrame()` (`view.js`). Otherwise the compositor's next frame waits until some canvas changes again (a fill click at 10000² showed nothing for ~300 ms; a bench row only sees it if the input also changes something on screen).
- Read one pixel of `#image` with `pixelAt()` (`dom.js`: a fresh 1 px GPU canvas). The picker used a `willReadFrequently` one, which read all of `#image` back for each click.
- Image assets keep a CPU copy for a GPU context loss only where one can happen (`LOSES` in `assets.js`: the canvas has an `oncontextlost` handler; WebKit has none), since the copy doubles their memory and is read back at idle.
- Don't call `toBlob()` on a big canvas, or post an `ImageBitmap` to a worker without transferring it: both read the whole thing back on the main thread (posting a copy serializes it). Use `encodeBlob()`, and transfer bitmaps.
- Drawing part of a GPU-backed `ImageBitmap` or canvas into a `willReadFrequently` (CPU) canvas reads the whole source back every time (~95 ms per call at 10000²). Cut the part out on a GPU canvas and `getImageData` that (`fill-worker.js`). Don't `getImageData` on `#image` itself for a pixel either: copy it into a 1 px canvas.
- Design decisions made during the UI polish, and why, are tabled in `task.md` along with the remaining backlog. Check it before changing UX behaviour.
