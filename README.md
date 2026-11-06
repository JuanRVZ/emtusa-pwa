# Bus Huelva (PWA no oficial)

PWA para consultar los autobuses de EMTUSA Huelva en tiempo real, pensada para iPhone (instalable desde Safari), pero funciona en cualquier navegador moderno.
Los datos proceden de la web pública de EMTUSA (https://www.emtusahuelva.com). Proyecto personal, sin afiliación con EMTUSA.

## Qué hace
- **Líneas:** elige una línea y mira su recorrido por las calles, los buses moviéndose en directo y los minutos que faltan a cada parada.
- **Mi parada:** minutos, paradas restantes y distancia del bus; **¿llego a tiempo?** según tu ubicación.
- **Planificador:** alternativas (más rápida / menos trasbordos / menos caminata), hora de salida o de llegada, y caminatas por calles reales.
- **Alarmas:** "avísame a X min", "me bajo aquí" (GPS) y alarmas en la nube que suenan con la app cerrada (Web Push), incluso recurrentes (L–V a las 8:00).
- **Inicio:** avisos de EMTUSA, favoritas con próximos buses, Casa/Trabajo y tarifas. Enlaces compartibles (`/?l=8&d=0&p=1034`).

## Arquitectura
| Pieza | Dónde | Para qué |
|---|---|---|
| App (Vite + TypeScript + Leaflet) | `src/` | Interfaz, planificador, rutas y alarmas locales |
| Proxy de tiempo real, info y rutas a pie | `functions/` (Cloudflare Pages Functions) | Evita CORS y cachea 20 s – 1 día |
| Red de líneas y paradas | `public/data/network.json` | Generada por `scripts/build-data.mjs` (CMS de EMTUSA + OSRM) |
| Mapa propio | `public/data/huelva.pmtiles` (2,8 MB) | Extracto vectorial de OpenStreetMap (Protomaps), estilos claro/oscuro; se dibuja con `protomaps-leaflet` y funciona sin conexión |
| Avisos push y alarmas | `worker/` (Cloudflare Worker + D1 + cron cada minuto) | Vigila los buses y envía Web Push |

Todo cabe en los planes gratuitos de Cloudflare para uso personal.

## Desarrollo
```
npm install
npm run dev        # Vite con proxies /tr, /info y /walk
npm run build      # tsc + vite build
npm run data       # regenera la red de líneas (tarda ~1 min, cortesía con los servidores)
npm run health     # comprueba que la API de EMTUSA sigue igual
```

## Regenerar el mapa (opcional, una vez al año aprox.)
Con la herramienta [`pmtiles`](https://github.com/protomaps/go-pmtiles) (verifica el hash del release):
```
pmtiles extract https://build.protomaps.com/AAAAMMDD.pmtiles public/data/huelva.pmtiles --bbox=-7.05,37.18,-6.82,37.36 --maxzoom=15
```
Las compilaciones diarias están en https://maps.protomaps.com/builds/. Para revisar los estilos: `/?mapa=claro` o `/?mapa=oscuro`.

## Despliegue
```
npm run build && npx wrangler pages deploy dist --project-name bus-huelva --branch main
cd worker && npx wrangler deploy      # Worker de avisos (requiere D1 y el secreto VAPID_PRIVATE)
```
Worker, primera vez: `wrangler d1 create bus-huelva`, poner el `database_id` en `worker/wrangler.toml`, `wrangler d1 execute bus-huelva --remote --file=schema.sql`, y `wrangler secret put VAPID_PRIVATE` (clave privada VAPID; la pública va en `[vars]`).

## Mantenimiento automático (GitHub Actions)
- **CI:** compila en cada push.
- **Comprobar API de EMTUSA:** cada día; si algo cambia de forma, abre una issue.
- **Actualizar red de líneas:** cada lunes; si cambian recorridos o paradas, abre un PR.

## Limitaciones conocidas
- Son endpoints internos de la web de EMTUSA, sin contrato: pueden cambiar sin aviso (de ahí la comprobación diaria).
- Los minutos "~" son estimaciones por la posición del bus (4,5 m/s + 20 s por parada), no datos oficiales.
- Las alarmas locales requieren la app abierta con la pantalla encendida (iOS pausa las webs en segundo plano); las de la nube no.
- En iOS el Web Push solo funciona con la app añadida a la pantalla de inicio (iOS 16.4 o superior).
- El Worker guarda posiciones de buses cada minuto (30 días) para poder calcular tiempos reales entre paradas; no guarda datos personales (solo tu suscripción push y tus alarmas).
