/**
 * BreathGuide COPD — Service Worker (sw.js)
 * Offline shell caching for Progressive Web App deployment
 */


const CACHE_NAME = 'breathguide-copd-v1.0.1';


const PRECACHE_ASSETS = [
  './',
  './index.html',
  './style.css',
  './css/style.css',
  './app.js',
  './js/app.js',
  './manifest.json'
];


// Install: Cache App Shell resiliently (supports both flat root and css/js subfolders)
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      console.log('[Service Worker] Precaching app shell assets');
      await Promise.allSettled(
        PRECACHE_ASSETS.map((url) =>
          cache.add(url).catch((err) => {
            console.debug('[Service Worker] Optional path skipped:', url, err);
          })
        )
      );
    }).then(() => self.skipWaiting())
  );
});


// Activate: Clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keyList) => {
      return Promise.all(
        keyList.map((key) => {
          if (key !== CACHE_NAME) {
            console.log('[Service Worker] Removing old cache:', key);
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});


// Fetch: Cache-First with runtime caching for MediaPipe CDN & Google Storage models
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;


  const url = new URL(event.request.url);


  // External MediaPipe CDN, Tailwind CDN, and Google Storage models
  if (url.origin !== self.location.origin) {
    event.respondWith(
      caches.match(event.request).then((cachedResponse) => {
        if (cachedResponse) return cachedResponse;
        return fetch(event.request).then((networkResponse) => {
          if (
            networkResponse &&
            networkResponse.status === 200 &&
            (url.hostname.includes('jsdelivr') ||
              url.hostname.includes('googleapis') ||
              url.hostname.includes('tailwindcss'))
          ) {
            const responseClone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, responseClone);
            });
          }
          return networkResponse;
        }).catch(() => cachedResponse);
      })
    );
    return;
  }


  // Local assets: Network-First for HTML/JS/CSS during updates, fallback to Cache
  event.respondWith(
    fetch(event.request)
      .then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          const responseClone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseClone);
          });
        }
        return networkResponse;
      })
      .catch(() => {
        return caches.match(event.request).then((cachedResponse) => {
          if (cachedResponse) return cachedResponse;
          if (event.request.mode === 'navigate') {
            return caches.match('./index.html');
          }
        });
      })
  );
});