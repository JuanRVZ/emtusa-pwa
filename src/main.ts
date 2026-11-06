import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './style.css';
import { buildGraph, planAll, dist, PROFILES, type Pt, type Plan, type Parada } from './planner';
import { Route, type Rec } from './route';
import { leafletLayer } from 'protomaps-leaflet';
import { pushSupported, getPushId, enablePush, createAlarm, deleteAlarm, listAlarms, testPush, type ServerAlarm } from './push';

type Linea = { codigo: string; nombre: string; color: string; recorridos: Rec[] };
type Llegada = { linea: string; colorLinea: string; hora: string; enVivo: boolean; fiabilidad: number; poste: string };
type LlegadaLinea = { parada: string; nombreParada: string | null; hora: string; enVivo: boolean };
type Bus = { lat: number; lon: number; sentido: number; linea: string; colorLinea: string };
type Tracked = { s0: number; s1: number; sNow: number; t0: number; dur: number; marker: L.Marker };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const net = (await (await fetch('/data/network.json')).json()) as { paradas: Parada[]; lineas: Linea[] };
const byCode = new Map(net.paradas.map((p) => [p.codigo, p]));
const lineaDe = new Map(net.lineas.map((l) => [l.codigo, l]));
const graph = buildGraph(net as never);
const REFRESH = 20000;

const map = L.map('map', { zoomControl: false }).setView([37.2614, -6.9447], 14);
// Mapa propio: vector de OpenStreetMap (extracto de Protomaps) alojado junto a la app, con estilo claro/oscuro real.
// Si el archivo no se puede leer, se usa el mapa raster público de OpenStreetMap como respaldo.
const AREA = L.latLngBounds([37.18, -7.05], [37.36, -6.82]);
map.setMinZoom(11); map.setMaxBounds(AREA.pad(0.15));
const darkMq = matchMedia('(prefers-color-scheme: dark)');
let baseLayer: L.Layer | null = null;
const forcedFlavor = ({ claro: 'light', oscuro: 'dark' } as Record<string, string>)[new URLSearchParams(location.search).get('mapa') ?? ''] ?? null; // ?mapa=claro|oscuro (solo para revisar estilos)
const vectorOk = await (async () => {
  try { const r = await fetch('/data/huelva.pmtiles', { headers: { Range: 'bytes=0-15' } }); return r.status === 206 && (await r.arrayBuffer()).byteLength === 16; } catch { return false; }
})();
function addBase() {
  baseLayer?.remove();
  baseLayer = (vectorOk
    ? leafletLayer({ url: '/data/huelva.pmtiles', flavor: forcedFlavor ?? (darkMq.matches ? 'dark' : 'light'), lang: 'es', maxZoom: 19, maxDataZoom: 15, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · <a href="https://protomaps.com">Protomaps</a>' })
    : L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' })) as L.Layer;
  baseLayer.addTo(map); (baseLayer as unknown as { bringToBack?: () => void }).bringToBack?.();
}
addBase(); darkMq.addEventListener('change', addBase);
map.on('zoomend', () => map.getContainer().classList.toggle('z-low', map.getZoom() < 15)); map.getContainer().classList.toggle('z-low', map.getZoom() < 15);
const stopLayer = L.layerGroup().addTo(map);
const busLayer = L.layerGroup().addTo(map);
const routeLayer = L.layerGroup().addTo(map);
const lineLayer = L.layerGroup().addTo(map);

let current: Parada | null = null;
let mode: 'search' | 'dest' = 'search';
let geoTimer: number | undefined;
let favs: string[] = JSON.parse(localStorage.getItem('favs') ?? '[]');
const mineStore: Record<string, { dir: number; code: string }> = JSON.parse(localStorage.getItem('mine') ?? '{}');

function toast(t: string) { const s = $('status'); s.textContent = t; s.classList.add('on'); setTimeout(() => s.classList.remove('on'), 2400); }
const hhmm = (iso: string) => iso.slice(11, 16);
const etaTxt = (iso: string) => { const m = Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 60000)); return m >= 90 ? hhmm(iso) : `${m} min`; };
const mins = (iso: string) => Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 60000));
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const destino = (r: Rec) => r.sentido.split('hacia')[1]?.trim() ?? r.sentido;
const fmtDist = (m: number) => (m < 950 ? `${Math.max(10, Math.round(m / 10) * 10)} m` : `${(m / 1000).toFixed(1)} km`);

// ============ Selector de líneas ============
const chips = $('lines');
chips.innerHTML = net.lineas.map((l) => `<button class="chip" data-l="${esc(l.codigo)}" style="--c:${l.color}" aria-label="Línea ${esc(l.codigo)}">${esc(l.codigo)}</button>`).join('');
chips.onclick = (e) => {
  const b = (e.target as HTMLElement).closest('.chip') as HTMLElement | null; if (!b) return;
  if (sel?.linea.codigo === b.dataset.l) closeLine(); else selectLine(b.dataset.l!);
};

// ============ Modo línea ============
type Sel = { linea: Linea; dir: number; route: Route; mine: string | null };
let sel: Sel | null = null;
let tracked: Tracked[] = [];
let arrivals = new Map<string, LlegadaLinea[]>();
let liveOk = true;
let mineSeg: L.Polyline | null = null;
let mineMarker: L.Marker | null = null;
let stopMarkers: L.CircleMarker[] = [];
let refreshTimer: number | undefined;

function selectLine(code: string, opts: { dir?: number; stop?: string } = {}) {
  const linea = lineaDe.get(code); if (!linea) return;
  closeStopSheet(); routeLayer.clearLayers(); clearLine();
  let dir = opts.dir ?? mineStore[code]?.dir ?? 0;
  if (opts.stop && opts.dir === undefined) { // elegir el sentido donde está la parada (y no es la última)
    const k = linea.recorridos.findIndex((r) => r.paradas.includes(opts.stop!) && r.paradas[r.paradas.length - 1] !== opts.stop);
    if (k >= 0) dir = k;
  }
  dir = Math.min(dir, linea.recorridos.length - 1);
  const route = new Route(linea.recorridos[dir], byCode);
  const mine = opts.stop ?? (mineStore[code]?.dir === dir ? mineStore[code].code : null);
  sel = { linea, dir, route, mine: mine && route.stops.some((s) => s.codigo === mine) ? mine : null };
  stopLayer.clearLayers(); busLayer.clearLayers(); showHome();
  document.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', (c as HTMLElement).dataset.l === code)); chips.classList.add('has-sel');
  (document.querySelector(`.chip[data-l="${CSS.escape(code)}"]`) as HTMLElement | null)?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  drawLine(true);
  $('lsheet').hidden = false; setDetent(1);
  arrivals = new Map(); tracked = [];
  renderPanel(); refreshLive();
  clearInterval(refreshTimer); refreshTimer = window.setInterval(() => { if (!document.hidden) refreshLive(); }, REFRESH);
  if (sel.mine) setTimeout(() => scrollToMine(), 50);
}

function clearLine() {
  lineLayer.clearLayers(); tracked.forEach((t) => t.marker.remove()); tracked = []; mineSeg = null; mineMarker = null;
}

function closeLine() {
  sel = null; clearLine(); clearInterval(refreshTimer);
  $('lsheet').hidden = true;
  document.querySelectorAll('.chip').forEach((c) => c.classList.remove('on')); chips.classList.remove('has-sel');
  drawStops(); loadBuses(); showHome();
}

function drawLine(fit: boolean) {
  if (!sel) return;
  lineLayer.clearLayers(); mineSeg = null; mineMarker = null;
  const { route, linea } = sel;
  L.polyline(route.pts, { color: '#fff', weight: 10, opacity: 0.95 }).addTo(lineLayer);
  L.polyline(route.pts, { color: linea.color, weight: 6, opacity: 0.95 }).addTo(lineLayer);
  stopMarkers = route.stops.map((p, i) => {
    const end = i === 0 || i === route.stops.length - 1;
    return L.circleMarker([p.lat, p.lon], { radius: end ? 7 : 5, color: linea.color, weight: 2, fillColor: '#fff', fillOpacity: 1 })
      .bindTooltip('', { permanent: true, direction: 'right', offset: [6, 0], className: 'min-tip' })
      .on('click', () => setMine(p.codigo)).addTo(lineLayer);
  });
  paintMinutes();
  updateMineMarker();
  if (fit) map.fitBounds(L.latLngBounds(route.pts).pad(0.12), { paddingBottomRight: [0, window.innerHeight * 0.38] });
}

function paintMinutes() {
  if (!sel) return;
  stopMarkers.forEach((m, i) => { const e = etaFor(i); const show = e && (e.src !== 'plan' || e.min < 90); m.setTooltipContent(show ? `<b class="${e.src}">${e.min}'</b>` : ''); const t = m.getTooltip()?.getElement(); if (t) t.style.display = show ? '' : 'none'; });
}

function setDir(d: number) {
  if (!sel || d === sel.dir) return;
  const linea = sel.linea; const route = new Route(linea.recorridos[d], byCode);
  const mine = mineStore[linea.codigo]?.dir === d ? mineStore[linea.codigo].code : null;
  clearLine(); stopMarkers = []; sel = { linea, dir: d, route, mine: mine && route.stops.some((s) => s.codigo === mine) ? mine : null };
  drawLine(true); renderPanel(); refreshLive();
}

function setMine(code: string) {
  if (!sel) return;
  sel.mine = code;
  mineStore[sel.linea.codigo] = { dir: sel.dir, code }; localStorage.setItem('mine', JSON.stringify(mineStore));
  updateMineMarker(); renderPanel(); updateMine();
  const p = byCode.get(code)!; focusAbove([p.lat, p.lon]);
  scrollToMine();
}

function focusAbove(ll: [number, number]) {
  const h = $('lsheet').getBoundingClientRect().height; const z = Math.max(map.getZoom(), 15);
  map.setView(map.unproject(map.project(ll, z).add([0, h / 2]), z), z, { animate: true });
}

function clearMine() {
  if (!sel) return; sel.mine = null; delete mineStore[sel.linea.codigo]; localStorage.setItem('mine', JSON.stringify(mineStore));
  updateMineMarker(); renderPanel();
}

function updateMineMarker() {
  mineMarker?.remove(); mineMarker = null; mineSeg?.remove(); mineSeg = null;
  if (!sel?.mine) return;
  const p = byCode.get(sel.mine)!;
  mineMarker = L.marker([p.lat, p.lon], { zIndexOffset: 500, icon: L.divIcon({ className: '', iconSize: [34, 34], iconAnchor: [17, 17], html: `<div class="mine-pin" style="--c:${sel.linea.color}">🚏</div>` }) }).addTo(lineLayer);
}

async function refreshLive() {
  const s = sel; if (!s) return;
  const [rb, ra] = await Promise.allSettled([fetch('/tr/buses').then((r) => r.json()), fetch(`/tr/${encodeURIComponent(s.linea.codigo)}`).then((r) => r.json())]);
  if (sel !== s) return; // el usuario cambió de línea/sentido mientras tanto
  const buses = rb.status === 'fulfilled' ? (rb.value.buses as Bus[] | null) : null;
  const llg = ra.status === 'fulfilled' ? (ra.value.llegadas as LlegadaLinea[] | null) : null;
  liveOk = buses !== null;
  if (buses) ingestBuses(buses);
  if (llg) { arrivals = new Map(); for (const a of llg) { const l = arrivals.get(a.parada) ?? []; l.push(a); arrivals.set(a.parada, l); } }
  renderPanel(); updateMine(); paintMinutes(); updateUserPos();
}

function newTracked(s: number): Tracked {
  const marker = L.marker(sel!.route.at(s), { zIndexOffset: 1000, icon: L.divIcon({ className: '', iconSize: [34, 34], iconAnchor: [17, 17], html: `<div class="bus-pin" style="--c:${sel!.linea.color}">${esc(sel!.linea.codigo)}</div>` }) }).addTo(lineLayer);
  return { s0: s, s1: s, sNow: s, t0: performance.now(), dur: REFRESH, marker };
}

function ingestBuses(buses: Bus[]) {
  const s = sel!; const now = performance.now();
  const snaps = buses.filter((b) => b.linea === s.linea.codigo && b.sentido === s.dir + 1)
    .map((b) => s.route.snap(b.lat, b.lon)).filter((x): x is { s: number; d: number } => !!x && x.d < 250).sort((a, b) => a.s - b.s);
  const old = [...tracked]; const next: Tracked[] = [];
  for (const sn of snaps) {
    let bi = -1, bd = Infinity;
    old.forEach((o, i) => { const d = sn.s - o.s1; if (d > -120 && d < 2500 && Math.abs(d) < bd) { bd = Math.abs(d); bi = i; } });
    if (bi >= 0) { const o = old.splice(bi, 1)[0]; o.s0 = o.sNow; o.s1 = Math.max(sn.s, o.sNow); o.t0 = now; o.dur = REFRESH; next.push(o); }
    else next.push(newTracked(sn.s));
  }
  old.forEach((o) => o.marker.remove()); tracked = next;
}

function frame() {
  if (sel && tracked.length) {
    const now = performance.now();
    for (const t of tracked) { const k = Math.min(1, (now - t.t0) / t.dur); t.sNow = t.s0 + (t.s1 - t.s0) * k; t.marker.setLatLng(sel.route.at(t.sNow)); }
    updateSeg();
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

/** Autobús que viene hacia mi parada (el más cercano por detrás). */
function approaching(): { t: Tracked; remain: number; away: number } | null {
  if (!sel?.mine) return null;
  const idx = sel.route.stops.findIndex((p) => p.codigo === sel!.mine); if (idx < 0) return null;
  const sp = sel.route.stopPos[idx]; let best: { t: Tracked; remain: number; away: number } | null = null;
  for (const t of tracked) {
    const remain = sp - t.sNow; if (remain < -25) continue;
    if (!best || remain < best.remain) best = { t, remain: Math.max(0, remain), away: idx - sel.route.lastPassed(t.sNow) };
  }
  return best;
}

function updateSeg() {
  const a = approaching(); if (!a || !sel) { mineSeg?.remove(); mineSeg = null; return; }
  const idx = sel.route.stops.findIndex((p) => p.codigo === sel!.mine);
  const pts = sel.route.slice(a.t.sNow, sel.route.stopPos[idx]);
  if (!mineSeg) mineSeg = L.polyline(pts, { color: '#111', weight: 5, opacity: 0.85, dashArray: '1 9', lineCap: 'round' }).addTo(lineLayer); else mineSeg.setLatLngs(pts);
}

/** Minutos que faltan para que un bus llegue a la parada i de la línea seleccionada. */
type Eta = { min: number; src: 'live' | 'est' | 'plan'; txt: string };
function etaFor(i: number): Eta | null {
  if (!sel) return null;
  const route = sel.route; const sp = route.stopPos[i];
  const a = arrivals.get(route.stops[i].codigo)?.[0];
  const apiMin = a ? mins(a.hora) : null;
  let est: number | null = null;
  for (const t of tracked) {
    const remain = sp - t.sNow; if (remain < -25) continue;
    const e = Math.max(0, Math.round((remain / 4.5 + (i - route.lastPassed(t.sNow)) * 20) / 60));
    if (est === null || e < est) est = e;
  }
  if (a && apiMin !== null && apiMin < 90 && a.enVivo) return { min: apiMin, src: 'live', txt: apiMin === 0 ? 'ya' : `${apiMin} min` };
  if (est !== null) return { min: est, src: 'est', txt: est === 0 ? 'ya' : `~${est} min` };
  if (a && apiMin !== null) return { min: apiMin, src: 'plan', txt: etaTxt(a.hora) };
  return null;
}

// ---------- Panel inferior de la línea ----------
function renderPanel() {
  if (!sel) return;
  const { linea, route, dir } = sel;
  const head = $('lhead');
  head.innerHTML = `<span class="badge big" style="background:${linea.color}">${esc(linea.codigo)}</span><div class="lt"><b>${esc(linea.nombre)}</b><small id="lstat"></small></div><button id="lclose" class="round" aria-label="Cerrar">✕</button>`;
  $('lclose').onclick = closeLine;
  const seg = $('seg');
  seg.innerHTML = linea.recorridos.map((r, i) => `<button class="${i === dir ? 'on' : ''}" data-d="${i}">→ ${esc(destino(r))}</button>`).join('');
  seg.onclick = (e) => { const b = (e.target as HTMLElement).closest('button'); if (b) setDir(+b.dataset.d!); };
  const st = $('lstat'); st.textContent = !liveOk ? 'Sin datos en directo' : tracked.length ? `${tracked.length} bus${tracked.length === 1 ? '' : 'es'} en circulación en este sentido` : 'Ningún bus en este sentido ahora'; st.classList.toggle('on', liveOk && tracked.length > 0);

  const list = $('slist'); const keep = list.scrollTop;
  const rows: string[] = [];
  route.stops.forEach((p, i) => {
    const e = etaFor(i);
    const et = e ? `<span class="et ${e.src}">${e.txt}</span>` : '<span class="et none">—</span>';
    rows.push(`<li class="srow ${sel!.mine === p.codigo ? 'mine' : ''}" data-c="${p.codigo}" style="--c:${linea.color}" role="button" tabindex="0" aria-pressed="${sel!.mine === p.codigo}" aria-label="${esc(p.nombre)}${e ? ', ' + (e.src === 'plan' ? 'horario ' + e.txt : e.txt.replace('~', 'aproximadamente ').replace(' min', ' minutos')) : ''}"><i class="dot"></i><span class="nm">${esc(p.nombre)}<small>${p.codigo}</small></span>${et}</li>`);
    if (i + 1 < route.stops.length) for (const t of tracked) if (t.sNow >= route.stopPos[i] && t.sNow < route.stopPos[i + 1])
      rows.push(`<li class="brow" style="--c:${linea.color}"><i class="bdot"></i><span>Bus a ${fmtDist(route.stopPos[i + 1] - t.sNow)} de <b>${esc(route.stops[i + 1].nombre)}</b></span></li>`);
  });
  list.innerHTML = rows.join(''); list.scrollTop = keep;
  list.onclick = (e) => { const li = (e.target as HTMLElement).closest('.srow') as HTMLElement | null; if (li) setMine(li.dataset.c!); };
  $('mine').hidden = !sel.mine; updateMine();
}

function scrollToMine() { document.querySelector('#slist .srow.mine')?.scrollIntoView({ block: 'center', behavior: 'smooth' }); }

// ---------- ¿Llego a tiempo? (ubicación del usuario) ----------
let userPos: Pt | null = null; let geoOn = false;
try { geoOn = localStorage.getItem('geoOn') === '1'; } catch { geoOn = false; }
function getPos(): Promise<Pt | null> {
  return new Promise((ok) => {
    if (!navigator.geolocation) return ok(null);
    navigator.geolocation.getCurrentPosition((q) => ok({ lat: q.coords.latitude, lon: q.coords.longitude }), () => ok(null), { enableHighAccuracy: true, timeout: 8000, maximumAge: 15000 });
  });
}
async function updateUserPos() { if (!geoOn) return; const q = await getPos(); if (q) { userPos = q; if (sel?.mine) updateMine(); } }
const walkCache = new Map<string, { m: number; s: number }>(); const walkPending = new Set<string>();
function walkInfo(p: Parada): { m: number; min: number } {
  const key = `${p.codigo}|${userPos!.lat.toFixed(4)},${userPos!.lon.toFixed(4)}`; const c = walkCache.get(key);
  if (c) return { m: Math.round(c.m), min: Math.max(1, Math.round(c.s / 60)) };
  if (!walkPending.has(key)) {
    walkPending.add(key);
    fetch(`/walk?a=${userPos!.lat},${userPos!.lon}&b=${p.lat},${p.lon}`).then((r) => r.json()).then((j: { routes?: { distance: number; duration: number }[] }) => {
      const r = j.routes?.[0]; if (r) { walkCache.set(key, { m: r.distance, s: r.duration }); updateMine(); }
    }).catch(() => { /* se queda la estimación en línea recta */ });
  }
  const m = Math.round(dist(userPos!, p) * 1.3); return { m, min: Math.max(1, Math.round(m / 75)) };
}
function leaveHtml(p: Parada, idx: number, arr: LlegadaLinea[]): string {
  if (!userPos) return `<div class="leave"><button data-act="geo">📍 ¿Llego a tiempo? Usar mi ubicación</button></div>`;
  const w = walkInfo(p); const e = etaFor(idx); const bus = e && e.src !== 'plan' ? e.min : null;
  if (w.m < 40) return '<div class="leave ok">📍 Ya estás en la parada</div>';
  if (bus === null) return `<div class="leave">🚶 Estás a ${w.min} min andando (${fmtDist(w.m)})</div>`;
  const margin = bus - w.min;
  if (margin >= 3) return `<div class="leave ok">✅ Llegas con ${margin} min de margen · sal en ${margin - 1} min <small>(${w.min} min andando)</small></div>`;
  if (margin >= 0) return `<div class="leave warn">⚠️ Justo: sal ya <small>(${w.min} min andando, bus en ${bus} min)</small></div>`;
  const n2 = arr[1] ? mins(arr[1].hora) : null;
  return `<div class="leave bad">❌ No alcanzas este bus <small>(${w.min} min andando, llega en ${bus})</small>${n2 !== null && n2 - w.min >= 0 ? `<br>El siguiente, en ${n2} min, sí` : ''}</div>`;
}

let mOpen = false;
let repDays = '1,2,3,4,5'; let repTime = '08:00'; let repMin = 5;
function cloudHtml(): string {
  if (!pushSupported()) return /iPhone|iPad/.test(navigator.userAgent) ? '<div class="leave">☁️ Para avisos con la app cerrada, añádela a la pantalla de inicio (Compartir → Añadir a pantalla de inicio)</div>' : '';
  if (!getPushId()) return '<div class="alrow"><span>☁️ Aunque cierre la app</span><div class="alopts"><button data-act="pushon">Activar</button></div></div>';
  const o = (v: string, t: string) => `<option value="${v}" ${repDays === v ? 'selected' : ''}>${t}</option>`;
  return `<div class="alrow"><span>☁️ Avisos en la nube activados</span><div class="alopts"><button data-act="pushtest">Probar</button></div></div>
    <div class="alrow rep"><span>🔁 Repetir</span><div class="alopts"><select id="rdays" aria-label="Días">${o('1,2,3,4,5', 'L–V')}${o('0,1,2,3,4,5,6', 'Todos')}${o('0,6', 'Fin de semana')}</select><input type="time" id="rtime" value="${repTime}" aria-label="Hora" /><select id="rmin" aria-label="Minutos de antelación">${[2, 5, 10].map((m) => `<option value="${m}" ${repMin === m ? 'selected' : ''}>${m} min</option>`).join('')}</select><button data-act="repeat">Crear</button></div></div>`;
}

function updateMine() {
  const box = $('mine'); if (!sel?.mine) { box.hidden = true; return; }
  const ae = document.activeElement as HTMLElement | null; if (ae && box.contains(ae) && /^(SELECT|INPUT)$/.test(ae.tagName)) return; // no pisar lo que el usuario está editando
  const p = byCode.get(sel.mine)!; const arr = arrivals.get(p.codigo) ?? [];
  const next = arr[0]; const a = approaching();
  let where = 'Ningún bus de camino ahora mismo';
  if (a) where = a.remain < 60 ? '🚌 ¡Llegando!' : `🚌 A ${a.away} parada${a.away === 1 ? '' : 's'} · ${fmtDist(a.remain)}`;
  else if (!liveOk) where = 'Sin datos de posición';
  // si hay un bus en camino pero el horario oficial no lo refleja, estimar por su posición
  const estMin = a ? Math.max(1, Math.round((a.remain / 4.5 + a.away * 20) / 60)) : null;
  const useEst = estMin !== null && (!next || mins(next.hora) - estMin > 25);
  const nm = next ? mins(next.hora) : 0;
  const big = useEst ? `~${estMin}<small> min</small>` : next ? (nm >= 90 ? `${hhmm(next.hora)}` : `${nm}<small> min</small>`) : '—';
  const sub = useEst ? 'estimado por la posición del bus' + (next ? ` · siguiente oficial ${hhmm(next.hora)}` : '')
    : next ? `${hhmm(next.hora)} · ${next.enVivo ? '<b class="rt">en directo</b>' : 'según horario'}${arr[1] ? ` · luego ${etaTxt(arr[1].hora)}` : ''}` : 'Sin llegadas previstas';
  box.hidden = false;
  box.innerHTML = `<div class="mtop"><div><small>MI PARADA</small><b>${esc(p.nombre)}</b></div><div class="macts"><button id="mshare" aria-label="Compartir">↗</button><button id="mclear" aria-label="Quitar">✕</button></div></div>
    <div class="mrow"><div class="mbig ${next?.enVivo && !useEst ? 'live' : ''}">${big}</div><div class="msub">${sub}<div class="mwhere">${where}</div></div></div>
    ${leaveHtml(p, sel.route.stops.findIndex((x) => x.codigo === p.codigo), arr)}
    <button class="moptsb" data-act="mopts" aria-expanded="${mOpen}">🔔 Alarmas y avisos <span>${mOpen ? '▴' : '▾'}</span></button><div class="mopts" ${mOpen ? '' : 'hidden'}>
    <div class="alrow"><span>🔔 Avisarme a</span><div class="alopts">${[2, 5, 10].map((m) => `<button data-m="${m}" class="${isMyAlarm(m) ? 'on' : ''}">${m} min</button>`).join('')}</div></div>
    <div class="alrow"><span>🛑 Me bajo aquí</span><div class="alopts"><button data-act="getoff" class="${isGetOff() ? 'on' : ''}">${isGetOff() ? 'Activado' : 'Avisar'}</button></div></div>
    ${cloudHtml()}</div>`;
  $('mclear').onclick = clearMine;
  $('mshare').onclick = async () => {
    const url = `${location.origin}/?l=${encodeURIComponent(sel!.linea.codigo)}&d=${sel!.dir}&p=${p.codigo}`;
    const text = `Línea ${sel!.linea.codigo} en ${p.nombre}`;
    try { if (navigator.share) await navigator.share({ title: 'Bus Huelva', text, url }); else { await navigator.clipboard.writeText(url); toast('Enlace copiado'); } } catch { /* cancelado */ }
  };
  box.onclick = async (e) => {
    const t = e.target as HTMLElement;
    const b = t.closest('button[data-m]') as HTMLElement | null; if (b) { toggleAlarm(+b.dataset.m!); return; }
    const a2 = (t.closest('button[data-act]') as HTMLElement | null)?.dataset.act;
    if (a2 === 'geo') { geoOn = true; try { localStorage.setItem('geoOn', '1'); } catch { /* ignorar */ } await updateUserPos(); if (!userPos) toast('No pude obtener tu ubicación'); }
    else if (a2 === 'pushtest') { try { await testPush(); toast('Enviado: debería llegarte en unos segundos'); } catch (err) { toast((err as Error).message); } }
    else if (a2 === 'mopts') { mOpen = !mOpen; updateMine(); }
    else if (a2 === 'getoff') toggleGetOff();
    else if (a2 === 'pushon') { try { await enablePush(); toast('Avisos en la nube activados ✓'); updateMine(); loadHomeAlarms(); } catch (err) { toast((err as Error).message); } }
    else if (a2 === 'repeat' && sel?.mine) {
      try {
        const p0 = byCode.get(sel.mine)!;
        await createAlarm({ linea: sel.linea.codigo, dir: sel.dir, code: sel.mine, name: p0.nombre, min: repMin, kind: 'weekly', days: repDays, time: repTime });
        toast(`Alarma creada: ${repDays === '1,2,3,4,5' ? 'L–V' : repDays === '0,6' ? 'fines de semana' : 'todos los días'} desde las ${repTime}`); loadHomeAlarms();
      } catch (err) { toast((err as Error).message); }
    }
  };
}
$('mine').addEventListener('change', (e) => {
  const t = e.target as HTMLInputElement | HTMLSelectElement;
  if (t.id === 'rdays') repDays = t.value; else if (t.id === 'rtime') repTime = t.value || repTime; else if (t.id === 'rmin') repMin = +t.value;
});
setInterval(() => { if (sel) { updateMine(); renderPanel(); paintMinutes(); } }, 5000);

// teclado y VoiceOver: Enter o espacio activan filas y el selector de altura
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const t = e.target as HTMLElement; if (!t.matches?.('.srow,.frow,.grab,.chip')) return;
  e.preventDefault(); t.click();
});
// tamaño de texto del sistema (Dynamic Type de iOS): escala el contenido de los paneles
try {
  if (CSS.supports('font', '-apple-system-body')) {
    const probe = document.createElement('span'); probe.style.font = '-apple-system-body'; probe.textContent = 'x'; document.body.append(probe);
    const px = parseFloat(getComputedStyle(probe).fontSize); probe.remove();
    if (px > 0) document.documentElement.style.setProperty('--k', String(Math.min(1.7, Math.max(0.9, px / 17))));
  }
} catch { /* sin Dynamic Type */ }

// hoja arrastrable con tres alturas (como Mapas de iOS)
const DETENTS = [30, 52, 86]; let detent = 1;
function setDetent(i: number) { detent = Math.max(0, Math.min(DETENTS.length - 1, i)); const el = $('lsheet'); el.style.height = ''; el.style.setProperty('--h', String(DETENTS[detent])); }
(() => {
  const el = $('lsheet'); let y0 = 0, h0 = 0, t0 = 0, moved = false, on = false;
  const down = (e: PointerEvent) => { if ((e.target as HTMLElement).closest('button')) return; on = true; moved = false; y0 = e.clientY; t0 = e.timeStamp; h0 = el.getBoundingClientRect().height; el.classList.add('dragging'); try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* evento sintético */ } };
  const move = (e: PointerEvent) => { if (!on) return; const dy = y0 - e.clientY; if (Math.abs(dy) > 4) moved = true; el.style.height = Math.max(window.innerHeight * 0.2, Math.min(window.innerHeight * 0.9, h0 + dy)) + 'px'; };
  const up = (e: PointerEvent) => {
    if (!on) return; on = false; el.classList.remove('dragging');
    if (!moved) { setDetent((detent + 1) % DETENTS.length); return; }
    const vel = (y0 - e.clientY) / Math.max(1, e.timeStamp - t0); // px/ms (+ = hacia arriba)
    const pct = ((h0 + (y0 - e.clientY)) / window.innerHeight) * 100 + vel * 120;
    let best = 0; DETENTS.forEach((d, i) => { if (Math.abs(d - pct) < Math.abs(DETENTS[best] - pct)) best = i; });
    setDetent(best);
  };
  el.querySelector('.grab')!.addEventListener('click', (e) => { if ((e as MouseEvent).detail === 0) setDetent((detent + 1) % DETENTS.length); }); // activación por teclado/VoiceOver
  for (const h of [el.querySelector('.grab')!, $('lhead')]) { h.addEventListener('pointerdown', down as EventListener); h.addEventListener('pointermove', move as EventListener); h.addEventListener('pointerup', up as EventListener); h.addEventListener('pointercancel', up as EventListener); }
})();

// ============ Alarma "avísame cuando mi bus esté a X min" ============
type Alarm = { kind?: 'bus' | 'getoff'; linea: string; dir: number; code: string; min: number; warned?: boolean; sid?: string };
let alarm: Alarm | null = null;
try { alarm = JSON.parse(localStorage.getItem('alarm') ?? 'null'); } catch { alarm = null; }
let wake: { release(): Promise<void>; addEventListener(t: string, f: () => void): void } | null = null;
let audio: AudioContext | null = null;
let alarmTimer: number | undefined;

const dropServer = (a: Alarm | null) => { if (a?.sid) deleteAlarm(a.sid).catch(() => { /* ya no existe */ }); };
const isMyAlarm = (m: number) => !!alarm && !!sel && alarm.linea === sel.linea.codigo && alarm.dir === sel.dir && alarm.code === sel.mine && alarm.kind !== 'getoff' && alarm.min === m;
const isGetOff = () => !!alarm && alarm.kind === 'getoff' && !!sel && alarm.linea === sel.linea.codigo && alarm.dir === sel.dir && alarm.code === sel.mine;

function toggleGetOff() {
  if (!sel?.mine) return;
  try { audio ??= new AudioContext(); void audio.resume(); } catch { /* sin audio */ }
  if (isGetOff()) { dropServer(alarm); alarm = null; toast('Aviso de bajada cancelado'); }
  else {
    dropServer(alarm);
    alarm = { kind: 'getoff', linea: sel.linea.codigo, dir: sel.dir, code: sel.mine, min: 0 };
    geoOn = true; try { localStorage.setItem('geoOn', '1'); } catch { /* ignorar */ }
    toast('Te aviso al acercarte a tu parada. Mantén la app abierta y la ubicación activada');
    try { if ('Notification' in window && Notification.permission === 'default') void Notification.requestPermission(); } catch { /* iOS sin PWA instalada */ }
  }
  saveAlarm(); alarmCheck();
}

function toggleAlarm(min: number) {
  if (!sel?.mine) return;
  try { audio ??= new AudioContext(); void audio.resume(); } catch { /* sin audio */ } // hay que desbloquearlo con un gesto del usuario
  if (isMyAlarm(min)) { dropServer(alarm); alarm = null; toast('Alarma cancelada'); }
  else {
    dropServer(alarm);
    alarm = { linea: sel.linea.codigo, dir: sel.dir, code: sel.mine, min };
    const cur = alarm; // con avisos en la nube activados, también se registra en el servidor (suena con la app cerrada)
    if (getPushId()) createAlarm({ linea: cur.linea, dir: cur.dir, code: cur.code, name: byCode.get(cur.code)?.nombre ?? '', min, kind: 'once' }).then((id) => { if (!id) return; if (alarm === cur) { cur.sid = id; saveAlarm(); } else deleteAlarm(id).catch(() => undefined); }).catch(() => toast('No pude registrar el aviso en la nube'));
    toast(`Te aviso cuando falten ${min} min. Mantén la app abierta`);
    try { if ('Notification' in window && Notification.permission === 'default') void Notification.requestPermission(); } catch { /* iOS sin PWA instalada */ }
  }
  saveAlarm(); alarmCheck();
}

function saveAlarm() {
  try { if (alarm) localStorage.setItem('alarm', JSON.stringify(alarm)); else localStorage.removeItem('alarm'); } catch { /* ignorar */ }
  paintAlarm(); manageWake(); updateMine();
  clearInterval(alarmTimer); if (alarm) alarmTimer = window.setInterval(alarmCheck, alarm.kind === 'getoff' ? 8000 : 15000);
}

async function manageWake() { // pantalla encendida mientras haya alarma: iOS pausa las webs en segundo plano
  try {
    const nav = navigator as unknown as { wakeLock?: { request(t: string): Promise<NonNullable<typeof wake>> } };
    if (alarm && !wake && nav.wakeLock) { wake = await nav.wakeLock.request('screen'); wake.addEventListener('release', () => { wake = null; }); }
    else if (!alarm && wake) { await wake.release(); wake = null; }
  } catch { wake = null; }
}

function paintAlarm() {
  const el = $('alarm');
  if (!alarm) { el.hidden = true; return; }
  const p = byCode.get(alarm.code); el.hidden = false;
  el.innerHTML = `<span class="al-t">${alarm.kind === 'getoff' ? `🛑 Bajas en ${esc(p?.nombre ?? '')} · L${esc(alarm.linea)}` : `🔔 L${esc(alarm.linea)} · ${esc(p?.nombre ?? '')} · ≤${alarm.min} min`}</span><button aria-label="Cancelar alarma">✕</button>`;
  (el.querySelector('.al-t') as HTMLElement).onclick = () => { if (alarm) selectLine(alarm.linea, { dir: alarm.dir, stop: alarm.code }); };
  (el.querySelector('button') as HTMLElement).onclick = () => { dropServer(alarm); alarm = null; saveAlarm(); toast('Alarma cancelada'); };
}

async function alarmCheck() {
  const a = alarm; if (!a) return;
  const rec = lineaDe.get(a.linea)?.recorridos[a.dir]; if (!rec) return;
  const route = new Route(rec, byCode); const idx = route.stops.findIndex((x) => x.codigo === a.code); if (idx < 0) return;
  if (a.kind === 'getoff') { // seguimiento por GPS dentro del bus
    const pos = await getPos(); if (!pos || alarm !== a) return; userPos = pos;
    const sn = route.snap(pos.lat, pos.lon); if (!sn || sn.d > 150) return; // no vas sobre la ruta
    const remain = route.stopPos[idx] - sn.s; const left = idx - route.lastPassed(sn.s); const nm = route.stops[idx].nombre;
    if (remain <= 150) { alarm = null; saveAlarm(); notifyUser(`🚏 ¡Bájate aquí! Parada ${nm}`); }
    else if ((left <= 2 || remain <= 500) && !a.warned) { a.warned = true; saveAlarm(); notifyUser(`Prepárate: te bajas en ${nm} (a ${fmtDist(remain)})`); }
    return;
  }
  const [rb, ra] = await Promise.allSettled([fetch('/tr/buses').then((r) => r.json()), fetch(`/tr/${encodeURIComponent(a.linea)}`).then((r) => r.json())]);
  if (alarm !== a) return;
  const buses = rb.status === 'fulfilled' ? (rb.value.buses as Bus[] | null) : null;
  const llg = ra.status === 'fulfilled' ? (ra.value.llegadas as LlegadaLinea[] | null) : null;
  let m: number | null = null;
  const live = llg?.find((x) => x.parada === a.code && x.enVivo); if (live) m = mins(live.hora);
  if (m === null && buses) {
    const sp = route.stopPos[idx];
    for (const b of buses) {
      if (b.linea !== a.linea || b.sentido !== a.dir + 1) continue;
      const sn = route.snap(b.lat, b.lon); if (!sn || sn.d > 250 || sn.s > sp + 25) continue;
      const e = Math.max(0, Math.round(((sp - sn.s) / 4.5 + (idx - route.lastPassed(sn.s)) * 20) / 60));
      if (m === null || e < m) m = e;
    }
  }
  if (m !== null && m <= a.min) fireAlarm(a, m);
}

function beep() {
  try {
    if (!audio) return; const t = audio.currentTime;
    [0, 0.28, 0.56].forEach((d) => { const o = audio!.createOscillator(), g = audio!.createGain(); o.frequency.value = 880; o.connect(g); g.connect(audio!.destination); g.gain.setValueAtTime(0.0001, t + d); g.gain.exponentialRampToValueAtTime(0.4, t + d + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.22); o.start(t + d); o.stop(t + d + 0.25); });
  } catch { /* ignorar */ }
}

function fireAlarm(a: Alarm, m: number) {
  const p = byCode.get(a.code); dropServer(a); alarm = null; saveAlarm();
  notifyUser(m <= 0 ? `¡Tu bus L${a.linea} está llegando a ${p?.nombre}!` : `Tu bus L${a.linea} llega a ${p?.nombre} en ~${m} min`);
}

function notifyUser(msg: string) {
  const ring = $('ring'); ring.hidden = false; ring.innerHTML = `<b>${/^[^\x00-\x7F]/.test(msg) ? '' : '🔔 '}${esc(msg)}</b><small>Toca para cerrar</small>`; ring.onclick = () => { ring.hidden = true; };
  beep(); try { navigator.vibrate?.([300, 120, 300, 120, 300]); } catch { /* iOS no vibra */ }
  try {
    if ('Notification' in window && Notification.permission === 'granted') {
      const opts = { body: msg, tag: 'bus-alarm', icon: '/icon-192.png' };
      if ('serviceWorker' in navigator) navigator.serviceWorker.getRegistration().then((r) => { if (r) void r.showNotification('Bus Huelva', opts); else new Notification('Bus Huelva', opts); });
      else new Notification('Bus Huelva', opts);
    }
  } catch { /* ignorar */ }
}

paintAlarm(); if (alarm) { alarmTimer = window.setInterval(alarmCheck, 15000); alarmCheck(); manageWake(); }

// ============ Modo general (sin línea) ============
function drawStops() {
  stopLayer.clearLayers();
  for (const p of net.paradas) L.circleMarker([p.lat, p.lon], { radius: 6, color: '#fff', weight: 2, fillColor: '#0b3d91', fillOpacity: 1 }).on('click', () => openStop(p)).addTo(stopLayer);
}

async function loadBuses() {
  if (sel) return;
  try {
    const r = await fetch('/tr/buses'); const { buses } = (await r.json()) as { buses: Bus[] | null };
    if (sel) return; if (!buses) return toast('Sin datos de buses ahora mismo');
    busLayer.clearLayers();
    for (const b of buses) L.marker([b.lat, b.lon], { zIndexOffset: 1000, icon: L.divIcon({ className: '', iconSize: [30, 30], iconAnchor: [15, 15], html: `<div class="bus-pin sm" style="--c:${b.colorLinea}">${esc(b.linea)}</div>` }) })
      .on('click', () => selectLine(b.linea, { dir: b.sentido - 1 })).addTo(busLayer);
  } catch { toast('Sin conexión'); }
}

async function loadArrivals() {
  if (!current) return;
  const code = current.codigo;
  try {
    const r = await fetch(`/tr/parada/${code}`); const { llegadas } = (await r.json()) as { llegadas: Llegada[] | null };
    if (current?.codigo !== code) return;
    const ul = $('arr');
    if (!llegadas) { ul.innerHTML = '<li>Sin información en tiempo real.</li>'; return; }
    const ls = llegadas.filter((l) => new Date(l.hora).getTime() > Date.now() - 30000).slice(0, 10);
    ul.innerHTML = ls.length ? ls.map((l) => `<li class="tap" data-l="${esc(l.linea)}"><span class="badge" style="background:${l.colorLinea}">${esc(l.linea)}</span>
      <span>${hhmm(l.hora)}</span><span class="eta ${l.enVivo ? 'live' : ''}">${etaTxt(l.hora)}<small>${l.enVivo ? 'en directo' : 'horario'}</small></span></li>`).join('')
      : '<li>Sin llegadas previstas ahora mismo.</li>';
  } catch { $('arr').innerHTML = '<li>Sin conexión.</li>'; }
}
$('arr').addEventListener('click', (e) => {
  const li = (e.target as HTMLElement).closest('li.tap') as HTMLElement | null; if (!li || !current) return;
  selectLine(li.dataset.l!, { stop: current.codigo });
});

function paintFav() { $('fav').textContent = current && favs.includes(current.codigo) ? '★' : '☆'; }
function closeStopSheet() { current = null; $('pseg').hidden = true; $('ptime').hidden = true; $('sheet').hidden = true; routeLayer.clearLayers(); $('fav').hidden = false; showHome(); }
function openStop(p: Parada) {
  if (sel) { setMineFromMap(p); return; }
  current = p; $('results').hidden = true; routeLayer.clearLayers(); $('fav').hidden = false; $('pseg').hidden = true; $('ptime').hidden = true;
  $('sname').textContent = p.nombre; $('smeta').textContent = `Parada ${p.codigo} · Líneas ${p.lineas.join(', ')} · toca una línea para seguir su bus`;
  $('arr').innerHTML = '<li>Cargando…</li>'; $('sheet').hidden = false; showHome(); paintFav();
  map.flyTo([p.lat, p.lon], Math.max(map.getZoom(), 16), { duration: 0.5 });
  loadArrivals();
}
function setMineFromMap(p: Parada) { if (sel?.route.stops.some((s) => s.codigo === p.codigo)) setMine(p.codigo); }
$('close').onclick = closeStopSheet;
$('fav').onclick = () => { if (!current) return; const c = current.codigo; favs = favs.includes(c) ? favs.filter((x) => x !== c) : [...favs, c]; localStorage.setItem('favs', JSON.stringify(favs)); paintFav(); };

function showResults(items: { t: string; s: string; go: () => void }[]) {
  const ul = $('results'); ul.innerHTML = '';
  for (const i of items) { const li = document.createElement('li'); li.innerHTML = `<span>${i.t}</span><small>${i.s}</small>`; li.onclick = i.go; ul.append(li); }
  ul.hidden = items.length === 0;
}
function favsList() {
  showResults(net.paradas.filter((p) => favs.includes(p.codigo)).map((p) => ({ t: '★ ' + esc(p.nombre), s: p.lineas.join(' '), go: () => openStop(p) })));
}
$('q').addEventListener('focus', () => { if (!($('q') as HTMLInputElement).value && mode === 'search') favsList(); });
$('q').addEventListener('input', (e) => {
  const raw = (e.target as HTMLInputElement).value.trim(); const q = norm(raw);
  if (mode === 'dest') return destSearch(raw);
  if (!q) return favsList();
  const ls = net.lineas.filter((l) => norm(l.codigo) === q || norm(l.nombre).includes(q)).map((l) => ({
    t: `Línea ${esc(l.codigo)}`, s: esc(l.nombre), go: () => { $('results').hidden = true; selectLine(l.codigo); },
  }));
  const ps = net.paradas.filter((p) => norm(p.nombre).includes(q) || p.codigo === q).slice(0, 15).map((p) => ({ t: esc(p.nombre), s: `${p.codigo} · ${p.lineas.join(' ')}`, go: () => { if (sel) closeLine(); openStop(p); } }));
  showResults([...ls, ...ps]);
});

$('loc').onclick = () => {
  if (!navigator.geolocation) return toast('Sin geolocalización');
  navigator.geolocation.getCurrentPosition((pos) => {
    const { latitude: la, longitude: lo } = pos.coords;
    const d = (p: Parada) => map.distance([la, lo], [p.lat, p.lon]);
    const pool = sel ? sel.route.stops : net.paradas;
    const near = [...pool].sort((a, b) => d(a) - d(b)).slice(0, 8);
    L.circleMarker([la, lo], { radius: 8, color: '#fff', weight: 3, fillColor: '#1a73e8', fillOpacity: 1 }).addTo(map);
    map.setView([la, lo], 16);
    showResults(near.map((p) => ({ t: esc(p.nombre), s: `${Math.round(d(p))} m · ${p.lineas.join(' ')}`, go: () => { $('results').hidden = true; if (sel) setMine(p.codigo); else openStop(p); } })));
  }, () => toast('No se pudo obtener tu ubicación'), { enableHighAccuracy: true, timeout: 8000 });
};

// ============ Cómo llegar ============
type Dest = Pt & { name: string };
function destSearch(raw: string) {
  const q = norm(raw);
  if (!q) return showResults([]);
  const ps = net.paradas.filter((p) => norm(p.nombre).includes(q)).slice(0, 6)
    .map((p) => ({ t: '🚏 ' + esc(p.nombre), s: p.lineas.join(' '), go: () => planTo({ lat: p.lat, lon: p.lon, name: p.nombre }) }));
  showResults(ps);
  clearTimeout(geoTimer);
  if (q.length < 3) return;
  geoTimer = window.setTimeout(async () => {
    try {
      const u = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&countrycodes=es&accept-language=es&viewbox=-7.06,37.34,-6.80,37.17&bounded=1&q=' + encodeURIComponent(raw + ', Huelva');
      const res = (await (await fetch(u)).json()) as { display_name: string; lat: string; lon: string; name?: string }[];
      if (mode !== 'dest') return;
      const pl = res.map((r) => ({ t: '📍 ' + esc(r.name || r.display_name.split(',')[0]), s: esc(r.display_name.split(',').slice(1, 3).join(',').trim()), go: () => planTo({ lat: +r.lat, lon: +r.lon, name: r.name || r.display_name.split(',')[0] }) }));
      showResults([...ps, ...pl]);
    } catch { /* sin geocodificador: quedan las paradas */ }
  }, 600);
}
$('go').onclick = () => {
  saving = null; mode = mode === 'dest' ? 'search' : 'dest';
  const q = $('q') as HTMLInputElement; q.value = ''; q.placeholder = mode === 'dest' ? '¿A dónde vas? Parada o dirección' : 'Buscar parada o línea';
  $('go').classList.toggle('active', mode === 'dest'); showResults([]); if (mode === 'dest') q.focus();
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
const fmtM = (m: number) => (m < 950 ? `${Math.max(10, Math.round(m / 10) * 10)} m` : `${(m / 1000).toFixed(1).replace('.', ',')} km`);
const HM = (d: Date) => d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
let plans: Plan[] = []; let planIdx = 0; let planFrom: Pt | null = null; let planDest: Dest | null = null;
let tmode: 'now' | 'dep' | 'arr' = 'now'; let tval = ''; let planToken = 0;
const profLabel = (id: string) => PROFILES.find((x) => x.id === id)?.label ?? id;

async function planTo(d: Dest) {
  if (saving) { places[saving] = { lat: d.lat, lon: d.lon, name: d.name }; localStorage.setItem('places', JSON.stringify(places)); toast(`${saving === 'home' ? 'Casa' : 'Trabajo'} guardado`); saving = null; }
  mode = 'search'; $('go').classList.remove('active'); ($('q') as HTMLInputElement).value = ''; ($('q') as HTMLInputElement).placeholder = 'Buscar parada o línea'; $('results').hidden = true;
  if (sel) closeLine();
  toast('Calculando ruta…');
  const from = await origin();
  planFrom = from; planDest = d; plans = planAll(graph, from, d); planIdx = 0;
  current = null; routeLayer.clearLayers(); $('fav').hidden = true; $('sheet').hidden = false; showHome();
  $('sname').textContent = 'Ruta a ' + d.name;
  $('pseg').hidden = true; $('ptime').hidden = true;
  if (!plans.length) { $('smeta').textContent = 'Sin ruta'; $('arr').innerHTML = '<li>No encuentro una ruta en bus razonable (¿origen o destino fuera de la red?).</li>'; return; }
  showPlan();
}

function showPlan() {
  const p = plans[planIdx]; routeLayer.clearLayers(); planToken++;
  renderPlanUI(); drawPlan(p, planFrom!, planDest!); renderPlan(p, planDest!); updateMeta();
}

function renderPlanUI() {
  const seg = $('pseg'); seg.hidden = plans.length < 2;
  seg.innerHTML = plans.map((p, i) => `<button data-i="${i}" class="${i === planIdx ? 'on' : ''}">${esc(profLabel(p.profile))}<small>${p.minutes} min</small></button>`).join('');
  seg.onclick = (e) => { const b = (e.target as HTMLElement).closest('button'); if (b) { planIdx = +b.dataset.i!; showPlan(); } };
  $('ptime').hidden = false;
}

function updateMeta() {
  const p = plans[planIdx]; if (!p) return;
  const base = `${p.minutes} min · ${p.buses} bus${p.buses > 1 ? 'es' : ''}${p.buses > 1 ? ` · ${p.buses - 1} trasbordo${p.buses > 2 ? 's' : ''}` : ''} · ${fmtM(p.walkM)} a pie`;
  let extra = `Llegas sobre las ${HM(new Date(Date.now() + p.minutes * 60000))}`;
  const [h, m] = (tval || '').split(':').map(Number);
  if (tmode !== 'now' && Number.isFinite(h)) {
    const t = new Date(); t.setHours(h, m, 0, 0); if (t.getTime() < Date.now() - 6 * 3600e3) t.setDate(t.getDate() + 1);
    extra = tmode === 'dep' ? `Sales a las ${HM(t)} · llegas sobre las ${HM(new Date(t.getTime() + p.minutes * 60000))}` : `Sal a las ${HM(new Date(t.getTime() - p.minutes * 60000))} para llegar a las ${HM(t)}`;
  }
  $('smeta').innerHTML = `${esc(base)}<br><b>${esc(extra)}</b>${tmode !== 'now' ? ' <i>(estimado por horario)</i>' : ' <i>· estimación</i>'}`;
  document.querySelectorAll<HTMLElement>('#pseg button').forEach((b) => { const q = plans[+b.dataset.i!]; if (q) b.querySelector('small')!.textContent = `${q.minutes} min`; });
}
$('tmode').addEventListener('change', () => {
  tmode = ($('tmode') as HTMLSelectElement).value as typeof tmode; const t = $('tval') as HTMLInputElement; t.hidden = tmode === 'now';
  if (tmode !== 'now' && !t.value) { const n = new Date(Date.now() + 30 * 60000); t.value = `${String(n.getHours()).padStart(2, '0')}:${String(n.getMinutes()).padStart(2, '0')}`; tval = t.value; }
  updateMeta();
});
$('tval').addEventListener('input', () => { tval = ($('tval') as HTMLInputElement).value; updateMeta(); });

/** Tramo a pie por calles reales (con respaldo en línea recta). */
function walkSeg(a: Pt, b: Pt, rowId: string, token: number, acc: { sec: number; n: number; total: number; p: Plan }) {
  let ln = L.polyline([[a.lat, a.lon], [b.lat, b.lon]], { color: '#8e8e93', weight: 4, dashArray: '2 8' }).addTo(routeLayer);
  fetch(`/walk?a=${a.lat},${a.lon}&b=${b.lat},${b.lon}`).then((r) => r.json()).then((j: { code?: string; routes?: { distance: number; duration: number; geometry: { coordinates: [number, number][] } }[] }) => {
    if (token !== planToken || !j.routes?.[0]) return;
    const r = j.routes[0]; routeLayer.removeLayer(ln);
    ln = L.polyline(r.geometry.coordinates.map(([lo, la]) => [la, lo] as [number, number]), { color: '#8e8e93', weight: 4, dashArray: '2 8' }).addTo(routeLayer);
    const el = document.querySelector(`#${rowId} .wv`); if (el) el.textContent = `${Math.max(1, Math.round(r.duration / 60))} min (${fmtM(r.distance)})`;
    acc.sec += r.duration; acc.n++;
    if (acc.n === acc.total) { // ajustar el total con el tiempo a pie real
      acc.p.minutes = Math.max(1, Math.round(acc.p.minutes + (acc.sec - acc.p.walkM / 1.25) / 60)); updateMeta();
    }
  }).catch(() => { /* se queda la línea recta */ });
}

function drawPlan(p: Plan, from: Pt, to: Pt) {
  const pts: [number, number][] = []; const token = planToken;
  const segs: { a: Pt; b: Pt; id: string }[] = [];
  if (p.walkStart.m >= 40) segs.push({ a: from, b: p.walkStart.to, id: 'w-start' });
  p.legs.forEach((l, i) => {
    const lin = lineaDe.get(l.linea); const rec = lin?.recorridos.find((r) => r.sentido === l.sentido);
    let ll = l.stops.map((s) => [s.lat, s.lon] as [number, number]);
    if (rec) {
      const rt = new Route(rec, byCode); const a = rt.stops.findIndex((s) => s.codigo === l.stops[0].codigo); const b = rt.stops.findIndex((s) => s.codigo === l.stops.at(-1)!.codigo);
      if (a >= 0 && b > a) ll = rt.slice(rt.stopPos[a], rt.stopPos[b]);
    }
    pts.push(...ll);
    L.polyline(ll, { color: '#fff', weight: 10 }).addTo(routeLayer);
    L.polyline(ll, { color: l.color, weight: 6, opacity: 0.95 }).addTo(routeLayer);
    L.circleMarker(ll[0], { radius: 8, color: '#fff', weight: 3, fillColor: l.color, fillOpacity: 1 }).bindTooltip('Sube L' + l.linea).addTo(routeLayer);
    p.transfers.filter((t) => t.after === i).forEach((x, k) => segs.push({ a: x.from, b: x.to, id: `w-x${i}-${k}` }));
  });
  if (dist(p.walkEnd.from, to) >= 40) segs.push({ a: p.walkEnd.from, b: to, id: 'w-end' });
  const acc = { sec: 0, n: 0, total: segs.length, p };
  segs.forEach((sg) => walkSeg(sg.a, sg.b, sg.id, token, acc));
  L.circleMarker([to.lat, to.lon], { radius: 9, color: '#fff', weight: 3, fillColor: '#ff3b30', fillOpacity: 1 }).addTo(routeLayer);
  map.fitBounds(L.latLngBounds([...pts, [from.lat, from.lon], [to.lat, to.lon]]).pad(0.25), { paddingBottomRight: [0, window.innerHeight * 0.4] });
}

function renderPlan(p: Plan, to: Dest) {
  const walk = (id: string, m: number, name: string) => `<div class="step" id="${id}"><span class="ic">🚶</span><div>Camina <span class="wv">${walkMin(m)} min (${fmtM(m)})</span> hasta <b>${esc(name)}</b></div></div>`;
  const rows: string[] = p.walkStart.m < 40 ? [] : [walk('w-start', p.walkStart.m, p.walkStart.to.nombre)];
  p.legs.forEach((l, i) => {
    const a = l.stops[0], b = l.stops.at(-1)!;
    rows.push(`<div class="step"><span class="ic"><span class="badge" style="background:${l.color}">${esc(l.linea)}</span></span><div>${l.continua ? 'Sigues en el mismo bus. ' : ''}${l.continua ? '' : `Sube en <b>${esc(a.nombre)}</b><br>`}Baja en <b>${esc(b.nombre)}</b><small>${l.stops.length - 1} paradas · ~${l.minutes} min · ${esc(l.sentido.split('—')[0].trim())}</small>${i === 0 ? '<small id="rt0">Consultando próximo bus…</small>' : ''}<button class="follow" data-l="${esc(l.linea)}" data-s="${a.codigo}">Seguir este bus en el mapa</button></div></div>`);
    p.transfers.filter((t) => t.after === i).forEach((x, k) => rows.push(walk(`w-x${i}-${k}`, x.m, x.to.nombre)));
  });
  const rest = Math.round(dist(p.walkEnd.from, to)); if (rest >= 40) rows.push(walk('w-end', rest, to.name));
  $('arr').innerHTML = rows.join('');
  $('arr').querySelectorAll<HTMLElement>('.follow').forEach((b) => b.onclick = () => selectLine(b.dataset.l!, { stop: b.dataset.s }));
  const first = p.legs[0]; const tok = planToken;
  fetch(`/tr/parada/${first.stops[0].codigo}`).then((r) => r.json()).then(({ llegadas }: { llegadas: Llegada[] | null }) => {
    const el = document.getElementById('rt0'); if (!el || tok !== planToken) return;
    const n = llegadas?.find((l) => l.linea === first.linea && new Date(l.hora).getTime() > Date.now() - 20000);
    el.innerHTML = n ? `<b class="rt">Próximo bus: ${mins(n.hora) >= 90 ? 'a las ' + hhmm(n.hora) : mins(n.hora) + ' min'}</b> (${n.enVivo ? 'en directo' : 'horario'})` : 'Sin próximo bus previsto ahora mismo';
  }).catch(() => { const el = document.getElementById('rt0'); if (el) el.textContent = ''; });
}

// ============ Pantalla de inicio: avisos, favoritas, casa/trabajo, tarifas ============
type Aviso = { titulo: string; slug: string; severidad: string; vigenciaDesde: string; vigenciaHasta: string };
type Tarifa = { titulo: string; importe: number; unidad: string; destacada?: boolean };
type Place = { lat: number; lon: number; name: string };
let avisos: Aviso[] = []; let tarifas: Tarifa[] = [];
let homeView: 'home' | 'tarifas' = 'home';
let places: { home?: Place; work?: Place } = {};
try { places = JSON.parse(localStorage.getItem('places') ?? '{}'); } catch { places = {}; }
let saving: 'home' | 'work' | null = null;
let homeTimer: number | undefined;

async function loadInfo() {
  try {
    const [a, t] = await Promise.all([fetch('/info/avisos').then((r) => r.json()), fetch('/info/tarifas').then((r) => r.json())]);
    const now = Date.now();
    avisos = ((a.docs ?? []) as Aviso[]).filter((x) => { const d = Date.parse(x.vigenciaDesde), h = Date.parse(x.vigenciaHasta); return h >= d && h >= now && d <= now + 7 * 864e5; });
    tarifas = ((t.docs ?? []) as Tarifa[]).sort((x, y) => Number(!!y.destacada) - Number(!!x.destacada));
    if (!$('home').hidden) renderHome();
  } catch { /* sin información adicional */ }
}
const eur = (n: number) => n.toFixed(2).replace('.', ',') + ' €';
const unidad = (u: string) => ({ por_viaje: 'por viaje', mensual: 'al mes', por_dia: 'por día' })[u] ?? u;
const sevClass = (v: string) => (/crit|grave|urgent|emerg/i.test(v) ? 'crit' : /alert|import|warn|aten/i.test(v) ? 'warn' : 'info');
const fdate = (iso: string) => new Date(iso).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });

function showHome() {
  const h = $('home'); const should = !sel && $('sheet').hidden;
  h.hidden = !should; clearInterval(homeTimer);
  if (should) { renderHome(); homeTimer = window.setInterval(() => { if (!document.hidden) homeArrivals(); }, 30000); }
}

function renderHome() {
  const h = $('home');
  if (homeView === 'tarifas') {
    h.innerHTML = `<div class="grab"><i></i></div><div class="head"><div><h2>Tarifas</h2><small>Precios oficiales de EMTUSA</small></div><div class="acts"><button class="round" data-act="back" aria-label="Volver">‹</button></div></div>
      <ul id="arr" class="fares">${tarifas.length ? tarifas.map((t) => `<li><span class="nm">${esc(t.titulo)}${t.destacada ? ' <small class="star">★ destacada</small>' : ''}</span><span class="eta">${t.importe === 0 ? 'Gratis' : eur(t.importe)}<small>${t.importe === 0 ? unidad(t.unidad) : unidad(t.unidad)}</small></span></li>`).join('') : '<li>Sin datos de tarifas ahora mismo.</li>'}</ul>`;
    return;
  }
  const place = (k: 'home' | 'work', ico: string, label: string) => `<button class="quick-b" data-act="${k}"><span class="qi">${ico}</span><b>${label}</b><small>${places[k] ? esc(places[k]!.name) : 'Toca para elegir'}</small></button>`;
  const favRows = net.paradas.filter((p) => favs.includes(p.codigo)).slice(0, 6).map((p) => `<li class="frow" data-c="${p.codigo}" role="button" tabindex="0" aria-label="Parada ${esc(p.nombre)}"><span class="nm">${esc(p.nombre)}<small>${p.codigo}</small></span><span class="fa" id="fa-${p.codigo}"></span></li>`).join('');
  h.innerHTML = `<div class="grab"><i></i></div>
    <div class="head"><div><h2>Bus Huelva</h2><small>EMTUSA · tiempo real</small></div></div>
    ${avisos.slice(0, 3).map((a) => `<a class="aviso ${sevClass(a.severidad)}" href="https://www.emtusahuelva.com/avisos/${encodeURIComponent(a.slug)}" target="_blank" rel="noopener"><b>${esc(a.titulo)}</b><small>${fdate(a.vigenciaDesde)}${a.vigenciaDesde.slice(0, 10) !== a.vigenciaHasta.slice(0, 10) ? ' – ' + fdate(a.vigenciaHasta) : ''}</small></a>`).join('')}
    <div class="quick">${place('home', '🏠', 'Casa')}${place('work', '💼', 'Trabajo')}<button class="quick-b" data-act="tarifas"><span class="qi">🎫</span><b>Tarifas</b><small>Bonos y billetes</small></button></div>
    <div id="hal"></div>
    <h3 class="sec">Mis paradas</h3>
    ${favRows ? `<ul class="flist">${favRows}</ul>` : '<p class="hint">Busca una parada y pulsa ☆ para tenerla aquí con sus próximos buses.</p>'}`;
  homeArrivals(); loadHomeAlarms();
}

async function homeArrivals() {
  for (const p of net.paradas.filter((x) => favs.includes(x.codigo)).slice(0, 6)) {
    try {
      const { llegadas } = (await (await fetch(`/tr/parada/${p.codigo}`)).json()) as { llegadas: Llegada[] | null };
      const el = document.getElementById('fa-' + p.codigo); if (!el) continue;
      const ls = (llegadas ?? []).filter((l) => new Date(l.hora).getTime() > Date.now() - 20000).slice(0, 3);
      el.innerHTML = ls.length ? ls.map((l) => `<span class="mini ${l.enVivo ? 'live' : ''}" style="--c:${l.colorLinea}"><b>${esc(l.linea)}</b> ${etaTxt(l.hora).replace(' min', "'")}</span>`).join('') : '<span class="none">Sin buses</span>';
    } catch { /* sin conexión */ }
  }
}

const dayLbl = (d: string | null) => d === '1,2,3,4,5' ? 'L–V' : d === '0,6' ? 'Fin de semana' : d === '0,1,2,3,4,5,6' ? 'Todos los días' : (d ?? '');
async function loadHomeAlarms() {
  const el = document.getElementById('hal'); if (!el || !getPushId()) return;
  try {
    const list: ServerAlarm[] = await listAlarms();
    el.innerHTML = list.length ? `<h3 class="sec">Alarmas en la nube</h3><ul class="flist">${list.map((a) => `<li class="frow"><span class="nm">L${esc(a.linea)} · ${esc(a.name || a.code)}<small>${a.kind === 'weekly' ? `${dayLbl(a.days)} desde las ${a.time} · ≤${a.min} min` : `Una vez · ≤${a.min} min`}</small></span><button class="round" data-act="delal" data-id="${a.id}" aria-label="Borrar alarma">✕</button></li>`).join('')}</ul>` : '';
  } catch { /* sin conexión con el servidor de avisos */ }
}

let pressT: number | undefined; let longPressed = false;
$('home').addEventListener('pointerdown', (e) => {
  const b = (e.target as HTMLElement).closest('[data-act="home"],[data-act="work"]') as HTMLElement | null; if (!b) return;
  longPressed = false; pressT = window.setTimeout(() => { longPressed = true; const k = b.dataset.act as 'home' | 'work'; if (places[k]) { delete places[k]; localStorage.setItem('places', JSON.stringify(places)); toast(`${k === 'home' ? 'Casa' : 'Trabajo'} borrado`); renderHome(); } }, 650);
});
for (const t of ['pointerup', 'pointercancel', 'pointerleave']) $('home').addEventListener(t, () => clearTimeout(pressT));
$('home').addEventListener('click', (e) => {
  const el = e.target as HTMLElement;
  const fr = el.closest('.frow') as HTMLElement | null; if (fr) { const p = byCode.get(fr.dataset.c!); if (p) openStop(p); return; }
  const b = el.closest('[data-act]') as HTMLElement | null; if (!b) return; const act = b.dataset.act!;
  if (act === 'delal') { deleteAlarm(b.dataset.id!).then(loadHomeAlarms).catch(() => toast('No pude borrar la alarma')); return; }
  if (act === 'tarifas') { homeView = 'tarifas'; renderHome(); }
  else if (act === 'back') { homeView = 'home'; renderHome(); }
  else if (act === 'home' || act === 'work') {
    if (longPressed) { longPressed = false; return; }
    const pl = places[act]; if (pl) { planTo(pl); return; }
    saving = act; mode = 'dest'; $('go').classList.add('active');
    const q = $('q') as HTMLInputElement; q.value = ''; q.placeholder = act === 'home' ? 'Dirección de tu casa' : 'Dirección de tu trabajo'; q.focus();
  }
});

// ============ Arranque ============
drawStops(); loadBuses();
setInterval(() => { if (!document.hidden) { loadBuses(); loadArrivals(); } }, 30000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { loadBuses(); loadArrivals(); if (sel) refreshLive(); if (alarm) { manageWake(); alarmCheck(); } } });
loadInfo(); showHome();
window.addEventListener('offline', () => toast('Sin conexión: no hay datos en directo'));
window.addEventListener('online', () => { toast('Conexión recuperada'); loadBuses(); loadInfo(); if (sel) refreshLive(); });
{ // enlaces compartidos: /?l=8&d=0&p=1034  ó  /?p=1034
  const qs = new URLSearchParams(location.search); const l = qs.get('l'), pc = qs.get('p'), d = qs.get('d');
  if (l && lineaDe.has(l)) selectLine(l, { dir: d !== null ? +d : undefined, stop: pc ?? undefined });
  else if (pc && byCode.has(pc)) openStop(byCode.get(pc)!);
}
if ('serviceWorker' in navigator && import.meta.env.PROD) navigator.serviceWorker.register('/sw.js');
