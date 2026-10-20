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
// The pixel at (x, y) of canvas src (#image), as RGBA bytes. It is copied into a new 1 px canvas and
// read there: getImageData on #image itself held the next frame for ~250 ms at 10000², and copying
// into a CPU canvas (willReadFrequently, or one Chrome moved to the CPU after a few reads, so the
// canvas isn't reused) reads the whole source back (~95 ms).
function pixelAt(src, x, y) {
  const g = makeCanvas(1, 1).getContext('2d');
  g.drawImage(src, x, y, 1, 1, 0, 0, 1, 1);
  return g.getImageData(0, 0, 1, 1).data;
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

export { $, antsEl, clamp, cloneCanvas, hexToU32, keyLabel, MAC, makeCanvas, ov, pixelAt, ring, setAttr, setData, setProp, setText, stage, textBox, toHex, vp };
