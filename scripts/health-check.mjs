// Comprueba que la API pública de EMTUSA sigue teniendo la forma que espera la app.
// Código de salida 1 si algo cambió (lo usa la GitHub Action diaria para avisar).
const BASE = 'https://www.emtusahuelva.com';
const UA = { 'User-Agent': 'emtusa-pwa-personal/0.1 (comprobación diaria)', Accept: 'application/json' };
const get = async (path, text = false) => { const r = await fetch(BASE + path, { headers: UA }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return text ? r.text() : r.json(); };

const checks = [
  ['posición de buses (/tiempo-real/buses)', async () => {
    const j = await get('/tiempo-real/buses'); if (!Array.isArray(j.buses)) throw new Error('"buses" no es una lista');
    for (const b of j.buses.slice(0, 3)) for (const k of ['lat', 'lon', 'sentido', 'linea']) if (!(k in b)) throw new Error(`falta "${k}" en un bus`);
    return `${j.buses.length} buses`;
  }],
  ['llegadas por parada (/tiempo-real/parada/3017)', async () => {
    const j = await get('/tiempo-real/parada/3017'); if (!Array.isArray(j.llegadas)) throw new Error('"llegadas" no es una lista');
    for (const l of j.llegadas.slice(0, 3)) for (const k of ['linea', 'hora', 'enVivo', 'colorLinea']) if (!(k in l)) throw new Error(`falta "${k}" en una llegada`);
    return `${j.llegadas.length} llegadas`;
  }],
  ['llegadas por línea (/tiempo-real/1)', async () => {
    const j = await get('/tiempo-real/1'); if (!Array.isArray(j.llegadas)) throw new Error('"llegadas" no es una lista');
    for (const l of j.llegadas.slice(0, 3)) for (const k of ['parada', 'hora', 'enVivo']) if (!(k in l)) throw new Error(`falta "${k}"`);
    return `${j.llegadas.length} llegadas`;
  }],
  ['líneas y paradas (/api/lineas)', async () => {
    const j = await get('/api/lineas?limit=100&depth=2'); if (!Array.isArray(j.docs) || j.docs.length < 10) throw new Error('menos de 10 líneas');
    const con = j.docs.filter((l) => l.recorridos?.length && l.recorridos[0].paradas?.some((p) => p.codigo));
    if (con.length < 10) throw new Error('las líneas ya no traen recorridos con paradas y código');
    return `${j.docs.length} líneas`;
  }],
  ['coordenadas de paradas (/lineas/1)', async () => {
    const t = (await get('/lineas/1', true)).replace(/\\"/g, '"');
    const n = [...t.matchAll(/"nombre":"([^"]+)","codigo":"([^"]+)","lat":(-?[\d.]+),"lon":(-?[\d.]+)/g)].length;
    if (n < 20) throw new Error(`solo ${n} paradas con coordenadas (¿cambió el formato de la página?)`);
    return `${n} paradas con coordenadas`;
  }],
  ['avisos y tarifas (/api/avisos, /api/tarifas)', async () => {
    const a = await get('/api/avisos?limit=5&depth=0'), t = await get('/api/tarifas?limit=5&depth=0');
    if (!Array.isArray(a.docs) || !Array.isArray(t.docs)) throw new Error('forma inesperada');
    if (t.docs.length && !('importe' in t.docs[0] && 'titulo' in t.docs[0])) throw new Error('las tarifas cambiaron de campos');
    return `${a.docs.length} avisos, ${t.docs.length} tarifas`;
  }],
];

let fallos = 0;
for (const [nombre, fn] of checks) {
  try { console.log(`✅ ${nombre}: ${await fn()}`); } catch (e) { fallos++; console.log(`❌ ${nombre}: ${e.message}`); }
}
console.log(fallos ? `\n${fallos} comprobación(es) fallaron: la web de EMTUSA pudo cambiar.` : '\nTodo correcto.');
process.exit(fallos ? 1 : 0);
