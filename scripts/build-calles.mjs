// Genera public/data/calles.json: calles, plazas, barrios, lugares, comercios, restaurantes y servicios SOLO del municipio de Huelva.
// Fuente: OpenStreetMap vía Overpass (con el límite administrativo oficial del municipio). Se ejecuta a mano cada pocos meses.
// Formato: { k: [tipos], l: [etiquetas], d: [[nombre, tipo, lat, lon, etiqueta, dirección?], ...] }
import { writeFileSync, readFileSync } from 'node:fs';

const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];
const UA = { 'User-Agent': 'emtusa-pwa-personal/0.1 (índice de calles, uso puntual)', 'Content-Type': 'application/x-www-form-urlencoded' };
const KEYS = ['amenity', 'shop', 'office', 'craft', 'tourism', 'leisure', 'healthcare', 'historic'];
const Q = `[out:json][timeout:180];
area["boundary"="administrative"]["admin_level"="8"]["name"="Huelva"]->.h;
way(area.h)["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|pedestrian|road)(_link)?$"]["name"]->.v;
.v out tags geom;
(
  nwr(area.h)["place"~"^(suburb|neighbourhood|quarter|locality|hamlet|village|square)$"]["name"];
  nwr(area.h)["landuse"="residential"]["name"];
  ${KEYS.map((k) => `nwr(area.h)["${k}"]["name"];`).join('\n  ')}
  nwr(area.h)["railway"="station"]["name"];
  nwr(area.h)["building"~"^(university|college|school|kindergarten|hospital|civic|public|government|commercial|retail|hotel|church|cathedral|stadium|train_station|museum)$"]["name"];
);
out tags center;`;

// Los servidores públicos de Overpass se saturan a menudo (502/504): se reintenta en rondas, con espera creciente.
let data;
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
for (let ronda = 1; ronda <= 4 && !data; ronda++) {
  for (const ep of ENDPOINTS) {
    try {
      const r = await fetch(ep, { method: 'POST', headers: UA, body: 'data=' + encodeURIComponent(Q), signal: AbortSignal.timeout(200000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      data = await r.json(); console.log(`Overpass OK (ronda ${ronda}):`, ep, data.elements.length, 'elementos'); break;
    } catch (e) { console.warn(`Falló (ronda ${ronda})`, ep, e.message); }
  }
  if (!data && ronda < 4) { const ms = ronda * 45000; console.warn(`Reintentando en ${ms / 1000} s…`); await espera(ms); }
}
if (!data) { console.error('No se pudo consultar Overpass'); process.exit(1); }

const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const KINDS = ['calle', 'plaza', 'barrio', 'lugar', 'comercio', 'comida', 'servicio'];
const K = Object.fromEntries(KINDS.map((k, i) => [k, i]));

// etiqueta en español y tipo por valor de etiqueta OSM (los valores no listados de "amenity" se ignoran para evitar ruido)
const AMENITY = {
  restaurant: ['Restaurante', 'comida'], cafe: ['Cafetería', 'comida'], bar: ['Bar', 'comida'], pub: ['Pub', 'comida'], fast_food: ['Comida rápida', 'comida'], ice_cream: ['Heladería', 'comida'], food_court: ['Restaurantes', 'comida'], nightclub: ['Discoteca', 'comida'],
  pharmacy: ['Farmacia', 'servicio'], bank: ['Banco', 'servicio'], post_office: ['Correos', 'servicio'], fuel: ['Gasolinera', 'servicio'], car_wash: ['Lavadero de coches', 'servicio'], car_rental: ['Alquiler de coches', 'servicio'], driving_school: ['Autoescuela', 'servicio'],
  townhall: ['Ayuntamiento', 'servicio'], police: ['Policía', 'servicio'], fire_station: ['Bomberos', 'servicio'], courthouse: ['Juzgado', 'servicio'], social_facility: ['Servicios sociales', 'servicio'],
  hospital: ['Hospital', 'lugar'], clinic: ['Clínica', 'lugar'], doctors: ['Médico', 'lugar'], dentist: ['Dentista', 'lugar'], veterinary: ['Veterinario', 'lugar'],
  school: ['Colegio', 'lugar'], kindergarten: ['Guardería', 'lugar'], university: ['Universidad', 'lugar'], college: ['Centro educativo', 'lugar'], library: ['Biblioteca', 'lugar'],
  theatre: ['Teatro', 'lugar'], cinema: ['Cine', 'lugar'], arts_centre: ['Centro de arte', 'lugar'], community_centre: ['Centro cívico', 'lugar'], marketplace: ['Mercado', 'lugar'], place_of_worship: ['Iglesia / templo', 'lugar'], bus_station: ['Estación de autobuses', 'lugar'],
};
const SHOP = {
  supermarket: 'Supermercado', convenience: 'Tienda', clothes: 'Ropa', shoes: 'Zapatería', bakery: 'Panadería', butcher: 'Carnicería', greengrocer: 'Frutería', seafood: 'Pescadería', hairdresser: 'Peluquería', beauty: 'Estética', mobile_phone: 'Móviles', electronics: 'Electrónica',
  furniture: 'Muebles', hardware: 'Ferretería', books: 'Librería', optician: 'Óptica', jewelry: 'Joyería', florist: 'Floristería', gift: 'Regalos', mall: 'Centro comercial', car_repair: 'Taller', car: 'Concesionario', variety_store: 'Bazar', fashion_accessories: 'Complementos',
  lottery: 'Lotería', stationery: 'Papelería', tobacco: 'Estanco', bicycle: 'Bicicletas', pet: 'Mascotas', toys: 'Juguetes', sports: 'Deportes', department_store: 'Grandes almacenes', chemist: 'Droguería', pastry: 'Pastelería', deli: 'Charcutería', wine: 'Vinos', alcohol: 'Licores', copyshop: 'Copistería', laundry: 'Lavandería', dry_cleaning: 'Tintorería', tailor: 'Sastrería', kiosk: 'Quiosco', medical_supply: 'Ortopedia', hearing_aids: 'Audífonos', massage: 'Masajes', tattoo: 'Tatuajes', travel_agency: 'Agencia de viajes', second_hand: 'Segunda mano', video_games: 'Videojuegos', computer: 'Informática', photo: 'Fotografía', perfumery: 'Perfumería', cosmetics: 'Cosmética', fabric: 'Telas', garden_centre: 'Jardinería', houseware: 'Hogar', interior_decoration: 'Decoración', carpet: 'Alfombras', curtain: 'Cortinas', bed: 'Colchones', electrical: 'Electricidad', doityourself: 'Bricolaje', paint: 'Pinturas', tyres: 'Neumáticos', motorcycle: 'Motos', e_cigarette: 'Vapeo', cannabis: 'Cannabis', ticket: 'Entradas', bag: 'Bolsos', boutique: 'Boutique', craft: 'Manualidades', music: 'Música', musical_instrument: 'Instrumentos', art: 'Arte', antiques: 'Antigüedades',
};
const OFFICE = { government: 'Administración', insurance: 'Seguros', estate_agent: 'Inmobiliaria', lawyer: 'Abogados', company: 'Empresa', ngo: 'Asociación', association: 'Asociación', accountant: 'Gestoría', employment_agency: 'Empleo', educational_institution: 'Centro educativo', architect: 'Arquitectos', financial: 'Financiera', notary: 'Notaría', political_party: 'Partido político', research: 'Investigación', telecommunication: 'Telecomunicaciones', travel_agent: 'Agencia de viajes' };
const TOURISM = { hotel: 'Hotel', hostel: 'Hostal', guest_house: 'Pensión', apartment: 'Apartamentos', motel: 'Motel', museum: 'Museo', attraction: 'Atractivo turístico', gallery: 'Galería', viewpoint: 'Mirador', artwork: 'Obra de arte', camp_site: 'Camping' };
const LEISURE = { park: 'Parque', garden: 'Jardín', stadium: 'Estadio', sports_centre: 'Polideportivo', fitness_centre: 'Gimnasio', swimming_pool: 'Piscina', dog_park: 'Parque canino', marina: 'Puerto deportivo', golf_course: 'Golf', sports_hall: 'Pabellón' };
const BUILDING = { university: 'Universidad', college: 'Centro educativo', school: 'Colegio', kindergarten: 'Guardería', hospital: 'Hospital', civic: 'Edificio público', public: 'Edificio público', government: 'Administración', commercial: 'Edificio comercial', retail: 'Comercio', hotel: 'Hotel', church: 'Iglesia', cathedral: 'Catedral', stadium: 'Estadio', train_station: 'Estación', museum: 'Museo' };

function clasifica(t) {
  if (t.amenity && AMENITY[t.amenity]) return AMENITY[t.amenity];
  if (t.shop) return [SHOP[t.shop] ?? 'Comercio', 'comercio'];
  if (t.tourism && TOURISM[t.tourism]) return [TOURISM[t.tourism], 'lugar'];
  if (t.leisure && LEISURE[t.leisure]) return [LEISURE[t.leisure], 'lugar'];
  if (t.healthcare && !t.amenity) return ['Salud', 'lugar'];
  if (t.historic) return ['Monumento', 'lugar'];
  if (t.railway === 'station') return ['Estación de tren', 'lugar'];
  if (t.office) return [OFFICE[t.office] ?? 'Oficina', 'servicio'];
  if (t.craft) return ['Taller', 'servicio'];
  if (t.building && BUILDING[t.building]) return [BUILDING[t.building], 'lugar'];
  return null;
}

const items = new Map();   // calles/plazas agrupadas por nombre; el resto, un elemento por sitio
const add = (key, name, kind, label, pts, addr) => { const it = items.get(key) ?? { name, kind, label, pts: [], addr }; it.pts.push(...pts); if (!it.addr && addr) it.addr = addr; items.set(key, it); };

for (const e of data.elements) {
  const t = e.tags ?? {}; const name = t.name; if (!name) continue;
  const addr = t['addr:street'] ? `${t['addr:street']}${t['addr:housenumber'] ? ' ' + t['addr:housenumber'] : ''}` : '';
  if (e.type === 'way' && e.geometry && t.highway) {
    const kind = /^(plaza|plazoleta|glorieta|plazuela)\b/i.test(name) ? 'plaza' : 'calle';
    add(`${kind}|${norm(name)}`, name, kind, '', e.geometry.map((g) => [g.lat, g.lon]));
    continue;
  }
  const c = e.center ?? (e.lat != null ? { lat: e.lat, lon: e.lon } : null); if (!c) continue;
  if (t.place === 'square' || (/^(plaza|plazoleta)\b/i.test(name) && !t.shop && !t.amenity)) { add(`plaza|${norm(name)}`, name, 'plaza', '', [[c.lat, c.lon]]); continue; }
  if (/^(suburb|neighbourhood|quarter|locality|hamlet|village)$/.test(t.place ?? '') || t.landuse === 'residential') { add(`barrio|${norm(name)}`, name, 'barrio', '', [[c.lat, c.lon]]); continue; }
  const cl = clasifica(t); if (!cl) continue;
  // un sitio por elemento; se deduplican las copias del mismo lugar (nodo + edificio) por nombre, tipo y posición aproximada
  add(`${cl[1]}|${norm(name)}|${cl[0]}|${c.lat.toFixed(3)}|${c.lon.toFixed(3)}`, name, cl[1], cl[0], [[c.lat, c.lon]], addr);
}

// un punto por sitio: el nodo más cercano al centro (así cae sobre la propia calle aunque sea curva o larga)
const labels = []; const lab = (l) => { if (!l) return -1; let i = labels.indexOf(l); if (i < 0) { i = labels.length; labels.push(l); } return i; };
const out = [];
for (const it of items.values()) {
  const la = it.pts.reduce((a, p) => a + p[0], 0) / it.pts.length, lo = it.pts.reduce((a, p) => a + p[1], 0) / it.pts.length;
  let best = it.pts[0], bd = Infinity;
  for (const p of it.pts) { const d = (p[0] - la) ** 2 + ((p[1] - lo) * 0.8) ** 2; if (d < bd) { bd = d; best = p; } }
  const row = [it.name, K[it.kind], +best[0].toFixed(5), +best[1].toFixed(5), lab(it.label)]; if (it.addr) row.push(it.addr);
  out.push(row);
}
out.sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0], 'es'));
const por = KINDS.map(() => 0); out.forEach((o) => por[o[1]]++);
const nuevo = { generado: new Date().toISOString().slice(0, 10), fuente: 'OpenStreetMap (municipio de Huelva)', k: KINDS, l: labels, d: out };
console.log(KINDS.map((k, i) => `${k} ${por[i]}`).join(', '), `→ ${out.length} entradas, ${labels.length} etiquetas`);

// Protecciones para la ejecución automática: no sustituir el índice por una respuesta incompleta de Overpass,
// y no reescribir el archivo si no hay cambios reales (así los PR automáticos no se llenan de ruido).
let previo = null;
try { previo = JSON.parse(readFileSync('public/data/calles.json', 'utf8')); } catch { /* primera vez */ }
if (previo) {
  if (out.length < previo.d.length * 0.7) { console.error(`ABORTADO: ${out.length} entradas frente a ${previo.d.length} del índice actual (menos del 70 %). Overpass pudo devolver datos incompletos.`); process.exit(1); }
  if (JSON.stringify({ ...previo, generado: 0 }) === JSON.stringify({ ...nuevo, generado: 0 })) { console.log('Sin cambios respecto al índice guardado.'); process.exit(0); }
  console.log(`Cambios: ${previo.d.length} → ${out.length} entradas.`);
}
writeFileSync('public/data/calles.json', JSON.stringify(nuevo));
