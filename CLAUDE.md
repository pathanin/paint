# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A small MS-Paint-style image editor written in plain HTML, CSS and JS. It has no build step. It must keep working when `index.html` is opened directly from `file://` in Chrome, and offline. That rules out ES modules, `fetch`, and external SVG sprite references; icons are inline `<symbol>`s in `index.html`.

The only CDN code is optional: pica (resize), UTIF (open TIFF) and UPNG (smaller PNG saves), with pako for the last two. See "Optional libraries" below. They preload at idle after boot (cached by the browser after that), and every feature that uses one has a built-in path.

## Commands

```bash
python3 -m http.server 8765                 # dev server (also .claude/launch.json "paint" for the preview pane)
node --test test/*.test.js                  # unit tests for js/core.js (no deps)
node --test --test-name-pattern="History" test/*.test.js   # single test by name
```

End-to-end smoke test: `test/e2e/smoke.js` runs about 280 checks in one sequential script, and later sections depend on state from earlier ones. It is dev-only and needs Playwright on `NODE_PATH` plus an installed Google Chrome (`channel: 'chrome'`).

```bash
mkdir -p /tmp/pw && (cd /tmp/pw && npm i playwright@1)
NODE_PATH=/tmp/pw/node_modules node test/e2e/smoke.js                      # http://localhost:8765/
NODE_PATH=/tmp/pw/node_modules node test/e2e/smoke.js file://$PWD/index.html
NODE_PATH=/tmp/pw/node_modules node test/e2e/shots.js /tmp/pw/shot         # light/dark/dialog/narrow screenshots
NODE_PATH=/tmp/pw/node_modules node test/e2e/history.js                    # pixel-exact undo/redo, undo depth
NODE_PATH=/tmp/pw/node_modules node test/e2e/preview.js                    # previews on screen at several zooms
NODE_PATH=/tmp/pw/node_modules node test/e2e/filledge.js                   # brush = one path; fill leaves no fringe at soft edges
NODE_PATH=/tmp/pw/node_modules node test/e2e/objects.js                    # live shapes: draw, move, resize, restyle, flatten (docs/objects.md)
NODE_PATH=/tmp/pw/node_modules node test/e2e/libs.js                       # CDN libraries: online, offline, CDN hanging
NODE_PATH=/tmp/pw/node_modules node test/e2e/bench.js --json /tmp/pw/a.json   # perf benchmark (3 runs, medians)
node test/e2e/bench-compare.js /tmp/pw/before.json /tmp/pw/a.json           # deltas; exit 1 on a regression
```

CI (`.github/workflows/ci.yml`, GitHub Actions) runs the unit tests and smoke (http and `file://`), history, preview, filledge, objects and libs on every push to master and every PR, in the runner's installed Chrome. The benchmark isn't in CI: shared runners are too noisy to gate on.

The benchmark's `task` (CDP main-thread time) varies by about ±15% between runs. For sub-millisecond per-frame changes, compare Chrome traces instead.

When smoke fails, read the **first** `FAIL` line, because later failures often cascade from it. The tests drive the app through `window.__paint`, a test handle defined at the bottom of `js/app.js`. Add to it rather than reaching into the DOM for internal state.

## Architecture

- **`js/core.js`** holds pure, DOM-free helpers that are exported as `window.Core` and through `module.exports` for Node. They cover flood fill, Bresenham line, rect/resize/anchor math, the smoothed brush path (`Stroke`) and `History`. `History` is the bounded undo stack: it evicts by count and bytes and tracks a save point with `markSaved()`/`isClean()`. `push()` returns the number of entries it evicted. Anything testable without a canvas belongs here, test-first.
- **`js/app.js`** is one IIFE organised into `// ---------- section ----------` blocks: document & history, view, tools, text, selection, clipboard, transforms, file I/O, dialogs, handles, pointer, keyboard, toolbar wiring, tooltips, help, boot. The core state lives in module locals:
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
  - `fill` entries store the before pixels, a bit mask and the new values of the anti-aliased ring around the region (`Core.fillEdge`, `ek`/`ev`), so neither undo nor redo reads the canvas. Redo paints the mask's runs as one `Path2D` fill (exact for the opaque fill colour), then the ring pixels one path per colour; masks with over 100k runs, or a ring that isn't opaque, fall back to recomputing and putting the pixels.
  - `obj` entries hold the other object list and swap it on apply. Streams of edits (held arrows, a colour-well drag) coalesce into one entry via `setObjs(next, key)`, except across the save point. A flatten is a `region` entry that also carries the object list, so one undo un-bakes the pixels and brings the objects back.
  - `doc` entries hold the previous `#image` element itself (crop, resize, rotate, a paste that grows the canvas), plus the previous object list when the op moved objects. `History`'s `onDrop` frees dropped canvases.
  - Unsaved state is `isDirty()` = `!hist.isClean()` OR a floating selection OR non-empty open text. Never keep a separate dirty flag.
- **UI wiring** is mostly data-driven from attributes in `index.html`:
  - `data-tool` and `data-cmd` buttons are dispatched by one document-level click handler, which looks commands up in `CMDS`.
  - `.opts [data-for="tool1 tool2"]` elements show or hide per tool in `setTool()`.
  - `data-tip` / `data-kbd` / `data-hint` feed the custom tooltip. Shortcut labels are written Mac-style (`⌘⇧`), and `keyLabel()` converts them for other platforms. `aria-keyshortcuts` and `aria-description` are generated from the same attributes at boot.
  - The shortcuts dialog is generated from the `HELP` table. Keep `HELP`, the `data-kbd` attributes, the README table and the keydown handler in sync.
- **Keyboard:**
  - `keyId(e)` maps keys by the character on the user's layout and falls back to the physical key for non-Latin letters. Digits stay physical.
  - Order in the keydown handler: a focus tooltip swallows the first Esc; dialogs and text fields return; while `drag` is set only Esc (cancel) and Shift (constrain shapes) act; then come modifier shortcuts, then single keys.
  - Arrows nudge the selection only when focus is on the canvas. Toolbars use roving tabindex through `rove()`.
- **Focus rules:** after a pointer click on a toolbar control, focus is released so single-letter shortcuts work. Keyboard activation keeps focus. The text box doesn't commit when focus moves into `.chrome`. `releaseFocus()` returns focus to an open text box.

## Optional libraries

- The `LIBS` table in `js/app.js` lists each library with an exact version, an SRI hash and its dependencies. `lib(name)` injects a classic `<script crossorigin integrity>` and resolves to the library's global. It rejects after `LIB_TIMEOUT` (4 s). The rejection is reused, so an unreachable CDN costs one wait at most. A later use falls back at once but starts a background retry (at most every `LIB_RETRY_MS`, 30 s); the `online` event clears failures, and a script that arrives after its timeout is picked up (`libReady()`).
- Scripts are `async = true`. In-order execution (`async = false`) let one stalled library block the others; dependencies are awaited instead.
- Boot calls `preloadLibs()` from `requestIdleCallback`. jsDelivr sends `immutable, max-age=31536000`, and Chrome serves those files from disk cache after a restart, even offline and from `file://`. Don't short-circuit on `navigator.onLine`: that skips the cache. `picaInst` is still created on first use, so the preload starts no workers.
- `fallbackNote()` is the once-a-session notice. It fires only when `lib()` rejected (`used.resizeMissed`, `used.pngMissed`), not when a budget skipped the library. It says "Working offline" when `navigator.onLine` is false, and that the libraries couldn't be loaded otherwise.
- Every caller catches the rejection and falls back: `scaleImage()` falls back to `resample()`, `encodePng()` to `toBlob`, and `decodeFile()` to an error saying the TIFF reader couldn't be downloaded. `__paint.used` records which path ran, and `libs.js` asserts it so that a silent fallback can't pass the online checks.
- To bump a version, change the path and recompute the hash: `curl -sL https://cdn.jsdelivr.net/npm/<pkg>@<ver>/<file> | openssl dgst -sha384 -binary | openssl base64 -A`.
- Scaling is async. `scaleDoc()` drops its result if the document changed while it ran.
- The budgets come from measurements on an M4 (the numbers are in the code comments):
  - pica is CPU-bound and gets superlinear on large downscales, so past `PICA_MAX_PIXELS` (50 MP, source plus result) the built-in GPU path runs.
  - UPNG runs on the main thread. It runs only up to `UPNG_MAX_PIXELS` (one 4K screen) and when `upngMs()` estimates it within `UPNG_BUDGET_MS` (750 ms). The estimate uses the browser PNG's size as an entropy proxy.
  - Both encoders run, and the smaller blob is kept.

## Constraints and conventions

- `confirmDiscard()` uses the synchronous native `confirm()` on purpose. Open must call `showOpenFilePicker` within the user gesture, and New applies on the synchronous `submit`, not `close`. An async in-app dialog would break both.
- Saving writes PNG, JPEG or WebP according to the file extension. Any other format (GIF, BMP) is saved as a PNG copy and never overwritten.
- Design decisions made during the UI polish, and why, are tabled in `task.md` along with the remaining backlog. Check it before changing UX behaviour.
