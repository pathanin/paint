// Third-party libraries, bundled at build time (npm, exact versions in package.json): pica
// resamples, UTIF opens TIFF and UPNG writes smaller PNGs (both on pako). Each is split into its own
// chunk and loaded on first use (UPNG inside png-worker.js), so boot parses none of them; the service
// worker caches the chunks, so they load offline too. Each caller still keeps a built-in path, for
// inputs past the library's budget and in case it throws or doesn't load (a tab left open across
// a deploy asks for chunks the server no longer has).
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

export { loadPica, loadUTIF, startWorker, used, workerCall };
