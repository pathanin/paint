# Objects: editable shapes, Figma-style

An exploration (2026-10-14) of whether and how Paint could treat things as objects, the way Figma and OpenPencil do: a shape stays a shape that you can select, move, resize, restyle, reorder and delete, instead of becoming pixels the moment it is drawn.

A thin spike of the recommended option is on branch `objects-spike`. See "The spike" below for what it does and doesn't cover.

## TL;DR

- Today every tool bakes pixels into `#image` at once, and undo stores pixels (tiles, fill masks, whole canvases). So "objects" can't be added to the select tool. It is a second document model next to the raster.
- **Recommendation: an object layer above the raster (option B).** Rectangles, ellipses and lines (then text, then pasted images) become live objects drawn above the pixels. Pixel tools keep working on the raster underneath. Objects are flattened into pixels on an explicit Flatten (⌘E, as in Figma), and before any whole-image op.
- **A full scene graph like Figma/OpenPencil (option C) is the wrong target here.** It would mean turning brush strokes into vector paths and dropping the raster model the app is built and tuned around. OpenPencil leans on CanvasKit (7 MB WASM) and Yoga WASM, and neither can load under the `file://`, no-build, no-`fetch` constraint.
- **The open product questions** are what pixel tools do to objects (they draw *under* them), and whether objects should survive a save (that needs a native format; see Persistence).

## How Figma and OpenPencil model objects

Read from OpenPencil's source (`packages/docs/reference/scene-graph.md`, `packages/core/src/editor/undo.ts`). Its MCP tools couldn't be used because the desktop app wasn't running.

| Aspect | OpenPencil / Figma | What it would mean here |
|---|---|---|
| Storage | Flat `Map<guid, Node>`, tree via `parentIndex`; pages → frames/groups → shapes | A flat list ordered bottom→top is enough until groups exist |
| Node types | FRAME, GROUP, RECTANGLE, ELLIPSE, LINE, TEXT, VECTOR, STAR, POLYGON, SECTION, INSTANCE… | RECT, ELLIPSE, LINE first; TEXT and IMAGE next |
| Bitmaps | Not a node: an `IMAGE` *fill* on a rectangle (`imageHash`, scale mode) | A pasted image could become a rect with an image fill: a movable, scalable picture |
| Geometry | x, y, w, h relative to the parent, rotation in degrees, 2×3 transform | x/y/w/h in image px; rotation later |
| Paint | `fills[]`, `strokes[]` (weight, cap, join, dash, align) | One stroke colour, one fill colour, a width: what the options bar has today |
| Hit test | Topmost visible node, test point mapped into node-local coords | Same, plus a stroke tolerance in *screen* px so thin lines are clickable at any zoom |
| Undo | Inverse commands: snapshot the affected fields before a change; drags batched into one entry | Snapshot the object list (objects are immutable and small); one entry per gesture |
| Rendering | CanvasKit (Skia WASM) over an infinite canvas | Canvas 2D on `#preview`, at screen resolution over the visible part only |
| File | Kiwi binary (`.fig`) | PNG + a private chunk (see Persistence) |

The part worth copying is the **model**: immutable nodes with ids, a z-ordered list, field-snapshot undo, and topmost-first hit testing. The **engine** (WASM renderer, Yoga layout, CRDT collaboration) doesn't fit this app.

## Options

### A. Editable until committed (MS Paint 10 style)

The shape you just drew keeps handles until you click elsewhere or switch tools. Then it bakes, exactly like a floating selection does today (`sel.float`).

- **Cost:** small. It reuses the float machinery.
- **But:** only the most recent shape is ever editable. It isn't "objects"; it's a better shape tool.

### B. Object layer above the raster (recommended)

Objects persist in a z-ordered list drawn above `#image`. Any object can be selected at any time, with the select tool or by clicking the selected shape again with a shape tool.

- **Pixel tools** (pencil, brush, eraser, fill) act on the raster *under* the objects. The picker and copy sample what you see (raster + objects).
- **Flatten** (⌘E) bakes every object into the raster as one undo step.
- **Before whole-image ops** (crop, resize, canvas size, rotate, flip), objects are flattened first. A later step could transform the objects instead (rotate their coordinates, scale them with Resize) rather than flatten them.
- **Saving to PNG, JPEG or WebP** writes the flattened composite. The objects stay live in the session.
- **Cost:** medium. See the touch list.

### C. Full scene graph (Figma / OpenPencil)

Everything is a node, including brush strokes (vector paths) and pasted bitmaps (image fills). The "document" is the tree, and `#image` becomes a cache.

- **Cost:** a rewrite. Fill, the eraser and tolerance-based ops have no meaning on vector nodes without rasterizing first. The tile undo, GPU snapshots, fill-edge work and 100 MP budgets would all be thrown away or duplicated.
- **Verdict:** if Figma-grade vector editing is the goal, it's a different app.

## The constraints that decide it

1. **Pixel tools vs objects.** This is the central UX question. With B, painting goes *under* objects, as on a raster layer in Photoshop or Krita below a shape layer. The alternatives are:
   - flatten all objects on the first pixel stroke (surprising: a brush dab freezes every shape);
   - flatten only the objects the stroke touches (complicated, and still surprising).

   B's rule is simple and predictable, and it needs a visible cue. Ideas: a one-time hint ("Shapes stay above your drawing · ⌘E to flatten"), and later a tiny layers list.
2. **Fill** sees only the raster, so a fill can flow "under" a rectangle's outline. Following the composite would need a composite readback (400 MB at 100 MP) and would still write to the raster. Recommendation: keep fill raster-only, and say so in its hint.
3. **Persistence.** PNG, JPEG and WebP can't hold objects. To keep them across a save, write a PNG whose pixels are the flattened composite (so every other app sees the right picture) plus a private ancillary chunk (`paNt`, or `iTXt` with a keyword) holding the object JSON and the raster *without* the objects (a nested PNG). On open, if the chunk is present, restore both. Costs and risks:
   - The chunk must be spliced in after encoding (UPNG and `toBlob` both produce plain PNGs). That's ~40 lines of CRC32 and chunk splicing, which fits in `core.js` and is testable.
   - The file grows by the size of the base raster.
   - A file edited in another app keeps a stale chunk. Store a hash of the composite in the chunk, and ignore the chunk when the pixels no longer match.
4. **`file://`, no build step, no `fetch`.** Everything stays in Canvas 2D inside the IIFE. No CanvasKit, Yoga or Yjs. This rules out C's usual stack and is fine for B.
5. **Performance at 100 MP.** Objects are drawn to `#preview`, which only covers the visible area plus a margin (`placePreview()`), so a frame's cost scales with the screen, not the document. The selection outline and handles are DOM elements in device px, like `#ants`, so they stay crisp at 1600%. Full-size rasterization happens only on flatten, save, copy and whole-image ops. Object undo entries are tiny (a list snapshot), so object edits never push pixel history out.
6. **Undo integration.** `History` is untouched. An `obj` entry holds the *other* object list and swaps it on apply, the same "entry holds the other state" rule as region and doc entries. Flatten is a `region` entry that also carries the object list, so one undo restores the shapes and un-bakes their pixels together. `isDirty()` stays derived from history.

## Touch list (for option B)

1. **`core.js`, test-first:** `objBox` (paint bounds), `hitObject` (topmost first; filled vs outline; tolerance), `objHandles` / `handleAt`, `moveObj`, `resizeObj` (a handle drag that may flip past the opposite edge). Done in the spike.
2. **Document state:** `objs` (immutable objects, bottom→top) and `objSel` (an id). History gets an `obj` entry type, and the region entry gets an optional `objs`. Done.
3. **Rendering:** objects drawn on `#preview` in `render()` (under shape previews and the brush tail, above a pixel float), keyed by a version counter, and an `#objsel` outline with 8 handles placed like `#ants`. Done.
4. **Pointer:** the select tool hit-tests handles of the selected object, then objects, then falls back to the marquee. Shape tools edit the selected object when you press on it, and otherwise draw a new one. New `drag.t` values: `objmove`, `objsize`. Esc cancels both. Done.
5. **Keyboard:** Delete, arrows (⇧ = 10), Esc to deselect, ⌘D duplicate, ⌘] / ⌘[ forward/backward, ⌘E flatten. Done in the spike, but not yet in `HELP`, `data-kbd` or the README.
6. **Restyle:** colour 1 and 2, size and Outline/Fill/Both act on the selected object (Figma's properties panel, in the options bar). Done for the palette, colour wells, the size slider (one undo step per drag, on `change`) and the fill-mode radios.
7. **Whole-image ops:** crop, resize, canvas size, rotate and flip flatten first. Done, but as two undo steps: flatten, then the op. Next: transform objects instead of flattening.
8. **Export:** save, copy and the picker use the composite. Done; save builds a full-size composite only when objects exist.
9. **Text as an object:** not done. `commitText()` would create a TEXT object (string, font, size, colour, position) instead of baking, and clicking it with the text tool would reopen the box. The baseline maths (`textBaseline()`) carries over unchanged.
10. **Pasted images as objects:** not done. This would reuse `sel.float`'s canvas as an IMAGE object, so a paste could be moved and scaled later, which is the most Figma-like win for screenshots.
11. **Persistence chunk:** not done (see constraint 3).
12. **Rotation, groups, multi-select, snapping, layers list:** not done. Multi-select (⇧-click, marquee over objects) is the next most useful step after text.
13. **`task.md`:** "selection resize handles" is listed as out of scope for polish. Objects reopen it as feature work.

## The spike (`objects-spike` branch)

**Behind a switch.** Shapes stay editable only when **Editable** is on in the Rectangle, Ellipse and Line options (`S.liveShapes`). It is off by default, so the existing behaviour and every existing test are unchanged. Turn it on to try it.

What works with Editable on:

- **Drawing:** a rectangle, ellipse or line becomes an object. It's selected right after drawing, with handles.
- **Editing:** drag the body to move, drag a handle to resize (a line has two end handles), and Esc mid-drag cancels.
- **Selecting:** with the select tool, click any object. Clicking empty canvas falls back to the marquee.
- **Keyboard:** Delete, arrows to nudge, Esc to deselect, ⌘D duplicate, ⌘] / ⌘[ to reorder, ⌘E to flatten all.
- **Restyling:** palette, colour wells, size and Outline/Fill/Both act on the selected object.
- **Undo/redo:** every object edit is undoable. Flatten undoes as one step (pixels and objects together).
- **Composite:** save, copy and the picker include objects. Crop, resize, rotate and flip flatten first.

Found while building it: if the shape tools keep the last object selected, setting up the *next* shape (picking a colour or style) restyles the last one, and a drag that starts inside it moves it instead of drawing. So the selection now survives only the select tool and the object's own shape tool. Figma avoids this by switching back to Move after each shape. Paint keeps the tool, so this rule stands in for that switch.

Verification: unit tests in `test/core.test.js` (object geometry) and an e2e check, `test/e2e/objects.js`.
