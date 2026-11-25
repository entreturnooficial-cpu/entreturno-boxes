// La copia de seguridad de punta a punta: lo que entrega la base, la función de Supabase «copia» TAL COMO SE SUBE
// (publicar/funcion-copia/index.ts), abrirla con la llave privada, restaurarla en una base nueva y comparar fila por fila.
// También el pedido nocturno de GitHub: corre el mismo guion del archivo .github/workflows/copia-diaria.yml.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { constants, createHash, createPublicKey, privateDecrypt } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { descifrarCopia, encabezadoDe } from '../copia/descifrar.mjs';
import { ensayarRestauracion } from '../copia/ensayar.mjs';
import { abrirPrivada, fraseNueva, generarPar, normalizar } from '../copia/llaves.mjs';
import { sqlDeRestauracion } from '../copia/restaurar.mjs';
import { cifrarCopia, huellaDe, mismaClave } from '../supabase/functions/_compartido/copia.ts';
import { LLAVES_DE_COPIA } from '../supabase/functions/_compartido/copia-llaves.ts';
import { armarBase, comoRol, crearCuenta } from './base.mjs';
import { CLAVE_PUBLICA, CLAVE_SECRETA, crearServidor } from './servidor-local.mjs';

const FRASE = 'abeja barco caja dado eco faro';
const CLAVE = 'c'.repeat(48);
// 4096 bits de verdad, como las que se usan (tarda un par de segundos)
const una = generarPar(FRASE, 'Santiago Prueba');
const dos = generarPar('gato hada isla jarra lana mano', 'Tomás');
const privadaUna = abrirPrivada(una.privada, FRASE);

let s;
let manejador;
let carpeta;
let armada;
const env = {};

before(async () => {
  s = await crearServidor();
  execFileSync(process.execPath, [fileURLToPath(new URL('../publicar/armar_funcion.mjs', import.meta.url))]);
  armada = readFileSync(new URL('../publicar/funcion-copia/index.ts', import.meta.url), 'utf8');
  // las llaves de verdad se cambian por las de la prueba (es lo único que se toca)
  const conLlaves = armada.replace(/export const LLAVES_DE_COPIA: LlavePublica\[\] = \[[\s\S]*?\];/, `export const LLAVES_DE_COPIA: LlavePublica[] = ${JSON.stringify([una.publica, dos.publica])};`);
  assert.notEqual(conLlaves, armada);
  await mover();
  carpeta = mkdtempSync(path.join(tmpdir(), 'funcion-copia-'));
  const archivo = path.join(carpeta, 'index.ts');
  writeFileSync(archivo, conLlaves);
  globalThis.Deno = { env: { get: (k) => env[k] }, serve: (fn) => { manejador = fn; } };
  await import(pathToFileURL(archivo).href);
  Object.assign(env, { SUPABASE_URL: s.url, SUPABASE_SERVICE_ROLE_KEY: CLAVE_SECRETA, COPIA_CLAVE: ` ${CLAVE}\n` });      // pegada con un espacio y un salto de más
});

after(async () => {
  delete globalThis.Deno;
  if (carpeta) rmSync(carpeta, { recursive: true, force: true });
  if (s) await s.cerrar();
});

/** Movimiento de verdad en el consultorio de ejemplo: reservas, pagos, una cancelación y una factura con centavos y tildes. */
async function mover() {
  const pros = (await s.pg.query(`select usuario_id, id from public.miembros m where rol = 'pro' and estado = 'aprobado' and exists (select 1 from interno.consentimientos k where k.miembro_id = m.id) order by nombre`)).rows;
  const como = (quien, sql, params) => comoRol(s.pg, 'authenticated', quien.usuario_id, (tx) => tx.query(sql, params)).then((r) => Object.values(r.rows[0])[0]);
  for (let i = 0; i < 6; i++) {
    let dia = new Date(Date.now() + (6 + i * 2) * 864e5);
    if (dia.getUTCDay() === 0) dia = new Date(dia.getTime() + 864e5);
    const r = await como(pros[i % pros.length], `select public.reservar('lavanda', $1, $2::date, 8, 12, $3, 'total', '{}'::uuid[], 1)`, [(i % 3) + 1, dia.toISOString().slice(0, 10), `Control n.º ${i} — piel & uñas "ñandú"`]);
    if (i < 4) await como(pros[i % pros.length], `select public.simular_pago('lavanda', $1, 'total')`, [r.id]);
    if (i === 1) await como(pros[i % pros.length], `select public.cancelar_reserva('lavanda', $1)`, [r.id]);
  }
  await s.pg.query(`insert into interno.mp_cuentas (consultorio_id, ambiente, estado, mp_user_id, nombre, vence) select id, 'real', 'conectada', '111222333', 'Laura Lavanda', now() + interval '90 days' from public.consultorios`);
  await s.pg.query(`insert into interno.ajustes (clave, valor) values ('funcion_mp_url', 'https://proyecto-viejo.supabase.co/functions/v1/mp'), ('mail_soporte', 'soporte@entreturno.prueba')`);
  assert.ok((await s.pg.query(`select count(*)::int as n from public.avisos where estado = 'pendiente'`)).rows[0].n > 3);
}

const pedir = (cabeceras = { 'x-entreturno-copia': CLAVE }, metodo = 'POST') =>
  manejador(new Request('https://proyecto.supabase.co/functions/v1/copia', { method: metodo, headers: cabeceras }));
const copias = async () => (await s.pg.query('select bytes, huella, llaves, guardada_en is not null as guardada from interno.copias order by hecha_en')).rows;

test('las llaves: la frase abre la privada (con mayúsculas o espacios de más), otra frase no, y no queda nada a la vista', () => {
  assert.match(una.publica.id, /^santiagoprue-[0-9a-f]{8}$/);
  assert.match(dos.publica.id, /^tomas-[0-9a-f]{8}$/);
  assert.equal(abrirPrivada(una.privada, '  Abeja BARCO caja  dado eco FARO ').asymmetricKeyDetails.modulusLength, 4096);
  for (const mala of ['abeja barco caja dado eco', 'abeja barco caja dado eco farol', '', FRASE.split('').reverse().join('')]) {
    assert.throws(() => abrirPrivada(una.privada, mala), /no es la frase/);
  }
  assert.throws(() => abrirPrivada({ ...una.privada, id: dos.publica.id }, FRASE), /no es la frase/);      // el archivo, cambiado a mano
  assert.ok(!JSON.stringify(una.privada).includes('PRIVATE'));
  assert.ok(!JSON.stringify(una.publica).includes(una.privada.llave.slice(0, 40)));
  assert.equal(normalizar(' Montaña   RÍO '), 'montana rio');
  const frases = Array.from({ length: 200 }, () => fraseNueva());
  assert.ok(frases.every((f) => /^([a-z]+ ){5}[a-z]+$/.test(f)));
  assert.equal(new Set(frases).size, 200);
});

test('cifrar y abrir: con cualquiera de las llaves; con otra no; y si se toca una letra, no abre', async () => {
  const contenido = JSON.stringify({ texto: 'Ñandú · 12.345.678.901.234.567.890 · 😀', relleno: 'x'.repeat(50000) });
  const archivo = Buffer.from(await cifrarCopia({ contenido, llaves: [una.publica, dos.publica], hecha: '2026-11-25T06:23:00.000Z' }));
  assert.equal(descifrarCopia(archivo, privadaUna, una.publica.id), contenido);
  assert.equal(descifrarCopia(archivo, abrirPrivada(dos.privada, 'gato hada isla jarra lana mano'), dos.publica.id), contenido);
  assert.ok(archivo.length < 5000, `comprimida: ${archivo.length}`);
  assert.ok(!archivo.includes('Ñandú') && !archivo.includes('xxxx'));
  assert.deepEqual(encabezadoDe(archivo).llaves.map((l) => l.id), [una.publica.id, dos.publica.id]);
  // la clave y el vector son nuevos en cada copia
  const otra = Buffer.from(await cifrarCopia({ contenido, llaves: [una.publica], hecha: '2026-11-25T06:23:00.000Z' }));
  const claveDe = (a) => privateDecrypt({ key: privadaUna, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(encabezadoDe(a).llaves[0].clave, 'base64'));
  assert.deepEqual([claveDe(otra).length, claveDe(archivo).length, Buffer.from(encabezadoDe(otra).iv, 'base64').length], [32, 32, 12]);
  assert.notDeepEqual(claveDe(otra), claveDe(archivo));
  assert.notEqual(encabezadoDe(otra).iv, encabezadoDe(archivo).iv);
  assert.ok(!claveDe(otra).equals(Buffer.alloc(32)));
  assert.notEqual(encabezadoDe(otra).contenido.subarray(0, 32).toString('hex'), encabezadoDe(archivo).contenido.subarray(0, 32).toString('hex'));
  // una llave que no está, o la llave de otro con ese nombre
  assert.throws(() => descifrarCopia(otra, abrirPrivada(dos.privada, 'gato hada isla jarra lana mano'), dos.publica.id), /no se abre con la llave/);
  assert.throws(() => descifrarCopia(otra, abrirPrivada(dos.privada, 'gato hada isla jarra lana mano'), una.publica.id), /dañada, o la llave no es/);
  // cualquier letra cambiada: en el encabezado, en el medio, en el final, o cortada
  const fin = archivo.indexOf(10, 8);
  for (const donde of [archivo.indexOf('2026') + 3, archivo.indexOf('"iv":"') + 8, fin - 10, fin + 1, fin + 40, archivo.length - 1]) {
    const rota = Buffer.from(archivo);
    rota[donde] ^= 1;
    assert.throws(() => descifrarCopia(rota, privadaUna, una.publica.id), /dañada/, `posición ${donde}`);
  }
  assert.throws(() => descifrarCopia(archivo.subarray(0, archivo.length - 20), privadaUna, una.publica.id), /dañada/);
  assert.throws(() => encabezadoDe(Buffer.from('hola')), /no es una copia/);
  await assert.rejects(cifrarCopia({ contenido, llaves: [], hecha: '' }), /ninguna llave/);
  assert.deepEqual([await mismaClave(CLAVE, CLAVE), await mismaClave(CLAVE, `${CLAVE}x`), await mismaClave('', CLAVE)], [true, false, false]);
});

test('la función armada no importa nada de afuera y no escribe datos en los registros', () => {
  assert.ok(!/^import\s/m.test(armada));
  for (const [, dicho] of armada.matchAll(/console\.\w+\(([^;]*)\);/g)) assert.ok(/^"copia: falla", e instanceof Error \? e\.message : typeof e$/.test(dicho), dicho);
  assert.ok(!/PRIVATE KEY|llave-privada/.test(armada));
});

test('las llaves que se suben son de verdad: RSA de 4096 bits, con su nombre, y sirven para cerrar', async () => {
  assert.ok(LLAVES_DE_COPIA.length >= 1, 'falta la llave pública en supabase/functions/_compartido/copia-llaves.ts');
  for (const l of LLAVES_DE_COPIA) {
    const k = createPublicKey({ key: Buffer.from(l.spki, 'base64'), format: 'der', type: 'spki' });
    assert.deepEqual([k.asymmetricKeyType, k.asymmetricKeyDetails.modulusLength], ['rsa', 4096]);
    assert.ok(l.id.endsWith(`-${createHash('sha256').update(Buffer.from(l.spki, 'base64')).digest('hex').slice(0, 8)}`), l.id);
    assert.deepEqual(Object.keys(l).sort(), ['id', 'spki']);
  }
  const a = Buffer.from(await cifrarCopia({ contenido: '{}', llaves: LLAVES_DE_COPIA, hecha: 'x' }));
  assert.deepEqual(encabezadoDe(a).llaves.map((l) => l.id), LLAVES_DE_COPIA.map((l) => l.id));
});

test('sin la clave no se entrega nada, y si falta configurar algo lo dice', async () => {
  for (const cabeceras of [{}, { 'x-entreturno-copia': '' }, { 'x-entreturno-copia': 'otra' }, { 'x-entreturno-copia': CLAVE.slice(1) }, { authorization: `Bearer ${CLAVE}` }, { apikey: CLAVE_PUBLICA }]) {
    const r = await pedir(cabeceras);
    assert.deepEqual([r.status, await r.json()], [401, { code: 'sin_permiso' }]);
  }
  assert.equal((await pedir({ 'x-entreturno-copia': CLAVE }, 'GET')).status, 405);
  assert.equal((await pedir({ 'x-entreturno-copia': CLAVE }, 'OPTIONS')).status, 405);      // no se puede pedir desde ninguna página
  for (const valor of [undefined, '', 'corta', '•'.repeat(40)]) {
    env.COPIA_CLAVE = valor;
    const r = await pedir({ 'x-entreturno-copia': valor === 'corta' ? valor : '' });
    assert.deepEqual([r.status, await r.json()], [500, { code: 'falta_configurar' }], String(valor));
  }
  env.COPIA_CLAVE = CLAVE;
  assert.deepEqual(await copias(), []);
});

test('la copia sale cifrada, queda la constancia, se abre y trae todo menos los secretos', async () => {
  // lo que no tiene que salir nunca
  await s.pg.query(`select vault.create_secret('APP_USR-secreto-mp', 'mp_acceso_x', ''), vault.create_secret('re_secreto_mails', 'resend_api_key', '')`);
  await s.pg.query(`insert into interno.arca_tickets (ambiente, token, sign, vence) values ('prueba', 'token-de-arca', 'firma-de-arca', now() + interval '1 hour')`);
  const c = (await s.pg.query(`select id from public.consultorios limit 1`)).rows[0].id;
  await s.pg.query(`insert into interno.mp_estados (estado, consultorio_id, miembro_id, ambiente, verificador, volver_a) values ($1, $2, gen_random_uuid(), 'prueba', $3, 'https://lavanda.entreturno.com.ar/')`, ['e'.repeat(40), c, 'verificador-secreto-'.repeat(3)]);

  const r = await pedir();
  assert.equal(r.status, 200);
  const archivo = Buffer.from(await r.arrayBuffer());
  const huella = createHash('sha256').update(archivo).digest('hex');
  assert.equal(r.headers.get('x-copia-huella'), huella);
  assert.equal(await huellaDe(new Uint8Array(archivo)), huella);
  assert.deepEqual([r.headers.get('content-type'), r.headers.get('access-control-allow-origin')], ['application/octet-stream', null]);
  assert.deepEqual(await copias(), [{ bytes: archivo.length, huella, llaves: `${una.publica.id},${dos.publica.id}`, guardada: false }]);
  for (const legible of ['lavanda', 'Lavanda', 'prueba.com', 'reservas', 'consultorios']) assert.ok(!archivo.includes(legible), legible);

  const contenido = descifrarCopia(archivo, privadaUna, una.publica.id);
  assert.equal((await s.pg.query('select datos from interno.copias')).rows[0].datos, contenido.length);
  const doc = JSON.parse(contenido);
  assert.equal(doc.formato, 1);
  // todas las tablas, menos las tres que no van
  const todas = (await s.pg.query(`select n.nspname || '.' || c.relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace
                                    where c.relkind in ('r', 'p') and n.nspname in ('public', 'interno') order by 1`)).rows.map((f) => f.t);
  assert.deepEqual(Object.keys(doc.tablas).sort(), [...todas.filter((t) => !['interno.arca_tickets', 'interno.arca_candados', 'interno.mp_estados'].includes(t)), 'auth.users'].sort());
  for (const t of Object.keys(doc.tablas)) assert.equal(doc.filas[t], doc.tablas[t].length, t);
  for (const t of todas.filter((x) => doc.tablas[x] && x !== 'interno.copias')) {
    assert.equal(doc.filas[t], (await s.pg.query(`select count(*)::int as n from ${t}`)).rows[0].n, t);
  }
  assert.ok(doc.filas['public.reservas'] > 5 && doc.filas['public.miembros'] > 3 && doc.filas['interno.consentimientos'] > 0);
  for (const secreto of ['APP_USR-secreto-mp', 're_secreto_mails', 'token-de-arca', 'firma-de-arca', 'verificador-secreto', CLAVE, CLAVE_SECRETA]) assert.ok(!contenido.includes(secreto), secreto);
});

test('recién cuenta como hecha cuando GitHub confirma que la guardó', async () => {
  const huella = (await copias())[0].huella;
  const confirmar = async (h, clave = CLAVE) => (await pedir({ 'x-entreturno-copia': clave, 'x-entreturno-guardada': h })).status;
  assert.equal(await confirmar(huella, 'otra'), 401);
  assert.deepEqual([await confirmar('corta'), await confirmar('z'.repeat(64)), await confirmar('a'.repeat(64))], [400, 400, 404]);
  assert.equal((await copias()).length, 1);                       // confirmar no hace otra copia
  assert.equal((await copias())[0].guardada, false);
  assert.equal(await confirmar(huella), 200);
  assert.equal((await copias())[0].guardada, true);
  assert.equal(await confirmar(huella), 404);                     // una sola vez
  await s.pg.query(`update interno.copias set guardada_en = null, hecha_en = now() - interval '25 hours'`);
  assert.equal(await confirmar(huella), 404);                     // y solo la de hoy
  await s.pg.query(`update interno.copias set hecha_en = now()`);
});

test('cada columna de la copia está revisada: si una migración agrega una, hay que decidir si puede salir', async () => {
  const pg = await armarBase();
  try {
    const hoy = (await pg.query(`select t.esquema || '.' || t.tabla || ': ' || string_agg(c.column_name, ', ' order by c.column_name) as r from interno.copia_tablas() t
       join information_schema.columns c on c.table_schema = t.esquema and c.table_name = t.tabla group by t.esquema, t.tabla order by t.esquema, t.tabla`)).rows.map((f) => f.r);
    const revisadas = readFileSync(new URL('./copia-columnas.txt', import.meta.url), 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#'));
    assert.deepEqual(hoy, revisadas, 'Hay tablas o columnas nuevas. Si son un secreto (una clave, un pase), no pueden salir en la copia: sacarlas en interno.copia_tablas. Si no, anotarlas en pruebas/copia-columnas.txt');
  } finally {
    await pg.close();
  }
});

test('los códigos de los mails de registro salen vacíos, y las cuentas de otros proveedores también van', async () => {
  const pg = await armarBase();
  try {
    await pg.exec(`alter table auth.users add column recovery_token text, add column confirmation_token text, add column encrypted_password text;
      create table auth.identities (id uuid primary key default gen_random_uuid(), user_id uuid, provider text);
      grant select on auth.identities to dueno;`);
    const u = await crearCuenta(pg, 'ana@prueba.com');
    await pg.query(`update auth.users set recovery_token = 'codigo-secreto', confirmation_token = null, encrypted_password = '$2a$hash' where id = $1`, [u]);
    await pg.query(`insert into auth.identities (user_id, provider) values ($1, 'email')`, [u]);
    const d = (await comoRol(pg, 'service_role', null, (tx) => tx.query('select public.copia_datos() as d'))).rows[0].d;
    assert.deepEqual([d.tablas['auth.users'][0].recovery_token, d.tablas['auth.users'][0].confirmation_token, d.tablas['auth.users'][0].encrypted_password], ['', '', '$2a$hash']);
    assert.deepEqual([d.filas['auth.identities'], d.tablas['auth.identities'][0].provider], [1, 'email']);
    // ni la página ni nadie con cuenta la puede pedir
    for (const [rol, sub] of [['anon', null], ['authenticated', u]]) {
      for (const sql of ['select public.copia_datos()', `select public.copia_anotar(1, 1, '${'a'.repeat(64)}', 'x')`, `select public.copia_guardada('${'a'.repeat(64)}')`, 'select * from interno.copias', 'select interno.copias_vigilar()']) {
        await assert.rejects(comoRol(pg, rol, sub, (tx) => tx.query(sql)), /permission denied/, `${rol}: ${sql}`);
      }
    }
  } finally {
    await pg.close();
  }
});

test('restaurar: queda igual fila por fila, los consultorios abren, y en la base restaurada se puede seguir reservando', async () => {
  const contenido = descifrarCopia(Buffer.from(await (await pedir()).arrayBuffer()), privadaUna, una.publica.id);
  const doc = JSON.parse(contenido);
  const r = await ensayarRestauracion(contenido, async (pg) => {
    // sigue viva: una profesional reserva, otra no puede tomar el mismo horario, y los candados siguen puestos
    const pros = (await pg.query(`select m.usuario_id, c.slug from public.miembros m join public.consultorios c on c.id = m.consultorio_id
                                   where m.rol = 'pro' and m.estado = 'aprobado' and exists (select 1 from interno.consentimientos k where k.miembro_id = m.id) order by m.nombre`)).rows;
    assert.ok(pros.length >= 2);
    let dia = new Date(Date.now() + 45 * 864e5);
    if (dia.getUTCDay() === 0) dia = new Date(dia.getTime() + 864e5);
    const reservar = (quien) => comoRol(pg, 'authenticated', quien.usuario_id, (tx) => tx.query(
      `select public.reservar($1, 1, $2::date, 8, 12, 'Consulta', 'sena', '{}'::uuid[], 1) as r`, [quien.slug, dia.toISOString().slice(0, 10)]));
    assert.ok((await reservar(pros[0])).rows[0].r.id);
    // Mercado Pago no queda «conectado» sin su pase, y los mails viejos no salen otra vez
    assert.deepEqual((await pg.query('select estado, mp_user_id, error from interno.mp_cuentas')).rows, [{ estado: 'caida', mp_user_id: '111222333', error: 'Se restauró una copia de seguridad: hay que conectar la cuenta de nuevo' }]);
    assert.deepEqual((await pg.query(`select distinct estado from public.avisos where creado_en < $1`, [doc.hecha])).rows, [{ estado: 'descartado' }]);
    assert.deepEqual((await pg.query('select clave, valor from interno.ajustes')).rows, [{ clave: 'mail_soporte', valor: 'soporte@entreturno.prueba' }]);      // la dirección del proyecto viejo, no
    await assert.rejects(reservar(pros[1]), /horario_no_disponible/);
    await assert.rejects(pg.query(`insert into public.pagos (consultorio_id, reserva_id, tipo, monto, estado, proveedor, proveedor_id)
                                   select consultorio_id, id, 'sena', 1, 'pendiente', 'mercadopago', 'ORD01X' from public.reservas limit 1`), /mp_otro_ambiente/);
  });
  assert.match(r.avisos.join(), /auth\.users: columnas que cambiaron en Supabase/);        // el servidor de prueba tiene menos columnas que Supabase
  assert.equal(r.consultorios.length, 1);
  assert.deepEqual([r.consultorios[0].slug, r.consultorios[0].abre, r.consultorios[0].boxes], ['lavanda', true, 3]);
  assert.equal(r.consultorios[0].personas, doc.filas['public.miembros']);

  // no se carga encima de una base con datos
  const pg = await armarBase();
  try {
    await pg.query(`insert into public.consultorios (slug, nombre, duena, letras, reglamento) values ('otro', 'Otro', 'Otra', 'OO', 'x')`);
    await assert.rejects(pg.exec(sqlDeRestauracion(contenido)), /ya tiene consultorios/);
    await pg.exec('rollback');
    assert.equal((await pg.query('select count(*)::int as n from public.consultorios')).rows[0].n, 1);
  } finally {
    await pg.close();
  }
});

test('restaurar con las cuentas como las tiene Supabase: contraseñas, identidades y columnas que se calculan solas', async () => {
  const pg = await armarBase();
  let contenido;
  try {
    await pg.exec(readFileSync(new URL('../copia/auth-de-supabase.sql', import.meta.url), 'utf8'));
    await pg.exec('grant select on auth.identities to dueno');
    const u = await crearCuenta(pg, 'Ana@Prueba.com');
    await pg.query(`update auth.users set encrypted_password = '$2a$10$hash', email_confirmed_at = '2026-11-20T10:11:12.123456Z', raw_app_meta_data = '{"provider":"email","n":12345678901234567890}',
                      recovery_token = 'codigo', confirmation_token = '', phone = null, banned_until = null where id = $1`, [u]);
    await pg.query(`insert into auth.identities (provider_id, user_id, identity_data, provider) values ($1::text, $1::uuid, '{"email":"Ana@Prueba.com"}', 'email')`, [u]);
    contenido = (await pg.query('select public.copia_datos()::text as t')).rows[0].t;
    assert.ok(!contenido.includes('codigo'));
  } finally {
    await pg.close();
  }
  const r = await ensayarRestauracion(contenido, async (otra) => {
    const c = (await otra.query(`select u.encrypted_password, u.confirmed_at = '2026-11-20T10:11:12.123456Z' as confirmada, u.recovery_token, u.raw_app_meta_data::text as meta, i.email from auth.users u join auth.identities i on i.user_id = u.id`)).rows;
    assert.deepEqual(c, [{ encrypted_password: '$2a$10$hash', confirmada: true, recovery_token: '', meta: '{"n": 12345678901234567890, "provider": "email"}', email: 'ana@prueba.com' }]);
  });
  assert.deepEqual([r.avisos, r.filas['auth.users'], r.filas['auth.identities']], [[], 1, 1]);
  // si Supabase suma una columna, la copia igual se restaura y lo dice
  const d = JSON.parse(contenido);
  d.tablas['auth.users'][0].columna_nueva = 'x';
  const conNueva = await ensayarRestauracion(JSON.stringify(d).replace('12345678901234567000', '12345678901234567890').replace('12345678901234567890', '12345678901234567890'));
  assert.equal(conNueva.avisos.length, 1);
  assert.match(conNueva.avisos[0], /auth\.users: columnas que cambiaron en Supabase \(columna_nueva, solo en la copia\)/);
});

test('si la copia viene mal, el ensayo lo dice: una fila de menos, una tabla que no existe, o una copia incompleta', async () => {
  const contenido = descifrarCopia(Buffer.from(await (await pedir()).arrayBuffer()), privadaUna, una.publica.id);
  const con = (cambio) => { const d = JSON.parse(contenido); cambio(d); return JSON.stringify(d); };
  await assert.rejects(ensayarRestauracion(con((d) => d.tablas['public.reservas'].pop())), /public\.reservas tenían que quedar/);
  await assert.rejects(ensayarRestauracion(con((d) => { d.tablas['public.boxes'][0].columna_que_no_existe = 1; })), /public\.boxes no quedó igual: 2 diferencias/);
  await assert.rejects(ensayarRestauracion(con((d) => { d.tablas['public.inventada'] = []; d.filas['public.inventada'] = 0; })), /no: actualizá el proyecto/);
  await assert.rejects(ensayarRestauracion(con((d) => { delete d.tablas['auth.users']; })), /no está completa/);
  assert.throws(() => sqlDeRestauracion(con((d) => { d.tablas['public.reservas; drop table x'] = []; })), /nombre de tabla raro/);
});

test('el vigía: avisa si falta la copia (aunque nunca haya salido ninguna), una vez por día, y se calla cuando vuelve', async () => {
  const pg = await armarBase();
  const vigilar = async () => (await pg.query('select interno.copias_vigilar() as r')).rows[0].r;
  const mails = async () => (await pg.query('select id::int as id, url, body, headers from net.llamadas order by id')).rows;
  const ajuste = (clave, valor) => pg.query(`insert into interno.ajustes (clave, valor) values ($1, $2) on conflict (clave) do update set valor = excluded.valor`, [clave, valor]);
  const hace = async (t) => (await pg.query(`select (now() - $1::interval)::text as t`, [t])).rows[0].t;
  const copia = async (t, guardada = true, datos = 5000) => pg.query(`insert into interno.copias (hecha_en, guardada_en, bytes, datos, huella, llaves)
     values (now() - $1::interval, case when $2 then now() - $1::interval end, 5000, $3, encode(sha256(gen_random_uuid()::text::bytea), 'hex'), 'x')`, [t, guardada, datos]);
  const contesto = (id, estado) => pg.query('insert into net._http_response (id, status_code) values ($1, $2)', [id, estado]);
  const avisoDeHace = async (t) => pg.query(`update interno.ajustes set valor = (valor::jsonb || jsonb_build_object('en', now() - $1::interval))::text where clave = 'copia_avisada'`, [t]);
  try {
    await copia('100 hours');
    assert.equal(await vigilar(), false);                                       // todavía no se puso en marcha
    await pg.query('delete from interno.copias');
    await ajuste('copia_desde', await hace('31 hours'));
    assert.equal(await vigilar(), false);                                       // falta a quién y con qué mandarlo
    await ajuste('mail_soporte', 'soporte@entreturno.prueba');
    assert.equal(await vigilar(), false);
    await pg.query(`select vault.create_secret('re_clave', 'resend_api_key', '')`);
    await ajuste('copia_desde', await hace('29 hours'));
    assert.equal(await vigilar(), false);                                       // recién empezó
    await ajuste('copia_desde', await hace('31 hours'));
    assert.equal(await vigilar(), true);                                        // nunca salió ninguna
    const [m] = await mails();
    assert.deepEqual([m.url, m.body.to, m.body.subject, m.headers.Authorization], ['https://api.resend.com/emails', ['soporte@entreturno.prueba'], 'No está saliendo la copia de seguridad', 'Bearer re_clave']);
    assert.match(m.body.text, /todavía no se guardó ni una vez\./);
    // el servicio de mails todavía no contestó: espera; lo rechazó: lo manda de nuevo; salió: se calla por un día
    assert.equal(await vigilar(), false);
    await contesto(m.id, 500);
    assert.equal(await vigilar(), true);
    const segundo = (await mails())[1];
    await avisoDeHace('55 minutes');
    assert.equal(await vigilar(), true);                                        // pasó casi una hora sin respuesta
    const tercero = (await mails())[2];
    assert.notEqual(tercero.id, segundo.id);
    await contesto(tercero.id, 200);
    assert.equal(await vigilar(), false);
    await pg.query('delete from net._http_response');                           // Supabase borra las respuestas a las pocas horas
    await avisoDeHace('23 hours');
    assert.equal(await vigilar(), false);
    await avisoDeHace('25 hours');
    assert.equal(await vigilar(), true);                                        // al otro día sigue faltando
    // que salga no alcanza: tiene que estar guardada
    await avisoDeHace('25 hours');
    await copia('1 hour', false);
    assert.equal(await vigilar(), true);
    await copia('1 minute');
    await avisoDeHace('25 hours');
    assert.equal(await vigilar(), false);
    assert.equal((await mails()).length, 5);
    await pg.query(`update interno.copias set guardada_en = now() - interval '31 hours', hecha_en = now() - interval '31 hours'`);
    assert.equal(await vigilar(), true);
    assert.match((await mails()).at(-1).body.text, /se guardó el \d\d\/\d\d\/\d{4} a las \d\d:\d\d\./);
    // y si los datos crecen mucho, avisa antes de que deje de andar, una vez por semana
    await copia('1 minute', true, 16000000);
    assert.equal(await vigilar(), true);
    const grande = (await mails()).at(-1);
    assert.deepEqual([grande.body.subject, /ya pesan 16 MB/.test(grande.body.text)], ['La copia de seguridad está creciendo', true]);
    await contesto(grande.id, 200);
    assert.equal(await vigilar(), false);
    await avisoDeHace('6 days');
    assert.equal(await vigilar(), false);
    await avisoDeHace('8 days');
    assert.equal(await vigilar(), true);
    // la constancia no se acumula para siempre, y no se anota cualquier cosa
    await copia('401 days');
    const antes = (await pg.query('select count(*)::int as n from interno.copias')).rows[0].n;
    await comoRol(pg, 'service_role', null, (tx) => tx.query(`select public.copia_anotar(9, 9, $1, 'y')`, ['c'.repeat(64)]));
    assert.equal((await pg.query('select count(*)::int as n from interno.copias')).rows[0].n, antes);      // entró una y salió la vieja
    await assert.rejects(comoRol(pg, 'service_role', null, (tx) => tx.query(`select public.copia_anotar(9, 9, 'corta', 'y')`)), /copias_huella_check/);
  } finally {
    await pg.close();
  }
});

// ---------------------------------------------------------------------------------------------------
// El pedido de GitHub: el mismo guion del archivo del repositorio, corrido acá contra la función
// ---------------------------------------------------------------------------------------------------
const FLUJO = readFileSync(new URL('../.github/workflows/copia-diaria.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const bash = ['C:\\Program Files\\Git\\bin\\bash.exe', '/bin/bash', '/usr/bin/bash'].find((b) => existsSync(b));

test('el flujo de GitHub: una vez por día, sin permisos sobre el repositorio, con la acción fija y 30 días de guarda', () => {
  assert.match(FLUJO, /\n {4}- cron: '23 6 \* \* \*'/);
  assert.match(FLUJO, /\npermissions: \{\}\n/);
  assert.match(FLUJO, /retention-days: 30 /);
  assert.deepEqual([...FLUJO.matchAll(/uses: (\S+)/g)].map((m) => /^actions\/upload-artifact@[0-9a-f]{40}$/.test(m[1])), [true]);
  assert.match(FLUJO, /COPIA_URL: https:\/\/mgnzmjeyhzxzlyrgxotp\.supabase\.co\/functions\/v1\/copia\n/);
  assert.ok(!/echo .*COPIA_CLAVE"?\s*$/m.test(FLUJO.replace(/echo "::error::.*"/g, '')));
  // en este orden: pedirla, guardarla, confirmar
  assert.deepEqual([...FLUJO.matchAll(/- name: (.*)/g)].map((m) => m[1]), ['Pedir la copia', 'Guardarla 30 días', 'Confirmar que quedó guardada']);
});

test('el guion de GitHub: guarda la copia si llegó bien, y falla si no', { skip: !bash && 'no hay bash en esta compu' }, async () => {
  const [pedirla, confirmarla] = FLUJO.split('        run: |\n').slice(1).map((x) => x.split('\n      - name:')[0].split('\n      - uses:')[0].split('\n      #')[0].split('\n').map((l) => l.slice(10)).join('\n')
    .replace('--retry 4 --retry-delay 30 --retry-all-errors', '--retry 0'));            // sin esperar los reintentos
  const correr = async (contestar, clave = CLAVE, guion = pedirla, huella = '') => {
    const web = createServer(async (req, res) => {
      const r = await contestar(req);
      res.writeHead(r.status, Object.fromEntries(r.headers));
      res.end(Buffer.from(await r.arrayBuffer()));
    });
    await new Promise((ok) => { web.listen(0, '127.0.0.1', ok); });
    const dir = mkdtempSync(path.join(tmpdir(), 'github-'));
    try {
      const salida = path.join(dir, 'salida.txt');
      writeFileSync(salida, '');
      writeFileSync(path.join(dir, 'resumen.txt'), '');
      writeFileSync(path.join(dir, 'guion.sh'), guion);
      const p = await new Promise((ok) => {
        const hijo = spawnAsync(bash, ['guion.sh'], { cwd: dir, env: { ...process.env, COPIA_CLAVE: clave, COPIA_URL: `http://127.0.0.1:${web.address().port}/`, HUELLA: huella, GITHUB_OUTPUT: 'salida.txt', GITHUB_STEP_SUMMARY: 'resumen.txt' } });
        hijo.then(ok);
      });
      return { ...p, archivos: readdirSync(dir).filter((f) => f.endsWith('.ecopia')), salida: readFileSync(salida, 'utf8'), resumen: readFileSync(path.join(dir, 'resumen.txt'), 'utf8'), otros: readdirSync(dir) };
    } finally {
      web.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const deVerdad = (req) => manejador(new Request('https://x/functions/v1/copia', { method: req.method, headers: { 'x-entreturno-copia': req.headers['x-entreturno-copia'] ?? '', ...(req.headers['x-entreturno-guardada'] ? { 'x-entreturno-guardada': req.headers['x-entreturno-guardada'] } : {}) } }));

  const bien = await correr(deVerdad);
  assert.equal(bien.codigo, 0, bien.texto);
  assert.equal(bien.archivos.length, 1);
  assert.match(bien.archivos[0], /^copia-\d{4}-\d\d-\d\d-\d\dh\d\d\.ecopia$/);
  const huella = /huella=([0-9a-f]{64})\n/.exec(bien.salida)[1];
  assert.equal(bien.salida, `archivo=${bien.archivos[0]}\nhuella=${huella}\n`);
  assert.match(bien.resumen, new RegExp(`^Copia recibida: \`copia-.*\` · \\d+ bytes · huella \`${huella}\`\\n$`));
  assert.ok(!bien.otros.includes('cabeceras.txt') && !bien.texto.includes(CLAVE));

  // el tercer paso confirma esa misma copia, y si no se puede confirmar también falla
  const guardadas = async () => (await s.pg.query(`select count(*)::int as n from interno.copias where huella = $1 and guardada_en is not null`, [huella])).rows[0].n;
  assert.equal(await guardadas(), 0);
  assert.equal((await correr(deVerdad, CLAVE, confirmarla, huella)).codigo, 0);
  assert.equal(await guardadas(), 1);
  assert.notEqual((await correr(deVerdad, CLAVE, confirmarla, huella)).codigo, 0);
  assert.notEqual((await correr(deVerdad, 'otra', confirmarla, huella)).codigo, 0);
  assert.notEqual((await correr(deVerdad, CLAVE, confirmarla, '')).codigo === 0 && (await guardadas()) === 0, true);

  const casos = [
    ['sin la clave', deVerdad, '', /Falta el secreto COPIA_CLAVE/],
    ['con otra clave', deVerdad, 'x'.repeat(48), /401/],
    ['la función falla', async () => new Response('{"code":"falla"}', { status: 500 }), CLAVE, /500/],
    ['llega una página', async () => new Response('<html>hola</html>'.padEnd(5000), { status: 200 }), CLAVE, /no es una copia/],
    ['llega cortada', async (req) => { const r = await deVerdad(req); return new Response((await r.arrayBuffer()).slice(0, 1500), { status: 200, headers: { 'x-copia-huella': r.headers.get('x-copia-huella') } }); }, CLAVE, /demasiado chica/],
    ['llega cambiada', async (req) => { const r = await deVerdad(req); const b = Buffer.from(await r.arrayBuffer()); b[b.length - 5] ^= 1; return new Response(b, { status: 200, headers: { 'x-copia-huella': r.headers.get('x-copia-huella') } }); }, CLAVE, /llegó distinta/],
    ['no dice la huella', async (req) => new Response(await (await deVerdad(req)).arrayBuffer(), { status: 200 }), CLAVE, /llegó distinta/],
  ];
  for (const [nombre, contestar, clave, dice] of casos) {
    const r = await correr(contestar, clave);
    assert.notEqual(r.codigo, 0, nombre);
    assert.match(r.texto, dice, nombre);
    assert.equal(r.salida, '', nombre);
  }
});

/** Corre un programa sin trabar a Node (el servidor de la prueba vive en este mismo proceso). */
async function spawnAsync(programa, args, opciones) {
  const { spawn } = await import('node:child_process');
  return new Promise((ok) => {
    const h = spawn(programa, args, opciones);
    let texto = '';
    h.stdout.on('data', (d) => { texto += d; });
    h.stderr.on('data', (d) => { texto += d; });
    h.on('close', (codigo) => ok({ codigo, texto }));
  });
}

test('el programa para abrirla: pide la frase, ensaya la restauración y dice si sirve', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'abrir-'));
  try {
    const archivo = path.join(dir, 'copia-2026-11-25.ecopia');
    const bytes = Buffer.from(await (await pedir()).arrayBuffer());
    writeFileSync(archivo, bytes);
    writeFileSync(path.join(dir, `llave-privada-${una.publica.id}.json`), JSON.stringify(una.privada));
    const abrir = (f, frase, ...mas) => spawnSync(process.execPath, [fileURLToPath(new URL('../copia/abrir.mjs', import.meta.url)), f, '--llave', dir, ...mas],
      { encoding: 'utf8', env: { ...process.env, FRASE_DE_PRUEBA: frase } });
    const bien = abrir(archivo, FRASE, '--sql', path.join(dir, 's.sql'));
    assert.equal(bien.status, 0, bien.stdout + bien.stderr);
    assert.match(bien.stdout, /LA COPIA SIRVE: se abrió, se restauró y quedó igual/);
    assert.match(bien.stdout, /lavanda: abre, con 3 boxes/);
    assert.match(bien.stdout, new RegExp(`Huella: ${createHash('sha256').update(bytes).digest('hex')}`));
    assert.ok(!/@/.test(bien.stdout));                                            // no muestra datos de nadie
    assert.match(readFileSync(path.join(dir, 's.sql'), 'utf8'), /^-- Restaurar una copia/);
    const mal = abrir(archivo, 'otra frase');
    assert.deepEqual([mal.status, /NO SIRVIÓ: Esa no es la frase/.test(mal.stdout)], [1, true]);
    bytes[bytes.length - 1] ^= 1;
    writeFileSync(archivo, bytes);
    const rota = abrir(archivo, FRASE);
    assert.deepEqual([rota.status, /NO SIRVIÓ: La copia está dañada/.test(rota.stdout)], [1, true]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
