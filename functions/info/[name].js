// Proxy de información pública (avisos y tarifas) del CMS de EMTUSA. Caché de 5 min.
const ORIGIN = 'https://www.emtusahuelva.com';
const OK = new Set(['avisos', 'tarifas']);

export async function onRequestGet({ params, request, waitUntil }) {
  const name = String(params.name);
  const json = (b, s = 200, extra = {}) => new Response(b, { status: s, headers: { 'content-type': 'application/json', ...extra } });
  if (!OK.has(name)) return json('{"error":"no permitido"}', 404);

  const cache = caches.default;
  const key = new Request(new URL(`/info/${name}`, request.url).toString());
  const hit = await cache.match(key);
  if (hit) return hit;

  const up = await fetch(`${ORIGIN}/api/${name}?limit=50&depth=0&sort=-publicadoEn`, { headers: { 'User-Agent': 'emtusa-pwa-personal/0.1', Accept: 'application/json' } });
  if (!up.ok) return json('{"docs":null}', 200);
  const res = json(await up.text(), 200, { 'cache-control': 'public, max-age=300' });
  waitUntil(cache.put(key, res.clone()));
  return res;
}
