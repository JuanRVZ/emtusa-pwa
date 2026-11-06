import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './style.css';

type Parada = { codigo: string; nombre: string; lat: number; lon: number; lineas: string[] };
type Linea = { codigo: string; nombre: string; color: string };
type Llegada = { linea: string; colorLinea: string; hora: string; enVivo: boolean; fiabilidad: number; poste: string };
type Bus = { lat: number; lon: number; sentido: number; linea: string; colorLinea: string };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const net = await (await fetch('/data/network.json')).json() as { paradas: Parada[]; lineas: Linea[] };
const colorDe = new Map(net.lineas.map((l) => [l.codigo, l.color]));

const map = L.map('map', { zoomControl: false }).setView([37.2614, -6.9447], 14);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
const stopLayer = L.layerGroup().addTo(map);
const busLayer = L.layerGroup().addTo(map);
let lineFilter: string | null = null;
let current: Parada | null = null;
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
  current = p; $('results').hidden = true;
  $('sname').textContent = p.nombre; $('smeta').textContent = `Parada ${p.codigo} · Líneas ${p.lineas.join(', ')}`;
  $('arr').innerHTML = '<li>Cargando…</li>'; $('sheet').hidden = false; paintFav();
  map.flyTo([p.lat, p.lon], Math.max(map.getZoom(), 16), { duration: 0.5 });
  loadArrivals();
}
$('close').onclick = () => { current = null; $('sheet').hidden = true; };
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
