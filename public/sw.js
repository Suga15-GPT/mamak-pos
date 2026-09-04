// sw.js — precaches the app shell + last GET /api/menu response (phase 07), so
// a reload while offline still opens a working app with the menu. Network-first
// for API GETs (falls back to cache when offline), cache-first for static
// assets. Never caches POSTs — the outbox (public/js/outbox.js) owns those;
// caching a write here would silently hide the very failures it exists to queue.
//
// Bump CACHE_VERSION on each deploy; old caches are dropped on activate.
const CACHE_VERSION = 'v1';
const CACHE_NAME = `mamak-pos-${CACHE_VERSION}`;

const SHELL_URLS = [
  '/',
  '/index.html',
  '/style.css',
  '/api.js',
  '/js/state.js',
  '/js/outbox.js',
  '/js/pos.js',
  '/js/kitchen.js',
  '/js/dashboard.js',
  '/js/admin.js',
  '/js/nav.js',
  '/js/main.js',
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL_URLS)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return; // never cache POSTs

  const url = new URL(request.url);
  event.respondWith(url.pathname.startsWith('/api/') ? networkFirst(request) : cacheFirst(request));
});

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const res = await fetch(request);
  if (res.ok) (await caches.open(CACHE_NAME)).put(request, res.clone());
  return res;
}

async function networkFirst(request) {
  try {
    const res = await fetch(request);
    if (res.ok) (await caches.open(CACHE_NAME)).put(request, res.clone());
    return res;
  } catch (e) {
    const cached = await caches.match(request);
    if (cached) return cached;
    throw e;
  }
}
