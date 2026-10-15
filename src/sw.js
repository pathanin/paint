// Service worker: once the app has loaded, it opens offline too. Install caches FILES, which
// build.mjs fills in along with VERSION, a hash of those files, so a new build gets a new cache.
// The previous build's cache is kept: a tab still running that build loads its library chunks
// (content-hashed names, so they never clash) on first use, and the server has only the new ones.
// Network first: online, every load gets the current files (a new build shows at once, and a dev
// server on the same origin is never shadowed by an old build), and the cache is kept current.
// Offline, or when the network takes longer than NET_WAIT_MS, the cached copy answers.
const VERSION = '__VERSION__';
const FILES = [/* __FILES__ */];
const CACHE = 'paint-' + VERSION;
const NET_WAIT_MS = 3000;

// This app's caches other than the current one, oldest first (caches.keys() is in creation order).
const older = (keys) => keys.filter((k) => k.startsWith('paint-') && k !== CACHE);

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(older(keys).slice(0, -1).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== self.location.origin) return;
  e.respondWith(caches.open(CACHE).then((cache) => new Promise((resolve, reject) => {
    // this build's copy, else the previous build's (a chunk only an older open tab asks for)
    const cached = () => cache.match(e.request, { ignoreSearch: true }) // a launch with a query string is still the app
      .then((r) => r || caches.keys().then((keys) => {
        const prev = older(keys).pop();
        return prev && caches.open(prev).then((c) => c.match(e.request, { ignoreSearch: true }));
      }));
    const slow = setTimeout(() => cached().then((r) => r && resolve(r)), NET_WAIT_MS);
    fetch(e.request).then((res) => {
      clearTimeout(slow);
      if (res.ok) { cache.put(e.request, res.clone()); resolve(res); }
      else cached().then((r) => resolve(r || res)); // e.g. a 404 for an old build's chunk
    }, (err) => {
      clearTimeout(slow);
      cached().then((r) => (r ? resolve(r) : reject(err)));
    });
  })));
});
