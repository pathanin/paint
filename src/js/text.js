import { bctx as ctx } from './doc.js';
import { addObj, objs, setObjs, showObjs } from './objects.js';
import { $, stage, textBox } from './dom.js';
import { S } from './state.js';
import { updateChrome } from './view.js';

// ---------- text ----------
let textAt = null; // {x, y, color, m?} while the text box is open
// The box sits at the text's origin; a text that was turned, flipped or scaled (m, about its origin)
// is edited in a box with the same transform, so it reads as it will be drawn.
function placeTextBox() {
  const m = textAt.m;
  Object.assign(textBox.style, {
    left: textAt.x * S.zoom + 'px',
    top: textAt.y * S.zoom + 'px',
    fontSize: S.fontSize * S.zoom + 'px',
    fontFamily: S.font,
    color: textAt.color,
    transform: m ? `matrix(${m.join(', ')}, 0, 0)` : '',
    transformOrigin: m ? '0 0' : '',
  });
}
// o: a text object to edit again (the text tool clicked it). It is hidden while the box is open, and
// committing replaces it in one undo step, keeping its transform.
function startText(p, color, o) {
  textAt = { x: p.x, y: p.y, color, o: null };
  textBox.value = '';
  if (o) {
    textAt = { x: o.x, y: o.y, color: o.color, o, m: o.m, before: objs };
    S.font = o.font; S.fontSize = o.fs;
    const f = $('#font'), fs = $('#fontSize');
    if (f) f.value = o.font;
    if (fs) fs.value = o.fs;
    textBox.value = o.lines.join('\n');
    showObjs(objs.filter((x) => x !== o));
  }
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
  const empty = !lines.join('').trim();
  if (t.o) showObjs(t.before); // put the edited one back, so the change below is one diff from it
  if (empty) { if (t.o) setObjs(objs.filter((x) => x.id !== t.o.id)); return; }
  const fs = S.fontSize;
  ctx.save();
  ctx.font = `${fs}px ${S.font}`;
  const w = lines.reduce((m, ln) => Math.max(m, ctx.measureText(ln).width), 0); // not Math.max(...): huge pastes overflow the stack
  ctx.restore();
  // The baseline is measured now and kept, so a repaint at another zoom draws the text in place.
  const o = { t: 'text', x: t.x, y: t.y, lines, font: S.font, fs, color: t.color, base: textBaseline(fs), w };
  if (t.o) setObjs(objs.map((x) => (x.id === t.o.id ? { ...o, id: t.o.id, z: t.o.z, ...(t.o.m && { m: t.o.m }) } : x)));
  else addObj(o, { keepSel: true }); // on top, as a text object (docs/objects.md, item 9)
}
function cancelText() {
  if (textAt && textAt.o) showObjs(textAt.before);
  textAt = null;
  textBox.hidden = true;
  $('#stHint').hidden = true;
  $('#stIntro').hidden = !S.pristine;
  textBox.value = '';
}

textBox.addEventListener('input', updateChrome);

export { cancelText, commitText, placeTextBox, startText, textAt };
