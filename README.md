# Paint

A tiny MS-Paint-style editor for quick jobs: paint over areas, crop, resize, annotate. Plain HTML/CSS/JS, no build. It works offline; when online, a few features get better through libraries loaded on demand (below).

**Run:** open `index.html` in Chrome (works from `file://`). Drop an image on the window, paste one with ⌘V, or ⌘O.
⌘S writes back to the file you opened (Chrome asks for write permission once).

## Shortcuts

⌘ is Ctrl and ⌥ is Alt on Windows/Linux; the app's tooltips and help show the right keys for your platform.

| Keys | Action |
|---|---|
| S P B E F I T L R O | Select, Pencil, Brush, Eraser, Fill, Picker, Text, Line, Rect, Ellipse |
| Left / right click | Draw with color 1 / color 2 (right-click or Shift-click a swatch sets color 2) |
| X | Swap colors |
| [ ] | Smaller / bigger size |
| Shift while dragging | Square / circle / 45° line |
| ⌘Z / ⌘⇧Z (or ⌘Y) | Undo / redo |
| ⌘A, Esc, Delete (or Backspace) | Select all, deselect (Esc also cancels a shape, selection, move or canvas drag, and dismisses an error message), clear selection to color 2 |
| Enter, Shift+Enter, Esc (text tool) | Apply text, new line, cancel |
| Arrows (Shift = 10px) | Nudge selection |
| ⌘C ⌘X ⌘V | Copy, cut, paste the selection. With nothing selected, ⌘C and ⌘X copy the whole image and leave it unchanged |
| ⌘⇧X | Crop to selection |
| Shift+R | Resize image (resample) |
| Shift+C, or drag the handles on the right/bottom/corner | Canvas size (new area = color 2; Shift+drag corner keeps aspect; Esc cancels) |
| ⌘O ⌘S ⌘⇧S Alt+N | Open, save, save as, new |
| + − (or ⌘+ ⌘−), ⌘+wheel / pinch | Zoom; ⇧1 (or ⌘0) fit, ⇧0 100% |
| Space+drag, middle drag | Pan |
| ? | Shortcut help |

The brush smooths strokes: it trails the pointer by a short lazy radius (Smoothing, 2 px per step; 0 turns it off), draws quadratic curves rather than straight segments, and always ends exactly where you release. Pencil and eraser stay pixel-exact.

Save format follows the file extension (PNG, JPEG, WebP); JPEG is flattened onto white. Files opened in other formats (GIF, BMP, TIFF) are saved as a PNG copy, never overwritten.

### With and without a connection

| Feature | Online (library from jsDelivr, loaded when first needed) | Offline (built in) |
|---|---|---|
| Resize image | [pica](https://github.com/nodeca/pica), Lanczos-3: less moiré, sharper (up to 50 MP, before plus after) | Halving resampler |
| Open TIFF | [UTIF](https://github.com/photopea/UTIF.js): first page, any compression it supports | Not available; the message says why |
| Save PNG | [UPNG](https://github.com/photopea/UPNG.js), lossless: about 40–60% smaller for screenshots and drawings, 13–16% for photos. Used up to 3840 × 2160, and only when its estimated time is under ¾ s | The browser's PNG encoder |

Versions are pinned and checked with Subresource Integrity. The libraries (about 190 KB) load in the background once the page is idle after it opens. The browser caches them for up to a year, so after one online visit they usually work offline too (best effort: the browser can clear its cache). If they can't load within 4 s, the built-in path runs. The first time that happens in a session, a message says so ("Working offline: resize and PNG saves use the built-in versions"), and a later use retries in the background.

## Layout

- `js/core.js` — pure helpers (flood fill, Bresenham, rect/resize math, smoothed brush path, bounded undo history)
- `js/app.js` — UI, tools, file I/O
- `test/core.test.js` — `node --test test/*.test.js`
- `test/e2e/smoke.js` — browser smoke test (about 280 checks). Dev-only: needs Playwright somewhere on `NODE_PATH` and Google Chrome.
  Serve the folder (`python3 -m http.server 8765`), then `NODE_PATH=/path/to/node_modules node test/e2e/smoke.js [url]`
  (url defaults to `http://localhost:8765/`; `file:///…/index.html` works too). `test/e2e/shots.js PREFIX` saves screenshots.
- `test/e2e/libs.js` — the optional libraries online, offline and with a CDN that never answers: which path ran, pixel-exact TIFF and PNG round trips, timeouts, and retry after coming back online. Fixtures are in `test/fixtures/`.
- `test/e2e/history.js` (pixel-exact undo/redo of every edit kind, undo depth on a 12 MP image) and `test/e2e/preview.js` (selection and shape previews on screen at several zooms) — same setup and `[url]` argument as the smoke test.
- `test/e2e/bench.js [url] [--runs N] [--only substr] [--json out.json]` — performance benchmark: main-thread time, frame times and memory per scenario, median of N runs. `test/e2e/bench-compare.js before.json after.json` prints the deltas and exits 1 on a regression.
