# Paint

A tiny MS-Paint-style editor for quick jobs: paint over areas, crop, resize, annotate. Plain HTML/CSS/JS, bundled by esbuild; served over http(s), and works offline once loaded.

**Use it online:** https://pathanin.github.io/paint/ (published from master by CI). Chrome can install it as an app (the install icon in the address bar): it then has its own window and Dock icon, works offline, and appears under "Open with" for images, saving back to the file you opened.

**Run locally:** `npm ci && npm run build && npm run serve`, then open http://localhost:8765/ in Chrome, or `npm run dev` for the same URL with rebuild on change. (Opening `dist/index.html` from `file://` doesn't work: browsers don't load ES modules there.) Drop an image on the window, paste one with ⌘V, or ⌘O.
⌘S writes back to the file you opened (Chrome asks for write permission once).

## Shortcuts

⌘ is Ctrl and ⌥ is Alt on Windows/Linux; the app's tooltips and help show the right keys for your platform.

| Keys | Action |
|---|---|
| V S P B E F I T L R O | Move (every mark is an editable object; drag empty canvas to box-select, ⇧-click to add; Space-drag pans), Select, Pencil, Brush, Eraser, Fill, Picker, Text, Line, Rect, Ellipse |
| Left / right click | Draw with color 1 / color 2 (right-click or Shift-click a swatch sets color 2) |
| X | Swap colors |
| [ ] | Smaller / bigger size |
| Shift while dragging | Square / circle / 45° line. On a shape you move or resize: straight along one axis, same proportions, 45° line end |
| ⌘Z / ⌘⇧Z (or ⌘Y) | Undo / redo |
| ⌘A, Esc, Delete (or Backspace) | Select all, deselect (Esc also cancels a shape, selection, move or canvas drag, and dismisses an error message), clear selection to color 2 |
| Enter, Shift+Enter, Esc (text tool) | Apply text, new line, cancel |
| Arrows (Shift = 10px) | Nudge selection |
| ⌘C ⌘X ⌘V | Copy, cut, paste the selection. With nothing selected, ⌘C and ⌘X copy the whole image and leave it unchanged |
| ⌘⇧X | Crop to selection |
| ⌘D, ⌘] ⌘[, ⌘E | Objects (every stroke, shape, text, fill and paste stays movable; new ones go on top; PNG saves keep them): duplicate, bring forward / send backward (⌘⇧] ⌘⇧[: to front / back; also buttons in the Move tool's bar), flatten into pixels (with the Move tool and a selection: just those, into one image object). The Fill tool inside a closed shape sets that shape's fill |
| ⌥+drag (Move tool) | Duplicate an object by dragging a copy off it |
| ⌥+drag (Eraser) | Delete every object the drag crosses (⌥ alone outlines the one under the pointer) |
| Tab / Shift+Tab (Move tool, canvas focused) | Select the next / previous object in drawing order; past the last one, focus moves on |
| Shift+R | Resize image (resample) |
| Shift+C, or drag the handles on the right/bottom/corner | Canvas size (new area = color 2; Shift+drag corner keeps aspect; Esc cancels) |
| ⌘O ⌘S ⌘⇧S Alt+N | Open, save, save as, new |
| + − (or ⌘+ ⌘−), ⌘+wheel / pinch | Zoom; ⇧1 (or ⌘0) fit, ⇧0 100% |
| Space+drag, middle drag | Pan |
| ? | Shortcut help |

The brush smooths strokes: it trails the pointer by a short lazy radius (Smoothing, 2 px per step; 0 turns it off), draws quadratic curves rather than straight segments, and always ends exactly where you release. Pencil and eraser stay pixel-exact. Fill also recolours the soft edge of brush strokes, ellipses and text next to the area it fills, so no light fringe is left around them.

Save format follows the file extension (PNG, JPEG, WebP); JPEG is flattened onto white. Files opened in other formats (GIF, BMP, TIFF) are saved as a PNG copy, never overwritten.

### Libraries

Bundled into the app (versions pinned in `package.json`), so they work offline too:

| Feature | Library | Built-in path |
|---|---|---|
| Resize image | [pica](https://github.com/nodeca/pica), Lanczos-3: less moiré, sharper (up to 50 MP, before plus after) | Halving resampler, for larger images |
| Open TIFF | [UTIF](https://github.com/photopea/UTIF.js): first page, any compression it supports | None (Chrome can't decode TIFF) |
| Save PNG | [UPNG](https://github.com/photopea/UPNG.js), lossless: about 40–60% smaller for screenshots and drawings, 13–16% for photos. Used up to 3840 × 2160, and only when its estimated time is under ¾ s | The browser's PNG encoder; the smaller file wins |

## Layout

- `src/index.html`, `src/style.css` — the page; `src/manifest.webmanifest`, `src/sw.js`, `src/icon.svg` — the installable app
- `src/js/core.js` — pure helpers (flood fill, Bresenham, rect/resize math, smoothed brush path, bounded undo history)
- `src/js/*.js` — UI, tools, file I/O, one ES module per area; `main.js` boots the app; `fill-worker.js` and `png-worker.js` run the paint bucket and the PNG encoder off the main thread
- `build.mjs` — bundles `src/` into `dist/` (`npm run build`; `npm run dev` watches and serves)
- `test/core.test.js` — `npm test`
- `test/e2e/smoke.js` — browser smoke test (about 290 checks) of the built app. Needs `npm ci` (Playwright) and Google Chrome.
  Build, serve `dist/` (`npm run serve`, or `npm run dev`), then `node test/e2e/smoke.js [url]`
  (url defaults to `http://localhost:8765/`). `test/e2e/shots.js PREFIX` saves screenshots.
- `test/e2e/libs.js` — the bundled libraries: none loads at boot, which path ran, pixel-exact TIFF and PNG round trips, the built-in paths past each budget, the fill worker, each fallback when a chunk or worker won't load, and no requests to other servers. Fixtures are in `test/fixtures/`.
- `test/e2e/pwa.js` — the installable app over http: manifest and install criteria, offline reload through the service worker, the lazy parts (chunks, workers) offline, the previous build's cache, files handed to the installed app; and the message `file://` shows.
- `test/e2e/history.js` (pixel-exact undo/redo of every edit kind, undo depth on a 12 MP image) and `test/e2e/preview.js` (selection and shape previews on screen at several zooms) — same setup and `[url]` argument as the smoke test.
- `test/e2e/bench.js [url] [--runs N] [--only substr] [--json out.json]` — performance benchmark: main-thread time, frame times and memory per scenario, median of N runs. `test/e2e/bench-compare.js before.json after.json` prints the deltas and exits 1 on a regression.
