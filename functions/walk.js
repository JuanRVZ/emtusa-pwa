// Proxy de rutas a pie (OSRM de OpenStreetMap). Solo dentro del área de Huelva. Caché 1 día.
const BOX = { latMin: 37.10, latMax: 37.45, lonMin: -7.20, lonMax: -6.70 };
const pt = (s) => { const [la, lo] = String(s ?? '').split(',').map(Number); return Number.isFinite(la) && Number.isFinite(lo) && la >= BOX.latMin && la <= BOX.latMax && lo >= BOX.lonMin && lo <= BOX.lonMax ? [la, lo] : null; };

export async function onRequestGet({ request, waitUntil }) {
  const u = new URL(request.url);
  const a = pt(u.searchParams.get('a')), b = pt(u.searchParams.get('b'));
  const json = (t, s = 200, h = {}) => new Response(t, { status: s, headers: { 'content-type': 'application/json', ...h } });
  if (!a || !b) return json('{"error":"parámetros no válidos"}', 400);

  const cache = caches.default;
  const key = new Request(`${u.origin}/walk?a=${a.map((x) => x.toFixed(4))}&b=${b.map((x) => x.toFixed(4))}`);
  const hit = await cache.match(key); if (hit) return hit;

  const up = await fetch(`https://routing.openstreetmap.de/routed-foot/route/v1/foot/${a[1]},${a[0]};${b[1]},${b[0]}?overview=full&geometries=geojson`, { headers: { 'User-Agent': 'emtusa-pwa-personal/0.1' } });
  if (!up.ok) return json('{"code":"Error"}', 200);
  const res = json(await up.text(), 200, { 'cache-control': 'public, max-age=86400' });
  waitUntil(cache.put(key, res.clone()));
  return res;
}
