// La función de Supabase «facturar» TAL COMO SE SUBE (publicar/funcion-facturar/index.ts, armado en un solo archivo),
// corrida en Node con un «Deno» de mentira contra el servidor de prueba (base + API) y el ARCA simulado.
// Así se prueba lo que no ven las otras pruebas: el armado, los pases, los permisos de origen y los secretos.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import forge from 'node-forge';

import { CLAVE_DE_PRUEBA, DUENA, PROFESIONALES } from './datos-de-ejemplo.mjs';
import { CLAVE_PUBLICA, CLAVE_SECRETA, crearServidor } from './servidor-local.mjs';

let s;
let manejador;
let carpeta;
const env = {};
const fetchOriginal = globalThis.fetch;

function certificadoDePrueba() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.publicKeyFromPem(publicKey);
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 86400e3);
  cert.validity.notAfter = new Date(Date.now() + 86400e3);
  const nombre = [{ name: 'commonName', value: 'prueba' }, { name: 'serialNumber', value: 'CUIT 20123456786' }];
  cert.setSubject(nombre);
  cert.setIssuer(nombre);
  cert.sign(forge.pki.privateKeyFromPem(privateKey), forge.md.sha256.create());
  return { cert: forge.pki.certificateToPem(cert), clave: privateKey };
}

before(async () => {
  s = await crearServidor();
  // la función armada, con node-forge de node_modules en lugar de «npm:»
  execFileSync(process.execPath, [fileURLToPath(new URL('../publicar/armar_funcion.mjs', import.meta.url))]);
  const armada = readFileSync(new URL('../publicar/funcion-facturar/index.ts', import.meta.url), 'utf8');
  carpeta = mkdtempSync(path.join(tmpdir(), 'funcion-'));
  const archivo = path.join(carpeta, 'index.ts');
  writeFileSync(archivo, armada.replace(/"npm:node-forge@[\d.]+"/, JSON.stringify(import.meta.resolve('node-forge'))));
  globalThis.Deno = { env: { get: (k) => env[k] }, serve: (fn) => { manejador = fn; } };
  // los pedidos a ARCA van al ARCA simulado del servidor; el resto, a la red de verdad (el servidor de prueba)
  globalThis.fetch = (url, init) => (/afip\.gov\.ar/.test(String(url)) ? s.arca.fetchFn(url, init) : fetchOriginal(url, init));
  await import(pathToFileURL(archivo).href);
  const { cert, clave } = certificadoDePrueba();
  Object.assign(env, {
    SUPABASE_URL: s.url, SUPABASE_ANON_KEY: CLAVE_PUBLICA, SUPABASE_SERVICE_ROLE_KEY: CLAVE_SECRETA,
    ARCA_PRUEBA_CERT: cert.replace(/\n/g, ''),        // pegado en un campo de una sola línea
    ARCA_PRUEBA_CLAVE: clave, ARCA_PRUEBA_CUIT: '20-12345678-6',
  });
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

async function pedir(cuerpo, { token, origen = 'https://lavanda.entreturno.com.ar', metodo = 'POST' } = {}) {
  const headers = { Origin: origen, 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await manejador(new Request('http://funcion/facturar', { method: metodo, headers, body: metodo === 'POST' ? JSON.stringify(cuerpo) : undefined }));
  const texto = await r.text();
  return { estado: r.status, cuerpo: texto ? JSON.parse(texto) : null, cabeceras: r.headers };
}

const pad = (n) => String(n).padStart(2, '0');
const hoyEnBuenosAires = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }).format(new Date());

test('el aviso previo del navegador: solo los orígenes de Entreturno', async () => {
  const bien = await pedir(null, { metodo: 'OPTIONS' });
  assert.equal(bien.estado, 204);
  assert.equal(bien.cabeceras.get('access-control-allow-origin'), 'https://lavanda.entreturno.com.ar');
  for (const origen of ['https://yanina-entreturno.pages.dev', 'http://localhost:8092']) {
    assert.equal((await pedir(null, { metodo: 'OPTIONS', origen })).cabeceras.get('access-control-allow-origin'), origen);
  }
  for (const origen of ['https://entreturno.com.ar.malo.com', 'https://otro.pages.dev', 'https://evil.com']) {
    assert.equal((await pedir(null, { metodo: 'OPTIONS', origen })).cabeceras.get('access-control-allow-origin'), null, origen);
  }
});

test('sin pase, con un pase inventado o como profesional: no hace nada', async () => {
  assert.deepEqual((await pedir({ accion: 'probar', slug: 'lavanda' })).cuerpo, { code: 'sin_sesion' });
  assert.equal((await pedir({ accion: 'probar', slug: 'lavanda' }, { token: 'eyJ.inventado.x' })).estado, 401);
  const lucia = await pase(PROFESIONALES[0].email);
  const r = await pedir({ accion: 'facturar', slug: 'lavanda', periodo: '2026-10' }, { token: lucia });
  assert.deepEqual([r.estado, r.cuerpo], [400, { code: 'solo_admin' }]);
  assert.equal(s.arca.pedidos.length, 0);
});

test('la dueña: probar la conexión y facturar el mes, con el certificado pegado en una línea', async () => {
  const duena = await pase(DUENA.email);
  assert.deepEqual((await pedir({ accion: 'probar', slug: 'lavanda' }, { token: duena })).cuerpo, { ambiente: 'apagado' });
  await s.pg.query(`update public.consultorios set fact_ambiente = 'prueba' where slug = 'lavanda'`);
  const prueba = (await pedir({ accion: 'probar', slug: 'lavanda' }, { token: duena })).cuerpo;
  assert.deepEqual([prueba.ok, prueba.ambiente, prueba.ultimoNumero], [true, 'prueba', 0]);

  // un turno de Lucía, pagado, corrido al mes anterior
  const [a, m] = hoyEnBuenosAires().split('-').map(Number);
  const mes = new Date(Date.UTC(a, m - 2, 1));
  const periodo = `${mes.getUTCFullYear()}-${pad(mes.getUTCMonth() + 1)}`;
  const lucia = await pase(PROFESIONALES[0].email);
  const rpc = async (token, fn, args) => (await fetchOriginal(`${s.url}/rest/v1/rpc/${fn}`, {
    method: 'POST', headers: { apikey: CLAVE_PUBLICA, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_slug: 'lavanda', ...args }),
  })).json();
  let dia = new Date(Date.now() + 5 * 864e5);
  if (dia.getUTCDay() === 0) dia = new Date(dia.getTime() + 864e5);
  const reserva = await rpc(lucia, 'reservar', {
    p_box: 1, p_fecha: dia.toISOString().slice(0, 10), p_desde: 8, p_hasta: 12, p_servicio: 'Consulta', p_plan: 'total',
    p_maquinas: [], p_reglamento_version: 1,
  });
  assert.ok(reserva.id, JSON.stringify(reserva));
  await rpc(lucia, 'simular_pago', { p_reserva: reserva.id, p_tipo: 'total' });
  await s.pg.query(`update public.reservas set fecha = $2 where id = $1`, [reserva.id, `${periodo}-10`]);

  const r = await pedir({ accion: 'facturar', slug: 'lavanda', periodo }, { token: duena });
  assert.equal(r.estado, 200);
  assert.equal(r.cuerpo.error, undefined, JSON.stringify(r.cuerpo.error));
  assert.deepEqual(r.cuerpo.emitidas.map((x) => x.numero), [1]);
  const fila = (await s.pg.query(`select estado, emisor_cuit, numero from public.facturas`)).rows[0];
  assert.deepEqual(fila, { estado: 'emitida', emisor_cuit: '20123456786', numero: 1 });
  // el ticket quedó guardado en la base y se reusa
  assert.equal((await pedir({ accion: 'facturar', slug: 'lavanda', periodo }, { token: duena })).cuerpo.emitidas.length, 0);
  assert.equal(s.arca.cuantos('loginCms'), 1);
});

test('si falta cargar un secreto, lo dice sin emitir nada', async () => {
  const duena = await pase(DUENA.email);
  const guardado = env.ARCA_PRUEBA_CLAVE;
  delete env.ARCA_PRUEBA_CLAVE;
  await s.pg.query(`delete from interno.arca_tickets`);           // sin ticket guardado, hay que firmar uno nuevo
  try {
    const r = (await pedir({ accion: 'probar', slug: 'lavanda' }, { token: duena })).cuerpo;
    assert.deepEqual([r.ok, r.error.codigo], [false, 'falta_configurar']);
    assert.match(r.error.mensaje, /ARCA_PRUEBA_CLAVE/);
  } finally {
    env.ARCA_PRUEBA_CLAVE = guardado;
  }
});
