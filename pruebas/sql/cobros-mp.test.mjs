// El cobro con Mercado Pago de punta a punta: lo que hace la función de Supabase «mp»
// (supabase/functions/_compartido/cobros.ts) contra la base de verdad (PGlite, con los roles de Supabase) y un
// Mercado Pago simulado (pruebas/mp-simulado.mjs).
import assert from 'node:assert/strict';

import {
  ErrorDeCobro, avisoDeMp, despachar, iniciarConexion, pagar, terminarConexion, verificar, vueltaDelReloj,
} from '../../supabase/functions/_compartido/cobros.ts';
import { crearMpSimulado } from '../mp-simulado.mjs';
import { prueba } from './entorno.mjs';

const REDIRECT = 'https://proyecto.supabase.co/functions/v1/mp';
const VOLVER = 'https://lavanda.entreturno.com.ar/';

function dependencias(e, mp, quien, extra = {}) {
  return {
    rpcUsuario: (fn, args) => e.llamarComo(quien, fn, args),
    rpcServicio: (fn, args) => e.comoRol('service_role', null, (c) => c.llamar(fn, args)),
    app: { clientId: mp.clientId, clientSecret: mp.clientSecret, redirectUri: REDIRECT, paseDePrueba: mp.paseDePrueba },
    fetchFn: mp.fetchFn,
    ...extra,
  };
}

async function esperarCobro(promesa, codigo) {
  await assert.rejects(promesa, (err) => {
    assert.ok(err instanceof ErrorDeCobro, `se esperaba ${codigo} y vino: ${err?.name} ${err?.message}`);
    assert.equal(err.codigo, codigo);
    return true;
  });
}

const conMercadoPago = (e, esc, ambiente = 'real') =>
  e.sql(`update public.consultorios set pagos_modo = 'mercadopago', mp_ambiente = $2 where id = $1`, [esc.id, ambiente]);
const cancelar = (e, esc, quien, reserva) => e.llamarComo(quien, 'cancelar_reserva', { p_slug: esc.slug, p_reserva: reserva });
const avisosDe = async (e, miembro) => (await e.sql(`select asunto from public.avisos where miembro_id = $1 order by creado_en, id`, [miembro])).map((a) => a.asunto);
const reservaDe = (e, id) => e.uno(`select estado from public.reservas where id = $1`, [id]);

/** La dueña conecta su cuenta pasando por «Mercado Pago» y la confirma. */
async function conectar(e, esc, mp, usuario = '111222333', confirmar = true) {
  const dep = dependencias(e, mp, esc.admin);
  const { url } = await iniciarConexion(dep, esc.slug, `https://${esc.slug}.entreturno.com.ar/`);
  const q = new URL(url).searchParams;
  const codigo = mp.autorizar(usuario, { desafio: q.get('code_challenge'), redirectUri: q.get('redirect_uri') });
  const fin = await terminarConexion(dep, { codigo, estado: q.get('state') });
  // una cuenta nueva hay que confirmarla (diciendo cuál se vio); la misma de antes, reconectada, ya sirve
  const como = fin.ok ? (await e.uno(`select estado from interno.mp_cuentas where consultorio_id = $1`, [esc.id])).estado : null;
  if (confirmar && como === 'por_confirmar') await e.llamarComo(esc.admin, 'mp_conexion_confirmar', { p_slug: esc.slug, p_user_id: String(usuario) });
  return { url, q, fin };
}

/** Reserva, aprieta «Pagar», paga en «Mercado Pago» y llega el aviso. */
async function reservarYPagar(e, esc, mp, quien, opciones, tipo = 'sena') {
  const r = await e.reservar(esc, quien, opciones);
  const dep = dependencias(e, mp, quien);
  const { pago, enlace } = await pagar(dep, esc.slug, r.id, tipo, VOLVER);
  const orden = new URL(enlace).searchParams.get('order_id');
  const res = await avisoDeMp(dep, mp.pagar(orden));
  return { reserva: r.id, pago, orden, res };
}

prueba('conectar la cuenta pasando por Mercado Pago: la dirección, el código de una sola vez y la cuenta por confirmar', async (e) => {
  const esc = await e.armar();
  await conMercadoPago(e, esc);
  const mp = crearMpSimulado();
  mp.cuenta('111222333', { nombre: 'Laura Lavanda', email: 'laura@lavanda.prueba' });
  // una profesional no puede iniciar la conexión
  await assert.rejects(iniciarConexion(dependencias(e, mp, esc.lucia), esc.slug, VOLVER), /solo_admin/);

  const { url, q, fin } = await conectar(e, esc, mp, '111222333', false);
  assert.ok(url.startsWith('https://auth.mercadopago.com.ar/authorization?'));
  assert.deepEqual([q.get('client_id'), q.get('response_type'), q.get('platform_id'), q.get('redirect_uri'), q.get('code_challenge_method')],
    [mp.clientId, 'code', 'mp', REDIRECT, 'S256']);
  assert.match(q.get('state'), /^[A-Za-z0-9_-]{43}$/);
  assert.match(q.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(fin, { volverA: VOLVER, ok: true });
  const cuenta = (await e.foto(esc, esc.admin)).config.mp.account;
  assert.deepEqual([cuenta.status, cuenta.userId, cuenta.name, cuenta.email, cuenta.env], ['por_confirmar', '111222333', 'Laura Lavanda', 'laura@lavanda.prueba', 'real']);
  // lo que viajó a Mercado Pago: el código, el verificador y los datos de la aplicación; nada en la dirección
  const pases = mp.pedidos.find((p) => p.que === 'pases');
  assert.deepEqual(Object.keys(pases.cuerpo).sort(), ['client_id', 'client_secret', 'code', 'code_verifier', 'grant_type', 'redirect_uri']);
  assert.equal(pases.ruta, '/oauth/token');

  const dep = dependencias(e, mp, esc.admin);
  // el mismo código de vuelta otra vez, uno inventado o uno mal formado: no hace nada y no dice a dónde volver
  assert.deepEqual(await terminarConexion(dep, { codigo: 'TG-x', estado: q.get('state') }), { volverA: null, ok: false, motivo: 'vencido' });
  assert.deepEqual(await terminarConexion(dep, { codigo: 'TG-x', estado: 'x'.repeat(43) }), { volverA: null, ok: false, motivo: 'vencido' });
  assert.deepEqual(await terminarConexion(dep, { codigo: 'TG-x', estado: 'corto' }), { volverA: null, ok: false, motivo: 'vencido' });
  // la dueña dijo que no en Mercado Pago: vuelve a su página sin cuenta
  const otra = new URL((await iniciarConexion(dep, esc.slug, VOLVER)).url).searchParams;
  assert.deepEqual(await terminarConexion(dep, { codigo: '', estado: otra.get('state') }), { volverA: VOLVER, ok: false, motivo: 'cancelado' });
  // un código que no es de ese intento (otro desafío): Mercado Pago lo rechaza y la cuenta anterior no se pisa
  const tercera = new URL((await iniciarConexion(dep, esc.slug, VOLVER)).url).searchParams;
  const ajeno = mp.autorizar('999', { desafio: 'otro-desafio', redirectUri: REDIRECT });
  assert.deepEqual(await terminarConexion(dep, { codigo: ajeno, estado: tercera.get('state') }), { volverA: VOLVER, ok: false, motivo: 'rechazado' });
  assert.equal((await e.foto(esc, esc.admin)).config.mp.account.userId, '111222333');
});

prueba('una cuenta de otro país no se conecta; en modo prueba se piden pases de prueba', async (e) => {
  const esc = await e.armar();
  await conMercadoPago(e, esc, 'prueba');
  const mp = crearMpSimulado();
  mp.cuenta('555').pais = 'MLB';
  assert.deepEqual((await conectar(e, esc, mp, '555', false)).fin, { volverA: VOLVER, ok: false, motivo: 'pais' });
  assert.equal((await e.foto(esc, esc.admin)).config.mp.account, null);
  await conectar(e, esc, mp, '666');
  assert.equal(mp.pedidos.filter((p) => p.que === 'pases').at(-1).cuerpo.test_token, true);
  assert.equal((await e.foto(esc, esc.admin)).config.mp.account.env, 'prueba');
});

prueba('pagar de punta a punta: la orden que recibe Mercado Pago, el aviso firmado y la reserva confirmada', async (e) => {
  const esc = await e.armar();
  await conMercadoPago(e, esc);
  const mp = crearMpSimulado();
  await conectar(e, esc, mp);
  const dia = await e.diaHabil(3);
  const r = await e.reservar(esc, esc.lucia, { fecha: dia });
  const dep = dependencias(e, mp, esc.lucia);
  const { pago, enlace } = await pagar(dep, esc.slug, r.id, 'sena', VOLVER);
  const orden = new URL(enlace).searchParams.get('order_id');
  assert.ok(enlace.startsWith('https://www.mercadopago.com.ar/checkout/v1/redirect?order_id=ORD'));

  // lo que recibió Mercado Pago
  const pedido = mp.pedidos.find((p) => p.que === 'crear');
  assert.equal(pedido.clave, `${pago}-0`);
  const c = pedido.cuerpo;
  assert.deepEqual([c.type, c.processing_mode, c.capture_mode, c.total_amount, c.external_reference, c.expiration_time],
    ['online', 'manual', 'automatic', '20000.00', pago, 'PT15M']);
  assert.deepEqual(c.items.map((i) => [i.quantity, i.unit_price]), [[1, '20000.00']]);
  assert.match(c.items[0].title, /^Seña · Box 2 · /);
  assert.deepEqual(c.config, {
    online: { success_url: `${VOLVER}?mp=ok`, failure_url: `${VOLVER}?mp=no`, pending_url: `${VOLVER}?mp=espera`, auto_return: 'all' },
    payment_method: { not_allowed_types: ['ticket', 'atm'] },
  });
  assert.match(c.payer.email, /@prueba\.com$/);
  // la plata va a la cuenta del consultorio, no a la de Entreturno
  assert.equal(mp.ordenes.get(orden).user_id, '111222333');

  // otro clic mientras tanto: la misma dirección, sin crear otra orden
  assert.deepEqual(await pagar(dep, esc.slug, r.id, 'sena', VOLVER), { pago, enlace });
  assert.equal(mp.cuantos('crear'), 1);

  // paga y llega el aviso
  const aviso = mp.pagar(orden);
  assert.deepEqual(await avisoDeMp(dep, aviso), { estado: 'aprobado', que: 'aprobado' });
  assert.equal((await reservaDe(e, r.id)).estado, 'confirmada');
  // Mercado Pago repite el aviso: no pasa nada
  assert.deepEqual(await avisoDeMp(dep, aviso), { estado: 'aprobado', repetido: true });
  assert.equal((await e.uno(`select count(*)::int as n from public.pagos where estado = 'aprobado'`)).n, 1);
  // un aviso de una orden que no es nuestra, o de otro tipo, se ignora
  assert.deepEqual(await avisoDeMp(dep, { tipo: 'order', dato: 'ORD00000000000000000000000X', cuerpo: { data: {} } }), { ignorado: 'orden desconocida' });
  assert.deepEqual(await avisoDeMp(dep, { tipo: 'order', dato: '../../etc', cuerpo: {} }), { ignorado: 'sin orden' });
  assert.deepEqual(await avisoDeMp(dep, { tipo: 'payment', dato: '123', cuerpo: {} }), { ignorado: 'payment' });
});

prueba('en modo prueba sin cuenta conectada se cobra con el pase de prueba de Entreturno, y no viaja el mail', async (e) => {
  const esc = await e.armar();
  await conMercadoPago(e, esc, 'prueba');
  const mp = crearMpSimulado();
  const { res, orden, reserva } = await reservarYPagar(e, esc, mp, esc.lucia, { fecha: await e.diaHabil(3) });
  assert.deepEqual(res, { estado: 'aprobado', que: 'aprobado' });
  assert.equal(mp.ordenes.get(orden).user_id, '900900900');
  assert.equal(mp.pedidos.find((p) => p.que === 'crear').cuerpo.payer, undefined);
  assert.equal((await reservaDe(e, reserva)).estado, 'confirmada');
  // sin ese pase cargado en los secretos, lo dice
  const r2 = await e.reservar(esc, esc.caro, { fecha: await e.diaHabil(3), box: 1 });
  const sinPase = dependencias(e, mp, esc.caro);
  sinPase.app.paseDePrueba = '';
  await esperarCobro(pagar(sinPase, esc.slug, r2.id, 'sena', VOLVER), 'falta_configurar');
});

prueba('en modo prueba se cobra con el pase de prueba aunque haya una cuenta conectada (lo que pasó el 25/11/2026)', async (e) => {
  const esc = await e.armar();
  await conMercadoPago(e, esc, 'prueba');
  const mp = crearMpSimulado();
  await conectar(e, esc, mp);                                             // la cuenta de la dueña, confirmada
  assert.equal((await e.foto(esc, esc.admin)).config.mp.account.status, 'conectada');
  const { res, orden, reserva } = await reservarYPagar(e, esc, mp, esc.lucia, { fecha: await e.diaHabil(3) });
  assert.deepEqual(res, { estado: 'aprobado', que: 'aprobado' });
  assert.match(orden, /^ORDTST/);
  assert.equal(mp.ordenes.get(orden).user_id, '900900900');               // la cuenta de ensayo de la aplicación, no la conectada
  assert.equal([...mp.ordenes.values()].filter((o) => o.user_id !== '900900900').length, 0);
  // la devolución sale con el mismo pase
  await cancelar(e, esc, esc.admin, reserva);
  await despachar(dependencias(e, mp, esc.admin), esc.slug);
  assert.equal(mp.ordenes.get(orden).status, 'refunded');
  // ni cobrando, ni con el reloj, ni con un aviso sobre esa cuenta se pidió otro pase: solo el de conectarla
  await e.sql(`update interno.mp_cuentas set vence = now() + interval '5 days'`);
  const dep = dependencias(e, mp, null);
  await vueltaDelReloj(dep);
  mp.revocar('111222333');
  await avisoDeMp(dep, { tipo: 'mp-connect', dato: '111222333', cuerpo: { user_id: 111222333 } });
  assert.equal(mp.cuantos('pases'), 1);
  assert.equal((await e.foto(esc, esc.admin)).config.mp.account.status, 'conectada');
  // y aunque la base le entregara el pase de una cuenta, la función en modo prueba no lo usa
  const real = mp.cuenta('555', { nombre: 'De Verdad' });
  const r = await e.reservar(esc, esc.caro, { fecha: await e.diaHabil(3), box: 1 });
  const normal = dependencias(e, mp, esc.caro);
  const entregado = { ...normal, rpcServicio: (fn, args) => fn === 'mp_credencial'
    ? Promise.resolve({ ambiente: 'prueba', acceso: real.acceso, renovar: real.renovar, cuenta: { userId: '555', estado: 'conectada' } }) : normal.rpcServicio(fn, args) };
  const otra = new URL((await pagar(entregado, esc.slug, r.id, 'sena', VOLVER)).enlace).searchParams.get('order_id');
  assert.equal(mp.ordenes.get(otra).user_id, '900900900');
});

prueba('al conectar, el pase tiene que ser del modo del consultorio: ni uno de verdad en prueba, ni uno de prueba en real', async (e) => {
  const esc = await e.armar();
  const mp = crearMpSimulado();
  const guardados = async () => (await e.uno(`select count(*)::int as n from vault.secrets where name like 'mp\_%'`)).n;
  await conMercadoPago(e, esc, 'prueba');
  mp.fallar('pases', 'real');
  assert.deepEqual((await conectar(e, esc, mp, '777', false)).fin, { volverA: VOLVER, ok: false, motivo: 'ambiente-prueba' });
  mp.fallar('pases', 'estado', { status: 200, cuerpo: { access_token: 'APP_USR-no-se-sabe', expires_in: 15552000, user_id: 777, refresh_token: 'TG-x' } });
  assert.deepEqual((await conectar(e, esc, mp, '777', false)).fin, { volverA: VOLVER, ok: false, motivo: 'ambiente-prueba' });
  await conMercadoPago(e, esc, 'real');
  mp.fallar('pases', 'de-prueba');
  assert.deepEqual((await conectar(e, esc, mp, '777', false)).fin, { volverA: VOLVER, ok: false, motivo: 'ambiente' });
  assert.deepEqual([(await e.foto(esc, esc.admin)).config.mp.account, await guardados()], [null, 0]);
  // y si al renovarlo viniera uno de prueba, la cuenta real queda caída en lugar de «cobrar» de mentira
  await conectar(e, esc, mp, '777');
  mp.revocar('777', { tambienRenovar: false });
  mp.fallar('pases', 'de-prueba');
  const r = await e.reservar(esc, esc.lucia, { fecha: await e.diaHabil(3) });
  await esperarCobro(pagar(dependencias(e, mp, esc.lucia), esc.slug, r.id, 'sena', VOLVER), 'mp_sin_cuenta');
  assert.equal((await e.foto(esc, esc.admin)).config.mp.account.status, 'caida');
  assert.equal(mp.ordenes.size, 0);
});

prueba('una orden que no es del modo del consultorio se cierra enseguida y nadie recibe dónde pagarla', async (e) => {
  for (const ambiente of ['prueba', 'real']) {
    const esc = await e.armar(`lavanda-${ambiente}`);
    await conMercadoPago(e, esc, ambiente);
    const mp = crearMpSimulado();
    if (ambiente === 'real') await conectar(e, esc, mp);
    const dep = dependencias(e, mp, esc.lucia);
    const r = await e.reservar(esc, esc.lucia, { fecha: await e.diaHabil(3) });
    mp.fallar('crear', 'otro-ambiente');
    await esperarCobro(pagar(dep, esc.slug, r.id, 'sena', VOLVER), 'mp_rechazo');
    const mala = [...mp.ordenes.values()].at(-1);
    assert.equal(mala.id.startsWith('ORDTST'), ambiente === 'real');
    assert.equal(mala.status, 'canceled');
    const p = await e.uno(`select proveedor_id, enlace, error from public.pagos where reserva_id = $1`, [r.id]);
    assert.deepEqual([p.proveedor_id, p.enlace], [null, null]);
    assert.equal(p.error, `otro_ambiente: la orden ${mala.id} no es del modo de este consultorio (cerrada)`);
    // el próximo intento, ya del modo que corresponde, anda
    const { enlace } = await pagar(dep, esc.slug, r.id, 'sena', VOLVER);
    assert.equal(enlace.includes('order_id=ORDTST'), ambiente === 'prueba');
    // si además no se deja cerrar, tampoco se entrega: queda anotado cuál fue
    const r2 = await e.reservar(esc, esc.caro, { fecha: await e.diaHabil(3), box: 1 });
    mp.fallar('crear', 'otro-ambiente');
    mp.fallar('cancelar', 'cortar');
    await esperarCobro(pagar(dependencias(e, mp, esc.caro), esc.slug, r2.id, 'sena', VOLVER), 'mp_rechazo');
    const abierta = [...mp.ordenes.values()].at(-1);
    const p2 = await e.uno(`select proveedor_id, enlace, error from public.pagos where reserva_id = $1`, [r2.id]);
    assert.deepEqual(p2, { proveedor_id: null, enlace: null, error: `otro_ambiente: la orden ${abierta.id} no es del modo de este consultorio (quedó sin cerrar)` });
  }
});

prueba('un pago hecho en una orden del otro modo no confirma la reserva: queda para revisar', async (e) => {
  const esc = await e.armar();
  await conMercadoPago(e, esc, 'real');
  const mp = crearMpSimulado();
  await conectar(e, esc, mp);
  const r = await e.reservar(esc, esc.lucia, { fecha: await e.diaHabil(3) });
  const { pago } = await e.llamarComo(esc.lucia, 'mp_pago_preparar', { p_slug: esc.slug, p_reserva: r.id, p_tipo: 'sena' });
  // alguien con un pase de la misma cuenta crea una orden de prueba con nuestra referencia y la «paga»
  mp.fallar('crear', 'otro-ambiente');
  const creada = await (await mp.fetchFn('https://api.mercadopago.com/v1/orders', {
    method: 'POST', headers: { authorization: `Bearer ${mp.cuentas.get('111222333').acceso}`, 'x-idempotency-key': 'otra' },
    body: JSON.stringify({ type: 'online', processing_mode: 'manual', total_amount: '20000.00', external_reference: pago }),
  })).json();
  assert.match(creada.id, /^ORDTST/);
  await avisoDeMp(dependencias(e, mp, null), mp.pagar(creada.id));
  assert.deepEqual(await e.uno(`select estado, proveedor_id from public.pagos where id = $1`, [pago]), { estado: 'revisar', proveedor_id: null });
  assert.equal((await reservaDe(e, r.id)).estado, 'pago');
});

prueba('si se corta al crear la orden, repetir no crea otra; si Mercado Pago la rechaza, el próximo pedido va con otra clave', async (e) => {
  const esc = await e.armar();
  await conMercadoPago(e, esc, 'prueba');
  const mp = crearMpSimulado();
  const r = await e.reservar(esc, esc.lucia, { fecha: await e.diaHabil(3) });
  const dep = dependencias(e, mp, esc.lucia);
  mp.fallar('crear', 'procesar-y-cortar');                       // la orden se creó, pero la respuesta no llegó
  await esperarCobro(pagar(dep, esc.slug, r.id, 'sena', VOLVER), 'mp_sin_respuesta');
  assert.equal(mp.ordenes.size, 1);
  const { enlace } = await pagar(dep, esc.slug, r.id, 'sena', VOLVER);
  assert.equal(mp.ordenes.size, 1, 'se creó una segunda orden para el mismo pago');
  assert.deepEqual(mp.pedidos.filter((p) => p.que === 'crear').map((p) => p.clave.slice(-2)), ['-0', '-0']);
  assert.ok(enlace.includes([...mp.ordenes.keys()][0]));

  const r2 = await e.reservar(esc, esc.caro, { fecha: await e.diaHabil(3), box: 1 });
  const dep2 = dependencias(e, mp, esc.caro);
  mp.fallar('crear', 'estado', { status: 400, cuerpo: { errors: [{ code: 'property_value', message: 'Se envió un valor inválido' }] } });
  await esperarCobro(pagar(dep2, esc.slug, r2.id, 'sena', VOLVER), 'mp_rechazo');
  assert.equal((await e.uno(`select error from public.pagos where reserva_id = $1`, [r2.id])).error, 'property_value: Se envió un valor inválido');
  await pagar(dep2, esc.slug, r2.id, 'sena', VOLVER);
  assert.deepEqual(mp.pedidos.filter((p) => p.que === 'crear').slice(-2).map((p) => p.clave.slice(-2)), ['-0', '-1']);
  assert.equal((await e.uno(`select count(*)::int as n from public.pagos where reserva_id = $1`, [r2.id])).n, 1);
});

prueba('si Mercado Pago no acepta el vencimiento en minutos, la orden se crea igual', async (e) => {
  const esc = await e.armar();
  await conMercadoPago(e, esc, 'prueba');
  const mp = crearMpSimulado();
  const r = await e.reservar(esc, esc.lucia, { fecha: await e.diaHabil(3) });
  mp.fallar('crear', 'sin-minutos');
  const { enlace } = await pagar(dependencias(e, mp, esc.lucia), esc.slug, r.id, 'sena', VOLVER);
  assert.ok(enlace.includes('order_id=ORD'));
  assert.deepEqual(mp.pedidos.filter((p) => p.que === 'crear').map((p) => p.cuerpo.expiration_time), ['PT15M', undefined]);
});

prueba('un aviso no alcanza: se acredita solo lo que Mercado Pago confirma, por el importe y para la cuenta que corresponden', async (e) => {
  const a = await e.armar('lavanda');
  const b = await e.armar('nacar', { nombre: 'Espacio Nácar', duena: 'Inés' });
  await conMercadoPago(e, a);
  await conMercadoPago(e, b);
  const mp = crearMpSimulado();
  await conectar(e, a, mp, '111');
  await conectar(e, b, mp, '222');
  const dia = await e.diaHabil(3);
  const r = await e.reservar(a, a.lucia, { fecha: dia });
  const dep = dependencias(e, mp, a.lucia);
  const { pago, enlace } = await pagar(dep, a.slug, r.id, 'sena', VOLVER);
  const orden = new URL(enlace).searchParams.get('order_id');

  // un aviso «trucho» que dice que está pagada, cuando en Mercado Pago sigue sin pagar: no acredita nada
  const falso = mp.aviso(orden, 'order.processed');
  falso.cuerpo.data.status = 'processed';
  assert.deepEqual(await avisoDeMp(dep, falso), { estado: 'pendiente' });
  assert.equal((await reservaDe(e, r.id)).estado, 'pago');

  // una orden pagada de OTRO consultorio, con nuestra referencia en el aviso: con el pase de Lavanda esa orden no existe
  const rb = await e.reservar(b, b.lucia, { fecha: dia });
  const deB = await pagar(dependencias(e, mp, b.lucia), b.slug, rb.id, 'sena', 'https://nacar.entreturno.com.ar/');
  const ordenB = new URL(deB.enlace).searchParams.get('order_id');
  const avisoB = mp.pagar(ordenB);
  const cruzado = { ...avisoB, cuerpo: { ...avisoB.cuerpo, data: { ...avisoB.cuerpo.data, external_reference: pago } } };
  await e.sql(`update public.pagos set proveedor_id = null where id = $1`, [deB.pago]);      // como si esa orden no se hubiera anotado
  assert.deepEqual(await avisoDeMp(dep, cruzado), { estado: 'pendiente' });
  assert.equal((await reservaDe(e, r.id)).estado, 'pago');
  await e.sql(`update public.pagos set proveedor_id = $2 where id = $1`, [deB.pago, ordenB]);
  assert.deepEqual(await avisoDeMp(dep, avisoB), { estado: 'aprobado', que: 'aprobado' });   // la de Nácar sí se acredita, en Nácar
  assert.equal((await reservaDe(e, rb.id)).estado, 'confirmada');

  // Mercado Pago cobró menos de lo que se pidió: no se confirma, queda para revisar
  assert.deepEqual(await avisoDeMp(dep, mp.pagar(orden, 'aprobado', { monto: 100 })), { estado: 'revisar' });
  assert.equal((await reservaDe(e, r.id)).estado, 'pago');
});

prueba('una orden pagada que no es la de ese pago (otra reserva, otra moneda) no lo acredita: queda para revisar', async (e) => {
  const esc = await e.armar();
  await conMercadoPago(e, esc);
  const mp = crearMpSimulado();
  await conectar(e, esc, mp);
  const dia = await e.diaHabil(3);
  // dos reservas del mismo consultorio y por el mismo importe (misma cuenta de Mercado Pago: el pase sirve para leer las dos órdenes)
  const deLucia = await e.reservar(esc, esc.lucia, { fecha: dia, box: 1 });       // seña $ 20.000
  const deCaro = await e.reservar(esc, esc.caro, { fecha: dia, box: 2, plan: 'total' });
  await e.sql(`update public.reservas set total = 20000, monto_box = 20000, precio_hora = 5000 where id = $1`, [deCaro.id]);
  const a = await pagar(dependencias(e, mp, esc.lucia), esc.slug, deLucia.id, 'sena', VOLVER);
  const b = await pagar(dependencias(e, mp, esc.caro), esc.slug, deCaro.id, 'total', VOLVER);
  const ordenA = new URL(a.enlace).searchParams.get('order_id');
  const ordenB = new URL(b.enlace).searchParams.get('order_id');
  // por un error (nuestro o de Mercado Pago) el pago de Lucía quedó apuntando a la orden de Caro, y Caro paga
  await e.sql(`update public.pagos set proveedor_id = null where id = $1`, [b.pago]);
  await e.sql(`update public.pagos set proveedor_id = $2 where id = $1`, [a.pago, ordenB]);
  mp.pagar(ordenB);
  assert.deepEqual(await verificar(dependencias(e, mp, esc.lucia), esc.slug, a.pago), { estado: 'revisar', reserva: deLucia.id });
  assert.equal((await reservaDe(e, deLucia.id)).estado, 'pago');
  assert.equal((await e.uno(`select interno.pagado($1) as n`, [deLucia.id])).n, 0);
  assert.equal((await avisosDe(e, await e.miembro(esc, esc.admin))).at(-1), 'Un pago para revisar');

  // una orden por el importe justo, pero en otra moneda
  const otra = await e.reservar(esc, esc.lucia, { fecha: dia, box: 3 });
  const c = await pagar(dependencias(e, mp, esc.lucia), esc.slug, otra.id, 'sena', VOLVER);
  const ordenC = new URL(c.enlace).searchParams.get('order_id');
  mp.ordenes.get(ordenC).currency = 'BRL';
  assert.deepEqual(await avisoDeMp(dependencias(e, mp, esc.lucia), mp.pagar(ordenC)), { estado: 'revisar' });
  assert.equal((await reservaDe(e, otra.id)).estado, 'pago');
  // y una orden bien pagada, pero de otra cuenta que la conectada (el número de cuenta no coincide)
  await e.sql(`update public.pagos set proveedor_id = $2 where id = $1`, [a.pago, ordenA]);
  await e.sql(`update public.pagos set estado = 'pendiente', error = null where id = $1`, [a.pago]);
  await e.sql(`update interno.mp_cuentas set mp_user_id = '999888777' where consultorio_id = $1`, [esc.id]);
  assert.deepEqual(await avisoDeMp(dependencias(e, mp, esc.lucia), mp.pagar(ordenA)), { estado: 'revisar' });
  assert.equal((await reservaDe(e, deLucia.id)).estado, 'pago');
});

prueba('«ya pagué, fijate»: al volver de Mercado Pago la página pide que se mire, aunque el aviso no haya llegado', async (e) => {
  const esc = await e.armar();
  await conMercadoPago(e, esc, 'prueba');
  const mp = crearMpSimulado();
  const r = await e.reservar(esc, esc.lucia, { fecha: await e.diaHabil(3) });
  const dep = dependencias(e, mp, esc.lucia);
  const { pago, enlace } = await pagar(dep, esc.slug, r.id, 'sena', VOLVER);
  const orden = new URL(enlace).searchParams.get('order_id');
  assert.deepEqual(await verificar(dep, esc.slug, pago), { estado: 'pendiente', reserva: r.id });
  mp.pagar(orden);                                               // paga, pero el aviso se pierde
  assert.deepEqual(await verificar(dep, esc.slug, pago), { estado: 'aprobado', reserva: r.id });
  assert.equal((await reservaDe(e, r.id)).estado, 'confirmada');
  // otra profesional no puede preguntar por ese pago; la dueña sí
  await assert.rejects(verificar(dependencias(e, mp, esc.caro), esc.slug, pago), /pago_inexistente/);
  assert.equal((await verificar(dependencias(e, mp, esc.admin), esc.slug, pago)).estado, 'aprobado');
  // si Mercado Pago no contesta, dice cómo está hoy y no rompe
  const r2 = await e.reservar(esc, esc.caro, { fecha: await e.diaHabil(3), box: 1 });
  const dep2 = dependencias(e, mp, esc.caro);
  const otro = await pagar(dep2, esc.slug, r2.id, 'sena', VOLVER);
  mp.fallar('leer', 'cortar');
  assert.deepEqual(await verificar(dep2, esc.slug, otro.pago), { estado: 'pendiente', reserva: r2.id });
});

prueba('el reloj: acredita lo que quedó sin avisar, cierra las órdenes viejas y devuelve solo lo que se pagó de más', async (e) => {
  const esc = await e.armar();
  await conMercadoPago(e, esc, 'prueba');
  const mp = crearMpSimulado();
  const dia = await e.diaHabil(3);
  const servicio = dependencias(e, mp, null);
  const vacia = { pagos: 0, cerradas: 0, devoluciones: 0, sobrantes: 0, renovadas: 0, fallas: 0 };
  assert.deepEqual(await vueltaDelReloj(servicio), vacia);

  // 1) pagó y el aviso nunca llegó
  const r1 = await e.reservar(esc, esc.lucia, { fecha: dia });
  const p1 = await pagar(dependencias(e, mp, esc.lucia), esc.slug, r1.id, 'sena', VOLVER);
  mp.pagar(new URL(p1.enlace).searchParams.get('order_id'));
  assert.deepEqual(await vueltaDelReloj(servicio), vacia);        // la orden es de hace segundos: todavía no se mira
  await e.sql(`update public.pagos set actualizado_en = now() - interval '2 minutes' where id = $1`, [p1.pago]);
  assert.deepEqual(await vueltaDelReloj(servicio), { ...vacia, pagos: 1 });
  assert.equal((await reservaDe(e, r1.id)).estado, 'confirmada');

  // 2) canceló sin pagar: la orden que quedó abierta se cierra en Mercado Pago
  const r2 = await e.reservar(esc, esc.caro, { fecha: dia, box: 1 });
  const p2 = await pagar(dependencias(e, mp, esc.caro), esc.slug, r2.id, 'sena', VOLVER);
  const orden2 = new URL(p2.enlace).searchParams.get('order_id');
  await cancelar(e, esc, esc.caro, r2.id);
  assert.deepEqual(await vueltaDelReloj(servicio), { ...vacia, cerradas: 1 });
  assert.equal(mp.ordenes.get(orden2).status, 'canceled');
  assert.deepEqual(await vueltaDelReloj(servicio), vacia);        // ya está: no se vuelve a pedir

  // 3) canceló, pero alcanzó a pagar antes de que la orden se cerrara: la plata se devuelve sola
  const r3 = await e.reservar(esc, esc.caro, { fecha: dia, box: 3 });
  const p3 = await pagar(dependencias(e, mp, esc.caro), esc.slug, r3.id, 'sena', VOLVER);
  const orden3 = new URL(p3.enlace).searchParams.get('order_id');
  await cancelar(e, esc, esc.caro, r3.id);
  mp.pagar(orden3);
  assert.deepEqual(await vueltaDelReloj(servicio), { ...vacia, cerradas: 1 });      // no se dejó cancelar: se miró y quedó como sobrante
  assert.equal((await e.uno(`select estado from public.pagos where id = $1`, [p3.pago])).estado, 'sobrante');
  await e.sql(`update public.pagos set actualizado_en = now() - interval '1 minute' where id = $1`, [p3.pago]);
  assert.deepEqual(await vueltaDelReloj(servicio), { ...vacia, sobrantes: 1 });
  assert.deepEqual([mp.ordenes.get(orden3).status, mp.ordenes.get(orden3).transactions.refunds.map((x) => x.amount)], ['refunded', ['16000.00']]);
  assert.equal((await e.uno(`select estado from public.pagos where id = $1`, [p3.pago])).estado, 'devuelto');
  assert.deepEqual(await vueltaDelReloj(servicio), vacia);
  assert.equal(mp.cuantos('devolver'), 1);
});

prueba('las devoluciones salen al cancelar, por el importe justo y una sola vez', async (e) => {
  const esc = await e.armar();
  await conMercadoPago(e, esc);
  const mp = crearMpSimulado();
  await conectar(e, esc, mp);
  await e.sql(`update public.consultorios set pol_total_despues = 75 where id = $1`, [esc.id]);
  const lejos = await e.diaHabil(10);
  const cerca = await e.diaHabil(2);

  // seña, con anticipación: se devuelve entera
  const a = await reservarYPagar(e, esc, mp, esc.lucia, { fecha: lejos });
  assert.equal((await cancelar(e, esc, esc.lucia, a.reserva)).amount, 20000);
  assert.deepEqual(await despachar(dependencias(e, mp, esc.lucia), esc.slug), { pagos: 0, cerradas: 0, devoluciones: 1, sobrantes: 0, renovadas: 0, fallas: 0 });
  assert.deepEqual([mp.ordenes.get(a.orden).status, mp.ordenes.get(a.orden).transactions.refunds.map((x) => x.amount)], ['refunded', ['20000.00']]);
  assert.equal((await e.foto(esc, esc.lucia)).bookings.find((x) => x.id === a.reserva).refund.done, true);
  // pedir que salgan de nuevo no devuelve otra vez
  await despachar(dependencias(e, mp, esc.admin), esc.slug);
  assert.equal(mp.cuantos('devolver'), 1);

  // seña + saldo, con poco tiempo: 75 % → el saldo entero y una parte de la seña
  const b = await e.reservar(esc, esc.lucia, { fecha: cerca, box: 3 });             // $ 48.000
  const dep = dependencias(e, mp, esc.lucia);
  const sena = await pagar(dep, esc.slug, b.id, 'sena', VOLVER);
  const ordenSena = new URL(sena.enlace).searchParams.get('order_id');
  await avisoDeMp(dep, mp.pagar(ordenSena));
  const saldo = await pagar(dep, esc.slug, b.id, 'saldo', VOLVER);
  const ordenSaldo = new URL(saldo.enlace).searchParams.get('order_id');
  await avisoDeMp(dep, mp.pagar(ordenSaldo));
  assert.equal((await cancelar(e, esc, esc.lucia, b.id)).amount, 36000);
  // la cuenta de la dueña no tiene saldo: sale lo que se puede... nada; queda esperando y ella se entera
  mp.cuenta('111222333').sinSaldo = true;
  assert.equal((await despachar(dep, esc.slug)).fallas, 1);
  assert.equal((await avisosDe(e, await e.miembro(esc, esc.admin))).at(-1), 'Una devolución no pudo salir: Lucía Ferrari');
  assert.match((await e.uno(`select error from public.pagos where tipo = 'devolucion' and estado = 'pendiente'`)).error, /^insufficient_money/);
  assert.equal((await e.foto(esc, esc.lucia)).bookings.find((x) => x.id === b.id).refund.done, false);
  // cuando hay saldo, el reloj la termina
  mp.cuenta('111222333').sinSaldo = false;
  await e.sql(`update public.pagos set actualizado_en = now() - interval '11 minutes' where tipo = 'devolucion' and estado = 'pendiente'`);
  assert.equal((await vueltaDelReloj(dependencias(e, mp, null))).devoluciones, 1);
  assert.deepEqual(mp.ordenes.get(ordenSaldo).transactions.refunds.map((x) => x.amount), ['24000.00']);
  assert.deepEqual([mp.ordenes.get(ordenSena).status_detail, mp.ordenes.get(ordenSena).transactions.refunds.map((x) => x.amount)], ['partially_refunded', ['12000.00']]);
  assert.equal((await e.foto(esc, esc.lucia)).bookings.find((x) => x.id === b.id).refund.done, true);
  // lo que viajó para la parte: el pago adentro de la orden y el importe
  const parcial = mp.pedidos.filter((p) => p.que === 'devolver').at(-1);
  assert.deepEqual(parcial.cuerpo, { transactions: [{ id: mp.ordenes.get(ordenSena).transactions.payments[0].id, amount: '12000.00' }] });
  assert.match(parcial.clave, /^dev-[0-9a-f-]{36}-2$/);
});

prueba('si la respuesta de una devolución se pierde, o la dueña ya la hizo desde Mercado Pago, no se devuelve dos veces', async (e) => {
  const esc = await e.armar();
  await conMercadoPago(e, esc);
  const mp = crearMpSimulado();
  await conectar(e, esc, mp);
  const lejos = await e.diaHabil(10);
  const reloj = dependencias(e, mp, null);
  const atrasar = () => e.sql(`update public.pagos set actualizado_en = now() - interval '11 minutes' where tipo = 'devolucion' and estado = 'pendiente'`);

  // la devolución salió, pero la respuesta no llegó
  const a = await reservarYPagar(e, esc, mp, esc.lucia, { fecha: lejos });
  await cancelar(e, esc, esc.lucia, a.reserva);
  mp.fallar('devolver', 'procesar-y-cortar');
  assert.equal((await vueltaDelReloj(reloj)).fallas, 1);
  assert.deepEqual(mp.ordenes.get(a.orden).transactions.refunds.map((x) => x.amount), ['20000.00']);
  await atrasar();
  assert.equal((await vueltaDelReloj(reloj)).devoluciones, 1);
  assert.deepEqual(mp.ordenes.get(a.orden).transactions.refunds.map((x) => x.amount), ['20000.00'], 'se devolvió dos veces');
  assert.equal((await e.uno(`select estado from public.pagos where reserva_id = $1 and tipo = 'devolucion'`, [a.reserva])).estado, 'aprobado');

  // la dueña la devolvió por su cuenta, desde Mercado Pago, antes de que el sistema llegara
  const b = await reservarYPagar(e, esc, mp, esc.caro, { fecha: lejos, box: 1 });
  await cancelar(e, esc, esc.caro, b.reserva);
  const cuenta = mp.cuenta('111222333');
  await mp.fetchFn(`https://api.mercadopago.com/v1/orders/${b.orden}/refund`, { method: 'POST', headers: { Authorization: `Bearer ${cuenta.acceso}`, 'X-Idempotency-Key': 'a-mano' } });
  assert.equal((await vueltaDelReloj(reloj)).devoluciones, 1);
  assert.equal(mp.ordenes.get(b.orden).transactions.refunds.length, 1);
  assert.equal((await e.uno(`select estado from public.pagos where reserva_id = $1 and tipo = 'devolucion'`, [b.reserva])).estado, 'aprobado');
});

prueba('si Mercado Pago rechaza el pase, se renueva solo; si no se puede, la cuenta queda caída y la dueña se entera', async (e) => {
  const esc = await e.armar();
  await conMercadoPago(e, esc);
  const mp = crearMpSimulado();
  await conectar(e, esc, mp);
  const dia = await e.diaHabil(3);
  const servicio = (fn, args) => e.comoRol('service_role', null, (c) => c.llamar(fn, args));

  // el pase se venció antes de tiempo: se renueva en el momento y el cobro sale igual
  const viejo = (await servicio('mp_credencial', { p_consultorio: esc.id })).acceso;
  mp.revocar('111222333', { tambienRenovar: false });
  const r = await e.reservar(esc, esc.lucia, { fecha: dia });
  const { enlace } = await pagar(dependencias(e, mp, esc.lucia), esc.slug, r.id, 'sena', VOLVER);
  assert.ok(enlace.includes('order_id=ORD'));
  const nuevo = (await servicio('mp_credencial', { p_consultorio: esc.id })).acceso;
  assert.notEqual(nuevo, viejo);
  assert.equal(nuevo, mp.cuenta('111222333').acceso);

  // la dueña le quitó el permiso a la aplicación: no hay forma de renovar
  mp.revocar('111222333');
  const r2 = await e.reservar(esc, esc.caro, { fecha: dia, box: 1 });
  await esperarCobro(pagar(dependencias(e, mp, esc.caro), esc.slug, r2.id, 'sena', VOLVER), 'mp_sin_cuenta');
  assert.equal((await e.foto(esc, esc.admin)).config.mp.account.status, 'caida');
  assert.equal((await avisosDe(e, await e.miembro(esc, esc.admin))).at(-1), 'Hay que volver a conectar Mercado Pago');
  assert.equal((await e.foto(esc, esc.caro)).site.mp.ready, false);
  await assert.rejects(pagar(dependencias(e, mp, esc.caro), esc.slug, r2.id, 'sena', VOLVER), /mp_sin_cuenta/);
});

prueba('el reloj renueva los pases que están por vencer, y Mercado Pago avisa cuando una cuenta quita el permiso', async (e) => {
  const esc = await e.armar();
  await conMercadoPago(e, esc);
  const mp = crearMpSimulado();
  await conectar(e, esc, mp);
  const reloj = dependencias(e, mp, null);
  const servicio = (fn, args) => e.comoRol('service_role', null, (c) => c.llamar(fn, args));
  const antes = (await servicio('mp_credencial', { p_consultorio: esc.id, p_con_renovar: true }));
  await e.sql(`update interno.mp_cuentas set vence = now() + interval '10 days' where consultorio_id = $1`, [esc.id]);
  // un corte: se anota y se prueba mañana
  mp.fallar('pases', 'cortar');
  assert.equal((await vueltaDelReloj(reloj)).fallas, 1);
  assert.equal((await vueltaDelReloj(reloj)).renovadas, 0);
  await e.sql(`update interno.mp_cuentas set renovada_en = now() - interval '2 days' where consultorio_id = $1`, [esc.id]);
  assert.equal((await vueltaDelReloj(reloj)).renovadas, 1);
  const despues = (await servicio('mp_credencial', { p_consultorio: esc.id, p_con_renovar: true }));
  assert.ok(despues.acceso !== antes.acceso && despues.renovar !== antes.renovar);
  assert.ok(Date.parse(despues.cuenta.vence) > Date.now() + 170 * 864e5);

  // El aviso de Mercado Pago «esa cuenta le quitó el permiso a la aplicación». Esa parte del aviso no viene firmada,
  // así que no se le cree: se prueba el pase. Si sigue sirviendo, no pasa nada (un aviso trucho no tira una cuenta).
  const aviso = { tipo: 'mp-connect', dato: '111222333', cuerpo: { action: 'application.deauthorized', type: 'mp-connect', user_id: 111222333 } };
  assert.deepEqual(await avisoDeMp(reloj, aviso), { cuentasComprobadas: 1, cuentasCaidas: 0 });
  assert.equal((await e.foto(esc, esc.admin)).config.mp.account.status, 'conectada');
  assert.deepEqual(await avisoDeMp(reloj, { ...aviso, cuerpo: { ...aviso.cuerpo, user_id: 555 } }), { cuentasComprobadas: 0, cuentasCaidas: 0 });
  assert.deepEqual(await avisoDeMp(reloj, { tipo: 'mp-connect', dato: 'x', cuerpo: { user_id: 'no es un número' } }), { ignorado: 'mp-connect' });
  // cuando de verdad le quitó el permiso, el pase ya no sirve ni se puede renovar: queda caída y la dueña se entera
  mp.revocar('111222333');
  assert.deepEqual(await avisoDeMp(reloj, aviso), { cuentasComprobadas: 1, cuentasCaidas: 1 });
  assert.equal((await e.foto(esc, esc.admin)).config.mp.account.status, 'caida');
  assert.equal((await avisosDe(e, await e.miembro(esc, esc.admin))).at(-1), 'Hay que volver a conectar Mercado Pago');
});

prueba('si llega un pago y la cuenta está desconectada, queda en duda, la dueña se entera, y al reconectar se resuelve solo', async (e) => {
  const esc = await e.armar();
  await conMercadoPago(e, esc);
  const mp = crearMpSimulado();
  await conectar(e, esc, mp);
  const r = await e.reservar(esc, esc.lucia, { fecha: await e.diaHabil(3) });
  const dep = dependencias(e, mp, esc.lucia);
  const { pago, enlace } = await pagar(dep, esc.slug, r.id, 'sena', VOLVER);
  const orden = new URL(enlace).searchParams.get('order_id');
  // la dueña le quita el permiso a la aplicación en Mercado Pago, y la profesional (que ya tenía abierta la pantalla) paga igual
  mp.revocar('111222333');
  await esperarCobro(avisoDeMp(dep, mp.pagar(orden)), 'mp_sin_cuenta');
  assert.equal((await reservaDe(e, r.id)).estado, 'pago');
  assert.equal((await e.uno(`select datos ? 'sin_comprobar' as s from public.pagos where id = $1`, [pago])).s, true);
  const mails = await avisosDe(e, await e.miembro(esc, esc.admin));
  assert.deepEqual(mails.slice(-2), ['Hay que volver a conectar Mercado Pago', 'Un pago de Mercado Pago sin comprobar']);
  // no puede sacar ni cambiar la cuenta dejando ese cobro en el aire
  await assert.rejects(e.llamarComo(esc.admin, 'mp_desconectar', { p_slug: esc.slug }), /mp_con_pendientes/);
  assert.deepEqual((await conectar(e, esc, mp, '999000111')).fin, { volverA: VOLVER, ok: false, motivo: 'pendientes' });
  assert.equal((await e.foto(esc, esc.admin)).config.mp.account.userId, '111222333');
  // reconecta la misma cuenta: sirve enseguida, y el reloj comprueba el pago y confirma la reserva
  assert.deepEqual((await conectar(e, esc, mp)).fin, { volverA: VOLVER, ok: true });
  assert.equal((await e.foto(esc, esc.admin)).config.mp.account.status, 'conectada');
  await e.sql(`update public.pagos set actualizado_en = now() - interval '11 minutes' where id = $1`, [pago]);
  assert.equal((await vueltaDelReloj(dependencias(e, mp, null))).pagos, 1);
  assert.equal((await reservaDe(e, r.id)).estado, 'confirmada');
  assert.equal((await e.uno(`select datos ? 'sin_comprobar' as s from public.pagos where id = $1`, [pago])).s, false);
});

prueba('lo que se cobró con una cuenta no se intenta devolver con otra: se le dice a la dueña', async (e) => {
  const esc = await e.armar();
  await conMercadoPago(e, esc);
  const mp = crearMpSimulado();
  await conectar(e, esc, mp, '111');
  const a = await reservarYPagar(e, esc, mp, esc.lucia, { fecha: await e.diaHabil(10) });
  assert.equal((await e.uno(`select datos ->> 'cuenta' as c from public.pagos where id = $1`, [a.pago])).c, '111');
  // sin nada pendiente, la dueña cambia de cuenta
  assert.deepEqual((await conectar(e, esc, mp, '222')).fin, { volverA: VOLVER, ok: true });
  assert.equal((await e.foto(esc, esc.admin)).config.mp.account.userId, '222');
  // y después se cancela aquella reserva: la plata está en la cuenta 111
  await cancelar(e, esc, esc.lucia, a.reserva);
  assert.equal((await despachar(dependencias(e, mp, esc.lucia), esc.slug)).fallas, 1);
  assert.equal(mp.cuantos('devolver'), 0, 'se le pidió una devolución a Mercado Pago con la cuenta equivocada');
  const dev = await e.uno(`select id, estado, error from public.pagos where tipo = 'devolucion'`);
  assert.deepEqual([dev.estado, dev.error], ['pendiente', 'otra_cuenta: ese pago se cobró con otra cuenta de Mercado Pago']);
  assert.equal((await avisosDe(e, await e.miembro(esc, esc.admin))).at(-1), 'Una devolución no pudo salir: Lucía Ferrari');
  // la dueña la hace desde la otra cuenta y la anota
  assert.deepEqual(await e.llamarComo(esc.admin, 'mp_devolucion_a_mano', { p_slug: esc.slug, p_devolucion: dev.id }), { ok: true });
  assert.equal((await e.foto(esc, esc.lucia)).bookings[0].refund.done, true);
});

prueba('dos vueltas a la vez no ejecutan la misma devolución', async (e) => {
  const esc = await e.armar();
  await conMercadoPago(e, esc, 'prueba');
  const mp = crearMpSimulado();
  const a = await reservarYPagar(e, esc, mp, esc.lucia, { fecha: await e.diaHabil(10) });
  await cancelar(e, esc, esc.lucia, a.reserva);
  // el reloj del servidor y «que salga ya» de la página, en el mismo instante
  const vueltas = await Promise.all([vueltaDelReloj(dependencias(e, mp, null)), despachar(dependencias(e, mp, esc.lucia), esc.slug)]);
  assert.equal(mp.cuantos('devolver'), 1);
  assert.deepEqual(vueltas.map((v) => v.devoluciones).sort(), [0, 1]);
  assert.deepEqual(vueltas.map((v) => v.fallas), [0, 0]);
  assert.deepEqual(mp.ordenes.get(a.orden).transactions.refunds.map((x) => x.amount), ['20000.00']);
  assert.equal((await e.uno(`select estado from public.pagos where tipo = 'devolucion'`)).estado, 'aprobado');
});
