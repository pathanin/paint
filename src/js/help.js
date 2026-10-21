import { $, keyLabel } from './dom.js';
import { commitText } from './text.js';

// ---------- help ----------
const HELP_COL = { Tools: 0, View: 0, Edit: 1, File: 1, Image: 1, Drawing: 2, Objects: 2 }; // ~17 rows per column
const HELP = [
  ['Tools', [['Move, box-select objects', 'V'], ['Select', 'S'], ['Pencil', 'P'], ['Brush', 'B'], ['Eraser', 'E'], ['Fill', 'F'], ['Color picker', 'I'],
    ['Text', 'T'], ['Line', 'L'], ['Rectangle', 'R'], ['Ellipse', 'O']]],
  ['Edit', [['Undo', '⌘Z'], ['Redo', '⌘⇧Z', '⌘Y'], ['Select all', '⌘A'], ['Deselect / dismiss error', 'Esc'], ['Cancel shape, selection or move drag', 'Esc'], ['Clear selection to color 2', 'Delete', '⌫'],
    ['Nudge selection (⇧ = 10px)', '←', '↑', '→', '↓'], ['Copy, cut, paste', '⌘C', '⌘X', '⌘V'], ['Crop to selection', '⌘⇧X']]],
  ['Drawing', [['Draw with color 1 / color 2', '~Left / right click'], ['Swap colors', 'X'], ['Smaller / bigger size', '[', ']'],
    ['Square, circle, 45° line', '⇧', '~drag'], ['Pick color 2 from a swatch', '~right-click / ⇧-click'],
    ['Apply text', 'Enter'], ['New line in text', '⇧Enter'], ['Cancel text', 'Esc']]],
  ['Objects', [['Next / previous object (Move tool)', 'Tab', '⇧Tab'], ['Duplicate', '⌘D'], ['Duplicate by dragging', 'Alt', '~drag'], ['Add to / take from the selection', '⇧', '~click'], ['Move straight, keep proportions', '⇧', '~drag'], ['Move or resize without snapping', '⌘', '~drag'],
    ['Forward / backward, to front / back', '⌘]', '⌘[', '⌘⇧]', '⌘⇧['], ['Flatten (with Move: just the selection)', '⌘E'], ['Delete what the Eraser crosses', 'Alt', '~drag'], ['Delete', 'Delete', '⌫'], ['Nudge (⇧ = 10px)', '←', '↑', '→', '↓']]],
  ['Image', [['Resize image', '⇧R'], ['Canvas size', '⇧C'], ['Canvas: keep aspect', '⇧', '~drag corner'], ['Cancel canvas drag', 'Esc']]],
  ['File', [['New', 'Alt+N'], ['Open', '⌘O'], ['Save', '⌘S'], ['Save as', '⌘⇧S']]],
  ['View', [['Zoom in / out', '+', '−', '⌘+', '⌘−'], ['Zoom at pointer', '⌘', '~scroll'], ['Fit to window', '⇧1', '⌘0'], ['Actual size', '⇧0'],
    ['Pan', 'Space', '~drag / middle-drag'], ['This list', '?']]],
];
function openHelp() {
  commitText();
  const body = $('#helpBody');
  if (!body.firstChild) {
    const cols = [0, 1, 2].map(() => document.createElement('div'));
    body.append(...cols);
    HELP.forEach(([title, rows], i) => {
      const sec = document.createElement('section');
      const h = document.createElement('h3');
      h.textContent = title;
      sec.appendChild(h);
      for (const [label, ...keys] of rows) {
        const row = document.createElement('div');
        row.className = 'row';
        const l = document.createElement('span');
        l.textContent = keyLabel(label);
        const k = document.createElement('span');
        k.className = 'keys';
        for (const key of keys) {
          const el = document.createElement(key[0] === '~' ? 'span' : 'kbd');
          el.textContent = key[0] === '~' ? keyLabel(key.slice(1)) : keyLabel(key);
          k.appendChild(el);
        }
        row.append(l, k);
        sec.appendChild(row);
      }
      cols[HELP_COL[title]].appendChild(sec);
    });
  }
  $('#helpDlg').showModal();
}

export { openHelp };
