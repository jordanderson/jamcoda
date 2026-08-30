const SOUNDFONT_BASE_URL = 'https://storage.googleapis.com/magentadata/js/soundfonts/sgm_plus/';
const SOUNDFONT_CACHE_NAME = 'jamcoda-soundfont-cache-v2';
const PIANO_PATH_SEGMENT = '/acoustic_grand_piano-';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const cacheNames = await caches.keys();
    await Promise.all(
      cacheNames
        .filter((name) => name.startsWith('jamcoda-soundfont-cache-') && name !== SOUNDFONT_CACHE_NAME)
        .map((name) => caches.delete(name))
    );

    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  if (!request.url.startsWith(SOUNDFONT_BASE_URL)) return;
  if (!request.url.includes(PIANO_PATH_SEGMENT)) return;

  event.respondWith((async () => {
    const cache = await caches.open(SOUNDFONT_CACHE_NAME);
    const cached = await cache.match(request);
    if (cached) {
      return cached;
    }

    const response = await fetch(request);
    if (response && (response.ok || response.type === 'opaque')) {
      await cache.put(request, response.clone());
    }
    return response;
  })());
});
