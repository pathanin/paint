# Paint

A tiny MS-Paint-style editor for quick jobs: paint over areas, crop, resize, annotate. Plain HTML/CSS/JS, no build, no dependencies.

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

Save format follows the file extension (PNG, JPEG, WebP); JPEG is flattened onto white. Files opened in other formats (GIF, BMP) are saved as a PNG copy, never overwritten.

## Layout

- `js/core.js` — pure helpers (flood fill, Bresenham, rect/resize math, bounded undo history)
- `js/app.js` — UI, tools, file I/O
- `test/core.test.js` — `node --test test/*.test.js`
- `test/e2e/smoke.js` — browser smoke test (210 checks). Dev-only: needs Playwright somewhere on `NODE_PATH` and Google Chrome.
  Serve the folder (`python3 -m http.server 8765`), then `NODE_PATH=/path/to/node_modules node test/e2e/smoke.js [url]`
  (url defaults to `http://localhost:8765/`; `file:///…/index.html` works too). `test/e2e/shots.js PREFIX` saves screenshots.
