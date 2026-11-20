// Reservar: precios, horarios permitidos, choques, vencimiento y lo que ve cada una.
import assert from 'node:assert/strict';

import { esperarError, prueba } from './entorno.mjs';

prueba('reservar un turno: el precio sale de la categoría y queda esperando el pago', async (e) => {
  const esc = await e.armar();
  const dia = await e.diaHabil(3);
  const r = await e.reservar(esc, esc.lucia, { fecha: dia, box: 2, desde: 8, hasta: 12, plan: 'sena', servicio: '  Dermatología ' });
  assert.equal(r.total, 40000);            // médica: $ 10.000 x 4 h
  assert.equal(r.amount, 20000);           // seña del 50 %
  const fila = await e.uno(`select estado, plan, precio_hora, monto_box, total, servicio, categoria_nombre, reglamento_version,
                                   round(extract(epoch from (vence_en - creada_en)) / 60)::int as minutos
                              from public.reservas where id = $1`, [r.id]);
  assert.deepEqual(fila, { estado: 'pago', plan: 'sena', precio_hora: 10000, monto_box: 40000, total: 40000, servicio: 'Dermatología',
    categoria_nombre: 'Médicas y médicos', reglamento_version: 1, minutos: 15 });

  // La esteticista paga su precio, y pagando el total el monto a pagar es el total
  const r2 = await e.reservar(esc, esc.caro, { fecha: dia, box: 1, desde: 12, hasta: 16, plan: 'total' });
  assert.deepEqual([r2.total, r2.amount], [24000, 24000]);
});

prueba('un box con precio propio cobra su precio; las máquinas se suman por hora', async (e) => {
  const esc = await e.armar();
  const dia = await e.diaHabil(3);
  const r = await e.reservar(esc, esc.lucia, { fecha: dia, box: 3, desde: 8, hasta: 12 });
  assert.equal(r.total, 48000);            // box 3 para médicas: $ 12.000 x 4 h
  const r2 = await e.reservar(esc, esc.caro, { fecha: dia, box: 3, desde: 12, hasta: 16, maquinas: [esc.maquinas.laser, esc.maquinas.crio, esc.maquinas.laser] });
  assert.equal(r2.total, 32000 + 64000 + 56000);   // box 3 para esteticistas $ 8.000 x 4 + láser $ 16.000 x 4 + crio $ 14.000 x 4
  assert.equal(r2.amount, 76000);
  const maq = await e.sql(`select nombre, horas, precio_hora, monto from public.reserva_maquinas where reserva_id = $1 order by nombre`, [r2.id]);
  assert.deepEqual(maq, [{ nombre: 'Criolipólisis', horas: 4, precio_hora: 14000, monto: 56000 }, { nombre: 'Láser', horas: 4, precio_hora: 16000, monto: 64000 }]);
});

prueba('una máquina no puede estar en dos reservas a la vez, ni se puede sumar una pausada', async (e) => {
  const esc = await e.armar();
  const dia = await e.diaHabil(3);
  await e.reservar(esc, esc.lucia, { fecha: dia, box: 1, maquinas: [esc.maquinas.laser] });
  await esperarError(e.reservar(esc, esc.caro, { fecha: dia, box: 2, maquinas: [esc.maquinas.laser] }), 'maquina_no_disponible');
  await esperarError(e.reservar(esc, esc.caro, { fecha: dia, box: 2, maquinas: [esc.maquinas.pausada] }), 'maquina_no_disponible');
  await esperarError(e.reservar(esc, esc.caro, { fecha: dia, box: 2, maquinas: ['00000000-0000-0000-0000-000000000001'] }), 'maquina_no_disponible');
  // Cuando falla por la máquina no queda media reserva guardada
  assert.equal((await e.uno(`select count(*)::int as n from public.reservas`)).n, 1);
  // En otro horario o con otra máquina, sí
  await e.reservar(esc, esc.caro, { fecha: dia, box: 2, maquinas: [esc.maquinas.crio] });
  await e.reservar(esc, esc.caro, { fecha: dia, box: 2, desde: 12, hasta: 16, maquinas: [esc.maquinas.laser] });
});

prueba('dos reservas no se pisan, aunque la primera todavía no esté paga', async (e) => {
  const esc = await e.armar();
  const dia = await e.diaHabil(3);
  await e.reservar(esc, esc.lucia, { fecha: dia, box: 2 });
  await esperarError(e.reservar(esc, esc.caro, { fecha: dia, box: 2 }), 'horario_no_disponible');
  await esperarError(e.reservar(esc, esc.lucia, { fecha: dia, box: 2 }), 'horario_no_disponible');
  await e.reservar(esc, esc.caro, { fecha: dia, box: 1 });            // otro box, mismo horario: sí
  await e.reservar(esc, esc.caro, { fecha: dia, box: 2, desde: 12, hasta: 16 });
  // La base misma lo impide, aunque alguien se saltee la función
  await assert.rejects(e.sql(`insert into public.reservas (consultorio_id, miembro_id, box_id, fecha, desde, hasta, precio_hora, monto_box, total, monto_sena, plan, reglamento_version)
                              select consultorio_id, miembro_id, box_id, fecha, 10, 14, 1, 4, 4, 2, 'sena', 1 from public.reservas limit 1`), /reservas_no_se_pisan/);
});

prueba('solo se reservan turnos enteros de la grilla, en días y horas que abre, y hacia adelante', async (e) => {
  const esc = await e.armar();
  await e.sql(`update public.consultorios set max_saldos = null where id = $1`, [esc.id]);      // acá se prueba otra regla: sin tope de saldos
  const dia = await e.diaHabil(3);
  const no = (cambios) => esperarError(e.reservar(esc, esc.lucia, { fecha: dia, ...cambios }), 'horario_no_disponible');
  await no({ desde: 9, hasta: 13 });       // no arranca donde arranca un turno
  await no({ desde: 8, hasta: 10 });       // medio turno
  await no({ desde: 8, hasta: 16 });       // dos turnos juntos
  await no({ desde: 4, hasta: 8 });        // antes de abrir
  await no({ desde: 20, hasta: 24 });      // después de cerrar
  await no({ desde: 12, hasta: 8 });       // al revés
  await no({ desde: null });
  await no({ fecha: null });
  // domingo: cerrado
  let domingo = await e.fecha(1);
  for (let i = 2; new Date(`${domingo}T12:00:00Z`).getUTCDay() !== 0; i++) domingo = await e.fecha(i);
  await no({ fecha: domingo });
  // ayer
  await no({ fecha: await e.fecha(-1) });
  // más allá de las semanas que se pueden reservar
  await esperarError(e.reservar(esc, esc.lucia, { fecha: await e.diaHabil(8 * 7 + 8) }), 'fuera_de_rango');
  await esperarError(e.reservar(esc, esc.lucia, { fecha: dia, box: 9 }), 'box_inexistente');
  await esperarError(e.reservar(esc, esc.lucia, { fecha: dia, plan: 'gratis' }), 'plan_invalido');
  await esperarError(e.reservar(esc, esc.lucia, { fecha: dia, servicio: 'x'.repeat(121) }), 'dato_invalido');
  assert.equal((await e.uno(`select count(*)::int as n from public.reservas`)).n, 0);
  // Los tres turnos del día sí
  for (const [desde, hasta] of [[8, 12], [12, 16], [16, 20]]) await e.reservar(esc, esc.lucia, { fecha: dia, desde, hasta });
});

prueba('un turno de hoy que ya empezó no se puede reservar', async (e) => {
  const esc = await e.armar();
  // Abre las 24 horas, con turnos de 1 hora: siempre hay una hora que ya empezó y otra que todavía no
  await e.sql(`update public.consultorios set abre = 0, cierra = 24, turno_horas = 1, dias = '{0,1,2,3,4,5,6}' where id = $1`, [esc.id]);
  const ahora = await e.uno(`select extract(hour from now() at time zone 'America/Argentina/Buenos_Aires')::int as h`);
  const hoy = await e.fecha(0);
  await esperarError(e.reservar(esc, esc.lucia, { fecha: hoy, desde: ahora.h, hasta: ahora.h + 1 }), 'horario_no_disponible');
  if (ahora.h < 23) await e.reservar(esc, esc.lucia, { fecha: hoy, desde: ahora.h + 1, hasta: ahora.h + 2 });
});

prueba('solo reservan las profesionales aprobadas', async (e) => {
  const esc = await e.armar();
  const dia = await e.diaHabil(3);
  await esperarError(e.reservar(esc, esc.martina, { fecha: dia }), 'no_aprobada');       // pendiente
  await esperarError(e.reservar(esc, esc.admin, { fecha: dia }), 'no_aprobada');         // la dueña bloquea, no reserva
  await esperarError(e.reservar(esc, await e.crearUsuario(), { fecha: dia }), 'no_aprobada');
  const caro = await e.miembro(esc, esc.caro);
  await e.llamarComo(esc.admin, 'cambiar_estado_profesional', { p_slug: esc.slug, p_miembro: caro, p_estado: 'bloqueado' });
  await esperarError(e.reservar(esc, esc.caro, { fecha: dia }), 'no_aprobada');          // pausada
  await e.reservar(esc, esc.lucia, { fecha: dia });
});

prueba('si no se paga a tiempo, el turno se libera solo', async (e) => {
  const esc = await e.armar();
  const dia = await e.diaHabil(3);
  const r = await e.reservar(esc, esc.lucia, { fecha: dia, box: 2, maquinas: [esc.maquinas.laser] });
  await esperarError(e.reservar(esc, esc.caro, { fecha: dia, box: 2 }), 'horario_no_disponible');
  await e.sql(`update public.reservas set vence_en = now() - interval '1 minute' where id = $1`, [r.id]);
  // Caro lo puede tomar apenas vence, con la misma máquina, sin esperar a nadie
  const r2 = await e.reservar(esc, esc.caro, { fecha: dia, box: 2, maquinas: [esc.maquinas.laser] });
  const vieja = await e.uno(`select estado, cancelada_por, devolucion_monto from public.reservas where id = $1`, [r.id]);
  assert.deepEqual(vieja, { estado: 'cancelada', cancelada_por: 'vencida', devolucion_monto: 0 });
  // Ya no se puede pagar la vencida
  await esperarError(e.pagar(esc, esc.lucia, r.id, 'sena'), 'pago_invalido');
  assert.equal((await e.uno(`select estado from public.reservas where id = $1`, [r2.id])).estado, 'pago');
  // A Lucía le queda el aviso
  const aviso = await e.uno(`select asunto from public.avisos where miembro_id = $1 order by creado_en desc limit 1`, [await e.miembro(esc, esc.lucia)]);
  assert.equal(aviso.asunto, 'Se liberó tu reserva');
});

prueba('una profesional no puede acaparar turnos sin pagar', async (e) => {
  const esc = await e.armar();
  await e.sql(`update public.consultorios set max_saldos = null where id = $1`, [esc.id]);      // acá se prueba otra regla: sin tope de saldos
  const dia = await e.diaHabil(3);
  const a = await e.reservar(esc, esc.lucia, { fecha: dia, box: 1 });
  await e.reservar(esc, esc.lucia, { fecha: dia, box: 2 });
  await e.reservar(esc, esc.lucia, { fecha: dia, box: 3 });
  await esperarError(e.reservar(esc, esc.lucia, { fecha: dia, box: 1, desde: 12, hasta: 16 }), 'demasiadas_sin_pagar');
  await e.pagar(esc, esc.lucia, a.id, 'sena');          // al pagar una, puede tomar otra
  await e.reservar(esc, esc.lucia, { fecha: dia, box: 1, desde: 12, hasta: 16 });
});

prueba('si el reglamento cambió, hay que aceptar el nuevo', async (e) => {
  const esc = await e.armar();
  const dia = await e.diaHabil(3);
  await e.llamarComo(esc.admin, 'guardar_reglamento', { p_slug: esc.slug, p_texto: 'Reglamento nuevo.' });
  await esperarError(e.reservar(esc, esc.lucia, { fecha: dia, version: 1 }), 'reglamento_cambio');
  await esperarError(e.reservar(esc, esc.lucia, { fecha: dia, version: null }), 'reglamento_cambio');
  const r = await e.reservar(esc, esc.lucia, { fecha: dia, version: 2 });
  assert.equal((await e.uno(`select reglamento_version as v from public.reservas where id = $1`, [r.id])).v, 2);
});

prueba('cada una ve lo suyo: las demás profesionales ven «ocupado», sin nombre, servicio ni plata', async (e) => {
  const esc = await e.armar();
  const dia = await e.diaHabil(3);
  const r = await e.reservar(esc, esc.lucia, { fecha: dia, box: 2, servicio: 'Dermatología reservada', maquinas: [esc.maquinas.laser] });
  await e.pagar(esc, esc.lucia, r.id, 'sena');
  const lucia = await e.miembro(esc, esc.lucia);

  // Lucía ve su reserva completa
  const fl = await e.foto(esc, esc.lucia);
  assert.equal(fl.bookings.length, 1);
  const mia = fl.bookings[0];
  assert.deepEqual([mia.id, mia.userId, mia.boxId, mia.date, mia.start, mia.end, mia.service, mia.status, mia.plan, mia.total, mia.rate, mia.boxAmount],
    [r.id, lucia, 2, dia, 8, 12, 'Dermatología reservada', 'confirmada', 'sena', 104000, 10000, 40000]);
  assert.deepEqual(mia.machines.map((m) => [m.id, m.name, m.hours, m.rate, m.amount]), [[esc.maquinas.laser, 'Láser', 4, 16000, 64000]]);
  assert.deepEqual(mia.payments.map((p) => [p.kind, p.amount, p.status]), [['sena', 52000, 'aprobado']]);
  assert.equal(typeof mia.payments[0].at, 'number');
  assert.equal(mia.expiresAt, null);
  assert.deepEqual(fl.users.map((u) => u.name), ['Lucía Ferrari']);

  // Caro ve que el horario está ocupado y que el láser está tomado, y nada más
  const fc = await e.foto(esc, esc.caro);
  assert.equal(fc.bookings.length, 1);
  const ajena = fc.bookings[0];
  assert.deepEqual(Object.keys(ajena).sort(), ['boxId', 'date', 'end', 'id', 'machines', 'payments', 'start', 'status', 'total', 'userId']);
  assert.deepEqual([ajena.userId, ajena.boxId, ajena.date, ajena.start, ajena.end, ajena.status, ajena.total], [null, 2, dia, 8, 12, 'ocupado', 0]);
  assert.deepEqual(ajena.machines, [{ id: esc.maquinas.laser }]);
  const texto = JSON.stringify(fc);
  for (const secreto of ['Lucía', 'Ferrari', 'Dermatología reservada', r.id, lucia, 'persona2@prueba.com', '52000', '104000']) {
    assert.ok(!texto.includes(secreto), `la foto de Caro no tendría que traer «${secreto}»`);
  }
  assert.deepEqual(fc.users.map((u) => u.name), ['Carolina Méndez']);
  assert.equal(fc.config.billing, null);
  assert.equal(fc.machines.length, 2);              // las pausadas no se ofrecen

  // La dueña ve todo
  const fa = await e.foto(esc, esc.admin);
  assert.equal(fa.bookings[0].service, 'Dermatología reservada');
  assert.equal(fa.users.length, 4);
  assert.equal(fa.machines.length, 3);
  assert.equal(fa.config.billing.cond, 'Monotributo');

  // Una reserva cancelada deja de verse como ocupada
  await e.llamarComo(esc.lucia, 'cancelar_reserva', { p_slug: esc.slug, p_reserva: r.id });
  assert.equal((await e.foto(esc, esc.caro)).bookings.length, 0);
  assert.equal((await e.foto(esc, esc.lucia)).bookings[0].status, 'cancelada');
});

prueba('un turno que ya pasó queda como cumplido', async (e) => {
  const esc = await e.armar();
  const dia = await e.diaHabil(3);
  const r = await e.reservar(esc, esc.lucia, { fecha: dia, plan: 'total' });
  await e.pagar(esc, esc.lucia, r.id, 'total');
  await e.sql(`update public.reservas set fecha = $2 where id = $1`, [r.id, await e.fecha(-1)]);
  const f = await e.foto(esc, esc.lucia);
  assert.equal(f.bookings[0].status, 'cumplida');
  await esperarError(e.llamarComo(esc.lucia, 'cancelar_reserva', { p_slug: esc.slug, p_reserva: r.id }), 'no_se_puede_cancelar');
  await esperarError(e.llamarComo(esc.admin, 'cancelar_reserva', { p_slug: esc.slug, p_reserva: r.id }), 'no_se_puede_cancelar');
});
