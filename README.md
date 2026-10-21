# Paint

A tiny MS-Paint-style editor for quick jobs: paint over areas, crop, resize, annotate. Runs in the browser and works offline.

**Use it online:** https://pathanin.github.io/paint/

In Chrome you can install it as an app (install icon in the address bar). It then opens in its own window, works offline, and shows up under "Open with" for images.

## Features

- Pencil, brush (smoothed), eraser, fill, colour picker, text
- Every mark (strokes, shapes, text, fills, pastes) stays an editable object until you flatten it (⌘E); PNG saves keep them. Moving or resizing one snaps it to the others and to the canvas
- Select, crop, resize, canvas size, rotate, flip
- Open, paste or drop images, including TIFF; ⌘S saves back to the file you opened
- Transparency: PNGs open and save with it. The checkered Transparent swatch erases: with color 2 set to it, the eraser, Delete, moving a selection and a bigger canvas leave transparent pixels, and pencil, brush and fill drawing with it clear
- Saves PNG, JPEG or WebP by file extension (JPEG is flattened onto white). Other formats (GIF, BMP, TIFF) are saved as a PNG copy, never overwritten

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
| V S P B E F I T L R O | Move (every mark is an editable object; drag empty canvas to box-select, ⇧-click to add; Space-drag pans), Select, Pencil, Brush, Eraser, Fill, Picker, Text, Line, Rect, Ellipse |
| Left / right click | Draw with color 1 / color 2 (right-click or Shift-click a swatch sets color 2; the checkered swatch is Transparent) |
| X | Swap colors |
| [ ] | Smaller / bigger size |
| Shift while dragging | Square / circle / 45° line. On a shape you move or resize: straight along one axis, same proportions, 45° line end |
| ⌘Z / ⌘⇧Z (or ⌘Y) | Undo / redo |
| ⌘A, Esc, Delete (or Backspace) | Select all, deselect (Esc also cancels a shape, selection, move or canvas drag, and dismisses an error message), clear selection to color 2 (or to transparent) |
| Enter, Shift+Enter, Esc (text tool) | Apply text, new line, cancel |
| Arrows (Shift = 10px) | Nudge selection |
| ⌘C ⌘X ⌘V | Copy, cut, paste the selection. With nothing selected, ⌘C and ⌘X copy the whole image and leave it unchanged |
| ⌘⇧X | Crop to selection |
| ⌘D, ⌘] ⌘[, ⌘E | Objects (every stroke, shape, text, fill and paste stays movable; new ones go on top; PNG saves keep them): duplicate, bring forward / send backward (⌘⇧] ⌘⇧[: to front / back; also buttons in the Move tool's bar), flatten into pixels (with the Move tool and a selection: just those, into image objects). The Fill tool inside a closed shape sets that shape's fill |
| ⌥+drag (Move tool) | Duplicate an object by dragging a copy off it |
| ⌘ while dragging an object | Moving or resizing an object snaps its edges and centre to other objects' and the canvas's (magenta guides show what lines up); hold ⌘ to place it freely |
| ⌥+drag (Eraser) | Delete every object the drag crosses (⌥ alone outlines the one under the pointer) |
| Tab / Shift+Tab (Move tool, canvas focused) | Select the next / previous object in drawing order; past the last one, focus moves on |
| Shift+R | Resize image (resample) |
| Shift+C, or drag the handles on the right/bottom/corner | Canvas size (new area = color 2, or transparent; Shift+drag corner keeps aspect; Esc cancels) |
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

### Testing in Safari

Build and serve first (`npm run build && npm run serve`, or keep `npm run dev` running). There are three levels, from automatic to by hand.

**1. Safari's engine (WebKit), automatic.** Playwright's WebKit is close to Safari but isn't Safari.

```bash
npx playwright install webkit            # once, about 150 MB
BROWSER=webkit node test/e2e/smoke.js    # also: history, preview, filledge, objects, alpha, libs, shots
```

pwa, bench and parity are Chrome only.

**2. Real Safari, automatic.** `test/e2e/safari.js` drives Safari itself through Apple's safaridriver. It hasn't connected on the machine it was written on yet, so treat a first failure as a setup problem.

1. Once: in Safari → Settings → Advanced, turn on "Show features for web developers". Then in Settings → Developer, turn on "Allow remote automation".
2. Once: run `sudo safaridriver --enable`.
3. Quit Safari completely (⌘Q). It has to restart after step 1.
4. Run:
   ```bash
   safaridriver -p 4445 &
   node test/e2e/safari.js                 # opens its own Safari window (orange address bar)
   ```

If it says "session timed out while connecting to a Safari instance", check that the setting from step 1 is still on, and quit Safari again.

**3. Real Safari, by hand.** These are the things neither script can do:

- **Pinch:** a real trackpad pinch over the image zooms the image, not the page.
- **Copy:** ⌘C, then paste into another app (Preview → File → New from Clipboard). ⌘V of an image copied elsewhere.
- **Save:** the first save asks to allow downloads, and the file arrives. On a big image (File → New, 10000 × 10000), if nothing arrives the message offers **Download again**.
- **Save as .webp:** saves `name.png`, since Safari can't write WebP.
- **Feel at 10000 × 10000:** draw, fill, rotate and undo stay responsive.
- **Shortcuts:** ⌘Y, ⌘0, ⌘= / ⌘−, and with a shape selected ⌘D and ⌘E act in the app, not in Safari's menus.
- **Text:** type, press Enter, then press a tool letter (B). The tool changes.
- **Add to Dock** (File → Add to Dock): the app gets the blue brush icon.

More docs:

- [CLAUDE.md](CLAUDE.md): architecture, all test commands, conventions
- [task.md](task.md): design decisions and open backlog
- [docs/objects.md](docs/objects.md): editable shapes
- [docs/total-objects.md](docs/total-objects.md): every mark as an object (design, decisions, measurements)
