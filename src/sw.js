// Service worker: once the app has loaded over http(s), it opens offline too. (file:// has no
// service workers; it doesn't need one.) Install caches FILES, which build.mjs fills in along with
// VERSION, a hash of those files, so a new build replaces the cache.
// Network first: online, every load gets the current files (a new build shows at once, and a dev
// server on the same origin is never shadowed by an old build), and the cache is kept current.
// Offline, or when the network takes longer than NET_WAIT_MS, the cached copy answers.
const VERSION = '__VERSION__';
const FILES = [/* __FILES__ */];
const CACHE = 'paint-' + VERSION;
const NET_WAIT_MS = 3000;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('paint-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== self.location.origin) return;
  e.respondWith(caches.open(CACHE).then((cache) => new Promise((resolve, reject) => {
    const cached = () => cache.match(e.request, { ignoreSearch: true }); // a launch with a query string is still the app
    const slow = setTimeout(() => cached().then((r) => r && resolve(r)), NET_WAIT_MS);
    fetch(e.request).then((res) => {
      clearTimeout(slow);
      if (res.ok) cache.put(e.request, res.clone());
      resolve(res);
    }, (err) => {
      clearTimeout(slow);
      cached().then((r) => (r ? resolve(r) : reject(err)));
    });
  })));
});
