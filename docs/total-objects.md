# Total objects: every mark is an object

A plan (2026-10-17) for making **everything** in Paint an object: pencil and brush strokes, the eraser, fills, text, pasted images and the opened picture, not only lines, rectangles and ellipses. Any mark could then be selected, moved, restyled, reordered or deleted after it was drawn. The user took the ten recommended defaults; it is being built on branch `total-objects-plan` (progress under "Status" at the end).

It builds on `docs/objects.md` (the live-shapes work, merged) and on reading three apps:

- **tldraw**: the source at `dd11653` (2026-10-16, v5.5.2). The user named its performance as the bar.
- **OpenPencil**: the source at `de913ce` (2026-10-16).
- **Figma**: its engineering blog posts. Figma's source isn't public, so every Figma claim below is dated by the post it comes from.

## TL;DR

- **Yes, it can be done, in 6 phases (0–5), and the app ships after every one.**
  - Phase 0 is a measurement gate.
  - Phase 1 moves today's shapes onto the new engine, with no visible change.
  - Phase 2 is **the switch**: every tool that writes pixels becomes an object in one release. A mix of the two would make the remaining pixel tools paint under the strokes.
- **The core idea:** a scene of immutable objects (the model tldraw and Figma use) rendered into **one document-resolution canvas that is a cache of the scene**. `#image` keeps its job as the canvas you see, and it becomes that cache.
  - Pan and zoom never re-draw content. That is the main reason tldraw feels fast, and Paint keeps it.
  - An edit re-draws only the dirty rectangle, from a spatial index (an R-tree, as tldraw uses).
- **We take tldraw's techniques, not its renderer.** tldraw draws each shape as its own SVG/DOM element. That can't give a pixel editor what it needs: what you see at 800% is the PNG you save, a 1 px pencil is aliased, and pages hold 100 MP. The technique-by-technique table is below.
- **No CanvasKit or WASM.** Chrome's Canvas 2D already runs on Skia on the GPU. Saves are pixel-exact only because screen and save go through the same rasterizer.
- **The big wins:**
  - Undo stops storing pixels for strokes, shapes and text. At 10000² that means 100 undo steps instead of 4.
  - Bitmaps (fills, pastes, lifted selections, whole-image ops) still count against the 256 MB cap, so a few full-canvas fills can still push older steps out.
  - A GPU context loss can be repaired by re-drawing the scene.
  - Memory after edits at 10000² should drop from 4.3 GB to roughly 1–1.5 GB.
- **One rule makes it safe:** each tool creates an object whose pixels, at the moment it's drawn, are byte-identical to what the tool paints today. A parity harness checks this against `master`.
- **Ten decisions are yours to make.** They're listed next, each with a recommended default.

## Open decisions

Each one has a recommended default. The plan is written assuming the defaults; changing one changes the phase it names.

1. **Reverse the "no full scene graph" decision?** `docs/objects.md` rejected option C (everything is a node), and `task.md` says not to relitigate without a new reason. There are two new reasons:
   - you asked for it;
   - `file://` was dropped on 2026-10-16, which removed the barrier to `fetch` and WASM that made the old verdict easy.

   *Recommended: yes, in phases, behind the Phase 0 measurement gate.*
2. **Renderer.**
   - (a) Canvas 2D with a document-resolution cache. *Recommended.*
   - (b) CanvasKit (Skia in WASM, 7 MB), as OpenPencil uses.
   - (c) DOM/SVG per object, as tldraw does.

   Reasons are in "Renderer choice".
3. **What zooming in shows.**
   - (a) Pixels, as now: at 800% you see the document's pixels. *Recommended*, because it keeps screen equal to the saved file.
   - (b) Crisp vectors, as in Figma. Shapes would look sharper than they'll save, which a pixel editor shouldn't do.
4. **Eraser.** Today the eraser paints **colour 2** with square, aliased stamps; it doesn't make pixels transparent.
   - (a) Keep that. As an object it's just a stamp stroke in colour 2, so its pixels match today's exactly. *Recommended.*
   - (b) Also add a whole-object eraser, as tldraw's eraser works. *Recommended as ⌥-drag with the Eraser.*
   - (c) An erase-to-transparent eraser stored as masks on the objects it touched. That's a new feature, and it can't match today's pixels. *Defer.*
5. **Fill.**
   - (a) Fill becomes a bitmap object: the flooded region of what you see at that moment, with today's anti-aliased edge ring (`Core.fillEdge`). It doesn't follow later edits: move the outline away and the fill stays where it was. *Recommended.* Its pixels match today's.
   - (b) Later: a click inside a closed shape object sets that shape's fill colour instead, as in Figma and tldraw.
   - (c) Vectorize the region (trace the mask). It scales cleanly but loses tolerance semantics. Not recommended.
6. **The opened picture.** It becomes the bottom object, a bitmap called the *base*.
   - Should the Move tool pick it? *Recommended: no, it's locked by default.* Otherwise every click on empty-looking canvas selects the whole picture.
7. **Select tool (S).**
   - (a) Keep it a pixel tool. Lifting a region creates an image object (a snapshot of what you see) plus a colour-2 rectangle object under it, where the region was. That is pixel-identical to today's lift. *Recommended.*
   - (b) In addition, add marquee selection of objects to the Move tool: drag on empty canvas, as in tldraw and Figma. Today that drag pans; Space would still pan. *Recommended, Phase 4.*
8. **Persistence.** Today objects are flattened into the saved PNG and gone on reopen (decided 2026-10-14). That was cheap when only a few shapes were objects. With every stroke an object, every save throws away all editability.
   - (a) Keep that.
   - (b) Add a round-trip: a PNG whose pixels are the picture, plus a private chunk holding the scene and the base bitmap. The full design is in `docs/objects.md`, "Persistence". Other apps see a normal PNG. The file grows by about the size of the base. *Recommended, Phase 5.*
9. **What one stroke is.** *Recommended: one object per pointer gesture* (down to up).
   - Long strokes are not split into several objects, as tldraw does at 600 points: where two pieces meet, the anti-aliased edge would be inked twice (the bug `filledge.js` guards against).
   - Instead one object keeps per-segment boxes for partial redraws.
10. **Stacking during the move-over.** Today pixel tools paint *under* shapes.
    - From the switch (Phase 2), a new mark goes on top of everything, like any new object. *Recommended*: in a world where everything is an object, "new marks go on top" is the only rule that reads naturally.
    - Until then, the current rule stays.

## What makes tldraw fast, and what Paint takes from it

Read from tldraw's source. The key files are:

- `packages/editor/src/lib/components/Shape.tsx`
- `.../editor/managers/SpatialIndexManager/SpatialIndexManager.ts`, plus `RBushIndex.ts` in the same directory
- `.../editor/managers/HistoryManager/HistoryManager.ts`
- `.../editor/overlays/strokeShapeIndicators.ts`
- `packages/tldraw/src/lib/shapes/draw/DrawShapeUtil.tsx`
- `apps/docs/content/sdk-features/{performance,culling,draw-shape,signals}.mdx`

| tldraw technique | What it does there | Here | Why |
|---|---|---|---|
| **Camera is a CSS transform** | Pan and zoom move one layer (`getHtmlLayerTransform`); no shape re-renders | **Already have it** | `#image` is CSS-scaled in a scrolled `#viewport`, so pan and zoom touch no pixels. The plan keeps it: content is drawn at document resolution, never per zoom. |
| **R-tree spatial index** (`rbush`) | O(log n) viewport culling and hit tests. Updated incrementally from store diffs, touching only the shapes that changed | **Adopt** | Hit tests (`Core.hitObject`) and the redraw queries ("which objects touch this dirty rect, in z order") need it once there are thousands of strokes. Use `rbush` from npm, pinned, as tldraw does. |
| **Geometry cache** | Bounds, outline and hit geometry computed once per shape version (`getShapeGeometry`) | **Adopt** | Objects are immutable, so a `WeakMap` keyed by the object holds its box, its `Path2D` and its segment boxes, with no invalidation logic. |
| **Viewport culling** (`display: none` on off-screen shapes) | Off-screen shapes cost nothing | **Adapt** | There are no per-object DOM nodes to hide. The equivalent is to **draw the visible part first**: a big rebuild (rotate, resize, context loss) draws visible tiles first and the rest at idle. That is OpenPencil's "visible before overscan" rule too. |
| **Debounced zoom and LOD** (`getEfficientZoomLevel`) | Above 500 shapes, shapes don't re-render mid-zoom, and they simplify when small | **Free / skip** | A document-resolution cache never re-draws on zoom, so there's nothing to debounce. Only the overlays (selection outlines, handles) depend on zoom, and they already live in the DOM in device px. |
| **History marks and squashing** | Every store change is recorded as a diff; a gesture is one entry, squashed to a mark | **Adopt** | Entries become record diffs (`[id, before, after]`), not whole-list snapshots, so a 5,000-object scene doesn't copy its list per edit. The coalescing keys (`setObjs(next, key)`) carry over. |
| **Batched store updates** (`editor.run`) | One notification per transaction | **Adopt** | A transaction collects dirty rects, and `render()` redraws their union once per frame. |
| **Signals** (`@tldraw/state`) | Fine-grained reactive invalidation | **Skip** | `render()` already redraws only when its key changes, through write-if-changed setters. The scene's dirty-rect list does the rest. A signals library would be a second invalidation system. |
| **SVG/DOM element per shape** | The browser rasterizes and composites each shape | **Skip** | See "Renderer choice": it breaks screen = saved file, it can't do aliased pixels, and 5,000 strokes would mean 5,000 DOM nodes. |
| **`maxPointsPerShape` = 600** (a long stroke splits into a new shape) | Bounds the per-shape path rebuild while drawing | **Adapt** | Splitting double-inks the anti-aliased edge where the pieces meet. Instead, keep one object with per-segment boxes, so a redraw strokes only the segments that reach the dirty rect. `brushCommit()` already filters segments this way (`d.all`, `box`). |
| **Delta-encoded points** (Float16 deltas in base64) | Small records for sync and storage | **Adapt** | In memory, a `Float32Array` per stroke (8 bytes per point, several times less than an array of `{x, y}` objects). Delta encoding only matters for the save chunk (decision 8). |
| **Batched indicators**: one `Path2D` and one `stroke()` for all selected and hovered outlines, on a canvas overlay | Selecting 1,000 shapes stays cheap | **Adopt with multi-select** | Today there are one `#objsel` and one hover element. With marquee selection of many objects, draw the outlines as one `Path2D` on a screen-resolution overlay canvas. |
| **Lazy resize** (`scaleX`/`scaleY` instead of re-encoding points) | A resize writes 2 numbers | **Adopt** | A stroke object carries a transform; its points are never rewritten. |
| **Shape cap** (`maxShapesPerPage` 4000) | A hard limit | **Adapt** | A painting easily passes 4,000 strokes, so there's no hard cap. Phase 0 measures where it degrades, and ⌘E (flatten) becomes "flatten into one bitmap object" for people who want to bake. |
| **`PerformanceManager`** (frame stats per interaction) | Telemetry | **Already have** | `test/e2e/bench.js` and `bench-compare.js`. The new scenarios are listed below. |

To be honest about it: much of tldraw's smoothness comes from **not having a pixel document**. Its shapes are resolution-free and the browser rasterizes them at screen size. Paint has a fixed pixel grid that must save exactly as shown, up to 100 MP. So this plan copies tldraw's data model, its indexing and its history, and gets the "camera never re-draws" property from the document-resolution cache instead of from SVG.

## Figma and OpenPencil: what applies

| Source | Finding | Here |
|---|---|---|
| Figma, "Building a professional design tool on the web" (Evan Wallace, 2015) | Its own WebGL renderer, "tile-based"; objects in pre-allocated typed arrays to avoid GC pauses; Canvas 2D rejected because it is immediate mode and re-uploads geometry every frame | Paint never re-uploads per frame, because the cache is retained. Typed arrays: adopt for stroke points. |
| Figma, "How Figma's multiplayer technology works" (2019) | The document is `Map<ObjectID, Map<Property, Value>>`; the parent link is a property; order among siblings is a fractional index; undo follows the rule "undo a lot, copy, redo back: the document should not change" | Objects as property records with a **fractional z-key** (tldraw does the same with `IndexKey`), so R-tree hits sort into z order without `indexOf`. The undo rule holds automatically with immutable records and diff entries. |
| Figma, "Figma rendering: powered by WebGPU" (2025-09-18) | C++ compiled to WASM, WebGPU through Dawn, with a mid-session fallback to WebGL. The post doesn't mention tiles | Skip. Nothing applies at Paint's scale. |
| Figma Draw (help centre, 2025) | Pencil and brush create **vector networks**, with texture brushes as stroke styles | It confirms that freehand-as-objects is mainstream. Figma's tools are vector tools: I found no tolerance flood fill or aliased pixel pencil, so Paint has to define those itself (decisions 4–7). |
| OpenPencil `packages/docs/development/architecture.md` | Flat `Map<guid, Node>`, tree via `parentIndex`; typed scene events; CanvasKit 7 MB WASM; Yoga; Kiwi format | The flat map: adopt. The rest is a design tool's stack, not a paint app's. |
| OpenPencil `renderer-lifecycle.md` | A **retained backing** is shown during navigation and never rebuilt mid-gesture; exact content is built at idle and swapped in atomically; **generations** cancel stale work, and a stale result is deleted, never installed; an opt-in tiled renderer works visible-first | Adopt for big rebuilds: keep showing the old cache until the new one is complete; a generation counter drops stale chunks (as `scaleDoc()` and `runFill()` already drop stale results). |
| OpenPencil `scene-graph/src/undo.ts` | Inverse commands with a `coalesceKey`, limit 200 | Same shape as Paint's keyed `setObjs`. |
| OpenPencil tools | **No freehand tool at all.** Its toolbar is Select, Frame, Section, Rectangle, Ellipse, Line, Text, Pen, Hand | Nothing to copy for strokes, eraser or fill. |

## Renderer choice

**Recommended: Canvas 2D, with `#image` as a document-resolution cache of the scene.**

- **CanvasKit (option b), against:**
  - It's 7 MB of WASM against ~28 KB gzipped of boot script today.
  - Chrome's Canvas 2D is already Skia on the GPU.
  - Save, copy and the picker must equal the screen pixel for pixel. Today they do because display and save use one rasterizer. CanvasKit would add a second one (its own Skia build), and anti-aliasing would differ by a level here and there, as already seen between turned and drawn ellipses (`docs/objects.md`, item 7).
  - The measured performance work (GPU tile snapshots, block draws, idle readback) is all Canvas 2D.
  - Revisit only if Canvas 2D runs out of features (blur, blend modes as object styles).
- **DOM/SVG per object (option c), against:**
  - It renders at screen resolution, so at 800% you'd see smooth vectors, not the pixels you'll save.
  - SVG can't draw today's aliased 1 px pencil faithfully.
  - Thousands of strokes become thousands of DOM nodes.
  - Every save would need a second, Canvas 2D drawing path, which could disagree with the screen.
- **Two layers (base canvas + transparent object canvas, composited by CSS), also rejected:**
  - Drawing anti-aliased ink onto a transparent layer and then compositing it rounds alpha twice. Pixels then differ by ±1 from drawing straight onto the picture, and parity with today is lost.
  - Save would still need a composite.

  A single composite cache stays byte-exact with today's sequential drawing.

### Layers after the change

| Canvas | Size | What it holds | Who writes it |
|---|---|---|---|
| `baseCv` (new, not in the DOM) | document | The base bitmap: the opened picture, or blank. Until Phase 2 it also holds pixel edits from tools that aren't objects yet | Open, New, whole-image ops; transitional pixel tools |
| `#image` (existing) | document | **The composite cache:** base plus every object, in z order. It is what you see, save, copy, pick from and fill from | Only the renderer (`redraw(rect)`), plus the live-stroke fast path below |
| `#preview` (existing) | visible area | The shape being drawn, a lifted float, the brush tail | `render()` |
| DOM overlays (existing) | — | Ants, handles, hover outline; later, a batched-outline canvas for multi-select | `render()` |

### The redraw primitive

`redraw(rect)`:

1. Group the dirty rects into contiguous blocks (`Core.groupRects(…, 1)`). Per-tile draws on a 100 MP canvas cost 130–540 ms per 1,600 draws; block draws don't.
2. For each block, `clearRect`, then `drawImage(baseCv, block)`.
3. Query the R-tree for the objects touching the block, sort them by z-key, and draw each one clipped to the block (integer coordinates).

**Invariant:** any sequence of `redraw()` calls leaves `#image` byte-identical to drawing the whole scene once, in order. Unit-test the rect maths in `core.js`, and pixel-test random dirty rects in e2e.

### Live gestures

- **New stroke on top (pencil, brush, eraser).** It draws straight into `#image` exactly as today. `brushCommit()` restores its box from the stroke's own GPU tile snapshots and strokes every segment that reaches it as one clipped path. The snapshots now only need to live for the gesture: they are dropped on release, never read back, and never stored in history. On release, the object joins the scene, and the cache already shows it. Drawing cost should equal today's.
- **Moving or resizing an object.** Each frame redraws (old box ∪ new box) from the scene.
  - If Phase 0 finds dense areas too slow (hundreds of strokes under the box), **lift** the object at drag start: snapshot "everything below it" lazily per tile (with the same GPU tile machinery), draw the object on top, then draw only the objects above it.
  - Figma and OpenPencil both isolate the moving content in a similar way.
- **Big rebuilds** (rotate, resize, canvas size, undo of those, GPU context loss):
  - The old cache stays on screen.
  - The visible blocks are drawn first, the rest in idle chunks.
  - A generation counter discards a stale build (OpenPencil's rule).

### Undo

- **Scene entries** hold `[id, before, after]` triples.
  - Undo applies `before`, redo applies `after`, and the changed boxes are redrawn.
  - Their size is tens of bytes per object, so the 256 MB budget stops being the limit and the 100-entry cap is.
- **Bitmap assets** (base, pasted images, fill bitmaps, lifted snapshots) are immutable and shared by reference.
  - An entry is charged for an asset only while it is the only holder.
- **`doc` entries** for whole-image ops keep the previous `baseCv` and object list, as today.
- **Region entries and GPU-held undo tiles** become unnecessary once nothing writes `baseCv` in place (Phase 3). Then `queueToData()`, `gpuLost()`'s entry dropping and the idle readback can retire, and a context loss on `#image` is repaired by `redraw(all)`.
  - Assets must survive a context loss too. Keep the opened file's `Blob` (or `ImageData`) as the source of truth, not only a canvas.
- **`isDirty()`** stays derived from history.

## Object kinds

| Kind | Data | Pixels at creation equal today's because | Phase |
|---|---|---|---|
| `line`, `rect`, `ellipse` | As now (`a`, `b`, colours, size, mode) | Already objects | 1 |
| `text` | String, font, size, colour, position (`textBaseline()` maths unchanged) | Same `fillText` calls | 2 |
| `image` | Asset ref, x, y, w, h | Same `drawImage` as committing `sel.float` | 2 |
| `pencil` | Int points (`Int32Array`), colour, size | Same Bresenham square stamps (`stampLine`) | 2 |
| `brush` | Settled segments `{a, c, b}` (`Float32Array`), colour, size, per-segment boxes | The same one-path stroke `brushPath()` draws | 2 |
| `eraser` | A pencil-like stamp stroke in colour 2 | It's what the eraser paints today | 2 |
| `fill` | A bitmap asset (the region plus the anti-aliased ring), x, y | `Core.fillPlan`, run in `fill-worker.js` as today, now on the composite | 2 |
| `base` | The bottom bitmap, locked | It is the picture | 3 |

Transforms keep their current rules (`Core.moveObj`, `scaleObj`, `transformObj`). Strokes get a transform field instead of rewritten points, and pencil strokes re-stamp after a transform, so they stay aliased.

## Invariants every phase keeps

1. **Screen = saved file** at zoom ≥ 1: `#image` is the composite, and save, copy and the picker read it directly.
2. **Parity:** an object's pixels at creation match what `master` paints for the same input. This is checked by the parity harness (Phase 0).
   - *Corrected in Phase 1 (2026-10-17):* byte-identical holds for the raster and the object records, not for composites with path objects. Chrome's GPU canvas anti-aliases a path differently depending on what else is in its batch and where on the canvas it lands (a line's edge pixel: 28 alone, 128 after an ellipse). `master`'s composite has the same dependence, so composites are compared within anti-aliasing. Evidence in `task.md`, Phase 0.
   - **The cache is a pure function of the scene** instead: it is repainted in whole 512² tiles, each composed from scratch the same way, so any sequence of repaints equals `__paint.freshRender()` byte for byte.
3. **One-path brush:** the image equals the stroke drawn as one path (`test/e2e/filledge.js`), including across tile edges. Tiles have integer edges.
4. **No DOM writes in `pointermove`.** All writes happen in `render()`, as now.
5. **No document readback during a stroke.**
6. **`isDirty()` comes from history only**, plus a float and open text, as now.
7. **`__paint` grows** with scene accessors (`objs`, `redrawCount`, `assetBytes`). Tests don't reach into the DOM for internal state.

## Phases

Each phase is a branch and a PR, green on CI, and shippable. The tests named are the ones that change; the rest must pass untouched.

### Phase 0: measure and gate (no user-visible change)

- **Parity harness** (`test/e2e/parity.js`): replay a scripted session on two builds and compare the saved PNG bytes. It is phase-aware:
  - **Phases 0–1:** no flattening. The branch must equal `master` exactly, including pixel tools painting under shapes.
  - **From Phase 2 (new marks on top):** the `master` side flattens each shape as it's drawn, so both sides stack in drawing order.
- **Bench scenarios** in `bench.js`, run on `master` first for baselines:
  - `scene 5k strokes`: build a scene of 5,000 brush strokes (simulated with shapes on `master`), at 4000×3000 and 10000².
  - `move one in 5k`: drag one object across a dense area for 60 frames.
  - `stroke over 5k`: 300-move brush stroke on top.
  - `rebuild 5k`: a full redraw, the cost after rotate or context loss.
- **Spike** (throwaway): measure `redraw(rect)` with N = 1k / 5k / 20k strokes in the box, at 10000², to decide whether lift-on-drag (above) is needed from the start.
- **Gate:** if a 256² `redraw` with 500 strokes under it exceeds ~8 ms, or a full 5k rebuild at 10000² exceeds ~2 s, stop and re-plan before Phase 1. One way out is a coarser cache: a stroke group rasterized once as a sprite.

### Phase 1: scene, spatial index and composite cache, for the existing shapes

- **Scene store** in a new `scene.js`:
  - immutable records, a fractional z-key, an R-tree, the `WeakMap` geometry cache;
  - diff entries in `History` (replacing the `obj` entry's whole-list snapshot);
  - transactions that collect dirty rects.
- **`baseCv` + `#image` as the composite.** Pixel tools still paint `baseCv` (under shapes, as decided), followed by `redraw(dirty)` per frame. `img` and `ctx` (and so `tiles.js`'s undo snapshots) now point at `baseCv`; `adoptImage()` swaps `baseCv` and re-sizes `#image`. The fill reads `baseCv`, so it still ignores shapes, as today.
- **`render()` stops redrawing every object on `#preview`** when `objVer` changes. Today that is O(n) per edit, the first thing that breaks with many objects.
- `composite()` becomes "read `#image`". Save, copy and the picker stop building a full-size copy.
- **Tests:**
  - `objects.js`: the cache equals a fresh full render after random edits; the hit test runs via the R-tree.
  - `preview.js`: objects are no longer on `#preview`.
  - `history.js`: pixel edits are unchanged; object undo uses diffs.
  - Unit tests: R-tree wrapper, z-keys, dirty-rect grouping.
- **Bench:** brush under 50 shapes at 10000² is no worse than `master`; `move one in 5k`.

### Phase 2: the switch. Every tool that writes pixels creates an object (one release)

**Why it is one release:** once any visible content lives above `baseCv`, a tool still writing `baseCv` paints *under* it. Splitting this phase would ship those breakages:

- Fill would pour straight through brush outlines.
- The eraser couldn't erase strokes.
- A lifted selection would leave the strokes behind.
- Typed text would go under earlier strokes.

So the steps below land on one branch, and nothing ships until all of them are done. After this phase, nothing writes `baseCv` except whole-image ops, and **new marks go on top** (decision 10).

1. **Pencil and brush.** This is the decisive step for performance.
   - The live path stays `brushCommit()` / `stampLine()` into `#image`, with gesture-scoped tiles. Release adds the object.
   - Strokes are hit-tested by distance to their segments: within half the size plus a screen-px tolerance, using per-segment boxes.
2. **Eraser.** The colour-2 stamp stroke becomes an object (decision 4a).
3. **Text.** `commitText()` creates a `text` object, and the text tool reopens it on click (`docs/objects.md`, item 9).
4. **Paste, drop and a committed float** create `image` objects (`docs/objects.md`, item 10).
   - The asset store gets reference counting and charges assets to history bytes.
5. **Fill** creates a `fill` bitmap object (decision 5a).
   - **Behaviour change:** today the fill reads only the raster (`#image`), so it ignores shapes. After the switch it reads the composite, everything you see, through a transferred copy as now.
   - The worker message format stays backward-compatible (`CLAUDE.md`, Libraries).
6. **Select tool (S).** Lift becomes an image object plus a colour-2 rect object under it (decision 7a); Delete becomes a colour-2 rect object. Crop stays a whole-image op.

**Tests:**

- `filledge.js`:
  - the one-path rule, checked on the object after moves and after random `redraw()` blocks;
  - the fill object's pixels equal `master`'s fill.
- `history.js`: stroke, fill and selection undo become scene diffs and stay pixel-exact; the run-length fill redo path (`Path2D` of runs) retires.
- `smoke.js`: the pencil, brush, eraser, fill, text, paste and select sections. Pixel reads that expected "pixel tools under shapes" change to "new marks on top".
- `objects.js`: text and image round trips.
- **Parity harness:** switches to flatten-as-drawn on the `master` side (see Phase 0), and covers every tool.

**Bench:**

- `10000 brush stroke` stays within noise of `master` (762 ms per 300 moves).
- `undo steps kept` at 10000², for strokes: from 4 to 100.
- `stroke over 5k`.
- `memory after edits` at 10000².

### Phase 3: the base object, and retiring pixel undo

- The opened picture becomes the locked base object (decision 6).
- Nothing writes `baseCv` in place any more, so region undo, GPU-held undo tiles, `queueToData()` and the idle readback retire (see Undo).
- A GPU context loss redraws the scene instead of dropping entries (`history.js` 1c changes meaning).
- **Tests:** `history.js` is rewritten around scene diffs and `doc` entries; `smoke.js` crop and open sections.
- **Bench:** `memory after edits` at 10000² (target ≤ 1.5 GB, against 4.3 GB).

### Phase 4: working with many objects

- **Move tool:** marquee selection of objects (Space still pans), ⇧-click to add, batched outlines on an overlay canvas, group move and resize, a z-order menu (decision 7b).
- **⌥-drag with the Eraser** deletes whole objects it crosses, with a hover preview (decision 4b).
- **Fill** inside a closed shape object sets the shape's fill (decision 5b).
- ⌘E flattens the selection into one bitmap object.
- **Tests:** `objects.js` multi-select, eraser and shape-fill sections.
- **Bench:** select all and move with 5k objects.

### Phase 5 (if decision 8b): round-trip save

- A private PNG chunk holding the scene JSON, the stroke arrays delta-encoded, and the base and assets as nested PNGs.
- A hash of the composite lets Paint ignore a stale chunk after the file was edited in another app.
- Chunk splicing and CRC32 live in `core.js`, test-first.

## Benchmark targets

These are proposed; Phase 0 confirms them against `master` on the M4. `task` noise is about ±15%.

| Scenario | Today | Target |
|---|---|---|
| Brush stroke, 300 moves, 10000², empty scene (main-thread ms) | 762 | within noise |
| Same, over 5k strokes | n/a | ≤ 1.2 × empty |
| Move one object among 5k, per frame (p95) | n/a | ≤ 8 ms main thread, no long frames |
| Pan or scroll at 25%, 5k strokes | ~0 content work | 0 content redraws (`__paint.redrawCount` unchanged) |
| Undo/redo of one stroke, 10000² | region swap | ≤ 16 ms (diff + one box redraw) |
| Undo steps kept, 10000², strokes and shapes | 4 | 100 (the count cap); bitmap entries still count bytes |
| Memory after edits, 10000² | 4.3 GB | ≤ 1.5 GB |
| Full rebuild, 5k strokes, 10000² | n/a | visible area ≤ 100 ms, everything ≤ 2 s at idle |
| Save at 10000² with objects | composite built first | no composite build |

## Risks

- **Dense paintings.** Redraw cost scales with the strokes under the dirty box. Phase 0's gate exists for this, and lift-on-drag and sprite caching are the fallbacks.
- **Memory at 100 MP.** `baseCv` plus `#image` is two document-size canvases (about 800 MB). That's still far below today's history footprint, but it's a fixed floor. If it's too much, a later step could make `#image` sparse (tiles only where objects exist), at the cost of seams at zoom < 1.
- **Transform parity.** Turned and flipped strokes match flatten-then-transform within anti-aliasing, not bit for bit. This is the same as shapes today (`docs/objects.md`, item 7), and the same test tolerance applies.
- **Stale fills.** A fill object doesn't follow the outline it filled (decision 5a). Users of vector apps may expect it to.
- **Scope.** Phase 2 (the switch) is the big one: several times the objects spike, on one long-lived branch. Keep it rebased on `master`, and land Phase 1 first so the engine is already proven. Phases 1, 3 and 4 are each about the size of the spike; Phase 5 is small.

## Sources

- **tldraw**, `github.com/tldraw/tldraw` at `dd11653`. The files are listed in the table heading above; also `packages/editor/src/lib/options.ts` (`maxShapesPerPage: 4000`) and `packages/utils/src/lib/reordering.ts` (fractional indexing).
- **OpenPencil**, `github.com/open-pencil/open-pencil` at `de913ce`:
  - `packages/docs/development/{architecture,renderer-lifecycle,navigation-performance}.md`
  - `packages/scene-graph/src/undo.ts`
  - `packages/docs/user-guide/*`
- **Figma:**
  - [Building a professional design tool on the web](https://www.figma.com/blog/building-a-professional-design-tool-on-the-web/) (2015)
  - [How Figma's multiplayer technology works](https://www.figma.com/blog/how-figmas-multiplayer-technology-works/) (2019)
  - [Realtime editing of ordered sequences](https://www.figma.com/blog/realtime-editing-of-ordered-sequences/) (2017)
  - [Figma rendering: powered by WebGPU](https://www.figma.com/blog/figma-rendering-powered-by-webgpu/) (2025-09-18)
  - [Draw with illustration tools](https://help.figma.com/hc/en-us/articles/31440438150935) (Figma Draw)
- **This repo:**
  - `docs/objects.md`
  - `task.md` (performance numbers and decisions)
  - `src/js/{objects,tools,view,selection,tiles}.js`

## Status

- **Phase 0 (done):** `test/e2e/parity.js`, the 5k bench rows, the gate measured and passed (`task.md`).
- **Phase 1 (done):** `scene.js` (R-tree from `rbush` 4.0.1, z-keys, geometry cache, whole-tile repaint, visible tiles first), `base` + `#image` as the cache, diff entries for objects. The redraw primitive differs from the sketch above: whole 512² tiles instead of grouped blocks, for the reason in Invariant 2.
- **Phase 2 (done):** pencil, eraser, brush, text (reopened by a click with the Text tool), pastes and lifts (image objects; a lift's colour-2 patch is a rect object), Delete (a patch) and the fill (a frozen fill object, from what is seen) all add objects on top. Parity runs with `--flatten-ref`, with composites compared at edges only (≤ 1% of pixels, ink within 0.5%): `master`'s own batches switch to multisampling (an edge pixel 58 vs 200), so no fixed channel limit holds. Bench at 10000² against `master`: brush 564 vs 652 ms, stroke over 5k 564 vs 1534 ms; slower: fill ×2 1083 vs 760 ms, undo/redo ×5 1480 vs 883 ms, rotate ×2 392 vs 70 ms (a full-image fill object repaints every tile), memory after edits 6.0 vs 4.2 GB (two full-image fill bitmaps; the region undo tiles retire in Phase 3).
- **Phase 5 (done, ahead of 3 and 4):** a PNG saved with objects carries a `paNt` chunk (`persist.js`): a length, JSON of the objects (bitmaps as indices), then the base and each asset as nested PNGs. The chunk records a hash of the file's own IDAT bytes in place of a composite hash: an app that re-encodes the picture leaves a stale chunk, which is ignored. Stroke points are stored as plain JSON numbers, not delta-encoded. JPEG and WebP save just the picture.
- **Phase 4a (done):** ⌥-drag with the Eraser deletes every object it crosses (sampled every half reach, so a fast drag skips nothing), one undo step; ⌥ alone outlines the object under the pointer. Help (now an "Objects" section), README and tooltips updated.
- **Phase 4b (done in part):** the Move tool box-selects on empty canvas (every object the box touches; ⇧ adds), ⇧-click adds or removes one (a ⇧-drag still locks the axis), a drag on a selected group moves it all, and arrows, Delete and ⌘D act on the group, each one undo step. Outlines are one batched `Path2D` on `#preview`. Space or the middle button pans. Not done: group resize, a z-order menu, fill inside a closed shape setting its fill (decision 5b), ⌘E flattening only the selection.
- **Phase 3 (done, simplified):** the opened picture stays the base canvas, the locked bottom layer (the Move tool can't pick it), rather than an object record. ⌘E is a whole-document step (the new base is a copy of the cache). With nothing writing the base in place, region undo, GPU undo tiles, the idle readback and `tiles.js` are gone (`gpu.js` keeps the context-loss handling). Not done: keeping the opened file's bytes so a lost base can be rebuilt. Bench at 10000²: brush 440 ms (`master` 652), memory after edits 4.7 GB (`master` 4.2; target 1.5 not met: the bench's two full-image fills are 400 MB bitmaps each, and its rotates keep whole canvases).
- **Checks after the phases (2026-10-17):** a reopened file starts with nothing selected; ⌘C / ⌘X copy a selected group. Parity also compares what each step changed (the pixels that moved by over 32 must agree on 90% of their union), which catches a missing mark that the whole-picture tolerance let through. objects, history, filledge and smoke pass with `--disable-gpu` (SwiftShader), as on CI. Undo depth at 10000² after 120 whole-canvas brush strokes: 100 steps here, 1 on `master`.
- **Also done:** a Fill click inside a closed shape (topmost there) sets that shape's fill (decision 5b); ⌘E with the Move tool and a selection flattens just the selection into image objects, in place: one per run of selected neighbours in the stack (`Core.flattenRuns`; an unselected object between them that covers one below splits the run, so nothing seen changes). A selected object that clears what is under it (`Core.clearsUnder`: a stroke or patch in Transparent, a fill that replaces pixels) stays an object and splits the run the same way, since an image can't clear.
- **Also done:** group resize by the selected group's box handles (each object scaled about the box), and arranging: Front / Forward / Backward / Back buttons in the Move tool's bar, ⌘] ⌘[ and ⌘⇧] ⌘⇧[, for one object or a group.
- **Open:** the 1.5 GB memory target (see below).
- **Decision 6 (done, 2026-10-17):** the opened picture is the bottom object, `objs[0]`: `{t: 'base', locked, x, y, w, h, asset}` over the base canvas, with the z-key `Zz` (`Core.BASE_Z`, just below `a0`, so the keys above it stay short; a list saved with lower keys is re-keyed on load). Locked objects never hit-test, so it can't be picked, box-selected, moved, reordered or deleted; whole-image ops and ⌘E replace it with the new canvas (`syncBase()`). It isn't saved in the chunk's list (the base is its own blob). Tests read `__paint.userObjs` for the other objects.
- **Memory work (2026-10-17):** an opaque fill (the usual case) is drawn from its runs, banded by 256 rows, and has no bitmap at all; a 90° turn or flip is undone by turning back, so its step keeps no canvas. Bench at 10000², one run: fill ×2 1141 ms, undo/redo ×5 1440 ms, rotate ×2 366 ms (back to the bitmap-era timings), memory after edits 3.98–4.27 GB across runs (`master` 4.2). **The 1.5 GB target is below this design's floor:** an empty 10000² document is 1.72 GB here (`master` 1.09 GB), because the base and the `#image` cache are two document-size canvases, as the plan's Risks section says. Going lower means a sparse cache (tiles only where objects are), not attempted.
- **GPU context loss:** image and fill bitmaps (and a fill's clearing mask) keep a CPU copy, read at idle in strips of rows and charged to the undo budget with the canvas, and are refilled and repainted when their canvas comes back; path-drawn fills hold nothing on the GPU. The base itself has no copy (it would be the whole picture again): a lost base still drops the whole-document steps, as before.
- **Fill cells (2026-10-20):** a fill is cut along the scene's 512² tiles in the fill worker (`Core.fillCells`): per tile, the region's merged rects and the soft edge pixels (one path per colour, cleared first where not opaque), or a dense tile's pixels. A tile repaint draws only the cells it meets, one for a fill that hasn't moved, where the 256-row bands spanned the fill's whole width. Every fill is paths now, over transparency and in Transparent too; only a dense cell has a canvas (≤ 1 MB, rebuilt from its pixels after a context loss). Image assets keep their CPU copy only where a 2D context can be lost (not in WebKit).
- **The chunk** packs strokes (`Core.packObj`): pencil and eraser points as deltas, brush segments as one flat array (float coordinates kept exact, so not delta-coded).

