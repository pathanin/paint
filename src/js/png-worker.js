// UPNG's PNG encoder, off the main thread (fileio.js encodePng): RGBA pixels in, a PNG file out.
import UPNG from 'upng-js';

self.onmessage = (e) => {
  const { raw, w, h } = e.data;
  try {
    const png = UPNG.encode([raw], w, h, 0); // 0 colours = lossless
    self.postMessage({ png }, [png]);
  } catch (err) {
    self.postMessage({ error: String(err && err.message || err) });
  }
};
