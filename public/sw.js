// sw.js — service worker: keeps the console shell available offline.
// Network first, so a new build is never hidden behind a stale cache.
const CACHE = 'op-console-shell-v1';
const SHELL = ['./', 'index.html', 'style.css', 'main.js', 'sound.js', 'chip.js', 'input-worker.js', 'ppu.wasm'];

self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {})); self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });
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
