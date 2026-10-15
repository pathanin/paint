# Paint

A tiny MS-Paint-style editor for quick jobs: paint over areas, crop, resize, annotate. Runs in the browser and works offline.

**Use it online:** https://pathanin.github.io/paint/

In Chrome you can install it as an app (install icon in the address bar). It then opens in its own window, works offline, and shows up under "Open with" for images.

## Features

- Pencil, brush (smoothed), eraser, fill, colour picker, text
- Line, rectangle and ellipse stay editable shapes until you flatten them (⌘E)
- Select, crop, resize, canvas size, rotate, flip
- Open, paste or drop images, including TIFF; ⌘S saves back to the file you opened
- Saves PNG, JPEG or WebP by file extension. Other formats (GIF, BMP, TIFF) are saved as a PNG copy, never overwritten

## Run locally

```bash
npm ci && npm run build && npm run serve
```

Then open http://localhost:8765/ in Chrome. Use `npm run dev` to rebuild on change. Opening `dist/index.html` directly from disk doesn't work.

## Shortcuts

Press `?` in the app for the full list. ⌘ is Ctrl and ⌥ is Alt on Windows/Linux.

<details>
<summary>All shortcuts</summary>

| Keys | Action |
|---|---|
| V S P B E F I T L R O | Move (editable shapes; drag empty canvas to pan), Select, Pencil, Brush, Eraser, Fill, Picker, Text, Line, Rect, Ellipse |
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
| ⌘D, ⌘] ⌘[, ⌘E | Shapes (line, rectangle, ellipse stay movable above your drawing): duplicate, bring forward / send backward, flatten all into pixels |
| ⌥+drag (Move tool) | Duplicate a shape by dragging a copy off it |
| Tab / Shift+Tab (Move tool, canvas focused) | Select the next / previous shape in drawing order; past the last one, focus moves on |
| Shift+R | Resize image (resample) |
| Shift+C, or drag the handles on the right/bottom/corner | Canvas size (new area = color 2; Shift+drag corner keeps aspect; Esc cancels) |
| ⌘O ⌘S ⌘⇧S Alt+N | Open, save, save as, new |
| + − (or ⌘+ ⌘−), ⌘+wheel / pinch | Zoom; ⇧1 (or ⌘0) fit, ⇧0 100% |
| Space+drag, middle drag | Pan |
| ? | Shortcut help |

</details>

## Development

Plain HTML/CSS/JS as ES modules in `src/`, bundled by esbuild into `dist/`. Libraries (pica, UTIF, UPNG) come from npm and load on first use.

```bash
npm test                 # unit tests
node test/e2e/smoke.js   # browser smoke test (needs a build served on :8765 and Google Chrome)
```

More docs:

- [CLAUDE.md](CLAUDE.md): architecture, all test commands, conventions
- [task.md](task.md): design decisions and open backlog
- [docs/objects.md](docs/objects.md): editable shapes
