import Core from './core.js';
import { img, newDoc } from './doc.js';
import { $ } from './dom.js';
import { confirmDiscard } from './fileio.js';
import { MAX_DIM, MAX_PIXELS, S, sizeProblem } from './state.js';
import { commitText } from './text.js';
import { resizeDoc } from './transforms.js';

// ---------- dialogs ----------
// Dialog validation: message in an alert region, the bad field marked and focused.
function fieldError(note, field, msg) {
  $(note).textContent = msg;
  const f = $(field);
  f.setAttribute('aria-invalid', 'true');
  f.setAttribute('aria-describedby', note.slice(1));
  f.focus();
  f.select();
}
// The size field the user typed in last (an area error belongs to the one they just changed).
let lastSizeField = null;
document.addEventListener('input', (e) => { if (/^(newW|newH|rW|rH)$/.test(e.target.id)) lastSizeField = '#' + e.target.id; });
const lastEdited = (a, b) => (lastSizeField === a || lastSizeField === b ? lastSizeField : b);
function clearFieldErrors(note) {
  $(note).textContent = '';
  $(note).closest('form').querySelectorAll('[aria-invalid]').forEach((f) => f.removeAttribute('aria-invalid'));
}
function openNewDialog() {
  commitText(); // a text box left behind a modal would lose its focus and go dead
  if (!confirmDiscard()) return;
  clearFieldErrors('#newNote');
  $('#newW').value = img.width;
  $('#newH').value = img.height;
  $('#newDlg').showModal();
  $('#newW').select();
}
// Apply on submit (synchronous), not 'close' (async): a fast follow-up action must see the result.
$('#newDlg form').addEventListener('submit', (e) => {
  if (!e.submitter || e.submitter.value !== 'ok') return;
  const w = Math.round(+$('#newW').value), h = Math.round(+$('#newH').value);
  const err = Core.sizeError(w, h, MAX_DIM, MAX_PIXELS);
  if (err) {
    e.preventDefault();
    fieldError('#newNote', err.field ? '#new' + err.field.toUpperCase() : lastEdited('#newW', '#newH'),
      err.reason === 'range' ? `Width and height must be between 1 and ${MAX_DIM} px.` : `Too large: ${sizeProblem(w, h)}.`);
    return;
  }
  newDoc(w, h);
  S.pristine = false; // the user chose this size: a paste goes onto it, not in place of it
});

const rForm = $('#resizeDlg form');
function resizeMode() { return rForm.rmode.value; }
function openResize(mode) {
  commitText();
  rForm.rmode.value = mode === 'canvas' ? 'canvas' : 'scale';
  $('#rLock').checked = mode !== 'canvas'; // adding canvas space usually means growing one side
  $('#rUnit').value = 'px';
  $('#rW').value = img.width;
  $('#rH').value = img.height;
  syncResizeMode();
  syncUnitLabels();
  $('#resizeDlg').showModal();
  $('#rW').select();
}
function syncResizeMode() {
  const canvas = resizeMode() === 'canvas';
  $('#rAnchor').disabled = !canvas;
  $('#resizeTitle').textContent = canvas ? 'Canvas size' : 'Resize image';
  $('#rNote').textContent = canvas ? 'Adds or trims space around the image.' : 'Stretches or shrinks the whole image.';
  clearFieldErrors('#rErr');
}
function syncUnitLabels() {
  document.querySelectorAll('.rUnitLbl').forEach((u) => { u.textContent = $('#rUnit').value === 'pct' ? '%' : 'px'; });
}
function syncResize(changed) {
  if (!$('#rLock').checked) return;
  const pct = $('#rUnit').value === 'pct';
  const v = +$(changed === 'w' ? '#rW' : '#rH').value;
  if (!(v > 0)) return;
  if (pct) { $(changed === 'w' ? '#rH' : '#rW').value = v; return; }
  const d = Core.fitDims(img.width, img.height, changed === 'w' ? { w: v, lockAspect: true } : { h: v, lockAspect: true });
  if (changed === 'w') $('#rH').value = d.h; else $('#rW').value = d.w;
}
$('#rW').addEventListener('input', () => { syncResize('w'); syncResizeMode(); });
['#newW', '#newH'].forEach((id) => $(id).addEventListener('input', () => clearFieldErrors('#newNote')));
$('#rH').addEventListener('input', () => { syncResize('h'); syncResizeMode(); });
$('#rUnit').addEventListener('change', () => {
  const pct = $('#rUnit').value === 'pct';
  $('#rW').value = pct ? 100 : img.width;
  $('#rH').value = pct ? 100 : img.height;
  syncUnitLabels();
});
rForm.addEventListener('change', (e) => { if (e.target.name === 'rmode') syncResizeMode(); });
document.querySelectorAll('dialog [data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
rForm.addEventListener('submit', (e) => {
  if (!e.submitter || e.submitter.value !== 'ok') return;
  let w = +$('#rW').value, h = +$('#rH').value;
  if ($('#rUnit').value === 'pct') {
    w = Math.max(1, Math.round(img.width * w / 100));
    h = Math.max(1, Math.round(img.height * h / 100));
  }
  w = Math.round(w); h = Math.round(h);
  const err = Core.sizeError(w, h, MAX_DIM, MAX_PIXELS);
  if (err) {
    e.preventDefault();
    fieldError('#rErr', err.field ? '#r' + err.field.toUpperCase() : lastEdited('#rW', '#rH'),
      err.reason === 'range'
        ? `Width and height must be between 1 and ${MAX_DIM} px` + (w >= 1 && h >= 1 ? ` (this would be ${w} × ${h} px).` : '.')
        : `Too large: ${sizeProblem(w, h)}.`);
    return;
  }
  resizeDoc(w, h, resizeMode(), rForm.anchor.value);
});

// Anchor grid: Up/Down move between rows (radios alone would step through the DOM order).
$('.anchor').addEventListener('keydown', (e) => {
  const d = { ArrowUp: -3, ArrowDown: 3 }[e.key];
  if (!d) return;
  const cells = [...document.querySelectorAll('input[name=anchor]')];
  const i = cells.indexOf(document.activeElement) + d;
  e.preventDefault();
  if (i >= 0 && i < 9) { cells[i].checked = true; cells[i].focus(); }
});

export { openNewDialog, openResize };
