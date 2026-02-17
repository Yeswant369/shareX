/**
 * ShareX — Service Worker
 * Offline shell caching and background sync for UI state.
 */

const CACHE_NAME = 'sharex-v5'; // Final fix for JS/CSS caching issues
const SHELL_URLS = [
    '/',
    '/static/css/base.css',
    '/static/css/layout.css',
    '/static/css/hero.css',
    '/static/css/animations.css',
    '/static/css/mobile.css',
    '/static/css/desktop.css',
    '/static/pwa/manifest.json'
];

// Install — cache shell
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            console.log('[SW] Caching shell');
            return cache.addAll(SHELL_URLS);
        })
    );
    self.skipWaiting();
});

// Activate — clean old caches
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) => {
            return Promise.all(
                keys.filter(key => key !== CACHE_NAME)
                    .map(key => caches.delete(key))
            );
        })
    );
    self.clients.claim();
});

// Fetch — network first, fallback to cache
self.addEventListener('fetch', (event) => {
    // Skip non-GET requests
    if (event.request.method !== 'GET') return;

    const url = new URL(event.request.url);

    // EXCLUDE specific paths from cache
    if (url.pathname.startsWith('/socket.io/') ||
        url.pathname.startsWith('/ice-config') ||
        url.pathname.startsWith('/static/js/') ||
        url.pathname.startsWith('/ws')) {
        return; // Bypass service worker (network only)
    }

    event.respondWith(
        fetch(event.request)
            .then((response) => {
                // Cache successful responses for other assets (images, css)
                if (response.ok) {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then((cache) => {
                        cache.put(event.request, clone);
                    });
                }
                return response;
            })
            .catch(() => {
                // Fallback to cache
                return caches.match(event.request).then((cached) => {
                    if (cached) return cached;
                    // Return offline page for navigation
                    if (event.request.mode === 'navigate') {
                        return caches.match('/');
                    }
                });
            })
    );
});

// Background sync support
self.addEventListener('sync', (event) => {
    if (event.tag === 'ui-state-sync') {
        console.log('[SW] Background sync: ui-state');
    }
});
