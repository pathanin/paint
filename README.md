# Paint

A tiny MS-Paint-style editor for quick jobs: paint over areas, crop, resize, annotate. Plain HTML/CSS/JS, no build, no dependencies.

**Run:** open `index.html` in Chrome (works from `file://`). Drop an image on the window, paste one with ⌘V, or ⌘O.
⌘S writes back to the file you opened (Chrome asks for write permission once).

## Shortcuts

| Keys | Action |
|---|---|
| S P B E F I T L R O | Select, Pencil, Brush, Eraser, Fill, Picker, Text, Line, Rect, Ellipse |
| Left / right click | Draw with color 1 / color 2 (right-click a swatch sets color 2) |
| X | Swap colors |
| [ ] | Smaller / bigger size |
| Shift while dragging | Square / circle / 45° line |
| ⌘Z / ⌘⇧Z | Undo / redo |
| ⌘A, Esc, Delete | Select all, deselect, clear selection to color 2 |
| Arrows (Shift = 10px) | Nudge selection |
| ⌘C ⌘X ⌘V | Copy, cut, paste (selection, or the whole image when nothing is selected) |
| ⌘⇧X | Crop to selection |
| Shift+R | Resize image (resample) or canvas (with anchor) |
| ⌘O ⌘S ⌘⇧S Alt+N | Open, save, save as, new |
| ⌘+wheel / pinch, + − | Zoom; ⌘0 fit, ⌘1 100% |
| Space+drag, middle drag | Pan |
| ? | Shortcut help |

Save format follows the file extension (PNG, JPEG, WebP); JPEG is flattened onto white.

## Layout

- `js/core.js` — pure helpers (flood fill, Bresenham, rect/resize math, bounded undo history)
- `js/app.js` — UI, tools, file I/O
- `test/core.test.js` — `node --test test/*.test.js`
