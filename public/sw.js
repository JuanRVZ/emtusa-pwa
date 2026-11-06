// Service worker de Bus Huelva: caché de la app y del mapa (uso sin conexión) + avisos Web Push.
const V = 'bush-v12';
const MAP = '/data/huelva.pmtiles';
const SHELL = ['/', '/data/network.json', MAP];

self.addEventListener('install', (e) => { e.waitUntil(caches.open(V).then((c) => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((k) => Promise.all(k.filter((x) => x !== V).map((x) => caches.delete(x)))));
  self.clients.claim();
});

// El mapa se lee por trozos (cabecera Range): se sirve desde la copia guardada, con respuestas 206 propias.
let mapBuf = null;
async function mapa(req) {
  try {
    if (!mapBuf) {
      const c = await caches.open(V);
      let full = await c.match(MAP);
      if (!full) { full = await fetch(MAP); if (!full.ok) return fetch(req); c.put(MAP, full.clone()); }
      mapBuf = await full.arrayBuffer();
    }
  } catch { return fetch(req); }
  const total = mapBuf.byteLength;
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.get('range') || '');
  if (!m) return new Response(mapBuf, { status: 200, headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(total), 'Accept-Ranges': 'bytes' } });
  const start = +m[1], end = m[2] ? Math.min(+m[2], total - 1) : total - 1;
  return new Response(mapBuf.slice(start, end + 1), { status: 206, headers: { 'Content-Type': 'application/octet-stream', 'Content-Range': `bytes ${start}-${end}/${total}`, 'Content-Length': String(end - start + 1), 'Accept-Ranges': 'bytes' } });
}

self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (u.origin === self.location.origin && u.pathname === MAP) { e.respondWith(mapa(e.request)); return; }
  // tiempo real, información, rutas a pie, mapas externos, analítica y el servidor de avisos: siempre por red
  if (u.pathname.startsWith('/tr/') || u.pathname.startsWith('/info/') || u.pathname.startsWith('/walk')) return;
  if (u.hostname.endsWith('openstreetmap.org') || u.hostname.endsWith('workers.dev') || u.hostname.endsWith('cloudflareinsights.com')) return;
  // la app y los datos: red primero, y si no hay conexión, la última copia guardada
  e.respondWith(fetch(e.request).then((r) => { if (r.ok && r.status === 200) { const cp = r.clone(); caches.open(V).then((c) => c.put(e.request, cp)); } return r; }).catch(() => caches.match(e.request)));
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
    for (const c of cs) if ('focus' in c) { if ('navigate' in c) c.navigate(url).catch(() => {}); return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
