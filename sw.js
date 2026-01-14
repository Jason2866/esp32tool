// Service Worker for ESP32Tool PWA
const CACHE_NAME = 'esp32tool-v2.0.1';
const RUNTIME_CACHE = 'esp32tool-runtime';

// Core files to cache on install (relative paths work for any deployment path)
// This ensures the app works completely offline after installation
const CORE_ASSETS = [
  // App shell
  './',
  './index.html',
  './install-android.html',
  
  // Stylesheets
  './css/style.css',
  './css/light.css',
  './css/dark.css',
  
  // JavaScript
  './js/script.js',
  './js/utilities.js',
  './js/webusb-serial.js',
  './js/modules/esptool.js',
  
  // PWA manifest
  './manifest.json',
  
  // Icons (all sizes referenced in manifest)
  './icons/icon-72.png',
  './icons/icon-96.png',
  './icons/icon-128.png',
  './icons/icon-144.png',
  './icons/icon-152.png',
  './icons/icon-192.png',
  './icons/icon-384.png',
  './icons/icon-512.png',
  './apple-touch-icon.png',
  './favicon.ico',
  
  // WASM modules (required for filesystem operations)
  './src/wasm/littlefs/index.js',
  './src/wasm/littlefs/littlefs.js',
  './src/wasm/littlefs/littlefs.wasm',
  './src/wasm/fatfs/index.js',
  './src/wasm/fatfs/fatfs.wasm'
];

// Install event - cache core assets
self.addEventListener('install', (event) => {
  console.log('[SW] Installing service worker...');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('[SW] Caching core assets');
        return cache.addAll(CORE_ASSETS);
      })
      .then(() => {
        console.log('[SW] Skipping waiting - activating immediately');
        return self.skipWaiting();
      })
  );
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
  console.log('[SW] Activating service worker...');
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME && name !== RUNTIME_CACHE)
          .map((name) => {
            console.log('[SW] Deleting old cache:', name);
            return caches.delete(name);
          })
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch event - network first, fallback to cache
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET requests
  if (request.method !== 'GET') {
    return;
  }

  // Skip chrome-extension and other non-http(s) requests
  if (!url.protocol.startsWith('http')) {
    return;
  }

  // Network first strategy for HTML and API calls
  if (request.headers.get('accept')?.includes('text/html')) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          // Only cache successful responses
          if (response && response.ok) {
            // Clone and cache the response
            const responseClone = response.clone();
            caches.open(RUNTIME_CACHE).then((cache) => {
              cache.put(request, responseClone);
            });
          }
          return response;
        })
        .catch(() => {
          // Fallback to cache
          return caches.match(request);
        })
    );
    return;
  }

  // Cache first strategy for static assets
  event.respondWith(
    caches.match(request)
      .then((cachedResponse) => {
        if (cachedResponse) {
          return cachedResponse;
        }

        return fetch(request).then((response) => {
          // Don't cache non-successful responses
          if (!response || response.status !== 200 || response.type === 'error') {
            return response;
          }

          // Clone and cache the response
          const responseClone = response.clone();
          caches.open(RUNTIME_CACHE).then((cache) => {
            cache.put(request, responseClone);
          });

          // CRITICAL: Return the response after caching
          return response;
        }).catch(() => {
          // Network failed and not in cache - return a basic error response
          // or optionally return an offline fallback
          console.warn('[SW] Network request failed for:', request.url);
          return new Response('Network unavailable', { status: 503 });
        });
      })
  );
});

// Handle messages from clients
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
