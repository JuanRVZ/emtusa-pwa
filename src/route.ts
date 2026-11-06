// Trazado de un recorrido sobre calles: posición de buses y paradas medida en metros a lo largo de la ruta.
import { dist, type Parada } from './planner';

export type Rec = { sentido: string; paradas: string[]; geom: number[]; pos: number[] | null; len?: number };
export type LL = [number, number];

export class Route {
  pts: LL[] = [];
  cum: number[] = [0];
  len = 0;
  stopPos: number[] = [];
  stops: Parada[];

  constructor(rec: Rec, byCode: Map<string, Parada>) {
    for (let i = 0; i < rec.geom.length; i += 2) this.pts.push([rec.geom[i], rec.geom[i + 1]]);
    for (let i = 1; i < this.pts.length; i++) this.cum.push(this.cum[i - 1] + dist({ lat: this.pts[i - 1][0], lon: this.pts[i - 1][1] }, { lat: this.pts[i][0], lon: this.pts[i][1] }));
    this.len = this.cum[this.cum.length - 1];
    this.stops = rec.paradas.map((c) => byCode.get(c)!).filter(Boolean);
    if (rec.pos && rec.len && rec.pos.length === this.stops.length) {
      const k = this.len / rec.len; this.stopPos = rec.pos.map((x) => x * k);
    } else { // sin posiciones exactas: proyectar cada parada, siempre hacia delante
      let from = 0; this.stopPos = this.stops.map((s) => { const r = this.snap(s.lat, s.lon, from, Infinity); from = r ? Math.max(from, r.s) : from; return from; });
    }
  }

  /** Proyección del punto sobre la ruta. `from`/`to` limitan la zona de búsqueda (metros). */
  snap(lat: number, lon: number, from = 0, to = Infinity): { s: number; d: number } | null {
    const ky = 111320, kx = 111320 * Math.cos((lat * Math.PI) / 180);
    let best: { s: number; d: number } | null = null;
    for (let i = 0; i + 1 < this.pts.length; i++) {
      if (this.cum[i + 1] < from || this.cum[i] > to) continue;
      const ax = (this.pts[i][1] - lon) * kx, ay = (this.pts[i][0] - lat) * ky;
      const bx = (this.pts[i + 1][1] - lon) * kx, by = (this.pts[i + 1][0] - lat) * ky;
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
      const t = l2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2)) : 0;
      const d = Math.hypot(ax + t * dx, ay + t * dy);
      if (!best || d < best.d) best = { d, s: this.cum[i] + t * (this.cum[i + 1] - this.cum[i]) };
    }
    return best;
  }

  at(s: number): LL {
    s = Math.max(0, Math.min(this.len, s));
    let lo = 0, hi = this.cum.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (this.cum[m] <= s) lo = m; else hi = m; }
    const seg = this.cum[hi] - this.cum[lo], t = seg ? (s - this.cum[lo]) / seg : 0;
    return [this.pts[lo][0] + (this.pts[hi][0] - this.pts[lo][0]) * t, this.pts[lo][1] + (this.pts[hi][1] - this.pts[lo][1]) * t];
  }

  /** Tramo de ruta entre dos posiciones. */
  slice(s0: number, s1: number): LL[] {
    const out: LL[] = [this.at(s0)];
    for (let i = 0; i < this.pts.length; i++) if (this.cum[i] > s0 && this.cum[i] < s1) out.push(this.pts[i]);
    out.push(this.at(s1)); return out;
  }

  /** Índice de la última parada ya sobrepasada (-1 si aún no llegó a la primera). */
  lastPassed(s: number): number { let k = -1; for (let i = 0; i < this.stopPos.length; i++) if (this.stopPos[i] <= s) k = i; return k; }
}
