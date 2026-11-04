// DuoSave Advanced Service Worker for 100% Offline PWA Support
const CACHE_NAME = 'duosave-cache-v4';

const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/icon.svg',
  '/privacy.html',
  'https://cdn.tailwindcss.com',
  'https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700;800&display=swap'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // Use catch for individual items so optional cross-origin fonts don't break install
      return Promise.all(
        STATIC_ASSETS.map((url) => {
          return cache.add(url).catch((err) => {
            console.warn('[SW] Could not precache:', url, err);
          });
        })
      );
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            console.log('[SW] Removing old cache:', key);
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // 1. API Requests: Network first with graceful offline response
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(req).catch(() => {
        return new Response(JSON.stringify({ 
          success: false, 
          offline: true, 
          error: "Offline mode active. Actions are saved locally." 
        }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' }
        });
      })
    );
    return;
  }

  // 2. Navigation Requests (Page loads): Network first, fallback to cached index.html
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).then((networkRes) => {
        if (networkRes && networkRes.status === 200) {
          const clone = networkRes.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
        }
        return networkRes;
      }).catch(async () => {
        const cached = await caches.match('/index.html') || await caches.match('/');
        return cached || new Response('Offline: Please open the app when online once to cache.', {
          status: 200,
          headers: { 'Content-Type': 'text/html' }
        });
      })
    );
    return;
  }

  // 3. Static Assets (Scripts, Styles, Images): Cache-first with background revalidation
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) {
        // Return cached immediately, fetch in background to update cache
        fetch(req).then((networkRes) => {
          if (networkRes && networkRes.status === 200 && req.method === 'GET') {
            caches.open(CACHE_NAME).then((cache) => cache.put(req, networkRes));
          }
        }).catch(() => {});
        return cached;
      }

      return fetch(req).then((networkRes) => {
        if (networkRes && networkRes.status === 200 && req.method === 'GET') {
          const clone = networkRes.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
        }
        return networkRes;
      }).catch(() => {
        // Fallback for image requests when offline
        if (req.destination === 'image') {
          return caches.match('/icon.svg');
        }
      });
    })
  );
});
