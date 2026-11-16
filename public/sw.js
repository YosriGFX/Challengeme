// sw.js — keeps the console's shell available when the network is not. Network first, so
// a new build is never hidden behind an old copy. Games are never stored: they do not
// exist on the device.
const CACHE = 'op-console-2';
const SHELL = ['./', 'index.html', 'style.css', 'main.js', 'screen.js', 'pad.js', 'sound.js', 'chip.js', 'net.js', 'ppu.wasm'];

self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {})); self.skipWaiting(); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((names) => Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/match/')) return;
  e.respondWith(
    fetch(e.request).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || Response.error()))
  );
});
