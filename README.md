# Bus Huelva (PWA)

PWA no oficial para consultar los autobuses de EMTUSA Huelva en tiempo real: mapa con buses en vivo, llegadas por parada, paradas cercanas y favoritos.

Los datos proceden de la web pública de EMTUSA (https://www.emtusahuelva.com). Proyecto personal, sin afiliación con EMTUSA.

## Desarrollo
```
npm install
npm run data      # regenera public/data/network.json (líneas y paradas)
npm run dev       # Vite con proxy /tr -> emtusahuelva.com/tiempo-real
npm run pages:dev # build + emulación local de Cloudflare Pages
```

## Despliegue
Cloudflare Pages: build `npm run build`, salida `dist`. `functions/tr` actúa de proxy con caché de 20 s.
