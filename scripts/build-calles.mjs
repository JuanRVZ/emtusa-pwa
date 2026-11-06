// Genera public/data/calles.json: calles, plazas, barrios y lugares de interés SOLO del municipio de Huelva (capital).
// Fuente: OpenStreetMap vía Overpass (con el límite administrativo oficial del municipio). Se ejecuta a mano o cada pocos meses.
import { writeFileSync } from 'node:fs';

const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const UA = { 'User-Agent': 'emtusa-pwa-personal/0.1 (índice de calles, uso puntual)', 'Content-Type': 'application/x-www-form-urlencoded' };
const Q = `[out:json][timeout:120];
area["boundary"="administrative"]["admin_level"="8"]["name"="Huelva"]->.h;
way(area.h)["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|pedestrian|road)(_link)?$"]["name"]->.v;
.v out tags geom;
(
  nwr(area.h)["place"~"^(suburb|neighbourhood|quarter|locality|hamlet|village|square)$"]["name"];
  nwr(area.h)["landuse"="residential"]["name"];
  nwr(area.h)["leisure"~"^(park|garden|stadium|sports_centre)$"]["name"];
  nwr(area.h)["amenity"~"^(hospital|clinic|university|college|school|marketplace|townhall|courthouse|library|theatre|cinema|bus_station|police|fire_station|post_office|arts_centre|community_centre|place_of_worship)$"]["name"];
  nwr(area.h)["tourism"~"^(museum|attraction|hotel|gallery|viewpoint)$"]["name"];
  nwr(area.h)["railway"="station"]["name"];
  nwr(area.h)["shop"="mall"]["name"];
);
out tags center;`;

let data;
for (const ep of ENDPOINTS) {
  try {
    const r = await fetch(ep, { method: 'POST', headers: UA, body: 'data=' + encodeURIComponent(Q) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    data = await r.json(); console.log('Overpass OK:', ep, data.elements.length, 'elementos'); break;
  } catch (e) { console.warn('Falló', ep, e.message); }
}
if (!data) { console.error('No se pudo consultar Overpass'); process.exit(1); }

const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const KIND = { calle: 0, plaza: 1, barrio: 2, lugar: 3 };
const items = new Map(); // clave: kind|nombre normalizado -> { name, kind, pts[] }
const add = (name, kind, pts) => { const k = kind + '|' + norm(name); const it = items.get(k) ?? { name, kind, pts: [] }; it.pts.push(...pts); items.set(k, it); };

for (const e of data.elements) {
  const name = e.tags?.name; if (!name) continue;
  if (e.type === 'way' && e.geometry && e.tags.highway) {
    add(name, /^(plaza|plazoleta|glorieta|plazuela)\b/i.test(name) ? 'plaza' : 'calle', e.geometry.map((g) => [g.lat, g.lon]));
  } else {
    const c = e.center ?? (e.lat != null ? { lat: e.lat, lon: e.lon } : null); if (!c) continue;
    const t = e.tags;
    const kind = t.place === 'square' || /^(plaza|plazoleta)\b/i.test(name) ? 'plaza' : /^(suburb|neighbourhood|quarter|locality|hamlet|village)$/.test(t.place ?? '') || t.landuse === 'residential' ? 'barrio' : 'lugar';
    add(name, kind, [[c.lat, c.lon]]);
  }
}

// un punto por nombre: el nodo más cercano al centro (así cae sobre la propia calle aunque sea curva o larga)
const out = [];
for (const it of items.values()) {
  const la = it.pts.reduce((a, p) => a + p[0], 0) / it.pts.length, lo = it.pts.reduce((a, p) => a + p[1], 0) / it.pts.length;
  let best = it.pts[0], bd = Infinity;
  for (const p of it.pts) { const d = (p[0] - la) ** 2 + ((p[1] - lo) * 0.8) ** 2; if (d < bd) { bd = d; best = p; } }
  out.push([it.name, KIND[it.kind], +best[0].toFixed(5), +best[1].toFixed(5)]);
}
out.sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0], 'es'));
const por = [0, 0, 0, 0]; out.forEach((o) => por[o[1]]++);
writeFileSync('public/data/calles.json', JSON.stringify({ generado: new Date().toISOString().slice(0, 10), fuente: 'OpenStreetMap (municipio de Huelva)', k: ['calle', 'plaza', 'barrio', 'lugar'], d: out }));
console.log(`calles ${por[0]}, plazas ${por[1]}, barrios ${por[2]}, lugares ${por[3]} → ${out.length} entradas`);
