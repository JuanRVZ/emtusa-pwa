import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './style.css';
import { buildGraph, plan, dist, type Pt, type Plan, type Parada } from './planner';
import { Route, type Rec } from './route';

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
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' }).addTo(map);
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
  renderPanel(); updateMine(); paintMinutes();
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
    rows.push(`<li class="srow ${sel!.mine === p.codigo ? 'mine' : ''}" data-c="${p.codigo}" style="--c:${linea.color}"><i class="dot"></i><span class="nm">${esc(p.nombre)}<small>${p.codigo}</small></span>${et}</li>`);
    if (i + 1 < route.stops.length) for (const t of tracked) if (t.sNow >= route.stopPos[i] && t.sNow < route.stopPos[i + 1])
      rows.push(`<li class="brow" style="--c:${linea.color}"><i class="bdot"></i><span>Bus a ${fmtDist(route.stopPos[i + 1] - t.sNow)} de <b>${esc(route.stops[i + 1].nombre)}</b></span></li>`);
  });
  list.innerHTML = rows.join(''); list.scrollTop = keep;
  list.onclick = (e) => { const li = (e.target as HTMLElement).closest('.srow') as HTMLElement | null; if (li) setMine(li.dataset.c!); };
  $('mine').hidden = !sel.mine; updateMine();
}

function scrollToMine() { document.querySelector('#slist .srow.mine')?.scrollIntoView({ block: 'center', behavior: 'smooth' }); }

function updateMine() {
  const box = $('mine'); if (!sel?.mine) { box.hidden = true; return; }
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
    <div class="alrow"><span>🔔 Avisarme a</span><div class="alopts">${[2, 5, 10].map((m) => `<button data-m="${m}" class="${isMyAlarm(m) ? 'on' : ''}">${m} min</button>`).join('')}</div></div>`;
  $('mclear').onclick = clearMine;
  $('mshare').onclick = async () => {
    const url = `${location.origin}/?l=${encodeURIComponent(sel!.linea.codigo)}&d=${sel!.dir}&p=${p.codigo}`;
    const text = `Línea ${sel!.linea.codigo} en ${p.nombre}`;
    try { if (navigator.share) await navigator.share({ title: 'Bus Huelva', text, url }); else { await navigator.clipboard.writeText(url); toast('Enlace copiado'); } } catch { /* cancelado */ }
  };
  box.onclick = (e) => { const b = (e.target as HTMLElement).closest('button[data-m]') as HTMLElement | null; if (b) toggleAlarm(+b.dataset.m!); };
}
setInterval(() => { if (sel) { updateMine(); renderPanel(); paintMinutes(); } }, 5000);

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
  for (const h of [el.querySelector('.grab')!, $('lhead')]) { h.addEventListener('pointerdown', down as EventListener); h.addEventListener('pointermove', move as EventListener); h.addEventListener('pointerup', up as EventListener); h.addEventListener('pointercancel', up as EventListener); }
})();

// ============ Alarma "avísame cuando mi bus esté a X min" ============
type Alarm = { linea: string; dir: number; code: string; min: number };
let alarm: Alarm | null = null;
try { alarm = JSON.parse(localStorage.getItem('alarm') ?? 'null'); } catch { alarm = null; }
let wake: { release(): Promise<void>; addEventListener(t: string, f: () => void): void } | null = null;
let audio: AudioContext | null = null;
let alarmTimer: number | undefined;

const isMyAlarm = (m: number) => !!alarm && !!sel && alarm.linea === sel.linea.codigo && alarm.dir === sel.dir && alarm.code === sel.mine && alarm.min === m;

function toggleAlarm(min: number) {
  if (!sel?.mine) return;
  try { audio ??= new AudioContext(); void audio.resume(); } catch { /* sin audio */ } // hay que desbloquearlo con un gesto del usuario
  if (isMyAlarm(min)) { alarm = null; toast('Alarma cancelada'); }
  else {
    alarm = { linea: sel.linea.codigo, dir: sel.dir, code: sel.mine, min };
    toast(`Te aviso cuando falten ${min} min. Mantén la app abierta`);
    try { if ('Notification' in window && Notification.permission === 'default') void Notification.requestPermission(); } catch { /* iOS sin PWA instalada */ }
  }
  saveAlarm(); alarmCheck();
}

function saveAlarm() {
  try { if (alarm) localStorage.setItem('alarm', JSON.stringify(alarm)); else localStorage.removeItem('alarm'); } catch { /* ignorar */ }
  paintAlarm(); manageWake(); updateMine();
  clearInterval(alarmTimer); if (alarm) alarmTimer = window.setInterval(alarmCheck, 15000);
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
  el.innerHTML = `<span class="al-t">🔔 L${esc(alarm.linea)} · ${esc(p?.nombre ?? '')} · ≤${alarm.min} min</span><button aria-label="Cancelar alarma">✕</button>`;
  (el.querySelector('.al-t') as HTMLElement).onclick = () => { if (alarm) selectLine(alarm.linea, { dir: alarm.dir, stop: alarm.code }); };
  (el.querySelector('button') as HTMLElement).onclick = () => { alarm = null; saveAlarm(); toast('Alarma cancelada'); };
}

async function alarmCheck() {
  const a = alarm; if (!a) return;
  const rec = lineaDe.get(a.linea)?.recorridos[a.dir]; if (!rec) return;
  const route = new Route(rec, byCode); const idx = route.stops.findIndex((x) => x.codigo === a.code); if (idx < 0) return;
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
  const p = byCode.get(a.code); alarm = null; saveAlarm();
  const msg = m <= 0 ? `¡Tu bus L${a.linea} está llegando a ${p?.nombre}!` : `Tu bus L${a.linea} llega a ${p?.nombre} en ~${m} min`;
  const ring = $('ring'); ring.hidden = false; ring.innerHTML = `<b>🔔 ${esc(msg)}</b><small>Toca para cerrar</small>`; ring.onclick = () => { ring.hidden = true; };
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
function closeStopSheet() { current = null; $('sheet').hidden = true; routeLayer.clearLayers(); $('fav').hidden = false; showHome(); }
function openStop(p: Parada) {
  if (sel) { setMineFromMap(p); return; }
  current = p; $('results').hidden = true; routeLayer.clearLayers(); $('fav').hidden = false;
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
async function planTo(d: Dest) {
  if (saving) { places[saving] = { lat: d.lat, lon: d.lon, name: d.name }; localStorage.setItem('places', JSON.stringify(places)); toast(`${saving === 'home' ? 'Casa' : 'Trabajo'} guardado`); saving = null; }
  mode = 'search'; $('go').classList.remove('active'); ($('q') as HTMLInputElement).value = ''; ($('q') as HTMLInputElement).placeholder = 'Buscar parada o línea'; $('results').hidden = true;
  if (sel) closeLine();
  toast('Calculando ruta…');
  const from = await origin();
  const p = plan(graph, from, d);
  current = null; routeLayer.clearLayers(); $('fav').hidden = true; $('sheet').hidden = false; showHome();
  $('sname').textContent = 'Ruta a ' + d.name;
  if (!p) { $('smeta').textContent = 'Sin ruta'; $('arr').innerHTML = '<li>No encuentro una ruta en bus razonable (¿origen o destino fuera de la red?).</li>'; return; }
  drawPlan(p, from, d); renderPlan(p, d);
}
function drawPlan(p: Plan, from: Pt, to: Pt) {
  const gray = { color: '#555', weight: 4, dashArray: '2 8' };
  const pts: [number, number][] = [];
  const line = (a: Pt, b: Pt) => L.polyline([[a.lat, a.lon], [b.lat, b.lon]], gray).addTo(routeLayer);
  line(from, p.legs[0].stops[0]);
  p.legs.forEach((l, i) => {
    const lin = lineaDe.get(l.linea); const rec = lin?.recorridos.find((r) => r.sentido === l.sentido);
    let ll = l.stops.map((s) => [s.lat, s.lon] as [number, number]);
    if (rec) { // trazado real entre la parada de subida y la de bajada
      const rt = new Route(rec, byCode); const a = rt.stops.findIndex((s) => s.codigo === l.stops[0].codigo); const b = rt.stops.findIndex((s) => s.codigo === l.stops.at(-1)!.codigo);
      if (a >= 0 && b > a) ll = rt.slice(rt.stopPos[a], rt.stopPos[b]);
    }
    pts.push(...ll);
    L.polyline(ll, { color: '#fff', weight: 10 }).addTo(routeLayer);
    L.polyline(ll, { color: l.color, weight: 6, opacity: 0.95 }).addTo(routeLayer);
    L.circleMarker(ll[0], { radius: 8, color: '#fff', weight: 3, fillColor: l.color, fillOpacity: 1 }).bindTooltip('Sube L' + l.linea).addTo(routeLayer);
    let last = l.stops.at(-1)!;
    for (const x of p.transfers.filter((t) => t.after === i)) { line(last, x.to); last = x.to; }
  });
  line(p.walkEnd.from, to);
  L.circleMarker([to.lat, to.lon], { radius: 9, color: '#fff', weight: 3, fillColor: '#d32f2f', fillOpacity: 1 }).addTo(routeLayer);
  map.fitBounds(L.latLngBounds([...pts, [from.lat, from.lon], [to.lat, to.lon]]).pad(0.25), { paddingBottomRight: [0, 260] });
}
function renderPlan(p: Plan, to: Dest) {
  const nBus = p.legs.filter((l) => !l.continua).length;
  $('smeta').textContent = `~${p.minutes} min · ${nBus} bus${nBus > 1 ? 'es' : ''}${nBus > 1 ? ` · ${nBus - 1} trasbordo${nBus > 2 ? 's' : ''}` : ''} · estimación`;
  const rows: string[] = p.walkStart.m < 40 ? [] : [`<div class="step"><span class="ic">🚶</span><div>Camina ${walkMin(p.walkStart.m)} min (${p.walkStart.m} m) hasta <b>${esc(p.walkStart.to.nombre)}</b></div></div>`];
  p.legs.forEach((l, i) => {
    const a = l.stops[0], b = l.stops.at(-1)!;
    rows.push(`<div class="step"><span class="ic"><span class="badge" style="background:${l.color}">${esc(l.linea)}</span></span><div>${l.continua ? 'Sigues en el mismo bus. ' : ''}${l.continua ? '' : `Sube en <b>${esc(a.nombre)}</b><br>`}Baja en <b>${esc(b.nombre)}</b><small>${l.stops.length - 1} paradas · ~${l.minutes} min · ${esc(l.sentido.split('—')[0].trim())}</small>${i === 0 ? '<small id="rt0">Consultando próximo bus…</small>' : ''}<button class="follow" data-l="${esc(l.linea)}" data-s="${a.codigo}">Seguir este bus en el mapa</button></div></div>`);
    for (const x of p.transfers.filter((t) => t.after === i)) rows.push(`<div class="step"><span class="ic">🚶</span><div>Camina ${walkMin(x.m)} min (${x.m} m) hasta <b>${esc(x.to.nombre)}</b></div></div>`);
  });
  const rest = Math.round(dist(p.walkEnd.from, to)); if (rest >= 40) rows.push(`<div class="step"><span class="ic">🚶</span><div>Camina ${walkMin(rest)} min (${rest} m) hasta <b>${esc(to.name)}</b></div></div>`);
  $('arr').innerHTML = rows.join('');
  $('arr').querySelectorAll<HTMLElement>('.follow').forEach((b) => b.onclick = () => selectLine(b.dataset.l!, { stop: b.dataset.s }));
  const first = p.legs[0];
  fetch(`/tr/parada/${first.stops[0].codigo}`).then((r) => r.json()).then(({ llegadas }: { llegadas: Llegada[] | null }) => {
    const el = document.getElementById('rt0'); if (!el) return;
    const n = llegadas?.find((l) => l.linea === first.linea && new Date(l.hora).getTime() > Date.now() - 20000);
    el.innerHTML = n ? `<b class="rt">Próximo bus: ${mins(n.hora)} min</b> (${n.enVivo ? 'en directo' : 'horario'})` : 'Sin próximo bus previsto ahora mismo';
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
  const favRows = net.paradas.filter((p) => favs.includes(p.codigo)).slice(0, 6).map((p) => `<li class="frow" data-c="${p.codigo}"><span class="nm">${esc(p.nombre)}<small>${p.codigo}</small></span><span class="fa" id="fa-${p.codigo}"></span></li>`).join('');
  h.innerHTML = `<div class="grab"><i></i></div>
    <div class="head"><div><h2>Bus Huelva</h2><small>EMTUSA · tiempo real</small></div></div>
    ${avisos.slice(0, 3).map((a) => `<a class="aviso ${sevClass(a.severidad)}" href="https://www.emtusahuelva.com/avisos/${encodeURIComponent(a.slug)}" target="_blank" rel="noopener"><b>${esc(a.titulo)}</b><small>${fdate(a.vigenciaDesde)}${a.vigenciaDesde.slice(0, 10) !== a.vigenciaHasta.slice(0, 10) ? ' – ' + fdate(a.vigenciaHasta) : ''}</small></a>`).join('')}
    <div class="quick">${place('home', '🏠', 'Casa')}${place('work', '💼', 'Trabajo')}<button class="quick-b" data-act="tarifas"><span class="qi">🎫</span><b>Tarifas</b><small>Bonos y billetes</small></button></div>
    <h3 class="sec">Mis paradas</h3>
    ${favRows ? `<ul class="flist">${favRows}</ul>` : '<p class="hint">Busca una parada y pulsa ☆ para tenerla aquí con sus próximos buses.</p>'}`;
  homeArrivals();
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
