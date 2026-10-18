// A canvas snapshot encoded to a file off the main thread (libs.js encodeBlob): an ImageBitmap in, a
// PNG/JPEG/WebP Blob out. toBlob() on a GPU canvas reads the whole thing back on the main thread first
// (~180 ms at 10000²) and holds the GPU process meanwhile. Here it is read back in strips, each cut out
// on a GPU canvas (as in fill-worker.js), into a CPU canvas, which encodes without touching the GPU.
const STRIP_PX = 1 << 21; // 2 MP (8 MB) per readback

self.onmessage = async (e) => {
  const { bmp, type, quality } = e.data;
  try {
    const w = bmp.width, h = bmp.height, rows = Math.max(1, Math.min(h, Math.floor(STRIP_PX / w)));
    const g = new OffscreenCanvas(w, rows).getContext('2d');
    g.globalCompositeOperation = 'copy';
    const out = new OffscreenCanvas(w, h), o = out.getContext('2d', { willReadFrequently: true }); // CPU-backed
    for (let y0 = 0; y0 < h; y0 += rows) {
      const n = Math.min(rows, h - y0);
      g.drawImage(bmp, 0, y0, w, n, 0, 0, w, n);
      o.putImageData(g.getImageData(0, 0, w, n), 0, y0);
    }
    bmp.close();
    self.postMessage({ blob: await out.convertToBlob({ type, quality }) });
  } catch (err) {
    self.postMessage({ error: String(err && err.message || err) });
  }
};
