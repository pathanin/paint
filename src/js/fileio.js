import Core from './core.js';
import { docLanded, hist, img, landDoc, requestDoc, setDoc } from './doc.js';
import { $, makeCanvas, textBox } from './dom.js';
import { encodeBlob, loadUTIF, startWorker, used, workerCall } from './libs.js';
import { composite, hasObjs, loadObjs, objIdNext, resetObjs, sceneVer, userObjs } from './objects.js';
import { readScene, withScene } from './persist.js';
import { commitSelection } from './selection.js';
import { S, sel, sizeProblem } from './state.js';
import { cancelText, commitText, textAt } from './text.js';
import { errText, flash } from './toast.js';
import { fitZoom, kickFrame, updateChrome } from './view.js';

// ---------- file I/O ----------
const IMAGE_TYPES = [{ description: 'Images', accept: { 'image/*': ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tif', '.tiff'] } }];
// A floating selection or open text box isn't in history yet, but it is still unsaved work.
const isDirty = () => !hist.isClean() || !!(sel && sel.float) || !!(textAt && textBox.value.trim());
// The document as it is (what an edit changes), for an Open that waits: if it changed since its discard
// was confirmed, the discard is asked about again before the Open lands.
const docMark = () => ({ top: hist.top(), scene: sceneVer, float: sel && sel.float, text: textAt ? textBox.value : null });
const sameDoc = (m) => { const n = docMark(); return n.top === m.top && n.scene === m.scene && n.float === m.float && n.text === m.text; };
const confirmDiscard = () => !isDirty() || confirm(`Discard unsaved changes to ${S.fileName}?`);

async function openFile() {
  if (!confirmDiscard()) return;
  // The picker needs the click's user activation, which runs out ~5 s after it, and confirm() doesn't
  // pause that clock: after a slow answer, offer the picker from a fresh click instead of failing.
  const ua = navigator.userActivation;
  if (ua && !ua.isActive) { flash('Discard confirmed. Choose the file to open', false, { label: 'Open…', run: pickFile }); return; }
  await pickFile();
}
async function pickFile() {
  if (!window.showOpenFilePicker) { $('#fileInput').click(); return; }
  try {
    const [h] = await window.showOpenFilePicker({ types: IMAGE_TYPES });
    await loadFile(await h.getFile(), h); // its turn starts here: a picker that's cancelled asks for nothing
  } catch (err) {
    if (err.name !== 'AbortError') flash("Can't open the file: " + errText(err, 'permission was denied'), true);
  }
}
// A decode failure with a reason worth showing (too big, an unreadable TIFF) carries `why`.
const cantOpen = (file, err) => (err && err.why ? `Can't open ${file.name}: ${err.why}`
  : file.type === 'image/svg+xml' || /\.svg$/i.test(file.name)
  ? "Can't open SVG files. Use PNG, JPEG, WebP, GIF, BMP or TIFF." : 'Not an image: ' + file.name);
const openError = (why) => Object.assign(new Error(why), { why });
const isTiff = (file) => file.type === 'image/tiff' || /\.tiff?$/i.test(file.name);
// The browser decodes most formats itself. Chrome can't decode TIFF, so that goes through UTIF
// (first page only).
async function decodeFile(file) {
  try { return await createImageBitmap(file); }
  catch (err) { if (!isTiff(file)) throw err; }
  let UTIF;
  try { UTIF = await loadUTIF(); }
  catch { throw openError('the TIFF reader didn’t load. Reload the page and try again'); }
  const buf = await file.arrayBuffer();
  let page;
  try { page = UTIF.decode(buf).find((p) => p.t256 && p.t257); }
  catch { page = null; }
  if (!page) throw openError('it isn’t a TIFF image this app can read');
  const w = page.t256[0], h = page.t257[0];
  const why = sizeProblem(w, h); // check before decoding: the pixels of a huge TIFF may not fit in memory
  if (why) throw openError(why);
  try { UTIF.decodeImage(buf, page); }
  catch { throw openError('it uses a TIFF compression this app can’t read'); }
  const rgba = UTIF.toRGBA8(page);
  used.open = 'utif';
  return createImageBitmap(new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, w * h * 4), w, h));
}
function tooBigToOpen(file, bmp) {
  const why = sizeProblem(bmp.width, bmp.height);
  if (!why) return false;
  bmp.close();
  flash(`Can't open ${file.name}: ${why}`, true);
  return true;
}
// The Open asked for last wins (doc.js requestDoc): one still loading when a later Open, drop or New
// lands is dropped, quietly, since that one shows. turn: its place in that order (a drop takes it as it
// arrives, before its decode); seen: the document when its discard was confirmed (docMark). Both
// default to now, which is when an Open's own picker has just returned.
async function loadFile(file, handle, decoded, turn = requestDoc(), seen = docMark()) {
  const stale = () => docLanded > turn;
  let bmp = decoded;
  if (!bmp) {
    try { bmp = await decodeFile(file); }
    catch (err) { if (!stale()) flash(cantOpen(file, err), true); return; }
  }
  if (stale()) { bmp.close(); return; }
  if (tooBigToOpen(file, bmp)) return;
  // A PNG Paint saved with objects carries them (persist.js): reopen those, over the saved base.
  const scene = /\.png$/i.test(file.name) || file.type === 'image/png' ? await readScene(new Uint8Array(await file.arrayBuffer())) : null;
  if (stale()) { bmp.close(); return; }
  // Edited while it loaded: those edits were never part of the discard confirmed for it.
  if (!sameDoc(seen) && !confirmDiscard()) { bmp.close(); return; }
  landDoc(turn);
  const keep = scene && scene.base.width === bmp.width && scene.base.height === bmp.height;
  cancelText();
  if (keep) setDoc(scene.base);
  else setDoc(bmp, bmp.width, bmp.height);
  bmp.close();
  hist.clear();
  if (keep) loadObjs(scene.objs, scene.nextId);
  else resetObjs();
  Object.assign(S, { fileHandle: handle || null, fileName: file.name, pristine: false, trimWarned: false, docId: S.docId + 1 });
  fitZoom(true);
  updateChrome();
}

// Formats we can encode. Anything else (GIF, BMP, ...) is saved as a new PNG rather than overwritten.
// Safari has no WebP encoder (toBlob and convertToBlob quietly return a PNG), so there WebP is one of those.
const WEBP = (() => { try { return makeCanvas(1, 1).toDataURL('image/webp').startsWith('data:image/webp'); } catch { return false; } })();
const canWrite = (name) => (WEBP ? /\.(png|jpe?g|webp)$/i : /\.(png|jpe?g)$/i).test(name);
const asPng = (name) => (Core.saveName(name) || 'untitled.png').replace(/\.webp$/i, '.png'); // foo.gif -> foo.png
function mimeFor(name) {
  const ext = name.split('.').pop().toLowerCase();
  return ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png';
}
// still (encodeBlob): whether the document is still the one being saved.
function encode(type, src = composite(), still) {
  if (type === 'image/jpeg') { // no alpha in JPEG: flatten onto white instead of black
    const c = makeCanvas(src.width, src.height), g = c.getContext('2d');
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, c.width, c.height);
    g.drawImage(src, 0, 0);
    return encodeBlob(c, type, 0.92).finally(() => { c.width = 0; }); // free its pixels now, not at some later GC
  }
  return encodeBlob(src, type, 0.92, still);
}
// UPNG compresses harder than the browser's PNG encoder. In a test (Chrome, M4), its files were
// ~60% smaller on a screenshot, 40-46% on a drawing, 92% on a gradient, 16% on a photo and 13% on
// noise. It runs in a worker (png-worker.js), so the page doesn't freeze, but Save still waits for
// it: ~30-100 ms per MP when the browser's PNG is under a quarter of the raw size, ~180-290 ms per
// MP above that (photos, noise), measured on the main thread. So the browser's file size picks the
// estimate, and UPNG runs only when that's within UPNG_BUDGET_MS, and only up to a 4K screen. Both
// encoders run and the smaller file wins, so a PNG is never bigger than before. UPNG writes into a
// buffer of raw size + 100 bytes and silently truncates past it; incompressible output comes close
// to that, so anything over 90% of raw is rejected.
const UPNG_MAX_PIXELS = 3840 * 2160, UPNG_BUDGET_MS = 750;
const upngMs = (pixels, nativeRatio) => pixels / 1e6 * (nativeRatio < 0.25 ? 100 : 300);
async function encodePng(still) {
  const tryUpng = img.width * img.height <= UPNG_MAX_PIXELS;
  // Snapshot the pixels in the same tick as encode() does, so both encoders see one image. The worker
  // reads the snapshot back: a getImageData on #image here would read it all on the main thread.
  const src = composite(); // with any objects drawn over the pixels
  const w = src.width, h = src.height, rawBytes = w * h * 4, snap = tryUpng && createImageBitmap(src);
  if (snap) kickFrame();
  const native = await encode('image/png', src, still);
  used.png = 'builtin';
  const bmp = snap && await snap.catch(() => null);
  if (!bmp || upngMs(w * h, native.size / rawBytes) > UPNG_BUDGET_MS) { if (bmp) bmp.close(); return native; }
  const worker = startWorker('png-worker'); // one per save: frees UPNG's memory after
  try {
    const { png } = await workerCall(worker, { bmp, w, h }, [bmp]);
    if (png.byteLength >= native.size || png.byteLength > rawBytes * 0.9) return native;
    used.png = 'upng';
    return new Blob([png], { type: 'image/png' });
  } catch {
    return native;
  } finally {
    worker.terminate();
  }
}
// A PNG keeps the objects in a private chunk (persist.js); JPEG and WebP can't, so they get the picture.
// still (encodeBlob): whether the document is still the one being saved.
async function encodeFor(name, still) {
  if (mimeFor(name) !== 'image/png') return encode(mimeFor(name), undefined, still);
  const png = encodePng(still);
  if (!hasObjs()) return png;
  const bytes = png.then((b) => b.arrayBuffer()).then((a) => new Uint8Array(a));
  bytes.catch(() => {}); // withScene awaits it last: a failure meanwhile isn't an unhandled rejection
  return new Blob([await withScene(bytes, userObjs(), objIdNext(), still)], { type: 'image/png' });
}
// The running save's promise, or null: one picker/write at a time (another Save meanwhile does nothing).
// Tests await __paint.saving before reading what a save did.
let saving = null;
const SLOW_DOWNLOAD_MS = 1000;
function save(as) {
  if (saving) return saving;
  saving = saveNow(as).finally(() => { saving = null; });
  return saving;
}
const cancelled = () => flash('Save cancelled: a different image is open now', true);
async function saveNow(as) {
  commitText();
  commitSelection();
  const savedAt = hist.top(); // edits made while the save is in flight stay unsaved
  // New or Open while it waits (a permission prompt, the picker, the encode and write) replaces the
  // document: that one is then neither encoded into this file nor given its handle, name or save point.
  const doc = S.docId, replaced = () => S.docId !== doc, still = () => !replaced();
  let h = as ? null : S.fileHandle;
  let name = S.fileName;
  if (!canWrite(name)) {
    if (h && !as) flash(`Can't write ${name.split('.').pop().toUpperCase()} files. Saving a PNG copy.`);
    h = null;
    name = asPng(name);
  }
  try {
    if (h && (await h.queryPermission({ mode: 'readwrite' })) !== 'granted' &&
        (await h.requestPermission({ mode: 'readwrite' })) !== 'granted') h = null;
    if (replaced()) return cancelled();
    if (!h) {
      if (!window.showSaveFilePicker) {
        if (as) { // no save picker here: ask for the name, so Save As differs from Save
          const typed = Core.saveName(prompt(`Save as (PNG, JPEG${WEBP ? ' or WebP' : ''}; PNG if no extension)`, name));
          if (!typed) return;
          name = canWrite(typed) ? typed : asPng(typed);
        }
        const t0 = performance.now();
        const href = URL.createObjectURL(await encodeFor(name, still));
        const download = () => { const a = document.createElement('a'); a.href = href; a.download = name; a.click(); };
        download();
        setTimeout(() => URL.revokeObjectURL(href), 60000); // Safari may first ask to allow downloads
        if (!replaced()) { S.fileName = name; hist.markSaved(savedAt); updateChrome(); }
        // Safari may block a download started this long after the click: offer one from a fresh click.
        if (performance.now() - t0 > SLOW_DOWNLOAD_MS) flash(`Downloaded ${name}. Nothing arrived?`, false, { label: 'Download again', run: download });
        else flash('Downloaded ' + name);
        return;
      }
      h = await window.showSaveFilePicker({
        suggestedName: name,
        types: [
          { description: 'PNG', accept: { 'image/png': ['.png'] } },
          { description: 'JPEG', accept: { 'image/jpeg': ['.jpg', '.jpeg'] } },
          ...(WEBP ? [{ description: 'WebP', accept: { 'image/webp': ['.webp'] } }] : []),
        ],
      });
      if (replaced()) return cancelled();
    }
    const blob = await encodeFor(h.name, still);
    const w = await h.createWritable();
    await w.write(blob);
    await w.close();
    if (!replaced()) {
      hist.markSaved(savedAt);
      Object.assign(S, { fileHandle: h, fileName: h.name });
      updateChrome();
    }
    flash('Saved ' + h.name);
  } catch (err) {
    if (err.name === 'SourceChanged') cancelled();
    else if (err.name !== 'AbortError') flash('Save failed: ' + errText(err, 'permission was denied'), true);
  }
}

export { cantOpen, confirmDiscard, decodeFile, docMark, encodeFor, isDirty, loadFile, openFile, save, saving, tooBigToOpen };
