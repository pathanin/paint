// The browser the e2e scripts drive: the installed Google Chrome, or Playwright's WebKit (Safari's
// engine) with BROWSER=webkit (once: npx playwright install webkit).
//   BROWSER=webkit node test/e2e/smoke.js
const { chromium, webkit } = require('playwright');

const engine = process.env.BROWSER === 'webkit' ? 'webkit' : 'chrome';
const launch = (opts = {}) => (engine === 'webkit' ? webkit.launch(opts) : chromium.launch({ channel: 'chrome', ...opts }));

module.exports = { engine, launch };
