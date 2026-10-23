# Code review, 2026-10-21

## Status (2026-10-24)

- **All findings are fixed** on branch `fix/save-resize-flatten`:
  - 1–3 in `c56df80`, with what three review rounds of that fix found (an Open still loading could land on a newer document; the blob worker's fallback could write a replaced document into the old file). A fourth round was interrupted before it reported.
  - 4–12 in the next commit (2026-10-24), each with a check that fails without it where a test can see it:
    - 4: the claim is corrected (`objects.js`, `task.md`, `docs/total-objects.md`).
    - 5: after a slow discard prompt, Open offers the picker from a toast button.
    - 6: `pngChunks` computes each CRC only when it's read.
    - 7: a restyle sets only what the kind draws with.
    - 8: Cut deletes after the clipboard write succeeds, and only what it copied.
    - 9: box-select and pan release toolbar focus.
    - 10: `[` / `]` step an odd size above 10 onto the even grid.
    - 11: `png-worker.js` reads a transferred snapshot back; the page no longer calls `getImageData` on `#image`.
    - 12: `paintLater` returns early when there's nothing to paint; `encodeBlob` falls back to `toBlob` when the snapshot fails; `readScene` validates each object (`Core.validObj`), and a bad scene opens as pixels; `Core.unionBox` replaces `Math.max(...)` over object lists; a brush's frame is its ink.
  - Two issues the review rounds turned up are fixed too: copying the whole image passes `still` to `encodeBlob`, and ⌘E on a lone image adds no step.
  - The `history.js` open item is fixed: see its section below.
- The line numbers below refer to the reviewed checkout (`99fddc2`), not to later code.

## Scope

- **Read in full:** local `master` (`99fddc2`): every module in `src/js/`, `src/sw.js`, `build.mjs`, and the CI workflow.
- **Read as a diff:** the 5 newer commits on `origin/master` (PR 21, object snapping, `5cf0e38`).
- **How each finding was checked:**

| Findings | How checked | Holds on `origin/master`? |
|---|---|---|
| 1, 2, 3, 4, 8, 9 | Reproduced in Chrome with a Playwright script | Yes: rerun on an `origin/master` build, identical results |
| 5, 7 | Reproduced in Chrome, on this checkout | Code unchanged there (`fileio.js`, `objects.js`, `tools.js`, `toolbar.js`) |
| 6 | Measured in Node, with the same `core.js` code | `pngChunks` / `readChunk` / `withChunk` unchanged there |
| 10, 11, 12 | Found by reading | Code unchanged there, except the brush-frame note, which is about `origin/master`'s new snapping |

- The scripts are listed at the end.
- This document is the review as written; the fixes since are listed under Status.

## Summary

| # | Severity | Finding | Where |
|---|---|---|---|
| 1 | **High** | A save still running when another document is opened or created binds that document to the old file; the next ⌘S overwrites the old file | `fileio.js:179`, `fileio.js:200` |
| 2 | **Medium-high** | A Resize image still running when another document is opened or created replaces that document with the resize result | `transforms.js:78`, `doc.js:47` |
| 3 | **Medium** | ⌘E on a selection brings back pixels that Transparent strokes, patches or fills had cleared | `objects.js:248-263` |
| 4 | Low | ⌘E on a selection can shift the anti-aliasing of *unselected* objects nearby (contradicts "nothing seen changes") | `objects.js:247` |
| 5 | Low-medium | Open fails if the "Discard unsaved changes?" dialog stays up over 5 s, with a misleading "permission was denied" | `fileio.js:17-26` |
| 6 | Low | Every PNG open runs a CRC over the whole file (≈300 ms main-thread for 150 MB) | `core.js:1019-1035` |
| 7 | Low | Picking colours with an image or fill selected adds undo steps that change nothing | `objects.js:204-208` |
| 8 | Low | Cut deletes the selection before the clipboard write succeeds | `clipboard.js:35-37` |
| 9 | Low | Move-tool box-select leaves focus on a keyboard-activated toolbar button, so Delete and arrows don't reach the selection | `pointer.js:94-101` |
| 10 | Low | `[` / `]` don't snap to the documented 1…10, 12, 14… grid from an odd size above 10 | `core.js:420-422` |
| 11 | Low | `encodePng()` calls `getImageData` on `#image`, which CLAUDE.md's rules forbid | `fileio.js:120` |
| 12 | Minor | Hardening notes (5 one-liners) | see section 12 |

There's also one open item that isn't mine: `history.js` fails 3 checks on this Mac. It reproduces, and three likely causes are ruled out (see "Open item" below).

---

## 1. High: a save in flight hands its file to the next document

**Where:** `saveNow()` in `src/js/fileio.js`. After its awaits it writes the file identity unconditionally:

- Line 200 (picker / handle path): `Object.assign(S, { fileHandle: h, fileName: h.name })`.
- Line 179 (download path): `S.fileName = name`.

New (`doc.js` `newDoc`), Open (`loadFile`), drop and launch (`pwa.js` `openLaunched`) never check `saving`.

**What happens:**

1. Save document A (`photo.png`). Encoding a large image takes seconds.
2. Meanwhile, open document B, or press New.
3. A's save finishes and sets `S.fileHandle` to A's handle, now attached to B.
4. Press ⌘S on B. It writes B's pixels into `photo.png` without asking. A is gone.

**Repro output:**

- New during the save: after New, the handle is `null`. After the save lands, the handle is `photo.png`, the title is "photo.png — Paint", and ⌘S wrote the 100×100 new document into `photo.png`.
- Open during the save: after Open, the handle is `second.png`. After the save lands, it is `first.png`, and ⌘S wrote `second`'s image into `first.png`.

**How likely:** a re-save of an unchanged document runs the full encode and write with no prompt. ⌘S, then immediately ⌘O, is enough. If the document was dirty, Open asks "Discard unsaved changes?" first, and a user who just pressed Save is likely to click OK.

**Expected:** the new document keeps its own handle and name.

**Fix (pick one):**

- Give each document a generation number, bumped in `newDoc` and `loadFile`. `saveNow` records it at the start and skips its `S.fileHandle`, `S.fileName` and `markSaved` writes if it changed.
- Or make New, Open, drop and launch wait for `saving`, or refuse with "Still saving".

## 2. Medium-high: a resize result lands on a newer document

**Where:**

- `scaleDoc()`, `src/js/transforms.js:78`, treats the result as stale only if `base !== src` or `hist.top() !== top`.
- `setDoc()`, `src/js/doc.js:47`, reuses the same base canvas (`base.width = w`) for New and for Open of a bitmap, and both then call `hist.clear()`.

**What happens:** when the resize was the first edit (`top === null`, as in "open a photo, resize it"), New or Open leaves both checks unchanged. When pica finishes, `docOp` swaps its result in over the new document. pica also reads `src` asynchronously, so it can read the *new* document's pixels.

**Repro output (pica path, 5000² → 2500²):**

- New 300×300 during the resize: the document ends up 2500×2500, with 1 undo step.
- Open a 400×300 red PNG during the resize: the document ends up 2500×2500 and still named `red.png`. Sampling the whole result:
  - It's almost all transparent.
  - The only content is a red area in the top-left corner, about 0.5% of the image, which matches the red file shrunk to 200×150.
  - So pica read the *new* file's pixels as if they were the old 5000² picture.
  - A ⌘S would write this into `red.png`.

Undo recovers it. `test/e2e/libs.js:134` tests the stale-resize message, but only for changes these two checks can see.

**Fix (pick one):**

- Have `setDoc()` always adopt a fresh canvas, so `base !== src` holds after New and Open. The fill's `base !== src` check would then also mean what it says.
- Or check a document generation number (see finding 1).

## 3. Medium: ⌘E on a selection brings back what Transparent marks cleared

**Where:** `flattenSelected()`, `src/js/objects.js:248-263`. Each run is drawn with `drawObj` onto a fresh, transparent canvas (line 256), and the canvas becomes an image object.

**What happens:** an object that clears (`destination-out`) has nothing to clear on that canvas, so its effect disappears. This covers:

- Transparent pencil, eraser and brush strokes
- a lift's or Delete's patch with colour 2 set to Transparent
- Transparent fills (`asset.clears`)

**Repro output:**

1. Draw a black bar.
2. Set Transparent and draw a pencil stroke across the bar. The pixel at (150, 100) reads `[0,0,0,0]`.
3. With the Move tool, click that stroke and press ⌘E. The pixel now reads `[0,0,0,255]`: the erased part is back.

**Expected:** `task.md` (Shapes) and `docs/total-objects.md` both say "nothing seen changes".

**Fix:** have `Core.flattenRuns` end a run at any clearing object and leave it as an object, so it keeps clearing what is under it. Optionally flash why it stayed. A clearing effect can't be expressed as a `source-over` image object.

## 4. Low: ⌘E on a selection can change unselected objects' edges

**Where:** the claim "what is seen doesn't change" in the comment at `objects.js:247`, and the same claim in `task.md` (Shapes) and `docs/total-objects.md`.

**Repro output:** an ellipse (3 px), a line over it, then ⌘E with only the ellipse selected.

- 432 pixels change. The whole-scene ⌘E on the same scene changes 0.
- On the ellipse itself (266 px), the worst change is 1/255. The same happens with the ellipse alone. Redrawing the selection is fine.
- Near the *unselected* line (166 px), the worst change is 48/255. Once the ellipse is no longer a path in the tile's batch, Chrome anti-aliases the line differently. That's the batch effect described in `task.md` (Phase 0).

**Fix:** no rasterisation of the run can avoid this, because the change is in an object outside the run. Correct the claim, for example: "nothing seen changes, apart from anti-aliasing shifts of up to a few levels on neighbouring paths". The same effect follows any edit that removes a path from a tile, such as Delete.

## 5. Low-medium: Open fails after a slow discard prompt

**Where:** `openFile()`, `src/js/fileio.js:20-23`. `confirmDiscard()` uses the native `confirm()` so that `showOpenFilePicker()` still runs inside the click. That decision is in `task.md`.

**What happens:** Chrome's user activation expires 5 s after the click, and `confirm()` doesn't pause that clock.

**Repro output:**

- Dialog answered after 0.5 s: activation is still active, and the picker opens.
- Answered after 6 s: `navigator.userActivation.isActive` is `false`, and the picker throws `SecurityError: Must be handling a user gesture`.

`errText()` maps `SecurityError` to "permission was denied", so the toast reads "Can't open the file: permission was denied".

Found by reading, not tested: the file-input fallback (`#fileInput.click()`, used where there's no `showOpenFilePicker`) also needs activation, and a `click()` without it opens no chooser and reports no error.

**Fix:** after the confirm, if `navigator.userActivation && !navigator.userActivation.isActive`, show a toast with an "Open…" button. Its click is a fresh gesture, the same pattern as "Download again". Also give this path its own message instead of "permission was denied".

## 6. Low: every PNG open CRCs the whole file

**Where:** `Core.pngChunks()`, `src/js/core.js:1025`, computes the CRC of *every* chunk. `readChunk()` (line 1032) only needs the CRC of the chunk it returns, and `withChunk()` (line 1037) needs none. `loadFile()` calls `readScene()` → `readChunk()` on every PNG, with or without a `paNt` chunk, and every save with objects calls `withChunk()`.

**Measured (Node, same code):**

| PNG size | Open (`readChunk`) | Save with objects (`withChunk`) |
|---|---|---|
| 10 MB | 21 ms | 21 ms |
| 50 MB | 99 ms | 102 ms |
| 150 MB | 299 ms | 307 ms |

Both run on the main thread.

**Fix:** compute the CRC lazily, only for a chunk whose type matches.

## 7. Low: colour picks on an image or fill add invisible undo steps

**Where:** `restyleObj()`, `src/js/objects.js:204-208`. It's called with `{color}` / `{alt}` from `setColor()` (`tools.js:48`) and `swapColors()` (`toolbar.js:19`) for whatever single object is selected.

**Repro output:** select a pasted image with the Move tool, then click Red and Shift-click Green. That adds 2 new undo steps (`color`, then `alt`), changes 0 pixels, and marks the title "● untitled.png". Undo then needs two extra ⌘Z presses that do nothing visible. Strokes and text get `alt` the same way.

**Fix:** restyle only the properties the kind draws with:

- shapes: `color`, `alt`, `size`, `mode`
- strokes: `color`, `size`
- text: `color`
- image and fill: none

## 8. Low: Cut deletes before the clipboard write succeeds

**Where:** `copySel()`, `src/js/clipboard.js:35-37`. `deleteObj()` / `deleteSelection()` run before `await navigator.clipboard.write(...)`.

**Repro output:** with the write rejected (`NotAllowedError`), the object count goes from 1 to 0, and the toast reads "Copy failed: the browser blocked clipboard access". Undo recovers it.

**Fix:** start the write in the gesture as now, `await` it, then delete (capture the ids or the rect first).

## 9. Low: box-select keeps focus on a keyboard-activated toolbar button

**Where:** `src/js/pointer.js:94-101`. The Move tool's empty-canvas branch returns before the focus release at line 114, which every other pointerdown path reaches.

**Repro output:**

- Focus the Move button and press Enter (focus stays, by design), then box-select two shapes. Focus is still on the Move button, and Delete leaves both objects.
- Clicking an object instead moves focus to `BODY`.

**Fix:** do the same blur as line 114 before the `objbox` return (and the pan return).

## 10. Low: `[` / `]` don't snap to the grid from odd sizes above 10

**Where:** `Core.stepSize()`, `src/js/core.js:420-422`. The `task.md` decision: "`[` / `]` snap to the 1…10, 12, 14… grid".

**What happens:** down from 11 gives 10, which is right (and tested). Up from 11 gives 13, then 15, and stays off the grid. A slider can set 11.

**Fix:** step up to the next even number: `s < 10 ? s + 1 : s + 2 - (s % 2)`.

## 11. Low: `encodePng()` reads `#image` directly

**Where:** `src/js/fileio.js:120`: `src.getContext('2d').getImageData(0, 0, w, h)` on `#image`, up to 4K (≈33 MB), on the main thread, for UPNG.

CLAUDE.md says not to `getImageData` on `#image`, and to read it back in a worker or in strips (as `blob-worker.js` does). I didn't measure the cost. I'm noting it as a breach of the project's own rule.

## 12. Minor hardening

- **`paintLater()` with nothing to paint** (`scene.js:201-214`): it still calls `fenceAfter()` when `flushRedraw()` has already emptied `later`. That's a needless 1 px copy, texture upload and fence, and a slow one counts toward `slowUploads`. Return early when `later` is empty.
- **No fallback when the snapshot fails** (`libs.js:49`): if `createImageBitmap(src)` rejects (memory pressure at 100 MP), `encodeBlob()` rejects with no `toBlob` fallback, so Save and Copy fail outright.
- **`readScene()` trusts the chunk's JSON** (`persist.js:48-72`): a crafted PNG (valid CRC and IDAT hash) with an unknown `t` or a missing `a` throws inside the tile-repaint microtask. Missing ids make `nextObjId` NaN (`objects.js:140`). It isn't a security hole (nothing reaches `innerHTML`), but nothing validates it.
- **`Math.max(...list)` over the object list:** `loadObjs` (`objects.js:140`), `flattenSelected` (`objects.js:253-254`) and `selectionCanvas` (`clipboard.js:17-18`). JavaScriptCore throws `RangeError` past 65,536 arguments. Only very large scenes are affected. `text.js:88` already avoids this, for the same reason.
- **Brush frames sit 1 px outside the ink** (`origin/master`, found by reading the code): `objFrame()` returns `objBox()` for strokes, and a brush's box includes the +1 px anti-aliasing margin. So the selection outline and the new snap lines (`frameOf`) sit 1 px outside the ink.

## Checked, not bugs

- **`History.dropLost` marking a saved entry LOST:** deliberate and tested (`core.test.js:905-915`). It's correct, because a GPU reset blanks the live base too.
- **The scene's `quiet` flag leaking:** every `endLive()` is followed synchronously by the stroke's `addObj()` (`pointer.js:297-299`).
- **Paste in the middle of a stroke:** the keydown handler `preventDefault`s ⌘V while `drag` is set (`keyboard.js:79`), so no `paste` event fires.
- **Stale tiles in `later` after a size change:** they only cause redundant repaints, since `compose()` reads the current scene.
- **A fill landing after New, Open or a text edit:** dropped, because `sceneVer` changes.
- **`panKey` / `altKey` stuck after switching windows:** reset on `blur` (`tooltips.js:55-62`).
- **The snapping diff (PR 21):** read in full. Apart from the brush-frame note above, I found nothing.

## Open item: `history.js` fails 3 checks on this Mac

The 3 failing checks:

- "undo of paste that grows is pixel-exact"
- "redo of pencil after crop is pixel-exact"
- "second undo of paste that grows"

It fails the same way on every run, both alone and alongside other runs. CI's Linux Chrome passes. `origin/master`'s `task.md` already lists it as "not looked into".

All three checks compare against the state recorded right after "pencil after crop". Ruled out:

1. **Chrome moving `#image` off the GPU after the test's own readbacks.** Hashing a copy instead of `#image` still fails the same 3 checks.
2. **A live stroke leaving the cache different from a fresh render.** Pencil, eraser and brush over an ellipse showed a 0 px difference (cache vs `freshRender()`, before and after a full repaint), over both an opaque and a semi-transparent noise base, in Chrome and WebKit.

**Cause (found 2026-10-24):** right after "pencil after crop", the cache differed from `freshRender()` by up to 4 levels in 5 channels, off the stroke. The tile's objects under it (scaled images, text) were composed before the live stroke's rects, in other batches, and Chrome for Mac anti-aliases them differently than when one compose draws them with the stroke. Forcing a flush before the stroke in `compose()` made the two match, which confirmed it. **Fix:** when a pencil or eraser stroke joins, its tiles that hold other objects are composed again (`rejoin` in `scene.js`). `history.js` now passes 86 of 86 here.

## Test baseline (this checkout, local Chrome)

- **Unit:** 87 passed.
- **e2e:**

| Suite | Passed | Failed |
|---|---|---|
| smoke | 313 | 0 |
| history | 83 | 3 (the open item above) |
| preview | 40 | 0 |
| filledge | 13 | 0 |
| objects | 200 | 0 |
| alpha | 105 | 0 |
| libs | 71 | 0 |
| pwa | 16 | 0 |

## Repro scripts

They are in `docs/code-review-2026-10-21/` (not committed) and drive `window.__paint`. Run them from the repo root against a served build, for example `node docs/code-review-2026-10-21/repro.js http://localhost:8765/`. `repro.js` also takes `ROOT=<dist dir>` to serve a build without a server; pass a case name as the second argument to run just that one. They print observed values and assert nothing, so they would need assertions to become regression tests for the fixes.

- `repro.js`: findings 1, 2, 3, 4, 8 and 9.
- `repro2.js`: findings 5 and 7.
- `repro3.js`: the cache-vs-fresh-render check from the open item. Set `window.NOISE` for the semi-transparent base.
- `repro4.js`: where finding 4's changed pixels are, and finding 2's whole result.
