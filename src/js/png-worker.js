// UPNG's PNG encoder, off the main thread (fileio.js encodePng): RGBA pixels in, a PNG file out.
import UPNG from 'upng-js';

self.onmessage = (e) => {
  const { bmp, w, h } = e.data;
  try {
    let { raw } = e.data; // a page from an older build sends the pixels themselves
    if (bmp) { // a snapshot of the picture, read back here, off the page's main thread
      const g = new OffscreenCanvas(w, h).getContext('2d');
      g.drawImage(bmp, 0, 0);
      bmp.close();
      raw = g.getImageData(0, 0, w, h).data.buffer;
    }
    const png = UPNG.encode([raw], w, h, 0); // 0 colours = lossless
    self.postMessage({ png }, [png]);
  } catch (err) {
    self.postMessage({ error: String(err && err.message || err) });
  }
};
