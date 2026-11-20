// El envío de los avisos por mail: qué se le pide al servicio, qué pasa cuando contesta bien, mal o no contesta.
import assert from 'node:assert/strict';

import { prueba } from './entorno.mjs';

const despachar = async (e) => (await e.uno(`select interno.despachar_avisos() as n`)).n;
const estados = async (e) => (await e.sql(`select estado, count(*)::int as n from public.avisos group by 1 order by 1`)).map((f) => `${f.estado}:${f.n}`).join(' ');
const contestar = (e, pedido, codigo, texto = '') => e.sql(`insert into net._http_response (id, status_code, content) values ($1, $2, $3)`, [pedido, codigo, texto]);
const cargarClave = (e) => e.sql(`insert into vault.decrypted_secrets (name, decrypted_secret) values ('resend_api_key', ' clave-de-prueba ')`);

prueba('sin la clave cargada no se manda nada: los avisos esperan', async (e) => {
  await e.armar();
  assert.equal(await estados(e), 'pendiente:8');          // los pedidos de acceso y las aprobaciones del consultorio de ejemplo
  assert.equal(await despachar(e), 0);
  assert.equal((await e.uno(`select count(*)::int as n from net.llamadas`)).n, 0);
  assert.equal(await estados(e), 'pendiente:8');
});

prueba('con la clave, pide de a dos y marca cada aviso según lo que conteste el servicio', async (e) => {
  await e.armar('lavanda', { nombre: 'Consultorio "Lavanda" <Sur>' });
  await cargarClave(e);
  assert.equal(await despachar(e), 2);
  const pedidos = await e.sql(`select id, url, body, headers from net.llamadas order by id`);
  assert.equal(pedidos.length, 2);
  const primero = await e.uno(`select id, para, asunto, cuerpo from public.avisos where pedido_id = $1`, [pedidos[0].id]);
  assert.equal(pedidos[0].url, 'https://api.resend.com/emails');
  assert.deepEqual(pedidos[0].body, { from: 'Consultorio Lavanda Sur <avisos@entreturno.com.ar>', to: [primero.para], subject: primero.asunto, text: primero.cuerpo });
  assert.deepEqual(pedidos[0].headers, { Authorization: 'Bearer clave-de-prueba', 'Content-Type': 'application/json', 'Idempotency-Key': primero.id });
  // Salen primero los más viejos: los dos avisos del primer pedido de acceso (entre ellos el orden da igual: nacieron en el mismo instante)
  assert.deepEqual((await e.sql(`select asunto from public.avisos where pedido_id is not null order by asunto`)).map((f) => f.asunto),
    ['Nueva solicitud de acceso: Lucía Ferrari', 'Recibimos tu solicitud']);
  assert.equal(await estados(e), 'enviando:2 pendiente:6');

  // Uno sale bien y al otro el servicio lo frena por ir muy rápido: ese vuelve a la cola
  await contestar(e, pedidos[0].id, 200, '{"id":"abc"}');
  await contestar(e, pedidos[1].id, 429, 'Too many requests');
  assert.equal(await despachar(e), 2);                               // el reintento y uno nuevo
  const hecho = await e.uno(`select estado, enviado_en is not null as con_fecha, error from public.avisos where id = $1`, [primero.id]);
  assert.deepEqual(hecho, { estado: 'enviado', con_fecha: true, error: null });
  assert.equal(await estados(e), 'enviado:1 enviando:2 pendiente:5');
  const reintento = await e.uno(`select intentos, error from public.avisos where intentos = 2`);
  assert.deepEqual(reintento, { intentos: 2, error: 'Too many requests' });
});

prueba('después de tres intentos fallidos queda como error y no insiste más', async (e) => {
  await e.armar();
  await cargarClave(e);
  await e.sql(`update public.avisos set estado = 'descartado' where id not in (select id from public.avisos order by creado_en, id limit 1)`);
  for (let i = 1; i <= 3; i++) {
    assert.equal(await despachar(e), 1, `intento ${i}`);
    await contestar(e, (await e.uno(`select max(id) as id from net.llamadas`)).id, 500, '');
  }
  assert.equal(await despachar(e), 0);
  assert.deepEqual(await e.uno(`select estado, intentos, error from public.avisos where estado <> 'descartado'`), { estado: 'error', intentos: 3, error: 'el servicio de mails no lo aceptó' });
  assert.equal((await e.uno(`select count(*)::int as n from net.llamadas`)).n, 3);
});

prueba('si el servicio no contesta en diez minutos, el aviso vuelve a la cola; sin dirección, se descarta', async (e) => {
  await e.armar();
  await cargarClave(e);
  await e.sql(`update public.avisos set para = '' where id in (select id from public.avisos order by creado_en desc, id limit 3)`);
  assert.equal(await despachar(e), 2);
  assert.equal(await estados(e), 'descartado:3 enviando:2 pendiente:3');
  await e.sql(`update public.avisos set pedido_en = now() - interval '11 minutes' where estado = 'enviando'`);
  assert.equal(await despachar(e), 2);                               // vuelven a salir primero, por ser los más viejos
  assert.equal((await e.uno(`select count(*)::int as n from public.avisos where intentos = 2 and estado = 'enviando'`)).n, 2);
});

prueba('la página no puede disparar el envío', async (e) => {
  const r = await e.uno(`select has_function_privilege('anon', 'interno.despachar_avisos()', 'execute') as a, has_function_privilege('authenticated', 'interno.despachar_avisos()', 'execute') as b`);
  assert.deepEqual(r, { a: false, b: false });
});
