import { confirmDiscard, loadFile } from './fileio.js';
import { flash } from './toast.js';

// ---------- installable app ----------
// The page links its manifest (so Chrome offers to install it) and registers the service worker
// (so it opens offline).
// A dev build (npm run dev) instead removes a worker an earlier build left on the same origin,
// which would otherwise keep serving the old files.
function setUpPwa() {
  if (!/^https?:$/.test(location.protocol) || !('serviceWorker' in navigator)) return;
  if (DEV) {
    navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => r.unregister()));
    return;
  }
  const link = document.createElement('link');
  link.rel = 'manifest';
  link.href = 'manifest.webmanifest';
  document.head.appendChild(link);
  navigator.serviceWorker.register('sw.js').catch(() => {}); // offline use is a bonus, not a feature to report
}

// Files opened with the installed app (Finder's Open With, or a double-click once it's the default)
// arrive through the launch queue, as handles: Save writes back to the file. main.js sets this as
// the consumer once the app has booted (launches wait in the queue until then).
async function openLaunched(params) {
  const h = params.files && params.files[0];
  if (!h || h.kind !== 'file' || !confirmDiscard()) return;
  let file;
  try { file = await h.getFile(); }
  catch (err) { flash(`Can't open ${h.name}: ${err.message}`, true); return; }
  await loadFile(file, h);
}

export { openLaunched, setUpPwa };
