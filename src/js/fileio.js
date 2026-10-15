import Core from './core.js';
import { hist, img, setDoc } from './doc.js';
import { $, makeCanvas, textBox } from './dom.js';
import { UPNG, UTIF, used } from './libs.js';
import { composite, resetObjs } from './objects.js';
import { commitSelection } from './selection.js';
import { S, sel, sizeProblem } from './state.js';
import { cancelText, commitText, textAt } from './text.js';
import { errText, flash } from './toast.js';
import { fitZoom, updateChrome } from './view.js';

// ---------- file I/O ----------
const IMAGE_TYPES = [{ description: 'Images', accept: { 'image/*': ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tif', '.tiff'] } }];
// A floating selection or open text box isn't in history yet, but it is still unsaved work.
const isDirty = () => !hist.isClean() || !!(sel && sel.float) || !!(textAt && textBox.value.trim());
const confirmDiscard = () => !isDirty() || confirm(`Discard unsaved changes to ${S.fileName}?`);

async function openFile() {
  if (!confirmDiscard()) return;
  if (!window.showOpenFilePicker) { $('#fileInput').click(); return; }
  try {
    const [h] = await window.showOpenFilePicker({ types: IMAGE_TYPES });
    await loadFile(await h.getFile(), h);
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
async function loadFile(file, handle, decoded) {
  let bmp = decoded;
  if (!bmp) {
    try { bmp = await decodeFile(file); }
    catch (err) { flash(cantOpen(file, err), true); return; }
  }
  if (tooBigToOpen(file, bmp)) return;
  cancelText();
  setDoc(bmp, bmp.width, bmp.height);
  bmp.close();
  hist.clear();
  resetObjs();
  Object.assign(S, { fileHandle: handle || null, fileName: file.name, pristine: false, trimWarned: false });
  fitZoom(true);
  updateChrome();
}

// Formats we can encode. Anything else (GIF, BMP, ...) is saved as a new PNG rather than overwritten.
const canWrite = (name) => /\.(png|jpe?g|webp)$/i.test(name);
const asPng = (name) => Core.saveName(name) || 'untitled.png'; // foo.gif -> foo.png
function mimeFor(name) {
  const ext = name.split('.').pop().toLowerCase();
  return ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png';
}
function encode(type, src = composite()) {
  if (type === 'image/jpeg') { // no alpha in JPEG: flatten onto white instead of black
    const c = makeCanvas(src.width, src.height), g = c.getContext('2d');
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, c.width, c.height);
    g.drawImage(src, 0, 0);
    src = c;
  }
  return new Promise((res, rej) => src.toBlob((b) => (b ? res(b) : rej(new Error('encode failed'))), type, 0.92));
}
// UPNG compresses harder than the browser's PNG encoder. In a test (Chrome, M4), its files were
// ~60% smaller on a screenshot, 40-46% on a drawing, 92% on a gradient, 16% on a photo and 13% on
// noise. It runs on the main thread: ~30-100 ms per MP when the browser's PNG is under a quarter of
// the raw size, ~180-290 ms per MP above that (photos, noise). So the browser's file size picks the
// estimate, and UPNG runs only when that's within UPNG_BUDGET_MS, and only up to a 4K screen. Both
// encoders run and the smaller file wins, so a PNG is never bigger than before. UPNG writes into a
// buffer of raw size + 100 bytes and silently truncates past it; incompressible output comes close
// to that, so anything over 90% of raw is rejected.
const UPNG_MAX_PIXELS = 3840 * 2160, UPNG_BUDGET_MS = 750;
const upngMs = (pixels, nativeRatio) => pixels / 1e6 * (nativeRatio < 0.25 ? 100 : 300);
async function encodePng() {
  const tryUpng = img.width * img.height <= UPNG_MAX_PIXELS;
  // Read the pixels in the same tick as toBlob() snapshots them, so both encoders see one image.
  const src = composite(); // with any objects drawn over the pixels
  const w = src.width, h = src.height, raw = tryUpng && src.getContext('2d').getImageData(0, 0, w, h).data.buffer;
  const native = await encode('image/png', src);
  used.png = 'builtin';
  if (!tryUpng || upngMs(w * h, native.size / raw.byteLength) > UPNG_BUDGET_MS) return native;
  try {
    const png = UPNG.encode([raw], w, h, 0); // 0 colours = lossless
    if (png.byteLength >= native.size || png.byteLength > raw.byteLength * 0.9) return native;
    used.png = 'upng';
    return new Blob([png], { type: 'image/png' });
  } catch {
    return native;
  }
}
function encodeFor(name) {
  return mimeFor(name) === 'image/png' ? encodePng() : encode(mimeFor(name));
}
let saving = false;
async function save(as) {
  if (saving) return; // one picker/write at a time
  saving = true;
  try { await saveNow(as); } finally { saving = false; }
}
async function saveNow(as) {
  commitText();
  commitSelection();
  const savedAt = hist.top(); // edits made while the save is in flight stay unsaved
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
    if (!h) {
      if (!window.showSaveFilePicker) {
        if (as) { // no save picker here: ask for the name, so Save As differs from Save
          const typed = Core.saveName(prompt('Save as (PNG, JPEG or WebP; PNG if no extension)', name));
          if (!typed) return;
          name = typed;
        }
        const a = document.createElement('a');
        a.href = URL.createObjectURL(await encodeFor(name));
        a.download = name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 10000);
        S.fileName = name;
        hist.markSaved(savedAt); updateChrome();
        flash('Downloaded ' + name);
        return;
      }
      h = await window.showSaveFilePicker({
        suggestedName: name,
        types: [
          { description: 'PNG', accept: { 'image/png': ['.png'] } },
          { description: 'JPEG', accept: { 'image/jpeg': ['.jpg', '.jpeg'] } },
          { description: 'WebP', accept: { 'image/webp': ['.webp'] } },
        ],
      });
    }
    const blob = await encodeFor(h.name);
    const w = await h.createWritable();
    await w.write(blob);
    await w.close();
    hist.markSaved(savedAt);
    Object.assign(S, { fileHandle: h, fileName: h.name });
    updateChrome();
    flash('Saved ' + h.name);
  } catch (err) {
    if (err.name !== 'AbortError') flash('Save failed: ' + errText(err, 'permission was denied'), true);
  }
}

export { cantOpen, confirmDiscard, decodeFile, isDirty, loadFile, openFile, save, tooBigToOpen };
