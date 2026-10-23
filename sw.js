/**
 * 舒呼 (SootheBreath) — PWA Service Worker (sw.js)
 * Version: v10.1.0 (ES6 14-Module Architecture with v10.1 Clinical UI & UX Enhancements)
 */

const CACHE_NAME = 'soothebreath-v10.1.0';
const APP_SHELL_ASSETS = [
  './',
  './index.html',
  './style.css?v=10.1',
  './app.js?v=10.1',
  './state.js',
  './dom.js',
  './vision.js',
  './camera.js',
  './cvEngine.js',
  './tts.js',
  './feedback.js',
  './scoring.js',
  './calibration.js',
  './training.js',
  './interactive3d.js',
  './summary.js',
  './uiControls.js',
  './manifest.json',
  './1.jpg',
  './2.jpg',
  './3.jpg',
  './4.jpg'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(APP_SHELL_ASSETS).catch((err) => {
        console.warn('[SW v10.1] Partial cache warning:', err);
      });
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((name) => {
          if (name !== CACHE_NAME) {
            return caches.delete(name);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      const fetchPromise = fetch(event.request).then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
          const responseClone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseClone);
          });
        }
        return networkResponse;
      }).catch(() => cachedResponse);

      return cachedResponse || fetchPromise;
    })
  );
});
