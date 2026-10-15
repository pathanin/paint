import Core from './core.js';
import { copySel } from './clipboard.js';
import { openNewDialog, openResize } from './dialogs.js';
import { redo, undo } from './doc.js';
import { $, ring, stage, textBox } from './dom.js';
import { openFile, save } from './fileio.js';
import { openHelp } from './help.js';
import { deleteObj, duplicateObj, flattenObjs, nudgeObj, objSel, objs, reorderObj, restyleObj, selObj, selectObj } from './objects.js';
import { modalOpen } from './paste.js';
import { cancelDrag } from './pointer.js';
import { crop, deleteSelection, dropSelection, nudge, selectAll } from './selection.js';
import { S, SHAPES, TOOL_KEYS, drag, sel } from './state.js';
import { cancelText, commitText } from './text.js';
import { msgTimer } from './toast.js';
import { swapColors } from './toolbar.js';
import { setSize, setTool } from './tools.js';
import { hideTip, tip, tipByKey } from './tooltips.js';
import { fitZoom, requestRender, setZoom, zoomStep } from './view.js';

// ---------- keyboard ----------
const TYPING_INPUTS = new Set(['text', 'number', 'search', 'email', 'url', 'password']);
function isTyping(t) {
  if (!t || !t.tagName) return false;
  return t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable ||
    (t.tagName === 'INPUT' && TYPING_INPUTS.has(t.type));
}
textBox.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.isComposing || e.keyCode === 229) return; // IME is using Enter/Esc to pick a candidate
  if (e.key === 'Escape') { e.preventDefault(); cancelText(); }
  else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitText(); }
});
textBox.addEventListener('blur', (e) => {
  // Picking a font, size or color in the toolbars restyles the open text instead of committing it.
  if (e.relatedTarget && e.relatedTarget.closest('.chrome')) return; // toolbar commands commit it themselves when needed
  commitText();
});

// Shortcuts follow the characters on the user's layout (AZERTY, Dvorak, German "+"), so the keys
// match the labels. Non-Latin layouts fall back to the physical letter key; digits stay physical.
const PUNCT = { '[': 'BracketLeft', ']': 'BracketRight', '+': 'Equal', '=': 'Equal', '-': 'Minus', '_': 'Minus' };
function keyId(e) {
  if (/^[a-z]$/i.test(e.key)) return 'Key' + e.key.toUpperCase();
  if (PUNCT[e.key]) return PUNCT[e.key];
  if (/^Digit\d$/.test(e.code)) return e.code;
  if (e.key.length === 1 && e.code !== 'Space') return /^Key[A-Z]$/.test(e.code) && e.key.charCodeAt(0) > 127 ? e.code : '';
  return e.code;
}
// Esc dismisses a visible error toast first (keyboard path for its ×). Capture phase, so the text box
// doesn't also cancel (and lose its text) on the same press. Not while a modal is open: the dialog sits
// above the toast and Esc belongs to it. Mid-drag Esc still cancels the drag.
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || drag || modalOpen() || !$('#toast').classList.contains('error') || !$('#toast').classList.contains('show')) return;
  if (!tip.hidden && tipByKey) return; // a keyboard-focus tooltip takes the first Esc (handled below)
  clearTimeout(msgTimer); $('#toast').classList.remove('show');
  e.preventDefault(); e.stopImmediatePropagation();
}, true);
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !tip.hidden) {
    const fromKeyboard = tipByKey;
    hideTip();
    if (fromKeyboard) { e.preventDefault(); return; } // first Esc dismisses a focus tooltip (WCAG 1.4.13)
  }
  if (document.querySelector('dialog[open]') || isTyping(e.target)) return;
  if (drag) { // mid-gesture, only Esc (cancel) applies; other keys would pull state out from under it
    if (e.key === 'Escape') cancelDrag();
    else if (e.key === 'Shift' && SHAPES.has(drag.t)) { drag.shift = true; requestRender(); }
    if (e.code !== 'Space') e.preventDefault();
    return;
  }
  // Space/Enter on a focused control activate it (keyboard users); they are not shortcuts there.
  if ((e.code === 'Space' || e.key === 'Enter') && e.target.closest && e.target.closest('button, input, select')) return;
  const mod = e.metaKey || e.ctrlKey;
  const k = keyId(e);
  if (mod) {
    if (e.repeat && !['KeyZ', 'KeyY', 'Equal', 'Minus'].includes(k)) { e.preventDefault(); return; }
    const act = {
      KeyZ: () => (e.shiftKey ? redo() : undo()),
      KeyY: redo,
      KeyS: () => save(e.shiftKey),
      KeyO: openFile,
      KeyA: selectAll,
      KeyC: () => copySel(false),
      KeyX: () => (e.shiftKey ? crop() : copySel(true)),
      Digit0: () => fitZoom(false),
      // Only with objects to act on; otherwise the browser keeps ⌘D (bookmark) and ⌘[ ⌘] (back, forward).
      KeyD: selObj() && duplicateObj,
      KeyE: objs.length && flattenObjs,
      BracketRight: selObj() && (() => reorderObj(1)),
      BracketLeft: selObj() && (() => reorderObj(-1)),
      Equal: () => zoomStep(1),
      Minus: () => zoomStep(-1),
    }[k];
    if (act) { e.preventDefault(); act(); }
    return; // ⌘V falls through to the native paste event
  }
  if (e.altKey) {
    if (k === 'KeyN') { e.preventDefault(); openNewDialog(); }
    return;
  }
  if (e.shiftKey && k === 'KeyR') { e.preventDefault(); openResize('scale'); return; }
  if (e.shiftKey && k === 'KeyC') { e.preventDefault(); openResize('canvas'); return; }
  if (e.key === '?') { openHelp(); return; }
  if (e.shiftKey && k === 'Digit0') { setZoom(1); return; }
  if (e.shiftKey && k === 'Digit1') { fitZoom(false); return; }
  if (TOOL_KEYS[k] && !e.shiftKey) { setTool(TOOL_KEYS[k]); return; }
  const step = e.shiftKey ? 10 : 1;
  const onCanvas = e.target === document.body || (e.target.closest && e.target.closest('#viewport'));
  if (k.startsWith('Arrow') && !onCanvas) return; // arrows on a focused control belong to that control
  switch (k) {
    case 'KeyX': swapColors(); break;
    case 'Delete': case 'Backspace': if (!onCanvas) return; e.preventDefault(); if (!deleteObj()) deleteSelection(); break;
    case 'Escape': if (objSel != null) selectObj(null); else dropSelection(); break;
    case 'BracketLeft': setSize(Core.stepSize(S.sizes[S.tool], -1)); restyleObj(S.sizes[S.tool] != null ? { size: S.sizes[S.tool] } : {}, 'size'); break;
    case 'BracketRight': setSize(Core.stepSize(S.sizes[S.tool], 1)); restyleObj(S.sizes[S.tool] != null ? { size: S.sizes[S.tool] } : {}, 'size'); break;
    case 'Equal': zoomStep(1); break;
    case 'Minus': zoomStep(-1); break;
    case 'Space': e.preventDefault(); S.panKey = true; ring.hidden = true; stage.classList.add('panning'); break;
    case 'ArrowLeft': if (selObj()) { e.preventDefault(); nudgeObj(-step, 0); } else if (sel) { e.preventDefault(); nudge(-step, 0); } break;
    case 'ArrowRight': if (selObj()) { e.preventDefault(); nudgeObj(step, 0); } else if (sel) { e.preventDefault(); nudge(step, 0); } break;
    case 'ArrowUp': if (selObj()) { e.preventDefault(); nudgeObj(0, -step); } else if (sel) { e.preventDefault(); nudge(0, -step); } break;
    case 'ArrowDown': if (selObj()) { e.preventDefault(); nudgeObj(0, step); } else if (sel) { e.preventDefault(); nudge(0, step); } break;
  }
});
window.addEventListener('keyup', (e) => {
  if (e.key === 'Shift' && drag && SHAPES.has(drag.t)) { drag.shift = false; requestRender(); }
  if (e.code === 'Space') { S.panKey = false; if (!drag || drag.t !== 'pan') stage.classList.remove('panning'); }
});

export { isTyping };
