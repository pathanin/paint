// Third-party libraries, bundled at build time (npm, exact versions in package.json): pica
// resamples, UTIF opens TIFF and UPNG writes smaller PNGs (both on pako). Each is split into its own
// chunk and loaded on first use (UPNG inside png-worker.js), so boot parses none of them; the service
// worker caches the chunks, so they load offline too. Each caller still keeps a built-in path, for
// inputs past the library's budget and in case it throws or doesn't load (a tab left open across
// a deploy asks for chunks the server no longer has).
import { kickFrame } from './view.js';

const loadPica = () => import('pica').then((m) => m.default);
const loadUTIF = () => import('utif2').then((m) => m.default);

// feature -> which implementation ran last, e.g. used.resize = 'pica' | 'builtin' (for the tests)
const used = {};

// A module worker built from src/js/<name>.js (an entry in build.mjs). The URL is relative to the
// page, not to this module, which may end up in a chunk.
const startWorker = (name) => new Worker(`${name}.js`, { type: 'module' });
// Posts one job to worker w and resolves with its reply, or rejects if the worker fails: it didn't
// load, or the job threw (any buffers sent along are gone then). One job at a time per worker.
function workerCall(w, msg, transfer) {
  return new Promise((resolve, reject) => {
    const settle = (e) => {
      w.removeEventListener('message', settle);
      w.removeEventListener('error', settle);
      w.removeEventListener('messageerror', settle);
      if (e.type === 'message' && !e.data.error) resolve(e.data);
      else {
        if (e.type === 'error') e.preventDefault(); // handled here: not an uncaught page error
        reject(new Error((e.data && e.data.error) || e.message || 'the worker failed'));
      }
    };
    w.addEventListener('message', settle);
    w.addEventListener('error', settle);
    w.addEventListener('messageerror', settle);
    w.postMessage(msg, transfer);
  });
}

// src (a canvas) as a file of the given type, like toBlob(), but encoded in blob-worker.js. The snapshot
// is taken now (createImageBitmap, a GPU copy), so later edits can't leak in; kickFrame() keeps it from
// holding the next frame. It is transferred: posting a copy would read it back here first. One worker
// per call, so its full-size CPU canvas is freed after. A small src is encoded here with toBlob(), and
// so is src itself if the worker can't start or fails: the snapshot went to the worker, so that encodes
// src as it is by then. Later edits of the same document are fine there (a save keeps them unsaved), but
// New and Open reuse #image and the base canvas: still(), when given, says whether src still holds the
// document it had, and if not the fallback rejects (name 'SourceChanged') instead of encoding another.
const SMALL_PX = 1 << 21; // up to here (one strip) the readback costs a few ms: not worth a worker
function encodeBlob(src, type = 'image/png', quality, still) {
  const builtin = () => new Promise((res, rej) => src.toBlob((b) => (b ? res(b) : rej(new Error('encode failed'))), type, quality));
  if (src.width * src.height <= SMALL_PX) { used.encode = 'builtin'; return builtin(); }
  const snap = createImageBitmap(src);
  kickFrame();
  return snap.then(async (bmp) => {
    const worker = startWorker('blob-worker');
    try {
      const { blob } = await workerCall(worker, { bmp, type, quality }, [bmp]);
      used.encode = 'worker';
      return blob;
    } catch {
      used.encode = 'builtin';
      if (still && !still()) throw Object.assign(new Error('the image was replaced while it was encoded'), { name: 'SourceChanged' });
      return builtin();
    } finally {
      worker.terminate();
    }
  });
}

export { encodeBlob, loadPica, loadUTIF, startWorker, used, workerCall };
