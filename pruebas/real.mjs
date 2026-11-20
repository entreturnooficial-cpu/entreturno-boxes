// Comprueba el proyecto REAL de Supabase desde afuera, sin entrar con ninguna cuenta (no crea ni cambia nada):
//   node pruebas/real.mjs            (npm run test:real)
// Usa la dirección y la clave pública de web\config.js y el mismo web\conexion.js que usa la página.
import { readFileSync } from 'node:fs';

import '../web/conexion.js';

const texto = readFileSync(new URL('../web/config.js', import.meta.url), 'utf8');
const url = /url:\s*"([^"]+)"/.exec(texto)[1];
const key = /key:\s*"([^"]+)"/.exec(texto)[1];
const almacen = { getItem: () => null, setItem() {}, removeItem() {} };
const conexion = (slug) => globalThis.crearConexion({ url, key, slug, almacen });

let fallas = 0;
async function espera(nombre, promesa, codigos) {
  let vino;
  try { vino = `respondió ${JSON.stringify(await promesa).slice(0, 120)}`; } catch (e) { vino = `${e.code} (${e.status})`; }
  const ok = codigos.some((c) => vino.startsWith(c));
  if (!ok) fallas++;
  console.log(`  ${ok ? '[OK]   ' : '[FALLA]'} ${nombre.padEnd(52)} ${vino}`);
}

console.log(`Proyecto: ${url}`);
// Sin sesión solo existe «portada»; un consultorio que no existe se rechaza con nuestro código (o sea: la función corre de verdad)
await espera('portada de un consultorio que no existe', conexion('no-existe-este-consultorio').rpc('portada'), ['consultorio_inexistente (400)']);
// Lo demás, sin sesión, no se puede llamar
await espera('foto sin sesión', conexion('yanina').rpc('foto'), ['42501 (401)', '42501 (403)', 'PGRST']);
await espera('reservar sin sesión', conexion('yanina').rpc('reservar', { p_box: 1, p_fecha: '2030-01-07', p_desde: 8, p_hasta: 12, p_servicio: '', p_plan: 'sena', p_maquinas: [], p_reglamento_version: 1 }), ['42501 (401)', '42501 (403)', 'PGRST']);
// Las funciones internas no están publicadas
await espera('función interna', conexion('yanina').rpc('mantener_todos', {}), ['PGRST202 (404)']);
// Las tablas no se pueden leer por la API
for (const tabla of ['reservas', 'miembros', 'pagos', 'consultorios']) {
  const r = await fetch(`${url}/rest/v1/${tabla}?select=*&limit=1`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
  const cuerpo = await r.text();
  const ok = r.status === 401 || r.status === 403 || r.status === 404;
  if (!ok) fallas++;
  console.log(`  ${ok ? '[OK]   ' : '[FALLA]'} ${('leer la tabla ' + tabla + ' por la API').padEnd(52)} ${r.status} ${cuerpo.slice(0, 90)}`);
}
console.log(fallas ? `\n${fallas} COMPROBACIONES FALLARON` : '\nTODO BIEN');
process.exit(fallas ? 1 : 0);
