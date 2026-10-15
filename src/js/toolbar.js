import { openNewDialog, openResize } from './dialogs.js';
import { redo, undo } from './doc.js';
import { $, clamp, textBox } from './dom.js';
import { openFile, save } from './fileio.js';
import { openHelp } from './help.js';
import { restyleObj, selObj } from './objects.js';
import { crop } from './selection.js';
import { PALETTE, S, sel } from './state.js';
import { commitText, placeTextBox, textAt } from './text.js';
import { setColor, setSize, setTool } from './tools.js';
import { hideTip } from './tooltips.js';
import { transformDoc } from './transforms.js';
import { fitZoom, setZoom, zoomStep } from './view.js';

// ---------- toolbar wiring ----------
function swapColors() {
  const p = S.primary;
  setColor('primary', S.secondary, false); setColor('secondary', p, false);
  restyleObj({ color: S.primary, alt: S.secondary }); // one step
}
const CMDS = {
  new: openNewDialog, open: openFile, save: () => save(false), saveAs: () => save(true),
  undo, redo, crop, resize: () => openResize('scale'), canvasSize: () => openResize('canvas'),
  rotL: () => transformDoc('rotL'), rotR: () => transformDoc('rotR'),
  flipH: () => transformDoc('flipH'), flipV: () => transformDoc('flipV'),
  zoomIn: () => zoomStep(1), zoomOut: () => zoomStep(-1),
  fit: () => fitZoom(false), zoom100: () => setZoom(1),
  help: openHelp, swap: swapColors,
};
document.addEventListener('click', (e) => {
  const b = e.target.closest('.chrome button');
  if (!b) return;
  hideTip();
  if (b.dataset.cmd) CMDS[b.dataset.cmd]();
  else if (b.dataset.tool) setTool(b.dataset.tool);
  // After a mouse click, hand focus back so single-key shortcuts (and Space-to-pan) work.
  // Keyboard activation (detail 0) keeps focus on the button so Tab order isn't lost.
  if (e.detail > 0) releaseFocus(b);
  else if (b.disabled) focusNeighbor(b); // e.g. Undo at the start of history
});
function focusNeighbor(b) {
  const all = [...b.closest('[role=toolbar]').querySelectorAll('button')];
  const i = all.indexOf(b);
  const next = all.slice(i + 1).concat(all.slice(0, i).reverse()).find((x) => !x.disabled && x.offsetParent !== null);
  if (next) next.focus();
}
// Range, radio and select fire 'change' on every arrow key, so only hand focus back after mouse use.
let pointerUsed = false;
document.addEventListener('pointerdown', () => { pointerUsed = true; }, true);
document.addEventListener('keydown', () => { pointerUsed = false; }, true);
document.addEventListener('change', (e) => {
  if (pointerUsed && e.target.closest('.chrome') && e.target.type !== 'number') releaseFocus(e.target);
});
function releaseFocus(el) {
  el.blur();
  if (textAt) textBox.focus(); // still typing: go back to the text
}
document.querySelectorAll('.chrome input[type=number]').forEach((i) => i.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && textAt) { i.blur(); commitText(); }
  else if (e.key === 'Enter' || e.key === 'Escape') releaseFocus(i);
}));

$('#size').addEventListener('input', (e) => setSize(+e.target.value));
$('#size').addEventListener('change', () => restyleObj({ size: S.sizes[S.tool] }, 'size')); // on release; arrow keys coalesce
$('#tolerance').addEventListener('input', (e) => { S.tolerance = +e.target.value; $('#tolOut').textContent = S.tolerance; });
$('#smoothing').addEventListener('input', (e) => { S.smoothing = +e.target.value; $('#smoothOut').textContent = S.smoothing; });
document.querySelectorAll('input[name=fillMode]').forEach((r) => r.addEventListener('change', () => { S.fillMode = r.value; const o = selObj(); if (o && o.t !== 'line') restyleObj({ mode: r.value }); }));
$('#font').addEventListener('change', (e) => { S.font = e.target.value; if (textAt) placeTextBox(); });
$('#fontSize').addEventListener('input', (e) => {
  const v = +e.target.value;
  if (v >= 1) { S.fontSize = clamp(Math.round(v), 6, 400); if (textAt) placeTextBox(); }
});
$('#fontSize').addEventListener('change', (e) => { e.target.value = S.fontSize; });
$('#primary').addEventListener('input', (e) => { setColor('primary', e.target.value, 'well1'); });
$('#secondary').addEventListener('input', (e) => { setColor('secondary', e.target.value, 'well2'); });

const pal = $('#palette');
for (const [c, name] of PALETTE) {
  const b = document.createElement('button');
  b.style.setProperty('--c', c);
  b.dataset.color = c;
  b.dataset.name = b.dataset.tip = name;
  b.dataset.hint = 'Right-click or Shift-click for color 2';
  b.setAttribute('aria-label', name);
  pal.appendChild(b);
}
pal.addEventListener('click', (e) => {
  if (e.target.dataset.color) setColor(e.shiftKey ? 'secondary' : 'primary', e.target.dataset.color);
});
pal.addEventListener('contextmenu', (e) => {
  if (!e.target.dataset.color) return;
  e.preventDefault();
  setColor('secondary', e.target.dataset.color);
});
pal.addEventListener('keydown', (e) => {
  if (e.target.dataset.color && e.shiftKey && (e.key === 'Enter' || e.code === 'Space')) {
    e.preventDefault();
    e.stopPropagation();
    setColor('secondary', e.target.dataset.color);
  }
});

// ---------- roving focus: one Tab stop per toolbar, arrow keys inside ----------
function rove(box, sel, keys) {
  const items = () => [...box.querySelectorAll(sel)].filter((b) => !b.disabled && b.offsetParent !== null);
  box.addEventListener('keydown', (e) => {
    const list = items(), i = list.indexOf(document.activeElement);
    if (i < 0) return;
    const d = e.key === 'Home' ? -Infinity : e.key === 'End' ? Infinity : keys[e.key];
    if (d == null) return;
    e.preventDefault();
    e.stopPropagation(); // arrows would otherwise nudge the selection
    list[clamp(i + d, 0, list.length - 1)].focus();
  });
  box.addEventListener('focusin', (e) => {
    if (!e.target.matches(sel)) return;
    box.querySelectorAll(sel).forEach((b) => { b.tabIndex = b === e.target ? 0 : -1; });
  });
  const fix = () => {
    const all = [...box.querySelectorAll(sel)];
    const cur = all.find((b) => b.tabIndex === 0);
    if (cur && !cur.disabled && cur.offsetParent !== null) return;
    const next = items()[0];
    all.forEach((b) => { b.tabIndex = b === next ? 0 : -1; });
  };
  fix();
  return fix;
}
const fixTopbar = rove($('#topbar'), 'button', { ArrowLeft: -1, ArrowRight: 1 });
rove($('#rail'), 'button', { ArrowUp: -1, ArrowDown: 1 });
rove(pal, 'button', { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -10, ArrowDown: 10 });
new MutationObserver(fixTopbar).observe($('#topbar'), { subtree: true, attributeFilter: ['disabled'] });
window.addEventListener('resize', fixTopbar);

export { pal, swapColors };
