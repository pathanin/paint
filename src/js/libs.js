// Third-party libraries, bundled into app.js at build time (npm, exact versions in package.json):
// pica resamples, UTIF opens TIFF and UPNG writes smaller PNGs (both on pako). Bundled rather than
// loaded from a CDN, so they work offline and from file:// with nothing to wait for. Each caller
// still keeps a built-in path, for inputs past the library's budget and in case it throws.
import pica from 'pica';
import UTIF from 'utif2';
import UPNG from 'upng-js';

export { pica, UTIF, UPNG };
// feature -> which implementation ran last, e.g. used.resize = 'pica' | 'builtin' (for the tests)
export const used = {};
