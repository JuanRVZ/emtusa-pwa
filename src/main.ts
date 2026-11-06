import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './style.css';
import { buildGraph, plan, dist, type Pt, type Plan } from './planner';

type Parada = { codigo: string; nombre: string; lat: number; lon: number; lineas: string[] };
type Linea = { codigo: string; nombre: string; color: string };
type Llegada = { linea: string; colorLinea: string; hora: string; enVivo: boolean; fiabilidad: number; poste: string };
type Bus = { lat: number; lon: number; sentido: number; linea: string; colorLinea: string };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const net = await (await fetch('/data/network.json')).json() as { paradas: Parada[]; lineas: Linea[] };
const graph = buildGraph(net as never);
const colorDe = new Map(net.lineas.map((l) => [l.codigo, l.color]));

const map = L.map('map', { zoomControl: false }).setView([37.2614, -6.9447], 14);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
const stopLayer = L.layerGroup().addTo(map);
const busLayer = L.layerGroup().addTo(map);
let lineFilter: string | null = null;
let current: Parada | null = null;
let mode: 'search' | 'dest' = 'search';
const routeLayer = L.layerGroup().addTo(map);
let geoTimer: number | undefined;
let favs: string[] = JSON.parse(localStorage.getItem('favs') ?? '[]');

function toast(t: string) { const s = $('status'); s.textContent = t; s.classList.add('on'); setTimeout(() => s.classList.remove('on'), 2200); }
const hhmm = (iso: string) => iso.slice(11, 16);
const mins = (iso: string) => Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 60000));

function drawStops() {
  stopLayer.clearLayers();
  for (const p of net.paradas) {
    if (lineFilter && !p.lineas.includes(lineFilter)) continue;
    const c = lineFilter ? colorDe.get(lineFilter)! : '#0b3d91';
    L.circleMarker([p.lat, p.lon], { radius: 6, color: '#fff', weight: 2, fillColor: c, fillOpacity: 1 })
      .on('click', () => openStop(p)).addTo(stopLayer);
  }
}

async function loadBuses() {
  try {
    const r = await fetch('/tr/buses'); const { buses } = await r.json() as { buses: Bus[] | null };
    if (!buses) return toast('Sin datos de buses ahora mismo');
    busLayer.clearLayers();
    for (const b of buses) {
      if (lineFilter && b.linea !== lineFilter) continue;
      const icon = L.divIcon({ className: '', iconSize: [28, 28], html: `<div class="bus" style="width:28px;height:28px;background:${b.colorLinea}">${b.linea}</div>` });
      L.marker([b.lat, b.lon], { icon, zIndexOffset: 1000 }).addTo(busLayer);
    }
  } catch { toast('Sin conexión'); }
}

async function loadArrivals() {
  if (!current) return;
  const code = current.codigo;
  try {
    const r = await fetch(`/tr/parada/${code}`); const { llegadas } = await r.json() as { llegadas: Llegada[] | null };
    if (current?.codigo !== code) return;
    const ul = $('arr');
    if (!llegadas) { ul.innerHTML = '<li>Sin información en tiempo real.</li>'; return; }
    const ls = llegadas.filter((l) => new Date(l.hora).getTime() > Date.now() - 30000).slice(0, 10);
    ul.innerHTML = ls.length ? ls.map((l) => `<li><span class="badge" style="background:${l.colorLinea}">${l.linea}</span>
      <span>${hhmm(l.hora)}</span><span class="eta ${l.enVivo ? 'live' : ''}">${mins(l.hora)} min<small>${l.enVivo ? 'en directo' : 'horario'}</small></span></li>`).join('')
      : '<li>Sin llegadas previstas ahora mismo.</li>';
  } catch { $('arr').innerHTML = '<li>Sin conexión.</li>'; }
}

function paintFav() { $('fav').textContent = current && favs.includes(current.codigo) ? '★' : '☆'; }
function openStop(p: Parada) {
  current = p; $('results').hidden = true; routeLayer.clearLayers(); $('fav').hidden = false;
  $('sname').textContent = p.nombre; $('smeta').textContent = `Parada ${p.codigo} · Líneas ${p.lineas.join(', ')}`;
  $('arr').innerHTML = '<li>Cargando…</li>'; $('sheet').hidden = false; paintFav();
  map.flyTo([p.lat, p.lon], Math.max(map.getZoom(), 16), { duration: 0.5 });
  loadArrivals();
}
$('close').onclick = () => { current = null; $('sheet').hidden = true; routeLayer.clearLayers(); $('fav').hidden = false; };
$('fav').onclick = () => { if (!current) return; const c = current.codigo; favs = favs.includes(c) ? favs.filter((x) => x !== c) : [...favs, c]; localStorage.setItem('favs', JSON.stringify(favs)); paintFav(); };

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
function showResults(items: { t: string; s: string; go: () => void }[]) {
  const ul = $('results'); ul.innerHTML = '';
  for (const i of items) { const li = document.createElement('li'); li.innerHTML = `<span>${i.t}</span><small>${i.s}</small>`; li.onclick = i.go; ul.append(li); }
  ul.hidden = items.length === 0;
}
function favsList() {
  showResults(net.paradas.filter((p) => favs.includes(p.codigo)).map((p) => ({ t: '★ ' + p.nombre, s: p.lineas.join(' '), go: () => openStop(p) })));
}
$('q').addEventListener('focus', () => { if (!($('q') as HTMLInputElement).value) favsList(); });
$('q').addEventListener('input', (e) => {
  const q = norm((e.target as HTMLInputElement).value.trim());
  if (mode === 'dest') return destSearch((e.target as HTMLInputElement).value.trim());
  if (!q) return favsList();
  const ls = net.lineas.filter((l) => norm(l.codigo) === q || norm(l.nombre).includes(q)).map((l) => ({
    t: `Línea ${l.codigo}`, s: l.nombre, go: () => { lineFilter = l.codigo; drawStops(); loadBuses(); $('results').hidden = true; toast(`Mostrando línea ${l.codigo} (toca el buscador para quitar)`); },
  }));
  const ps = net.paradas.filter((p) => norm(p.nombre).includes(q) || p.codigo === q).slice(0, 15).map((p) => ({ t: p.nombre, s: `${p.codigo} · ${p.lineas.join(' ')}`, go: () => openStop(p) }));
  showResults([...(lineFilter ? [{ t: '✕ Mostrar todas las líneas', s: '', go: () => { lineFilter = null; drawStops(); loadBuses(); $('results').hidden = true; } }] : []), ...ls, ...ps]);
});

$('loc').onclick = () => {
  if (!navigator.geolocation) return toast('Sin geolocalización');
  navigator.geolocation.getCurrentPosition((pos) => {
    const { latitude: la, longitude: lo } = pos.coords;
    const d = (p: Parada) => map.distance([la, lo], [p.lat, p.lon]);
    const near = [...net.paradas].sort((a, b) => d(a) - d(b)).slice(0, 8);
    L.circleMarker([la, lo], { radius: 8, color: '#fff', weight: 3, fillColor: '#1a73e8', fillOpacity: 1 }).addTo(map);
    map.setView([la, lo], 16);
    showResults(near.map((p) => ({ t: p.nombre, s: `${Math.round(d(p))} m · ${p.lineas.join(' ')}`, go: () => openStop(p) })));
  }, () => toast('No se pudo obtener tu ubicación'), { enableHighAccuracy: true, timeout: 8000 });
};

drawStops(); loadBuses();
setInterval(() => { if (!document.hidden) { loadBuses(); loadArrivals(); } }, 30000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { loadBuses(); loadArrivals(); } });
if ('serviceWorker' in navigator && import.meta.env.PROD) navigator.serviceWorker.register('/sw.js');

// ---------- Cómo llegar ----------
type Dest = Pt & { name: string };
function destSearch(raw: string) {
  const q = norm(raw);
  if (!q) return showResults([]);
  const ps = net.paradas.filter((p) => norm(p.nombre).includes(q)).slice(0, 6)
    .map((p) => ({ t: '🚏 ' + p.nombre, s: p.lineas.join(' '), go: () => planTo({ lat: p.lat, lon: p.lon, name: p.nombre }) }));
  showResults(ps);
  clearTimeout(geoTimer);
  if (q.length < 3) return;
  geoTimer = window.setTimeout(async () => {
    try {
      const u = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&countrycodes=es&accept-language=es&viewbox=-7.06,37.34,-6.80,37.17&bounded=1&q=' + encodeURIComponent(raw + ', Huelva');
      const res = await (await fetch(u)).json() as { display_name: string; lat: string; lon: string; name?: string }[];
      if (mode !== 'dest') return;
      const pl = res.map((r) => ({ t: '📍 ' + (r.name || r.display_name.split(',')[0]), s: r.display_name.split(',').slice(1, 3).join(',').trim(), go: () => planTo({ lat: +r.lat, lon: +r.lon, name: r.name || r.display_name.split(',')[0] }) }));
      showResults([...ps, ...pl]);
    } catch { /* sin geocodificador: quedan las paradas */ }
  }, 600);
}
$('go').onclick = () => {
  mode = mode === 'dest' ? 'search' : 'dest';
  const q = $('q') as HTMLInputElement; q.value = ''; q.placeholder = mode === 'dest' ? '¿A dónde vas? (parada o dirección)' : 'Buscar parada o línea…';
  $('go').style.background = mode === 'dest' ? '#cfe0ff' : ''; showResults([]); if (mode === 'dest') q.focus();
};
function origin(): Promise<Pt> {
  return new Promise((ok) => {
    const c = map.getCenter();
    if (!navigator.geolocation) return ok({ lat: c.lat, lon: c.lng });
    navigator.geolocation.getCurrentPosition((p) => ok({ lat: p.coords.latitude, lon: p.coords.longitude }),
      () => { toast('Sin ubicación: salgo desde el centro del mapa'); ok({ lat: c.lat, lon: c.lng }); }, { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 });
  });
}
const walkMin = (m: number) => Math.max(1, Math.round(m / 75));
async function planTo(d: Dest) {
  mode = 'search'; $('go').style.background = ''; ($('q') as HTMLInputElement).value = ''; ($('q') as HTMLInputElement).placeholder = 'Buscar parada o línea…'; $('results').hidden = true;
  toast('Calculando ruta…');
  const from = await origin();
  const p = plan(graph, from, d);
  current = null; routeLayer.clearLayers(); $('fav').hidden = true; $('sheet').hidden = false;
  $('sname').textContent = 'Ruta a ' + d.name;
  if (!p) { $('smeta').textContent = 'Sin ruta'; $('arr').innerHTML = '<li>No encuentro una ruta en bus razonable (¿origen o destino fuera de la red?).</li>'; return; }
  drawPlan(p, from, d); renderPlan(p, from, d);
}
function drawPlan(p: Plan, from: Pt, to: Pt) {
  const gray = { color: '#555', weight: 4, dashArray: '2 8' };
  const pts: [number, number][] = [];
  const line = (a: Pt, b: Pt) => L.polyline([[a.lat, a.lon], [b.lat, b.lon]], gray).addTo(routeLayer);
  line(from, p.legs[0].stops[0]);
  p.legs.forEach((l, i) => {
    const ll = l.stops.map((s) => [s.lat, s.lon] as [number, number]); pts.push(...ll);
    L.polyline(ll, { color: l.color, weight: 6, opacity: 0.9 }).addTo(routeLayer);
    L.circleMarker(ll[0], { radius: 8, color: '#fff', weight: 3, fillColor: l.color, fillOpacity: 1 }).bindTooltip('Sube L' + l.linea).addTo(routeLayer);
    const t = p.transfers.filter((x) => x.after === i); let last = l.stops.at(-1)!;
    for (const x of t) { line(last, x.to); last = x.to; }
  });
  const end = p.legs.at(-1)!.stops.at(-1)!; line(p.transfers.length ? p.walkEnd.from : end, to);
  L.circleMarker([to.lat, to.lon], { radius: 9, color: '#fff', weight: 3, fillColor: '#d32f2f', fillOpacity: 1 }).addTo(routeLayer);
  map.fitBounds(L.latLngBounds([...pts, [from.lat, from.lon], [to.lat, to.lon]]).pad(0.25), { paddingBottomRight: [0, 260] });
}
function renderPlan(p: Plan, from: Pt, to: Dest) {
  const nBus = p.legs.filter((l) => !l.continua).length;
  $('smeta').textContent = `~${p.minutes} min · ${nBus} bus${nBus > 1 ? 'es' : ''}${nBus > 1 ? ` · ${nBus - 1} trasbordo${nBus > 2 ? 's' : ''}` : ''} · estimación`;
  const rows: string[] = p.walkStart.m < 40 ? [] : [`<div class="step"><span class="ic">🚶</span><div>Camina ${walkMin(p.walkStart.m)} min (${p.walkStart.m} m) hasta <b>${p.walkStart.to.nombre}</b></div></div>`];
  p.legs.forEach((l, i) => {
    const a = l.stops[0], b = l.stops.at(-1)!;
    rows.push(`<div class="step"><span class="ic"><span class="badge" style="background:${l.color}">${l.linea}</span></span><div>${l.continua ? 'Sigues en el mismo bus. ' : ''}${l.continua ? '' : `Sube en <b>${a.nombre}</b><br>`}Baja en <b>${b.nombre}</b><small>${l.stops.length - 1} paradas · ~${l.minutes} min · ${l.sentido.split('—')[0].trim()}</small>${i === 0 ? '<small id="rt0">Consultando próximo bus…</small>' : ''}</div></div>`);
    for (const x of p.transfers.filter((t) => t.after === i)) rows.push(`<div class="step"><span class="ic">🚶</span><div>Camina ${walkMin(x.m)} min (${x.m} m) hasta <b>${x.to.nombre}</b></div></div>`);
  });
  const rest = Math.round(dist(p.walkEnd.from, to)); if (rest >= 40) rows.push(`<div class="step"><span class="ic">🚶</span><div>Camina ${walkMin(rest)} min (${rest} m) hasta <b>${to.name}</b></div></div>`);
  $('arr').innerHTML = rows.join('');
  const first = p.legs[0];
  fetch(`/tr/parada/${first.stops[0].codigo}`).then((r) => r.json()).then(({ llegadas }: { llegadas: Llegada[] | null }) => {
    const el = document.getElementById('rt0'); if (!el) return;
    const n = llegadas?.find((l) => l.linea === first.linea && new Date(l.hora).getTime() > Date.now() - 20000);
    el.innerHTML = n ? `<b class="rt">Próximo bus: ${mins(n.hora)} min</b> (${n.enVivo ? 'en directo' : 'horario'})` : 'Sin próximo bus previsto ahora mismo';
  }).catch(() => { const el = document.getElementById('rt0'); if (el) el.textContent = ''; });
}
