import { $, clamp, keyLabel, stage } from './dom.js';
import { S, drag } from './state.js';
import { pal } from './toolbar.js';

// ---------- tooltips ----------
const tip = $('#tip');
let tipTimer = 0, tipWarmUntil = 0, tipFor = null, tipByKey = false;
function showTip(el, fade) {
  tipFor = el;
  tip.classList.toggle('fade', !!fade);
  tip.textContent = el.dataset.tip;
  if (el.dataset.kbd) {
    const k = document.createElement('kbd');
    k.textContent = keyLabel(el.dataset.kbd);
    tip.appendChild(k);
  }
  if (el.dataset.hint) {
    const h = document.createElement('span');
    h.className = 'hint';
    h.textContent = keyLabel(el.dataset.hint);
    tip.appendChild(h);
  }
  tip.hidden = false;
  const r = el.getBoundingClientRect(), t = tip.getBoundingClientRect();
  const side = el.closest('#rail');
  // Palette: below the whole palette, so a tip never hides the other row of swatches.
  const bottom = el.parentElement === pal ? pal.getBoundingClientRect().bottom : r.bottom;
  let x = side ? r.right + 8 : r.left + r.width / 2 - t.width / 2;
  let y = side ? r.top + r.height / 2 - t.height / 2 : bottom + 6;
  x = clamp(x, 6, innerWidth - t.width - 6);
  y = clamp(y, 6, innerHeight - t.height - 6);
  tip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
}
function hideTip() {
  clearTimeout(tipTimer);
  if (!tip.hidden) tipWarmUntil = performance.now() + 400;
  tip.hidden = true;
  tipFor = null;
}
document.addEventListener('pointerover', (e) => {
  const el = e.target.closest('.chrome [data-tip]');
  if (el === tipFor) return;
  hideTip();
  if (!el || e.pointerType === 'touch' || drag) return;
  const warm = performance.now() < tipWarmUntil;
  tipTimer = setTimeout(() => { showTip(el, !warm); tipByKey = false; }, warm ? 0 : 450);
});
document.addEventListener('pointerdown', hideTip, true);
document.documentElement.addEventListener('mouseleave', hideTip);
document.addEventListener('focusin', (e) => {
  const el = e.target.closest && e.target.closest('.chrome [data-tip]');
  if (el && e.target.matches(':focus-visible')) { hideTip(); showTip(el); tipByKey = true; }
});
document.addEventListener('focusout', () => { if (tipFor) hideTip(); });
function resetTransientKeys() {
  hideTip();
  S.panKey = false;
  if (!drag || drag.t !== 'pan') stage.classList.remove('panning');
}
window.addEventListener('blur', resetTransientKeys);
document.addEventListener('visibilitychange', () => { if (document.hidden) resetTransientKeys(); });

export { hideTip, tip, tipByKey };
