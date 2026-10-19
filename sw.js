/**
 * 舒呼(SootheBreath) 呼吸復康訓練 Service Worker (sw.js v8.0.0)
 * Network-First strategy for local files + Precache for offline & Human Mode JPG assets
 */

const CACHE_NAME = 'soothebreath-v8.0.0';

const PRECACHE_ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './state.js',
  './dom.js',
  './vision.js',
  './camera.js',
  './cvEngine.js',
  './scoring.js',
  './tts.js',
  './feedback.js',
  './calibration.js',
  './training.js',
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
      return Promise.allSettled(
        PRECACHE_ASSETS.map((asset) => cache.add(asset).catch(() => {}))
      );
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keyList) => {
      return Promise.all(
        keyList.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // External MediaPipe WASM / Task models / Tailwind CDN: Cache-First for fast & offline startup
  if (url.origin !== location.origin) {
    event.respondWith(
      caches.match(event.request).then((cachedResponse) => {
        if (cachedResponse) return cachedResponse;
        return fetch(event.request).then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200 &&
              (url.hostname.includes('jsdelivr') || url.hostname.includes('googleapis') || url.hostname.includes('tailwindcss'))) {
            const responseClone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseClone));
          }
          return networkResponse;
        }).catch(() => cachedResponse);
      })
    );
    return;
  }

  // Local HTML/JS/CSS/JPG: Network-First with Offline Cache Fallback
  event.respondWith(
    fetch(event.request)
      .then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          const responseClone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseClone));
        }
        return networkResponse;
      })
      .catch(() => caches.match(event.request))
  );
});
