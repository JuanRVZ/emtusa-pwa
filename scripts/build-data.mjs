// Construye public/data/network.json: líneas, recorridos y paradas con coordenadas.
// Fuente: API pública de la web oficial (CMS) + payload embebido en /lineas/{n}.
import { writeFileSync } from 'node:fs';
const BASE = 'https://www.emtusahuelva.com';
const UA = { 'User-Agent': 'emtusa-pwa-personal/0.1 (proyecto personal sin ánimo de lucro)' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cms = await (await fetch(`${BASE}/api/lineas?limit=100&depth=2`, { headers: UA })).json();
const stops = new Map(); // codigo -> {codigo,nombre,lat,lon,lineas:Set}
const lines = [];

for (const l of cms.docs) {
  if (!l.recorridos?.length) continue;
  await sleep(400); // cortesía con el servidor
  const html = await (await fetch(`${BASE}/lineas/${encodeURIComponent(l.codigo)}`, { headers: UA })).text();
  const t = html.replace(/\\"/g, '"');
  const coords = new Map();
  for (const m of t.matchAll(/"nombre":"([^"]+)","codigo":"([^"]+)","lat":(-?[\d.]+),"lon":(-?[\d.]+)/g)) {
    coords.set(m[2], { lat: +m[3], lon: +m[4] });
  }
  const recorridos = [];
  for (const r of l.recorridos) {
    const codes = r.paradas.filter((p) => p.codigo).map((p) => p.codigo);
    recorridos.push({ sentido: r.sentido, paradas: codes });
  }
  for (const r of l.recorridos) for (const p of r.paradas) {
    if (!p.codigo) continue;
    const c = coords.get(p.codigo);
    const s = stops.get(p.codigo) ?? { codigo: p.codigo, nombre: p.nombre, lat: null, lon: null, lineas: new Set() };
    if (c) { s.lat = c.lat; s.lon = c.lon; }
    s.lineas.add(l.codigo);
    stops.set(p.codigo, s);
  }
  // geometría real por calles (OSRM público, una sola vez en el build)
  for (const rec of recorridos) {
    const pts = rec.paradas.map((c) => stops.get(c)).filter((x) => x?.lat != null);
    rec.geom = pts.flatMap((x) => [x.lat, x.lon]); // por defecto: rectas entre paradas
    rec.pos = null;
    if (pts.length === rec.paradas.length && pts.length >= 2) {
      await sleep(1100);
      try {
        const co = pts.map((x) => `${x.lon},${x.lat}`).join(';');
        const j = await (await fetch(`https://router.project-osrm.org/route/v1/driving/${co}?overview=full&geometries=geojson&continue_straight=true`, { headers: UA })).json();
        if (j.code === 'Ok') {
          rec.geom = j.routes[0].geometry.coordinates.flatMap(([lo, la]) => [+la.toFixed(5), +lo.toFixed(5)]);
          let acc = 0; rec.pos = [0, ...j.routes[0].legs.map((lg) => (acc += lg.distance))].map(Math.round);
          rec.len = Math.round(j.routes[0].distance);
        }
      } catch (e) { console.warn('  OSRM falló para', l.codigo, rec.sentido, e.message); }
    }
    console.log('  ', rec.sentido, rec.pos ? `calles ✓ ${rec.len} m` : 'solo rectas');
  }
  lines.push({ codigo: l.codigo, nombre: l.nombre, color: l.color, recorridos });
  console.log(l.codigo.padEnd(5), l.nombre, '→', coords.size, 'coords');
}

const out = {
  generado: new Date().toISOString(),
  lineas: lines,
  paradas: [...stops.values()].map((s) => ({ ...s, lineas: [...s.lineas] })),
};
const sinCoord = out.paradas.filter((s) => s.lat == null).length;
writeFileSync('public/data/network.json', JSON.stringify(out));
console.log(`\n${out.lineas.length} líneas, ${out.paradas.length} paradas (${sinCoord} sin coordenadas)`);
