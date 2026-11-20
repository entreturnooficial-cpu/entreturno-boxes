// La dueña: profesionales y configuración.
import assert from 'node:assert/strict';

import { esperarError, prueba } from './entorno.mjs';

const estado = (e, esc, miembro, nuevo) =>
  e.llamarComo(esc.admin, 'cambiar_estado_profesional', { p_slug: esc.slug, p_miembro: miembro, p_estado: nuevo });

prueba('profesionales: aprobar, rechazar, pausar y habilitar, solo en los pasos que corresponden', async (e) => {
  const esc = await e.armar();
  const martina = await e.miembro(esc, esc.martina);
  const lucia = await e.miembro(esc, esc.lucia);
  const duena = await e.miembro(esc, esc.admin);

  await esperarError(estado(e, esc, martina, 'bloqueado'), 'cambio_invalido');      // pendiente no se pausa
  await esperarError(estado(e, esc, martina, 'pendiente'), 'cambio_invalido');
  await esperarError(estado(e, esc, martina, 'cualquiera'), 'cambio_invalido');
  await esperarError(estado(e, esc, lucia, 'rechazado'), 'cambio_invalido');        // aprobada no se rechaza: se pausa
  await esperarError(estado(e, esc, lucia, 'aprobado'), 'cambio_invalido');
  await esperarError(estado(e, esc, duena, 'bloqueado'), 'profesional_inexistente'); // a la dueña no se la toca desde acá
  await esperarError(estado(e, esc, '00000000-0000-0000-0000-000000000000', 'aprobado'), 'profesional_inexistente');

  assert.equal((await estado(e, esc, martina, 'rechazado')).status, 'rechazado');
  await esperarError(e.reservar(esc, esc.martina, { fecha: await e.diaHabil(3) }), 'no_aprobada');
  await estado(e, esc, martina, 'aprobado');                                         // una rechazada se puede habilitar
  await e.reservar(esc, esc.martina, { fecha: await e.diaHabil(3) });
  await estado(e, esc, martina, 'bloqueado');
  await estado(e, esc, martina, 'aprobado');

  const avisos = await e.sql(`select asunto from public.avisos where miembro_id = $1 order by creado_en`, [martina]);
  assert.deepEqual(avisos.map((a) => a.asunto), ['Recibimos tu solicitud', 'Sobre tu solicitud', '¡Ya podés reservar!', 'Tu acceso está pausado', '¡Ya podés reservar!']);
  // A la dueña le avisaron de cada pedido de acceso
  const aDuena = await e.sql(`select asunto, para from public.avisos where miembro_id = $1 order by creado_en`, [duena]);
  assert.deepEqual(aDuena.map((a) => a.asunto), ['Nueva solicitud de acceso: Lucía Ferrari', 'Nueva solicitud de acceso: Carolina Méndez', 'Nueva solicitud de acceso: Martina Sosa']);
  assert.equal(aDuena[0].para, 'duena-lavanda@prueba.com');
});

prueba('cambiar la categoría de una profesional vale para sus reservas nuevas', async (e) => {
  const esc = await e.armar();
  const caro = await e.miembro(esc, esc.caro);
  const dia = await e.diaHabil(3);
  const antes = await e.reservar(esc, esc.caro, { fecha: dia, box: 1 });
  await esperarError(e.llamarComo(esc.admin, 'cambiar_categoria_profesional', { p_slug: esc.slug, p_miembro: caro, p_categoria: '00000000-0000-0000-0000-000000000000' }), 'categoria_inexistente');
  await esperarError(e.llamarComo(esc.admin, 'cambiar_categoria_profesional', { p_slug: esc.slug, p_miembro: await e.miembro(esc, esc.admin), p_categoria: esc.medica }), 'profesional_inexistente');
  await e.llamarComo(esc.admin, 'cambiar_categoria_profesional', { p_slug: esc.slug, p_miembro: caro, p_categoria: esc.medica });
  const despues = await e.reservar(esc, esc.caro, { fecha: dia, box: 2 });
  assert.deepEqual([antes.total, despues.total], [24000, 40000]);
  const filas = await e.sql(`select categoria_nombre, precio_hora from public.reservas order by creada_en`);
  assert.deepEqual(filas, [{ categoria_nombre: 'Esteticistas', precio_hora: 6000 }, { categoria_nombre: 'Médicas y médicos', precio_hora: 10000 }]);
});

prueba('turnos y horarios: solo se guardan combinaciones que cierran justo', async (e) => {
  const esc = await e.armar();
  const guardar = (args) => e.llamarComo(esc.admin, 'guardar_turnos', { p_slug: esc.slug, p_turno_horas: 4, p_abre: 8, p_cierra: 20, p_dias: '{1,2,3,4,5,6}', ...args });
  await esperarError(guardar({ p_cierra: 8 }), 'horario_invalido');                  // cierra cuando abre
  await esperarError(guardar({ p_abre: 9 }), 'horario_invalido');                    // 11 horas no dan turnos de 4
  await esperarError(guardar({ p_turno_horas: 0 }), 'horario_invalido');
  await esperarError(guardar({ p_cierra: 28, p_abre: 20 }), 'horario_invalido');
  await esperarError(guardar({ p_dias: '{1,9}' }), 'horario_invalido');
  await esperarError(guardar({ p_dias: null }), 'horario_invalido');
  assert.deepEqual(await e.uno(`select turno_horas, abre, cierra from public.consultorios where id = $1`, [esc.id]), { turno_horas: 4, abre: 8, cierra: 20 });

  await guardar({ p_turno_horas: 2, p_abre: 10, p_cierra: 18, p_dias: '{5,1,3,3}' });
  const cfg = (await e.foto(esc, esc.lucia)).config;
  assert.deepEqual([cfg.turnHours, cfg.open, cfg.close, cfg.days], [2, 10, 18, [1, 3, 5]]);
  // La grilla nueva ya manda: turnos de 2 horas, de 10 a 18, lunes, miércoles y viernes
  let dia = await e.fecha(1);
  for (let i = 2; ![1, 3, 5].includes(new Date(`${dia}T12:00:00Z`).getUTCDay()); i++) dia = await e.fecha(i);
  await e.reservar(esc, esc.lucia, { fecha: dia, desde: 10, hasta: 12 });
  await esperarError(e.reservar(esc, esc.lucia, { fecha: dia, desde: 8, hasta: 10 }), 'horario_no_disponible');
  await esperarError(e.reservar(esc, esc.lucia, { fecha: dia, desde: 12, hasta: 16 }), 'horario_no_disponible');
});

prueba('seña, plazo de pago y política de cancelación', async (e) => {
  const esc = await e.armar();
  await esperarError(e.llamarComo(esc.admin, 'guardar_pago', { p_slug: esc.slug, p_sena_pct: 0, p_minutos_pago: 15, p_max_saldos: 2 }), 'dato_invalido');
  await esperarError(e.llamarComo(esc.admin, 'guardar_pago', { p_slug: esc.slug, p_sena_pct: 50, p_minutos_pago: 1, p_max_saldos: 2 }), 'dato_invalido');
  await esperarError(e.llamarComo(esc.admin, 'guardar_pago', { p_slug: esc.slug, p_sena_pct: null, p_minutos_pago: 15, p_max_saldos: 2 }), 'dato_invalido');
  await e.llamarComo(esc.admin, 'guardar_pago', { p_slug: esc.slug, p_sena_pct: 30, p_minutos_pago: 60, p_max_saldos: 2 });
  const politica = { p_slug: esc.slug, p_dias: 3, p_sena_antes: 50, p_sena_despues: 0, p_total_antes: 100, p_total_despues: 25 };
  await esperarError(e.llamarComo(esc.admin, 'guardar_politica', { ...politica, p_total_despues: 120 }), 'dato_invalido');
  await esperarError(e.llamarComo(esc.admin, 'guardar_politica', { ...politica, p_dias: -1 }), 'dato_invalido');
  await e.llamarComo(esc.admin, 'guardar_politica', politica);

  const cfg = (await e.foto(esc, esc.lucia)).config;
  assert.deepEqual([cfg.depositPct, cfg.mpMinutes, cfg.policy], [30, 60, { days: 3, senaBefore: 50, senaAfter: 0, totalBefore: 100, totalAfter: 25 }]);
  // La política nueva se aplica al cancelar: seña con más de 3 días → 50 %
  const r = await e.reservar(esc, esc.lucia, { fecha: await e.diaHabil(5), plan: 'sena' });
  assert.equal(r.amount, 12000);                                                     // 30 % de $ 40.000
  await e.pagar(esc, esc.lucia, r.id, 'sena');
  assert.deepEqual(await e.llamarComo(esc.lucia, 'cancelar_reserva', { p_slug: esc.slug, p_reserva: r.id }), { amount: 6000, pct: 50, paid: 12000, by: 'pro' });
});

prueba('el reglamento sube de versión solo cuando cambia el texto', async (e) => {
  const esc = await e.armar();
  const guardar = (texto) => e.llamarComo(esc.admin, 'guardar_reglamento', { p_slug: esc.slug, p_texto: texto });
  assert.equal((await guardar('Dejá el box limpio.\nRespetá el horario.')).version, 1);    // igual: no cambia
  assert.equal((await guardar('  Dejá el box limpio.\nRespetá el horario.  ')).version, 1);
  assert.equal((await guardar('Dejá el box limpio.')).version, 2);
  assert.equal((await guardar('Dejá el box limpio.')).version, 2);
  await esperarError(guardar('x'.repeat(8001)), 'dato_invalido');
  assert.deepEqual((await e.foto(esc, esc.caro)).config.terms, { version: 2, text: 'Dejá el box limpio.' });
});

prueba('los boxes: nombre, equipamiento y precio propio por categoría', async (e) => {
  const esc = await e.armar();
  const guardar = (args) => e.llamarComo(esc.admin, 'guardar_box', { p_slug: esc.slug, p_numero: 1, p_nombre: 'Box grande', p_resumen: 'Con aparatología',
    p_equipamiento: '{" Camilla eléctrica ","",Lavatorio}', p_precios: JSON.stringify({ [esc.medica]: '15000', [esc.estetica]: '' }), ...args });
  await guardar({});
  let box = (await e.foto(esc, esc.lucia)).boxes[0];
  assert.deepEqual([box.id, box.name, box.short, box.equipment, box.prices, box.photo], [1, 'Box grande', 'Con aparatología', ['Camilla eléctrica', 'Lavatorio'], { [esc.medica]: 15000 }, null]);
  const dia = await e.diaHabil(3);
  assert.equal((await e.reservar(esc, esc.lucia, { fecha: dia, box: 1 })).total, 60000);            // médica en este box: $ 15.000
  assert.equal((await e.reservar(esc, esc.caro, { fecha: dia, box: 1, desde: 12, hasta: 16 })).total, 24000);   // esteticista: el general

  // Vaciar el precio propio vuelve al general; el nombre vacío deja el que estaba
  await guardar({ p_nombre: '', p_precios: '{}' });
  box = (await e.foto(esc, esc.lucia)).boxes[0];
  assert.deepEqual([box.name, box.prices], ['Box grande', {}]);
  await esperarError(guardar({ p_precios: JSON.stringify({ [esc.medica]: '-5' }) }), 'dato_invalido');
  await esperarError(guardar({ p_precios: JSON.stringify({ [esc.medica]: 'mucho' }) }), 'dato_invalido');
  await esperarError(guardar({ p_numero: 7 }), 'box_inexistente');
  await esperarError(guardar({ p_nombre: 'x'.repeat(61) }), 'dato_invalido');
  // El box 3 conserva sus precios propios
  assert.deepEqual((await e.foto(esc, esc.lucia)).boxes[2].prices, { [esc.medica]: 12000, [esc.estetica]: 8000 });

  // La foto: solo una dirección https
  await esperarError(e.llamarComo(esc.admin, 'guardar_foto_box', { p_slug: esc.slug, p_numero: 1, p_foto: 'javascript:alert(1)' }), 'dato_invalido');
  await esperarError(e.llamarComo(esc.admin, 'guardar_foto_box', { p_slug: esc.slug, p_numero: 9, p_foto: null }), 'box_inexistente');
  await e.llamarComo(esc.admin, 'guardar_foto_box', { p_slug: esc.slug, p_numero: 1, p_foto: 'https://ejemplo.com/box1.jpg' });
  assert.equal((await e.foto(esc, esc.caro)).boxes[0].photo, 'https://ejemplo.com/box1.jpg');
  await e.llamarComo(esc.admin, 'guardar_foto_box', { p_slug: esc.slug, p_numero: 1, p_foto: '' });
  assert.equal((await e.foto(esc, esc.caro)).boxes[0].photo, null);
});

prueba('categorías: agregar, editar y quitar solo si nadie la usa y queda otra', async (e) => {
  const esc = await e.armar();
  const guardar = (args) => e.llamarComo(esc.admin, 'guardar_categoria', { p_slug: esc.slug, p_id: null, p_nombre: 'Kinesiólogas', p_nota: 'Sin aparatología', p_precio_hora: 8000, ...args });
  const quitar = (id) => e.llamarComo(esc.admin, 'quitar_categoria', { p_slug: esc.slug, p_id: id });
  await esperarError(guardar({ p_nombre: ' ' }), 'dato_invalido');
  await esperarError(guardar({ p_precio_hora: -1 }), 'dato_invalido');
  await esperarError(guardar({ p_precio_hora: null }), 'dato_invalido');
  const nueva = (await guardar({})).id;
  await guardar({ p_id: esc.estetica, p_nombre: 'Esteticistas y cosmetólogas', p_nota: '', p_precio_hora: 7000 });
  const cats = (await e.foto(esc, esc.lucia)).config.categories;
  assert.deepEqual(cats.map((k) => [k.name, k.pricePerHour]), [['Médicas y médicos', 10000], ['Esteticistas y cosmetólogas', 7000], ['Kinesiólogas', 8000]]);
  // El precio nuevo vale para las reservas nuevas
  assert.equal((await e.reservar(esc, esc.caro, { fecha: await e.diaHabil(3), box: 1 })).total, 28000);

  await esperarError(quitar(esc.estetica), 'categoria_en_uso');                       // la usan Caro y Martina
  await esperarError(quitar('00000000-0000-0000-0000-000000000000'), 'categoria_inexistente');
  await quitar(nueva);
  await esperarError(quitar(nueva), 'categoria_inexistente');
  await esperarError(guardar({ p_id: nueva }), 'categoria_inexistente');              // una quitada no se edita
  assert.equal((await e.foto(esc, esc.lucia)).config.categories.length, 2);
  // Nadie puede pedir acceso con una categoría quitada
  await esperarError(e.llamarComo(await e.crearUsuario(), 'pedir_acceso', { p_slug: esc.slug, p_nombre: 'Ana', p_profesion: 'Kine', p_categoria: nueva, p_telefono: '', p_cuit: '' }), 'categoria_inexistente');

  // Con una sola categoría, no se puede quitar la última
  await e.sql(`update public.miembros set categoria_id = $1 where categoria_id = $2`, [esc.medica, esc.estetica]);
  await quitar(esc.estetica);
  await esperarError(quitar(esc.medica), 'categoria_en_uso');
  await e.pg.exec(`delete from public.reservas; delete from public.avisos; delete from public.miembros where rol = 'pro'`);
  await esperarError(quitar(esc.medica), 'ultima_categoria');
  // Al quitar una categoría se van sus precios propios de los boxes
  assert.deepEqual((await e.sql(`select categoria_id from public.box_precios`)).map((x) => x.categoria_id), [esc.medica]);
});

prueba('máquinas: agregar, editar, pausar y quitar sin tocar las reservas que ya la tenían', async (e) => {
  const esc = await e.armar();
  const guardar = (args) => e.llamarComo(esc.admin, 'guardar_maquina', { p_slug: esc.slug, p_id: null, p_nombre: 'Radiofrecuencia', p_resumen: 'Facial y corporal', p_precio_hora: 12000, p_activa: true, p_foto: null, ...args });
  await esperarError(guardar({ p_nombre: '' }), 'dato_invalido');
  await esperarError(guardar({ p_precio_hora: -3 }), 'dato_invalido');
  await esperarError(guardar({ p_foto: 'http://sin-candado.com/a.jpg' }), 'dato_invalido');
  const nueva = (await guardar({ p_foto: 'https://ejemplo.com/rf.jpg' })).id;
  const dia = await e.diaHabil(3);
  const r = await e.reservar(esc, esc.caro, { fecha: dia, box: 1, maquinas: [nueva] });
  assert.equal(r.total, 24000 + 48000);

  // Pausada: la dueña la sigue viendo, las profesionales no, y no se puede sumar
  await guardar({ p_id: nueva, p_nombre: 'Radiofrecuencia tripolar', p_precio_hora: 13000, p_activa: false });
  assert.equal((await e.foto(esc, esc.lucia)).machines.some((m) => m.id === nueva), false);
  const paraDuena = (await e.foto(esc, esc.admin)).machines.find((m) => m.id === nueva);
  assert.deepEqual([paraDuena.name, paraDuena.pricePerHour, paraDuena.active, paraDuena.photo], ['Radiofrecuencia tripolar', 13000, false, null]);
  await esperarError(e.reservar(esc, esc.lucia, { fecha: dia, box: 2, maquinas: [nueva] }), 'maquina_no_disponible');

  // Quitada: desaparece para todas, pero la reserva que la tenía conserva nombre y precio de ese momento
  await e.llamarComo(esc.admin, 'quitar_maquina', { p_slug: esc.slug, p_id: nueva });
  await esperarError(e.llamarComo(esc.admin, 'quitar_maquina', { p_slug: esc.slug, p_id: nueva }), 'maquina_inexistente');
  await esperarError(guardar({ p_id: nueva }), 'maquina_inexistente');
  assert.equal((await e.foto(esc, esc.admin)).machines.length, 3);
  const mia = (await e.foto(esc, esc.caro)).bookings.find((b) => b.id === r.id);
  assert.deepEqual(mia.machines.map((m) => [m.name, m.rate, m.amount]), [['Radiofrecuencia', 12000, 48000]]);
});

prueba('datos de facturación', async (e) => {
  const esc = await e.armar();
  const guardar = (args) => e.llamarComo(esc.admin, 'guardar_facturacion', { p_slug: esc.slug, p_nombre: 'Laura Benítez', p_cuit: '27-30111222-4', p_condicion: 'Responsable inscripta', p_punto_venta: 3, ...args });
  await esperarError(guardar({ p_condicion: 'Otra cosa' }), 'dato_invalido');
  await esperarError(guardar({ p_punto_venta: 0 }), 'dato_invalido');
  await esperarError(guardar({ p_cuit: '27-ABC' }), 'dato_invalido');
  await guardar({});
  assert.deepEqual((await e.foto(esc, esc.admin)).config.billing, { name: 'Laura Benítez', cuit: '27-30111222-4', cond: 'Responsable inscripta', pos: 3 });
  assert.equal((await e.foto(esc, esc.lucia)).config.billing, null);                  // las profesionales no ven esos datos
});

prueba('el recordatorio del día anterior se deja listo una sola vez', async (e) => {
  const esc = await e.armar();
  await e.sql(`update public.consultorios set abre = 0, cierra = 24, turno_horas = 1, dias = '{0,1,2,3,4,5,6}' where id = $1`, [esc.id]);
  const en = await e.uno(`select ((now() at time zone 'America/Argentina/Buenos_Aires') + interval '3 hours')::date::text as dia,
                                 extract(hour from (now() at time zone 'America/Argentina/Buenos_Aires') + interval '3 hours')::int as hora`);
  if (en.hora === 23) return;        // el turno cruzaría la medianoche: no se prueba a esa hora
  const r = await e.reservar(esc, esc.lucia, { fecha: en.dia, desde: en.hora, hasta: en.hora + 1, plan: 'sena' });
  await e.pagar(esc, esc.lucia, r.id, 'sena');
  await e.foto(esc, esc.admin);
  await e.foto(esc, esc.lucia);
  const avisos = await e.sql(`select asunto, cuerpo from public.avisos where miembro_id = $1 and asunto like 'Recordatorio%'`, [await e.miembro(esc, esc.lucia)]);
  assert.equal(avisos.length, 1);
  assert.equal(avisos[0].asunto, 'Recordatorio: mañana tenés Box 2');
  assert.match(avisos[0].cuerpo, /Te queda pagar el saldo: \$ 5\.000\./);
});

prueba('los textos de los avisos: plata y fechas como en la página', async (e) => {
  await e.armar();
  const t = await e.uno(`select interno.plata(60000) as a, interno.plata(1234567) as b, interno.plata(0) as c, interno.plata(999) as d,
                                interno.dia_largo('2026-11-24') as dia, interno.cap(interno.dia_largo('2026-12-06')) as dom,
                                interno.lunes('2026-11-22')::text as lun, interno.lunes('2026-11-23')::text as lun2,
                                interno.sena(13332, 30) as s1, interno.sena(25, 50) as s2`);
  assert.deepEqual(t, { a: '$ 60.000', b: '$ 1.234.567', c: '$ 0', d: '$ 999', dia: 'martes 24 de noviembre', dom: 'Domingo 6 de diciembre',
    lun: '2026-11-16', lun2: '2026-11-23', s1: 4000, s2: 13 });
});
