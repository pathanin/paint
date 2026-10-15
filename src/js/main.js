// Every module, in the order of the sections of the old single app.js: most of them only wire up
// listeners when they load, and nothing else imports them. (Imports that form cycles load depth-first,
// so this is only roughly the order the code runs in; nothing at load time depends on it.)
import './dom.js';
import './state.js';
import './toast.js';
import './libs.js';
import './doc.js';
import './tiles.js';
import './view.js';
import './tools.js';
import './fill.js';
import './objects.js';
import './text.js';
import './selection.js';
import './clipboard.js';
import './transforms.js';
import './fileio.js';
import './dialogs.js';
import './handles.js';
import './pointer.js';
import './keyboard.js';
import './paste.js';
import './toolbar.js';
import './tooltips.js';
import './help.js';

import { pasteImage } from './clipboard.js';
import { hist, img, newDoc, redo, undo } from './doc.js';
import { $, MAC, keyLabel } from './dom.js';
import { decodeFile, loadFile, save } from './fileio.js';
import { used } from './libs.js';
import { composite, flattenObjs, objSel, objs } from './objects.js';
import { crop, selectAll } from './selection.js';
import { MAX_PIXELS, S, drag, sel } from './state.js';
import { flushToData, op, pendingParts } from './tiles.js';
import { flash } from './toast.js';
import { setColor, setTool } from './tools.js';
import { resample, resizeDoc, scaleImage, transformDoc } from './transforms.js';
import { fitZoom, setZoom, updateChrome } from './view.js';

// ---------- boot ----------
document.querySelectorAll('[data-hint]').forEach((el) => { if (el.dataset.hint) el.setAttribute('aria-description', keyLabel(el.dataset.hint)); });
// Expose shortcuts to assistive tech (aria-keyshortcuts uses Control/Meta/Shift names).
document.querySelectorAll('[data-kbd]').forEach((el) => {
  const k = el.dataset.kbd;
  if (/\s/.test(k)) return;
  el.setAttribute('aria-keyshortcuts', k.replace('⌘', MAC ? 'Meta+' : 'Control+').replace('⇧', 'Shift+').replace('−', 'Minus').replace(/^\+$/, 'Shift+Equal'));
});
// Fade the bottom of the shortcut list while more is hidden below.
const helpBody = $('#helpBody');
const helpFade = () => helpBody.classList.toggle('more', helpBody.scrollTop + helpBody.clientHeight < helpBody.scrollHeight - 2);
helpBody.addEventListener('scroll', helpFade);
$('#helpDlg').addEventListener('toggle', helpFade);
window.addEventListener('resize', helpFade);
setColor('primary', S.primary);
setColor('secondary', S.secondary);
$('#stIntro').textContent = `Draw, or drop or paste an image · ${keyLabel('⌘O')} opens a file`;
newDoc(800, 600);
setTool('pencil');

// Handle for scripted smoke tests in the console.
window.__paint = { S, hist, used, decodeFile, scaleImage, resample, get img() { return img; }, newDoc, flash, save, updateChrome, get drag() { return drag; }, get sel() { return sel; }, setTool, undo, redo, crop, resizeDoc, transformDoc, selectAll, pasteImage, loadFile, setZoom, fitZoom, MAX_PIXELS, flushToData, get op() { return op; }, get objs() { return objs; }, get objSel() { return objSel; }, flattenObjs, composite, get pendingParts() { return [...pendingParts].filter((p) => p.cv).length; } };
