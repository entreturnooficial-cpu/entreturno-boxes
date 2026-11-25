// La migración de facturas sobre una base que YA tiene datos, como la del proyecto real (revisión 5 de Codex, punto 14):
// se arma la base con las migraciones anteriores, se cargan datos como los de Yani (con la página vieja) y recién ahí
// se carga la nueva, como se hace en el SQL Editor.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { DUENO, MIGRACIONES, armarBase, comoRol, crearCuenta, leerMigracion } from '../base.mjs';

test('la migración de Mercado Pago se carga sobre una base con datos y lo que había sigue andando', async () => {
  const nueva = '20261124100000_mercadopago.sql';
  const pg = await armarBase(MIGRACIONES.slice(0, MIGRACIONES.indexOf(nueva)));     // solo las anteriores a esa
  try {
    // Como el proyecto real: el consultorio de Yani, Soporte como dueña y una profesional con una reserva paga de prueba,
    // otra esperando el pago y una cancelada con su devolución de prueba
    const c = (await pg.query(
      `insert into public.consultorios (slug, nombre, duena, letras, reglamento) values ('yanina', 'Consultorio Yani', 'Yani', 'YO', 'Provisorio') returning id`,
    )).rows[0].id;
    const cat = (await pg.query(
      `insert into public.categorias (consultorio_id, nombre, nota, precio_hora, orden) values ($1, 'Médicas y médicos', '', 25000, 1) returning id`, [c],
    )).rows[0].id;
    for (const n of [1, 2, 3]) await pg.query(`insert into public.boxes (consultorio_id, numero, nombre, resumen, equipamiento) values ($1, $2, $3, '', '{}')`, [c, n, `Box ${n}`]);
    const soporte = await crearCuenta(pg, 'soporte@entreturno.prueba');
    await pg.query(`select interno.alta_admin('yanina', 'soporte@entreturno.prueba', 'Soporte Entreturno')`);
    const comoPersona = async (sub, sql, params) => (await comoRol(pg, 'authenticated', sub, (tx) => tx.query(sql, params))).rows[0];
    const pro = await crearCuenta(pg, 'pro@prueba.com');
    const pedido = await comoPersona(pro, `select public.pedir_acceso(p_slug => 'yanina', p_nombre => 'Paula Pro', p_profesion => 'Médica', p_categoria => $1,
      p_telefono => '', p_cuit => '27-11111111-7', p_condicion_iva => 6) as r`, [cat]);
    await comoPersona(soporte, `select public.cambiar_estado_profesional(p_slug => 'yanina', p_miembro => $1, p_estado => 'aprobado')`, [pedido.r.id]);
    let dia = new Date(Date.now() + 10 * 864e5);
    if (dia.getUTCDay() === 0) dia = new Date(dia.getTime() + 864e5);
    const fecha = dia.toISOString().slice(0, 10);
    const reservar = async (box) => (await comoPersona(pro, `select public.reservar(p_slug => 'yanina', p_box => $1, p_fecha => $2, p_desde => 8, p_hasta => 12,
      p_servicio => 'Consulta', p_plan => 'sena', p_maquinas => '{}', p_reglamento_version => 1) as r`, [box, fecha])).r;
    const paga = await reservar(1);
    await comoPersona(pro, `select public.simular_pago(p_slug => 'yanina', p_reserva => $1, p_tipo => 'sena')`, [paga.id]);
    const esperando = await reservar(2);
    // (el tope de saldos es 2: con dos turnos señados, la tercera reserva señada no entra; se paga y cancela la primera antes)
    await comoPersona(pro, `select public.cancelar_reserva(p_slug => 'yanina', p_reserva => $1)`, [paga.id]);
    const otra = await reservar(3);
    await comoPersona(pro, `select public.simular_pago(p_slug => 'yanina', p_reserva => $1, p_tipo => 'sena')`, [otra.id]);
    const antes = (await comoPersona(soporte, `select public.foto(p_slug => 'yanina') as f`)).f;

    // La migración nueva, como en el SQL Editor
    await pg.exec(`set role ${DUENO}`);
    await pg.exec(leerMigracion(nueva));
    await pg.exec('reset role');

    // Lo que había sigue igual: el consultorio sigue en pagos de prueba y las reservas con sus pagos y su devolución
    const foto = (await comoPersona(soporte, `select public.foto(p_slug => 'yanina') as f`)).f;
    assert.deepEqual([foto.site.payments, foto.site.mp, foto.config.mp], ['simulado', null, { mode: 'simulado', env: 'prueba', account: null }]);
    const resumen = (f) => f.bookings.map((b) => [b.id, b.status, b.total, b.refund?.done ?? null, b.payments.map((p) => [p.kind, p.amount, p.status])]);
    assert.deepEqual(resumen(foto), resumen(antes));
    assert.deepEqual(foto.bookings.map((b) => [b.pending, b.surplus]), [[null, []], [null, []], [null, []]]);
    assert.deepEqual((await pg.query(`select distinct proveedor, intentos, error, enlace from public.pagos`)).rows, [{ proveedor: 'simulado', intentos: 0, error: null, enlace: null }]);
    // El pago de prueba sigue andando, y Mercado Pago todavía no existe para este consultorio
    await comoPersona(pro, `select public.simular_pago(p_slug => 'yanina', p_reserva => $1, p_tipo => 'sena')`, [esperando.id]);
    await assert.rejects(comoPersona(pro, `select public.mp_pago_preparar(p_slug => 'yanina', p_reserva => $1, p_tipo => 'saldo')`, [esperando.id]), /pagos_simulados/);
    // Y la base queda como la nueva: lo que pide control.sql
    const control = (await pg.query(readFileSync(new URL('../../supabase/control.sql', import.meta.url), 'utf8'))).rows[0];
    assert.deepEqual({ ...control, lee_usuarios: undefined, dueno: undefined }, {
      tablas: 15, sin_candado: 0, f_public: 58, f_interno: control.f_interno, sin_sesion: 'public.portada', con_sesion: 34, arca_solo_servicio: 5,
      mp_solo_servicio: 19, interno_abierto: false, legibles: 0, mp_tablas_abiertas: 0, ext: 'extensions', lee_usuarios: undefined, dueno: undefined });
  } finally {
    await pg.close();
  }
});

test('la migración de facturas se carga sobre una base con datos y lo que había sigue andando', async () => {
  const nueva = '20261123100000_facturas_arca.sql';
  const pg = await armarBase(MIGRACIONES.slice(0, MIGRACIONES.indexOf(nueva)));     // solo las anteriores a esa
  try {
    // Como el proyecto real: el consultorio de Yani, «Soporte Entreturno» como dueña (sin CUIT) y una profesional que
    // pidió acceso con la página vieja, con una CUIT que no da (antes se aceptaba cualquier número)
    const c = (await pg.query(
      `insert into public.consultorios (slug, nombre, duena, letras, reglamento) values ('yanina', 'Consultorio Yani', 'Yani', 'YO', 'Provisorio') returning id`,
    )).rows[0].id;
    const cat = (await pg.query(
      `insert into public.categorias (consultorio_id, nombre, nota, precio_hora, orden) values ($1, 'Médicas y médicos', '', 25000, 1) returning id`, [c],
    )).rows[0].id;
    const soporte = await crearCuenta(pg, 'soporte@entreturno.prueba');
    await pg.query(`select interno.alta_admin('yanina', 'soporte@entreturno.prueba', 'Soporte Entreturno')`);
    const comoPersona = (sub, sql, params) => comoRol(pg, 'authenticated', sub, (tx) => tx.query(sql, params));
    const pedirViejo = (sub, nombre, cuit) => comoPersona(sub,
      `select public.pedir_acceso(p_slug => 'yanina', p_nombre => $2, p_profesion => 'Médica', p_categoria => $1, p_telefono => '', p_cuit => $3)`,
      [cat, nombre, cuit]);
    await pedirViejo(await crearCuenta(pg, 'vieja@prueba.com'), 'Vieja', '27-11111111-1');

    // La migración nueva, como en el SQL Editor
    await pg.exec(`set role ${DUENO}`);
    await pg.exec(leerMigracion(nueva));
    await pg.exec('reset role');

    // Lo que había sigue andando: la foto de la dueña, la profesional vieja con su CUIT (la dueña la ve y la corrige)
    const foto = (await comoPersona(soporte, `select public.foto(p_slug => 'yanina') as f`)).rows[0].f;
    assert.equal(foto.site.name, 'Consultorio Yani');
    const vieja = foto.users.find((u) => u.name === 'Vieja');
    assert.deepEqual([vieja.cuit, vieja.ivaCond], ['27-11111111-1', null]);
    assert.deepEqual([foto.config.billing.env, foto.invoices], ['apagado', []]);
    // Un pedido de acceso mandado por la página vieja (sin condición de IVA, sin CUIT) sigue entrando
    await pedirViejo(await crearCuenta(pg, 'otra@prueba.com'), 'Otra', '');
    // Y la base queda como la nueva: las funciones de ARCA, cerradas para la página
    const cerradas = (await pg.query(`
      select count(*)::int as n from pg_proc p
       where p.pronamespace = 'public'::regnamespace and p.proname like 'arca\\_%'
         and has_function_privilege('service_role', p.oid, 'execute')
         and not has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute')`)).rows[0].n;
    assert.equal(cerradas, 5);
  } finally {
    await pg.close();
  }
});
