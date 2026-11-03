// DuoSave Service Worker for Google Play / PWA
const CACHE_NAME = 'duosave-v1';

self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(clients.claim());
});

self.addEventListener('fetch', (e) => {
  // Let network requests pass through normally
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});
