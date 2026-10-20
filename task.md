# Design notes: Paint

Open work, settled decisions, and measured gotchas. Read before changing UX behaviour. Architecture and commands are in `CLAUDE.md`; shapes in `docs/objects.md`. Full history is in `git log`.

## Status

All of this is done and merged to `master`:

- UI polish: 15 review rounds (2026-10-13); the last two found nothing.
- Performance: fill in a worker, crisp marching ants, smooth brush. Measure with `test/e2e/bench.js` + `bench-compare.js`.
- Objects: line, rect and ellipse are editable shapes, with a Move tool (V).
- Build step (esbuild), installable PWA, GitHub Pages deploy, libraries bundled from npm and lazy-loaded.
- **Total objects** (PR 14): every mark (strokes, eraser, fill, text, images, the opened picture) is an object, with tldraw-style z-keys, an R-tree and diff history over `#image` as a document-resolution cache of the scene. See `docs/total-objects.md`. The user took all ten recommended defaults (2026-10-17); Phase 0's measurements are below. Undo tiles and the idle readback are gone.
- **Responsiveness, Chrome and Safari** (2026-10-20): the fill worker sends back its result cut along the scene's tiles (`Core.fillCells`) instead of the pixels and undo data (800 MB at 100 MP, now kilobytes for a plain region); building the paths on the page took ~60 ms at 16 MP (main-thread JS for one fill 80 → 24 ms, heap growth 130 → 3 MB, headless Chromium on a software GPU). Fills over transparency and Transparent fills are paths too (they were two box-sized bitmaps, each with a CPU copy) and now reopen from a PNG as they were (their clearing mask is saved). A live pencil or eraser stroke draws each new piece onto its tile's canvas instead of composing the tile again every frame (main-thread time for a 400-move scribble 715 → 354 ms, and it no longer grows with the stroke's length), and stamps are one rect per run of a line. The picker no longer reads all of `#image` back per click. Image assets keep no CPU copy where a 2D context can't be lost (WebKit). The bench wasn't run (user's call): measured with one-off CPU profiles, then an in-page A/B (pre-PR `master` 2315e42 vs after) at 4000² on a software GPU, in Playwright's Chromium and in WebKitGTK 2.52's MiniBrowser (Ubuntu's `webkit2gtk-driver` under Xvfb, driven over WebDriver, since Playwright's WebKit download was blocked there):
  - pencil scribble, 300 frames of 4 moves, main-thread ms per frame (first 50 → last 50): Chromium 0.97 → 2.30 before, 0.93 → 0.79 after; WebKit 5.4 → 27.2 before (worst 66), 3.7 → 3.5 after (worst 11). Chromium's wall time for it 99 → 37 s.
  - background fill around 12 rings (medians of 3): Chromium total 1909 → 1348 ms, longest frame gap 611 → 236 ms, heap growth 131 → 3 MB; WebKit total 1035 → 920 ms, the pause when it lands 168 → ~90 ms (with the follow-up fix: a tile drew the cells right of and below it too).
  - picker: ~1–2 ms in both engines when the GPU is idle, before and after; the whole-`#image` readback CLAUDE.md measured on the M4 doesn't show on a software GPU.
- **INP at 10000²** (PR 15): scene repaint on a pool of scratch tiles behind a GPU fence (nudge 864 → 88 ms), fill readback in its worker (312 → 32 ms), copy and save encoded in `blob-worker.js` (152–160 → 32 ms), and bench `inp …` rows (Event Timing with real input). The `second fill click (with damage)` row was checked only on a software GPU (inp200 1 without `kickFrame()`, 0 with); not yet on the M4.

## Open

**Not verified:**
- Firefox (no runs at all yet).
- Real Safari. Every suite except pwa runs in Playwright's WebKit (`BROWSER=webkit`, 2026-10-18), which is close to Safari 27 but not Safari. Still to try by hand: trackpad pinch (only synthetic gesture events are tested), real clipboard copy/paste, the first-download prompt, Add to Dock, and feel at 10000² (a functional pass at 10000² and 16384×6100 in WebKit was fine: no blank canvases, no canvas-memory warnings). WebKit dropped its total canvas memory cap in June 2023 (bug 195325): running out now gets the tab killed and reloaded, losing unsaved work, so an 8 GB Mac at 100 MP is the tightest case. Safari 16.x may still have the old cap (RAM/4); a failed `getContext` there would throw in doc ops without a toast.
- Safari's download path marks the document saved once `a.click()` runs. If Safari silently blocks a download started after a long encode, the document looks clean, so after an encode over 1 s the toast offers "Download again" (a fresh click; user's call, 2026-10-18).
- `test/e2e/safari.js` drives the real Safari through safaridriver. It has never connected here: with "Allow remote automation" on and `safaridriver --enable` done, session creation still timed out (Safari probably needs a restart after the setting). Its checks are unverified until it runs.
- Superseded big canvases (the old base after a rotate) wait for GC rather than being freed at once: the history and objects may still refer to them, so it wasn't changed.
- iPad: per-canvas cap 8192² (67 MP); `canvasFits()` now refuses bigger documents with a message instead of a blank picture. iOS Safari never shows a `beforeunload` prompt.
- WebKit flake: smoke's "mid-stroke: ink reaches the pointer" failed once in about five WebKit runs (a 50 ms wait).
- Safari draws range sliders natively: it ignores `accent-color` there, so Size/Smoothing are grey, not blue.
- A real Windows machine (labels were checked only with a `navigator.platform` override).
- A VoiceOver pass over dialogs, toasts and the canvas label.
- The DPR-change path (`matchMedia` watcher); CDP emulation doesn't fire `change`.
- Headed GPU runs of very large scribbles; a real GPU driver reset (only a dispatched `contextlost` is tested).
- Oversized open/paste with real 100+ MP files (tested with fake bitmaps).
- Save As `prompt()` path (tested with a stubbed `prompt`).

**Out of scope** unless the user asks (feature work, not polish): fill clipped to a selection, selection resize handles, auto text size, cancelling freehand strokes with Esc, phone widths (<600px; bars scroll sideways).

## Total objects: Phase 0 measurements (2026-10-17)

- **Parity harness:** `test/e2e/parity.js <master url> [branch url] [--flatten-ref]` replays 23 steps (every tool, select move/delete, undo/redo, rotate, flip, canvas size, crop, an opened PNG with alpha, and fills and a brush over it) on both builds and compares the decoded pixels after each. On this branch before Phase 1: all 23 identical to `master`. With `--flatten-ref`, 15 differ, as they should: there the reference stacks shapes in drawing order.
- **Spike** (scratch page, not in `src/`; Chrome, M4, headless): `redraw(rect)` = put back the base under a 256² block, then stroke every object whose box touches it (30-segment brush strokes, 2–12 px), at 10000². Each figure is ms per redraw over 20 redraws plus one flush, so GPU work is included.

  | Strokes under the block | Straight onto the 10000² canvas | Block drawn on a small scratch canvas, then copied in |
  |---|---|---|
  | 0 | 0.6 | 0.6 |
  | 100 | 13.0 | 0.6 |
  | 500 | 13.3 | **0.9** |
  | 5,000 | 28.6 | 4.1 |
  | 20,000 | 72 | — |

  Full rebuild of 5,000 strokes at 10000²: **~32 ms**; the visible 1600×1000 part: ~10 ms. Main-thread time was under 0.5 ms per redraw up to 1,000 strokes.
- **Finding:** any path drawn into a 10000² canvas right after a `drawImage` into it costs ~12 ms of GPU time, whatever the path. Drawn on a block-sized scratch canvas and copied in with one `drawImage`, the cost is gone. So `redraw()` composes each block on a scratch canvas. At 2000² and 4000² the difference is small.
- **Gate (≤ 8 ms per 256² redraw with 500 strokes, ≤ 2 s for a full 5k rebuild at 10000²):** passed, 0.9 ms and ~32 ms, with the scratch-canvas redraw. Lift-on-drag isn't needed from the start.
- **Correction found in Phase 1: exact block redraws aren't possible on Chrome's GPU canvas.** How a path is anti-aliased depends on what else is in the same GPU batch. On one canvas, a 2 px line drawn after an ellipse has an edge pixel of 128 instead of 28 (Chrome switches the batch to multisampling), and the same draw at another canvas offset gives yet another value (up to 100 of 255 off). So no redraw can be byte-identical to `master`'s composite, which has the same dependence. What can be exact, and is:
  - **The cache is a pure function of the scene.** It is repainted in whole 512² tiles, each composed from scratch on a tile-sized canvas at the tile's origin. A pixel always gets the same draws in the same batch, whatever caused the repaint. `objects.js` checks the cache against `__paint.freshRender()` (the same tile method, whole) after random edits, and the check fails if a removed object's box isn't repainted.
  - **Parity:** before the switch, the raster (`__paint.base` here, `#image` on `master`) and the object records are byte-identical to `master`. Composites with path objects are compared within anti-aliasing (no channel off by half the range, ≤ 0.5% of pixels): the line step differs by 788 px, worst channel 67.
  - **Measured alternatives** (ms per 256² block with 100 / 500 / 5,000 strokes; full 5k rebuild), at 2000² and 4000²:

    | Variant | 2000² | 4000² | Exact against its own full render |
    |---|---|---|---|
    | In place, batch ended after each object (1×1 `drawImage`) | 42 / 172 / 2070; 1991 | 146 / 729 / 7296; 7282 | yes |
    | Whole tiles, batch ended after each object | 12 / 58 / 576; 1059 | 12 / 59 / 577; 1106 | yes |
    | **Whole tiles, no batch ends (chosen)** | 0.2 / 0.5 / 5.0; 13 | 0.3 / 0.5 / 4.3; 53 | **yes** |

    At 10000², whole 256² tiles took 0.7 / 1.3 / 4.8 ms and 583 ms for a full rebuild; 512² tiles bring the rebuild in the app to 163 ms (bench `rebuild 5k (rotate)`). The gate still passes.
- **Bench baselines on `master`** (new `bench.js` rows, `--only 5k`, 1 run): `scene 5k objects` 151 / 133 ms (4000×3000 / 10000²), `move one in 5k` 226 / 235 ms, `stroke over 5k` 1130 / 1534 ms (12 long frames at 10000²), `rebuild 5k (rotate)` 17 / 19 ms.

1. **Not yet verified:**
   - Firefox. It has no File System Access API, so the download-save path runs there. The `:has()`, `field-sizing` and `text-wrap: balance` CSS also needs checking. (Safari: see Open above.)
   - A real Windows machine.
   - A VoiceOver pass over dialogs, toasts and the canvas label.
2. **Phone widths (<600px)** are out of scope, since the app is desktop-first. The top bar and options bar scroll sideways there rather than reflowing.

## Decisions (don't relitigate without a new reason)

**Platform and build**
- Served over http(s) only; `file://` shows a "serve it" message (user's call, 2026-10-16). ES-module output with lazy chunks and workers.
- PWA with a network-first service worker. Cache-first served stale builds and shadowed the dev server.
- Libraries bundled from npm: pica (≤ 50 MP), UPNG (≤ ~750 ms estimated), UTIF. Each keeps a built-in fallback. pica's `mks2013` filter oversharpens, so it isn't used.
- Rejected: gifenc (would flatten animated GIFs), wasm encoders (need `fetch` or huge inline binaries), heic2any (2.7 MB).

**Dialogs and saving**
- Native `confirm()` for discarding changes: Open must call `showOpenFilePicker` synchronously in the click.
- Native `prompt()` for the name in Save As when there's no `showSaveFilePicker`.

**Keyboard and focus**
- ⇧0 = 100%, ⇧1 / ⌘0 = fit (Chrome reserves ⌘1).
- Text: Enter applies, Shift+Enter adds a line; key hints in the status bar.
- Options bar: keyboard changes keep focus; pointer changes return focus to the canvas.
- Tab order: top bar → options bar → tool rail → canvas; each toolbar is one roving-tabindex stop.
- Esc order: focus tooltip → cancel drag → dismiss error toast (never while a modal is open) → deselect.
- `[` / `]` snap to the 1…10, 12, 14… grid.
- Windows labels say "Ctrl+Plus/Minus", not "Ctrl++".
- Crop uses `aria-disabled`, not `disabled`, so its explanation stays reachable.

**Layout and look**
- ≤844px: file name hidden; unsaved = dot on Save. (Breakpoints moved up 24px for the palette's Transparent column: 760 → 784, 820 → 844, compact options 640 → 724.)
- Palette: 24px targets with 18px chips (WCAG 2.5.8); colours 1 and 2 marked by rings only, no badges. "Size" and "Smoothing" labels hidden ≤724px (each slider keeps its aria-label and tooltip).
- Toasts bottom-centre, `pointer-events: none` except errors. One sentence = no period; errors read "X failed: <plain reason>".
- Smooth rendering when zoom × DPR < 1, pixelated from there up.
- No refit after paste/rotate/flip, no auto-scroll during handle drags, no touch pan, no backdrop-click close. Desktop-first.
- Help (`?`) has three columns.

**Painting**
- Brush smoothing: lazy-brush radius (screen px), then a triangular average along the path (points 2 screen px apart, 3 × smoothing either side, shrinking at the ends) + midpoint quadratic curves, live tail on the overlay, ends exactly at release. The average is what removes a mouse's whole-pixel staircase on shallow lines: the lazy brush alone filters over only its radius. Default 2, 0 = off. Pencil and eraser stay pixel-exact.
- Brush stays anti-aliased and is never inked twice at its edges (`test/e2e/filledge.js`): a stroke is one object, drawn as one path per 512² tile of the scene cache, live as it grows (on `master`: each batch redrawn from the stroke's undo tiles as one clipped path).
- Fill recolours the anti-aliased ring around the region (`Core.fillEdge`, up to 8 px) so no fringe is left. Pixels that aren't a clean blend are left untouched.
- Transparent is a colour value (`CLEAR`) either slot can hold, from a tall checkered chip in an 11th palette column (user's call, 2026-10-16, over a per-document mode or always erasing like Paint.NET). Pixel tools clear with it; Delete, a lift and a grown canvas leave it; shapes and text refuse it; a shape fill in it is no fill. Default colour 2 stays white.
  - Never written into `<input type=color>` (Chrome shows black); the well keeps its last colour under a checkerboard. Swap never makes a selected shape's line transparent.
  - Fill to transparent keeps the ink colour on the soft edge and fades its alpha; a straight-RGBA lerp darkened it.
  - An erasing brush tail can't cut a hole in `#preview`, so it's drawn with the stage's checkerboard.
  - With total objects: a pencil, brush or eraser stroke in Transparent is an object that clears what is under it (and moves with it); a lift's or Delete's patch with colour 2 Transparent clears too; Fill in Transparent inside an outlined shape with a fill removes the fill, and elsewhere clears what is seen; editing an existing text works while colour 1 is Transparent.

**Shapes (objects)**
- Always editable, no on/off switch. On `master`: pixel tools paint under them; flattened on save, not kept in the file.
- Total objects (2026-10-17, the user's call, the ten defaults in `docs/total-objects.md`): every mark is an object, and new marks go on top of everything; one stroke = one object; the eraser is a colour-2 stroke and ⌥-drag with it deletes whole objects; a fill is a bitmap object frozen at fill time, and a fill click inside a closed shape sets its fill; the opened picture is the bottom object, locked; a lift makes an image object plus a colour-2 patch; PNG saves carry the objects in a private `paNt` chunk; zooming in shows real pixels. It reverses `docs/objects.md`'s "no full scene graph", "pixel tools paint under shapes" and "gone on reopen".
- Move tool (V) picks, moves, resizes; Select stays pixels-only. With total objects, a drag on empty canvas box-selects (decision 7b; Space or the middle button pans), ⇧-click adds or removes, and ⌘E with a selection flattens just it (one image per run of neighbours, so nothing seen changes).
- 3 screen px drag threshold. Shift locks axis / keeps aspect / snaps line to 45°, also mid-drag. Small shapes drop midpoint handles.
- Hover outlines the shape a click would pick. ⌥-drag copies, placed just above the original.
- With the Move tool, Tab / ⇧Tab cycle shapes and release focus at the ends (no focus trap).
- Crop, resize, canvas size, rotate and flip carry shapes along in one undo step; crop drops shapes wholly outside.

## Measured gotchas (Chrome, M4, 10000² canvas)

- Any readback of the document mid-stroke costs ~10 ms a frame.
- A canvas that was read back must not be reused as a snapshot target: drawing into it becomes a readback too.
- One 400 MB readback ≈ 70 ms; 40 band readbacks ≈ 340 ms.
- A DOM write inside `pointermove` forces a layout in the hit test.
- Comparing against a `style` read-back never matches for fractional px; cache the last value written.
- `WeakMap` has no `.size`.
- `createImageBitmap(#image)` leaves GPU work that only a frame with a changed canvas sends off: call `kickFrame()` after it, or the next frame waits ~310 ms. Only a second or later fill shows it, and only if the click also changes something on screen.
- `toBlob()` on a 10000² GPU canvas reads it all back on the main thread inside the call (~180 ms); `encodeBlob()` does it in a worker.
- Bench: `task` varies ±15% between runs. The `10000 pencil stroke` long-frame count swings 1–80 depending on earlier scenarios; compare against a same-filter master run.
