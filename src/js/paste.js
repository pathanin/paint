import { pasteImage } from './clipboard.js';
import { $ } from './dom.js';
import { cantOpen, confirmDiscard, decodeFile, docMark, isDirty, loadFile, takeInputSeen, tooBigToOpen } from './fileio.js';
import { docLanded, requestDoc } from './doc.js';
import { isTyping } from './keyboard.js';
import { errText, flash } from './toast.js';
import { updateStatus } from './view.js';

// ---------- paste / drop / unload ----------
const modalOpen = () => !!document.querySelector('dialog[open]');
const isImage = (t) => t.startsWith('image/');
// The pasted image file; undefined when an image is listed but the event won't hand it over
// (Safari lists one written by the async Clipboard API, but its getAsFile() is null); null when
// there is none.
function clipboardImage(dt) {
  if (!dt) return null;
  const file = [...dt.files].find((f) => isImage(f.type))
    || [...dt.items].filter((i) => i.kind === 'file' && isImage(i.type)).map((i) => i.getAsFile()).find(Boolean);
  if (file) return file;
  return [...dt.items].some((i) => isImage(i.type)) || dt.types.some(isImage) ? undefined : null;
}
async function readClipboardImage() {
  if (!navigator.clipboard || !navigator.clipboard.read) throw new Error('the clipboard image couldn’t be read');
  for (const it of await navigator.clipboard.read()) {
    const t = it.types.find(isImage);
    if (t) return it.getType(t);
  }
  throw new Error('the clipboard image couldn’t be read');
}
window.addEventListener('paste', async (e) => {
  if (isTyping(e.target) || modalOpen()) return;
  const file = clipboardImage(e.clipboardData);
  if (file === null) { flash('No image on the clipboard'); return; }
  e.preventDefault();
  try {
    const bmp = await createImageBitmap(file || await readClipboardImage());
    pasteImage(bmp);
    bmp.close();
  } catch (err) {
    flash('Paste failed: ' + errText(err, 'the clipboard image couldn’t be read'), true);
  }
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  if (modalOpen()) return;
  const item = [...e.dataTransfer.items].find((i) => i.kind === 'file');
  if (!item) return;
  // Both must be requested synchronously, before the DataTransfer expires.
  const hp = item.getAsFileSystemHandle ? item.getAsFileSystemHandle() : null;
  const file = item.getAsFile();
  if (!file || (file.type && !file.type.startsWith('image/'))) { flash('Not an image: ' + (file ? file.name : 'file'), true); return; }
  // Its place among Opens and New is taken now, as it arrives: an Open or New asked for while it
  // decodes comes after it (loadFile).
  const turn = requestDoc();
  // Decode before asking to discard, so a file that isn't an image never prompts.
  let bmp;
  try { bmp = await decodeFile(file); }
  catch (err) { if (docLanded <= turn) flash(cantOpen(file, err), true); return; }
  if (docLanded > turn) { bmp.close(); return; } // a later Open, drop or New landed meanwhile: no prompt for this one
  if (tooBigToOpen(file, bmp)) return; // before asking to discard: nothing would replace it
  if (!confirmDiscard()) { bmp.close(); return; }
  const seen = docMark(); // what that discard covered
  let handle = null;
  try { handle = hp ? await hp : null; } catch { handle = null; }
  loadFile(file, handle && handle.kind === 'file' ? handle : null, bmp, turn, seen);
});
$('#fileInput').addEventListener('change', (e) => {
  const f = e.target.files[0];
  if (f) loadFile(f, null, undefined, undefined, takeInputSeen());
  e.target.value = '';
});
window.addEventListener('beforeunload', (e) => {
  if (isDirty()) { e.preventDefault(); e.returnValue = ''; }
});
window.addEventListener('resize', () => updateStatus());

// ---------- drop zone ----------
let dragDepth = 0;
const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
window.addEventListener('dragenter', (e) => { if (hasFiles(e) && !modalOpen()) { dragDepth++; $('#dropZone').hidden = false; } });
window.addEventListener('dragleave', (e) => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; $('#dropZone').hidden = true; } });
window.addEventListener('drop', () => { dragDepth = 0; $('#dropZone').hidden = true; }, true);

export { modalOpen };
