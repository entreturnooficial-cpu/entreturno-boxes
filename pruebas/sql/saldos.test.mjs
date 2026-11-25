// Saldos pendientes: cuántos turnos señados sin terminar de pagar puede tener cada profesional (pedido de Santiago, 20/11/2026).
// Por defecto son 2. Al llegar a ese número: si alguno es de un turno que ya pasó, no reserva hasta pagarlo;
// si está al día, puede seguir reservando pero pagando el turno nuevo completo.
import assert from 'node:assert/strict';

import { esperarError, prueba } from './entorno.mjs';

const guardarPago = (e, esc, maxSaldos) =>
  e.llamarComo(esc.admin, 'guardar_pago', { p_slug: esc.slug, p_sena_pct: 50, p_minutos_pago: 15, p_max_saldos: maxSaldos });
/** Reserva con seña y paga la seña: queda un turno con saldo pendiente. */
async function senar(e, esc, quien, args) {
  const r = await e.reservar(esc, quien, { plan: 'sena', ...args });
  await e.pagar(esc, quien, r.id, 'sena');
  return r;
}
/** Hace de cuenta que ese turno fue ayer (ya se usó). */
const yaPaso = async (e, id) => e.sql(`update public.reservas set fecha = $2 where id = $1`, [id, await e.fecha(-1)]);

prueba('con dos turnos señados sin terminar de pagar, el tercero va completo o hay que saldar uno', async (e) => {
  const esc = await e.armar();
  const dia = await e.diaHabil(4);
  assert.equal((await e.foto(esc, esc.lucia)).config.maxOpenBalances, 2);
  const a = await senar(e, esc, esc.lucia, { fecha: dia, box: 1 });
  await senar(e, esc, esc.lucia, { fecha: dia, box: 2 });
  await esperarError(e.reservar(esc, esc.lucia, { fecha: dia, box: 3, plan: 'sena' }), 'demasiados_saldos');
  // Está al día (ningún turno pasó): puede seguir reservando si paga el turno nuevo completo
  const c = await e.reservar(esc, esc.lucia, { fecha: dia, box: 3, plan: 'total' });
  await e.pagar(esc, esc.lucia, c.id, 'total');
  // Salda uno y vuelve a poder señar
  await e.pagar(esc, esc.lucia, a.id, 'saldo');
  await e.reservar(esc, esc.lucia, { fecha: dia, box: 1, desde: 12, hasta: 16, plan: 'sena' });
  // A otra profesional no la afecta
  await e.reservar(esc, esc.caro, { fecha: dia, box: 2, desde: 12, hasta: 16, plan: 'sena' });
});

prueba('los turnos que está por señar también cuentan, y cancelar uno libera lugar', async (e) => {
  const esc = await e.armar();
  const dia = await e.diaHabil(4);
  const a = await e.reservar(esc, esc.lucia, { fecha: dia, box: 1, plan: 'sena' });      // todavía sin pagar la seña
  await e.reservar(esc, esc.lucia, { fecha: dia, box: 2, plan: 'sena' });
  await esperarError(e.reservar(esc, esc.lucia, { fecha: dia, box: 3, plan: 'sena' }), 'demasiados_saldos');
  await e.llamarComo(esc.lucia, 'cancelar_reserva', { p_slug: esc.slug, p_reserva: a.id });
  await e.reservar(esc, esc.lucia, { fecha: dia, box: 3, plan: 'sena' });
  // Un turno pagado completo no cuenta: puede tener varios
  await e.pg.exec(`delete from public.reserva_maquinas; delete from public.pagos; delete from public.reservas`);
  for (const box of [1, 2, 3]) {
    const r = await e.reservar(esc, esc.lucia, { fecha: dia, box, plan: 'total' });
    await e.pagar(esc, esc.lucia, r.id, 'total');
  }
  await e.reservar(esc, esc.lucia, { fecha: dia, box: 1, desde: 12, hasta: 16, plan: 'sena' });
});

prueba('con el saldo de un turno que ya pasó sin pagar y en el tope, no reserva nada hasta pagarlo', async (e) => {
  const esc = await e.armar();
  const dia = await e.diaHabil(4);
  const a = await senar(e, esc, esc.lucia, { fecha: dia, box: 1 });
  await yaPaso(e, a.id);
  // Debe un turno ya usado, pero es uno solo: todavía puede reservar (es la tolerancia de dos turnos)
  await senar(e, esc, esc.lucia, { fecha: dia, box: 2 });
  // Ahora son dos y uno está vencido: no puede ni señando ni pagando completo
  await esperarError(e.reservar(esc, esc.lucia, { fecha: dia, box: 3, plan: 'sena' }), 'saldo_vencido');
  await esperarError(e.reservar(esc, esc.lucia, { fecha: dia, box: 3, plan: 'total' }), 'saldo_vencido');
  // El saldo de un turno ya usado se puede pagar: paga y vuelve a reservar
  assert.equal((await e.foto(esc, esc.lucia)).bookings.find((b) => b.id === a.id).status, 'cumplida');
  assert.deepEqual(await e.pagar(esc, esc.lucia, a.id, 'saldo'), { status: 'cumplida', paid: 40000, balance: 0 });
  await esperarError(e.pagar(esc, esc.lucia, a.id, 'saldo'), 'nada_que_pagar');
  await e.reservar(esc, esc.lucia, { fecha: dia, box: 3, plan: 'sena' });
  const aviso = await e.uno(`select asunto, cuerpo from public.avisos where miembro_id = $1 and asunto = 'Recibimos tu pago'`, [await e.miembro(esc, esc.lucia)]);
  assert.match(aviso.cuerpo, /Tu turno está pago completo\./);
});

prueba('la dueña elige el tope: uno solo (estricto), varios, o sin tope', async (e) => {
  const esc = await e.armar();
  const dia = await e.diaHabil(4);
  await esperarError(guardarPago(e, esc, -1), 'dato_invalido');       // cero se puede: es «ninguno» (pruebas/sql/almagro.test.mjs)
  await esperarError(guardarPago(e, esc, 21), 'dato_invalido');

  // Estricto: con un pago pendiente, el próximo turno va completo; y si ese pago es de un turno que ya pasó, nada
  await guardarPago(e, esc, 1);
  assert.equal((await e.foto(esc, esc.caro)).config.maxOpenBalances, 1);
  const a = await senar(e, esc, esc.caro, { fecha: dia, box: 1 });
  await esperarError(e.reservar(esc, esc.caro, { fecha: dia, box: 2, plan: 'sena' }), 'demasiados_saldos');
  const b = await e.reservar(esc, esc.caro, { fecha: dia, box: 2, plan: 'total' });
  await e.llamarComo(esc.caro, 'cancelar_reserva', { p_slug: esc.slug, p_reserva: b.id });
  await yaPaso(e, a.id);
  await esperarError(e.reservar(esc, esc.caro, { fecha: dia, box: 2, plan: 'total' }), 'saldo_vencido');

  // Sin tope: puede señar todos los que quiera, aunque deba uno viejo
  await guardarPago(e, esc, null);
  assert.equal((await e.foto(esc, esc.caro)).config.maxOpenBalances, null);
  for (const box of [1, 2, 3]) await senar(e, esc, esc.caro, { fecha: dia, box });
});

prueba('si la seña es del 100 %, señar no deja saldo y no cuenta para el tope', async (e) => {
  const esc = await e.armar();
  const dia = await e.diaHabil(4);
  await senar(e, esc, esc.lucia, { fecha: dia, box: 1 });
  await senar(e, esc, esc.lucia, { fecha: dia, box: 2 });
  await e.sql(`update public.consultorios set sena_pct = 100 where id = $1`, [esc.id]);
  const r = await e.reservar(esc, esc.lucia, { fecha: dia, box: 3, plan: 'sena' });
  assert.deepEqual([r.total, r.amount], [48000, 48000]);
});
