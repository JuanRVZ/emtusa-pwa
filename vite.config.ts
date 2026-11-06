import { defineConfig } from 'vite';
export default defineConfig({
  build: { target: 'es2022' },
  server: { proxy: {
    '/info': { target: 'https://www.emtusahuelva.com', changeOrigin: true, rewrite: (p) => p.replace(/^\/info\/(\w+).*/, '/api/$1?limit=50&depth=0&sort=-publicadoEn') }, '/tr': { target: 'https://www.emtusahuelva.com', changeOrigin: true, rewrite: (p) => p.replace(/^\/tr/, '/tiempo-real') } } },
});
