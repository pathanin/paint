// End-to-end smoke test (Playwright + installed Chrome). See task.md / README for how to run.
// Functional smoke test. usage: node smoke.js [url]   exit 0 = all pass
const { chromium } = require('playwright');
const url = process.argv[2] || 'http://localhost:8765/';
let fails = 0, passes = 0;
const ok = (c, m) => { if (c) passes++; else { fails++; console.log('FAIL:', m); } };
(async () => {
  const browser = await chromium.launch({ channel: 'chrome' });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
    page.on('dialog', (d) => d.accept());
    await page.goto(url);
    await page.waitForTimeout(300);
    const P = (f, a) => page.evaluate(f, a);
    // every tool button selects its tool
    const tools = await P(() => [...document.querySelectorAll('button[data-tool]')].map((b) => b.dataset.tool));
    ok(tools.length === 10, 'ten tool buttons, got ' + tools.length);
    for (const t of tools) {
      await page.click(`button[data-tool="${t}"]`);
      ok(await P(() => window.__paint.S.tool) === t, 'tool button ' + t);
      ok(await P((t) => document.querySelector('#toolName') ? document.querySelector('#toolName').textContent === document.querySelector(`button[data-tool="${t}"]`).dataset.tip : true, t), 'tool name label ' + t);
      ok(await P(() => !document.querySelector('#stage').hasAttribute('aria-pressed')), 'stage not treated as tool button');
      ok(await P((t) => { const b = document.querySelector(`button[data-tool="${t}"]`); return b.classList.contains('active') || b.getAttribute('aria-pressed') === 'true'; }, t), 'active state ' + t);
    }
    // shortcuts still work after clicking a toolbar control
    await page.click('button[data-tool="select"]');
    await page.keyboard.press('KeyB');
    ok(await P(() => window.__paint.S.tool) === 'brush', 'B after toolbar click');
    await page.click('#size');
    await page.keyboard.press('KeyP');
    ok(await P(() => window.__paint.S.tool) === 'pencil', 'P after slider click');
    // undo disabled initially; stroke changes pixels; undo enabled
    ok(await P(() => document.querySelector('[data-cmd="undo"]').disabled), 'undo disabled at start');
    await page.keyboard.press('KeyB');
    const box = await page.locator('#overlay').boundingBox();
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy); await page.mouse.down(); await page.mouse.move(cx + 40, cy + 20, { steps: 5 }); await page.mouse.up();
    const px = () => P(() => { const c = document.querySelector('#image'); const r = c.getBoundingClientRect(); const x = Math.floor(c.width / 2), y = Math.floor(c.height / 2); return [...c.getContext('2d').getImageData(x, y, 1, 1).data].join(); });
    ok(await px() === '0,0,0,255', 'stroke painted black at center, got ' + await px());
    ok(!(await P(() => document.querySelector('[data-cmd="undo"]').disabled)), 'undo enabled after stroke');
    await page.click('[data-cmd="undo"]');
    ok(await px() === '255,255,255,255', 'undo button reverted stroke');
    ok(!(await P(() => document.querySelector('[data-cmd="redo"]').disabled)), 'redo enabled after undo');
    await page.keyboard.press('Meta+Shift+KeyZ');
    ok(await px() === '0,0,0,255', '⌘⇧Z redo');
    // palette: left sets primary, right sets secondary; X swaps
    const sw = page.locator('#palette [data-color="#ed1c24"]');
    await sw.click();
    ok(await P(() => window.__paint.S.primary) === '#ed1c24', 'swatch click sets primary');
    await page.locator('#palette [data-color="#22b14c"]').click({ button: 'right' });
    ok(await P(() => window.__paint.S.secondary) === '#22b14c', 'swatch right-click sets secondary');
    await page.keyboard.press('KeyX');
    ok(await P(() => window.__paint.S.primary === '#22b14c' && window.__paint.S.secondary === '#ed1c24'), 'X swaps colors');
    // command buttons open dialogs
    for (const [cmd, dlg] of [['new', '#newDlg'], ['resize', '#resizeDlg'], ['canvasSize', '#resizeDlg'], ['help', '#helpDlg']]) {
      await page.click(`[data-cmd="${cmd}"]`);
      ok(await page.locator(dlg).evaluate((d) => d.open), cmd + ' opens ' + dlg);
      await page.keyboard.press('Escape');
      ok(!(await page.locator(dlg).evaluate((d) => d.open)), dlg + ' closes on Esc');
    }
    // rotate button changes dims; tool options visibility follows tool
    await page.click('[data-cmd="rotR"]');
    ok(await P(() => window.__paint.img.width === 600 && window.__paint.img.height === 800), 'rotate right');
    await page.keyboard.press('KeyF');
    ok(await page.locator('#tolerance').isVisible(), 'tolerance visible for fill');
    ok(!(await page.locator('#size').isVisible()), 'size hidden for fill');
    // zoom buttons
    const z0 = await P(() => window.__paint.S.zoom);
    await page.click('[data-cmd="zoomIn"]');
    ok(await P(() => window.__paint.S.zoom) > z0, 'zoom in');
    // --- round 1 review fixes ---
    await page.reload(); await page.waitForTimeout(200);
    // dirty clears when undone back to the saved/original state
    await page.keyboard.press('KeyB');
    await page.mouse.move(cx, cy); await page.mouse.down(); await page.mouse.move(cx + 30, cy, { steps: 3 }); await page.mouse.up();
    ok(await page.locator('#docDirty').isVisible(), 'Edited shown after stroke');
    await page.keyboard.press('Meta+KeyZ');
    ok(!(await page.locator('#docDirty').isVisible()), 'Edited cleared after undo to original');
    // keyboard: Space on a focused toolbar button activates it and focus stays
    await page.locator('[data-cmd="flipH"]').focus();
    const before = await P(() => window.__paint.hist.undoStack.length);
    await page.keyboard.press('Space');
    ok(await P(() => window.__paint.hist.undoStack.length) === before + 1, 'Space activates focused button');
    ok(await P(() => document.activeElement.dataset.cmd) === 'flipH', 'focus stays on keyboard-activated button');
    await page.keyboard.press('ArrowRight');
    ok(await P(() => document.activeElement.dataset.cmd) === 'flipV', 'ArrowRight roves in top bar');
    // mouse click releases focus so letter shortcuts work
    await page.click('[data-cmd="flipV"]');
    ok(await P(() => document.activeElement === document.body), 'mouse click releases focus');
    // rail: one tab stop = active tool
    ok(await P(() => [...document.querySelectorAll('#rail button')].filter((b) => b.tabIndex === 0).map((b) => b.dataset.tool).join()) === 'brush', 'rail tab stop is active tool');
    // palette: shift-click and Shift+Enter set color 2; names as labels
    await page.locator('#palette [data-color="#3f48cc"]').click({ modifiers: ['Shift'] });
    ok(await P(() => window.__paint.S.secondary) === '#3f48cc', 'shift-click sets color 2');
    await page.locator('#palette [data-color="#ff7f27"]').focus();
    await page.keyboard.press('Shift+Enter');
    ok(await P(() => window.__paint.S.secondary) === '#ff7f27', 'Shift+Enter on swatch sets color 2');
    ok(await page.locator('#palette [data-color="#ed1c24"]').getAttribute('aria-label') === 'Red', 'swatch named');
    await page.evaluate(() => document.activeElement.blur());
    // text: changing font keeps the text box open
    await page.keyboard.press('KeyT');
    await page.mouse.click(cx - 100, cy - 100);
    await page.keyboard.type('Hi');
    // keyboard: focus stays on the select so arrows keep working; text stays open
    await page.focus('#font');
    await page.selectOption('#font', { label: 'Mono' });
    ok(await P(() => !document.querySelector('#textInput').hidden), 'text box stays open after keyboard font change');
    ok(await P(() => document.activeElement.id) === 'font', 'keyboard font change keeps focus on select');
    // mouse: picking from the select hands focus back to the text
    await page.dispatchEvent('#font', 'pointerdown');
    await page.selectOption('#font', { label: 'Serif' });
    ok(await P(() => !document.querySelector('#textInput').hidden), 'text box stays open after font change');
    ok(await P(() => document.activeElement.id) === 'textInput', 'focus back in text box after mouse font change');
    await page.keyboard.press('Enter');
    ok(await P(() => document.querySelector('#textInput').hidden), 'Enter commits text');
    // resize: too large keeps dialog open with an error
    await page.keyboard.press('Shift+KeyR');
    await page.waitForTimeout(100);
    await page.fill('#rW', '20000');
    await page.click('#resizeDlg button.primary');
    ok(await page.locator('#resizeDlg').evaluate((d) => d.open), 'resize dialog stays open on too-large input');
    ok(/between 1 and 16384/.test(await page.locator('#rErr').textContent()), 'resize shows inline error');
    await page.keyboard.press('Escape'); await page.waitForTimeout(150);
    // crop hint
    ok(await P(() => document.querySelector('#cropBtn').dataset.hint) === 'Select an area first', 'crop hint when disabled');
    // narrow: nothing clipped in the top bar at 640px
    for (const w of [640, 760, 900]) {
      await page.setViewportSize({ width: w, height: 700 });
      await page.waitForTimeout(100);
      const [sw, cw] = await P(() => [document.querySelector('#topbar').scrollWidth, document.querySelector('#topbar').clientWidth]);
      ok(sw <= cw, `top bar fits at ${w}px (${sw} > ${cw})`);
      const [osw, ocw] = await P(() => [document.querySelector('#optbar').scrollWidth, document.querySelector('#optbar').clientWidth]);
      ok(osw <= ocw, `options bar fits at ${w}px (${osw} > ${ocw})`);
      // every visible tool option and the palette must actually be on screen and hit-testable
      for (const tool of ['KeyP', 'KeyR', 'KeyT', 'KeyF']) {
        await page.keyboard.press(tool);
        const bad = await P(() => [...document.querySelectorAll('.opts [data-for]:not([hidden]):not(.hint) :is(input,select), #palette button, .well input')]
          .filter((el) => {
            const r = el.getBoundingClientRect();
            if (!r.width || !r.height) return true;
            const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            return !(hit === el || el.contains(hit) || (hit && hit.closest('label') && hit.closest('label').contains(el)));
          }).map((el) => el.id || el.name || el.dataset.color));
        ok(bad.length === 0, `controls hidden/clipped at ${w}px with ${tool}: ${bad.join(',')}`);
      }
    }
    // --- round 2 review fixes ---
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.reload(); await page.waitForTimeout(200);
    const ib = await page.locator('#image').boundingBox();
    // handle hit areas don't cover canvas pixels at the edge
    const edgeHits = await P(([x, y, w, h]) => [
      document.elementFromPoint(x + w - 1.5, y + h / 2).id,
      document.elementFromPoint(x + w / 2, y + h - 1.5).id,
      document.elementFromPoint(x + w - 1.5, y + h - 1.5).id,
    ], [ib.x, ib.y, ib.width, ib.height]);
    ok(edgeHits.every((id) => id === 'overlay'), 'edge pixels hit the canvas, got ' + edgeHits);
    // palette marks current colors
    ok(await P(() => document.querySelector('#palette [data-color="#000000"]').classList.contains('is1')), 'black swatch marked as color 1 at start');
    ok(await P(() => document.querySelector('#palette [data-color="#ffffff"]').classList.contains('is2')), 'white swatch marked as color 2 at start');
    await page.click('#palette [data-color="#22b14c"]');
    ok(await P(() => document.querySelector('#palette [data-color="#22b14c"]').getAttribute('aria-pressed')) === 'true', 'clicked swatch pressed');
    ok(await P(() => !document.querySelector('#palette [data-color="#000000"]').classList.contains('is1')), 'old swatch unmarked');
    // Esc dismisses a keyboard tooltip
    await page.locator('[data-cmd="open"]').focus();
    await page.keyboard.press('ArrowLeft'); await page.waitForTimeout(50);
    ok(await page.locator('#tip').isVisible(), 'keyboard focus shows tooltip');
    ok(await P(() => !document.querySelector('#tip').classList.contains('fade')), 'keyboard tooltip does not fade');
    await page.keyboard.press('Escape');
    ok(!(await page.locator('#tip').isVisible()), 'Esc hides tooltip');
    // undo via keyboard until disabled keeps focus in the toolbar
    await page.evaluate(() => document.activeElement.blur());
    await page.keyboard.press('KeyP');
    await page.mouse.move(cx, cy); await page.mouse.down(); await page.mouse.move(cx + 20, cy, { steps: 2 }); await page.mouse.up();
    await page.locator('[data-cmd="undo"]').focus();
    await page.keyboard.press('Enter');
    ok(await P(() => document.querySelector('[data-cmd="undo"]').disabled), 'undo disabled at start of history');
    ok(await P(() => !!document.activeElement.closest('#topbar')), 'focus stays in top bar after undo disables itself, got ' + await P(() => document.activeElement.tagName));
    await page.evaluate(() => document.activeElement.blur());
    // Space-pan resets on window blur
    await page.keyboard.down('Space');
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await page.keyboard.up('Space'); // keyup lost in real life; emulate by resetting below
    await page.keyboard.down('Space');
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    ok(await P(() => window.__paint.S.panKey === false), 'panKey cleared on blur');
    await page.keyboard.up('Space');
    // Shift+0 / Shift+1 zoom
    await page.keyboard.press('Shift+Digit1');
    const zf = await P(() => window.__paint.S.zoom);
    await page.keyboard.press('Shift+Digit0');
    ok(await P(() => window.__paint.S.zoom) === 1 && zf !== 1, 'Shift+1 fits, Shift+0 actual size');
    ok(/100%/.test(await page.locator('#zoomBtn').getAttribute('aria-label')), 'zoom button label carries value');
    // download-save feedback
    await page.evaluate(() => { delete window.showSaveFilePicker; window.showSaveFilePicker = undefined; });
    await page.click('[data-cmd="save"]');
    await page.waitForTimeout(150);
    ok(/Downloaded/.test(await page.locator('#toast').textContent()), 'download save shows toast');
    // round 11: Save As on the download path asks for a name; cancel downloads nothing
    {
      const fn0 = await P(() => window.__paint.S.fileName);
      await P(() => { window.__realPrompt = window.prompt; window.prompt = () => null; window.__paint.flash('—'); });
      await page.keyboard.press('Meta+Shift+KeyS'); await page.waitForTimeout(150);
      ok(!/Downloaded/.test(await page.locator('#toast').textContent()) && await P(() => window.__paint.S.fileName) === fn0, 'cancelled Save As downloads nothing');
      await P(() => { window.prompt = (m, d) => { window.__promptDefault = d; return ' sketch '; }; });
      await page.keyboard.press('Meta+Shift+KeyS'); await page.waitForTimeout(150);
      ok(await P(() => window.__promptDefault) === fn0, 'Save As prompt suggests the current name');
      ok(/Downloaded sketch\.png/.test(await page.locator('#toast').textContent()) && await P(() => window.__paint.S.fileName) === 'sketch.png', 'Save As downloads under the typed name, .png added: ' + await page.locator('#toast').textContent());
      await P(() => { window.prompt = () => 'photo.jpg'; });
      await page.keyboard.press('Meta+Shift+KeyS'); await page.waitForTimeout(150);
      ok(await P(() => window.__paint.S.fileName) === 'photo.jpg', 'Save As keeps a writable extension');
      // round 12: a dot isn't an extension; names are sanitised so title and download agree; prompt says what's accepted
      for (const [typed, want] of [['report v1.2', 'report v1.2.png'], ['a/b.png', 'a_b.png']]) {
        await P((t) => { window.prompt = (m) => { window.__promptMsg = m; return t; }; }, typed);
        await page.keyboard.press('Meta+Shift+KeyS'); await page.waitForTimeout(150);
        ok(await P(() => window.__paint.S.fileName) === want, `Save As "${typed}" -> ${want}, got ` + await P(() => window.__paint.S.fileName));
      }
      ok(/PNG/.test(await P(() => window.__promptMsg)) && /JPEG/.test(await P(() => window.__promptMsg)), 'Save As prompt names the formats: ' + await P(() => window.__promptMsg));
      await P(() => { window.prompt = window.__realPrompt; });
    }
    // resize dialog title follows mode
    await page.keyboard.press('Shift+KeyC'); await page.waitForTimeout(100);
    ok(await page.locator('#resizeTitle').textContent() === 'Canvas size', 'canvas dialog titled');
    await page.keyboard.press('Escape'); await page.waitForTimeout(150);
    // short window: rail buttons keep their size
    await page.setViewportSize({ width: 1280, height: 420 }); await page.waitForTimeout(100);
    ok(await P(() => Math.min(...[...document.querySelectorAll('#rail button')].map((b) => b.getBoundingClientRect().height))) >= 36, 'rail buttons stay 36px at 420px height');
    // narrow: unsaved state still visible
    await page.setViewportSize({ width: 760, height: 700 }); await page.waitForTimeout(100);
    await page.keyboard.press('KeyP');
    await page.mouse.move(300, 400); await page.mouse.down(); await page.mouse.move(330, 400, { steps: 2 }); await page.mouse.up();
    ok(await P(() => getComputedStyle(document.querySelector('[data-cmd="save"]'), '::after').content !== 'none'), 'unsaved marker (Save dot) visible at 760px');
    // text: Enter in font size field applies the text
    await page.setViewportSize({ width: 1280, height: 800 }); await page.waitForTimeout(100);
    await page.keyboard.press('KeyT');
    await page.mouse.click(cx - 50, cy - 50);
    await page.keyboard.type('Yo');
    await page.fill('#fontSize', '30');
    await page.keyboard.press('Enter');
    ok(await P(() => document.querySelector('#textInput').hidden), 'Enter in size field applies text');
    // --- round 3 review fixes ---
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.reload(); await page.waitForTimeout(200);
    // cut with no selection does not claim "Cut"
    await page.evaluate(() => { navigator.clipboard.write = async () => {}; });
    await page.keyboard.press('Meta+KeyX'); await page.waitForTimeout(100);
    ok(!/^Cut$/.test(await page.locator('#toast').textContent()), 'no "Cut" toast without a selection, got ' + await page.locator('#toast').textContent());
    // layout-aware punctuation: German "+" key (code BracketRight) zooms, doesn't resize the brush
    await page.keyboard.press('KeyB');
    const sz0 = await P(() => window.__paint.S.sizes.brush), z0b = await P(() => window.__paint.S.zoom);
    await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: '+', code: 'BracketRight', bubbles: true })));
    ok(await P(() => window.__paint.S.sizes.brush) === sz0 && await P(() => window.__paint.S.zoom) > z0b, 'German + zooms in');
    const sz1 = await P(() => window.__paint.S.sizes.brush);
    await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ü', code: 'BracketLeft', bubbles: true })));
    ok(await P(() => window.__paint.S.sizes.brush) === sz1, 'German ü does nothing');
    await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'и', code: 'KeyB', bubbles: true })));
    ok(await P(() => window.__paint.S.tool) === 'brush', 'Cyrillic layout letter falls back to physical key');
    await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'п', code: 'KeyG', bubbles: true })));
    await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'е', code: 'KeyT', bubbles: true })));
    ok(await P(() => window.__paint.S.tool) === 'text', 'Cyrillic physical T selects text');
    // zoom aria-label reads correctly away from 100%
    await page.keyboard.press('Shift+Digit1');
    ok(!/\d+%, actual size/.test(await page.locator('#zoomBtn').getAttribute('aria-label')), 'zoom label not "N%, actual size": ' + await page.locator('#zoomBtn').getAttribute('aria-label'));
    // IME: Enter while composing doesn't commit
    await page.keyboard.press('Shift+Digit0');
    await page.keyboard.press('KeyT');
    await page.mouse.click(cx - 80, cy - 80);
    await page.keyboard.type('ka');
    await page.evaluate(() => document.querySelector('#textInput').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true })));
    ok(await P(() => !document.querySelector('#textInput').hidden), 'Enter during IME composition keeps text open');
    ok(await page.locator('#stHint').isVisible(), 'status bar explains text keys while editing');
    await page.keyboard.press('Escape');
    ok(!(await page.locator('#stHint').isVisible()), 'text key hint gone after Esc');
    // non-image drop doesn't ask to discard
    await page.keyboard.press('KeyP');
    await page.mouse.move(cx, cy); await page.mouse.down(); await page.mouse.move(cx + 10, cy, { steps: 2 }); await page.mouse.up();
    let dialogs = 0;
    const onDlg = () => dialogs++;
    page.on('dialog', onDlg);
    await page.evaluate(() => { const dt = new DataTransfer(); dt.items.add(new File(['x'], 'notes.txt', { type: 'text/plain' })); window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); });
    await page.waitForTimeout(150);
    page.off('dialog', onDlg);
    ok(dialogs === 0, 'non-image drop does not prompt to discard');
    ok(/Not an image/.test(await page.locator('#toast').textContent()), 'non-image drop reports it');
    // help lists ⌘0, swatch color 2, middle-drag (shortcuts read Ctrl+ off a Mac: keyLabel())
    const mac = await P(() => /Mac|iPhone|iPad/.test(navigator.platform));
    const mod = mac ? '⌘' : 'Ctrl\\+';
    await page.keyboard.press('Shift+Slash'); await page.waitForTimeout(100);
    const helpTxt = await page.locator('#helpBody').textContent();
    ok(new RegExp(mod + '0').test(helpTxt) && /swatch/i.test(helpTxt) && /middle/i.test(helpTxt) && new RegExp(mod + 'Y').test(helpTxt), 'help lists ⌘0, swatch, middle-drag, ⌘Y');
    await page.keyboard.press('Escape'); await page.waitForTimeout(150);
    // palette exposes color 2
    ok(/color 2/i.test(await page.locator('#palette [data-color="#ffffff"]').getAttribute('aria-label')), 'color 2 swatch labelled');
    // tiny image: only the corner handle, and auto-zoom to an integer
    const png = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 16; c.height = 12; return c.toDataURL('image/png').split(',')[1]; });
    await page.setInputFiles('#fileInput', { name: 'tiny.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
    await page.waitForTimeout(200);
    ok(await P(() => window.__paint.img.width) === 16, 'tiny image opened');
    const tz = await P(() => window.__paint.S.zoom);
    ok(tz > 1 && Number.isInteger(tz), 'tiny image opens at an integer zoom > 1, got ' + tz);
    ok(!(await page.locator('.handle[data-edge=e]').isVisible()) && await page.locator('.handle[data-edge=se]').isVisible() || (await P(() => window.__paint.img.width * window.__paint.S.zoom)) >= 40, 'tiny stage keeps only the corner handle');
    // --- round 4 review fixes ---
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.reload(); await page.waitForTimeout(200);
    // keyboard on slider and radios keeps focus
    await page.keyboard.press('KeyR');
    await page.focus('#size');
    const s0 = await P(() => window.__paint.S.sizes.rect);
    await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight');
    ok(await P(() => window.__paint.S.sizes.rect) === s0 + 2, 'two arrow presses step the size twice');
    ok(await P(() => document.activeElement.id) === 'size', 'slider keeps focus on arrow keys');
    await page.focus('input[name=fillMode][value=outline]');
    await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight');
    ok(await P(() => window.__paint.S.fillMode) === 'both', 'arrows move through shape styles');
    // mouse use of the slider still hands focus back
    await page.locator('#size').click();
    ok(await P(() => document.activeElement === document.body), 'mouse on slider releases focus');
    // tooltip hides when pointer leaves the window
    await page.waitForTimeout(450);
    await page.hover('[data-cmd="save"]'); await page.waitForTimeout(700);
    ok(await page.locator('#tip').isVisible(), 'hover tip shown');
    ok(await P(() => document.querySelector('#tip').classList.contains('fade')), 'cold hover tip fades in');
    await page.hover('[data-cmd="saveAs"]'); await page.waitForTimeout(50);
    ok(await page.locator('#tip').isVisible(), 'warm hover tip shown at once');
    ok(await P(() => !document.querySelector('#tip').classList.contains('fade')), 'warm hover tip does not fade');
    await page.evaluate(() => document.documentElement.dispatchEvent(new MouseEvent('mouseleave', { relatedTarget: null })));
    await page.mouse.move(640, -20);
    await page.waitForTimeout(50);
    ok(!(await page.locator('#tip').isVisible()), 'tip hides when pointer leaves window');
    // font size clamps
    await page.keyboard.press('KeyT');
    await page.fill('#fontSize', '5000');
    ok(await P(() => window.__paint.S.fontSize) <= 400, 'font size clamped');
    await page.locator('#fontSize').press('Enter');
    ok(await page.locator('#fontSize').inputValue() === '400', 'clamped size written back');
    // help lists text Enter/Esc
    await page.keyboard.press('Shift+Slash'); await page.waitForTimeout(100);
    ok(/Apply text/.test(await page.locator('#helpBody').textContent()), 'help lists Apply text');
    await page.keyboard.press('Escape'); await page.waitForTimeout(150);
    // paste that grows the canvas says so
    await page.keyboard.press('KeyP');
    await page.mouse.move(cx, cy); await page.mouse.down(); await page.mouse.move(cx + 5, cy, { steps: 2 }); await page.mouse.up();
    await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 1200; c.height = 300; window.__paint.pasteImage(c); });
    ok(/enlarged/i.test(await page.locator('#toast').textContent()), 'grow-on-paste toast');
    // saving over an unsupported format goes to Save As as .png
    const saveLog = await page.evaluate(async () => {
      const log = [];
      window.__paint.S.fileName = 'pic.bmp';
      window.__paint.S.fileHandle = { name: 'pic.bmp', queryPermission: async () => 'granted', requestPermission: async () => 'granted', createWritable: async () => { log.push('wrote-bmp'); return { write: async () => {}, close: async () => {} }; } };
      window.showSaveFilePicker = async (o) => { log.push('picker:' + o.suggestedName); return { name: o.suggestedName, createWritable: async () => ({ write: async () => {}, close: async () => {} }) }; };
      await window.__paint.save(false);
      return log;
    });
    ok(!saveLog.includes('wrote-bmp') && saveLog.includes('picker:pic.png'), 'bmp save goes to Save As pic.png: ' + saveLog);
    // short options for select/picker on narrow screens
    await page.setViewportSize({ width: 760, height: 700 }); await page.waitForTimeout(100);
    await page.keyboard.press('KeyS');
    ok(await page.locator('.hint[data-for~="select"]').isVisible(), 'select hint visible at 760');
    await page.keyboard.press('KeyI');
    ok(await page.locator('.hint[data-for~="picker"]').isVisible(), 'picker hint visible at 760');
    await page.setViewportSize({ width: 1280, height: 800 });
    // --- round 5 review fixes ---
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.reload(); await page.waitForTimeout(200);
    {
      const png = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 200; c.height = 100; const g = c.getContext('2d'); g.fillStyle = '#c00'; g.fillRect(0, 0, 100, 100); return c.toDataURL().split(',')[1]; });
      await page.setInputFiles('#fileInput', { name: 'half.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
      await page.waitForTimeout(200);
    }
    // floating paste counts as unsaved, and Undo is available
    await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 20; c.height = 20; window.__paint.pasteImage(c); });
    ok(await page.locator('#docDirty').isVisible(), 'floating paste shows Edited');
    ok(!(await P(() => document.querySelector('[data-cmd="undo"]').disabled)), 'undo enabled with a floating paste');
    let asked = 0; const onAsk = () => { asked++; }; // the global handler accepts
    page.on('dialog', onAsk);
    await page.keyboard.press('Alt+KeyN'); await page.waitForTimeout(100);
    page.off('dialog', onAsk);
    ok(asked === 1, 'New asks to discard a floating paste');
    await page.keyboard.press('Escape'); await page.waitForTimeout(150); // close the New dialog
    await page.click('[data-cmd="undo"]');
    ok(!(await page.locator('#docDirty').isVisible()), 'undo of floating paste is clean again');
    // picker on a transparent pixel doesn't pick black
    await page.click('#palette [data-color="#3f48cc"]'); // non-black, so picking black would show
    await page.keyboard.press('KeyI');
    await page.click('[data-cmd="zoom100"]');
    const hb = await page.locator('#image').boundingBox();
    const prim = await P(() => window.__paint.S.primary);
    await page.mouse.click(hb.x + hb.width * 0.75, hb.y + hb.height / 2);
    ok(await P(() => window.__paint.S.primary) === prim, 'transparent pick keeps color 1');
    await page.mouse.click(hb.x + hb.width * 0.25, hb.y + hb.height / 2);
    ok(await P(() => window.__paint.S.primary) === '#cc0000', 'opaque pick works');
    // file name live region not rewritten per stroke
    const muts = await page.evaluate(async () => {
      let n = 0; const mo = new MutationObserver((m) => { n += m.length; });
      mo.observe(document.querySelector('#docTitle'), { childList: true, characterData: true, subtree: true });
      window.__paint.undo(); window.__paint.redo(); window.__paint.undo();
      await new Promise((r) => setTimeout(r, 50)); mo.disconnect(); return n;
    });
    ok(muts === 0, 'doc title not rewritten when unchanged, mutations=' + muts);
    // unchanged resize says so
    await page.keyboard.press('Shift+KeyR'); await page.waitForTimeout(100);
    const w1 = await page.locator('#resizeDlg').evaluate((d) => d.getBoundingClientRect().width);
    await page.fill('#rW', '99999'); await page.click('#resizeDlg button.primary');
    const w2 = await page.locator('#resizeDlg').evaluate((d) => d.getBoundingClientRect().width);
    ok(Math.abs(w1 - w2) < 1, `resize dialog width stable (${w1} vs ${w2})`);
    await page.fill('#rW', '200'); await page.fill('#rH', '100'); await page.click('#resizeDlg button.primary');
    await page.waitForTimeout(100);
    ok(/unchanged/i.test(await page.locator('#toast').textContent()), 'unchanged size toast');
    // anchor grid: Down goes to the cell below
    await page.keyboard.press('Shift+KeyC'); await page.waitForTimeout(100);
    await page.focus('input[name=anchor][value=mc]');
    await page.keyboard.press('ArrowDown');
    ok(await P(() => document.querySelector('input[name=anchor]:checked').value) === 'bc', 'anchor Down moves to cell below');
    await page.keyboard.press('Escape'); await page.waitForTimeout(150);
    // crop stays reachable by keyboard and explains itself
    ok(await P(() => { const b = document.querySelector('#cropBtn'); return !b.disabled && b.getAttribute('aria-disabled') === 'true'; }), 'crop aria-disabled, focusable');
    await page.click('#cropBtn', { force: true }); // Playwright treats aria-disabled as not clickable; users can click it
    ok(/Select an area/.test(await page.locator('#toast').textContent()), 'crop without selection explains');
    // zoom presets
    await page.keyboard.press('Shift+Digit0');
    await page.click('[data-cmd="zoomIn"]');
    ok(await P(() => window.__paint.S.zoom) === 1.5, 'zoom in from 100% goes to 150%');
    await page.keyboard.press('Minus');
    ok(await P(() => window.__paint.S.zoom) === 1, 'zoom out returns to 100%');
    // help complete and fits at 1280x800
    await page.keyboard.press('Shift+Slash'); await page.waitForTimeout(150);
    const ht = await page.locator('#helpBody').textContent();
    ok((mac ? /⌘\+/ : /Ctrl\+Plus/).test(ht) && /Cancel shape, selection or move drag/.test(ht), 'help lists ⌘+ and Esc cancel for drags');
    ok(await P(() => { const b = document.querySelector('#helpBody'); return b.scrollHeight <= b.clientHeight + 1; }), 'help fits at 1280x800 without scrolling');
    await page.keyboard.press('Escape'); await page.waitForTimeout(150);
    // 600px wide: nothing clipped
    await page.setViewportSize({ width: 600, height: 700 }); await page.waitForTimeout(100);
    ok(await P(() => { const t = document.querySelector('#topbar'); return t.scrollWidth <= t.clientWidth; }), 'top bar fits at 600');
    await page.keyboard.press('KeyR');
    ok(await P(() => { const r = document.querySelector('.seg[data-for]').getBoundingClientRect(), o = document.querySelector('.opts').getBoundingClientRect(); return r.right <= o.right + 0.5; }), 'shape style not clipped at 600');
    await page.setViewportSize({ width: 1280, height: 800 });
    // --- round 6 review fixes ---
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.reload(); await page.waitForTimeout(200);
    await page.click('[data-cmd="zoom100"]');
    const ob = await page.locator('#image').boundingBox();
    const at = (x, y) => [ob.x + x, ob.y + y];
    // content to select
    await page.keyboard.press('KeyR');
    await page.mouse.move(...at(100, 100)); await page.mouse.down(); await page.mouse.move(...at(160, 140), { steps: 3 }); await page.mouse.up();
    await page.evaluate(() => { window.__paint.hist.markSaved(); if (window.__paint.updateChrome) window.__paint.updateChrome(); });
    await page.keyboard.press('KeyS');
    await page.mouse.move(...at(90, 90)); await page.mouse.down(); await page.mouse.move(...at(170, 150), { steps: 3 }); await page.mouse.up();
    // a bare click inside the selection changes nothing
    await page.mouse.click(...at(120, 120));
    ok(!(await page.locator('#docDirty').isVisible()), 'bare click in selection is not an edit');
    // Esc during a move cancels it cleanly, with no errors
    const errsBefore = errs.length;
    await page.mouse.move(...at(120, 120)); await page.mouse.down(); await page.mouse.move(...at(220, 220), { steps: 3 });
    await page.keyboard.press('Escape');
    await page.mouse.move(...at(240, 240), { steps: 3 }); await page.mouse.up();
    ok(errs.length === errsBefore, 'no errors after Esc mid-move: ' + errs.slice(errsBefore));
    ok(await P(() => { const s = window.__paint.sel; return !s || (s.x === 90 && s.y === 90); }), 'Esc mid-move returns selection to origin');
    ok(!(await page.locator('#docDirty').isVisible()), 'cancelled move is not an edit');
    // tool key / Delete mid-move are ignored
    await page.keyboard.press('KeyS');
    await page.mouse.move(...at(90, 90)); await page.mouse.down(); await page.mouse.move(...at(170, 150), { steps: 3 }); await page.mouse.up();
    await page.mouse.move(...at(120, 120)); await page.mouse.down(); await page.mouse.move(...at(200, 200), { steps: 3 });
    await page.keyboard.press('KeyP'); await page.keyboard.press('Delete');
    await page.mouse.move(...at(210, 210), { steps: 2 }); await page.mouse.up();
    ok(errs.length === errsBefore, 'no errors after keys mid-move');
    ok(await P(() => window.__paint.S.tool) === 'select', 'tool key ignored mid-drag');
    // undo of a move clears the marquee
    await page.keyboard.press('Meta+KeyZ');
    ok(await P(() => window.__paint.sel) === null, 'undo clears the selection marquee');
    // a completed move, then undo: no stale marquee left at the destination
    await page.keyboard.press('KeyS');
    await page.mouse.move(...at(90, 90)); await page.mouse.down(); await page.mouse.move(...at(170, 150), { steps: 3 }); await page.mouse.up();
    await page.mouse.move(...at(120, 120)); await page.mouse.down(); await page.mouse.move(...at(300, 260), { steps: 4 }); await page.mouse.up();
    ok(await P(() => !!window.__paint.sel && window.__paint.sel.x !== 90), 'selection moved');
    await page.keyboard.press('Meta+KeyZ');
    ok(await P(() => window.__paint.sel) === null, 'undo after a completed move clears the marquee');
    // arrows on a focused toolbar button don't nudge a selection
    await page.keyboard.press('Meta+KeyA');
    await page.locator('[data-cmd="new"]').focus();
    await page.keyboard.press('ArrowDown');
    ok(await P(() => window.__paint.sel.y) === 0, 'ArrowDown on toolbar does not nudge');
    await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
    await page.evaluate(() => document.activeElement.blur());
    // zero-size rect click is not an edit
    await page.evaluate(() => { window.__paint.hist.markSaved(); if (window.__paint.updateChrome) window.__paint.updateChrome(); });
    await page.keyboard.press('KeyR');
    await page.mouse.click(...at(400, 300));
    ok(!(await page.locator('#docDirty').isVisible()), 'zero-size rectangle is not an edit');
    // paste after explicit New keeps the chosen size
    await page.keyboard.press('Alt+KeyN'); await page.waitForTimeout(100);
    await page.fill('#newW', '1200'); await page.fill('#newH', '900');
    await page.click('#newDlg button.primary'); await page.waitForTimeout(100);
    await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 120; c.height = 80; window.__paint.pasteImage(c); });
    ok(await P(() => window.__paint.img.width === 1200 && window.__paint.img.height === 900), 'paste keeps user-chosen New size');
    await page.keyboard.press('Escape');
    // focus rings in options bar not clipped
    await page.keyboard.press('KeyF');
    await page.focus('#tolerance');
    ok(await P(() => { const el = document.querySelector('#tolerance'), r = el.getBoundingClientRect(); const o = document.querySelector('.opts').getBoundingClientRect(); return r.top - 3 >= o.top - 0.5 && r.bottom + 3 <= o.bottom + 0.5; }), 'focus ring room inside .opts');
    ok(await P(() => { const sw = document.querySelector('.well .swap').getBoundingClientRect(), bar = document.querySelector('#optbar').getBoundingClientRect(); return sw.top - 3 >= bar.top; }), 'swap button ring inside bar');
    // zoom buttons disable at limits
    await page.evaluate(() => window.__paint.setZoom(32));
    ok(await P(() => document.querySelector('[data-cmd="zoomIn"]').disabled), 'zoom in disabled at max');
    await page.evaluate(() => window.__paint.setZoom(1));
    // hover tooltip doesn't swallow Esc
    await page.keyboard.press('Meta+KeyA');
    await page.hover('[data-cmd="save"]'); await page.waitForTimeout(700);
    await page.keyboard.press('Escape');
    ok(await P(() => window.__paint.sel) === null, 'Esc deselects even with a hover tooltip');
    // text commit lands where the editor showed it (within 1 image px)
    await page.mouse.move(5, 400);
    await page.evaluate(() => window.__paint.setZoom(2));
    await page.keyboard.press('KeyT');
    const tb = await page.locator('#image').boundingBox();
    const vb = await page.locator('#viewport').boundingBox();
    await page.mouse.click(vb.x + vb.width / 2, vb.y + vb.height / 2); // image origin may be scrolled away at 200%
    await page.keyboard.type('HIH');
    const box1 = await page.locator('#textInput').boundingBox();
    const clip = { x: box1.x - 10, y: box1.y - 10, width: box1.width + 20, height: box1.height + 20 };
    const inkBox = async () => page.evaluate(async (clip) => 0, clip);
    const shotA = await page.screenshot({ clip });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(100);
    const shotB = await page.screenshot({ clip });
    const ink = await page.evaluate(async ([a, b]) => {
      const load = (b64) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = 'data:image/png;base64,' + b64; });
      const box = (img) => { const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const g = c.getContext('2d'); g.drawImage(img, 0, 0);
        const d = g.getImageData(0, 0, c.width, c.height).data; let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
        for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) { const i = (y * c.width + x) * 4; if (d[i] < 80 && d[i + 1] < 80 && d[i + 2] < 80) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); } }
        return [x0, y0, x1, y1]; };
      return [box(await load(a)), box(await load(b))];
    }, [shotA.toString('base64'), shotB.toString('base64')]);
    const dx = Math.abs(ink[0][0] - ink[1][0]), dy = Math.abs(ink[0][1] - ink[1][1]);
    console.log('text offset css px at 200%:', dx, dy);
    ok(dx <= 1 && dy <= 1, `committed text within half an image px of editor (dx=${dx}, dy=${dy} css px at 200%)`);
    await page.evaluate(() => window.__paint.setZoom(1));
    // --- round 7 review fixes ---
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.reload(); await page.waitForTimeout(200);
    // consecutive whole-image ops share canvases: 4000x3000 keeps >= 4 rotations of undo
    {
      const big = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 4000; c.height = 3000; return c.toDataURL().split(',')[1]; });
      await page.setInputFiles('#fileInput', { name: 'photo.png', mimeType: 'image/png', buffer: Buffer.from(big, 'base64') });
      await page.waitForTimeout(500);
      for (let i = 0; i < 4; i++) await page.click('[data-cmd="rotR"]');
      ok(await P(() => window.__paint.hist.undoStack.length) === 4, 'four rotations of a 4000x3000 image all undoable, got ' + await P(() => window.__paint.hist.undoStack.length));
      for (let i = 0; i < 6; i++) await page.click('[data-cmd="rotR"]');
      const n = await P(() => window.__paint.hist.undoStack.length);
      ok(n < 10 ? /undo/i.test(await page.locator('#toast').textContent()) : true, 'trimmed history is announced (' + n + ' steps)');
      await page.evaluate(() => { window.__paint.hist.clear(); window.__paint.updateChrome && window.__paint.updateChrome(); });
      await page.keyboard.press('Alt+KeyN'); await page.waitForTimeout(100);
      await page.fill('#newW', '800'); await page.fill('#newH', '600'); await page.click('#newDlg button.primary'); await page.waitForTimeout(100);
    }
    // shortcuts are ignored mid-gesture
    const cbox = await page.locator('#viewport').boundingBox();
    const mx = cbox.x + cbox.width / 2, my = cbox.y + cbox.height / 2;
    await page.keyboard.press('KeyP');
    await page.mouse.move(mx, my); await page.mouse.down(); await page.mouse.move(mx + 20, my, { steps: 2 });
    await page.keyboard.press('Shift+KeyR'); await page.keyboard.press('Shift+Slash'); await page.keyboard.press('Meta+KeyA');
    await page.mouse.move(mx + 40, my, { steps: 2 }); await page.mouse.up();
    ok(!(await P(() => !!document.querySelector('dialog[open]'))) && await P(() => window.__paint.sel) === null, 'no dialogs or select-all mid-stroke');
    // Shift constrains a shape without moving the mouse
    await page.keyboard.press('KeyR');
    await page.mouse.move(mx, my); await page.mouse.down(); await page.mouse.move(mx + 80, my + 30, { steps: 2 });
    ok(await P(() => window.__paint.drag && window.__paint.drag.shift === false), 'shape not constrained before Shift');
    await page.keyboard.down('Shift');
    ok(await P(() => window.__paint.drag && window.__paint.drag.shift === true), 'Shift constrains shape without mouse move');
    await page.keyboard.up('Shift');
    ok(await P(() => window.__paint.drag && window.__paint.drag.shift === false), 'releasing Shift unconstrains');
    await page.mouse.up();
    // dirty marker on Save at narrow widths
    await page.setViewportSize({ width: 600, height: 700 }); await page.waitForTimeout(100);
    ok(await P(() => getComputedStyle(document.querySelector('[data-cmd="save"]'), '::after').content !== 'none'), 'save button shows unsaved dot at 600px');
    await page.setViewportSize({ width: 1280, height: 800 }); await page.waitForTimeout(100);
    // New dialog validates inline, no native bubble
    await page.evaluate(() => { window.__paint.hist.markSaved(); window.__paint.updateChrome && window.__paint.updateChrome(); });
    await page.keyboard.press('Alt+KeyN'); await page.waitForTimeout(100);
    await page.fill('#newW', '0'); await page.click('#newDlg button.primary');
    ok(await page.locator('#newDlg').evaluate((d) => d.open && d.querySelector('form').noValidate), 'New dialog stays open, novalidate');
    ok(/between 1 and 16384/.test(await page.locator('#newNote').textContent()), 'New dialog inline error');
    await page.keyboard.press('Escape'); await page.waitForTimeout(150);
    // error toasts go to an assertive live region
    await page.evaluate(() => window.__paint.flash('Save failed: x', true));
    await page.waitForTimeout(100);
    ok(/Save failed/.test(await page.locator('#srAlert').textContent()), 'error announced assertively');
    // canvas has an accessible name
    ok(/800 × 600/.test(await page.locator('#image').getAttribute('aria-label') || ''), 'image canvas labelled with size');
    ok(await page.locator('#overlay').getAttribute('aria-hidden') === 'true', 'overlay hidden from AT');
    // clicking a toolbar zoom button while typing keeps the text open
    await page.keyboard.press('KeyT');
    await page.mouse.click(mx, my); await page.keyboard.type('ok');
    await page.click('[data-cmd="zoomIn"]');
    ok(await P(() => !document.querySelector('#textInput').hidden), 'zoom click keeps text editing open');
    await page.keyboard.press('Escape');
    // --- round 8 review fixes ---
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.reload(); await page.waitForTimeout(200);
    {
      const vb = await page.locator('#viewport').boundingBox();
      const mx = vb.x + vb.width / 2, my = vb.y + vb.height / 2;
      // open text + dialog + cancel: text is never left dead
      for (const cmd of ['resize', 'help', 'new']) {
        await page.keyboard.press('KeyT');
        await page.mouse.click(mx, my); await page.keyboard.type('Hi');
        await page.click(`[data-cmd="${cmd}"]`); await page.waitForTimeout(100);
        await page.keyboard.press('Escape'); await page.waitForTimeout(150);
        const st = await P(() => [document.querySelector('#textInput').hidden, document.activeElement.id]);
        ok(st[0] === true || st[1] === 'textInput', `text not left dead after ${cmd} dialog: ${st}`);
        if (!st[0]) await page.keyboard.press('Escape');
      }
      // resize error announced + bad field marked
      await page.keyboard.press('Shift+KeyR'); await page.waitForTimeout(100);
      await page.fill('#rW', '0'); await page.click('#resizeDlg button.primary');
      ok(await P(() => !!document.querySelector('#resizeDlg [role=alert]') && /between/.test(document.querySelector('#resizeDlg [role=alert]').textContent)), 'resize error in an alert region');
      ok(await P(() => document.querySelector('#rW').getAttribute('aria-invalid') === 'true' && document.activeElement.id === 'rW'), 'bad resize field marked and focused');
      await page.keyboard.press('Escape'); await page.waitForTimeout(150);
      await page.keyboard.press('Alt+KeyN'); await page.waitForTimeout(100);
      await page.fill('#newH', '0'); await page.click('#newDlg button.primary');
      ok(await P(() => document.querySelector('#newH').getAttribute('aria-invalid') === 'true' && document.activeElement.id === 'newH'), 'bad New field marked and focused');
      await page.keyboard.press('Escape'); await page.waitForTimeout(150);
      // Save label says unsaved when dirty
      await page.keyboard.press('KeyP');
      await page.mouse.move(mx, my); await page.mouse.down(); await page.mouse.move(mx + 10, my, { steps: 2 }); await page.mouse.up();
      ok(/unsaved/i.test(await page.locator('[data-cmd="save"]').getAttribute('aria-label')), 'Save label mentions unsaved changes');
      // held ⌘S opens one picker
      const calls = await page.evaluate(async () => {
        let n = 0; window.showSaveFilePicker = () => { n++; return new Promise(() => {}); };
        window.__paint.S.fileHandle = null;
        for (let i = 0; i < 5; i++) window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', code: 'KeyS', metaKey: true, ctrlKey: true, repeat: i > 0, bubbles: true, cancelable: true }));
        await new Promise((r) => setTimeout(r, 50)); return n;
      });
      ok(calls === 1, 'held ⌘S opens one save picker, got ' + calls);
      // paste with no image says so
      await page.evaluate(() => { const dt = new DataTransfer(); dt.setData('text/plain', 'hello'); window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); });
      await page.waitForTimeout(100);
      ok(/No image on the clipboard/.test(await page.locator('#toast').textContent()), 'paste without image explains');
      // SVG explains
      await page.setInputFiles('#fileInput', { name: 't.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>') });
      await page.waitForTimeout(200);
      ok(/SVG/.test(await page.locator('#toast').textContent()), 'SVG open gives a specific message: ' + await page.locator('#toast').textContent());
      // slider value text has units
      ok(/px/.test(await page.locator('#size').getAttribute('aria-valuetext') || ''), 'size slider aria-valuetext has px');
    }
    // total-pixel cap: every way in refuses an oversized document before touching state
    {
      const dims = () => P(() => [window.__paint.img.width, window.__paint.img.height].join('x'));
      const before = await dims();
      const fake = (w, h) => `({ width: ${w}, height: ${h}, closed: false, close() { this.closed = true; } })`;
      const big = await P(`(async () => { const b = ${fake(20000, 20000)}; await window.__paint.loadFile({ name: 'huge.png' }, null, b); return b.closed; })()`);
      ok(big && await dims() === before, 'open refuses >16384 px side and frees the bitmap');
      ok(/huge\.png/.test(await page.locator('#toast').textContent()), 'open refusal names the file: ' + await page.locator('#toast').textContent());
      await P(`(async () => { await window.__paint.loadFile({ name: 'wide.png' }, null, ${fake(12000, 9000)}); })()`);
      ok(await dims() === before && /108 MP/.test(await page.locator('#toast').textContent()), 'open refuses 108 MP with sides in range: ' + await page.locator('#toast').textContent());
      await P(() => { window.__paint.S.pristine = false; window.__paint.selectAll(); });
      const ih = await P(() => window.__paint.img.height);
      const pw = 16000, ph = Math.max(ih, Math.ceil(100e6 / 16000) + 1); // both sides fit, grown area doesn't
      await P(`window.__paint.pasteImage(${fake(pw, ph)})`);
      ok(await dims() === before, 'paste that would grow past the cap is refused');
      ok(await P(() => !!window.__paint.sel && !window.__paint.sel.float), 'refused paste keeps the selection untouched');
      ok(/Can't paste/.test(await page.locator('#toast').textContent()), 'paste refusal toast');
      ok(!/\.$/.test(await page.locator('#toast').textContent()), 'one-sentence toasts have no trailing period');
      ok(await P(() => ![...document.querySelectorAll('[data-hint],[data-tip],[aria-label]')].some((e) => /\b(left|right) click/i.test((e.dataset.hint || '') + (e.dataset.tip || '') + e.getAttribute('aria-label')))), 'click verbs hyphenated (left-click/right-click)');
      await P(() => window.__paint.resizeDoc(12000, 12000, 'scale', 'mc'));
      ok(await dims() === before && /144 MP/.test(await page.locator('#toast').textContent()), 'resizeDoc refuses 144 MP');
      await P(() => document.querySelector('[data-cmd="new"]') && window.__paint.hist.markSaved());
      await page.keyboard.press('Alt+KeyN'); await page.waitForTimeout(100);
      await page.fill('#newW', '10000'); await page.fill('#newH', '10001'); await page.click('#newDlg button.primary');
      ok(await page.locator('#newDlg').evaluate((d) => d.open), 'New dialog stays open over the cap');
      ok(/100 MP/.test(await page.locator('#newNote').textContent()), 'New dialog area error: ' + await page.locator('#newNote').textContent());
      ok(await page.locator('#newH').getAttribute('aria-invalid') === 'true', 'area error marks the field edited last');
      await page.keyboard.press('Escape'); await page.waitForTimeout(150);
      await P(() => window.__paint.selectAll && document.querySelector('[data-cmd="resize"]').click());
      await page.waitForTimeout(100);
      if (await page.locator('#resizeDlg').evaluate((d) => d.open)) {
        await page.selectOption('#rUnit', 'px');
        await page.locator('#rLock').setChecked(false);
        await page.fill('#rH', '9000'); await page.fill('#rW', '12000'); await page.click('#resizeDlg button.primary');
        ok(/108 MP/.test(await page.locator('#rErr').textContent()), 'Resize dialog area error: ' + await page.locator('#rErr').textContent());
        ok(await page.locator('#rW').getAttribute('aria-invalid') === 'true', 'resize area error marks the field edited last');
        await page.keyboard.press('Escape'); await page.waitForTimeout(150);
      } else ok(false, 'resize dialog opens');
      ok(await dims() === before, 'no size change from any refused path');
    }
    // round 9: WCAG 2.2 target size (24px, or 24px pitch) for palette and swap, at wide and narrow widths
    for (const w of [1280, 820, 600]) {
      await page.setViewportSize({ width: w, height: 700 }); await page.waitForTimeout(100);
      const small = await P(() => [...document.querySelectorAll('#palette button, .well .swap')]
        .map((b) => { const r = b.getBoundingClientRect(); return [b.getAttribute('aria-label'), r.width, r.height]; })
        .filter(([, bw, bh]) => bw < 24 || bh < 24));
      ok(small.length === 0, `targets >= 24px at ${w}: ` + JSON.stringify(small.slice(0, 3)));
      ok(await P(() => { const a = document.querySelector('.well .swap').getBoundingClientRect(), b = document.querySelector('#palette button').getBoundingClientRect(); return a.right <= b.left + 0.5; }), `swap target clear of the palette at ${w}`);
      ok(await P(() => { const o = document.querySelector('#optbar'); return o.scrollWidth <= o.clientWidth + 1; }) || w < 640, `options bar not overflowing at ${w}`);
    }
    await page.setViewportSize({ width: 1280, height: 800 }); await page.waitForTimeout(100);
    // round 9: palette tooltip doesn't cover the other palette row
    for (const c of ['#ed1c24', '#b97a57']) {
      await page.hover(`#palette [data-color="${c}"]`); await page.waitForTimeout(700);
      const hit = await P(() => { const t = document.querySelector('#tip').getBoundingClientRect();
        return document.querySelector('#tip').hidden ? 'hidden' : [...document.querySelectorAll('#palette button')].filter((b) => { const r = b.getBoundingClientRect();
          return !(r.right <= t.left || r.left >= t.right || r.bottom <= t.top || r.top >= t.bottom); }).length; });
      ok(hit === 0, `palette tooltip for ${c} covers ${hit} swatches`);
      await page.mouse.move(600, 400); await page.waitForTimeout(200);
    }
    // round 9: resize tabs don't repeat the title; anchor note hidden while it doesn't apply
    await page.keyboard.press('Shift+KeyR'); await page.waitForTimeout(100);
    ok(await page.locator('#resizeDlg').evaluate((d) => d.open), 'Shift+R opens resize');
    const tabs = await P(() => [...document.querySelectorAll('#resizeDlg .seg span')].map((x) => x.textContent));
    ok(!tabs.includes(await page.locator('#resizeTitle').textContent()), 'resize tabs differ from title: ' + tabs);
    ok(await P(() => getComputedStyle(document.querySelector('#rAnchor .note')).visibility === 'hidden'), 'anchor note hidden in scale mode');
    await page.click('#resizeDlg .seg label:nth-child(2)');
    ok(await P(() => getComputedStyle(document.querySelector('#rAnchor .note')).visibility === 'visible'), 'anchor note shown in canvas mode');
    await page.keyboard.press('Escape'); await page.waitForTimeout(150);
    // round 9: error toasts can be dismissed; info toasts aren't interactive
    await P(() => window.__paint.flash('Something broke', true)); await page.waitForTimeout(200);
    const x = page.locator('#toast .toast-x');
    ok(await x.count() === 1 && await x.isVisible(), 'error toast has a dismiss button');
    if (await x.count()) { await x.click(); await page.waitForTimeout(250); }
    ok(await P(() => !document.querySelector('#toast').classList.contains('show')), 'dismiss hides the error toast');
    await P(() => window.__paint.flash('Copied')); await page.waitForTimeout(200);
    ok(await page.locator('#toast .toast-x').count() === 0 && await P(() => getComputedStyle(document.querySelector('#toast')).pointerEvents === 'none'), 'info toast has no button and ignores the pointer');
    // round 10: Esc dismisses an error toast first (keyboard path), and only then deselects
    await page.mouse.move(600, 400);
    await P(() => { window.__paint.setTool('select'); window.__paint.selectAll(); document.querySelector('#viewport').focus(); });
    await P(() => window.__paint.flash('Save failed: disk full', true)); await page.waitForTimeout(150);
    await page.keyboard.press('Escape'); await page.waitForTimeout(100);
    ok(await P(() => !document.querySelector('#toast').classList.contains('show')), 'Esc dismisses the error toast');
    ok(await P(() => !!window.__paint.sel), 'that Esc keeps the selection');
    await page.keyboard.press('Escape'); await page.waitForTimeout(100);
    ok(await P(() => !window.__paint.sel), 'next Esc deselects');
    // round 11: Esc dismisses an error toast inside the text box without cancelling the text;
    // in a modal dialog (drawn above the toast) Esc still closes the dialog
    await P(() => window.__paint.flash('Something failed', true)); await page.waitForTimeout(100);
    await page.keyboard.press('Alt+KeyN'); await page.waitForTimeout(100);
    await page.keyboard.press('Escape'); await page.waitForTimeout(150);
    ok(!(await page.locator('#newDlg').evaluate((d) => d.open)), 'Esc closes a dialog even with an error toast up');
    await page.keyboard.press('Escape'); await page.waitForTimeout(100);
    await page.keyboard.press('KeyT');
    { const b = await page.locator('#overlay').boundingBox(); await page.mouse.click(b.x + 60, b.y + 60); }
    await page.waitForTimeout(100); await page.keyboard.type('hi');
    await P(() => window.__paint.flash('Something failed', true)); await page.waitForTimeout(100);
    await page.keyboard.press('Escape'); await page.waitForTimeout(100);
    ok(await P(() => !document.querySelector('#toast').classList.contains('show') && !document.querySelector('#textInput').hidden), 'Esc in the text box dismisses the toast, text stays open');
    await page.keyboard.press('Escape'); await page.waitForTimeout(100);
    ok(await P(() => document.querySelector('#textInput').hidden), 'next Esc cancels the text');
    // final: with a keyboard-focus tooltip AND an error toast up, Esc closes the tooltip first, then the toast
    {
      const tp = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await tp.goto(url); await tp.waitForTimeout(200);
      await tp.keyboard.press('Tab'); await tp.waitForTimeout(700);
      await tp.evaluate(() => window.__paint.flash('x', true)); await tp.waitForTimeout(100);
      const st = () => tp.evaluate(() => [!document.querySelector('#tip').hidden, document.querySelector('#toast').classList.contains('show')].join());
      ok(await st() === 'true,true', 'tooltip and toast both up: ' + await st());
      await tp.keyboard.press('Escape'); await tp.waitForTimeout(100);
      ok(await st() === 'false,true', 'first Esc closes the focus tooltip: ' + await st());
      await tp.keyboard.press('Escape'); await tp.waitForTimeout(100);
      ok(await st() === 'false,false', 'second Esc closes the toast: ' + await st());
      await tp.close();
    }
    // round 12: Delete/Backspace on a focused toolbar control don't clear the selection
    await P(() => { window.__paint.setTool('select'); window.__paint.selectAll(); });
    await page.focus('#palette button'); ok(await P(() => document.activeElement.matches('#palette button')), 'swatch focused for the Delete check');
    await page.keyboard.press('Backspace'); await page.keyboard.press('Delete'); await page.waitForTimeout(50);
    ok(await P(() => !!window.__paint.sel), 'Backspace/Delete on a focused swatch keep the selection');
    await P(() => document.activeElement.blur()); await page.keyboard.press('Delete'); await page.waitForTimeout(50); // as after a pointer click
    ok(await P(() => !window.__paint.sel), 'Delete with focus released still clears the selection');
    await P(() => document.querySelector('#viewport').focus()); await page.keyboard.press('Escape');
    // round 12: [ from 11 px lands on 10, not 9
    await page.keyboard.press('KeyB'); await P(() => { document.querySelector('#size').value = 11; document.querySelector('#size').dispatchEvent(new Event('input', { bubbles: true })); document.activeElement.blur(); });
    await page.keyboard.press('BracketLeft');
    ok(await P(() => window.__paint.S.sizes.brush) === 10, '[ from 11 gives 10, got ' + await P(() => window.__paint.S.sizes.brush));
    // round 10: the swap button's box never covers the visible part of the Color 2 well
    for (const w of [1280, 820, 600]) {
      await page.setViewportSize({ width: w, height: 700 }); await page.waitForTimeout(100);
      ok(await P(() => { const a = document.querySelector('.well .swap').getBoundingClientRect(), b = document.querySelector('#secondary').getBoundingClientRect(); return a.left >= b.right - 0.5 || a.bottom <= b.top + 0.5; }), `swap clear of Color 2 at ${w}`);
      ok(await P(() => { const o = document.querySelector('#optbar'); return [...o.querySelectorAll('.opts > :not([hidden]), .colors')].every((e) => e.getBoundingClientRect().right <= o.getBoundingClientRect().right + 0.5); }), `options bar contents fit at ${w}`);
    }
    await page.setViewportSize({ width: 600, height: 700 }); await page.keyboard.press('KeyR'); await page.waitForTimeout(100);
    ok(await P(() => { const r = document.querySelector('.seg[data-for]').getBoundingClientRect(), o = document.querySelector('.opts').getBoundingClientRect(); return r.right <= o.right + 0.5; }), 'shape style still fits at 600 after swap move');
    await page.setViewportSize({ width: 1280, height: 800 }); await page.waitForTimeout(100);
    // picker hint not clipped at 600
    await page.setViewportSize({ width: 600, height: 700 }); await page.waitForTimeout(100);
    await page.keyboard.press('KeyI');
    ok(await P(() => { const h = document.querySelector('.hint[data-for~="picker"]'); return h.scrollWidth <= h.clientWidth; }), 'picker hint fits at 600');
    await page.setViewportSize({ width: 1280, height: 800 });
    ok(errs.length === 0, 'console errors: ' + JSON.stringify(errs));
    // round 9: first-run hint on a fresh blank document, gone after the first edit
    {
      const fp = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await fp.goto(url); await fp.waitForTimeout(200);
      const intro = () => fp.evaluate(() => { const e = document.querySelector('#stIntro'); return e && !e.hidden ? e.textContent : null; });
      ok(/open/i.test(await intro() || '') && /paste|drop/i.test(await intro() || ''), 'first-run hint shown: ' + await intro());
      const b = await fp.locator('#overlay').boundingBox();
      await fp.keyboard.press('KeyB');
      await fp.mouse.move(b.x + 50, b.y + 50); await fp.mouse.down(); await fp.mouse.move(b.x + 90, b.y + 70, { steps: 4 }); await fp.mouse.up();
      await fp.waitForTimeout(100);
      ok(await intro() === null, 'first-run hint gone after drawing');
      await fp.close();
    }
    // smoothed brush: lazy-brush stabiliser + quadratic curves; exact ends; tail reaches the pointer; undo is exact
    {
      const bp = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await bp.goto(url); await bp.waitForTimeout(200);
      const Q = (f, a) => bp.evaluate(f, a);
      await bp.keyboard.press('KeyB');
      await Q(() => { window.__paint.S.sizes.brush = 2; });
      const smW = () => Q(() => document.querySelector('#smoothing').getBoundingClientRect().width);
      ok(await Q(() => window.__paint.S.smoothing) === 2 && await smW() > 0, 'brush shows Smoothing, default 2');
      await bp.keyboard.press('KeyP');
      ok(await smW() === 0, 'pencil hides Smoothing');
      await bp.keyboard.press('KeyB');
      // pointer use hands focus back (letter shortcuts work); keyboard use keeps it
      await bp.click('#smoothing'); await bp.keyboard.press('KeyP');
      ok(await Q(() => window.__paint.S.tool) === 'pencil', 'shortcut works after clicking Smoothing');
      await bp.keyboard.press('KeyB');
      await bp.focus('#smoothing'); await Q(() => { const r = document.querySelector('#smoothing'); r.value = 2; r.dispatchEvent(new Event('input', { bubbles: true })); });
      await bp.keyboard.press('ArrowRight');
      ok(await Q(() => window.__paint.S.smoothing === 3 && document.activeElement.id === 'smoothing'), 'arrow key changes Smoothing and keeps focus');
      await Q(() => { const r = document.querySelector('#smoothing'); r.value = 2; r.dispatchEvent(new Event('input', { bubbles: true })); document.activeElement.blur(); });
      const z = await Q(() => window.__paint.S.zoom), bb = await bp.locator('#image').boundingBox();
      const scr = (x, y) => [bb.x + (x + 0.5) * z, bb.y + (y + 0.5) * z];
      const hash = () => Q(() => { const d = window.__paint.img.getContext('2d').getImageData(0, 0, window.__paint.img.width, window.__paint.img.height).data; let h = 0; for (let i = 0; i < d.length; i++) h = (h * 31 + d[i]) | 0; return h; });
      const px = (x, y) => Q(([x, y]) => window.__paint.img.getContext('2d').getImageData(x, y, 1, 1).data[0], [x, y]);
      // Live tail alpha at image pixel (x, y): #preview covers part of the image at its own scale.
      const ovAt = (x, y) => Q(([x, y]) => {
        const pv = document.querySelector('#preview'), z = window.__paint.S.zoom, st = pv.style;
        const k = pv.width / parseFloat(st.width) * z; // backing px per image px
        const bx = Math.floor((x + 0.5 - parseFloat(st.left) / z) * k), by = Math.floor((y + 0.5 - parseFloat(st.top) / z) * k);
        if (bx < 0 || by < 0 || bx >= pv.width || by >= pv.height) return 0;
        return pv.getContext('2d').getImageData(bx, by, 1, 1).data[3];
      }, [x, y]);
      const centre = (y0) => Q((y0) => {
        const d = window.__paint.img.getContext('2d').getImageData(0, y0 - 20, 400, 40).data, out = [];
        for (let x = 0; x < 400; x++) { let s = 0, n = 0; for (let y = 0; y < 40; y++) if (d[(y * 400 + x) * 4] < 128) { s += y; n++; } out.push(n ? s / n : null); }
        return out;
      }, y0);
      const sd = (a) => { const v = a.slice(100, 260); const m = v.reduce((s, c) => s + c, 0) / v.length; return Math.sqrt(v.reduce((s, c) => s + (c - m) ** 2, 0) / v.length); };
      const jig = (x, y0) => y0 + (x % 8 < 4 ? 3 : -3);
      const draw = async (y0, end = 300) => {
        await bp.mouse.move(...scr(60, y0)); await bp.mouse.down();
        for (let x = 61; x <= end; x++) await bp.mouse.move(...scr(x, jig(x, y0)));
      };
      const h0 = await hash();
      await draw(100);
      await bp.waitForTimeout(50);
      ok(await ovAt(300, jig(300, 100)) > 0 || await px(300, jig(300, 100)) < 128, 'mid-stroke: ink reaches the pointer');
      await bp.mouse.up(); await bp.waitForTimeout(50);
      const smooth = await centre(100);
      ok(await px(60, 100) < 128 && await px(300, jig(300, 100)) < 128, 'smoothed stroke starts and ends exactly at the pointer');
      ok(await Q(() => { const o = document.querySelector('#overlay'); return !o.getContext('2d').getImageData(0, 0, o.width, o.height).data.some((v, i) => i % 4 === 3 && v); }), 'overlay clear after the stroke');
      await Q(() => window.__paint.undo());
      ok(await hash() === h0, 'undo restores the canvas exactly after a smoothed stroke');
      await Q(() => window.__paint.redo());
      // smoothing 0 follows every sample; smoothing steadies the same jitter
      await Q(() => { const r = document.querySelector('#smoothing'); r.value = 0; r.dispatchEvent(new Event('input', { bubbles: true })); });
      ok(await Q(() => window.__paint.S.smoothing === 0 && document.querySelector('#smoothOut').textContent === '0'), 'Smoothing slider sets 0');
      await draw(200); await bp.mouse.up(); await bp.waitForTimeout(50);
      const raw = await centre(200);
      let missed = 0; for (let x = 61; x <= 300; x++) if (await px(x, jig(x, 200)) >= 128) missed++;
      ok(missed === 0, 'smoothing 0 paints every sampled point, missed ' + missed);
      ok(sd(raw) > 1.5 && sd(smooth) < sd(raw) / 2, `smoothing steadies jitter: sd ${sd(smooth).toFixed(2)} vs raw ${sd(raw).toFixed(2)}`);
      // the radius is fixed at pointerdown: zooming mid-stroke doesn't jump or break the stroke
      await Q(() => { window.__paint.S.smoothing = 2; });
      const n0 = await Q(() => window.__paint.hist.undoStack.length);
      await bp.mouse.move(...scr(60, 300)); await bp.mouse.down();
      for (let x = 61; x <= 120; x++) await bp.mouse.move(...scr(x, 300));
      await Q(() => window.__paint.setZoom(window.__paint.S.zoom * 2));
      await bp.mouse.up(); await bp.waitForTimeout(50);
      ok(await Q(() => window.__paint.drag === null && window.__paint.hist.undoStack.length) === n0 + 1, 'zoom mid-stroke: one undo step');
      ok(await px(60, 300) < 128 && await px(118, 300) < 128, 'zoom mid-stroke: stroke drawn start to end');
      await bp.close();
    }
    // non-Mac labels
    const wpage = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await wpage.addInitScript(() => Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'Win32' }));
    await wpage.goto(url); await wpage.waitForTimeout(200);
    await wpage.keyboard.press('Shift+Slash'); await wpage.waitForTimeout(100);
    const wtxt = await wpage.locator('#helpBody').textContent();
    ok(!/[⌘⇧⌫⌥]/.test(wtxt), 'no Mac glyphs in help on Windows: ' + (wtxt.match(/.{20}[⌘⇧⌫⌥].{10}/g) || []).join(' | '));
    const dangling = await wpage.evaluate(() => [...document.querySelectorAll('#helpBody kbd')].map((k) => k.textContent).filter((t) => t !== '+' && t.endsWith('+')));
    ok(dangling.length === 0, 'no dangling "+" key labels in help: ' + dangling);
    await wpage.keyboard.press('Escape'); await wpage.waitForTimeout(150);
    await wpage.hover('[data-cmd="fit"]'); await wpage.waitForTimeout(700);
    ok(!/[⌘⇧]/.test(await wpage.locator('#tip').textContent()), 'no Mac glyphs in tooltip on Windows');
    await wpage.close();
  } finally { await browser.close(); }
  console.log(`${passes} passed, ${fails} failed`);
  process.exit(fails ? 1 : 0);
})();
