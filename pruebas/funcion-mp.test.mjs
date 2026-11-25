// La función de Supabase «mp» TAL COMO SE SUBE (publicar/funcion-mp/index.ts, armada en un solo archivo), corrida en
// Node con un «Deno» de mentira contra el servidor de prueba (base + API) y el Mercado Pago simulado.
// Así se prueba lo que no ven las otras pruebas: el armado, quién puede pedir cada cosa, los orígenes y los secretos.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { CLAVE_DE_PRUEBA, DUENA, PROFESIONALES } from './datos-de-ejemplo.mjs';
import { CLAVE_PUBLICA, CLAVE_SECRETA, crearServidor } from './servidor-local.mjs';

let s;
let manejador;
let carpeta;
let armada;
const env = {};
const fetchOriginal = globalThis.fetch;
const ORIGEN = 'https://lavanda.entreturno.com.ar';

const PAGO_DE_VERDAD = 'https://www.mercadopago.com.ar/checkout/v1/redirect';

before(async () => {
  s = await crearServidor();
  // la función que se sube solo manda a pagar a Mercado Pago: acá el simulado contesta con una dirección de Mercado Pago,
  // no con la pantalla de pago que usa el servidor de prueba para la página
  s.mp.paginaDePago = PAGO_DE_VERDAD;
  execFileSync(process.execPath, [fileURLToPath(new URL('../publicar/armar_funcion.mjs', import.meta.url))]);
  armada = readFileSync(new URL('../publicar/funcion-mp/index.ts', import.meta.url), 'utf8');
  carpeta = mkdtempSync(path.join(tmpdir(), 'funcion-mp-'));
  const archivo = path.join(carpeta, 'index.ts');
  writeFileSync(archivo, armada);
  globalThis.Deno = { env: { get: (k) => env[k] }, serve: (fn) => { manejador = fn; } };
  // los pedidos a Mercado Pago van al simulado del servidor; el resto, a la red de verdad (el servidor de prueba)
  globalThis.fetch = (url, init) => (/^https:\/\/api\.mercadopago\.com\//.test(String(url)) ? s.mp.fetchFn(url, init) : fetchOriginal(url, init));
  await import(pathToFileURL(archivo).href);
  Object.assign(env, {
    SUPABASE_URL: s.url, SUPABASE_ANON_KEY: CLAVE_PUBLICA, SUPABASE_SERVICE_ROLE_KEY: CLAVE_SECRETA,
    MP_CLIENT_ID: s.mp.clientId, MP_CLIENT_SECRET: ` ${s.mp.clientSecret}\n`,     // pegado con un espacio y un salto de más
    MP_WEBHOOK_SECRETO: s.mp.secretoAvisos, MP_PRUEBA_TOKEN: s.mp.paseDePrueba,
  });
  await s.pg.query(`update public.consultorios set pagos_modo = 'mercadopago', mp_ambiente = 'prueba' where slug = 'lavanda'`);
});

after(async () => {
  globalThis.fetch = fetchOriginal;
  delete globalThis.Deno;
  if (carpeta) rmSync(carpeta, { recursive: true, force: true });
  if (s) await s.cerrar();
});

async function pase(email) {
  const r = await fetchOriginal(`${s.url}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: CLAVE_PUBLICA, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: CLAVE_DE_PRUEBA }),
  });
  return (await r.json()).access_token;
}

async function pedir(cuerpo, { token, origen = ORIGEN, metodo = 'POST', cabeceras = {}, consulta = '' } = {}) {
  const headers = { 'Content-Type': 'application/json', ...cabeceras };
  if (origen) headers.Origin = origen;
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await manejador(new Request(`http://funcion/mp${consulta}`, { method: metodo, headers, body: metodo === 'POST' ? JSON.stringify(cuerpo) : undefined, redirect: 'manual' }));
  const texto = await r.text();
  let j = null;
  try { j = texto ? JSON.parse(texto) : null; } catch { j = texto; }
  return { estado: r.status, cuerpo: j, cabeceras: r.headers };
}

const mandarAviso = (aviso, cambios = {}) => pedir(aviso.cuerpo, {
  origen: null, consulta: `?data.id=${aviso.dato}&type=${aviso.tipo}`,
  cabeceras: { 'x-signature': cambios.firma ?? aviso.firma, 'x-request-id': cambios.pedido ?? aviso.pedido },
});

const rpc = async (token, fn, args) => (await fetchOriginal(`${s.url}/rest/v1/rpc/${fn}`, {
  method: 'POST', headers: { apikey: CLAVE_PUBLICA, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ p_slug: 'lavanda', ...args }),
})).json();

let cajon = 0;
async function reservar(token) {
  let dia = new Date(Date.now() + (5 + cajon) * 864e5);
  if (dia.getUTCDay() === 0) dia = new Date(dia.getTime() + 864e5);
  cajon += 2;
  const r = await rpc(token, 'reservar', { p_box: 1, p_fecha: dia.toISOString().slice(0, 10), p_desde: 8, p_hasta: 12, p_servicio: 'Consulta', p_plan: 'sena', p_maquinas: [], p_reglamento_version: 1 });
  assert.ok(r.id, JSON.stringify(r));
  return r;
}

test('la función armada no trae nada de afuera y no escribe pases en los registros', () => {
  assert.equal(/^import\s/m.test(armada), false);
  assert.ok(armada.includes('_compartido/mp.ts') && armada.includes('_compartido/cobros.ts') && armada.includes('mp/index.ts'));
  for (const linea of armada.split('\n').filter((l) => l.includes('console.'))) assert.match(linea, /console\.error\("mp: (falla|aviso sin procesar)", e instanceof Error \? e\.name : typeof e\);/);
});

test('el aviso previo del navegador: solo los orígenes de Entreturno', async () => {
  const bien = await pedir(null, { metodo: 'OPTIONS' });
  assert.equal(bien.estado, 204);
  assert.equal(bien.cabeceras.get('access-control-allow-origin'), ORIGEN);
  for (const origen of ['https://yanina-entreturno.pages.dev', 'http://localhost:8092']) {
    assert.equal((await pedir(null, { metodo: 'OPTIONS', origen })).cabeceras.get('access-control-allow-origin'), origen);
  }
  for (const origen of ['https://entreturno.com.ar.malo.com', 'https://otro.pages.dev', 'https://evil.com']) {
    assert.equal((await pedir(null, { metodo: 'OPTIONS', origen })).cabeceras.get('access-control-allow-origin'), null, origen);
  }
});

test('la página: sin pase, con un pase inventado o desde otro sitio no se hace nada', async () => {
  const lucia = await pase(PROFESIONALES[0].email);
  const r = await reservar(lucia);
  const pedido = { accion: 'pagar', slug: 'lavanda', reserva: r.id, tipo: 'sena' };
  assert.deepEqual([(await pedir(pedido)).estado, (await pedir(pedido)).cuerpo], [401, { code: 'sin_sesion' }]);
  assert.equal((await pedir(pedido, { token: 'eyJ.inventado.x' })).estado, 401);
  assert.deepEqual((await pedir(pedido, { token: lucia, origen: 'https://evil.com' })).cuerpo, { code: 'origen_no_permitido' });
  assert.deepEqual((await pedir(pedido, { token: lucia, origen: null })).cuerpo, { code: 'origen_no_permitido' });
  assert.deepEqual((await pedir({ ...pedido, reserva: 'no-es-un-id' }, { token: lucia })).cuerpo, { code: 'dato_invalido' });
  assert.deepEqual((await pedir({ ...pedido, tipo: 'regalo' }, { token: lucia })).cuerpo, { code: 'dato_invalido' });
  assert.deepEqual((await pedir({ accion: 'otra', slug: 'lavanda' }, { token: lucia })).cuerpo, { code: 'dato_invalido' });
  // una profesional no conecta la cuenta del consultorio
  assert.deepEqual((await pedir({ accion: 'conectar', slug: 'lavanda' }, { token: lucia })).cuerpo, { code: 'solo_admin' });
  assert.equal(s.mp.pedidos.length, 0);
  assert.equal((await pedir(null, { metodo: 'PUT', token: lucia })).estado, 405);
});

test('pagar de punta a punta: la página pide, Mercado Pago avisa con su firma y la reserva queda confirmada', async () => {
  const lucia = await pase(PROFESIONALES[0].email);
  const r = await reservar(lucia);
  const res = await pedir({ accion: 'pagar', slug: 'lavanda', reserva: r.id, tipo: 'sena' }, { token: lucia });
  assert.equal(res.estado, 200, JSON.stringify(res.cuerpo));
  const orden = new URL(res.cuerpo.enlace).searchParams.get('order_id');
  // vuelve a la página desde la que pidió
  assert.equal(s.mp.ordenes.get(orden).config.online.success_url, `${ORIGEN}/?mp=ok`);
  assert.deepEqual((await pedir({ accion: 'verificar', slug: 'lavanda', pago: res.cuerpo.pago }, { token: lucia })).cuerpo, { estado: 'pendiente', reserva: r.id });

  const aviso = s.mp.pagar(orden);
  // un aviso con la firma mal, de otro pedido o sin firma válida: 401 y no se mira nada
  const antes = s.mp.pedidos.length;
  assert.deepEqual([(await mandarAviso(aviso, { firma: aviso.firma.replace(/.$/, (c) => (c === '0' ? '1' : '0')) })).estado,
    (await mandarAviso(aviso, { pedido: 'otro-pedido' })).estado, (await mandarAviso(aviso, { firma: 'cualquier cosa' })).estado], [401, 401, 401]);
  // una firma buena pero de hace tres días tampoco (una copia vieja de un aviso no sirve para siempre)
  const hace3dias = Date.now() - 3 * 86400e3;
  assert.equal((await mandarAviso(aviso, { firma: s.mp.firmar(aviso.dato, aviso.pedido, hace3dias) })).estado, 401);
  assert.equal(s.mp.pedidos.length, antes);
  assert.equal((await s.pg.query(`select estado from public.reservas where id = $1`, [r.id])).rows[0].estado, 'pago');
  // con la firma bien
  assert.deepEqual([(await mandarAviso(aviso)).estado, (await mandarAviso(aviso)).cuerpo], [200, { ok: true }]);
  assert.equal((await s.pg.query(`select estado from public.reservas where id = $1`, [r.id])).rows[0].estado, 'confirmada');
  assert.equal((await s.pg.query(`select count(*)::int as n from public.pagos where reserva_id = $1 and estado = 'aprobado'`, [r.id])).rows[0].n, 1);
  assert.deepEqual((await pedir({ accion: 'verificar', slug: 'lavanda', pago: res.cuerpo.pago }, { token: lucia })).cuerpo, { estado: 'aprobado', reserva: r.id });
  // otra profesional no puede preguntar por ese pago
  const caro = await pase(PROFESIONALES[1].email);
  assert.deepEqual((await pedir({ accion: 'verificar', slug: 'lavanda', pago: res.cuerpo.pago }, { token: caro })).cuerpo, { code: 'pago_inexistente' });
});

test('cancelar y pedir que la devolución salga ya', async () => {
  const caro = await pase(PROFESIONALES[1].email);      // (Lucía ya tiene dos turnos señados: la regla de saldos no le deja señar otro)
  const r = await reservar(caro);
  const res = (await pedir({ accion: 'pagar', slug: 'lavanda', reserva: r.id, tipo: 'sena' }, { token: caro })).cuerpo;
  const orden = new URL(res.enlace).searchParams.get('order_id');
  await mandarAviso(s.mp.pagar(orden));
  const duena = await pase(DUENA.email);
  const c = await rpc(duena, 'cancelar_reserva', { p_reserva: r.id });           // cancela la dueña: se devuelve todo
  assert.ok(c.amount > 0, JSON.stringify(c));
  const v = await pedir({ accion: 'despachar', slug: 'lavanda' }, { token: duena });
  assert.deepEqual([v.estado, v.cuerpo.devoluciones, v.cuerpo.fallas], [200, 1, 0]);
  assert.equal(s.mp.ordenes.get(orden).status, 'refunded');
});

test('conectar la cuenta: la dueña sale a Mercado Pago y vuelve por la función a su página', async () => {
  const duena = await pase(DUENA.email);
  const ini = await pedir({ accion: 'conectar', slug: 'lavanda' }, { token: duena });
  assert.equal(ini.estado, 200, JSON.stringify(ini.cuerpo));
  const q = new URL(ini.cuerpo.url).searchParams;
  assert.ok(ini.cuerpo.url.startsWith('https://auth.mercadopago.com.ar/authorization?'));
  assert.equal(q.get('redirect_uri'), `${s.url}/functions/v1/mp`);
  s.mp.cuenta('424242', { nombre: 'Laura Lavanda' });
  const codigo = s.mp.autorizar('424242', { desafio: q.get('code_challenge'), redirectUri: q.get('redirect_uri') });
  const vuelta = await pedir(null, { metodo: 'GET', origen: null, consulta: `?code=${codigo}&state=${q.get('state')}` });
  assert.deepEqual([vuelta.estado, vuelta.cabeceras.get('location')], [302, `${ORIGEN}/#mp=conectada`]);
  const cuenta = (await s.pg.query(`select estado, mp_user_id, nombre, ambiente from interno.mp_cuentas`)).rows[0];
  assert.deepEqual(cuenta, { estado: 'por_confirmar', mp_user_id: '424242', nombre: 'Laura Lavanda', ambiente: 'prueba' });
  // el mismo enlace otra vez, o uno inventado: no sirve y no dice a dónde volver
  const otra = await pedir(null, { metodo: 'GET', origen: null, consulta: `?code=${codigo}&state=${q.get('state')}` });
  assert.deepEqual([otra.estado, otra.cabeceras.get('location')], [400, null]);
  assert.match(String(otra.cuerpo), /ya no sirve/);
  assert.equal((await pedir(null, { metodo: 'GET', origen: null, consulta: '?code=x&state=y' })).estado, 400);
  // la dueña dijo que no en Mercado Pago: vuelve a su página sin tocar la cuenta
  const ini2 = new URL((await pedir({ accion: 'conectar', slug: 'lavanda' }, { token: duena, origen: 'http://localhost:8092' })).cuerpo.url).searchParams;
  const no = await pedir(null, { metodo: 'GET', origen: null, consulta: `?error=access_denied&state=${ini2.get('state')}` });
  assert.deepEqual([no.estado, no.cabeceras.get('location')], [302, 'http://localhost:8092/#mp=error-cancelado']);
});

test('si Mercado Pago contestara con una dirección de pago que no es suya, no se manda a nadie ahí', async () => {
  const martina = await pase(PROFESIONALES[1].email);
  const r = await reservar(martina);
  try {
    for (const trucha of [`${s.url}/__mp/pagar`, 'https://mercadopago.com.ar.malo.com/pagar', 'http://www.mercadopago.com.ar/checkout']) {
      s.mp.paginaDePago = trucha;
      const res = await pedir({ accion: 'pagar', slug: 'lavanda', reserva: r.id, tipo: 'sena' }, { token: martina });
      assert.deepEqual([res.estado, res.cuerpo], [400, { code: 'mp_sin_respuesta' }], trucha);
      await s.pg.query(`delete from public.pagos where reserva_id = $1`, [r.id]);       // para que el próximo intento cree otra orden
    }
  } finally {
    s.mp.paginaDePago = PAGO_DE_VERDAD;
  }
  assert.equal((await pedir({ accion: 'pagar', slug: 'lavanda', reserva: r.id, tipo: 'sena' }, { token: martina })).estado, 200);
});

test('el reloj entra solo con la clave que guarda la base', async () => {
  assert.equal((await pedir({ accion: 'reloj' }, { origen: null, cabeceras: { 'x-entreturno-reloj': 'x'.repeat(48) } })).estado, 401);
  await s.pg.query(`select vault.create_secret($1, 'mp_clave_reloj', '')`, ['r'.repeat(48)]);
  const v = await pedir({ accion: 'reloj' }, { origen: null, cabeceras: { 'x-entreturno-reloj': 'r'.repeat(48) } });
  assert.deepEqual([v.estado, Object.keys(v.cuerpo).sort()], [200, ['cerradas', 'devoluciones', 'fallas', 'pagos', 'renovadas', 'sobrantes']]);
  assert.equal((await pedir({ accion: 'reloj' }, { origen: null, cabeceras: { 'x-entreturno-reloj': '' } })).estado, 401);
});

test('los avisos valen con la firma de Prueba o con la de Producción, y los puntitos no son una firma', async () => {
  const guardados = { ...env };
  const aviso = s.mp.aviso([...s.mp.ordenes.keys()][0]);
  const conFirma = (secreto) => mandarAviso(aviso, { firma: s.mp.firmar(aviso.dato, aviso.pedido, Date.now(), secreto) });
  try {
    // una sola cargada: la otra no vale
    assert.deepEqual([(await conFirma(s.mp.secretoAvisos)).estado, (await conFirma('firma-de-produccion')).estado], [200, 401]);
    // las dos: vale cualquiera; una tercera, no
    env.MP_WEBHOOK_SECRETO_REAL = ' firma-de-produccion\n';
    assert.deepEqual([(await conFirma(s.mp.secretoAvisos)).estado, (await conFirma('firma-de-produccion')).estado, (await conFirma('otra-firma')).estado], [200, 200, 401]);
    // solo la de Producción
    delete env.MP_WEBHOOK_SECRETO;
    assert.deepEqual([(await conFirma(s.mp.secretoAvisos)).estado, (await conFirma('firma-de-produccion')).estado], [401, 200]);
    // lo que muestra el panel para tapar la clave (pasó el 25/11/2026): es como si no estuviera, ni siquiera firmando con eso
    delete env.MP_WEBHOOK_SECRETO_REAL;
    for (const tapada of ['•'.repeat(64), '*'.repeat(40), '·'.repeat(64)]) {
      env.MP_WEBHOOK_SECRETO = tapada;
      const v = await conFirma(tapada);
      assert.deepEqual([v.estado, v.cuerpo], [500, { code: 'falta_configurar' }]);
      env.MP_WEBHOOK_SECRETO_REAL = 'firma-de-produccion';
      assert.deepEqual([(await conFirma(tapada)).estado, (await conFirma('firma-de-produccion')).estado], [401, 200]);
      delete env.MP_WEBHOOK_SECRETO_REAL;
    }
    // lo mismo con el pase de prueba y con los datos de la aplicación
    Object.assign(env, guardados, { MP_CLIENT_SECRET: '•'.repeat(32) });
    assert.deepEqual((await pedir({ accion: 'conectar', slug: 'lavanda' }, { token: await pase(DUENA.email) })).cuerpo, { code: 'falta_configurar' });
  } finally {
    delete env.MP_WEBHOOK_SECRETO_REAL;
    Object.assign(env, guardados);
  }
});

test('si falta cargar un secreto, lo dice sin hacer nada', async () => {
  const duena = await pase(DUENA.email);
  const guardados = { ...env };
  try {
    delete env.MP_CLIENT_SECRET;
    assert.deepEqual((await pedir({ accion: 'conectar', slug: 'lavanda' }, { token: duena })).cuerpo, { code: 'falta_configurar' });
    delete env.MP_WEBHOOK_SECRETO;
    const aviso = s.mp.aviso([...s.mp.ordenes.keys()][0]);
    assert.deepEqual([(await mandarAviso(aviso)).estado, (await mandarAviso(aviso)).cuerpo], [500, { code: 'falta_configurar' }]);
    delete env.SUPABASE_SERVICE_ROLE_KEY;
    assert.equal((await pedir({ accion: 'conectar', slug: 'lavanda' }, { token: duena })).estado, 500);
  } finally {
    Object.assign(env, guardados);
  }
});
