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
  const recorridos = l.recorridos.map((r) => ({
    sentido: r.sentido,
    paradas: r.paradas.filter((p) => p.codigo).map((p) => p.codigo),
  }));
  for (const r of l.recorridos) for (const p of r.paradas) {
    if (!p.codigo) continue;
    const c = coords.get(p.codigo);
    const s = stops.get(p.codigo) ?? { codigo: p.codigo, nombre: p.nombre, lat: null, lon: null, lineas: new Set() };
    if (c) { s.lat = c.lat; s.lon = c.lon; }
    s.lineas.add(l.codigo);
    stops.set(p.codigo, s);
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
