import { pasteImage } from './clipboard.js';
import { $ } from './dom.js';
import { cantOpen, confirmDiscard, decodeFile, isDirty, loadFile, tooBigToOpen } from './fileio.js';
import { isTyping } from './keyboard.js';
import { errText, flash } from './toast.js';
import { updateStatus } from './view.js';

// ---------- paste / drop / unload ----------
const modalOpen = () => !!document.querySelector('dialog[open]');
window.addEventListener('paste', async (e) => {
  if (isTyping(e.target) || modalOpen()) return;
  const item = [...(e.clipboardData ? e.clipboardData.items : [])].find((i) => i.type.startsWith('image/'));
  if (!item) { flash('No image on the clipboard'); return; }
  e.preventDefault();
  try {
    const bmp = await createImageBitmap(item.getAsFile());
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
  // Decode before asking to discard, so a file that isn't an image never prompts.
  let bmp;
  try { bmp = await decodeFile(file); }
  catch (err) { flash(cantOpen(file, err), true); return; }
  if (tooBigToOpen(file, bmp)) return; // before asking to discard: nothing would replace it
  if (!confirmDiscard()) { bmp.close(); return; }
  let handle = null;
  try { handle = hp ? await hp : null; } catch { handle = null; }
  loadFile(file, handle && handle.kind === 'file' ? handle : null, bmp);
});
$('#fileInput').addEventListener('change', (e) => {
  const f = e.target.files[0];
  if (f) loadFile(f, null);
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
