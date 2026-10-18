import { $ } from './dom.js';

// ---------- toast ----------
let msgTimer = 0;
const toastX = document.createElement('button');
toastX.className = 'toast-x';
toastX.tabIndex = -1; // the toast is aria-hidden (live regions announce it); this is a pointer convenience
toastX.innerHTML = '<svg><use href="#i-x"/></svg>';
toastX.addEventListener('click', () => { clearTimeout(msgTimer); $('#toast').classList.remove('show'); });
// Errors and toasts with a button stay while the pointer is over them, so they can be read to the end.
const lingers = () => $('#toast').classList.contains('error') || $('#toast').classList.contains('act');
$('#toast').addEventListener('pointerenter', () => { if (lingers()) clearTimeout(msgTimer); });
$('#toast').addEventListener('pointerleave', () => {
  if (!lingers() || !$('#toast').classList.contains('show')) return;
  clearTimeout(msgTimer);
  msgTimer = setTimeout(() => $('#toast').classList.remove('show'), 2500);
});
// Plain words for the errors people actually hit; anything else keeps the browser's own message.
const errText = (err, denied) => (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError') ? denied
  : err && err.name === 'InvalidStateError' ? 'the file is busy or was changed elsewhere'
  : (err && err.message) || 'unknown error');
// Screen readers only (the polite live region), for changes the eye sees on the canvas.
function announce(msg) {
  const live = $('#srStatus');
  live.textContent = '';
  setTimeout(() => { live.textContent = msg; }, 50);
}
// action: {label, run}, a button in the toast (a pointer convenience, like the ×).
function flash(msg, isError, action) {
  const t = $('#toast');
  t.textContent = msg;
  if (action) {
    const b = document.createElement('button');
    b.className = 'toast-act';
    b.tabIndex = -1;
    b.textContent = action.label;
    b.addEventListener('click', () => { clearTimeout(msgTimer); t.classList.remove('show'); action.run(); });
    t.appendChild(b);
  }
  if (isError) t.appendChild(toastX);
  // Screen readers: errors are assertive; clear first so a repeated message is announced again.
  const live = $(isError ? '#srAlert' : '#srStatus');
  live.textContent = '';
  setTimeout(() => { live.textContent = msg; }, 50);
  t.classList.toggle('error', !!isError);
  t.classList.toggle('act', !!action);
  t.classList.add('show');
  clearTimeout(msgTimer);
  msgTimer = setTimeout(() => t.classList.remove('show'), action ? 8000 : isError ? 5000 : 2200);
}

export { announce, errText, flash, msgTimer };
