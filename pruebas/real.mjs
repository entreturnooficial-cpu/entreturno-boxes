// Comprueba el proyecto REAL de Supabase desde afuera, sin entrar con ninguna cuenta (no crea ni cambia nada):
//   node pruebas/real.mjs            (npm run test:real)
// Usa la dirección y la clave pública de web\config.js y el mismo web\conexion.js que usa la página.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import '../web/conexion.js';

const texto = readFileSync(new URL('../web/config.js', import.meta.url), 'utf8');
const url = /url:\s*"([^"]+)"/.exec(texto)[1];
const key = /key:\s*"([^"]+)"/.exec(texto)[1];
const almacen = { getItem: () => null, setItem() {}, removeItem() {} };
const conexion = (slug) => globalThis.crearConexion({ url, key, slug, almacen });

const CONSULTORIO = 'puntoalmagro', ANTES = 'yanina';      // la dirección de hoy y la que tuvo

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
await espera('foto sin sesión', conexion(CONSULTORIO).rpc('foto'), ['42501 (401)', '42501 (403)', 'PGRST']);
await espera('reservar sin sesión', conexion(CONSULTORIO).rpc('reservar', { p_box: 1, p_fecha: '2030-01-07', p_desde: 8, p_hasta: 12, p_servicio: '', p_plan: 'sena', p_maquinas: [], p_reglamento_version: 1 }), ['42501 (401)', '42501 (403)', 'PGRST']);
// El aviso de datos personales se lee sin entrar: con su versión, sin llaves sin completar y con la huella de ese mismo texto
{
  const p = (await conexion(CONSULTORIO).rpc('portada')).site?.privacy ?? {};
  const huella = createHash('sha256').update(p.text ?? '', 'utf8').digest('hex').slice(0, 32);
  const ok = p.version >= 1 && p.text.length > 3000 && !/[{}]/.test(p.text) && p.hash === huella && p.text.includes('AGENCIA DE ACCESO A LA INFORMACIÓN PÚBLICA');
  if (!ok) fallas++;
  console.log(`  ${ok ? '[OK]   ' : '[FALLA]'} ${'el aviso de datos se lee sin entrar'.padEnd(52)} versión ${p.version}, ${p.text?.length} letras, huella ${p.hash === huella ? 'igual' : 'DISTINTA'}`);
}
const sinPermiso = ['42501 (401)', '42501 (403)', 'PGRST'];
// Las direcciones del consultorio: la de hoy y la que tuvo dan el mismo, y la página sigue en la de hoy
for (const d of [CONSULTORIO, ANTES]) {
  const s = (await conexion(d).rpc('portada')).site ?? {};
  const ok = s.slug === CONSULTORIO && s.name === 'Punto Almagro' && (s.tagline ?? '').length > 5;
  if (!ok) fallas++;
  console.log(`  ${ok ? '[OK]   ' : '[FALLA]'} ${`entrando por «${d}»`.padEnd(52)} ${s.name} · ${s.tagline} · ${s.slug}`);
}
const nadie = '00000000-0000-0000-0000-000000000000';
await espera('mover un turno sin sesión', conexion(CONSULTORIO).rpc('reprogramar_reserva', { p_reserva: nadie, p_box: 1, p_fecha: '2030-01-07', p_desde: 8 }), sinPermiso);
await espera('cambiar la política sin sesión', conexion(CONSULTORIO).rpc('guardar_politica', { p_dias: 7, p_sena_antes: 0, p_sena_despues: 0, p_total_antes: 100, p_total_despues: 0 }), sinPermiso);
await espera('aceptar el aviso sin sesión', conexion(CONSULTORIO).rpc('aceptar_privacidad', { p_privacidad: 'x', p_exterior: true }), sinPermiso);
await espera('cambiar los datos del aviso sin sesión', conexion(CONSULTORIO).rpc('guardar_privacidad', { p_responsable: 'x', p_domicilio: 'x', p_contacto: 'x@example.com' }), sinPermiso);
await espera('pedir acceso sin sesión', conexion(CONSULTORIO).rpc('pedir_acceso', { p_nombre: 'x', p_profesion: 'x', p_categoria: '00000000-0000-0000-0000-000000000000', p_telefono: '', p_cuit: '', p_condicion_iva: 5, p_privacidad: 'x', p_exterior: true }), sinPermiso);
// La copia de seguridad: los datos no se piden con la clave pública, y la función no entrega nada sin su clave
for (const [nombre, opciones, estado] of [
  ['pedir los datos de la copia con la clave pública', { method: 'POST', headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: '{}', datos: true }, 401],
  ['pedir la copia sin la clave', { method: 'POST' }, 401],
  ['pedir la copia con una clave inventada', { method: 'POST', headers: { 'x-entreturno-copia': 'x'.repeat(64) } }, 401],
  ['confirmar una copia sin la clave', { method: 'POST', headers: { 'x-entreturno-guardada': 'a'.repeat(64) } }, 401],
  ['abrir la dirección de la copia en el navegador', { method: 'GET' }, 405],
]) {
  const r = await fetch(opciones.datos ? `${url}/rest/v1/rpc/copia_datos` : `${url}/functions/v1/copia`, opciones);
  const cuerpo = await r.text();
  const ok = r.status === estado && (opciones.datos ? cuerpo.includes('"42501"') : cuerpo.length < 60);
  if (!ok) fallas++;
  console.log(`  ${ok ? '[OK]   ' : '[FALLA]'} ${nombre.padEnd(52)} ${r.status} ${cuerpo.slice(0, 60)}`);
}
// Las funciones internas no están publicadas
await espera('función interna', conexion(CONSULTORIO).rpc('mantener_todos', {}), ['PGRST202 (404)']);
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
