// El cobro real con Mercado Pago, visto desde la base: conectar la cuenta, pagar, los pagos que llegan tarde o repetidos,
// las devoluciones y el reloj. Acá no hay Mercado Pago: se llama a la base como lo hace la función de Supabase «mp».
import assert from 'node:assert/strict';

import { FUNCIONES_DE_SERVICIO, esperarError, esperarSinPermiso, prueba } from './entorno.mjs';

const servicio = (e, fn, args = {}) => e.comoRol('service_role', null, (c) => c.llamar(fn, args));
const cancelar = (e, esc, quien, reserva) => e.llamarComo(quien, 'cancelar_reserva', { p_slug: esc.slug, p_reserva: reserva });
const preparar = (e, esc, quien, reserva, tipo) => e.llamarComo(quien, 'mp_pago_preparar', { p_slug: esc.slug, p_reserva: reserva, p_tipo: tipo });
const ENLACE = (orden) => `https://www.mercadopago.com.ar/checkout/v1/redirect?order_id=${orden}`;
const CUENTA = '1858095454';       // la cuenta de Mercado Pago que cobra en estas pruebas
const anotarOrden = (e, pago, orden, cuenta = CUENTA) => servicio(e, 'mp_pago_orden', { p_pago: pago, p_orden: orden, p_enlace: ENLACE(orden), p_cuenta: cuenta });
const resultado = (e, pago, orden, estado, extra = {}) => servicio(e, 'mp_pago_resultado', {
  p_pago: pago, p_orden: orden, p_estado: estado, p_detalle: null, p_pagado: null, p_transaccion: null, p_cuenta: CUENTA, ...extra });
const avisosDe = async (e, miembro) => (await e.sql(`select asunto from public.avisos where miembro_id = $1 order by creado_en, id`, [miembro])).map((a) => a.asunto);

let cuenta = 0;
let modo = 'real';                  // el del consultorio de la prueba (lo cambia conMercadoPago): las órdenes de prueba se numeran ORDTST…
const ordenNueva = () => `${modo === 'prueba' ? 'ORDTST01' : 'ORD01'}${String(++cuenta).padStart(20, '0')}`;

async function conMercadoPago(e, esc, ambiente = 'real') {
  modo = ambiente;
  await e.sql(`update public.consultorios set pagos_modo = 'mercadopago', mp_ambiente = $2 where id = $1`, [esc.id, ambiente]);
}

/** La dueña conecta su cuenta, como lo hace la función: iniciar → tomar → guardar → (la dueña) confirmar. */
async function conectar(e, esc, { confirmar = true, userId = CUENTA, ambiente } = {}) {
  const estado = `estado-${esc.slug}-${'x'.repeat(40)}-${++cuenta}`;
  const ini = await e.llamarComo(esc.admin, 'mp_conexion_iniciar', {
    p_slug: esc.slug, p_estado: estado, p_verificador: 'v'.repeat(64), p_volver_a: `https://${esc.slug}.entreturno.com.ar/` });
  const t = await servicio(e, 'mp_conexion_tomar', { p_estado: estado });
  const guardada = await servicio(e, 'mp_cuenta_guardar', {
    p_consultorio: t.consultorio, p_ambiente: ambiente ?? t.ambiente, p_user_id: userId, p_acceso: `APP_USR-acceso-${esc.slug}`,
    p_renovar: `TG-renovar-${esc.slug}`, p_segundos: 15552000, p_nombre: 'LAURALAVANDA', p_email: 'laura@lavanda.prueba', p_miembro: t.miembro });
  // una cuenta nueva hay que confirmarla; la misma de antes, reconectada, ya sirve
  if (confirmar && guardada.estado === 'por_confirmar') await e.llamarComo(esc.admin, 'mp_conexion_confirmar', { p_slug: esc.slug, p_user_id: userId });
  return { estado, ini, tomado: t, guardada };
}

/** Un pago entero por Mercado Pago: la profesional lo pide, se crea la orden y Mercado Pago lo aprueba. */
async function pagarMp(e, esc, quien, reserva, tipo) {
  const p = await preparar(e, esc, quien, reserva, tipo);
  const orden = ordenNueva();
  await anotarOrden(e, p.pago, orden);
  const r = await resultado(e, p.pago, orden, 'processed', { p_pagado: p.monto, p_transaccion: `PAY${orden.slice(3)}` });
  return { ...p, orden, resultado: r };
}

async function vencer(e, esc, reserva) {
  await e.sql(`update public.reservas set vence_en = now() - interval '1 minute' where id = $1`, [reserva]);
  await e.sql(`select interno.mantener($1)`, [esc.id]);
}

prueba('las funciones de Mercado Pago que usa la función de Supabase no se pueden llamar desde la página', async (e) => {
  const esc = await e.armar();
  const ninguno = '00000000-0000-0000-0000-000000000000';
  const ejemplo = {
    mp_conexion_tomar: { p_estado: 'x'.repeat(43) },
    mp_cuenta_guardar: { p_consultorio: esc.id, p_ambiente: 'real', p_user_id: '1', p_acceso: 'a', p_renovar: 'r', p_segundos: 60, p_nombre: '', p_email: '', p_miembro: null },
    mp_credencial: { p_consultorio: esc.id },
    mp_cuenta_renovada: { p_consultorio: esc.id, p_acceso: 'a', p_renovar: 'r', p_segundos: 60 },
    mp_cuenta_reintento: { p_consultorio: esc.id, p_error: 'x' },
    mp_cuenta_caida: { p_consultorio: esc.id, p_user_id: null, p_motivo: 'x' },
    mp_cuentas_de: { p_user_id: '1' },
    mp_pago_orden: { p_pago: ninguno, p_orden: 'ORD0000001', p_enlace: 'https://x/', p_cuenta: '1' },
    mp_pago_fallo: { p_pago: ninguno, p_error: 'x', p_definitivo: true },
    mp_pago_ubicar: { p_orden: 'ORD0000001', p_referencia: ninguno },
    mp_pago_resultado: { p_pago: ninguno, p_orden: 'ORD0000001', p_estado: 'processed', p_detalle: null, p_pagado: 1, p_transaccion: 'PAY1' },
    mp_pago_cerrado: { p_pago: ninguno },
    mp_pago_sin_comprobar: { p_pago: ninguno, p_pagada: true },
    mp_devolucion_tomar: { p_devolucion: ninguno },
    mp_devolucion_parte: { p_devolucion: ninguno, p_n: 1, p_hecha: true, p_referencia: 'r', p_error: null },
    mp_sobrante_tomar: { p_pago: ninguno },
    mp_sobrante_resultado: { p_pago: ninguno, p_hecha: true, p_error: null },
    mp_pendientes: {},
    mp_reloj_clave: { p_clave: 'x'.repeat(40) },
  };
  assert.deepEqual(Object.keys(ejemplo).sort(), FUNCIONES_DE_SERVICIO.filter((n) => n.startsWith('mp_')).sort());
  for (const [fn, args] of Object.entries(ejemplo)) {
    await esperarSinPermiso(e.llamarComo(esc.admin, fn, args));
    await esperarSinPermiso(e.llamarComo(esc.lucia, fn, args));
    await esperarSinPermiso(e.comoAnon((c) => c.llamar(fn, args)));
  }
  // y las tablas donde vive la cuenta no se leen ni como dueña
  for (const t of ['mp_cuentas', 'mp_estados', 'ajustes']) await esperarSinPermiso(e.comoUsuario(esc.admin, (c) => c.sql(`select * from interno.${t}`)));
});

prueba('conectar la cuenta: la inicia la dueña, el código sirve una vez, los pases van al Vault y hay que confirmarla', async (e) => {
  const esc = await e.armar();
  await conMercadoPago(e, esc, 'real');
  // sin cuenta, en real, todavía no se puede cobrar
  assert.deepEqual((await e.foto(esc, esc.lucia)).site.mp, { env: 'real', ready: false });
  assert.deepEqual((await e.foto(esc, esc.admin)).config.mp, { mode: 'mercadopago', env: 'real', account: null });
  assert.equal((await e.foto(esc, esc.lucia)).config.mp, null);          // lo de la cuenta lo ve solo la dueña

  await esperarError(e.llamarComo(esc.admin, 'mp_conexion_iniciar', { p_slug: esc.slug, p_estado: 'corto', p_verificador: 'v'.repeat(64), p_volver_a: 'https://lavanda.entreturno.com.ar/' }), 'dato_invalido');
  // la vuelta solo puede ser a una página de Entreturno (si no, serviría para mandar gente a cualquier sitio)
  for (const destino of ['https://malo.com/camino?x=1', 'https://malo.com/', 'https://entreturno.com.ar.malo.com/', 'https://lavanda.entreturno.com.ar/otra', 'javascript:alert(1)//']) {
    await esperarError(e.llamarComo(esc.admin, 'mp_conexion_iniciar', { p_slug: esc.slug, p_estado: 'e'.repeat(43), p_verificador: 'v'.repeat(64), p_volver_a: destino }), 'dato_invalido');
  }

  const { estado, tomado } = await conectar(e, esc, { confirmar: false });
  assert.deepEqual([tomado.slug, tomado.ambiente, tomado.volverA, tomado.verificador], ['lavanda', 'real', 'https://lavanda.entreturno.com.ar/', 'v'.repeat(64)]);
  assert.equal(await servicio(e, 'mp_conexion_tomar', { p_estado: estado }), null);                 // el código ya se usó
  assert.equal(await servicio(e, 'mp_conexion_tomar', { p_estado: 'no-existe-' + 'x'.repeat(40) }), null);

  // por confirmar: se ve cuál es, pero todavía no sirve para cobrar
  const antes = (await e.foto(esc, esc.admin)).config.mp.account;
  assert.deepEqual([antes.status, antes.env, antes.userId, antes.name, antes.email], ['por_confirmar', 'real', '1858095454', 'LAURALAVANDA', 'laura@lavanda.prueba']);
  assert.equal((await e.foto(esc, esc.lucia)).site.mp.ready, false);
  assert.equal((await servicio(e, 'mp_credencial', { p_consultorio: esc.id })).acceso, null);
  // los pases están en el Vault y en ninguna tabla nuestra
  const secretos = await e.sql(`select name, decrypted_secret from vault.decrypted_secrets order by name`);
  assert.deepEqual(secretos, [{ name: `mp_acceso_${esc.id}`, decrypted_secret: 'APP_USR-acceso-lavanda' }, { name: `mp_renovar_${esc.id}`, decrypted_secret: 'TG-renovar-lavanda' }]);
  assert.ok(!JSON.stringify(await e.sql(`select * from interno.mp_cuentas`)).includes('APP_USR'));
  assert.ok(!JSON.stringify(await e.foto(esc, esc.admin)).includes('APP_USR'));

  // confirma la cuenta que VIO: si mientras miraba quedó conectada otra, no se confirma esa
  await esperarError(e.llamarComo(esc.admin, 'mp_conexion_confirmar', { p_slug: esc.slug, p_user_id: '999' }), 'mp_cuenta_cambio');
  await esperarError(e.llamarComo(esc.admin, 'mp_conexion_confirmar', { p_slug: esc.slug, p_user_id: null }), 'mp_cuenta_cambio');
  assert.equal((await servicio(e, 'mp_credencial', { p_consultorio: esc.id })).acceso, null);
  assert.deepEqual(await e.llamarComo(esc.admin, 'mp_conexion_confirmar', { p_slug: esc.slug, p_user_id: CUENTA }), { status: 'conectada', name: 'LAURALAVANDA', email: 'laura@lavanda.prueba' });
  await esperarError(e.llamarComo(esc.admin, 'mp_conexion_confirmar', { p_slug: esc.slug, p_user_id: CUENTA }), 'mp_sin_cuenta');     // ya estaba
  assert.deepEqual(await servicio(e, 'mp_cuentas_de', { p_user_id: CUENTA }), [esc.id]);
  assert.deepEqual(await servicio(e, 'mp_cuentas_de', { p_user_id: '999' }), []);
  assert.equal((await e.foto(esc, esc.lucia)).site.mp.ready, true);
  const cred = await servicio(e, 'mp_credencial', { p_consultorio: esc.id });
  assert.deepEqual([cred.acceso, cred.renovar, cred.cuenta.estado, cred.ambiente], ['APP_USR-acceso-lavanda', null, 'conectada', 'real']);
  assert.equal((await servicio(e, 'mp_credencial', { p_consultorio: esc.id, p_con_renovar: true })).renovar, 'TG-renovar-lavanda');

  // un código viejo (más de 15 minutos) no sirve
  const viejo = `viejo-${'y'.repeat(40)}`;
  await e.llamarComo(esc.admin, 'mp_conexion_iniciar', { p_slug: esc.slug, p_estado: viejo, p_verificador: 'v'.repeat(64), p_volver_a: 'http://localhost:8092/' });
  await e.sql(`update interno.mp_estados set creado_en = now() - interval '16 minutes' where estado = $1`, [viejo]);
  assert.equal(await servicio(e, 'mp_conexion_tomar', { p_estado: viejo }), null);

  // desconectar borra la cuenta y los pases
  await e.llamarComo(esc.admin, 'mp_desconectar', { p_slug: esc.slug });
  assert.equal((await e.foto(esc, esc.admin)).config.mp.account, null);
  assert.deepEqual(await e.sql(`select name from vault.decrypted_secrets where name like 'mp_%'`), []);
  assert.equal((await e.foto(esc, esc.lucia)).site.mp.ready, false);
});

prueba('en modo prueba se puede cobrar sin cuenta propia; en modo simulado Mercado Pago no existe', async (e) => {
  const esc = await e.armar();
  const dia = await e.diaHabil(3);
  const r = await e.reservar(esc, esc.lucia, { fecha: dia });
  assert.equal((await e.foto(esc, esc.lucia)).site.mp, null);
  await esperarError(preparar(e, esc, esc.lucia, r.id, 'sena'), 'pagos_simulados');

  await conMercadoPago(e, esc, 'real');
  await esperarError(preparar(e, esc, esc.lucia, r.id, 'sena'), 'mp_sin_cuenta');
  await conMercadoPago(e, esc, 'prueba');
  assert.deepEqual((await e.foto(esc, esc.lucia)).site.mp, { env: 'prueba', ready: true });
  const p = await preparar(e, esc, esc.lucia, r.id, 'sena');
  assert.deepEqual([p.nuevo, p.monto, p.ambiente, p.slug], [true, 20000, 'prueba', 'lavanda']);
  // una cuenta conectada en prueba no sirve para cobrar en real: hay que conectarla de nuevo
  await conectar(e, esc);
  await conMercadoPago(e, esc, 'real');
  assert.equal((await e.foto(esc, esc.lucia)).site.mp.ready, false);
  assert.equal((await servicio(e, 'mp_credencial', { p_consultorio: esc.id })).acceso, null);
});

prueba('en modo prueba no se entrega el pase de la cuenta conectada ni se renueva', async (e) => {
  const esc = await e.armar();
  await conMercadoPago(e, esc, 'prueba');
  await conectar(e, esc);
  const cred = () => servicio(e, 'mp_credencial', { p_consultorio: esc.id, p_con_renovar: true });
  let c = await cred();
  assert.deepEqual([c.ambiente, c.cuenta.estado, c.cuenta.userId, c.acceso, c.renovar], ['prueba', 'conectada', CUENTA, null, null]);
  // por vencer: la de prueba no se renueva (sin el pase de renovar quedaría «caída» y la dueña recibiría un mail sin sentido)
  const porVencer = () => e.sql(`update interno.mp_cuentas set vence = now() + interval '5 days', renovada_en = null where consultorio_id = $1`, [esc.id]);
  const renovar = async () => (await servicio(e, 'mp_pendientes')).renovar;
  await porVencer();
  assert.deepEqual(await renovar(), []);
  // una real se entrega y se renueva, pero no mientras el consultorio está en prueba
  await conMercadoPago(e, esc, 'real');
  assert.deepEqual(await renovar(), []);                                      // todavía es la de prueba
  await conectar(e, esc, { userId: '777' });
  await porVencer();
  c = await cred();
  assert.deepEqual([c.ambiente, c.cuenta.userId, c.acceso, c.renovar], ['real', '777', 'APP_USR-acceso-lavanda', 'TG-renovar-lavanda']);
  assert.deepEqual(await renovar(), [esc.id]);
  await conMercadoPago(e, esc, 'prueba');
  assert.deepEqual([(await cred()).acceso, await renovar()], [null, []]);
});

prueba('una orden no queda anotada si no es del modo del consultorio', async (e) => {
  const esc = await e.armar();
  const dia = await e.diaHabil(3);
  await conMercadoPago(e, esc, 'prueba');
  const r = await e.reservar(esc, esc.lucia, { fecha: dia });
  const p = await preparar(e, esc, esc.lucia, r.id, 'sena');
  await esperarError(anotarOrden(e, p.pago, 'ORD01M89VH4MQ8183RWWEMV12K8XK'), 'mp_otro_ambiente');
  await esperarError(resultado(e, p.pago, 'ORD01M89VH4MQ8183RWWEMV12K8XK', 'processed', { p_pagado: 20000, p_transaccion: 'PAY1' }), 'mp_otro_ambiente');
  assert.deepEqual(await e.uno(`select estado, proveedor_id from public.pagos where id = $1`, [p.pago]), { estado: 'pendiente', proveedor_id: null });
  await anotarOrden(e, p.pago, 'ORDTST01M89VH4MQ8183RWWEMV12K8XK');
  assert.equal((await resultado(e, p.pago, 'ORDTST01M89VH4MQ8183RWWEMV12K8XK', 'processed', { p_pagado: 20000, p_transaccion: 'PAY1' })).estado, 'aprobado');

  await conMercadoPago(e, esc, 'real');
  await conectar(e, esc);
  const r2 = await e.reservar(esc, esc.caro, { fecha: dia, box: 1 });
  const p2 = await preparar(e, esc, esc.caro, r2.id, 'sena');
  await esperarError(anotarOrden(e, p2.pago, 'ORDTST01OTRA000000000000000000'), 'mp_otro_ambiente');
  await anotarOrden(e, p2.pago, ordenNueva());
  // lo que ya estaba anotado de antes no se traba al cambiar de modo (ni volviendo a escribir el mismo número)
  await e.sql(`update public.pagos set actualizado_en = now(), error = null where id = $1`, [p.pago]);
  await e.sql(`update public.pagos set proveedor_id = proveedor_id, estado = estado where id = $1`, [p.pago]);
});

prueba('si cambió el modo con una orden abierta, su enlace no se entrega más y no se aprueba: queda para revisar', async (e) => {
  const esc = await e.armar();
  const dia = await e.diaHabil(3);
  await conMercadoPago(e, esc, 'real');
  await conectar(e, esc);
  const r = await e.reservar(esc, esc.lucia, { fecha: dia });
  const p = await preparar(e, esc, esc.lucia, r.id, 'sena');
  const orden = ordenNueva();
  await anotarOrden(e, p.pago, orden);
  assert.deepEqual((await preparar(e, esc, esc.lucia, r.id, 'sena')).enlace, ENLACE(orden));      // en el mismo modo se reusa
  // alguien cambia el modo a mano, sin pasar por mp_pasar_a
  await conMercadoPago(e, esc, 'prueba');
  await esperarError(resultado(e, p.pago, orden, 'processed', { p_pagado: 20000, p_transaccion: 'PAY1' }), 'mp_otro_ambiente');
  assert.equal((await e.uno(`select estado from public.reservas where id = $1`, [r.id])).estado, 'pago');
  const q = await preparar(e, esc, esc.lucia, r.id, 'sena');
  assert.deepEqual([q.nuevo, q.enlace, q.cerrar, q.ambiente], [true, undefined, null, 'prueba']);
  assert.notEqual(q.pago, p.pago);
  assert.deepEqual(await e.uno(`select estado, error from public.pagos where id = $1`, [p.pago]), { estado: 'revisar', error: 'la orden es del otro modo (prueba o real)' });
  assert.equal((await avisosDe(e, esc.adminMiembro ?? (await e.uno(`select id from public.miembros where consultorio_id = $1 and rol = 'admin'`, [esc.id])).id)).filter((a) => a === 'Un pago para revisar').length, 1);
  await anotarOrden(e, q.pago, ordenNueva());
});

prueba('pasar un consultorio a cobrar de verdad, o volver a prueba: solo si no queda nada colgado del otro modo', async (e) => {
  const esc = await e.armar();
  const pasar = async (ambiente) => {
    const r = (await e.uno(`select interno.mp_pasar_a($1, $2) as r`, [esc.slug, ambiente])).r;
    modo = ambiente;
    return r;
  };
  const comoEsta = () => e.uno(`select pagos_modo, mp_ambiente from public.consultorios where id = $1`, [esc.id]);
  await esperarError(pasar('cualquiera'), 'dato_invalido');
  await esperarError(pasar(null), 'dato_invalido');
  await esperarError(e.sql(`select interno.mp_pasar_a('no-existe', 'real')`), 'consultorio_inexistente');
  // ni la página ni las funciones de Supabase lo pueden llamar
  for (const rol of ['anon', 'authenticated', 'service_role']) {
    await assert.rejects(e.comoRol(rol, null, (c) => c.sql(`select interno.mp_pasar_a('lavanda', 'real')`)), /permission denied/);
  }

  // un turno por venir pagado con el pago simulado
  const dia = await e.diaHabil(3);
  const simulada = await e.reservar(esc, esc.lucia, { fecha: dia });
  await e.pagar(esc, esc.lucia, simulada.id, 'sena');
  await esperarError(pasar('real'), 'hay_turnos_pagados_en_el_otro_modo');
  assert.equal(await pasar('prueba'), 'lavanda cobra con Mercado Pago en modo prueba');
  assert.deepEqual(await comoEsta(), { pagos_modo: 'mercadopago', mp_ambiente: 'prueba' });
  assert.equal(await pasar('prueba'), 'lavanda ya cobraba con Mercado Pago en modo prueba: no se cambió nada');
  await cancelar(e, esc, esc.admin, simulada.id);

  /** Hace salir la devolución que espera, como lo haría el reloj. */
  const devolver = async () => {
    await e.sql(`update public.pagos set actualizado_en = now() - interval '1 minute' where tipo = 'devolucion' and estado = 'pendiente'`);
    const { devolucion } = (await servicio(e, 'mp_pendientes')).devoluciones[0];
    for (const parte of (await servicio(e, 'mp_devolucion_tomar', { p_devolucion: devolucion })).partes) {
      await servicio(e, 'mp_devolucion_parte', { p_devolucion: devolucion, p_n: parte.n, p_hecha: true, p_referencia: 'REF1', p_error: null, p_definitivo: false });
    }
  };
  // de prueba a real, y después de real a prueba: lo mismo en los dos sentidos
  for (const [hoy, destino, box] of [['prueba', 'real', 1], ['real', 'prueba', 2]]) {
    if (hoy === 'real') await conectar(e, esc);
    const r = await e.reservar(esc, esc.caro, { fecha: dia, box });
    await esperarError(pasar(destino), 'hay_reservas_esperando_pago');
    const p = await preparar(e, esc, esc.caro, r.id, 'sena');
    await esperarError(pasar(destino), 'mp_con_pendientes');                                     // intento todavía sin número
    const orden = ordenNueva();
    await anotarOrden(e, p.pago, orden);
    await esperarError(pasar(destino), 'mp_con_pendientes');                                     // orden abierta
    await resultado(e, p.pago, orden, 'processed', { p_pagado: p.monto, p_transaccion: `PAY-${hoy}` });
    await esperarError(pasar(destino), 'hay_turnos_pagados_en_el_otro_modo');
    const saldo = await preparar(e, esc, esc.caro, r.id, 'saldo');
    await esperarError(pasar(destino), 'mp_con_pendientes');                                     // el saldo, a medio pedir
    await anotarOrden(e, saldo.pago, ordenNueva());
    await cancelar(e, esc, esc.admin, r.id);
    await esperarError(pasar(destino), 'mp_con_pendientes');                                     // la devolución todavía no salió
    await devolver();
    await esperarError(pasar(destino), 'mp_con_pendientes');                                     // falta cerrar la orden del saldo en Mercado Pago
    assert.equal((await e.uno(`select estado from public.pagos where id = $1`, [saldo.pago])).estado, 'vencido');
    await servicio(e, 'mp_pago_cerrado', { p_pago: saldo.pago });
    for (const [que, vuelta] of [[`datos = datos || '{"sin_comprobar": true}'`, `datos = datos - 'sin_comprobar'`], [`estado = 'revisar'`, `estado = 'vencido'`],
      [`estado = 'sobrante'`, `estado = 'vencido'`]]) {
      await e.sql(`update public.pagos set ${que} where id = $1`, [saldo.pago]);
      await esperarError(pasar(destino), 'mp_con_pendientes');
      await e.sql(`update public.pagos set ${vuelta} where id = $1`, [saldo.pago]);
    }
    assert.equal(await pasar(destino), destino === 'real' ? 'lavanda cobra con Mercado Pago en modo real: falta que la dueña conecte su cuenta desde Configuración'
      : 'lavanda cobra con Mercado Pago en modo prueba');
    assert.deepEqual(await comoEsta(), { pagos_modo: 'mercadopago', mp_ambiente: destino });
    if (destino === 'real') assert.equal((await e.foto(esc, esc.lucia)).site.mp.ready, false);
  }
  // de vuelta a real: la cuenta real que ya estaba conectada sirve
  assert.equal(await pasar('real'), 'lavanda cobra con Mercado Pago en modo real');
  assert.equal((await e.foto(esc, esc.lucia)).site.mp.ready, true);
});

prueba('pagar la seña y después el saldo: se acredita una sola vez aunque Mercado Pago avise varias veces', async (e) => {
  const esc = await e.armar();
  await conMercadoPago(e, esc);
  await conectar(e, esc);
  const dia = await e.diaHabil(3);
  const r = await e.reservar(esc, esc.lucia, { fecha: dia, plan: 'sena' });       // total $ 40.000, seña $ 20.000

  await esperarError(preparar(e, esc, esc.lucia, r.id, 'total'), 'pago_invalido');
  await esperarError(preparar(e, esc, esc.lucia, r.id, 'saldo'), 'pago_invalido');
  await esperarError(preparar(e, esc, esc.caro, r.id, 'sena'), 'reserva_inexistente');
  await esperarError(preparar(e, esc, esc.admin, r.id, 'sena'), 'reserva_inexistente');
  await esperarError(e.pagar(esc, esc.lucia, r.id, 'sena'), 'pagos_no_simulados');

  const p = await preparar(e, esc, esc.lucia, r.id, 'sena');
  assert.deepEqual([p.nuevo, p.monto, p.minutos, p.clave, p.cerrar], [true, 20000, 15, `${p.pago}-0`, null]);
  assert.match(p.titulo, /^Seña · Box 2 · .* · 8 a 12 h$/);
  assert.equal(p.email, (await e.uno(`select email from public.miembros where id = $1`, [await e.miembro(esc, esc.lucia)])).email);
  // mientras se crea la orden, otro clic espera
  await esperarError(preparar(e, esc, esc.lucia, r.id, 'sena'), 'pago_en_curso');
  const orden = ordenNueva();
  await anotarOrden(e, p.pago, orden);
  await esperarError(anotarOrden(e, p.pago, ordenNueva()), 'pago_inexistente');                    // ese pago ya tiene su orden
  // con la orden creada, otro clic devuelve la misma dirección
  assert.deepEqual(await preparar(e, esc, esc.lucia, r.id, 'sena'), { pago: p.pago, nuevo: false, enlace: ENLACE(orden), consultorio: esc.id });
  // la foto muestra el pago en curso, y nada como pagado todavía
  const enCurso = (await e.foto(esc, esc.lucia)).bookings[0];
  assert.deepEqual([enCurso.status, enCurso.payments, enCurso.pending.kind, enCurso.pending.amount, enCurso.pending.started], ['pago', [], 'sena', 20000, true]);
  // a quién corresponde un aviso de Mercado Pago: por la orden o por nuestra referencia
  assert.equal((await servicio(e, 'mp_pago_ubicar', { p_orden: orden, p_referencia: null })).pago, p.pago);
  assert.equal((await servicio(e, 'mp_pago_ubicar', { p_orden: 'ORD-DESCONOCIDA', p_referencia: p.pago })).pago, p.pago);
  assert.equal(await servicio(e, 'mp_pago_ubicar', { p_orden: 'ORD-DESCONOCIDA', p_referencia: 'cualquier cosa' }), null);
  // «ya pagué, fijate»: lo puede pedir la profesional o la dueña, nadie más
  assert.equal((await e.llamarComo(esc.lucia, 'mp_pago_mio', { p_slug: esc.slug, p_pago: p.pago })).orden, orden);
  assert.equal((await e.llamarComo(esc.admin, 'mp_pago_mio', { p_slug: esc.slug, p_pago: p.pago })).orden, orden);
  await esperarError(e.llamarComo(esc.caro, 'mp_pago_mio', { p_slug: esc.slug, p_pago: p.pago }), 'pago_inexistente');

  // todavía sin pagar: no cambia nada
  assert.deepEqual(await resultado(e, p.pago, orden, 'created'), { estado: 'pendiente' });
  const ok = await resultado(e, p.pago, orden, 'processed', { p_pagado: 20000, p_transaccion: 'PAY0001' });
  assert.deepEqual(ok, { estado: 'aprobado', que: 'aprobado' });
  assert.deepEqual(await e.uno(`select estado, vence_en from public.reservas where id = $1`, [r.id]), { estado: 'confirmada', vence_en: null });
  // el mismo aviso otra vez (Mercado Pago reintenta): no acredita de nuevo
  assert.deepEqual(await resultado(e, p.pago, orden, 'processed', { p_pagado: 20000, p_transaccion: 'PAY0001' }), { estado: 'aprobado', repetido: true });
  await esperarError(preparar(e, esc, esc.lucia, r.id, 'sena'), 'pago_invalido');

  const saldo = await pagarMp(e, esc, esc.lucia, r.id, 'saldo');
  assert.deepEqual([saldo.monto, saldo.minutos, saldo.resultado], [20000, 30, { estado: 'aprobado', que: 'aprobado' }]);
  await esperarError(preparar(e, esc, esc.lucia, r.id, 'saldo'), 'nada_que_pagar');
  const pagos = await e.sql(`select tipo, monto, estado, proveedor, datos ->> 'transaccion' as transaccion from public.pagos where reserva_id = $1 order by creado_en`, [r.id]);
  assert.deepEqual(pagos.map((x) => [x.tipo, x.monto, x.estado, x.proveedor]), [['sena', 20000, 'aprobado', 'mercadopago'], ['saldo', 20000, 'aprobado', 'mercadopago']]);
  assert.equal(pagos[0].transaccion, 'PAY0001');
  const b = (await e.foto(esc, esc.lucia)).bookings[0];
  assert.deepEqual([b.status, b.pending, b.payments.map((x) => [x.kind, x.amount, x.status, x.via])],
    ['confirmada', null, [['sena', 20000, 'aprobado', 'mercadopago'], ['saldo', 20000, 'aprobado', 'mercadopago']]]);
  assert.deepEqual((await avisosDe(e, await e.miembro(esc, esc.lucia))).slice(-2),
    [`Reserva confirmada: Box 2, ${(await e.uno(`select interno.dia_largo($1::date) as d`, [dia])).d}`, 'Recibimos tu pago']);
});

prueba('si la orden quedó a medio crear se repite el mismo pedido; si Mercado Pago dijo que no, el próximo va con otra clave', async (e) => {
  const esc = await e.armar();
  await conMercadoPago(e, esc, 'prueba');
  const r = await e.reservar(esc, esc.lucia, { fecha: await e.diaHabil(3) });
  const p1 = await preparar(e, esc, esc.lucia, r.id, 'sena');
  // se cortó la conexión: no se sabe si la orden llegó a crearse → mismo intento, misma clave
  await servicio(e, 'mp_pago_fallo', { p_pago: p1.pago, p_error: 'sin respuesta', p_definitivo: false });
  const p2 = await preparar(e, esc, esc.lucia, r.id, 'sena');
  assert.deepEqual([p2.pago, p2.nuevo, p2.clave, p2.minutos], [p1.pago, true, p1.clave, p1.minutos]);
  // Mercado Pago rechazó el pedido: mismo intento, clave nueva
  await servicio(e, 'mp_pago_fallo', { p_pago: p1.pago, p_error: 'property_value', p_definitivo: true });
  const p3 = await preparar(e, esc, esc.lucia, r.id, 'sena');
  assert.deepEqual([p3.pago, p3.clave], [p1.pago, `${p1.pago}-1`]);
  assert.equal((await e.uno(`select count(*)::int as n from public.pagos where reserva_id = $1`, [r.id])).n, 1);
  // la orden que no llegó a anotarse igual se reconoce cuando Mercado Pago avisa
  const orden = ordenNueva();
  assert.deepEqual(await resultado(e, p1.pago, orden, 'processed', { p_pagado: 20000, p_transaccion: 'PAY7' }), { estado: 'aprobado', que: 'aprobado' });
  assert.equal((await e.uno(`select proveedor_id from public.pagos where id = $1`, [p1.pago])).proveedor_id, orden);
});

prueba('si el importe o la orden no coinciden, no se acredita nada y queda para revisar', async (e) => {
  const esc = await e.armar();
  await conMercadoPago(e, esc, 'prueba');
  const dia = await e.diaHabil(3);
  const r = await e.reservar(esc, esc.lucia, { fecha: dia });
  const p = await preparar(e, esc, esc.lucia, r.id, 'sena');
  const orden = ordenNueva();
  await anotarOrden(e, p.pago, orden);
  assert.deepEqual(await resultado(e, p.pago, orden, 'processed', { p_pagado: 19999, p_transaccion: 'PAY1' }), { estado: 'revisar' });
  assert.equal((await e.uno(`select estado from public.reservas where id = $1`, [r.id])).estado, 'pago');
  assert.deepEqual(await e.uno(`select estado, error from public.pagos where id = $1`, [p.pago]), { estado: 'revisar', error: 'Mercado Pago informa 19999 y se esperaban 20000' });
  assert.equal((await avisosDe(e, await e.miembro(esc, esc.admin))).at(-1), 'Un pago para revisar');
  // ni aunque después llegue bien: lo mira una persona
  assert.deepEqual(await resultado(e, p.pago, orden, 'processed', { p_pagado: 20000, p_transaccion: 'PAY1' }), { estado: 'revisar', repetido: true });

  const r2 = await e.reservar(esc, esc.caro, { fecha: dia, box: 1 });
  const q = await preparar(e, esc, esc.caro, r2.id, 'sena');
  await anotarOrden(e, q.pago, ordenNueva());
  assert.deepEqual(await resultado(e, q.pago, ordenNueva(), 'processed', { p_pagado: 12000, p_transaccion: 'PAY2' }), { estado: 'revisar' });
  assert.equal((await e.uno(`select estado from public.pagos where id = $1`, [q.pago])).estado, 'revisar');
  // sin el número del pago adentro de la orden tampoco
  const r3 = await e.reservar(esc, esc.caro, { fecha: dia, box: 3 });
  const s = await preparar(e, esc, esc.caro, r3.id, 'sena');
  const o3 = ordenNueva();
  await anotarOrden(e, s.pago, o3);
  assert.deepEqual(await resultado(e, s.pago, o3, 'processed', { p_pagado: s.monto, p_transaccion: '' }), { estado: 'revisar' });
});

prueba('un pago rechazado deja la reserva esperando y se puede intentar de nuevo', async (e) => {
  const esc = await e.armar();
  await conMercadoPago(e, esc, 'prueba');
  const r = await e.reservar(esc, esc.lucia, { fecha: await e.diaHabil(3) });
  const p = await preparar(e, esc, esc.lucia, r.id, 'sena');
  const orden = ordenNueva();
  await anotarOrden(e, p.pago, orden);
  assert.deepEqual(await resultado(e, p.pago, orden, 'failed', { p_detalle: 'insufficient_amount' }), { estado: 'rechazado', detalle: 'insufficient_amount' });
  assert.equal((await e.uno(`select estado from public.reservas where id = $1`, [r.id])).estado, 'pago');
  const otra = await pagarMp(e, esc, esc.lucia, r.id, 'sena');
  assert.notEqual(otra.pago, p.pago);
  assert.deepEqual(otra.resultado, { estado: 'aprobado', que: 'aprobado' });
  // una orden vencida o cancelada en Mercado Pago cierra el intento
  const r2 = await e.reservar(esc, esc.caro, { fecha: await e.diaHabil(3), box: 1 });
  const q = await preparar(e, esc, esc.caro, r2.id, 'sena');
  const o2 = ordenNueva();
  await anotarOrden(e, q.pago, o2);
  assert.deepEqual(await resultado(e, q.pago, o2, 'canceled'), { estado: 'vencido' });
});

prueba('un pago que llega con el plazo vencido: si el horario sigue libre la reserva revive, con sus máquinas', async (e) => {
  const esc = await e.armar();
  await conMercadoPago(e, esc, 'prueba');
  const dia = await e.diaHabil(3);
  const r = await e.reservar(esc, esc.lucia, { fecha: dia, maquinas: [esc.maquinas.laser] });
  const p = await preparar(e, esc, esc.lucia, r.id, 'sena');
  const orden = ordenNueva();
  await anotarOrden(e, p.pago, orden);
  await vencer(e, esc, r.id);
  assert.deepEqual(await e.uno(`select estado, cancelada_por from public.reservas where id = $1`, [r.id]), { estado: 'cancelada', cancelada_por: 'vencida' });
  assert.equal((await e.uno(`select estado from public.pagos where id = $1`, [p.pago])).estado, 'vencido');

  assert.deepEqual(await resultado(e, p.pago, orden, 'processed', { p_pagado: p.monto, p_transaccion: 'PAY9' }), { estado: 'aprobado', que: 'revivio' });
  assert.deepEqual(await e.uno(`select estado, cancelada_en, cancelada_por, devolucion_monto, vence_en from public.reservas where id = $1`, [r.id]),
    { estado: 'confirmada', cancelada_en: null, cancelada_por: null, devolucion_monto: null, vence_en: null });
  assert.deepEqual(await e.sql(`select activa from public.reserva_maquinas where reserva_id = $1`, [r.id]), [{ activa: true }]);
  await esperarError(e.reservar(esc, esc.caro, { fecha: dia, box: 2 }), 'horario_no_disponible');
  assert.match((await avisosDe(e, await e.miembro(esc, esc.lucia))).at(-1), /^Reserva confirmada/);
});

prueba('un pago que llega tarde con el horario ya tomado, o de una reserva cancelada, se devuelve entero', async (e) => {
  const esc = await e.armar();
  await conMercadoPago(e, esc, 'prueba');
  const dia = await e.diaHabil(3);
  const lucia = await e.miembro(esc, esc.lucia);
  const r = await e.reservar(esc, esc.lucia, { fecha: dia });
  const p = await preparar(e, esc, esc.lucia, r.id, 'sena');
  const orden = ordenNueva();
  await anotarOrden(e, p.pago, orden);
  await vencer(e, esc, r.id);
  const deCaro = await e.reservar(esc, esc.caro, { fecha: dia, box: 2 });               // otra tomó el horario
  await pagarMp(e, esc, esc.caro, deCaro.id, 'sena');

  assert.deepEqual(await resultado(e, p.pago, orden, 'processed', { p_pagado: p.monto, p_transaccion: 'PAY-TARDE' }), { estado: 'sobrante', que: 'sobrante' });
  assert.deepEqual(await e.uno(`select estado, cancelada_por from public.reservas where id = $1`, [r.id]), { estado: 'cancelada', cancelada_por: 'vencida' });
  assert.equal((await e.uno(`select estado from public.reservas where id = $1`, [deCaro.id])).estado, 'confirmada');
  assert.equal((await e.uno(`select interno.pagado($1) as n`, [r.id])).n, 0);            // no cuenta como pagado
  assert.equal((await avisosDe(e, lucia)).at(-1), 'Te devolvemos un pago');
  assert.equal((await avisosDe(e, await e.miembro(esc, esc.admin))).at(-1), 'Pago para devolver: Lucía Ferrari');
  let b = (await e.foto(esc, esc.lucia)).bookings.find((x) => x.id === r.id);
  assert.deepEqual([b.payments, b.surplus.map((x) => [x.amount, x.done])], [[], [[20000, false]]]);

  // el reloj lo ve y la función lo devuelve entero
  const pend = await servicio(e, 'mp_pendientes');
  assert.deepEqual(pend.sobrantes, [{ pago: p.pago, consultorio: esc.id, orden }]);
  // se toma de a una vuelta por vez: mientras una la está devolviendo, otra no la agarra
  assert.deepEqual(await servicio(e, 'mp_sobrante_tomar', { p_pago: p.pago }), { pago: p.pago, consultorio: esc.id, orden, cuenta: CUENTA });
  assert.equal(await servicio(e, 'mp_sobrante_tomar', { p_pago: p.pago }), null);
  assert.deepEqual((await servicio(e, 'mp_pendientes')).sobrantes, []);
  await esperarError(e.llamarComo(esc.admin, 'mp_devolucion_a_mano', { p_slug: esc.slug, p_devolucion: p.pago }), 'mp_en_curso');
  // si no sale porque Mercado Pago dijo que no, la dueña se entera una vez y se sigue intentando
  await servicio(e, 'mp_sobrante_resultado', { p_pago: p.pago, p_hecha: false, p_error: 'insufficient_money', p_definitivo: true });
  await servicio(e, 'mp_sobrante_resultado', { p_pago: p.pago, p_hecha: false, p_error: 'insufficient_money', p_definitivo: true });
  assert.equal((await avisosDe(e, await e.miembro(esc, esc.admin))).filter((a) => a === 'Una devolución no pudo salir').length, 1);
  assert.deepEqual((await servicio(e, 'mp_pendientes')).sobrantes, []);                  // espera 10 minutos antes de probar de nuevo
  await e.sql(`update public.pagos set actualizado_en = now() - interval '11 minutes' where id = $1`, [p.pago]);
  assert.equal((await servicio(e, 'mp_pendientes')).sobrantes.length, 1);                // y pasado ese rato, vuelve a estar para hacer
  await servicio(e, 'mp_sobrante_resultado', { p_pago: p.pago, p_hecha: true, p_error: null });
  b = (await e.foto(esc, esc.lucia)).bookings.find((x) => x.id === r.id);
  assert.deepEqual(b.surplus.map((x) => [x.amount, x.done]), [[20000, true]]);
  assert.equal((await e.uno(`select estado from public.pagos where id = $1`, [p.pago])).estado, 'devuelto');

  // canceló mientras pagaba: el pago que llega después también se devuelve
  const r2 = await e.reservar(esc, esc.lucia, { fecha: dia, box: 1 });
  const q = await preparar(e, esc, esc.lucia, r2.id, 'sena');
  const o2 = ordenNueva();
  await anotarOrden(e, q.pago, o2);
  await cancelar(e, esc, esc.lucia, r2.id);
  assert.deepEqual((await servicio(e, 'mp_pendientes', { p_consultorio: esc.id })).cerrar.map((x) => x.orden), [o2]);     // la orden abierta hay que cancelarla
  assert.deepEqual(await resultado(e, q.pago, o2, 'processed', { p_pagado: q.monto, p_transaccion: 'PAY-CANC' }), { estado: 'sobrante', que: 'sobrante' });
  assert.equal((await e.uno(`select error from public.pagos where id = $1`, [q.pago])).error, 'la reserva ya estaba cancelada');
  assert.deepEqual((await servicio(e, 'mp_pendientes')).cerrar, []);
});

prueba('la misma seña pagada dos veces: la segunda se devuelve entera', async (e) => {
  const esc = await e.armar();
  await conMercadoPago(e, esc, 'prueba');
  const r = await e.reservar(esc, esc.lucia, { fecha: await e.diaHabil(3) });
  const a = await preparar(e, esc, esc.lucia, r.id, 'sena');
  const ordenA = ordenNueva();
  await anotarOrden(e, a.pago, ordenA);
  await e.sql(`update public.pagos set vence_en = now() + interval '30 seconds' where id = $1`, [a.pago]);    // esa orden está por vencer
  const b = await preparar(e, esc, esc.lucia, r.id, 'sena');
  assert.deepEqual([b.nuevo, b.cerrar, b.pago !== a.pago], [true, ordenA, true]);                               // se abre otra y la vieja se manda a cancelar
  const ordenB = ordenNueva();
  await anotarOrden(e, b.pago, ordenB);
  assert.deepEqual(await resultado(e, b.pago, ordenB, 'processed', { p_pagado: 20000, p_transaccion: 'PAY-B' }), { estado: 'aprobado', que: 'aprobado' });
  // pero la primera también se pagó
  assert.deepEqual(await resultado(e, a.pago, ordenA, 'processed', { p_pagado: 20000, p_transaccion: 'PAY-A' }), { estado: 'sobrante', que: 'sobrante' });
  assert.equal((await e.uno(`select error from public.pagos where id = $1`, [a.pago])).error, 'ese pago ya estaba hecho');
  assert.equal((await e.uno(`select interno.pagado($1) as n`, [r.id])).n, 20000);
  // un saldo que ya estaba cubierto, igual
  const s1 = await preparar(e, esc, esc.lucia, r.id, 'saldo');
  const o1 = ordenNueva();
  await anotarOrden(e, s1.pago, o1);
  await e.sql(`update public.pagos set vence_en = now() + interval '30 seconds' where id = $1`, [s1.pago]);
  await pagarMp(e, esc, esc.lucia, r.id, 'saldo');
  assert.deepEqual(await resultado(e, s1.pago, o1, 'processed', { p_pagado: 20000, p_transaccion: 'PAY-S1' }), { estado: 'sobrante', que: 'sobrante' });
  assert.equal((await e.uno(`select interno.pagado($1) as n`, [r.id])).n, 40000);
});

prueba('la devolución de una cancelación sale por Mercado Pago, una sola vez', async (e) => {
  const esc = await e.armar();
  await conMercadoPago(e, esc);
  await conectar(e, esc);
  const r = await e.reservar(esc, esc.lucia, { fecha: await e.diaHabil(10) });
  const pago = await pagarMp(e, esc, esc.lucia, r.id, 'sena');
  assert.deepEqual(await cancelar(e, esc, esc.lucia, r.id), { amount: 20000, pct: 100, paid: 20000, by: 'pro' });
  const dev = await e.uno(`select id, monto, estado, proveedor from public.pagos where tipo = 'devolucion'`);
  assert.deepEqual([dev.monto, dev.estado, dev.proveedor], [20000, 'pendiente', 'mercadopago']);
  assert.deepEqual((await e.foto(esc, esc.lucia)).bookings[0].refund, { amount: 20000, pct: 100, done: false });

  assert.deepEqual((await servicio(e, 'mp_pendientes')).devoluciones, [{ devolucion: dev.id, consultorio: esc.id }]);
  const t = await servicio(e, 'mp_devolucion_tomar', { p_devolucion: dev.id });
  assert.deepEqual([t.lista, t.consultorio, t.partes], [false, esc.id,
    [{ n: 1, pago: pago.pago, orden: pago.orden, transaccion: `PAY${pago.orden.slice(3)}`, monto: 20000, entera: true, estado: 'pendiente',
      cuenta: CUENTA, devueltoAntes: 0 }]]);
  // mientras una vuelta la tiene tomada, otra no la ejecuta, no aparece para hacer y no se puede marcar «a mano»
  assert.equal(await servicio(e, 'mp_devolucion_tomar', { p_devolucion: dev.id }), null);
  assert.deepEqual((await servicio(e, 'mp_pendientes')).devoluciones, []);
  await esperarError(e.llamarComo(esc.admin, 'mp_devolucion_a_mano', { p_slug: esc.slug, p_devolucion: dev.id }), 'mp_en_curso');
  // si esa vuelta se cortó, al minuto y medio otra la retoma y repite exactamente lo mismo
  await e.sql(`update public.pagos set datos = datos || jsonb_build_object('tomada_hasta', now() - interval '1 second') where id = $1`, [dev.id]);
  assert.deepEqual((await servicio(e, 'mp_devolucion_tomar', { p_devolucion: dev.id })).partes, t.partes);
  await esperarError(servicio(e, 'mp_devolucion_parte', { p_devolucion: dev.id, p_n: 5, p_hecha: true, p_referencia: 'x', p_error: null }), 'dato_invalido');
  assert.deepEqual(await servicio(e, 'mp_devolucion_parte', { p_devolucion: dev.id, p_n: 1, p_hecha: true, p_referencia: 'REF-1', p_error: null }), { estado: 'aprobado' });
  await esperarError(servicio(e, 'mp_devolucion_parte', { p_devolucion: dev.id, p_n: 1, p_hecha: true, p_referencia: 'REF-1', p_error: null }), 'pago_inexistente');
  assert.equal(await servicio(e, 'mp_devolucion_tomar', { p_devolucion: dev.id }), null);
  assert.deepEqual((await e.foto(esc, esc.lucia)).bookings[0].refund, { amount: 20000, pct: 100, done: true });
  assert.equal((await e.uno(`select datos ->> 'devuelto' as d from public.pagos where id = $1`, [pago.pago])).d, '20000');
  assert.deepEqual((await servicio(e, 'mp_pendientes')).devoluciones, []);
});

prueba('una devolución que sale de dos pagos: si una parte falla, la otra no se repite y la dueña se entera', async (e) => {
  const esc = await e.armar();
  await conMercadoPago(e, esc);
  await conectar(e, esc);
  await e.sql(`update public.consultorios set pol_total_despues = 75 where id = $1`, [esc.id]);
  const r = await e.reservar(esc, esc.lucia, { fecha: await e.diaHabil(2), box: 3 });     // box 3: $ 48.000, seña $ 24.000
  const sena = await pagarMp(e, esc, esc.lucia, r.id, 'sena');
  const saldo = await pagarMp(e, esc, esc.lucia, r.id, 'saldo');
  assert.deepEqual(await cancelar(e, esc, esc.lucia, r.id), { amount: 36000, pct: 75, paid: 48000, by: 'pro' });
  const dev = (await e.uno(`select id from public.pagos where tipo = 'devolucion'`)).id;
  const t = await servicio(e, 'mp_devolucion_tomar', { p_devolucion: dev });
  // primero el pago más nuevo (el saldo, entero) y después lo que falta de la seña
  assert.deepEqual(t.partes.map((x) => [x.n, x.pago, x.monto, x.entera]), [[1, saldo.pago, 24000, true], [2, sena.pago, 12000, false]]);
  assert.deepEqual(await servicio(e, 'mp_devolucion_parte', { p_devolucion: dev, p_n: 1, p_hecha: true, p_referencia: 'REF-A', p_error: null }), { estado: 'pendiente' });
  const noSalio = (definitivo) => servicio(e, 'mp_devolucion_parte', { p_devolucion: dev, p_n: 2, p_hecha: false, p_referencia: null, p_error: 'insufficient_money', p_definitivo: definitivo });
  const mails = async () => (await avisosDe(e, await e.miembro(esc, esc.admin))).filter((a) => a === 'Una devolución no pudo salir: Lucía Ferrari').length;
  // Mercado Pago dijo que no (no hay saldo): la dueña se entera en el momento, una sola vez
  assert.deepEqual(await noSalio(true), { estado: 'pendiente', intentos: 1 });
  assert.deepEqual(await noSalio(true), { estado: 'pendiente', intentos: 2 });
  assert.equal(await mails(), 1);
  assert.deepEqual(await e.uno(`select estado, intentos, error from public.pagos where id = $1`, [dev]), { estado: 'pendiente', intentos: 2, error: 'insufficient_money' });
  // el reloj espera 10 minutos antes de volver a probar
  assert.deepEqual((await servicio(e, 'mp_pendientes')).devoluciones, []);
  await e.sql(`update public.pagos set actualizado_en = now() - interval '11 minutes' where id = $1`, [dev]);
  assert.equal((await servicio(e, 'mp_pendientes')).devoluciones.length, 1);
  // en la vuelta siguiente solo queda la parte que falló
  assert.deepEqual((await servicio(e, 'mp_devolucion_tomar', { p_devolucion: dev })).partes.map((x) => [x.n, x.monto]), [[2, 12000]]);
  assert.deepEqual(await servicio(e, 'mp_devolucion_parte', { p_devolucion: dev, p_n: 2, p_hecha: true, p_referencia: 'REF-B', p_error: null }), { estado: 'aprobado' });
  const devueltos = await e.sql(`select tipo, datos ->> 'devuelto' as d from public.pagos where reserva_id = $1 and tipo <> 'devolucion' order by creado_en`, [r.id]);
  assert.deepEqual(devueltos, [{ tipo: 'sena', d: '12000' }, { tipo: 'saldo', d: '24000' }]);
});

prueba('si una devolución falla por un corte, la dueña no recibe un mail hasta el tercer intento', async (e) => {
  const esc = await e.armar();
  await conMercadoPago(e, esc, 'prueba');
  const r = await e.reservar(esc, esc.lucia, { fecha: await e.diaHabil(10) });
  await pagarMp(e, esc, esc.lucia, r.id, 'sena');
  await cancelar(e, esc, esc.lucia, r.id);
  const dev = (await e.uno(`select id from public.pagos where tipo = 'devolucion'`)).id;
  await servicio(e, 'mp_devolucion_tomar', { p_devolucion: dev });
  const corte = () => servicio(e, 'mp_devolucion_parte', { p_devolucion: dev, p_n: 1, p_hecha: false, p_referencia: null, p_error: 'sin_respuesta', p_definitivo: false });
  const mails = async () => (await avisosDe(e, await e.miembro(esc, esc.admin))).filter((a) => a.startsWith('Una devolución no pudo salir')).length;
  await corte(); await corte();
  assert.equal(await mails(), 0);
  await corte();
  assert.equal(await mails(), 1);
  await corte();
  assert.equal(await mails(), 1);
  // y si sigue sin salir, se le recuerda una vez por semana (cada 28 intentos, que van cada 6 horas)
  await e.sql(`update public.pagos set intentos = 27 where id = $1`, [dev]);
  await corte();
  assert.equal(await mails(), 2);
  // un fallo no deja la devolución tomada: la próxima vuelta la puede retomar
  assert.equal((await e.uno(`select datos ? 'tomada_hasta' as t from public.pagos where id = $1`, [dev])).t, false);
});

prueba('no se cambia ni se saca la cuenta mientras tenga cobros abiertos o devoluciones esperando', async (e) => {
  const esc = await e.armar();
  await conMercadoPago(e, esc);
  await conectar(e, esc, { userId: '111' });
  const otraCuenta = () => servicio(e, 'mp_cuenta_guardar', { p_consultorio: esc.id, p_ambiente: 'real', p_user_id: '222', p_acceso: 'APP_USR-otra',
    p_renovar: 'TG-otra', p_segundos: 15552000, p_nombre: 'OTRA', p_email: '', p_miembro: null });
  const sacar = () => e.llamarComo(esc.admin, 'mp_desconectar', { p_slug: esc.slug });
  const dia = await e.diaHabil(10);

  // 1) un cobro abierto: alguien puede estar pagándolo en este momento con esa cuenta
  const r = await e.reservar(esc, esc.lucia, { fecha: dia });
  const p = await preparar(e, esc, esc.lucia, r.id, 'sena');
  const orden = ordenNueva();
  await anotarOrden(e, p.pago, orden, '111');
  await esperarError(otraCuenta(), 'mp_con_pendientes');
  await esperarError(sacar(), 'mp_con_pendientes');
  assert.equal((await servicio(e, 'mp_credencial', { p_consultorio: esc.id })).cuenta.userId, '111');     // sigue la de antes, con sus pases
  assert.equal((await e.uno(`select decrypted_secret as s from vault.decrypted_secrets where name = $1`, [`mp_acceso_${esc.id}`])).s, 'APP_USR-acceso-lavanda');
  // reconectar la MISMA cuenta sí se puede, y sigue sirviendo sin confirmar de nuevo
  assert.deepEqual((await conectar(e, esc, { userId: '111' })).guardada, { estado: 'conectada' });

  // 2) pagó y canceló: hay una devolución esperando
  await resultado(e, p.pago, orden, 'processed', { p_pagado: 20000, p_transaccion: 'PAY-1', p_cuenta: '111' });
  await cancelar(e, esc, esc.lucia, r.id);
  await esperarError(otraCuenta(), 'mp_con_pendientes');
  await esperarError(sacar(), 'mp_con_pendientes');
  // aunque la cuenta se haya caído: hay que reconectar ESA (o marcar la devolución como hecha)
  await servicio(e, 'mp_cuenta_caida', { p_consultorio: esc.id, p_user_id: null, p_motivo: 'x' });
  await esperarError(otraCuenta(), 'mp_con_pendientes');
  assert.deepEqual((await conectar(e, esc, { userId: '111' })).guardada, { estado: 'conectada' });

  // 3) con todo resuelto, sí se puede cambiar; la cuenta nueva hay que confirmarla
  const dev = (await e.uno(`select id from public.pagos where tipo = 'devolucion'`)).id;
  await e.llamarComo(esc.admin, 'mp_devolucion_a_mano', { p_slug: esc.slug, p_devolucion: dev });
  assert.deepEqual(await otraCuenta(), { estado: 'por_confirmar' });
  assert.equal((await servicio(e, 'mp_credencial', { p_consultorio: esc.id })).acceso, null);
  assert.deepEqual(await sacar(), { ok: true });        // una cuenta sin confirmar se puede sacar siempre
});

prueba('un aviso que no se pudo comprobar queda marcado y el reloj lo sigue mirando; lo que se pasa de plazo va a revisar', async (e) => {
  const esc = await e.armar();
  await conMercadoPago(e, esc, 'prueba');
  const dia = await e.diaHabil(3);
  const admin = await e.miembro(esc, esc.admin);
  const r = await e.reservar(esc, esc.lucia, { fecha: dia });
  const p = await preparar(e, esc, esc.lucia, r.id, 'sena');
  const orden = ordenNueva();
  await anotarOrden(e, p.pago, orden);
  await vencer(e, esc, r.id);                                                            // el intento ya está cerrado («vencido»)
  await servicio(e, 'mp_pago_cerrado', { p_pago: p.pago });
  assert.deepEqual([(await servicio(e, 'mp_pendientes')).pagos, (await servicio(e, 'mp_pendientes')).cerrar], [[], []]);
  // llega un aviso de esa orden y no se puede leer: sin mail si no se sabe que esté pagada
  await servicio(e, 'mp_pago_sin_comprobar', { p_pago: p.pago, p_pagada: false });
  assert.equal((await avisosDe(e, admin)).includes('Un pago de Mercado Pago sin comprobar'), false);
  assert.deepEqual((await servicio(e, 'mp_pendientes')).pagos, []);                      // se vuelve a mirar a los 10 minutos
  await e.sql(`update public.pagos set actualizado_en = now() - interval '11 minutes' where id = $1`, [p.pago]);
  assert.deepEqual((await servicio(e, 'mp_pendientes')).pagos.map((x) => [x.pago, x.estado]), [[p.pago, 'vencido']]);
  // cuando por fin se puede leer y estaba pagada, se resuelve como cualquier pago tardío, y deja de estar en duda
  assert.deepEqual(await resultado(e, p.pago, orden, 'processed', { p_pagado: 20000, p_transaccion: 'PAY-X' }), { estado: 'aprobado', que: 'revivio' });
  assert.equal((await e.uno(`select datos ? 'sin_comprobar' as s from public.pagos where id = $1`, [p.pago])).s, false);

  // si el aviso hablaba de un pago hecho y la cuenta no está conectada, la dueña se entera (una vez)
  const r2 = await e.reservar(esc, esc.caro, { fecha: dia, box: 1 });
  const q = await preparar(e, esc, esc.caro, r2.id, 'sena');
  await anotarOrden(e, q.pago, ordenNueva());
  await servicio(e, 'mp_pago_sin_comprobar', { p_pago: q.pago, p_pagada: true });
  await servicio(e, 'mp_pago_sin_comprobar', { p_pago: q.pago, p_pagada: true });
  assert.equal((await avisosDe(e, admin)).filter((a) => a === 'Un pago de Mercado Pago sin comprobar').length, 1);

  // lo que se pasa de plazo no queda «pendiente» para siempre
  const r3 = await e.reservar(esc, esc.caro, { fecha: dia, box: 3 });
  const sinOrden = await preparar(e, esc, esc.caro, r3.id, 'sena');                      // nunca llegó a tener orden
  await e.sql(`update public.pagos set vence_en = now() - interval '11 minutes' where id = $1`, [sinOrden.pago]);
  await e.sql(`update public.pagos set creado_en = now() - interval '61 days' where id = $1`, [q.pago]);       // en duda hace dos meses
  const r4 = await e.reservar(esc, esc.lucia, { fecha: dia, box: 2, desde: 12, hasta: 16 });
  const viejo = await preparar(e, esc, esc.lucia, r4.id, 'sena');
  await anotarOrden(e, viejo.pago, ordenNueva());
  await e.sql(`update public.pagos set creado_en = now() - interval '4 days' where id = $1`, [viejo.pago]);    // abierta hace 4 días sin poder consultarla
  assert.equal((await e.uno(`select interno.mp_vencidos() as n`)).n, 2);
  const estados = await e.sql(`select id, estado from public.pagos where id = any($1::uuid[])`, [`{${sinOrden.pago},${q.pago},${viejo.pago}}`]);
  assert.deepEqual(Object.fromEntries(estados.map((x) => [x.id, x.estado])), { [sinOrden.pago]: 'vencido', [q.pago]: 'revisar', [viejo.pago]: 'revisar' });
  assert.equal((await avisosDe(e, admin)).filter((a) => a === 'Un pago para revisar').length, 2);
  assert.equal((await e.uno(`select interno.mp_vencidos() as n`)).n, 0);
});

prueba('la dueña puede marcar como hecha una devolución que hizo por su cuenta', async (e) => {
  const esc = await e.armar();
  const otro = await e.armar('nacar', { nombre: 'Espacio Nácar', duena: 'Inés' });
  await conMercadoPago(e, esc, 'prueba');
  const r = await e.reservar(esc, esc.lucia, { fecha: await e.diaHabil(10) });
  await pagarMp(e, esc, esc.lucia, r.id, 'sena');
  await cancelar(e, esc, esc.admin, r.id);
  const dev = (await e.uno(`select id from public.pagos where tipo = 'devolucion'`)).id;
  await esperarError(e.llamarComo(esc.lucia, 'mp_devolucion_a_mano', { p_slug: esc.slug, p_devolucion: dev }), 'solo_admin');
  await esperarError(e.llamarComo(otro.admin, 'mp_devolucion_a_mano', { p_slug: otro.slug, p_devolucion: dev }), 'pago_inexistente');
  assert.deepEqual(await e.llamarComo(esc.admin, 'mp_devolucion_a_mano', { p_slug: esc.slug, p_devolucion: dev }), { ok: true });
  assert.equal((await e.foto(esc, esc.lucia)).bookings[0].refund.done, true);
  await esperarError(e.llamarComo(esc.admin, 'mp_devolucion_a_mano', { p_slug: esc.slug, p_devolucion: dev }), 'pago_inexistente');
  assert.deepEqual((await servicio(e, 'mp_pendientes')).devoluciones, []);
});

prueba('una reserva pagada mitad de prueba y mitad por Mercado Pago devuelve por Mercado Pago solo lo que entró por ahí', async (e) => {
  const esc = await e.armar();
  const r = await e.reservar(esc, esc.lucia, { fecha: await e.diaHabil(10) });
  await e.pagar(esc, esc.lucia, r.id, 'sena');                                           // $ 20.000 de prueba
  await conMercadoPago(e, esc, 'prueba');
  const saldo = await pagarMp(e, esc, esc.lucia, r.id, 'saldo');                         // $ 20.000 por Mercado Pago
  assert.equal((await cancelar(e, esc, esc.lucia, r.id)).amount, 40000);
  const dev = (await e.uno(`select id from public.pagos where tipo = 'devolucion'`)).id;
  const t = await servicio(e, 'mp_devolucion_tomar', { p_devolucion: dev });
  assert.deepEqual(t.partes.map((x) => [x.pago, x.monto]), [[saldo.pago, 20000]]);
  assert.equal((await e.uno(`select datos ->> 'sin_plata' as s from public.pagos where id = $1`, [dev])).s, '20000');
  assert.deepEqual(await servicio(e, 'mp_devolucion_parte', { p_devolucion: dev, p_n: 1, p_hecha: true, p_referencia: 'R', p_error: null }), { estado: 'aprobado' });
});

prueba('el reloj: mira las órdenes abiertas, renueva los pases que están por vencer y despierta a la función solo si hay trabajo', async (e) => {
  const esc = await e.armar();
  await conMercadoPago(e, esc);
  await conectar(e, esc);
  const vacio = { pagos: [], cerrar: [], devoluciones: [], sobrantes: [], renovar: [] };
  assert.deepEqual(await servicio(e, 'mp_pendientes'), vacio);
  assert.equal((await e.uno(`select interno.mp_reloj() as r`)).r, false);

  const r = await e.reservar(esc, esc.lucia, { fecha: await e.diaHabil(3) });
  const p = await preparar(e, esc, esc.lucia, r.id, 'sena');
  const orden = ordenNueva();
  await anotarOrden(e, p.pago, orden);
  assert.deepEqual(await servicio(e, 'mp_pendientes'), vacio);                           // recién creada: todavía no
  await e.sql(`update public.pagos set actualizado_en = now() - interval '2 minutes' where id = $1`, [p.pago]);
  assert.deepEqual((await servicio(e, 'mp_pendientes')).pagos, [{ pago: p.pago, consultorio: esc.id, orden, monto: 20000, estado: 'pendiente' }]);
  assert.deepEqual((await servicio(e, 'mp_pendientes', { p_consultorio: '00000000-0000-0000-0000-000000000000' })).pagos, []);
  // hay trabajo, pero sin la dirección de la función y la clave no se llama a nadie
  assert.equal((await e.uno(`select interno.mp_reloj() as r`)).r, false);
  await e.sql(`insert into interno.ajustes (clave, valor) values ('funcion_mp_url', 'https://proyecto.supabase.co/functions/v1/mp')`);
  await e.sql(`select vault.create_secret($1, 'mp_clave_reloj', '')`, ['c'.repeat(48)]);
  assert.equal((await e.uno(`select interno.mp_reloj() as r`)).r, true);
  const llamada = await e.uno(`select url, body, headers from net.llamadas order by id desc limit 1`);
  assert.deepEqual([llamada.url, llamada.body, llamada.headers['x-entreturno-reloj']], ['https://proyecto.supabase.co/functions/v1/mp', { accion: 'reloj' }, 'c'.repeat(48)]);
  assert.equal(await servicio(e, 'mp_reloj_clave', { p_clave: 'c'.repeat(48) }), true);
  assert.equal(await servicio(e, 'mp_reloj_clave', { p_clave: 'd'.repeat(48) }), false);
  assert.equal(await servicio(e, 'mp_reloj_clave', { p_clave: '' }), false);
  assert.equal(await servicio(e, 'mp_reloj_clave', { p_clave: null }), false);
  // después de mirarla sigue abierta: no se vuelve a preguntar enseguida
  await resultado(e, p.pago, orden, 'created');
  assert.deepEqual((await servicio(e, 'mp_pendientes')).pagos, []);

  // el pase vence en menos de 30 días: se renueva, una vez por día
  await e.sql(`update interno.mp_cuentas set vence = now() + interval '20 days' where consultorio_id = $1`, [esc.id]);
  assert.deepEqual((await servicio(e, 'mp_pendientes')).renovar, [esc.id]);
  await servicio(e, 'mp_cuenta_reintento', { p_consultorio: esc.id, p_error: 'sin respuesta' });
  assert.deepEqual((await servicio(e, 'mp_pendientes')).renovar, []);
  await e.sql(`update interno.mp_cuentas set renovada_en = now() - interval '2 days' where consultorio_id = $1`, [esc.id]);
  await servicio(e, 'mp_cuenta_renovada', { p_consultorio: esc.id, p_acceso: 'APP_USR-nuevo', p_renovar: 'TG-nuevo', p_segundos: 15552000 });
  assert.deepEqual((await servicio(e, 'mp_pendientes')).renovar, []);
  const cred = await servicio(e, 'mp_credencial', { p_consultorio: esc.id, p_con_renovar: true });
  assert.deepEqual([cred.acceso, cred.renovar], ['APP_USR-nuevo', 'TG-nuevo']);
});

prueba('si la cuenta deja de servir, no se cobra hasta que la dueña la conecte de nuevo, y se le avisa una vez', async (e) => {
  const esc = await e.armar();
  const otro = await e.armar('nacar', { nombre: 'Espacio Nácar', duena: 'Inés' });
  await conMercadoPago(e, esc);
  await conMercadoPago(e, otro);
  await conectar(e, esc, { userId: '111' });
  await conectar(e, otro, { userId: '222' });
  const r = await e.reservar(esc, esc.lucia, { fecha: await e.diaHabil(3) });
  // Mercado Pago avisa que la cuenta 111 le quitó el permiso a la aplicación
  assert.equal(await servicio(e, 'mp_cuenta_caida', { p_consultorio: null, p_user_id: '111', p_motivo: 'la dueña quitó el permiso' }), 1);
  assert.equal(await servicio(e, 'mp_cuenta_caida', { p_consultorio: esc.id, p_user_id: null, p_motivo: 'otra vez' }), 0);
  assert.equal((await avisosDe(e, await e.miembro(esc, esc.admin))).filter((a) => a === 'Hay que volver a conectar Mercado Pago').length, 1);
  assert.equal((await e.foto(esc, esc.admin)).config.mp.account.status, 'caida');
  assert.equal((await servicio(e, 'mp_credencial', { p_consultorio: esc.id })).acceso, null);
  await esperarError(preparar(e, esc, esc.lucia, r.id, 'sena'), 'mp_sin_cuenta');
  // el otro consultorio sigue cobrando
  assert.equal((await e.foto(otro, otro.lucia)).site.mp.ready, true);
  // al conectarla de nuevo, vuelve a servir
  await conectar(e, esc, { userId: '111' });
  assert.equal((await preparar(e, esc, esc.lucia, r.id, 'sena')).monto, 20000);
});

prueba('lo de un consultorio no se toca desde otro', async (e) => {
  const a = await e.armar('lavanda');
  const b = await e.armar('nacar', { nombre: 'Espacio Nácar', duena: 'Inés' });
  await conMercadoPago(e, a, 'prueba');
  await conMercadoPago(e, b, 'prueba');
  const r = await e.reservar(a, a.lucia, { fecha: await e.diaHabil(3) });
  const p = await preparar(e, a, a.lucia, r.id, 'sena');
  await esperarError(preparar(e, b, b.lucia, r.id, 'sena'), 'reserva_inexistente');
  await esperarError(e.llamarComo(b.admin, 'mp_pago_mio', { p_slug: b.slug, p_pago: p.pago }), 'pago_inexistente');
  await esperarError(e.llamarComo(b.admin, 'mp_pago_mio', { p_slug: a.slug, p_pago: p.pago }), 'pago_inexistente');
  await esperarError(e.llamarComo(b.lucia, 'mp_consultorio_mio', { p_slug: a.slug }), 'solo_miembros');
  assert.deepEqual(await e.llamarComo(a.lucia, 'mp_consultorio_mio', { p_slug: a.slug }), { consultorio: a.id, admin: false });
  assert.deepEqual(await e.llamarComo(a.admin, 'mp_consultorio_mio', { p_slug: a.slug }), { consultorio: a.id, admin: true });
  await esperarError(e.llamarComo(b.admin, 'mp_conexion_confirmar', { p_slug: a.slug, p_user_id: CUENTA }), 'solo_admin');
  await esperarError(e.llamarComo(b.admin, 'mp_desconectar', { p_slug: a.slug }), 'solo_admin');
});
