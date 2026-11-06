CREATE TABLE IF NOT EXISTS subs (
  id TEXT PRIMARY KEY, endpoint TEXT NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL, created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS alarms (
  id TEXT PRIMARY KEY, sub_id TEXT NOT NULL, linea TEXT NOT NULL, dir INTEGER NOT NULL, code TEXT NOT NULL,
  name TEXT, min INTEGER NOT NULL, kind TEXT NOT NULL,            -- 'once' | 'weekly'
  days TEXT, time TEXT,                                           -- weekly: '1,2,3,4,5' (0=domingo) y 'HH:MM' hora de Madrid
  active INTEGER NOT NULL DEFAULT 1, last_fired TEXT, created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS alarms_active ON alarms(active);
CREATE INDEX IF NOT EXISTS alarms_sub ON alarms(sub_id);
-- Posiciones de los buses cada minuto (base para calcular tiempos reales entre paradas)
CREATE TABLE IF NOT EXISTS snaps (ts INTEGER NOT NULL, linea TEXT NOT NULL, sentido INTEGER NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL);
CREATE INDEX IF NOT EXISTS snaps_ts ON snaps(ts);
