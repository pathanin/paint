import { bctx as ctx } from './doc.js';
import { $, stage, textBox } from './dom.js';
import { S } from './state.js';
import { beginOp, endOp, touch } from './tiles.js';
import { updateChrome } from './view.js';

// ---------- text ----------
let textAt = null; // {x, y, color} while the text box is open
function placeTextBox() {
  Object.assign(textBox.style, {
    left: textAt.x * S.zoom + 'px',
    top: textAt.y * S.zoom + 'px',
    fontSize: S.fontSize * S.zoom + 'px',
    fontFamily: S.font,
    color: textAt.color,
  });
}
function startText(p, color) {
  textAt = { x: p.x, y: p.y, color };
  textBox.value = '';
  textBox.hidden = false;
  placeTextBox();
  textBox.focus(); // the overlay's mousedown default is suppressed, so focus sticks immediately
  $('#stHint').hidden = false;
  $('#stIntro').hidden = true;
}
// Image px from the top of a text line to its baseline, where the editor's CSS line box puts it.
// Measured by the browser's own layout at the editor's size (a zero-height inline-block sits on
// the baseline): computing it from canvas font metrics was off by an image px on Linux, where
// layout rounds the font's ascent and descent at each size. Below 100% it's measured at 100%, so
// a CSS px of rounding isn't magnified into several image px.
function textBaseline(fs) {
  const k = Math.max(S.zoom, 1);
  const probe = document.createElement('div'), dot = document.createElement('span');
  Object.assign(probe.style, { position: 'absolute', visibility: 'hidden', whiteSpace: 'pre', lineHeight: '1.2', fontSize: fs * k + 'px', fontFamily: S.font });
  Object.assign(dot.style, { display: 'inline-block', width: '0', height: '0' });
  probe.append('Hg', dot);
  stage.append(probe);
  const y = dot.getBoundingClientRect().top - probe.getBoundingClientRect().top;
  probe.remove();
  return y / k;
}
function commitText() {
  if (!textAt) return;
  const t = textAt; textAt = null;
  textBox.hidden = true;
  $('#stHint').hidden = true;
  $('#stIntro').hidden = !S.pristine;
  const lines = textBox.value.split('\n');
  textBox.value = '';
  if (!lines.join('').trim()) return;
  const fs = S.fontSize, lh = fs * 1.2;
  const base = textBaseline(fs);
  beginOp();
  ctx.save();
  ctx.font = `${fs}px ${S.font}`;
  ctx.fillStyle = t.color;
  ctx.textBaseline = 'alphabetic';
  const w = lines.reduce((m, ln) => Math.max(m, ctx.measureText(ln).width), 0); // not Math.max(...): huge pastes overflow the stack
  touch(t.x - fs / 2, t.y - fs / 2, w + fs, lines.length * lh + fs);
  lines.forEach((ln, i) => ctx.fillText(ln, t.x, t.y + i * lh + base));
  ctx.restore();
  endOp();
}
function cancelText() {
  textAt = null;
  textBox.hidden = true;
  $('#stHint').hidden = true;
  $('#stIntro').hidden = !S.pristine;
  textBox.value = '';
}

textBox.addEventListener('input', updateChrome);

export { cancelText, commitText, placeTextBox, startText, textAt };
