# Paint

A tiny MS-Paint-style editor for quick jobs: paint over areas, crop, resize, annotate. Plain HTML/CSS/JS, no build, no dependencies.

**Run:** open `index.html` in Chrome (works from `file://`). Drop an image on the window, paste one with ⌘V, or ⌘O.
⌘S writes back to the file you opened (Chrome asks for write permission once).

## Shortcuts

| Keys | Action |
|---|---|
| S P B E F I T L R O | Select, Pencil, Brush, Eraser, Fill, Picker, Text, Line, Rect, Ellipse |
| Left / right click | Draw with color 1 / color 2 (right-click or Shift-click a swatch sets color 2) |
| X | Swap colors |
| [ ] | Smaller / bigger size |
| Shift while dragging | Square / circle / 45° line |
| ⌘Z / ⌘⇧Z (or ⌘Y) | Undo / redo |
| ⌘A, Esc, Delete | Select all, deselect (Esc also cancels a shape or canvas drag), clear selection to color 2 |
| Enter, Shift+Enter, Esc (text tool) | Apply text, new line, cancel |
| Arrows (Shift = 10px) | Nudge selection |
| ⌘C ⌘X ⌘V | Copy, cut, paste (selection, or the whole image when nothing is selected) |
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
