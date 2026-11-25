// Pagos de prueba, cancelaciones y devoluciones.
import assert from 'node:assert/strict';

import { esperarError, prueba } from './entorno.mjs';

const cancelar = (e, esc, quien, reserva) => e.llamarComo(quien, 'cancelar_reserva', { p_slug: esc.slug, p_reserva: reserva });

prueba('pagar la seña confirma la reserva; después se paga el saldo y no se cobra de más', async (e) => {
  const esc = await e.armar();
  const dia = await e.diaHabil(3);
  const r = await e.reservar(esc, esc.lucia, { fecha: dia, plan: 'sena' });       // total $ 40.000, seña $ 20.000
  await esperarError(e.pagar(esc, esc.lucia, r.id, 'total'), 'pago_invalido');      // eligió seña: no se le cobra el total
  await esperarError(e.pagar(esc, esc.lucia, r.id, 'saldo'), 'pago_invalido');      // todavía no hay saldo: falta la seña
  await esperarError(e.pagar(esc, esc.caro, r.id, 'sena'), 'reserva_inexistente');  // no es suya
  await esperarError(e.pagar(esc, esc.admin, r.id, 'sena'), 'reserva_inexistente');

  const p1 = await e.pagar(esc, esc.lucia, r.id, 'sena');
  assert.deepEqual(p1, { status: 'confirmada', paid: 20000, balance: 20000 });
  assert.deepEqual(await e.uno(`select estado, vence_en from public.reservas where id = $1`, [r.id]), { estado: 'confirmada', vence_en: null });
  await esperarError(e.pagar(esc, esc.lucia, r.id, 'sena'), 'pago_invalido');       // la seña ya está

  const p2 = await e.pagar(esc, esc.lucia, r.id, 'saldo');
  assert.deepEqual(p2, { status: 'confirmada', paid: 40000, balance: 0 });
  await esperarError(e.pagar(esc, esc.lucia, r.id, 'saldo'), 'nada_que_pagar');

  const pagos = await e.sql(`select tipo, monto, estado, proveedor from public.pagos where reserva_id = $1 order by creado_en`, [r.id]);
  assert.deepEqual(pagos, [{ tipo: 'sena', monto: 20000, estado: 'aprobado', proveedor: 'simulado' }, { tipo: 'saldo', monto: 20000, estado: 'aprobado', proveedor: 'simulado' }]);
  const avisos = await e.sql(`select asunto from public.avisos where miembro_id = $1 order by creado_en`, [await e.miembro(esc, esc.lucia)]);
  assert.deepEqual(avisos.map((a) => a.asunto).slice(-2), [`Reserva confirmada: Box 2, ${(await e.uno(`select interno.dia_largo($1::date) as d`, [dia])).d}`, 'Recibimos tu pago']);
});

prueba('pagar el total confirma y no deja saldo', async (e) => {
  const esc = await e.armar();
  const r = await e.reservar(esc, esc.caro, { fecha: await e.diaHabil(3), plan: 'total' });
  assert.deepEqual(await e.pagar(esc, esc.caro, r.id, 'total'), { status: 'confirmada', paid: 24000, balance: 0 });
  await esperarError(e.pagar(esc, esc.caro, r.id, 'saldo'), 'nada_que_pagar');
});

prueba('la seña se redondea igual que en la página', async (e) => {
  const esc = await e.armar();
  await e.sql(`update public.categorias set precio_hora = 3333 where id = $1`, [esc.estetica]);
  await e.sql(`update public.consultorios set sena_pct = 30 where id = $1`, [esc.id]);
  const r = await e.reservar(esc, esc.caro, { fecha: await e.diaHabil(3), box: 1, plan: 'sena' });
  assert.equal(r.total, 13332);
  assert.equal(r.amount, Math.round(13332 * 30 / 100));
  assert.equal((await e.pagar(esc, esc.caro, r.id, 'sena')).paid, 4000);
});

prueba('con Mercado Pago conectado no existe el pago de prueba', async (e) => {
  const esc = await e.armar();
  const r = await e.reservar(esc, esc.lucia, { fecha: await e.diaHabil(3) });
  await e.sql(`update public.consultorios set pagos_modo = 'mercadopago' where id = $1`, [esc.id]);
  await esperarError(e.pagar(esc, esc.lucia, r.id, 'sena'), 'pagos_no_simulados');
  assert.equal((await e.uno(`select count(*)::int as n from public.pagos`)).n, 0);
});

prueba('cancelar con anticipación devuelve según la política; con poco tiempo, menos', async (e) => {
  const esc = await e.armar();                       // política: 7 días; seña 100 % / 0 %; total 100 % / 50 %
  const lejos = await e.diaHabil(10);
  const cerca = await e.diaHabil(2);

  // Seña, con 7 días o más: se devuelve toda
  const a = await e.reservar(esc, esc.lucia, { fecha: lejos, box: 1, plan: 'sena' });
  await e.pagar(esc, esc.lucia, a.id, 'sena');
  assert.deepEqual(await cancelar(e, esc, esc.lucia, a.id), { amount: 20000, pct: 100, paid: 20000, by: 'pro' });

  // Seña, con menos de 7 días: no se devuelve
  const b = await e.reservar(esc, esc.lucia, { fecha: cerca, box: 1, plan: 'sena' });
  await e.pagar(esc, esc.lucia, b.id, 'sena');
  assert.deepEqual(await cancelar(e, esc, esc.lucia, b.id), { amount: 0, pct: 0, paid: 20000, by: 'pro' });

  // Total, con menos de 7 días: la mitad
  const c = await e.reservar(esc, esc.lucia, { fecha: cerca, box: 2, plan: 'total' });
  await e.pagar(esc, esc.lucia, c.id, 'total');
  assert.deepEqual(await cancelar(e, esc, esc.lucia, c.id), { amount: 20000, pct: 50, paid: 40000, by: 'pro' });

  // Total, con 7 días o más: todo
  const d = await e.reservar(esc, esc.lucia, { fecha: lejos, box: 2, plan: 'total' });
  await e.pagar(esc, esc.lucia, d.id, 'total');
  assert.deepEqual(await cancelar(e, esc, esc.lucia, d.id), { amount: 40000, pct: 100, paid: 40000, by: 'pro' });

  // Seña más saldo ya pagados cuenta como total
  const f = await e.reservar(esc, esc.lucia, { fecha: cerca, box: 3, plan: 'sena' });       // box 3: $ 48.000
  await e.pagar(esc, esc.lucia, f.id, 'sena');
  await e.pagar(esc, esc.lucia, f.id, 'saldo');
  assert.deepEqual(await cancelar(e, esc, esc.lucia, f.id), { amount: 24000, pct: 50, paid: 48000, by: 'pro' });

  // Sin pagar: no hay nada que devolver
  const g = await e.reservar(esc, esc.lucia, { fecha: lejos, box: 3, plan: 'sena' });
  assert.deepEqual(await cancelar(e, esc, esc.lucia, g.id), { amount: 0, pct: 100, paid: 0, by: 'pro' });

  const dev = await e.sql(`select monto, estado from public.pagos where tipo = 'devolucion' order by monto`);
  assert.deepEqual(dev, [{ monto: 20000, estado: 'aprobado' }, { monto: 20000, estado: 'aprobado' }, { monto: 24000, estado: 'aprobado' }, { monto: 40000, estado: 'aprobado' }]);
  // En la foto, cada cancelada trae su devolución
  const foto = await e.foto(esc, esc.lucia);
  const deA = foto.bookings.find((x) => x.id === a.id);
  assert.deepEqual([deA.status, deA.cancelledBy, deA.refund], ['cancelada', 'pro', { amount: 20000, pct: 100, done: true }]);
  assert.deepEqual(deA.payments.map((p) => [p.kind, p.amount]), [['sena', 20000], ['devolucion', 20000]]);
});

prueba('si cancela la dueña, se devuelve todo lo pagado', async (e) => {
  const esc = await e.armar();
  const r = await e.reservar(esc, esc.lucia, { fecha: await e.diaHabil(2), plan: 'sena' });
  await e.pagar(esc, esc.lucia, r.id, 'sena');
  assert.deepEqual(await cancelar(e, esc, esc.admin, r.id), { amount: 20000, pct: 100, paid: 20000, by: 'admin' });
  const fila = await e.uno(`select estado, cancelada_por, devolucion_monto, devolucion_pct from public.reservas where id = $1`, [r.id]);
  assert.deepEqual(fila, { estado: 'cancelada', cancelada_por: 'admin', devolucion_monto: 20000, devolucion_pct: 100 });
});

prueba('cancelar libera el horario y la máquina; no se cancela dos veces ni lo ajeno', async (e) => {
  const esc = await e.armar();
  const dia = await e.diaHabil(10);
  const r = await e.reservar(esc, esc.lucia, { fecha: dia, box: 2, maquinas: [esc.maquinas.laser] });
  await e.pagar(esc, esc.lucia, r.id, 'sena');
  await esperarError(cancelar(e, esc, esc.caro, r.id), 'reserva_inexistente');
  await esperarError(cancelar(e, esc, esc.martina, r.id), 'reserva_inexistente');
  await esperarError(cancelar(e, esc, await e.crearUsuario(), r.id), 'reserva_inexistente');
  await esperarError(cancelar(e, esc, esc.lucia, '00000000-0000-0000-0000-000000000000'), 'reserva_inexistente');
  await esperarError(e.reservar(esc, esc.caro, { fecha: dia, box: 2 }), 'horario_no_disponible');

  await cancelar(e, esc, esc.lucia, r.id);
  await esperarError(cancelar(e, esc, esc.lucia, r.id), 'no_se_puede_cancelar');
  await esperarError(cancelar(e, esc, esc.admin, r.id), 'no_se_puede_cancelar');
  await esperarError(e.pagar(esc, esc.lucia, r.id, 'saldo'), 'pago_invalido');
  const r2 = await e.reservar(esc, esc.caro, { fecha: dia, box: 2, maquinas: [esc.maquinas.laser] });
  assert.equal(r2.total, 24000 + 64000);
  // La dueña se entera de la cancelación
  const aviso = await e.uno(`select asunto from public.avisos where miembro_id = $1 order by creado_en desc limit 1`, [await e.miembro(esc, esc.admin)]);
  assert.equal(aviso.asunto, 'Cancelación: Lucía Ferrari');
});

prueba('una profesional pausada conserva sus reservas y las puede cancelar', async (e) => {
  const esc = await e.armar();
  const r = await e.reservar(esc, esc.lucia, { fecha: await e.diaHabil(10) });
  await e.pagar(esc, esc.lucia, r.id, 'sena');
  await e.llamarComo(esc.admin, 'cambiar_estado_profesional', { p_slug: esc.slug, p_miembro: await e.miembro(esc, esc.lucia), p_estado: 'bloqueado' });
  const foto = await e.foto(esc, esc.lucia);
  assert.deepEqual(foto.bookings.map((b) => b.status), ['confirmada']);
  assert.deepEqual([foto.blocks, foto.releases], [[], []]);
  assert.equal((await cancelar(e, esc, esc.lucia, r.id)).amount, 20000);
});

prueba('al pasar a Mercado Pago, lo que se había pagado de prueba no deja devoluciones esperando', async (e) => {
  const esc = await e.armar();
  const r = await e.reservar(esc, esc.lucia, { fecha: await e.diaHabil(10) });
  await e.pagar(esc, esc.lucia, r.id, 'sena');
  await e.sql(`update public.consultorios set pagos_modo = 'mercadopago' where id = $1`, [esc.id]);
  await cancelar(e, esc, esc.lucia, r.id);
  // ese pago era de prueba: no hay plata que devolver por Mercado Pago (las devoluciones de verdad están en mercadopago.test.mjs)
  assert.deepEqual(await e.uno(`select monto, estado, proveedor from public.pagos where tipo = 'devolucion'`), { monto: 20000, estado: 'aprobado', proveedor: 'simulado' });
  const b = (await e.foto(esc, esc.lucia)).bookings[0];
  assert.deepEqual(b.refund, { amount: 20000, pct: 100, done: true });
});
