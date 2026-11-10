// Service worker de Bus Huelva: caché de la app y del mapa (uso sin conexión) + avisos Web Push.
const V = 'bush-v17';
const SHELL = ['/', '/data/network.json', '/data/calles.json', '/data/huelva.pmtiles'];

self.addEventListener('install', (e) => { e.waitUntil(caches.open(V).then((c) => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((k) => Promise.all(k.filter((x) => x !== V).map((x) => caches.delete(x)))));
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // tiempo real, información, rutas a pie, mapa raster de respaldo, analítica y el servidor de avisos: siempre por red
  if (u.pathname.startsWith('/tr/') || u.pathname.startsWith('/info/') || u.pathname.startsWith('/walk')) return;
  if (u.hostname.endsWith('openstreetmap.org') || u.hostname.endsWith('workers.dev') || u.hostname.endsWith('cloudflareinsights.com')) return;
  if (u.origin !== self.location.origin) return;
  const guarda = (r) => { if (r.ok && r.status === 200) { const cp = r.clone(); e.waitUntil(caches.open(V).then((c) => c.put(e.request, cp))); } return r; };
  // JS/CSS con hash en el nombre y el mapa (2,8 MB): no cambian, así que se sirven de la caché sin volver a descargarlos en cada arranque.
  // (El mapa se renueva subiendo la versión V.)
  if (u.pathname.startsWith('/assets/') || u.pathname.endsWith('.pmtiles') || /\.(png|webmanifest)$/.test(u.pathname)) {
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then(guarda)));
    return;
  }
  // red de líneas e índice de sitios: respuesta inmediata desde la caché y actualización en segundo plano para la próxima vez
  if (u.pathname.startsWith('/data/')) {
    e.respondWith(caches.match(e.request).then((hit) => { const red = fetch(e.request).then(guarda); if (hit) { e.waitUntil(red.catch(() => {})); return hit; } return red; }));
    return;
  }
  // la página: red primero, y si no hay conexión, la última copia guardada
  e.respondWith(fetch(e.request).then(guarda).catch(() => caches.match(e.request, { ignoreSearch: e.request.mode === 'navigate' })));
});

// ---- Web Push ----
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Bus Huelva', {
    body: d.body || '', icon: '/icon-192.png', badge: '/icon-192.png', tag: d.tag || 'bus', renotify: true, data: { url: d.url || '/' },
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => {
    // app ya abierta: se le pide que muestre la línea (sin recargar; WindowClient.navigate no es fiable en iOS)
    for (const c of cs) if ('focus' in c) { c.postMessage({ type: 'open', url }); return c.focus().catch(() => {}); }
    return self.clients.openWindow(url);
  }));
});
