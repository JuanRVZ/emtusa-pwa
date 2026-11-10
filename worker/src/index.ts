// Worker de Bus Huelva: avisos Web Push con la app cerrada + captura de posiciones de buses.
// Cron cada minuto: consulta la API de EMTUSA y envía los avisos que toquen.
import { buildPushPayload } from '@block65/webcrypto-web-push';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Env = { DB: any; VAPID_PUBLIC: string; VAPID_PRIVATE: string; VAPID_SUBJECT: string };

const EMTUSA = 'https://www.emtusahuelva.com/tiempo-real';
const UA = { 'User-Agent': 'emtusa-pwa-personal/0.1', Accept: 'application/json' };
const ORIGIN_OK = (o: string) => o === 'https://bus-huelva.pages.dev' || o === 'https://bus.juanrvz.dev' || /^https:\/\/[a-z0-9-]+\.bus-huelva\.pages\.dev$/.test(o) || /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(o);
const MAX_ALARMS = 12;

const cors = (req: Request) => {
  const o = req.headers.get('Origin') ?? '';
  return ORIGIN_OK(o) ? { 'Access-Control-Allow-Origin': o, 'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'content-type', Vary: 'Origin' } : {};
};
const json = (req: Request, body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...cors(req) } });

// ---------- API ----------
async function handle(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url); const path = url.pathname;
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req) });
  if (path === '/vapid' && req.method === 'GET') return json(req, { publicKey: env.VAPID_PUBLIC });

  if (path === '/subscribe' && req.method === 'POST') {
    const b: any = await req.json().catch(() => null); const s = b?.subscription;
    if (!s?.endpoint || !/^https:\/\//.test(s.endpoint) || !s.keys?.p256dh || !s.keys?.auth) return json(req, { error: 'suscripción no válida' }, 400);
    const id = (b.id && /^[0-9a-f-]{36}$/.test(b.id) ? b.id : crypto.randomUUID()) as string;
    await env.DB.prepare('INSERT INTO subs (id,endpoint,p256dh,auth,created) VALUES (?1,?2,?3,?4,?5) ON CONFLICT(id) DO UPDATE SET endpoint=?2,p256dh=?3,auth=?4')
      .bind(id, s.endpoint, s.keys.p256dh, s.keys.auth, Date.now()).run();
    return json(req, { id });
  }

  const sub = url.searchParams.get('sub') ?? '';
  const known = sub && (await env.DB.prepare('SELECT id FROM subs WHERE id=?1').bind(sub).first());

  if (path === '/alarms' && req.method === 'GET') {
    if (!known) return json(req, { error: 'suscripción desconocida' }, 404);
    const { results } = await env.DB.prepare('SELECT id,linea,dir,code,name,min,kind,days,time,active,last_fired FROM alarms WHERE sub_id=?1 AND active=1 ORDER BY created DESC').bind(sub).all();
    return json(req, { alarms: results });
  }

  if (path === '/alarm' && req.method === 'POST') {
    if (!known) return json(req, { error: 'suscripción desconocida' }, 404);
    const b: any = await req.json().catch(() => null);
    const okLinea = typeof b?.linea === 'string' && /^[A-Za-z0-9]{1,5}$/.test(b.linea);
    const okCode = typeof b?.code === 'string' && /^\d{1,6}$/.test(b.code);
    const min = Number(b?.min), dir = Number(b?.dir);
    const kind = b?.kind === 'weekly' ? 'weekly' : 'once';
    const days = kind === 'weekly' ? String(b?.days ?? '').split(',').filter((d: string) => /^[0-6]$/.test(d)).join(',') : null;
    const time = kind === 'weekly' ? String(b?.time ?? '') : null;
    if (!okLinea || !okCode || !(min >= 1 && min <= 30) || !(dir === 0 || dir === 1) || (kind === 'weekly' && (!days || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time!))))
      return json(req, { error: 'datos de alarma no válidos' }, 400);
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM alarms WHERE sub_id=?1 AND active=1').bind(sub).first();
    if ((n?.n ?? 0) >= MAX_ALARMS) return json(req, { error: 'demasiadas alarmas' }, 429);
    const id = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO alarms (id,sub_id,linea,dir,code,name,min,kind,days,time,active,created) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,1,?11)')
      .bind(id, sub, b.linea, dir, b.code, String(b?.name ?? '').slice(0, 80), Math.round(min), kind, days, time, Date.now()).run();
    return json(req, { id });
  }

  const m = path.match(/^\/alarm\/([0-9a-f-]{36})$/);
  if (m && req.method === 'DELETE') {
    if (!known) return json(req, { error: 'suscripción desconocida' }, 404);
    await env.DB.prepare('DELETE FROM alarms WHERE id=?1 AND sub_id=?2').bind(m[1], sub).run();
    return json(req, { ok: true });
  }

  if (path === '/test' && req.method === 'POST') {
    if (!known) return json(req, { error: 'suscripción desconocida' }, 404);
    const s = await env.DB.prepare('SELECT * FROM subs WHERE id=?1').bind(sub).first();
    const r = await push(env, s, { title: 'Bus Huelva', body: 'Prueba de aviso: todo funciona 🎉', url: '/', tag: 'test' });
    return json(req, { status: r });
  }
  return json(req, { error: 'no encontrado' }, 404);
}

// ---------- Envío de push ----------
async function push(env: Env, s: any, msg: { title: string; body: string; url: string; tag: string }): Promise<number> {
  try {
    const payload = await buildPushPayload(
      { data: msg, options: { ttl: 120, urgency: 'high' } },
      { endpoint: s.endpoint, expirationTime: null, keys: { p256dh: s.p256dh, auth: s.auth } },
      { subject: env.VAPID_SUBJECT, publicKey: env.VAPID_PUBLIC, privateKey: env.VAPID_PRIVATE },
    );
    const r = await fetch(s.endpoint, payload as RequestInit);
    if (r.status === 404 || r.status === 410) { // suscripción caducada: limpiar
      await env.DB.batch([env.DB.prepare('DELETE FROM alarms WHERE sub_id=?1').bind(s.id ?? s.sub_id), env.DB.prepare('DELETE FROM subs WHERE id=?1').bind(s.id ?? s.sub_id)]);
    }
    return r.status;
  } catch { return 0; }
}

// ---------- Cron ----------
const madrid = (d: Date) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Madrid', weekday: 'short', hour: '2-digit', minute: '2-digit', year: 'numeric', month: '2-digit', day: '2-digit', hour12: false }).formatToParts(d).map((x) => [x.type, x.value]));
  return { dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday), h: +p.hour % 24, m: +p.minute, date: `${p.year}-${p.month}-${p.day}` };
};

async function tick(env: Env) {
  const now = new Date(); const ts = Math.floor(now.getTime() / 1000);
  // 1) posiciones de buses (para calcular tiempos reales entre paradas)
  try {
    const { buses } = (await (await fetch(`${EMTUSA}/buses`, { headers: UA })).json()) as { buses: { lat: number; lon: number; sentido: number; linea: string }[] | null };
    if (buses?.length) for (let i = 0; i < buses.length; i += 15) {
      const ch = buses.slice(i, i + 15);
      await env.DB.prepare(`INSERT INTO snaps (ts,linea,sentido,lat,lon) VALUES ${ch.map(() => '(?,?,?,?,?)').join(',')}`).bind(...ch.flatMap((b) => [ts, b.linea, b.sentido, b.lat, b.lon])).run();
    }
  } catch { /* sin datos esta vez */ }
  const t = madrid(now);
  if (t.h === 4 && t.m === 0) await env.DB.prepare('DELETE FROM snaps WHERE ts < ?1').bind(ts - 30 * 86400).run();

  // 2) alarmas
  // las de "una vez" que no llegaron a dispararse caducan a las 3 h: si no, sonarían por sorpresa con el primer bus del día siguiente
  await env.DB.prepare("DELETE FROM alarms WHERE kind='once' AND (active=0 OR created < ?1)").bind(now.getTime() - 3 * 3600e3).run();
  const { results } = await env.DB.prepare('SELECT a.*, s.endpoint, s.p256dh, s.auth FROM alarms a JOIN subs s ON s.id=a.sub_id WHERE a.active=1').all();
  if (!results.length) return;
  const nowMin = t.h * 60 + t.m;
  const due = (results as any[]).filter((a) => {
    if (a.kind === 'once') return true;
    if (a.last_fired === t.date) return false;
    if (!String(a.days).split(',').includes(String(t.dow))) return false;
    const [h, m] = a.time.split(':').map(Number); const start = h * 60 + m;
    return nowMin >= start - 5 && nowMin <= start + 40; // ventana de vigilancia
  });
  const lineas = [...new Set(due.map((a) => a.linea as string))];
  const llegadas = new Map<string, { parada: string; hora: string; enVivo: boolean }[]>();
  await Promise.all(lineas.map(async (l) => {
    try { const j = (await (await fetch(`${EMTUSA}/${encodeURIComponent(l)}`, { headers: UA })).json()) as { llegadas: any[] | null }; if (j.llegadas) llegadas.set(l, j.llegadas); } catch { /* ignorar */ }
  }));
  for (const a of due) {
    const arr = llegadas.get(a.linea)?.filter((x) => x.parada === a.code); if (!arr?.length) continue;
    // las horas de EMTUSA vienen en hora local de Madrid sin zona: comparar con la hora local actual
    const nowLocal = Date.UTC(+t.date.slice(0, 4), +t.date.slice(5, 7) - 1, +t.date.slice(8, 10), t.h, t.m, now.getSeconds());
    const next = arr.map((x) => ({ ...x, mins: Math.round((Date.parse(x.hora + 'Z') - nowLocal) / 60000) })).filter((x) => x.mins >= 0).sort((x, y) => x.mins - y.mins)[0];
    if (!next || next.mins > a.min) continue;
    if (next.mins > 2 && !next.enVivo) continue; // un horario sin GPS no basta para avisar con antelación
    const q = new URLSearchParams({ l: a.linea, d: String(a.dir), p: a.code });
    const st = await push(env, a, { title: `Línea ${a.linea}`, body: next.mins <= 0 ? `¡Tu bus está llegando a ${a.name || 'tu parada'}!` : `Tu bus llega a ${a.name || 'tu parada'} en ~${next.mins} min`, url: `/?${q}`, tag: `alarm-${a.id}` });
    if (st >= 200 && st < 300) {
      if (a.kind === 'once') await env.DB.prepare('UPDATE alarms SET active=0,last_fired=?2 WHERE id=?1').bind(a.id, t.date).run();
      else await env.DB.prepare('UPDATE alarms SET last_fired=?2 WHERE id=?1').bind(a.id, t.date).run();
    }
  }
}

export default {
  fetch: (req: Request, env: Env) => handle(req, env).catch((e) => json(req, { error: String(e?.message ?? e) }, 500)),
  scheduled: (_e: unknown, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }) => { ctx.waitUntil(tick(env)); },
};
