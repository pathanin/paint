# Design notes: Paint UI

The design decisions behind the current UI, the evidence behind them, and what's still open. Read this before changing UX behaviour. The commands for running the checks are in `CLAUDE.md` and `README.md`.

## Scope and testing so far

- The UI was polished over 15 review rounds (2026-10-13), each with a fresh UX reviewer. The last two rounds found no defects. Each change's rationale is in its commit message (`git log`).
- Tested only in desktop Chrome on macOS (DPR 1 and 2). Windows key labels were checked with a `navigator.platform` override only.

## Layout and behaviour at a glance

- **Layout.** A top bar holds file, undo, image ops, the doc name and zoom. A contextual options bar shows tool options, a short hint, the colour well and the palette. A left tool rail holds the tools. The status bar shows cursor, selection, size, text-key hints and a first-run hint. Icons are inline Lucide-style SVG; colours are light/dark tokens.
- **Tooltips** show the shortcut (⌘ on Mac, Ctrl elsewhere) on hover or keyboard focus. The help dialog is generated from the `HELP` table in `js/app.js`.
- **Keyboard.** Roving tabindex in the top bar, rail and palette. Space/Enter activate focused controls. Letter shortcuts follow the keyboard layout; non-Latin layouts fall back to physical keys.
- **State.** Unsaved state comes from the history save point (`Core.History.markSaved/isClean`) plus floating selections and open text. Documents are capped at 16384 px per side and 100 MP in total (`Core.sizeError`), and every way in checks the cap before changing state.
- **Saving.** PNG/JPEG/WebP are written in place; GIF/BMP are saved as a PNG copy. Without the File System Access API, Save downloads the file and Save As asks for a name (`Core.saveName`).

## Backlog

1. **Not yet verified:**
   - Firefox and Safari. Neither has the File System Access API, so the download-save path runs there. The `:has()`, `field-sizing` and `text-wrap: balance` CSS also needs checking.
   - A real Windows machine.
   - A VoiceOver pass over dialogs, toasts and the canvas label.
2. **Phone widths (<600px)** are out of scope, since the app is desktop-first. The top bar and options bar scroll sideways there rather than reflowing.

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
| Out of scope (new features, not polish): fill clipped to a selection, selection resize handles, auto text size, cancelling freehand strokes with Esc | Feature work. |

## Caveats on the evidence

- Oversized open and paste were tested with fake bitmap objects, not real 100+ MP files.
- The Save As `prompt()` path was tested with a stubbed `prompt`, because Chrome has `showSaveFilePicker`.
- The GIF/BMP save check rests partly on reading the code: the old code had no `save` hook to test against.
