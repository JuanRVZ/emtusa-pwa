// Proxy de tiempo real hacia la web oficial de EMTUSA (misma origin que la PWA → sin CORS).
// Solo permite /tiempo-real/buses, /tiempo-real/parada/{codigo} y /tiempo-real/{linea}.
const ORIGIN = 'https://www.emtusahuelva.com';
const OK = /^(buses|parada\/[A-Za-z0-9]{1,8}|[A-Za-z0-9]{1,5})$/;

export async function onRequestGet({ params, request, waitUntil }) {
  const path = [].concat(params.path ?? []).join('/');
  if (!OK.test(path)) return new Response('{"error":"ruta no permitida"}', { status: 404, headers: { 'content-type': 'application/json' } });

  const cache = caches.default;
  const key = new Request(new URL(`/tr/${path}`, request.url).toString());
  const hit = await cache.match(key);
  if (hit) return hit;

  const up = await fetch(`${ORIGIN}/tiempo-real/${path}`, {
    headers: { 'User-Agent': 'emtusa-pwa-personal/0.1', Accept: 'application/json' },
  });
  const body = await up.text();
  const res = new Response(up.ok ? body : '{"llegadas":null,"buses":null}', {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=5' },
  });
  if (up.ok) waitUntil(cache.put(key, res.clone()));
  return res;
}
