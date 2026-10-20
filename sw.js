/**
 * 舒呼 (SootheBreath) — PWA Service Worker (sw.js)
 * Version: v9.1.0 (ES6 14-Module Architecture with P0–P2 60 FPS Optimized 3D Interactive Mode)
 */

const CACHE_NAME = 'soothebreath-v9.1.0';
const APP_SHELL_ASSETS = [
  './',
  './index.html',
  './style.css?v=9.1',
  './app.js?v=9.1',
  './state.js',
  './dom.js',
  './vision.js',
  './camera.js',
  './cvEngine.js',
  './scoring.js',
  './tts.js',
  './feedback.js',
  './calibration.js',
  './interactive3d.js',
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
      return cache.addAll(APP_SHELL_ASSETS).catch((err) => {
        console.warn('[SW v9.1] Partial cache warning:', err);
      });
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);
  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(event.request)
        .then((networkResp) => {
          if (networkResp && networkResp.status === 200) {
            const copy = networkResp.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return networkResp;
        })
        .catch(() => caches.match(event.request))
    );
  }
});
