import { defineConfig } from 'vite';
export default defineConfig({
  build: { target: 'es2022' },
  server: { proxy: { '/tr': { target: 'https://www.emtusahuelva.com', changeOrigin: true, rewrite: (p) => p.replace(/^\/tr/, '/tiempo-real') } } },
});
