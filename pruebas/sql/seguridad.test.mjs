// Seguridad: qué puede ver y hacer cada quien.
import assert from 'node:assert/strict';

import { FUNCIONES_CON_SESION, FUNCIONES_SIN_SESION, esperarError, esperarSinPermiso, prueba } from './entorno.mjs';

const TABLAS = ['consultorios', 'reglamentos', 'categorias', 'boxes', 'box_precios', 'maquinas', 'miembros', 'bloqueos', 'bloqueo_boxes',
  'ratos_libres', 'reservas', 'reserva_maquinas', 'pagos', 'facturas', 'avisos'];

prueba('desde la página no se puede leer ni escribir ninguna tabla', async (e) => {
  const esc = await e.armar();
  for (const t of TABLAS) {
    await esperarSinPermiso(e.comoAnon((c) => c.sql(`select * from public.${t} limit 1`)));
    await esperarSinPermiso(e.comoUsuario(esc.lucia, (c) => c.sql(`select * from public.${t} limit 1`)));
    await esperarSinPermiso(e.comoUsuario(esc.admin, (c) => c.sql(`delete from public.${t}`)));
  }
  const rls = await e.sql(`select relname from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and not relrowsecurity`);
  assert.deepEqual(rls, [], 'hay tablas sin el candado de RLS');
  const tablas = await e.sql(`select tablename from pg_tables where schemaname = 'public' order by 1`);
  assert.deepEqual(tablas.map((t) => t.tablename), [...TABLAS].sort());
});

prueba('la página solo puede ejecutar las funciones de la lista', async (e) => {
  const filas = await e.sql(`
    select n.nspname as esquema, p.proname as nombre,
           has_function_privilege('anon', p.oid, 'execute') as sin_sesion,
           has_function_privilege('authenticated', p.oid, 'execute') as con_sesion
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('public', 'interno')`);
  const nombres = (clave) => filas.filter((f) => f[clave]).map((f) => `${f.esquema}.${f.nombre}`).sort();
  assert.deepEqual(nombres('sin_sesion'), FUNCIONES_SIN_SESION.map((n) => `public.${n}`).sort());
  assert.deepEqual(nombres('con_sesion'), FUNCIONES_CON_SESION.map((n) => `public.${n}`).sort());
  const esquema = await e.uno(`select has_schema_privilege('anon', 'interno', 'usage') as a, has_schema_privilege('authenticated', 'interno', 'usage') as b`);
  assert.deepEqual(esquema, { a: false, b: false });
  // Todas las funciones corren con el camino de búsqueda fijo
  const sinCamino = await e.sql(`
    select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('public', 'interno') and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) as x where x like 'search_path=%')`);
  assert.deepEqual(sinCamino, [], 'hay funciones sin search_path fijo');
});

prueba('sin sesión solo se ve la portada', async (e) => {
  await e.armar();
  const p = await e.comoAnon((c) => c.llamar('portada', { p_slug: 'lavanda' }));
  assert.equal(p.site.name, 'Consultorio Lavanda');
  assert.equal(p.site.owner, 'Laura');
  assert.equal(p.boxCount, 3);
  assert.deepEqual(p.config.categories.map((k) => [k.name, k.pricePerHour]), [['Médicas y médicos', 10000], ['Esteticistas', 6000]]);
  assert.equal(p.config.turnHours, 4);
  assert.equal(p.config.depositPct, 50);
  await esperarError(e.comoAnon((c) => c.llamar('portada', { p_slug: 'no-existe' })), 'consultorio_inexistente');
  await esperarError(e.comoAnon((c) => c.llamar('portada', { p_slug: null })), 'consultorio_inexistente');
  for (const fn of FUNCIONES_CON_SESION.filter((n) => !FUNCIONES_SIN_SESION.includes(n))) {
    const r = await e.uno(`select has_function_privilege('anon', p.oid, 'execute') as puede from pg_proc p where p.proname = $1 and p.pronamespace = 'public'::regnamespace`, [fn]);
    assert.equal(r.puede, false, `sin sesión no se tendría que poder llamar ${fn}`);
  }
  await esperarSinPermiso(e.comoAnon((c) => c.llamar('foto', { p_slug: 'lavanda' })));
});

prueba('un consultorio apagado deja de existir para la página', async (e) => {
  const esc = await e.armar();
  await e.sql(`update public.consultorios set activo = false where id = $1`, [esc.id]);
  await esperarError(e.comoAnon((c) => c.llamar('portada', { p_slug: 'lavanda' })), 'consultorio_inexistente');
  await esperarError(e.foto(esc, esc.admin), 'consultorio_inexistente');
});

prueba('quien no es la dueña no puede usar ninguna función de la dueña', async (e) => {
  const esc = await e.armar();
  const otro = await e.armar('nacar', { nombre: 'Espacio Nácar', duena: 'Inés' });
  const dia = await e.diaHabil(3);
  const martina = await e.miembro(esc, esc.martina);
  const ninguno = '00000000-0000-0000-0000-000000000000';
  const llamadas = [
    ['bloquear', { p_slug: 'lavanda', p_boxes: '{1}', p_fecha: dia, p_desde: 8, p_hasta: 12, p_semanal: false, p_nota: 'x' }],
    ['publicar_rato', { p_slug: 'lavanda', p_box: 1, p_fecha: dia, p_desde: 8, p_hasta: 10 }],
    ['liberar_dia', { p_slug: 'lavanda', p_bloqueo: ninguno, p_box: 1, p_fecha: dia }],
    ['quitar_rato', { p_slug: 'lavanda', p_rato: ninguno }],
    ['quitar_bloqueo', { p_slug: 'lavanda', p_bloqueo: ninguno }],
    ['cambiar_estado_profesional', { p_slug: 'lavanda', p_miembro: martina, p_estado: 'aprobado' }],
    ['cambiar_categoria_profesional', { p_slug: 'lavanda', p_miembro: martina, p_categoria: esc.medica }],
    ['guardar_turnos', { p_slug: 'lavanda', p_turno_horas: 2, p_abre: 8, p_cierra: 20, p_dias: '{1,2,3}' }],
    ['guardar_pago', { p_slug: 'lavanda', p_sena_pct: 30, p_minutos_pago: 30, p_max_saldos: 2 }],
    ['guardar_politica', { p_slug: 'lavanda', p_dias: 3, p_sena_antes: 100, p_sena_despues: 0, p_total_antes: 100, p_total_despues: 0 }],
    ['guardar_reglamento', { p_slug: 'lavanda', p_texto: 'Otro reglamento' }],
    ['guardar_box', { p_slug: 'lavanda', p_numero: 1, p_nombre: 'Mío', p_resumen: '', p_equipamiento: '{}', p_precios: '{}' }],
    ['guardar_foto_box', { p_slug: 'lavanda', p_numero: 1, p_foto: null }],
    ['guardar_categoria', { p_slug: 'lavanda', p_id: null, p_nombre: 'Gratis', p_nota: '', p_precio_hora: 0 }],
    ['quitar_categoria', { p_slug: 'lavanda', p_id: esc.estetica }],
    ['guardar_maquina', { p_slug: 'lavanda', p_id: null, p_nombre: 'Mía', p_resumen: '', p_precio_hora: 1, p_activa: true, p_foto: null }],
    ['quitar_maquina', { p_slug: 'lavanda', p_id: esc.maquinas.laser }],
    ['guardar_facturacion', { p_slug: 'lavanda', p_nombre: 'Yo', p_cuit: '20-1-1', p_condicion: 'Monotributo', p_punto_venta: 1 }],
  ];
  // Todas las funciones con sesión que no son de uso general tienen que estar en la lista de arriba
  const generales = ['portada', 'foto', 'pedir_acceso', 'reservar', 'simular_pago', 'cancelar_reserva'];
  assert.deepEqual(llamadas.map((l) => l[0]).sort(), FUNCIONES_CON_SESION.filter((n) => !generales.includes(n)).sort());

  const antes = JSON.stringify(await e.foto(esc, esc.admin));
  const sinMiembro = await e.crearUsuario();
  for (const [fn, args] of llamadas) {
    for (const [quien, id] of [['una profesional aprobada', esc.lucia], ['una pendiente', esc.martina], ['la dueña de otro consultorio', otro.admin],
      ['una cuenta sin acceso', sinMiembro]]) {
      await assert.rejects(e.llamarComo(id, fn, args), (err) => {
        assert.equal(err.message, 'solo_admin', `${fn} como ${quien}: vino ${err.message}`);
        return true;
      });
    }
  }
  const despues = JSON.stringify(await e.foto(esc, esc.admin));
  const sinReloj = (t) => t.replace(/"now": ?\d+/, '');
  assert.equal(sinReloj(despues), sinReloj(antes), 'algo cambió aunque todas las llamadas tenían que fallar');
});

prueba('lo de un consultorio no se ve ni se toca desde otro', async (e) => {
  const a = await e.armar('lavanda');
  const b = await e.armar('nacar', { nombre: 'Espacio Nácar', duena: 'Inés' });
  const dia = await e.diaHabil(3);
  const r = await e.reservar(a, a.lucia, { fecha: dia });
  await e.pagar(a, a.lucia, r.id, 'sena');
  const bloqueo = await e.llamarComo(a.admin, 'bloquear', { p_slug: 'lavanda', p_boxes: '{1}', p_fecha: dia, p_desde: 8, p_hasta: 16, p_semanal: false, p_nota: 'Atiendo yo' });

  // Lucía tiene cuenta, pero en Nácar no es nadie: ve la portada y nada más
  const f = await e.foto(b, a.lucia);
  assert.equal(f.me, null);
  assert.equal(f.bookings, undefined);
  assert.equal(f.users, undefined);
  assert.equal(f.site.name, 'Espacio Nácar');
  await esperarError(e.reservar(b, a.lucia, { fecha: dia }), 'no_aprobada');

  // La dueña de Nácar no llega a nada de Lavanda, ni nombrando Lavanda ni usando los números de Lavanda en Nácar
  await esperarError(e.llamarComo(b.admin, 'cancelar_reserva', { p_slug: 'lavanda', p_reserva: r.id }), 'reserva_inexistente');
  await esperarError(e.llamarComo(b.admin, 'cancelar_reserva', { p_slug: 'nacar', p_reserva: r.id }), 'reserva_inexistente');
  await esperarError(e.llamarComo(b.admin, 'quitar_bloqueo', { p_slug: 'nacar', p_bloqueo: bloqueo.id }), 'bloqueo_inexistente');
  await esperarError(e.llamarComo(b.admin, 'cambiar_estado_profesional', { p_slug: 'nacar', p_miembro: await e.miembro(a, a.martina), p_estado: 'aprobado' }), 'profesional_inexistente');
  await esperarError(e.llamarComo(b.admin, 'cambiar_categoria_profesional', { p_slug: 'nacar', p_miembro: await e.miembro(b, b.lucia), p_categoria: a.medica }), 'categoria_inexistente');
  await esperarError(e.llamarComo(b.admin, 'quitar_maquina', { p_slug: 'nacar', p_id: a.maquinas.laser }), 'maquina_inexistente');
  await esperarError(e.llamarComo(b.admin, 'guardar_categoria', { p_slug: 'nacar', p_id: a.medica, p_nombre: 'X', p_nota: '', p_precio_hora: 1 }), 'categoria_inexistente');
  // Una profesional de Nácar no puede sumar a su reserva una máquina de Lavanda
  await esperarError(e.reservar(b, b.lucia, { fecha: dia, maquinas: [a.maquinas.laser] }), 'maquina_no_disponible');

  // La foto de Nácar no trae nada de Lavanda
  const fb = JSON.stringify(await e.foto(b, b.admin));
  assert.ok(!fb.includes(r.id) && !fb.includes(a.id) && !fb.includes('Lavanda'));
  assert.equal((await e.foto(b, b.admin)).bookings.length, 0);
  assert.equal((await e.foto(a, a.admin)).bookings.length, 1);
});

prueba('pedir acceso: una vez por consultorio, con categoría de ese consultorio y datos válidos', async (e) => {
  const a = await e.armar('lavanda');
  const b = await e.armar('nacar', { nombre: 'Espacio Nácar', duena: 'Inés' });
  const nueva = await e.crearUsuario('nueva@prueba.com');
  const pedido = { p_slug: 'lavanda', p_nombre: '  Ana Paz ', p_profesion: 'Kinesióloga', p_categoria: a.estetica, p_telefono: '', p_cuit: '' };
  await esperarError(e.llamarComo(nueva, 'pedir_acceso', { ...pedido, p_categoria: b.estetica }), 'categoria_inexistente');
  await esperarError(e.llamarComo(nueva, 'pedir_acceso', { ...pedido, p_nombre: '   ' }), 'dato_invalido');
  await esperarError(e.llamarComo(nueva, 'pedir_acceso', { ...pedido, p_profesion: '' }), 'dato_invalido');
  await esperarError(e.llamarComo(nueva, 'pedir_acceso', { ...pedido, p_nombre: 'x'.repeat(81) }), 'dato_invalido');
  await esperarError(e.llamarComo(nueva, 'pedir_acceso', { ...pedido, p_cuit: '27-ABC' }), 'cuit_invalido');
  const r = await e.llamarComo(nueva, 'pedir_acceso', pedido);
  assert.equal(r.status, 'pendiente');
  await esperarError(e.llamarComo(nueva, 'pedir_acceso', pedido), 'ya_sos_miembro');

  const m = await e.uno(`select nombre, rol, estado, email, categoria_id from public.miembros where id = $1`, [r.id]);
  assert.deepEqual(m, { nombre: 'Ana Paz', rol: 'pro', estado: 'pendiente', email: 'nueva@prueba.com', categoria_id: a.estetica });
  // Nadie se puede anotar como dueña: el rol no viene de la página
  assert.equal((await e.uno(`select count(*)::int as n from public.miembros where consultorio_id = $1 and rol = 'admin'`, [a.id])).n, 1);

  // Una pendiente ve su solicitud, los boxes y las máquinas, pero no la agenda ni a las demás
  const f = await e.foto(a, nueva);
  assert.equal(f.me, r.id);
  assert.deepEqual(f.users.map((u) => [u.name, u.status]), [['Ana Paz', 'pendiente']]);
  assert.equal(f.boxes.length, 3);
  assert.equal(f.boxCount, undefined);
  assert.equal(f.machines.length, 2);
  assert.deepEqual([f.bookings, f.blocks, f.releases], [[], [], []]);
  assert.equal(f.config.billing, null);
  // La misma cuenta puede pedir acceso en otro consultorio
  assert.equal((await e.llamarComo(nueva, 'pedir_acceso', { ...pedido, p_slug: 'nacar', p_categoria: b.estetica })).status, 'pendiente');
});
