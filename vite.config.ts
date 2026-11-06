import { defineConfig } from 'vite';
export default defineConfig({
  build: { target: 'es2022' },
  server: { proxy: {
    '/walk': { target: 'https://routing.openstreetmap.de', changeOrigin: true, rewrite: (p) => { const q = new URL(p, 'http://x').searchParams; const [a1, a2] = q.get('a')!.split(','); const [b1, b2] = q.get('b')!.split(','); return `/routed-foot/route/v1/foot/${a2},${a1};${b2},${b1}?overview=full&geometries=geojson`; } },
    '/info': { target: 'https://www.emtusahuelva.com', changeOrigin: true, rewrite: (p) => p.replace(/^\/info\/(\w+).*/, '/api/$1?limit=50&depth=0&sort=-publicadoEn') }, '/tr': { target: 'https://www.emtusahuelva.com', changeOrigin: true, rewrite: (p) => p.replace(/^\/tr/, '/tiempo-real') } } },
});
