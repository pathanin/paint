# Design notes: Paint UI

The design decisions behind the current UI, the evidence behind them, and what's still open. Read this before changing UX behaviour. The commands for running the checks are in `CLAUDE.md` and `README.md`.

## Scope and testing so far

- The UI was polished over 15 review rounds (2026-10-13), each with a fresh UX reviewer. The last two rounds found no defects. Each change's rationale is in its commit message (`git log`).
- Tested only in desktop Chrome on macOS (DPR 1 and 2). Windows key labels were checked with a `navigator.platform` override only.

## Layout and behaviour at a glance

- **Layout.** A top bar holds file, undo, image ops, the doc name and zoom. A contextual options bar shows tool options, a short hint, the colour well and the palette. A left tool rail holds the tools. The status bar shows cursor, selection, size, text-key hints and a first-run hint. Icons are inline Lucide-style SVG; colours are light/dark tokens.
- **Tooltips** show the shortcut (⌘ on Mac, Ctrl elsewhere) on hover or keyboard focus. The help dialog is generated from the `HELP` table in `src/js/help.js`.
- **Keyboard.** Roving tabindex in the top bar, rail and palette. Space/Enter activate focused controls. Letter shortcuts follow the keyboard layout; non-Latin layouts fall back to physical keys.
- **State.** Unsaved state comes from the history save point (`Core.History.markSaved/isClean`) plus floating selections and open text. Documents are capped at 16384 px per side and 100 MP in total (`Core.sizeError`), and every way in checks the cap before changing state.
- **Saving.** PNG/JPEG/WebP are written in place; GIF/BMP are saved as a PNG copy. Without the File System Access API, Save downloads the file and Save As asks for a name (`Core.saveName`).

## Backlog

0. **Objects (live shapes), exploration:** see `docs/objects.md`. Built on branch `objects-spike` (always on). It reopens "selection resize handles" (below) as feature work.

1. **Not yet verified:**
   - Firefox and Safari. Neither has the File System Access API, so the download-save path runs there. The `:has()`, `field-sizing` and `text-wrap: balance` CSS also needs checking.
   - A real Windows machine.
   - A VoiceOver pass over dialogs, toasts and the canvas label.
2. **Phone widths (<600px)** are out of scope, since the app is desktop-first. The top bar and options bar scroll sideways there rather than reflowing.

## Performance work (2026-10-13, merged to `master` at 8e53662)

Three rounds, each reviewed by a fresh agent, with the smooth brush merged in along the way (6161d22). The `perf` branch is merged and deleted; continue on a new branch off `master`. Design and gotchas are in `CLAUDE.md` (Rendering, Undo) and the code comments. Measure with `test/e2e/bench.js` and `bench-compare.js`; pixel-exactness is guarded by `test/e2e/history.js`, previews by `test/e2e/preview.js`.

The table compares medians of 3 headless Chrome runs on an M4, against the pre-perf code (1d72654):

| Scenario | Before | After |
|---|---|---|
| Memory after edits, 10000² | 6.3 GB | 4.3 GB |
| Undo steps kept, 4000×3000 / 10000² | 4 / 1 | 13 / 4 |
| Brush stroke, 300 moves, 4000×3000 / 10000² (main-thread ms) | 1153 / 3170 | 653 / 762 |
| Pencil stroke, 10000² | 1052 | 705 |
| Rotate ×2, 10000² | 304 | 61 |
| Flood fill ×2, 4000×3000 / 10000² | 415 / 2695 | 214 / 1832 |

Hover cost per move is near Chrome's per-frame floor. The app is fully idle when nothing changes.

### Left to do (pick up here)

Done on branch `perf-leftovers` (2026-10-14):
- **Region undo/redo** no longer reads the document back. It snapshots on the GPU, writes the stored pixels, and reads the snapshot back at idle, a second after the last change. At 100 MP a whole-image step takes ~57 ms, against 285 ms on master and ~90 ms pre-perf.
- **Shape (and every non-stroke) commits** snapshot on the GPU too. A whole-doc filled rect commits in ~58 ms plus ~300 ms of chunked idle readback; pre-perf took 512 ms.
- **Fill redo** paints the mask's runs as one path fill instead of recomputing and putting 400 MB. Bench `10000 undo+redo x5` is 893 ms, against 909 pre-perf over 5 runs and 1313–1469 on master.
- **Marching ants** are an `#ants` element at screen resolution. `preview.js` checks them at 800% and 1600%.
- **`bench.js`** now flushes the idle readback at the end of each scenario, so the cost lands on the edit that caused it. "undo all" rows therefore include reading back every undone entry, which the app does in idle chunks.

- **Undo data on the GPU** (branch `gpu-undo-safety`): a floating selection no longer postpones the readback (its op's tiles are queued; only a pointer gesture waits), and a GPU context loss drops the entries it erased, plus everything only reachable through them, with a flash, instead of letting undo paint blanks. Tested by dispatching `contextlost` on `#image` (`history.js` 1c); a real driver reset is not tested. The live document and an open float are still lost on a reset; that's Chrome's to restore.
- **Benchmark:** the `10000 pencil stroke` long-frame count swings from 1 to 80 depending on which scenarios ran before it, on master too. Don't read it as a regression without a same-filter master run.

1. **Not verified:**
   - the DPR-change path (`matchMedia` watcher), since CDP emulation doesn't fire `change`;
   - headed GPU runs of very large scribbles;
   - Firefox and Safari performance.
2. **Benchmark noise:** `task` varies about ±15% between runs. Small-document rows flagged by `bench-compare` were within that noise. Brush rows compare against code without smoothing. For sub-millisecond questions use a Chrome trace.

Measured gotchas behind the design (Chrome, M4, 10000² canvas):
- Any readback of the document mid-stroke (`getImageData`, or of a canvas drawn from it) costs ~10 ms a frame.
- A canvas that was read back must not be reused as a snapshot target: drawing into it becomes a readback too.
- One 400 MB readback takes ~70 ms; 40 band readbacks take ~340 ms.
- A DOM write inside `pointermove` forces a layout in the hit test.
- Comparing against a `style` read-back never matches for fractional px, so cache the last value written yourself.
- `WeakMap` has no `.size`.

## Decisions taken (don't relitigate without a new reason)

| Decision | Why |
|---|---|
| Keep native `confirm()` for discarding unsaved changes | Open must call `showOpenFilePicker` synchronously in the click. An async in-app dialog breaks it. The confirm runs *before* New opens. |
| ⇧0 = 100%, ⇧1 / ⌘0 = fit (Figma style) | Chrome reserves ⌘1 for tab switching. |
| Text: Enter applies, Shift+Enter adds a new line; key hints in the status bar while editing | Hint is always visible there at any width. |
| Options-bar controls: keyboard changes keep focus, pointer changes hand focus back to the canvas | Arrow keys keep working on sliders and radios, and letter shortcuts work after mouse use. |
| Crop uses `aria-disabled`, not `disabled` | It stays focusable, so the "Select an area first" explanation is reachable. |
| At ≤820px the file name is hidden; unsaved = dot on Save (and Save's label says so) | Room. |
| No refit after paste, rotate or flip; no auto-scroll during handle drag; linear size slider; no touch pan; no backdrop-click close; Anchor grid dimmed (not hidden) in Resize mode | Avoid surprise view or dialog jumps and accidental loss of input. Desktop-first. |
| Tab order: top bar → options bar → tool rail → canvas | It matches reading order (rows top to bottom), and each toolbar is a single roving-tabindex stop. |
| Toasts sit bottom-centre over the workspace, `pointer-events: none` (errors excepted) | A standard pattern, and they never block handles. Errors take the pointer only for × and hover-to-pause. |
| The toast's × is `tabindex=-1` | The toast is `aria-hidden` because live regions announce it, and errors time out. |
| Windows labels read "Ctrl+Plus/Minus" | Spelled-out key names read unambiguously. "Ctrl++" is confusing. |
| Smooth rendering when zoom × DPR < 1, pixelated from there up | Nearest-neighbour downsampling drops 1px lines, while at 1:1 and above hard pixels are what a pixel editor should show. |
| Palette swatches are 24px targets with 18px chips (16px chips at ≤820px); the "Size" label is hidden at ≤640px | WCAG 2.2 target size (2.5.8) needs a 24px pitch. Hiding the label buys the room, and the slider still has its aria-label and tooltip. |
| Palette marks Color 1 and Color 2 with rings only (bright vs muted), with no badges | The well is the main indicator. Tooltips and labels say "(color 2)". Badges on 18px chips add noise. |
| Esc order: focus tooltip → cancel drag → dismiss error toast (also from the text box; never while a modal is open) → deselect | Transient UI eats the first Esc, so dismissing a message never loses a selection or typed text. A modal sits above the toast, so Esc belongs to the dialog. |
| Save As on the download path (no `showSaveFilePicker`) uses native `prompt()` for the name | It matches the native `confirm()` decision. Without it, Save As and Save do the same thing in Firefox and Safari. |
| `[`/`]` snap off-grid sizes onto the 1…10, 12, 14… grid (from 11: `[` → 10, `]` → 12) | A step control should land on its grid. They are exact inverses on it. |
| Toast copy: one sentence = no trailing period; two sentences keep periods; error toasts say "X failed: <plain reason>" | It reads consistently. Permission and busy errors are mapped to plain words by `errText()`, and other errors keep the browser's message. |
| Brush smoothing = lazy-brush radius (screen px, fixed at pointerdown) + tldraw-style midpoint quadratic curves; segments commit as they settle, the tail to the pointer is drawn on the overlay and committed on release; default 2 (4 px), 0 = off; brush only | A position-based radius steadies jitter without depending on the event rate and doesn't drift while the pointer rests. tldraw's EMA `streamline` lags more as you draw faster. The live tail means there's no visible lag, and the stroke ends exactly where the pointer lifts. Mid-stroke detail smaller than the radius is lost, which is why 0 is offered. Pencil and eraser are pixel-exact stamps, so they aren't smoothed. tldraw's start/end point stripping (for pressure tapers) would eat short strokes, so it isn't used. |
| Brush strokes stay anti-aliased; each batch of settled segments is drawn by putting its box back as it was before the stroke and stroking every segment that reaches it as one clipped path | Stroking batches over each other inked the soft edge pixels twice where they met: darker bumps along the edge and a dotted fringe after a fill. Redrawing from the stroke's own undo tiles makes the image equal the stroke drawn as one path (`test/e2e/filledge.js`), at the cost of one tile draw-back per move. An aliased (MS Paint) brush would also be clean, but jagged. |
| Fill recolours the anti-aliased ring around the region (`Core.fillEdge`): each edge pixel that is a blend of the target colour and the ink next to it becomes the same blend of the fill colour and that ink | Without it, a tolerance fill stops short of soft edges (brush, ellipse, text) and leaves a light fringe. The ring grows up to 8 px through recoloured pixels, so the narrow wedge where strokes cross and the inside of letters like M are reached, but never onto a pixel touching another region. Pixels that aren't such a blend (hard-edged art, another colour, another region touching diagonally) are left byte-identical. A thin line with no fully inked pixel nearby can't tell its ink colour, so it is left as is; so is a grey pixel next to black, which looks the same as an anti-aliased edge. |
| Libraries (pica, UTIF, UPNG + pako), bundled from npm since 2026-10-15 (before that: from a CDN, with SRI, an idle preload, a fallback notice and retries); each feature keeps a built-in path past its budget; pica ≤ 50 MP and UPNG ≤ 750 ms estimated | They were measured (2026-10-14, Chrome, M4). pica's Lanczos-3 had about 40% less moiré on a zone plate ÷3, and was closer to the signal at low frequencies (RMS 0.4 vs 3.5) and when upscaling (0.44 vs 0.72). UPNG's PNGs were 40–60% smaller for screenshots and drawings, and 13–16% smaller for photos and noise. On large inputs pica took 5 s for 10000² → 5000², and UPNG took 3.3 s on a 4K photo, hence the budgets. Chrome can't decode TIFF at all. pica's default `mks2013` filter oversharpens, so it isn't used. Bundling them came with the build step (next row): npm keeps third-party code out of the repo as the CDN did, and the features no longer depend on a first online visit, so the preload, the fallback notice and the retries went away. |
| A build step (esbuild, `build.mjs`): ES modules in `src/js/` bundled into one classic script in `dist/`; `dist/` not committed; deployed to GitHub Pages | The user's call (2026-10-15): one 2300-line IIFE was hard to work in. A classic-script bundle keeps `file://` and offline working, which ES modules loaded directly would break. Pages needs no domain: the repo is public. |
| Installable app (PWA) over http(s): manifest with image `file_handlers`, network-first service worker | The user's call (2026-10-15), for a desktop-app feel without Electron: its own window, offline use, "Open with" that saves back. Network-first because cache-first served an old build after an update and shadowed the dev server on the same port (seen in testing). |
| `file://` dropped (2026-10-16): ES-module output with code splitting; the libraries load on first use; the fill and the UPNG encode run in workers; `file://` shows a message to serve the app | The user's call: double-clicking `dist/index.html` didn't matter to them. Boot parses ~28 KB gzipped instead of 88 KB (~3 ms of script instead of ~14 ms). The workers were possible before (blob URLs), and are the change users notice: a 100 MP fill no longer freezes the page for ~1 s. The service worker caches every chunk and keeps the previous build's cache, so offline use and a tab left open across a deploy keep working. |
| Rejected libraries: gifenc (GIF save), oxipng/wasm encoders, heic2any | gifenc ships only as CommonJS, and saving GIF in place would flatten animations and quantise colour, against "GIF is never overwritten". The wasm encoders need `fetch` or large inlined binaries. heic2any is 2.7 MB unpacked. |
| Objects (merged from `objects-spike`, PR #8): line, rectangle and ellipse are always editable shapes, with no switch; pixel tools paint *under* shapes; shapes are flattened into the saved file and gone on reopen; a Move tool (V) picks, moves and resizes shapes and pans on empty canvas, and the select tool stays pixels-only | The user's call (2026-10-14). A switch only added a setting: move-then-⌘E gives the same pixels as drawing straight in. Painting under is the predictable layer rule. Session-only shapes avoid a private PNG chunk (and files the size of two images). A separate Move tool means a marquee can start over a shape, and V matches Figma. Details in `docs/objects.md`. |
| Object drags: nothing moves until the pointer has gone 3 screen px; Shift locks a move to one axis, keeps a box's aspect ratio (corner: from the opposite corner, edge: about the middle) and snaps a line end to 45°, also when pressed mid-drag; sides under 24 screen px drop their midpoint handles, and inside a shape a handle reaches at most a quarter of its short side | At 25% one screen px is 4 image px, so a click wobble moved shapes and added undo steps. Shift matches the shape tools' own Shift and Figma's. Tiny shapes were all handle: every press resized them. |
| Move tool: hover outlines the shape a click would pick (2 px on its edge; a bar for lines); ⌥-drag moves a copy placed just above the original, one undo step | Figma's model. 1 px vanished on a thick black outline. The copy sits next to its original in the stack, not at the top as ⌘D's does, so it overlaps what the original overlapped. |
| Keyboard: `#viewport` is a Tab stop; with the Move tool, Tab / ⇧Tab select the next / previous shape and announce it; past either end they deselect and let focus move on | Shapes were pointer-only. Figma uses Tab for this too. Letting focus leave at the ends avoids a focus trap (WCAG 2.1.2). Only the Move tool, so Tab elsewhere stays plain navigation. |
| Crop, resize, canvas size, rotate and flip carry shapes along (one undo step) instead of flattening them; a crop drops shapes left wholly outside; Resize scales them as vectors (stroke by the geometric mean, ≥ 1 px) | Flattening lost the shapes and took two undo steps. Off-canvas shapes would be invisible but still Tab-able. Turned or flipped shapes match flatten-then-transform within anti-aliasing, not bit for bit (`docs/objects.md`). |
| Help (`?`) has three columns, with a Shapes section | Two columns filled 1280×800 exactly; the shape shortcuts didn't fit. |
| Out of scope (new features, not polish): fill clipped to a selection, selection resize handles, auto text size, cancelling freehand strokes with Esc | Feature work. |

## Caveats on the evidence

- Oversized open and paste were tested with fake bitmap objects, not real 100+ MP files.
- The Save As `prompt()` path was tested with a stubbed `prompt`, because Chrome has `showSaveFilePicker`.
- The GIF/BMP save check rests partly on reading the code: the old code had no `save` hook to test against.
