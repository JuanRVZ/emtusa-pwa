// Avisos Web Push con la app cerrada: suscripción y alarmas en el Worker (bus-huelva-push).
export const PUSH_API = 'https://bus-huelva-push.juanravaz.workers.dev';
export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
export const getPushId = (): string | null => { try { return localStorage.getItem('pushId'); } catch { return null; } };

const fromB64 = (s: string) => { const r = atob((s + '='.repeat((4 - (s.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(r, (c) => c.charCodeAt(0)); };

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(PUSH_API + path, init);
  const j = (await r.json()) as T & { error?: string };
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j;
}

/** Pide permiso, suscribe este dispositivo y lo registra en el servidor. Debe llamarse desde un gesto del usuario. */
export async function enablePush(): Promise<string> {
  if (!pushSupported()) throw new Error('Este navegador no admite avisos push (en iPhone: añade la app a la pantalla de inicio)');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Permiso de notificaciones denegado');
  await navigator.serviceWorker.register('/sw.js');
  const reg = await navigator.serviceWorker.ready;
  const { publicKey } = await api<{ publicKey: string }>('/vapid');
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromB64(publicKey) }));
  const { id } = await api<{ id: string }>('/subscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: getPushId() ?? undefined, subscription: sub.toJSON() }) });
  try { localStorage.setItem('pushId', id); } catch { /* ignorar */ }
  return id;
}

export type ServerAlarm = { id: string; linea: string; dir: number; code: string; name: string; min: number; kind: 'once' | 'weekly'; days: string | null; time: string | null; last_fired: string | null };
export type NewAlarm = { linea: string; dir: number; code: string; name: string; min: number; kind: 'once' | 'weekly'; days?: string; time?: string };

export async function createAlarm(a: NewAlarm): Promise<string | null> {
  const id = getPushId(); if (!id) return null;
  return (await api<{ id: string }>(`/alarm?sub=${id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(a) })).id;
}
export async function deleteAlarm(alarmId: string): Promise<void> {
  const id = getPushId(); if (!id) return;
  await api(`/alarm/${alarmId}?sub=${id}`, { method: 'DELETE' });
}
export async function listAlarms(): Promise<ServerAlarm[]> {
  const id = getPushId(); if (!id) return [];
  return (await api<{ alarms: ServerAlarm[] }>(`/alarms?sub=${id}`)).alarms;
}
export async function testPush(): Promise<void> { const id = getPushId(); if (id) await api(`/test?sub=${id}`, { method: 'POST' }); }
