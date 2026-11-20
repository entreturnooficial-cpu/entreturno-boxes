// La agenda de la dueña: horarios bloqueados y ratos libres publicados.
import assert from 'node:assert/strict';

import { esperarError, prueba } from './entorno.mjs';

const bloquear = (e, esc, args) =>
  e.llamarComo(esc.admin, 'bloquear', { p_slug: esc.slug, p_boxes: '{1}', p_desde: 8, p_hasta: 16, p_semanal: false, p_nota: 'Atiendo yo', ...args });
const rato = (e, esc, args) => e.llamarComo(esc.admin, 'publicar_rato', { p_slug: esc.slug, p_box: 1, ...args });
const mas7 = (fecha) => { const d = new Date(`${fecha}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + 7); return d.toISOString().slice(0, 10); };

prueba('un horario bloqueado no se puede reservar; el resto del día sí', async (e) => {
  const esc = await e.armar();
  const dia = await e.diaHabil(3);
  const b = await bloquear(e, esc, { p_fecha: dia });
  assert.equal(b.clashes, 0);
  await esperarError(e.reservar(esc, esc.lucia, { fecha: dia, box: 1, desde: 8, hasta: 12 }), 'horario_no_disponible');
  await esperarError(e.reservar(esc, esc.lucia, { fecha: dia, box: 1, desde: 12, hasta: 16 }), 'horario_no_disponible');
  await e.reservar(esc, esc.lucia, { fecha: dia, box: 1, desde: 16, hasta: 20 });       // después del bloqueo
  await e.reservar(esc, esc.lucia, { fecha: dia, box: 2, desde: 8, hasta: 12 });        // otro box
  await e.reservar(esc, esc.caro, { fecha: mas7(dia), box: 1, desde: 8, hasta: 12 });   // la semana siguiente: era solo ese día

  // Un bloqueo que toma solo un pedazo del turno deja ese turno sin poder reservarse
  await bloquear(e, esc, { p_fecha: dia, p_boxes: '{3}', p_desde: 12, p_hasta: 13 });
  await esperarError(e.reservar(esc, esc.caro, { fecha: dia, box: 3, desde: 12, hasta: 16 }), 'horario_no_disponible');
});

prueba('un bloqueo de todas las semanas vale para ese día de cada semana, y puede tomar varios boxes', async (e) => {
  const esc = await e.armar();
  const dia = await e.diaHabil(3);
  await bloquear(e, esc, { p_fecha: dia, p_semanal: true, p_boxes: '{1,3}', p_nota: '' });
  for (const fecha of [dia, mas7(dia), mas7(mas7(dia))]) {
    await esperarError(e.reservar(esc, esc.lucia, { fecha, box: 1 }), 'horario_no_disponible');
    await esperarError(e.reservar(esc, esc.lucia, { fecha, box: 3 }), 'horario_no_disponible');
  }
  await e.reservar(esc, esc.lucia, { fecha: dia, box: 2 });
  const fila = await e.uno(`select recurrente, dia_semana, fecha, nota from public.bloqueos`);
  assert.deepEqual([fila.recurrente, fila.dia_semana, fila.fecha, fila.nota], [true, new Date(`${dia}T12:00:00Z`).getUTCDay(), null, 'Lo uso yo']);
});

prueba('bloquear sobre una reserva ya tomada no la cancela: avisa cuántas quedan en pie', async (e) => {
  const esc = await e.armar();
  const dia = await e.diaHabil(3);
  const r = await e.reservar(esc, esc.lucia, { fecha: dia, box: 1 });
  await e.pagar(esc, esc.lucia, r.id, 'sena');
  assert.equal((await bloquear(e, esc, { p_fecha: dia })).clashes, 1);
  assert.equal((await e.uno(`select estado from public.reservas where id = $1`, [r.id])).estado, 'confirmada');
  assert.equal((await bloquear(e, esc, { p_fecha: dia, p_semanal: true, p_boxes: '{1,2}' })).clashes, 1);
  assert.equal((await bloquear(e, esc, { p_fecha: dia, p_boxes: '{2}' })).clashes, 0);
});

prueba('bloquear pide boxes que existan y horas dentro del horario', async (e) => {
  const esc = await e.armar();
  const dia = await e.diaHabil(3);
  await esperarError(bloquear(e, esc, { p_fecha: dia, p_boxes: '{}' }), 'box_inexistente');
  await esperarError(bloquear(e, esc, { p_fecha: dia, p_boxes: '{1,7}' }), 'box_inexistente');
  await esperarError(bloquear(e, esc, { p_fecha: dia, p_desde: 12, p_hasta: 12 }), 'horario_invalido');
  await esperarError(bloquear(e, esc, { p_fecha: dia, p_desde: 6, p_hasta: 10 }), 'horario_invalido');
  await esperarError(bloquear(e, esc, { p_fecha: dia, p_desde: 16, p_hasta: 22 }), 'horario_invalido');
  await esperarError(bloquear(e, esc, { p_fecha: null }), 'horario_invalido');
  await esperarError(bloquear(e, esc, { p_fecha: dia, p_nota: 'x'.repeat(121) }), 'dato_invalido');
  assert.equal((await e.uno(`select count(*)::int as n from public.bloqueos`)).n, 0);
});

prueba('un rato libre publicado se reserva entero, al precio por hora de quien lo toma', async (e) => {
  const esc = await e.armar();
  const dia = await e.diaHabil(3);
  await bloquear(e, esc, { p_fecha: dia });                                   // box 1, de 8 a 16
  await esperarError(rato(e, esc, { p_fecha: dia, p_desde: 14, p_hasta: 18 }), 'fuera_de_bloqueo');   // se sale del bloqueo
  await esperarError(rato(e, esc, { p_fecha: dia, p_box: 2, p_desde: 12, p_hasta: 14 }), 'fuera_de_bloqueo');
  await esperarError(rato(e, esc, { p_fecha: mas7(dia), p_desde: 12, p_hasta: 14 }), 'fuera_de_bloqueo');
  await esperarError(rato(e, esc, { p_fecha: dia, p_desde: 14, p_hasta: 12 }), 'horario_invalido');
  await esperarError(rato(e, esc, { p_fecha: dia, p_box: 8, p_desde: 12, p_hasta: 14 }), 'box_inexistente');
  const r = await rato(e, esc, { p_fecha: dia, p_desde: 12, p_hasta: 14 });
  await esperarError(rato(e, esc, { p_fecha: dia, p_desde: 13, p_hasta: 15 }), 'rato_superpuesto');

  // No se puede tomar medio rato, ni el turno entero que lo contiene
  await esperarError(e.reservar(esc, esc.caro, { fecha: dia, box: 1, desde: 12, hasta: 13 }), 'horario_no_disponible');
  await esperarError(e.reservar(esc, esc.caro, { fecha: dia, box: 1, desde: 12, hasta: 16 }), 'horario_no_disponible');
  await esperarError(e.reservar(esc, esc.caro, { fecha: dia, box: 1, desde: 8, hasta: 12 }), 'horario_no_disponible');
  const reserva = await e.reservar(esc, esc.caro, { fecha: dia, box: 1, desde: 12, hasta: 14, plan: 'total' });
  assert.equal(reserva.total, 12000);                                          // esteticista: $ 6.000 x 2 h
  await esperarError(e.reservar(esc, esc.lucia, { fecha: dia, box: 1, desde: 12, hasta: 14 }), 'horario_no_disponible');

  // La profesional ve el bloqueo sin la nota y el rato libre; la dueña ve la nota
  const fp = await e.foto(esc, esc.lucia);
  assert.deepEqual(fp.blocks.map((b) => [b.boxIds, b.recurring, b.date, b.start, b.end, b.note]), [[[1], false, dia, 8, 16, '']]);
  assert.deepEqual(fp.releases, [{ id: r.id, boxId: 1, date: dia, start: 12, end: 14 }]);
  assert.equal((await e.foto(esc, esc.admin)).blocks[0].note, 'Atiendo yo');

  // Si la dueña lo vuelve a bloquear, la reserva ya tomada sigue
  await e.llamarComo(esc.admin, 'quitar_rato', { p_slug: esc.slug, p_rato: r.id });
  await esperarError(e.llamarComo(esc.admin, 'quitar_rato', { p_slug: esc.slug, p_rato: r.id }), 'rato_inexistente');
  assert.equal((await e.uno(`select estado from public.reservas where id = $1`, [reserva.id])).estado, 'pago');
});

prueba('liberar un día entero de un bloqueo fijo, y quitar bloqueos', async (e) => {
  const esc = await e.armar();
  const dia = await e.diaHabil(3);
  const b = await bloquear(e, esc, { p_fecha: dia, p_semanal: true });       // todas las semanas, box 1, de 8 a 16
  await esperarError(e.llamarComo(esc.admin, 'liberar_dia', { p_slug: esc.slug, p_bloqueo: b.id, p_box: 2, p_fecha: dia }), 'fuera_de_bloqueo');
  await esperarError(e.llamarComo(esc.admin, 'liberar_dia', { p_slug: esc.slug, p_bloqueo: '00000000-0000-0000-0000-000000000000', p_box: 1, p_fecha: dia }), 'bloqueo_inexistente');
  await e.llamarComo(esc.admin, 'liberar_dia', { p_slug: esc.slug, p_bloqueo: b.id, p_box: 1, p_fecha: dia });
  assert.deepEqual((await e.foto(esc, esc.caro)).releases.map((r) => [r.boxId, r.date, r.start, r.end]), [[1, dia, 8, 16]]);
  // Ese día se reserva el rato entero (8 horas); la semana siguiente sigue bloqueado
  const r = await e.reservar(esc, esc.caro, { fecha: dia, box: 1, desde: 8, hasta: 16 });
  assert.equal(r.total, 48000);
  await esperarError(e.reservar(esc, esc.lucia, { fecha: mas7(dia), box: 1, desde: 8, hasta: 12 }), 'horario_no_disponible');

  // Otro rato, la semana siguiente; al quitar el bloqueo, los ratos que vivían adentro se van y vuelve la grilla normal
  await rato(e, esc, { p_fecha: mas7(dia), p_desde: 8, p_hasta: 10 });
  await esperarError(e.reservar(esc, esc.lucia, { fecha: mas7(dia), box: 1, desde: 8, hasta: 12 }), 'horario_no_disponible');
  await e.llamarComo(esc.admin, 'quitar_bloqueo', { p_slug: esc.slug, p_bloqueo: b.id });
  await esperarError(e.llamarComo(esc.admin, 'quitar_bloqueo', { p_slug: esc.slug, p_bloqueo: b.id }), 'bloqueo_inexistente');
  assert.equal((await e.uno(`select count(*)::int as n from public.ratos_libres`)).n, 0);
  assert.equal((await e.uno(`select count(*)::int as n from public.bloqueo_boxes`)).n, 0);
  await e.reservar(esc, esc.lucia, { fecha: mas7(dia), box: 1, desde: 8, hasta: 12 });
  assert.equal((await e.uno(`select estado from public.reservas where id = $1`, [r.id])).estado, 'pago');    // la reserva del rato sigue
});

prueba('si dos bloqueos cubren el mismo rato, quitar uno no borra el rato', async (e) => {
  const esc = await e.armar();
  const dia = await e.diaHabil(3);
  const fijo = await bloquear(e, esc, { p_fecha: dia, p_semanal: true });
  await bloquear(e, esc, { p_fecha: dia });
  const r = await rato(e, esc, { p_fecha: dia, p_desde: 12, p_hasta: 14 });
  await e.llamarComo(esc.admin, 'quitar_bloqueo', { p_slug: esc.slug, p_bloqueo: fijo.id });
  assert.deepEqual((await e.sql(`select id from public.ratos_libres`)).map((x) => x.id), [r.id]);
});
