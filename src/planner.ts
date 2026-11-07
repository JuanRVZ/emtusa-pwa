// Planificador de rutas: Dijkstra sobre un grafo de paradas + tramos de recorrido, con varios perfiles.
export type Parada = { codigo: string; nombre: string; lat: number; lon: number; lineas: string[] };
export type Recorrido = { sentido: string; paradas: string[] };
export type Linea = { codigo: string; nombre: string; color: string; recorridos: Recorrido[] };
export type Net = { paradas: Parada[]; lineas: Linea[] };
export type Pt = { lat: number; lon: number };

export type Leg = { continua?: boolean; linea: string; color: string; sentido: string; stops: Parada[]; minutes: number };
export type Plan = {
  profile: string;
  walkStart: { to: Parada; m: number };
  legs: Leg[];
  transfers: { after: number; from: Parada; to: Parada; m: number }[]; // caminata tras el tramo `after` (índice de leg)
  walkEnd: { from: Parada; m: number };
  minutes: number;   // duración total estimada (a pie + esperas + bus)
  walkM: number;     // metros totales a pie
  buses: number;     // autobuses distintos (sin contar continuar en cabecera)
  nextBus?: number | null;                  // hora real (ms) del próximo bus en la primera parada; null = sin datos
  nextBusLive?: boolean;
  walkAlone?: { m: number; s: number } | null; // ir andando directamente (por calles)
};

export type Profile = { id: string; label: string; boardS: number; walkW: number; maxEnd: number };
export const PROFILES: Profile[] = [
  { id: 'rapida', label: 'Más rápida', boardS: 7 * 60, walkW: 1.6, maxEnd: 900 },
  { id: 'directa', label: 'Menos trasbordos', boardS: 22 * 60, walkW: 1.6, maxEnd: 900 },
  { id: 'caminar', label: 'Menos caminata', boardS: 7 * 60, walkW: 4, maxEnd: 450 },
];

const BUS_MPS = 5.0;       // ~18 km/h de media urbana
const DWELL_S = 20;        // parada
const CURVE = 1.25;        // factor de rodeo sobre línea recta
const WALK_MPS = 1.25;
const WAIT_S = 5 * 60;     // espera media al subir (para la estimación mostrada)
const BOARD_S = 7 * 60;    // coste base de subir (espera + penalización)
const MAX_WALK_XFER = 250; // m máx. a pie entre paradas para trasbordar
const K_RIDE = 0, K_BOARD = 1, K_WALK = 2;

export function dist(a: Pt, b: Pt): number {
  const R = 6371000, r = Math.PI / 180;
  const dLa = (b.lat - a.lat) * r, dLo = (b.lon - a.lon) * r;
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

class Heap {
  a: [number, number][] = [];
  push(k: number, v: number) { const a = this.a; a.push([k, v]); let i = a.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; } }
  pop() { const a = this.a; const top = a[0]; const last = a.pop()!; if (a.length) { a[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < a.length && a[l][0] < a[m][0]) m = l; if (r < a.length && a[r][0] < a[m][0]) m = r; if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m; } } return top; }
  get size() { return this.a.length; }
}

type Edge = { to: number; w: number; k: number };

export function buildGraph(net: Net) {
  const byCode = new Map(net.paradas.map((p) => [p.codigo, p]));
  const stopIdx = new Map<string, number>();
  net.paradas.forEach((p, i) => stopIdx.set(p.codigo, i));
  const nStops = net.paradas.length;
  // nodos: [0..nStops) parada; luego nodos de tramo (recorrido, posición)
  const ride: { linea: Linea; rec: Recorrido; i: number; stop: Parada }[] = [];
  const adj: Edge[][] = net.paradas.map(() => []);
  const add = (a: number, b: number, w: number, k = K_RIDE) => adj[a].push({ to: b, w, k });
  for (const l of net.lineas) for (const rec of l.recorridos) {
    let prev = -1;
    rec.paradas.forEach((code, i) => {
      const stop = byCode.get(code); if (!stop) return;
      const id = nStops + ride.length; adj[id] = [];
      ride.push({ linea: l, rec, i, stop });
      const s = stopIdx.get(code)!;
      add(s, id, BOARD_S, K_BOARD);   // subir
      add(id, s, 0);                  // bajar
      if (prev >= 0) {
        const ps = ride[prev - nStops].stop;
        add(prev, id, (dist(ps, stop) * CURVE) / BUS_MPS + DWELL_S);
      }
      prev = id;
    });
  }
  // mismo autobús que cambia de sentido en cabecera: seguir sentado (sin volver a subir)
  const firsts = new Map<Recorrido, number>(), lasts = new Map<Recorrido, number>();
  ride.forEach((r, k) => { if (!firsts.has(r.rec)) firsts.set(r.rec, nStops + k); lasts.set(r.rec, nStops + k); });
  for (const l of net.lineas) for (const a of l.recorridos) for (const b of l.recorridos) {
    if (a === b || !firsts.has(b) || !lasts.has(a)) continue;
    const la = ride[lasts.get(a)! - nStops].stop, fb = ride[firsts.get(b)! - nStops].stop;
    if (dist(la, fb) < 400) add(lasts.get(a)!, firsts.get(b)!, 120);
  }
  // caminatas de trasbordo entre paradas cercanas (w = segundos reales a pie; se pondera al planificar)
  for (let i = 0; i < nStops; i++) for (let j = 0; j < nStops; j++) {
    if (i === j) continue; const d = dist(net.paradas[i], net.paradas[j]);
    if (d <= MAX_WALK_XFER) add(i, j, d / WALK_MPS, K_WALK);
  }
  return { net, adj, ride, nStops, stopIdx };
}
export type Graph = ReturnType<typeof buildGraph>;

export function plan(g: Graph, from: Pt, to: Pt, prof: Profile = PROFILES[0]): Plan | null {
  const { net, adj, ride, nStops } = g;
  const N = nStops + ride.length;
  const D = new Float64Array(N + 1).fill(Infinity);
  const prev = new Int32Array(N + 1).fill(-1);
  const START = N;
  const h = new Heap();
  net.paradas.forEach((p, i) => { const d = dist(from, p); if (d <= prof.maxEnd) { D[i] = (d / WALK_MPS) * prof.walkW; prev[i] = START; h.push(D[i], i); } });
  const endWalk = new Map<number, number>();
  net.paradas.forEach((p, i) => { const d = dist(to, p); if (d <= prof.maxEnd) endWalk.set(i, d); });
  if (!endWalk.size || !h.size) return null;

  let best = Infinity, bestStop = -1;
  while (h.size) {
    const [d, u] = h.pop();
    if (d > D[u]) continue;
    if (d >= best) break;
    if (u < nStops && endWalk.has(u)) { const tot = d + (endWalk.get(u)! / WALK_MPS) * prof.walkW; if (tot < best) { best = tot; bestStop = u; } }
    for (const e of adj[u] ?? []) {
      const w = e.k === K_BOARD ? e.w - BOARD_S + prof.boardS : e.k === K_WALK ? e.w * prof.walkW + 60 : e.w;
      const nd = d + w; if (nd < D[e.to]) { D[e.to] = nd; prev[e.to] = u; h.push(nd, e.to); }
    }
  }
  if (bestStop < 0) return null;

  const path: number[] = []; for (let n = bestStop; n !== START && n >= 0; n = prev[n]) path.push(n); path.reverse();
  const legs: Leg[] = []; const transfers: Plan['transfers'] = [];
  const mk = (r: typeof ride[number], st: Parada[]): Leg => {
    const sec = st.reduce((a, s, i) => i ? a + (dist(st[i - 1], s) * CURVE) / BUS_MPS + DWELL_S : a, 0);
    return { linea: r.linea.codigo, color: r.linea.color, sentido: r.rec.sentido, stops: st, minutes: Math.max(1, Math.round(sec / 60)) };
  };
  let cur: { r: typeof ride[number]; stops: Parada[]; cont?: boolean } | null = null; let lastAlight: Parada | null = null;
  for (let k = 0; k < path.length; k++) {
    const n = path[k];
    if (n >= nStops) {
      const r = ride[n - nStops];
      let cont = false;
      if (cur && cur.r.rec !== r.rec) { const st = cur.stops; const lg = mk(cur.r, st); if (cur.cont) lg.continua = true; legs.push(lg); lastAlight = st[st.length - 1]; cur = null; cont = true; }
      if (!cur) cur = { r, stops: [r.stop], cont }; else cur.stops.push(r.stop);
      const nx = path[k + 1];
      if (nx === undefined || nx < nStops) {
        const st = cur.stops; const lg = mk(cur.r, st); if (cur.cont) lg.continua = true; legs.push(lg);
        lastAlight = st[st.length - 1]; cur = null;
      }
    } else if (legs.length && lastAlight && n !== net.paradas.indexOf(lastAlight)) {
      const to2 = net.paradas[n]; if (!transfers.some((t) => t.to === to2)) { transfers.push({ after: legs.length - 1, from: lastAlight, to: to2, m: Math.round(dist(lastAlight, to2)) }); lastAlight = to2; }
    }
  }
  if (!legs.length) return null;
  const first = legs[0].stops[0], last = lastAlight!;
  const walkStart = { to: first, m: Math.round(dist(from, first)) };
  const walkEnd = { from: last, m: Math.round(dist(to, last)) };
  const walkM = walkStart.m + walkEnd.m + transfers.reduce((a, t) => a + t.m, 0);
  const buses = legs.filter((l) => !l.continua).length;
  const minutes = Math.max(1, Math.round((walkM / WALK_MPS + buses * WAIT_S + legs.reduce((a, l) => a + l.minutes * 60, 0)) / 60));
  return { profile: prof.id, walkStart, legs, transfers, walkEnd, minutes, walkM, buses };
}

/** Calcula las alternativas y elimina las que repiten el mismo itinerario. */
export function planAll(g: Graph, from: Pt, to: Pt): Plan[] {
  const out: Plan[] = []; const seen = new Set<string>();
  for (const pr of PROFILES) {
    const p = plan(g, from, to, pr); if (!p) continue;
    const sig = p.legs.map((l) => `${l.linea}:${l.stops[0].codigo}>${l.stops.at(-1)!.codigo}`).join('|');
    if (seen.has(sig)) continue; seen.add(sig); out.push(p);
  }
  return out;
}
