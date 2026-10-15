import Core from './core.js';

// ---------- DOM helpers ----------
const $ = (s) => document.querySelector(s);
const ov = $('#overlay'), stage = $('#stage'), vp = $('#viewport'), textBox = $('#textInput');
const ring = $('#ring'), antsEl = $('#ants');

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}
function cloneCanvas(src) {
  const c = makeCanvas(src.width, src.height);
  c.getContext('2d').drawImage(src, 0, 0);
  return c;
}
const hexToU32 = (c) => Core.colorToU32(c); // '#rrggbb' or transparent (0)
// Write-if-changed DOM setters for paths that run on every pointermove or frame. Rewriting an
// identical value isn't free: textContent replaces the text node (layout), and attribute or
// `disabled` writes queue mutation records (the topbar's MutationObserver then forces a layout).
function setText(el, v) { if (el.textContent !== v) el.textContent = v; }
function setAttr(el, k, v) {
  if (v == null) { if (el.hasAttribute(k)) el.removeAttribute(k); return; }
  v = String(v);
  if (el.getAttribute(k) !== v) el.setAttribute(k, v);
}
function setProp(el, k, v) { if (el[k] !== v) el[k] = v; }
function setData(el, k, v) { if (el.dataset[k] !== v) el.dataset[k] = v; }
const toHex = (r, g, b) => '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Shortcut labels are written Mac-style in the markup; show Ctrl/Shift elsewhere.
const MAC = /Mac|iPhone|iPad/.test(navigator.platform);
const keyLabel = (k) => (MAC ? (k === 'Alt' ? '⌥' : k.replace(/Alt\+/g, '⌥'))
  : k === '⌘' ? 'Ctrl' : k === '⇧' ? 'Shift' : k === '⌫' ? 'Backspace'
  : k.replace(/⌘/g, 'Ctrl+').replace(/⇧([- ])/g, 'Shift$1').replace(/⇧/g, 'Shift+').replace(/\+\+$/, '+Plus').replace(/\+−$/, '+Minus'));

export { $, antsEl, clamp, cloneCanvas, hexToU32, keyLabel, MAC, makeCanvas, ov, ring, setAttr, setData, setProp, setText, stage, textBox, toHex, vp };
