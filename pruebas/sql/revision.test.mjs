// Casos que salieron de la revisión hecha con Codex el 20/11/2026 (revisiones/respuesta-codex-1.md).
import assert from 'node:assert/strict';

import { esperarError, prueba } from './entorno.mjs';

const bloquear = (e, esc, args) =>
  e.llamarComo(esc.admin, 'bloquear', { p_slug: esc.slug, p_boxes: '{1}', p_desde: 8, p_hasta: 16, p_semanal: false, p_nota: '', ...args });

prueba('un rato libre con una reserva adentro deja reservar el pedazo que quedó libre, entero', async (e) => {
  const esc = await e.armar();
  await e.sql(`update public.consultorios set max_saldos = null where id = $1`, [esc.id]);      // acá se prueba otra regla: sin tope de saldos
  const dia = await e.diaHabil(3);
  const vieja = await e.reservar(esc, esc.lucia, { fecha: dia, box: 1, desde: 8, hasta: 12 });
  await e.pagar(esc, esc.lucia, vieja.id, 'sena');
  const b = await bloquear(e, esc, { p_fecha: dia });
  assert.equal(b.clashes, 1);
  await e.llamarComo(esc.admin, 'liberar_dia', { p_slug: esc.slug, p_bloqueo: b.id, p_box: 1, p_fecha: dia });     // rato de 8 a 16

  await esperarError(e.reservar(esc, esc.caro, { fecha: dia, box: 1, desde: 8, hasta: 16 }), 'horario_no_disponible');   // pisa la reserva
  await esperarError(e.reservar(esc, esc.caro, { fecha: dia, box: 1, desde: 12, hasta: 14 }), 'horario_no_disponible');  // medio pedazo
  await esperarError(e.reservar(esc, esc.caro, { fecha: dia, box: 1, desde: 13, hasta: 16 }), 'horario_no_disponible');
  const r = await e.reservar(esc, esc.caro, { fecha: dia, box: 1, desde: 12, hasta: 16 });
  assert.equal(r.total, 24000);

  // Con una reserva en el medio quedan dos pedazos, y cada uno se reserva entero
  await e.sql(`update public.consultorios set turno_horas = 2 where id = $1`, [esc.id]);
  const otro = await e.diaHabil(5);
  const medio = await e.reservar(esc, esc.lucia, { fecha: otro, box: 2, desde: 10, hasta: 12 });
  const b2 = await bloquear(e, esc, { p_fecha: otro, p_boxes: '{2}' });
  await e.llamarComo(esc.admin, 'liberar_dia', { p_slug: esc.slug, p_bloqueo: b2.id, p_box: 2, p_fecha: otro });
  await esperarError(e.reservar(esc, esc.caro, { fecha: otro, box: 2, desde: 8, hasta: 9 }), 'horario_no_disponible');
  await esperarError(e.reservar(esc, esc.caro, { fecha: otro, box: 2, desde: 12, hasta: 14 }), 'horario_no_disponible');
  assert.equal((await e.reservar(esc, esc.caro, { fecha: otro, box: 2, desde: 8, hasta: 10 })).total, 12000);
  assert.equal((await e.reservar(esc, esc.caro, { fecha: otro, box: 2, desde: 12, hasta: 16 })).total, 24000);
  // Si la del medio se cancela, ese hueco también se puede tomar entero
  await e.llamarComo(esc.lucia, 'cancelar_reserva', { p_slug: esc.slug, p_reserva: medio.id });
  await esperarError(e.reservar(esc, esc.lucia, { fecha: otro, box: 2, desde: 10, hasta: 11 }), 'horario_no_disponible');
  await e.reservar(esc, esc.lucia, { fecha: otro, box: 2, desde: 10, hasta: 12 });
});

prueba('liberar un día exige que el bloqueo elegido sea de ese box y de ese día', async (e) => {
  const esc = await e.armar();
  const dia = await e.diaHabil(3);
  const otroDia = await e.diaHabil(5);
  const a = await bloquear(e, esc, { p_fecha: dia, p_boxes: '{1}', p_desde: 8, p_hasta: 12 });
  await bloquear(e, esc, { p_fecha: dia, p_boxes: '{2}', p_desde: 8, p_hasta: 16 });
  await bloquear(e, esc, { p_fecha: otroDia, p_boxes: '{1}', p_desde: 8, p_hasta: 16 });
  const liberar = (args) => e.llamarComo(esc.admin, 'liberar_dia', { p_slug: esc.slug, p_bloqueo: a.id, p_box: 1, p_fecha: dia, ...args });
  await esperarError(liberar({ p_box: 2 }), 'fuera_de_bloqueo');            // el box 2 tiene OTRO bloqueo ese día
  await esperarError(liberar({ p_fecha: otroDia }), 'fuera_de_bloqueo');    // ese día el box 1 tiene OTRO bloqueo
  await esperarError(liberar({ p_fecha: null }), 'fuera_de_bloqueo');
  await esperarError(liberar({ p_box: 9 }), 'box_inexistente');
  assert.equal((await e.uno(`select count(*)::int as n from public.ratos_libres`)).n, 0);
  await liberar({});
  assert.deepEqual(await e.uno(`select desde, hasta from public.ratos_libres`), { desde: 8, hasta: 12 });
});

prueba('la seña que se informó al reservar es la que se cobra, aunque después cambie el porcentaje', async (e) => {
  const esc = await e.armar();
  const r = await e.reservar(esc, esc.lucia, { fecha: await e.diaHabil(3), plan: 'sena' });
  assert.equal(r.amount, 20000);
  await e.llamarComo(esc.admin, 'guardar_pago', { p_slug: esc.slug, p_sena_pct: 80, p_minutos_pago: 15, p_max_saldos: 2 });
  assert.equal((await e.foto(esc, esc.lucia)).bookings[0].deposit, 20000);
  assert.deepEqual(await e.pagar(esc, esc.lucia, r.id, 'sena'), { status: 'confirmada', paid: 20000, balance: 20000 });
  // Las reservas nuevas sí usan el porcentaje nuevo
  const r2 = await e.reservar(esc, esc.lucia, { fecha: await e.diaHabil(3), box: 1, plan: 'sena' });
  assert.equal(r2.amount, 32000);
});

prueba('si no hay nada para cobrar, la reserva queda confirmada sin pasar por el pago', async (e) => {
  const esc = await e.armar();
  const dia = await e.diaHabil(3);
  await e.llamarComo(esc.admin, 'guardar_categoria', { p_slug: esc.slug, p_id: esc.estetica, p_nombre: 'Invitadas', p_nota: '', p_precio_hora: 0 });
  const r = await e.reservar(esc, esc.caro, { fecha: dia, box: 1, plan: 'total' });
  assert.deepEqual([r.total, r.amount, r.status, r.expiresAt], [0, 0, 'confirmada', null]);
  assert.deepEqual(await e.uno(`select estado, vence_en from public.reservas where id = $1`, [r.id]), { estado: 'confirmada', vence_en: null });
  assert.equal((await e.uno(`select count(*)::int as n from public.pagos`)).n, 0);
  await esperarError(e.pagar(esc, esc.caro, r.id, 'saldo'), 'nada_que_pagar');
  const aviso = await e.uno(`select cuerpo from public.avisos where miembro_id = $1 order by creado_en desc limit 1`, [await e.miembro(esc, esc.caro)]);
  assert.match(aviso.cuerpo, /No hay nada para pagar\./);

  // Una seña que redondea a cero confirma igual, y el total queda como saldo
  await e.sql(`update public.categorias set precio_hora = 1 where id = $1`, [esc.estetica]);
  await e.sql(`update public.consultorios set sena_pct = 1 where id = $1`, [esc.id]);
  const r2 = await e.reservar(esc, esc.caro, { fecha: dia, box: 2, plan: 'sena' });
  assert.deepEqual([r2.total, r2.amount, r2.status], [4, 0, 'confirmada']);
  assert.deepEqual(await e.pagar(esc, esc.caro, r2.id, 'saldo'), { status: 'confirmada', paid: 4, balance: 0 });
});

prueba('una reserva vencida no se puede pagar, se puede cancelar, y el reloj la libera sola', async (e) => {
  const a = await e.armar('lavanda');
  const b = await e.armar('nacar', { nombre: 'Espacio Nácar', duena: 'Inés' });
  const dia = await e.diaHabil(3);
  const r1 = await e.reservar(a, a.lucia, { fecha: dia, box: 1, maquinas: [a.maquinas.laser] });
  const r2 = await e.reservar(a, a.lucia, { fecha: dia, box: 2 });
  const r3 = await e.reservar(b, b.caro, { fecha: dia, box: 1 });
  await e.sql(`update public.reservas set vence_en = now() - interval '1 minute'`);

  // Pagar: no se puede; y como no se llegó a cambiar nada, la reserva sigue esperando al mantenimiento
  await esperarError(e.pagar(a, a.lucia, r1.id, 'sena'), 'pago_vencido');
  assert.equal((await e.uno(`select estado from public.reservas where id = $1`, [r1.id])).estado, 'pago');
  // Cancelar una vencida: queda cancelada sin devolución (faltan menos de 7 días y no había pagado nada)
  assert.deepEqual(await e.llamarComo(a.lucia, 'cancelar_reserva', { p_slug: 'lavanda', p_reserva: r2.id }), { amount: 0, pct: 0, paid: 0, by: 'pro' });

  // El reloj del servidor pasa por todos los consultorios
  assert.equal((await e.uno(`select interno.mantener_todos() as n`)).n, 2);
  const filas = await e.sql(`select id, estado, cancelada_por from public.reservas order by creada_en`);
  assert.deepEqual(filas.map((f) => [f.id, f.estado, f.cancelada_por]),
    [[r1.id, 'cancelada', 'vencida'], [r2.id, 'cancelada', 'pro'], [r3.id, 'cancelada', 'vencida']]);
  assert.equal((await e.uno(`select count(*)::int as n from public.reserva_maquinas where activa`)).n, 0);
  assert.equal((await e.uno(`select count(*)::int as n from public.avisos where asunto = 'Se liberó tu reserva'`)).n, 2);
  // Pasar dos veces no repite avisos
  await e.sql(`select interno.mantener_todos()`);
  assert.equal((await e.uno(`select count(*)::int as n from public.avisos where asunto = 'Se liberó tu reserva'`)).n, 2);
});

prueba('cada versión del reglamento queda guardada', async (e) => {
  const esc = await e.armar();
  const guardar = (texto) => e.llamarComo(esc.admin, 'guardar_reglamento', { p_slug: esc.slug, p_texto: texto });
  await guardar('Dejá el box limpio.\nRespetá el horario.');           // igual al que estaba: no suma versión
  await guardar('Versión dos.');
  await guardar('Versión dos.');
  await guardar('Versión tres.');
  const versiones = await e.sql(`select version, texto from public.reglamentos where consultorio_id = $1 order by version`, [esc.id]);
  assert.deepEqual(versiones, [{ version: 1, texto: 'Dejá el box limpio.\nRespetá el horario.' }, { version: 2, texto: 'Versión dos.' }, { version: 3, texto: 'Versión tres.' }]);
  const r = await e.reservar(esc, esc.lucia, { fecha: await e.diaHabil(3), version: 3 });
  const aceptado = await e.uno(`select g.texto from public.reservas r join public.reglamentos g on g.consultorio_id = r.consultorio_id and g.version = r.reglamento_version where r.id = $1`, [r.id]);
  assert.equal(aceptado.texto, 'Versión tres.');
});

prueba('topes: precios, cantidad de máquinas y totales que entran en un número', async (e) => {
  const esc = await e.armar();
  await esperarError(e.llamarComo(esc.admin, 'guardar_categoria', { p_slug: esc.slug, p_id: null, p_nombre: 'Cara', p_nota: '', p_precio_hora: 10000001 }), 'dato_invalido');
  await esperarError(e.llamarComo(esc.admin, 'guardar_maquina', { p_slug: esc.slug, p_id: null, p_nombre: 'Cara', p_resumen: '', p_precio_hora: 10000001, p_activa: true, p_foto: null }), 'dato_invalido');
  await esperarError(e.llamarComo(esc.admin, 'guardar_box', { p_slug: esc.slug, p_numero: 1, p_nombre: 'Box 1', p_resumen: '', p_equipamiento: '{}', p_precios: JSON.stringify({ [esc.medica]: '10000001' }) }), 'dato_invalido');
  const once = [];
  for (let i = 0; i < 11; i++) {
    once.push((await e.llamarComo(esc.admin, 'guardar_maquina', { p_slug: esc.slug, p_id: null, p_nombre: `Equipo ${i}`, p_resumen: '', p_precio_hora: 10000000, p_activa: true, p_foto: null })).id);
  }
  const dia = await e.diaHabil(3);
  await esperarError(e.reservar(esc, esc.lucia, { fecha: dia, maquinas: once }), 'dato_invalido');
  const r = await e.reservar(esc, esc.lucia, { fecha: dia, maquinas: once.slice(0, 10) });
  assert.equal(r.total, 40000 + 10 * 40000000);
  assert.equal(r.amount, (40000 + 10 * 40000000) / 2);
  // Con números así de grandes, pagar y cancelar siguen dando bien
  assert.equal((await e.pagar(esc, esc.lucia, r.id, 'sena')).paid, 200020000);
  assert.deepEqual(await e.llamarComo(esc.admin, 'cancelar_reserva', { p_slug: esc.slug, p_reserva: r.id }), { amount: 200020000, pct: 100, paid: 200020000, by: 'admin' });
  // Un total que no entra en un número se rechaza antes de guardar nada: un rato libre de 24 horas, todo al precio máximo
  await e.sql(`update public.consultorios set abre = 0, cierra = 24, turno_horas = 12 where id = $1`, [esc.id]);
  await e.sql(`update public.categorias set precio_hora = 10000000`);
  const b = await bloquear(e, esc, { p_fecha: dia, p_boxes: '{2}', p_desde: 0, p_hasta: 24 });
  await e.llamarComo(esc.admin, 'liberar_dia', { p_slug: esc.slug, p_bloqueo: b.id, p_box: 2, p_fecha: dia });
  await esperarError(e.reservar(esc, esc.lucia, { fecha: dia, desde: 0, hasta: 24, maquinas: once.slice(0, 10) }), 'dato_invalido');
  assert.equal((await e.uno(`select count(*)::int as n from public.reservas where estado <> 'cancelada'`)).n, 0);
  assert.equal((await e.reservar(esc, esc.lucia, { fecha: dia, desde: 0, hasta: 24, maquinas: once.slice(0, 7) })).total, 8 * 240000000);
});

prueba('todo lo que cambia la agenda o la configuración pasa por el candado del consultorio', async (e) => {
  const debe = ['reservar', 'bloquear', 'publicar_rato', 'liberar_dia', 'quitar_rato', 'quitar_bloqueo', 'cambiar_estado_profesional',
    'cambiar_categoria_profesional', 'guardar_turnos', 'guardar_pago', 'guardar_politica', 'guardar_reglamento', 'guardar_box',
    'guardar_foto_box', 'guardar_categoria', 'quitar_categoria', 'guardar_maquina', 'quitar_maquina', 'guardar_facturacion',
    'cambiar_datos_fiscales_profesional', 'facturacion_preparar',
    'mp_pago_resultado'];       // acreditar un pago de Mercado Pago: puede confirmar o revivir una reserva (candados: consultorio → reserva → pago)
  const filas = await e.sql(`select proname from pg_proc where pronamespace = 'public'::regnamespace and prosrc like '%interno.candado(%'`);
  assert.deepEqual(filas.map((f) => f.proname).sort(), [...debe].sort());
  const candado = await e.uno(`select prosrc from pg_proc where pronamespace = 'interno'::regnamespace and proname = 'candado'`);
  assert.match(candado.prosrc, /for no key update/);
});
