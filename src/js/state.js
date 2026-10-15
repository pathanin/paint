import Core from './core.js';
import { $ } from './dom.js';

// ---------- settings & shared state ----------
const S = {
  tool: 'pencil', prevTool: 'pencil',
  primary: '#000000', secondary: '#ffffff',
  sizes: { pencil: 1, brush: 6, eraser: 12, line: 2, rect: 2, ellipse: 2 },
  fillMode: 'outline', tolerance: 10, smoothing: 2,
  font: 'system-ui, sans-serif', fontSize: 24,
  zoom: 1,
  fileHandle: null, fileName: 'untitled.png',
  pristine: true, panKey: false,
};
// Gesture and selection state, read everywhere. Other modules read these live bindings and change
// them only through the setters (an ES module can't assign another module's binding).
let drag = null;   // in-progress pointer interaction
let sel = null;    // {x, y, w, h, float: canvas|null}
const setDrag = (d) => { drag = d; };
const setSel = (s) => { sel = s; };

const SHAPES = new Set(['line', 'rect', 'ellipse']);
const TOOL_KEYS = {
  KeyV: 'move', KeyS: 'select', KeyP: 'pencil', KeyB: 'brush', KeyE: 'eraser', KeyF: 'fill',
  KeyI: 'picker', KeyT: 'text', KeyL: 'line', KeyR: 'rect', KeyO: 'ellipse',
};
const PALETTE = [
  ['#000000', 'Black'], ['#7f7f7f', 'Gray'], ['#880015', 'Dark red'], ['#ed1c24', 'Red'], ['#ff7f27', 'Orange'],
  ['#fff200', 'Yellow'], ['#22b14c', 'Green'], ['#00a2e8', 'Turquoise'], ['#3f48cc', 'Indigo'], ['#a349a4', 'Purple'],
  ['#ffffff', 'White'], ['#c3c3c3', 'Light gray'], ['#b97a57', 'Brown'], ['#ffaec9', 'Rose'], ['#ffc90e', 'Gold'],
  ['#efe4b0', 'Light yellow'], ['#b5e61d', 'Lime'], ['#99d9ea', 'Light turquoise'], ['#7092be', 'Blue-gray'], ['#c8bfe7', 'Lavender'],
];
const MAX_DIM = 16384;
const MAX_PIXELS = 100e6; // ~400 MB per canvas; history keeps several
const megapixels = (w, h) => +(w * h / 1e6).toFixed(1);
// User-facing reason a w x h document can't exist, or null.
function sizeProblem(w, h) {
  const e = Core.sizeError(w, h, MAX_DIM, MAX_PIXELS);
  if (!e) return null;
  return e.reason === 'range' ? `sides must be between 1 and ${MAX_DIM} px`
    : `${w} × ${h} px (${megapixels(w, h)} MP) is over the ${MAX_PIXELS / 1e6} MP limit`;
}

export { drag, MAX_DIM, MAX_PIXELS, PALETTE, S, sel, setDrag, setSel, SHAPES, sizeProblem, TOOL_KEYS };
