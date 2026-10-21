const path = require('path');
const { launch } = require(path.resolve('test/e2e/browser.js'));
const url = 'http://localhost:8765/';
(async () => {
  const browser = await launch();
  try {
    // 1. User activation after a slow confirm(): Open calls showOpenFilePicker right after confirmDiscard().
    for (const wait of [500, 6000]) {
      const page = await browser.newPage();
      page.on('dialog', async (d) => { await new Promise((r) => setTimeout(r, wait)); await d.accept(); });
      await page.goto(url);
      await page.evaluate(() => {
        const b = document.createElement('button'); b.id = 'probe'; b.textContent = 'probe';
        Object.assign(b.style, { position: 'fixed', left: '10px', top: '300px', zIndex: 99 });
        b.onclick = async () => {
          const before = navigator.userActivation.isActive;
          confirm('Discard unsaved changes?');
          const after = navigator.userActivation.isActive;
          let picker;
          try { await window.showOpenFilePicker(); picker = 'opened'; } catch (e) { picker = e.name + ': ' + e.message; }
          window.probe = { before, after, picker };
        };
        document.body.appendChild(b);
      });
      page.on('filechooser', (fc) => fc.setFiles([]).catch(() => {}));
      await page.click('#probe');
      await page.waitForFunction(() => window.probe, null, { timeout: 20000 }).catch(() => {});
      console.log(`confirm answered after ${wait} ms:`, JSON.stringify(await page.evaluate(() => window.probe)));
      await page.close();
    }
    // 2. Restyling a selected image object with the palette: an undo step that changes nothing seen?
    {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      page.on('dialog', (d) => d.accept());
      await page.goto(url);
      await page.waitForTimeout(300);
      const r = await page.evaluate(async () => {
        const p = window.__paint;
        p.newDoc(300, 200); p.setZoom(1); p.S.pristine = false;
        const c = document.createElement('canvas'); c.width = 40; c.height = 40; c.getContext('2d').fillRect(0, 0, 40, 40);
        p.pasteImage(c);
        p.setTool('move'); // commits the paste as an image object
        const img = p.userObjs.find((o) => o.t === 'image');
        p.selectObj(img.id);
        const dirtyBefore = p.hist.isClean(), depth0 = p.hist.undoStack.length;
        const px0 = [...p.composite().getContext('2d').getImageData(0, 0, 300, 200).data];
        document.querySelector('#palette button[data-color="#ed1c24"]').click(); // Red as colour 1
        document.querySelector('#palette button[data-color="#22b14c"]').dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })); // Green as colour 2
        const px1 = [...p.composite().getContext('2d').getImageData(0, 0, 300, 200).data];
        let changed = 0; for (let i = 0; i < px0.length; i++) if (px0[i] !== px1[i]) changed++;
        const top = p.hist.undoStack.slice(depth0).map((e) => e.pairs && e.pairs.map(([n, t]) => [n.t, Object.keys(n).filter((k) => n[k] !== t[k])]));
        return { cleanBefore: dirtyBefore, newSteps: p.hist.undoStack.length - depth0, steps: top, pixelsChanged: changed, title: document.title };
      });
      console.log('restyle a selected image:', JSON.stringify(r));
      await page.close();
    }
  } finally { await browser.close(); }
})();
