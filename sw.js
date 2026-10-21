/* Dispatch Scan Register – service worker.
   Lets Android install the app and open it without internet.
   App files are fetched fresh when online (so updates show at once) and from the saved copy when offline.
   Google Sheet requests are never cached. */
const CACHE = 'dsr-v7';
const SHELL = ['./', './index.html', './app.js', './style.css', './manifest.json', './icon-192.png', './icon-512.png', './icon.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.hostname.endsWith('google.com') || url.hostname.endsWith('googleusercontent.com')) return;   // live data, never cached
  const isLib = /cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|fastly\.jsdelivr\.net|fonts\.(googleapis|gstatic)\.com/.test(url.hostname);
  if (url.origin !== location.origin && !isLib) return;
  if (isLib) {   // libraries and fonts never change at a fixed version: saved copy first
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); return res; })));
    return;
  }
  e.respondWith(fetch(req).then(res => {     // app files: newest first, saved copy when offline
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req).then(hit => hit || caches.match('./index.html'))));
});
