# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A small MS-Paint-style image editor written in plain HTML, CSS and JS. It has no build step and no runtime dependencies. It must keep working when `index.html` is opened directly from `file://` in Chrome. That rules out ES modules, `fetch`, CDN assets and external SVG sprite references; icons are inline `<symbol>`s in `index.html`.

## Commands

```bash
python3 -m http.server 8765                 # dev server (also .claude/launch.json "paint" for the preview pane)
node --test test/*.test.js                  # unit tests for js/core.js (no deps)
node --test --test-name-pattern="History" test/*.test.js   # single test by name
```

End-to-end smoke test: `test/e2e/smoke.js` runs about 270 checks in one sequential script, and later sections depend on state from earlier ones. It is dev-only and needs Playwright on `NODE_PATH` plus an installed Google Chrome (`channel: 'chrome'`).

```bash
mkdir -p /tmp/pw && (cd /tmp/pw && npm i playwright@1)
NODE_PATH=/tmp/pw/node_modules node test/e2e/smoke.js                      # http://localhost:8765/
NODE_PATH=/tmp/pw/node_modules node test/e2e/smoke.js file://$PWD/index.html
NODE_PATH=/tmp/pw/node_modules node test/e2e/shots.js /tmp/pw/shot         # light/dark/dialog/narrow screenshots
```

When smoke fails, read the **first** `FAIL` line, because later failures often cascade from it. The tests drive the app through `window.__paint`, a test handle defined at the bottom of `js/app.js`. Add to it rather than reaching into the DOM for internal state.

## Architecture

- **`js/core.js`** holds pure, DOM-free helpers that are exported as `window.Core` and through `module.exports` for Node. They cover flood fill, Bresenham line, rect/resize/anchor math and `History`. `History` is the bounded undo stack: it evicts by count and bytes and tracks a save point with `markSaved()`/`isClean()`. `push()` returns the number of entries it evicted. Anything testable without a canvas belongs here, test-first.
- **`js/app.js`** is one IIFE organised into `// ---------- section ----------` blocks: document & history, view, tools, text, selection, clipboard, transforms, file I/O, dialogs, handles, pointer, keyboard, toolbar wiring, tooltips, help, boot. The core state lives in module locals:
  - `S` holds settings and the document (tool, colours, sizes, zoom, file handle and name, `pristine`).
  - `drag` is the in-progress pointer gesture, keyed by `drag.t`: `pencil`, `brush`, `move`, `select`, `canvas`, `pan`, and so on.
  - `sel` is the selection; `sel.float` is a lifted or pasted canvas that hasn't been committed yet.
  - `textAt` is non-null while the text box is open.
- **Rendering:** `#image` is the document canvas, and `#overlay` draws marching ants, shape previews and floating selections. `#ring` is a DOM brush-footprint cursor. `render()` is rAF-throttled through `requestRender()` and returns early when the overlay is clean.
- **Undo** uses two entry types.
  - `region` entries store before/after `ImageData` for a dirty bbox. The flow is `beginOp()` (snapshot into the `backup` canvas), then `touch()` (grow the bbox), then `endOp()`.
  - `doc` entries store whole canvases (crop, resize, rotate, a paste that grows the canvas). Consecutive doc entries share canvases.
  - Unsaved state is `isDirty()` = `!hist.isClean()` OR a floating selection OR non-empty open text. Never keep a separate dirty flag.
- **UI wiring** is mostly data-driven from attributes in `index.html`:
  - `data-tool` and `data-cmd` buttons are dispatched by one document-level click handler, which looks commands up in `CMDS`.
  - `.opts [data-for="tool1 tool2"]` elements show or hide per tool in `setTool()`.
  - `data-tip` / `data-kbd` / `data-hint` feed the custom tooltip. Shortcut labels are written Mac-style (`⌘⇧`), and `keyLabel()` converts them for other platforms. `aria-keyshortcuts` and `aria-description` are generated from the same attributes at boot.
  - The shortcuts dialog is generated from the `HELP` table. Keep `HELP`, the `data-kbd` attributes, the README table and the keydown handler in sync.
- **Keyboard:**
  - `keyId(e)` maps keys by the character on the user's layout and falls back to the physical key for non-Latin letters. Digits stay physical.
  - Order in the keydown handler: a focus tooltip swallows the first Esc; dialogs and text fields return; while `drag` is set only Esc (cancel) and Shift (constrain shapes) act; then come modifier shortcuts, then single keys.
  - Arrows nudge the selection only when focus is on the canvas. Toolbars use roving tabindex through `rove()`.
- **Focus rules:** after a pointer click on a toolbar control, focus is released so single-letter shortcuts work. Keyboard activation keeps focus. The text box doesn't commit when focus moves into `.chrome`. `releaseFocus()` returns focus to an open text box.

## Constraints and conventions

- `confirmDiscard()` uses the synchronous native `confirm()` on purpose. Open must call `showOpenFilePicker` within the user gesture, and New applies on the synchronous `submit`, not `close`. An async in-app dialog would break both.
- Saving writes PNG, JPEG or WebP according to the file extension. Any other format (GIF, BMP) is saved as a PNG copy and never overwritten.
- Design decisions made during the UI polish, and why, are tabled in `HANDOFF.md` along with the remaining backlog. Check it before changing UX behaviour.
