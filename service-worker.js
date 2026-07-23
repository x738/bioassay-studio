const CACHE_NAME = 'bioassay-studio-v2.5.1-r42';
const APP_SHELL = [
  './',
  './index.html',
  './styles.css?v=2.5.1-r39',
  './analysis-core.js?v=2.5.1-r4',
  './app.js?v=2.5.1-r42',
  './privacy.html',
  './manifest.webmanifest',
  './icon.svg',
  './vendor/xlsx.full.min.js',
  './vendor/chart.umd.js',
  './vendor/CHARTJS-LICENSE.txt',
  './vendor/UTIF.js',
  './vendor/UTIF-LICENSE.txt',
  './vendor/SHEETJS-LICENSE.txt',
  './THIRD_PARTY_NOTICES.txt',
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(key => key.startsWith('bioassay-studio-') && key !== CACHE_NAME).map(key => caches.delete(key))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin) return;
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request)
      .then(response => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put('./index.html', copy));
        return response;
      })
      .catch(() => caches.match('./index.html')));
    return;
  }
  event.respondWith(caches.match(event.request).then(cached => {
    const update = fetch(event.request).then(response => {
      if (response.ok) caches.open(CACHE_NAME).then(cache => cache.put(event.request, response.clone()));
      return response;
    }).catch(() => cached);
    return cached || update;
  }));
});
