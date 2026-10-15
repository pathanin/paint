# Design notes: Paint

Open work, settled decisions, and measured gotchas. Read before changing UX behaviour. Architecture and commands are in `CLAUDE.md`; shapes in `docs/objects.md`. Full history is in `git log`.

## Status

All of this is done and merged to `master`:

- UI polish: 15 review rounds (2026-10-13); the last two found nothing.
- Performance: undo on the GPU with idle readback, fill in a worker, crisp marching ants, smooth brush. Measure with `test/e2e/bench.js` + `bench-compare.js`.
- Objects: line, rect and ellipse are editable shapes, with a Move tool (V).
- Build step (esbuild), installable PWA, GitHub Pages deploy, libraries bundled from npm and lazy-loaded.

## Open

**Not verified:**
- Firefox and Safari: the download-save path, `:has()`, `field-sizing`, `text-wrap: balance`, and performance.
- A real Windows machine (labels were checked only with a `navigator.platform` override).
- A VoiceOver pass over dialogs, toasts and the canvas label.
- The DPR-change path (`matchMedia` watcher); CDP emulation doesn't fire `change`.
- Headed GPU runs of very large scribbles; a real GPU driver reset (only a dispatched `contextlost` is tested).
- Oversized open/paste with real 100+ MP files (tested with fake bitmaps).
- Save As `prompt()` path (tested with a stubbed `prompt`).

**Out of scope** unless the user asks (feature work, not polish): fill clipped to a selection, selection resize handles, auto text size, cancelling freehand strokes with Esc, phone widths (<600px; bars scroll sideways).

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
- ≤820px: file name hidden; unsaved = dot on Save.
- Palette: 24px targets with 18px chips (WCAG 2.5.8); colours 1 and 2 marked by rings only, no badges. "Size" label hidden ≤640px.
- Toasts bottom-centre, `pointer-events: none` except errors. One sentence = no period; errors read "X failed: <plain reason>".
- Smooth rendering when zoom × DPR < 1, pixelated from there up.
- No refit after paste/rotate/flip, no auto-scroll during handle drags, no touch pan, no backdrop-click close. Desktop-first.
- Help (`?`) has three columns.

**Painting**
- Brush smoothing: lazy-brush radius (screen px) + midpoint quadratic curves, live tail on the overlay, ends exactly at release. Default 2, 0 = off. Pencil and eraser stay pixel-exact.
- Brush stays anti-aliased; each batch is redrawn from the stroke's undo tiles as one clipped path, so edge pixels are never inked twice (`test/e2e/filledge.js`).
- Fill recolours the anti-aliased ring around the region (`Core.fillEdge`, up to 8 px) so no fringe is left. Pixels that aren't a clean blend are left untouched.

**Shapes (objects)**
- Always editable, no on/off switch. Pixel tools paint under them. Flattened on save; not kept in the file.
- Move tool (V) picks, moves, resizes; Select stays pixels-only.
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
- Bench: `task` varies ±15% between runs. The `10000 pencil stroke` long-frame count swings 1–80 depending on earlier scenarios; compare against a same-filter master run.
