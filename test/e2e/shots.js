// Screenshots of key UI states: node test/e2e/shots.js OUT_PREFIX (needs the dev server on :8765).
// usage: node shot.js out-prefix [scheme]  — screenshots main states
const { chromium } = require('playwright');
(async () => {
  const out = process.argv[2] || 'shot';
  const browser = await chromium.launch({ channel: 'chrome' });
  for (const scheme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme: scheme });
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
    await page.goto('http://localhost:8765/');
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${out}-${scheme}.png` });
    if (scheme === 'light') {
      await page.keyboard.press('KeyR');
      await page.screenshot({ path: `${out}-rect.png`, clip: { x: 0, y: 0, width: 1280, height: 120 } });
      await page.keyboard.press('Shift+KeyR');
      await page.waitForTimeout(200);
      await page.screenshot({ path: `${out}-resize.png` });
      await page.keyboard.press('Escape'); await page.waitForTimeout(150);
      await page.keyboard.press('Shift+Slash');
      await page.waitForTimeout(200);
      await page.screenshot({ path: `${out}-help.png` });
      await page.keyboard.press('Escape'); await page.waitForTimeout(150);
      await page.setViewportSize({ width: 900, height: 700 });
      await page.waitForTimeout(200);
      await page.screenshot({ path: `${out}-narrow.png` });
    }
    if (errs.length) console.log(scheme, 'ERRORS', errs);
  }
  await browser.close();
})();
