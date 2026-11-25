// Lo que habla con Mercado Pago (supabase/functions/_compartido/mp.ts), sin internet: la firma de los avisos, el
// desafío de PKCE, lo que se manda para cobrar, cómo se lee una orden y cómo se cuentan los errores.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';

import {
  ErrorMp, aleatorio, crearOrden, cuerpoDeOrden, desafioDe, devolverOrden, esDireccionDePago, firmaValida, leerOrden, resumenDe, urlAutorizar,
} from '../supabase/functions/_compartido/mp.ts';

const SECRETO = 'firma-secreta-de-prueba';
const firmar = (manifiesto, secreto = SECRETO) => createHmac('sha256', secreto).update(manifiesto).digest('hex');

test('la firma de un aviso: vale solo con la firma secreta, para ese dato, ese pedido y ese momento', async () => {
  const dato = 'ORD01JQ4S4KY8HWQ6NA5PXB65B3D3';
  const pedido = '2066ca19-c6f1-498a-be75-1923005edd06';
  const ts = '1742505638683';
  const v1 = firmar(`id:${dato};request-id:${pedido};ts:${ts};`);
  const firma = `ts=${ts},v1=${v1}`;
  assert.equal(await firmaValida({ firma, pedido, dato, secreto: SECRETO }), true);
  assert.equal(await firmaValida({ firma: ` v1=${v1.toUpperCase()} , ts=${ts} `, pedido, dato, secreto: SECRETO }), true);     // otro orden, espacios, mayúsculas
  // si Mercado Pago firmó con el número de orden en minúsculas, también vale
  const enMinusculas = `ts=${ts},v1=${firmar(`id:${dato.toLowerCase()};request-id:${pedido};ts:${ts};`)}`;
  assert.equal(await firmaValida({ firma: enMinusculas, pedido, dato, secreto: SECRETO }), true);
  // sin número de pedido o sin dato, esas partes no entran en la cuenta
  assert.equal(await firmaValida({ firma: `ts=${ts},v1=${firmar(`id:${dato};ts:${ts};`)}`, pedido: null, dato, secreto: SECRETO }), true);
  assert.equal(await firmaValida({ firma: `ts=${ts},v1=${firmar(`request-id:${pedido};ts:${ts};`)}`, pedido, dato: '', secreto: SECRETO }), true);

  const malas = [
    { firma, pedido, dato, secreto: 'otra-firma-secreta' },
    { firma, pedido, dato: 'ORD01OTRAORDEN0000000000000000', secreto: SECRETO },
    { firma, pedido: 'otro-pedido', dato, secreto: SECRETO },
    { firma: `ts=${Number(ts) + 1},v1=${v1}`, pedido, dato, secreto: SECRETO },
    { firma: `ts=${ts},v1=${v1.slice(0, -1)}0`, pedido, dato, secreto: SECRETO },
    { firma: `ts=${ts},v1=${v1.slice(0, 20)}`, pedido, dato, secreto: SECRETO },
    { firma: `ts=${ts}`, pedido, dato, secreto: SECRETO },
    { firma: `v1=${v1}`, pedido, dato, secreto: SECRETO },
    { firma: `ts=mañana,v1=${v1}`, pedido, dato, secreto: SECRETO },
    { firma: '', pedido, dato, secreto: SECRETO },
    { firma: null, pedido, dato, secreto: SECRETO },
    { firma, pedido, dato, secreto: '' },
  ];
  for (const [i, m] of malas.entries()) assert.equal(await firmaValida(m), false, `tendría que ser inválida la ${i}`);
});

test('una firma vieja no vale para siempre: con antigüedad máxima, un aviso de hace días (o del futuro) se rechaza', async () => {
  const dato = 'ORD01JQ4S4KY8HWQ6NA5PXB65B3D3';
  const pedido = 'pedido-1';
  const AHORA = Date.UTC(2026, 10, 24, 15, 0, 0);
  const DOS_DIAS = 2 * 86400;
  const con = (ts) => ({ firma: `ts=${ts},v1=${firmar(`id:${dato};request-id:${pedido};ts:${ts};`)}`, pedido, dato, secreto: SECRETO, ahora: AHORA, maxAntiguedadSeg: DOS_DIAS });
  // el momento puede venir en milésimas (13 cifras) o en segundos (10)
  assert.equal(await firmaValida(con(AHORA - 5000)), true);
  assert.equal(await firmaValida(con(Math.floor(AHORA / 1000) - 5)), true);
  assert.equal(await firmaValida(con(AHORA - 47 * 3600e3)), true);                 // el reintento de Mercado Pago de las 48 horas todavía entra
  assert.equal(await firmaValida(con(AHORA - 49 * 3600e3)), false);
  assert.equal(await firmaValida(con(Math.floor(AHORA / 1000) - 3 * 86400)), false);
  assert.equal(await firmaValida(con(AHORA + 2 * 3600e3)), false);                 // «firmado» dentro de dos horas
  assert.equal(await firmaValida(con(AHORA + 10 * 60e3)), true);                   // un reloj corrido unos minutos no molesta
  // sin pedir antigüedad máxima no se mira el momento (así se usa en las pruebas de arriba)
  assert.equal(await firmaValida({ ...con(AHORA - 30 * 86400e3), maxAntiguedadSeg: undefined }), true);
});

test('solo se manda a pagar a Mercado Pago', () => {
  for (const u of ['https://www.mercadopago.com.ar/checkout/v1/redirect?order_id=ORD1', 'https://mercadopago.com.ar/x', 'https://sandbox.mercadopago.com.ar/x', 'https://www.mercadopago.com/x']) {
    assert.equal(esDireccionDePago(u), true, u);
  }
  for (const u of ['http://www.mercadopago.com.ar/x', 'https://mercadopago.com.ar.malo.com/x', 'https://malomercadopago.com.ar/x', 'https://www.mercadopago.com.ar:8443/x',
    'https://usuario:clave@www.mercadopago.com.ar/x', 'https://www.mercadopago.com.ar@malo.com/x', 'javascript:alert(1)', 'http://localhost:8092/__mp/pagar', '', 'no es una dirección']) {
    assert.equal(esDireccionDePago(u), false, u);
  }
  // el servidor de prueba de la compu sí puede usar su propia pantalla de pago
  assert.equal(esDireccionDePago('http://localhost:8092/__mp/pagar?order_id=ORD1', true), true);
  assert.equal(esDireccionDePago('http://127.0.0.1:8092/__mp/pagar', true), true);
  assert.equal(esDireccionDePago('http://malo.com/__mp/pagar', true), false);
});

test('el desafío de PKCE da lo que dice la norma, y los textos al azar no se repiten', async () => {
  // el ejemplo del RFC 7636, apéndice B
  assert.equal(await desafioDe('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  const a = aleatorio(32);
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.match(aleatorio(48), /^[A-Za-z0-9_-]{64}$/);
  assert.notEqual(a, aleatorio(32));
  const u = new URL(urlAutorizar({ clientId: '123', estado: a, redirectUri: 'https://x.supabase.co/functions/v1/mp', desafio: 'D' }));
  assert.equal(`${u.origin}${u.pathname}`, 'https://auth.mercadopago.com.ar/authorization');
  assert.deepEqual(Object.fromEntries(u.searchParams), { client_id: '123', response_type: 'code', platform_id: 'mp', state: a,
    redirect_uri: 'https://x.supabase.co/functions/v1/mp', code_challenge: 'D', code_challenge_method: 'S256' });
});

test('lo que se manda para cobrar sale siempre igual para el mismo intento', () => {
  const p = { monto: 20000, referencia: '11111111-2222-3333-4444-555555555555', titulo: 'Seña · Box 2', descripcion: 'Consultorio: alquiler de Box 2',
    email: 'lucia@prueba.com', minutos: 15, volverA: 'https://lavanda.entreturno.com.ar/' };
  const c = cuerpoDeOrden(p);
  assert.equal(JSON.stringify(c), JSON.stringify(cuerpoDeOrden({ ...p })));
  assert.deepEqual([c.total_amount, c.items[0].unit_price, c.expiration_time, c.payer], ['20000.00', '20000.00', 'PT15M', { email: 'lucia@prueba.com' }]);
  assert.equal(cuerpoDeOrden({ ...p, email: null }).payer, undefined);
  assert.equal(cuerpoDeOrden({ ...p, minutos: 0.4 }).expiration_time, 'PT1M');
});

test('cómo se lee una orden: estado, lo pagado, el pago de adentro y lo ya devuelto', () => {
  const o = resumenDe({
    id: 'ORD01KS5AJ6HTK2HRQ3XJ3C2JCKP9', status: 'processed', status_detail: 'partially_refunded', external_reference: 'ref-1', user_id: 1858095454,
    currency: 'ARS', total_amount: '48000.00', total_paid_amount: '48000.00', checkout_url: 'https://www.mercadopago.com.ar/checkout/v1/redirect?order_id=X',
    transactions: { payments: [{ id: 'PAY-A', status: 'failed' }, { id: 'PAY-B', status: 'processed', refunded_amount: '12000.00' }],
      refunds: [{ id: 'REF-1', transaction_id: 'PAY-B', amount: '12000.00' }] },
  });
  assert.deepEqual([o.id, o.estado, o.detalle, o.referencia, o.usuario, o.moneda, o.total, o.pagado, o.transaccion, o.devuelto, o.devolucion],
    ['ORD01KS5AJ6HTK2HRQ3XJ3C2JCKP9', 'processed', 'partially_refunded', 'ref-1', '1858095454', 'ARS', 48000, 48000, 'PAY-B', 12000, 'REF-1']);
  const nueva = resumenDe({ id: 'ORD0000001', status: 'created' });
  assert.deepEqual([nueva.pagado, nueva.transaccion, nueva.devuelto, nueva.enlace], [0, '', 0, '']);
  assert.throws(() => resumenDe({ status: 'created' }), ErrorMp);
  assert.throws(() => resumenDe({ id: '../../x' }), ErrorMp);
});

test('los errores: qué se puede repetir y qué no, y nunca aparece el pase', async () => {
  const PASE = 'APP_USR-pase-muy-secreto';
  const con = (estado, cuerpo) => async () => new Response(typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo), { status: estado });
  const fallo = async (fetchFn) => {
    try {
      await leerOrden({ acceso: PASE, orden: 'ORD0000001', fetchFn });
    } catch (e) {
      assert.ok(e instanceof ErrorMp);
      assert.ok(!`${e.message} ${e.codigo} ${e.stack}`.includes(PASE), 'el pase aparece en el error');
      return [e.codigo, e.estado, e.definitivo];
    }
    throw new Error('tenía que fallar');
  };
  assert.deepEqual(await fallo(con(400, { errors: [{ code: 'property_value', message: 'valor inválido' }] })), ['property_value', 400, true]);
  assert.deepEqual(await fallo(con(401, { errors: [{ code: 'invalid_credentials' }] })), ['invalid_credentials', 401, true]);
  assert.deepEqual(await fallo(con(404, { errors: [{ code: 'order_not_found' }] })), ['order_not_found', 404, true]);
  assert.deepEqual(await fallo(con(400, { message: 'invalid client', error: 'invalid_client', status: 400 })), ['invalid_client', 400, true]);
  assert.deepEqual(await fallo(con(423, { errors: [{ code: 'resource_locked' }] })), ['resource_locked', 423, false]);
  assert.deepEqual(await fallo(con(429, { errors: [{ code: 'too_many_requests' }] })), ['too_many_requests', 429, false]);
  assert.deepEqual(await fallo(con(500, 'se rompió')), ['http_500', 500, false]);
  assert.deepEqual(await fallo(con(200, 'esto no es JSON')), ['respuesta_rara', 200, false]);
  assert.deepEqual(await fallo(async () => { throw new TypeError('fetch failed'); }), ['sin_respuesta', 0, false]);
  // un código con caracteres raros no se copia tal cual
  assert.deepEqual((await fallo(con(400, { errors: [{ code: '<script>alert(1)</script>' }] })))[0], 'script alert(1) /script');

  // lo que viaja: el pase en la cabecera (nunca en la dirección), la clave para no repetir y el cuerpo
  const vistos = [];
  const anotar = async (url, init) => {
    vistos.push({ url: String(url), metodo: init.method, cabeceras: init.headers, cuerpo: init.body });
    return new Response(JSON.stringify({ id: 'ORD0000001', status: 'created', checkout_url: 'https://www.mercadopago.com.ar/x' }), { status: 201 });
  };
  await crearOrden({ acceso: PASE, clave: 'clave-1', cuerpo: { type: 'online' }, fetchFn: anotar });
  await devolverOrden({ acceso: PASE, orden: 'ORD/raro?x', clave: 'dev-1', fetchFn: anotar });
  await devolverOrden({ acceso: PASE, orden: 'ORD0000001', clave: 'dev-2', transaccion: 'PAY1', monto: 12000, fetchFn: anotar });
  assert.deepEqual(vistos.map((v) => [v.metodo, v.url, v.cabeceras['X-Idempotency-Key'], v.cuerpo]), [
    ['POST', 'https://api.mercadopago.com/v1/orders', 'clave-1', '{"type":"online"}'],
    ['POST', 'https://api.mercadopago.com/v1/orders/ORD%2Fraro%3Fx/refund', 'dev-1', undefined],
    ['POST', 'https://api.mercadopago.com/v1/orders/ORD0000001/refund', 'dev-2', '{"transactions":[{"id":"PAY1","amount":"12000.00"}]}'],
  ]);
  assert.ok(vistos.every((v) => v.cabeceras.Authorization === `Bearer ${PASE}` && !v.url.includes(PASE)));
});
