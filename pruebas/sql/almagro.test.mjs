// Las reglas que pidió Yani para «Punto Almagro» (25/11/2026): la seña no se devuelve, hasta terminar de pagar un turno no se reserva
// otro, y reprogramar un turno una vez. Todas son opciones del consultorio.
import assert from 'node:assert/strict';

import { esperarError, prueba } from './entorno.mjs';

const reglas = (e, esc, cambios) => e.sql(
  `update public.consultorios set ${Object.keys(cambios).map((k, i) => `${k} = $${i + 2}`).join(', ')} where id = $1`, [esc.id, ...Object.values(cambios)]);
const ALMAGRO = { sena_no_vuelve: true, pol_dias: 7, pol_total_antes: 100, pol_total_despues: 0, max_saldos: 0, repro_max: 1, repro_dias: 3 };
const cancelar = (e, esc, quien, reserva) => e.llamarComo(quien, 'cancelar_reserva', { p_slug: esc.slug, p_reserva: reserva });
const mover = (e, esc, quien, reserva, p_fecha, { box = 2, desde = 8 } = {}) =>
  e.llamarComo(quien, 'reprogramar_reserva', { p_slug: esc.slug, p_reserva: reserva, p_box: box, p_fecha, p_desde: desde });
const reservaDe = (e, id) => e.uno(`select r.*, to_char(r.fecha, 'YYYY-MM-DD') as dia, to_char(r.fecha_original, 'YYYY-MM-DD') as original, b.numero from public.reservas r join public.boxes b on b.id = r.box_id where r.id = $1`, [id]);
const avisosDe = async (e, miembro) => (await e.sql(`select asunto from public.avisos where miembro_id = $1 order by creado_en, id`, [miembro])).map((a) => a.asunto);
/** Como si la reserva fuera para dentro de esos días (o ya hubiera pasado, si es negativo), a la misma hora. */
const aDias = (e, id, dias) => e.sql(`update public.reservas set fecha = (now() at time zone 'America/Argentina/Buenos_Aires')::date + $2::int where id = $1`, [id, dias]);

prueba('con los valores de fábrica todo sigue como estaba: la seña vuelve según la política y no se puede reprogramar', async (e) => {
  const esc = await e.armar();
  const c = (await e.foto(esc, esc.admin)).config.policy;
  assert.deepEqual([c.depositKept, c.moves, c.moveDays], [false, 0, 3]);
  assert.equal((await e.foto(esc, esc.admin)).site.tagline, 'Alquiler de boxes');
  const r = await e.reservar(esc, esc.lucia, { fecha: await e.diaHabil(20) });
  await e.pagar(esc, esc.lucia, r.id, 'sena');
  await esperarError(mover(e, esc, esc.lucia, r.id, await e.diaHabil(22)), 'sin_reprogramacion');
  assert.equal((await cancelar(e, esc, esc.lucia, r.id)).amount, 20000);
});

prueba('la seña no se devuelve: con 7 días o más vuelve lo que pagó de más que la seña; con menos, nada; si cancela la dueña, todo', async (e) => {
  const esc = await e.armar();
  await reglas(e, esc, { ...ALMAGRO, max_saldos: null });
  const caso = async (dias, plan, saldo, quien) => {
    const r = await e.reservar(esc, esc.lucia, { fecha: await e.diaHabil(10), plan });
    await e.pagar(esc, esc.lucia, r.id, plan);
    if (saldo) await e.pagar(esc, esc.lucia, r.id, 'saldo');
    await aDias(e, r.id, dias);
    const c = await cancelar(e, esc, quien ?? esc.lucia, r.id);
    const f = await reservaDe(e, r.id);
    assert.deepEqual([f.devolucion_monto, f.devolucion_pct], [c.amount, c.pct]);
    return [c.amount, c.pct];
  };
  // total 40.000, seña 20.000
  assert.deepEqual(await caso(8, 'sena'), [0, 0]);
  assert.deepEqual(await caso(8, 'total'), [20000, 50]);
  assert.deepEqual(await caso(8, 'sena', true), [20000, 50]);           // señó y después pagó el saldo: vuelve el saldo
  assert.deepEqual(await caso(5, 'total'), [0, 0]);
  assert.deepEqual(await caso(5, 'sena', true), [0, 0]);
  assert.deepEqual(await caso(2, 'sena'), [0, 0]);
  assert.deepEqual(await caso(2, 'total', false, esc.admin), [40000, 100]);
  assert.deepEqual(await caso(8, 'sena', false, esc.admin), [20000, 100]);
  // con otra seña no hay que tocar ningún porcentaje: sigue siendo «todo menos la seña»
  await reglas(e, esc, { sena_pct: 30 });
  assert.deepEqual(await caso(8, 'total'), [28000, 70]);
  // y sin pagar nada, no hay nada que devolver
  const r = await e.reservar(esc, esc.lucia, { fecha: await e.diaHabil(10) });
  assert.deepEqual((({ amount, pct }) => [amount, pct])(await cancelar(e, esc, esc.lucia, r.id)), [0, 0]);
});

prueba('ningún turno señado sin pagar: hasta terminar de pagarlo no reserva otro, ni pagándolo entero', async (e) => {
  const esc = await e.armar();
  await reglas(e, esc, ALMAGRO);
  const dia = await e.diaHabil(10);
  const r = await e.reservar(esc, esc.lucia, { fecha: dia });
  await esperarError(e.reservar(esc, esc.lucia, { fecha: dia, box: 1 }), 'saldo_pendiente');                       // la está por señar
  await e.pagar(esc, esc.lucia, r.id, 'sena');
  await esperarError(e.reservar(esc, esc.lucia, { fecha: dia, box: 1 }), 'saldo_pendiente');
  await esperarError(e.reservar(esc, esc.lucia, { fecha: dia, box: 1, plan: 'total' }), 'saldo_pendiente');
  await e.reservar(esc, esc.caro, { fecha: dia, box: 1 });                                                         // a las demás no las frena
  await e.pagar(esc, esc.lucia, r.id, 'saldo');
  const otra = await e.reservar(esc, esc.lucia, { fecha: dia, box: 3, plan: 'total' });
  await e.pagar(esc, esc.lucia, otra.id, 'total');
  const tercera = await e.reservar(esc, esc.lucia, { fecha: await e.diaHabil(11), box: 3 });                       // al día: puede señar una
  await e.pagar(esc, esc.lucia, tercera.id, 'sena');
  await cancelar(e, esc, esc.lucia, tercera.id);                                                                   // cancelada, ya no cuenta
  await e.reservar(esc, esc.lucia, { fecha: await e.diaHabil(12), box: 3 });
  // la dueña lo puede elegir desde Configuración, y no acepta cualquier número
  await e.llamarComo(esc.admin, 'guardar_pago', { p_slug: esc.slug, p_sena_pct: 50, p_minutos_pago: 15, p_max_saldos: 0 });
  await esperarError(e.llamarComo(esc.admin, 'guardar_pago', { p_slug: esc.slug, p_sena_pct: 50, p_minutos_pago: 15, p_max_saldos: -1 }), 'dato_invalido');
});

prueba('reprogramar: una vez, con lugar y con anticipación; lo pagado sigue valiendo y se enteran las dos', async (e) => {
  const esc = await e.armar();
  await reglas(e, esc, ALMAGRO);
  const [d1, d2, d3] = [await e.diaHabil(8), await e.diaHabil(12), await e.diaHabil(15)];
  const r = await e.reservar(esc, esc.lucia, { fecha: d1 });
  await esperarError(mover(e, esc, esc.lucia, r.id, d2), 'no_se_puede_reprogramar');                               // todavía sin pagar
  await e.pagar(esc, esc.lucia, r.id, 'sena');
  // no se mueve a cualquier lado
  await esperarError(mover(e, esc, esc.lucia, r.id, d1), 'mismo_horario');
  await esperarError(mover(e, esc, esc.lucia, r.id, d2, { desde: 9 }), 'horario_no_disponible');                   // fuera de la grilla
  await esperarError(mover(e, esc, esc.lucia, r.id, d2, { desde: 18 }), 'horario_no_disponible');                  // se pasa del cierre
  await esperarError(mover(e, esc, esc.lucia, r.id, d2, { box: 99 }), 'box_inexistente');
  const esDomingo = async (dias) => new Date(`${await e.fecha(dias)}T12:00:00Z`).getUTCDay() === 0;
  let pasado = -2; while (await esDomingo(pasado)) pasado--;
  await esperarError(mover(e, esc, esc.lucia, r.id, await e.fecha(pasado)), 'horario_no_disponible');              // un día que ya pasó
  let domingo = 5; while (!(await esDomingo(domingo))) domingo++;
  await esperarError(mover(e, esc, esc.lucia, r.id, await e.fecha(domingo)), 'horario_no_disponible');             // un día que no abre
  await esperarError(mover(e, esc, esc.lucia, r.id, await e.diaHabil(120)), 'fuera_de_rango');
  await esperarError(mover(e, esc, esc.lucia, r.id, null), 'horario_no_disponible');
  // donde ya hay otra, o un bloqueo, no
  const deCaro = await e.reservar(esc, esc.caro, { fecha: d2 });
  await esperarError(mover(e, esc, esc.lucia, r.id, d2), 'horario_no_disponible');
  assert.equal((await reservaDe(e, r.id)).dia, d1);
  // ni la de otra persona, ni sin cuenta
  await esperarError(mover(e, esc, esc.caro, r.id, d3), 'reserva_inexistente');
  await esperarError(mover(e, esc, esc.lucia, deCaro.id, d3), 'reserva_inexistente');

  const antes = await e.uno(`select total, monto_sena, plan, estado from public.reservas where id = $1`, [r.id]);
  await e.sql(`update public.reservas set recordada = true where id = $1`, [r.id]);
  assert.deepEqual(await mover(e, esc, esc.lucia, r.id, d2, { desde: 12 }), { id: r.id, date: d2, start: 12, end: 16 });
  const f = await reservaDe(e, r.id);
  assert.deepEqual([f.dia, f.desde, f.hasta, f.numero, f.reprogramada, f.original, f.desde_original, f.recordada], [d2, 12, 16, 2, 1, d1, 8, false]);
  assert.deepEqual(await e.uno(`select total, monto_sena, plan, estado from public.reservas where id = $1`, [r.id]), antes);
  const b = (await e.foto(esc, esc.lucia)).bookings.find((x) => x.id === r.id);
  assert.deepEqual([b.moved, b.original], [1, { date: d1, start: 8 }]);
  assert.equal((await avisosDe(e, await e.miembro(esc, esc.lucia))).filter((a) => a.startsWith('Turno reprogramado: Box 2')).length, 1);
  assert.deepEqual((await avisosDe(e, await e.miembro(esc, esc.admin))).filter((a) => a.startsWith('Turno reprogramado')), ['Turno reprogramado: Lucía Ferrari']);
  // el lugar viejo quedó libre, y el nuevo tomado
  const nueva = await e.reservar(esc, esc.martina ?? esc.caro, { fecha: d1 }).catch((x) => x.message);
  assert.ok(nueva.id || nueva === 'saldo_pendiente' || nueva === 'no_aprobada', JSON.stringify(nueva));
  await e.sql(`update public.consultorios set max_saldos = null where id = $1`, [esc.id]);
  await esperarError(e.reservar(esc, esc.caro, { fecha: d2, desde: 12 }), 'horario_no_disponible');
  // una sola vez (la dueña puede más veces, y no le cuenta a la profesional)
  await esperarError(mover(e, esc, esc.lucia, r.id, d3), 'ya_reprogramada');
  await mover(e, esc, esc.admin, r.id, d3);
  const g = await reservaDe(e, r.id);
  assert.deepEqual([g.dia, g.reprogramada, g.original, g.desde_original], [d3, 1, d1, 8]);
  assert.equal((await e.uno(`select count(*)::int as n from interno.reprogramaciones where reserva_id = $1`, [r.id])).n, 2);
  // sigue pudiendo pagar el saldo
  await e.pagar(esc, esc.lucia, r.id, 'saldo');
  assert.equal((await e.uno(`select interno.pagado($1) as n`, [r.id])).n, antes.total);
});

prueba('reprogramar: ni con menos de 3 días, ni un turno que ya empezó, ni sin haber aceptado el aviso de datos', async (e) => {
  const esc = await e.armar();
  await reglas(e, esc, ALMAGRO);
  const r = await e.reservar(esc, esc.lucia, { fecha: await e.diaHabil(8) });
  await e.pagar(esc, esc.lucia, r.id, 'sena');
  const d = await e.diaHabil(14);
  await aDias(e, r.id, 2);
  await esperarError(mover(e, esc, esc.lucia, r.id, d), 'tarde_para_reprogramar');
  await aDias(e, r.id, -1);
  await esperarError(mover(e, esc, esc.lucia, r.id, d), 'no_se_puede_reprogramar');
  await esperarError(mover(e, esc, esc.admin, r.id, d), 'no_se_puede_reprogramar');
  await aDias(e, r.id, 5);
  const m = await e.miembro(esc, esc.lucia);
  await e.sql(`update interno.consentimientos set version = 1 where miembro_id = $1`, [m]);
  await esperarError(mover(e, esc, esc.lucia, r.id, d), 'privacidad_falta');
  await e.sql(`update interno.consentimientos set version = 2 where miembro_id = $1`, [m]);
  await e.sql(`update public.miembros set estado = 'bloqueado' where id = $1`, [m]);
  await esperarError(mover(e, esc, esc.lucia, r.id, d), 'no_aprobada');
  await e.sql(`update public.miembros set estado = 'aprobado' where id = $1`, [m]);
  await mover(e, esc, esc.lucia, r.id, d);
});

prueba('mover un turno no sirve para esquivar la política: al cancelar, los días se cuentan desde la fecha original', async (e) => {
  const esc = await e.armar();
  await reglas(e, esc, ALMAGRO);
  const r = await e.reservar(esc, esc.lucia, { fecha: await e.diaHabil(8), plan: 'total' });
  await e.pagar(esc, esc.lucia, r.id, 'total');
  await aDias(e, r.id, 5);                                                       // ya no se devuelve, pero todavía se puede mover
  await mover(e, esc, esc.lucia, r.id, await e.diaHabil(20));
  assert.equal((await cancelar(e, esc, esc.lucia, r.id)).amount, 0);
  // si lo movió para antes, manda la fecha nueva
  const s = await e.reservar(esc, esc.lucia, { fecha: await e.diaHabil(20), plan: 'total' });
  await e.pagar(esc, esc.lucia, s.id, 'total');
  await mover(e, esc, esc.lucia, s.id, await e.diaHabil(4));
  assert.equal((await cancelar(e, esc, esc.lucia, s.id)).amount, 0);
  // y con tiempo de sobra en las dos, se devuelve todo menos la seña
  const t = await e.reservar(esc, esc.lucia, { fecha: await e.diaHabil(20), plan: 'total' });
  await e.pagar(esc, esc.lucia, t.id, 'total');
  await mover(e, esc, esc.lucia, t.id, await e.diaHabil(22));
  assert.equal((await cancelar(e, esc, esc.lucia, t.id)).amount, 20000);
});

prueba('reprogramar a otro box: solo si cuesta lo mismo; y las máquinas se mueven con el turno', async (e) => {
  const esc = await e.armar();
  await reglas(e, esc, { ...ALMAGRO, repro_max: 5, max_saldos: null });
  const [d1, d2] = [await e.diaHabil(8), await e.diaHabil(12)];
  const maq = (await e.sql(`select id from public.maquinas where consultorio_id = $1 order by nombre limit 1`, [esc.id]))[0];
  const r = await e.reservar(esc, esc.lucia, { fecha: d1, ...(maq ? { maquinas: [maq.id] } : {}) });
  await e.pagar(esc, esc.lucia, r.id, 'sena');
  const cat = (await reservaDe(e, r.id)).categoria_id;
  const box3 = (await e.uno(`select id from public.boxes where consultorio_id = $1 and numero = 3`, [esc.id])).id;
  await e.sql(`delete from public.box_precios where consultorio_id = $1`, [esc.id]);
  await e.sql(`insert into public.box_precios (consultorio_id, box_id, categoria_id, precio_hora) values ($1, $2, $3, 99999)`, [esc.id, box3, cat]);
  await esperarError(mover(e, esc, esc.lucia, r.id, d2, { box: 3 }), 'otro_precio');
  // aunque hoy los dos cuesten lo mismo entre sí, si aumentaron no se pasa a otro box con el precio viejo (en el mismo, sí)
  await e.sql(`update public.box_precios set precio_hora = 20000`);
  await e.sql(`update public.categorias set precio_hora = 20000 where id = $1`, [cat]);
  await esperarError(mover(e, esc, esc.lucia, r.id, d2, { box: 3 }), 'otro_precio');
  await mover(e, esc, esc.lucia, r.id, d2);
  await mover(e, esc, esc.lucia, r.id, d1);
  await e.sql(`update public.categorias set precio_hora = 10000 where id = $1`, [cat]);
  await e.sql(`update public.box_precios set precio_hora = (select precio_hora from public.categorias where id = $1)`, [cat]);
  await mover(e, esc, esc.lucia, r.id, d2, { box: 3 });
  const f = await reservaDe(e, r.id);
  assert.deepEqual([f.dia, f.numero], [d2, 3]);
  if (maq) {
    assert.deepEqual(await e.uno(`select to_char(fecha, 'YYYY-MM-DD') as dia, desde, hasta from public.reserva_maquinas where reserva_id = $1`, [r.id]), { dia: d2, desde: 8, hasta: 12 });
    // si la máquina ya la tiene otra en ese horario, no se mueve nada
    const otra = await e.reservar(esc, esc.caro, { fecha: d1, box: 1, maquinas: [maq.id] });
    assert.ok(otra.id);
    await esperarError(mover(e, esc, esc.lucia, r.id, d1, { box: 3 }), 'maquina_no_disponible');
    assert.equal((await reservaDe(e, r.id)).dia, d2);
  }
});

prueba('reprogramar adentro de un rato libre: el lugar que deja la misma reserva no cuenta como tomado', async (e) => {
  const esc = await e.armar();
  await reglas(e, esc, { ...ALMAGRO, repro_max: 5, max_saldos: null });
  const [d1, d2] = [await e.diaHabil(8), await e.diaHabil(12)];
  // el día 2, el box 1 está bloqueado de 8 a 20 y la dueña publicó de 8 a 16: se reserva entero (8 h) o el pedazo que quede
  await e.llamarComo(esc.admin, 'bloquear', { p_slug: esc.slug, p_boxes: '{1}', p_fecha: d2, p_desde: 8, p_hasta: 20, p_semanal: false, p_nota: '' });
  await e.llamarComo(esc.admin, 'publicar_rato', { p_slug: esc.slug, p_box: 1, p_fecha: d2, p_desde: 8, p_hasta: 16 });
  const r = await e.reservar(esc, esc.lucia, { fecha: d1 });
  await e.pagar(esc, esc.lucia, r.id, 'sena');
  const al = (desde) => mover(e, esc, esc.lucia, r.id, d2, { box: 1, desde });
  await esperarError(al(8), 'horario_no_disponible');                                                           // medio rato no
  await esperarError(al(16), 'horario_no_disponible');                                                          // bloqueado
  // con otra reserva adentro del rato, el pedazo que queda sí; cuando la otra se va, no puede moverse adentro apoyándose en su propio lugar
  const enElRato = async (desde) => {
    const x = await e.reservar(esc, esc.caro, { fecha: d1, box: 3 });
    await e.sql(`update public.reservas set fecha = $2::date, desde = $4, hasta = $4 + 4, box_id = (select id from public.boxes where consultorio_id = $3 and numero = 1) where id = $1`,
      [x.id, d2, esc.id, desde]);
    return x.id;
  };
  let otra = await enElRato(8);
  await al(12);
  await cancelar(e, esc, esc.caro, otra);
  await esperarError(al(8), 'horario_no_disponible');
  await mover(e, esc, esc.lucia, r.id, d1);
  otra = await enElRato(12);
  await al(8);
  await cancelar(e, esc, esc.caro, otra);
  await esperarError(al(12), 'horario_no_disponible');
});

prueba('quién puede cambiar las reglas, y hasta dónde; se guarda todo o nada', async (e) => {
  const esc = await e.armar();
  const guardar = (quien, extra, p_dias = 7) => e.llamarComo(quien, 'guardar_politica', { p_slug: esc.slug, p_dias, p_sena_antes: 0, p_sena_despues: 0, p_total_antes: 100, p_total_despues: 0, ...extra });
  const politica = async () => (await e.foto(esc, esc.lucia)).config.policy;
  await esperarError(guardar(esc.lucia, { p_repro_max: 1 }), 'solo_admin');
  const antes = await politica();
  for (const [max, dias] of [[-1, 3], [6, 3], [1, -1], [1, 61]]) await esperarError(guardar(esc.admin, { p_sena_no_vuelve: true, p_repro_max: max, p_repro_dias: dias }), 'dato_invalido');
  assert.deepEqual(await politica(), antes);                                    // no quedó nada a medias
  await guardar(esc.admin, { p_sena_no_vuelve: true, p_repro_max: 1, p_repro_dias: 3 });
  assert.deepEqual(await politica(), { days: 7, senaBefore: 0, senaAfter: 0, totalBefore: 100, totalAfter: 0, depositKept: true, moves: 1, moveDays: 3 });
  await guardar(esc.admin, {}, 5);                                              // la página anterior no manda las tres nuevas: quedan como están
  assert.deepEqual(await politica(), { days: 5, senaBefore: 0, senaAfter: 0, totalBefore: 100, totalAfter: 0, depositKept: true, moves: 1, moveDays: 3 });
  await assert.rejects(e.sql(`update public.consultorios set lema = '   ' where id = $1`, [esc.id]), /check/);
});

prueba('con varios cambios, cuenta la fecha más temprana que tuvo; y los de la dueña no perjudican a la profesional', async (e) => {
  const esc = await e.armar();
  await reglas(e, esc, { ...ALMAGRO, repro_max: 3 });
  const nueva = async (dias) => { const r = await e.reservar(esc, esc.lucia, { fecha: await e.diaHabil(dias), plan: 'total' }); await e.pagar(esc, esc.lucia, r.id, 'total'); return r.id; };
  const a = await nueva(20);
  await mover(e, esc, esc.lucia, a, await e.diaHabil(4));
  await mover(e, esc, esc.lucia, a, await e.diaHabil(22));
  await mover(e, esc, esc.lucia, a, await e.diaHabil(24));
  const f = (await e.foto(esc, esc.lucia)).bookings.find((x) => x.id === a);
  assert.ok(f.policyFrom && f.policyFrom < Date.now() + 6 * 864e5);
  assert.equal((await cancelar(e, esc, esc.lucia, a)).amount, 0);
  const b = await nueva(20);
  await mover(e, esc, esc.admin, b, await e.diaHabil(4));
  await mover(e, esc, esc.admin, b, await e.diaHabil(22));
  assert.equal((await cancelar(e, esc, esc.lucia, b)).amount, 20000);
});

prueba('cambiar de dirección: la vieja sigue andando y dice cuál es la nueva', async (e) => {
  const esc = await e.armar('yanina');
  await e.sql(`update public.consultorios set slug = 'puntoalmagro', slugs_viejos = '{yanina}' where id = $1`, [esc.id]);
  const portada = (slug) => e.comoRol('anon', null, (c) => c.llamar('portada', { p_slug: slug }));
  for (const slug of ['puntoalmagro', 'yanina', ' Yanina ']) assert.equal((await portada(slug)).site.slug, 'puntoalmagro', slug);
  await esperarError(portada('otra'), 'consultorio_inexistente');
  await esperarError(portada(''), 'consultorio_inexistente');
  assert.equal((await e.llamarComo(esc.lucia, 'foto', { p_slug: 'yanina' })).site.slug, 'puntoalmagro');
  // si otro consultorio toma la dirección vieja, gana el que la usa hoy
  const otro = await e.uno(`insert into public.consultorios (slug, nombre, duena, letras, reglamento) values ('yanina', 'Otro', 'Otra', 'OO', 'x') returning id`);
  assert.equal((await portada('yanina')).site.slug, 'yanina');
  assert.equal((await portada('puntoalmagro')).site.slug, 'puntoalmagro');
  await e.sql(`update public.consultorios set activo = false where id = $1`, [otro.id]);
  assert.equal((await portada('yanina')).site.slug, 'puntoalmagro');
  // si la tuvieron dos, no se adivina
  const tercero = await e.uno(`insert into public.consultorios (slug, nombre, duena, letras, reglamento, slugs_viejos) values ('tercero', 'Tercero', 'Otra', 'TT', 'x', '{yanina}') returning id`);
  await esperarError(portada('yanina'), 'consultorio_inexistente');
  await e.sql(`update public.consultorios set activo = false where id = $1`, [tercero.id]);
  assert.equal((await portada('yanina')).site.slug, 'puntoalmagro');
  for (const mal of ['{puntoalmagro}', '{yanina,""}', '{a,b,c,d,e,f}']) await assert.rejects(e.sql(`update public.consultorios set slugs_viejos = $2 where id = $1`, [esc.id, mal]), /check/, mal);
  // y si se da de baja, no atiende ni por la nueva ni por la vieja
  await e.sql(`update public.consultorios set activo = false where id = $1`, [esc.id]);
  for (const slug of ['yanina', 'puntoalmagro']) await esperarError(portada(slug), 'consultorio_inexistente');
});
