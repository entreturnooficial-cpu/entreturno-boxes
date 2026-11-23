// «Facturar todo el mes» de punta a punta: la función que habla con ARCA (supabase/functions/_compartido/facturar.ts)
// contra la base de verdad (PGlite, con los roles de Supabase) y un ARCA simulado (pruebas/arca-simulado.mjs).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { facturarMes, normalizarPem, probarConexion } from '../../supabase/functions/_compartido/facturar.ts';
import { crearArcaSimulado } from '../arca-simulado.mjs';
import { esperarError, prueba } from './entorno.mjs';

const pad = (n) => String(n).padStart(2, '0');

async function mesAnterior(e) {
  const [a, m] = (await e.fecha(0)).split('-').map(Number);
  const d = new Date(Date.UTC(a, m - 2, 1));
  const periodo = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
  return { periodo, dia: (n) => `${periodo}-${pad(n)}` };
}

async function alquilado(e, esc, usuario, { dia, box = 2, desde = 8, hasta = 12 }) {
  const r = await e.reservar(esc, usuario, { box, fecha: await e.diaHabil(3), desde, hasta, plan: 'total' });
  await e.pagar(esc, usuario, r.id, 'total');
  await e.sql('update public.reservas set fecha = $2 where id = $1', [r.id, dia]);
  return r.id;
}

const ambiente = (e, esc, valor) => e.sql(`update public.consultorios set fact_ambiente = $2, fact_cuit = '27-30111222-5' where id = $1`, [esc.id, valor]);

// Por la API de Supabase los jsonb viajan como JSON; acá, como texto
const comoTexto = (args) =>
  Object.fromEntries(Object.entries(args).map(([k, v]) => [k, v !== null && typeof v === 'object' ? JSON.stringify(v) : v]));

function dependencias(e, esc, arca, extra = {}) {
  return {
    rpcUsuario: (fn, args) => e.llamarComo(esc.admin, fn, args),
    rpcServicio: (fn, args) => e.comoRol('service_role', null, (c) => c.llamar(fn, comoTexto(args))),
    firmar: () => 'Q01T', // el ARCA simulado no mira la firma (la firma se prueba en pruebas/arca.test.mjs)
    prueba: { cuit: '20123456786', puntoVenta: 1 },
    fetchFn: arca.fetchFn,
    ...extra,
  };
}

async function escenario(e, { profesionales = ['lucia'] } = {}) {
  const esc = await e.armar();
  await ambiente(e, esc, 'prueba');
  const { periodo, dia } = await mesAnterior(e);
  if (profesionales.includes('lucia')) await alquilado(e, esc, esc.lucia, { dia: dia(5) });          // $ 40.000
  if (profesionales.includes('caro')) await alquilado(e, esc, esc.caro, { dia: dia(7), box: 3 });    // $ 32.000
  return { esc, periodo, dia };
}

prueba('facturar el mes en prueba: una Factura C por profesional, con la CUIT de prueba; apretar de nuevo no duplica', async (e) => {
  const { esc, periodo, dia } = await escenario(e, { profesionales: ['lucia', 'caro'] });
  const arca = crearArcaSimulado();
  const r = await facturarMes(dependencias(e, esc, arca), esc.slug, periodo);
  assert.equal(r.error, undefined);
  assert.deepEqual(r.emitidas.map((x) => x.numero).sort(), [1, 2]);
  assert.deepEqual([r.rechazadas, r.inciertas, r.faltan, r.revisar], [[], [], [], []]);

  const filas = await e.sql('select estado, emisor_cuit, punto_venta, numero, cae, total from public.facturas order by numero');
  assert.deepEqual(filas.map((f) => [f.estado, f.emisor_cuit, f.punto_venta, f.numero, f.total]),
    [['emitida', '20123456786', 1, 1, 32000], ['emitida', '20123456786', 1, 2, 40000]]);
  assert.ok(filas.every((f) => /^\d{14}$/.test(f.cae)));
  // lo que recibió ARCA es lo de la base: total, CUIT y condición de la profesional, fechas del turno
  const recibido = [...arca.comprobantes.values()].map((c) =>
    [c.datos.ImpTotal, c.datos.DocTipo, c.datos.DocNro, c.datos.CondicionIVAReceptorId, c.datos.FchServDesde, c.datos.Concepto]);
  assert.deepEqual(recibido, [
    ['32000.00', '80', '27111111117', '6', dia(7).replace(/-/g, ''), '2'],
    ['40000.00', '80', '27111111117', '6', dia(5).replace(/-/g, ''), '2'],
  ]);

  const otra = await facturarMes(dependencias(e, esc, arca), esc.slug, periodo);
  assert.deepEqual(otra.emitidas, []);
  assert.equal(arca.cuantos('FECAESolicitar'), 2);
  assert.equal(arca.cuantos('loginCms'), 1);                // el ticket se pidió una sola vez y se reusó
  const foto = await e.foto(esc, esc.admin);
  assert.deepEqual(foto.invoices.map((i) => [i.number, i.status, i.env]).sort(),
    [['0001-00000001', 'emitida', 'prueba'], ['0001-00000002', 'emitida', 'prueba']]);
});

prueba('si la respuesta de ARCA se pierde, la factura queda en duda y después se concilia sola, sin duplicar', async (e) => {
  const { esc, periodo } = await escenario(e);
  const arca = crearArcaSimulado();
  arca.fallar('FECAESolicitar', 'procesar-y-cortar');        // ARCA la hace, pero la respuesta no llega
  arca.fallar('FECompConsultar', 'cortar');                   // y la consulta tampoco: no hay forma de saber
  const r1 = await facturarMes(dependencias(e, esc, arca), esc.slug, periodo);
  assert.deepEqual([r1.inciertas.map((x) => x.numero), r1.error], [[1], undefined]);
  assert.deepEqual(await e.uno('select estado, numero from public.facturas'), { estado: 'incierta', numero: 1 });

  const r2 = await facturarMes(dependencias(e, esc, arca), esc.slug, periodo);   // enseguida: no se toca
  assert.deepEqual(r2.inciertas.map((x) => x.numero), [1]);
  assert.equal(arca.cuantos('FECAESolicitar'), 1);

  const despues = dependencias(e, esc, arca, { ahora: () => new Date(Date.now() + 5 * 60_000) });
  const r3 = await facturarMes(despues, esc.slug, periodo);                     // unos minutos después
  assert.deepEqual(r3.emitidas.map((x) => x.numero), [1]);
  assert.equal(arca.cuantos('FECAESolicitar'), 1);                               // no mandó otra
  assert.deepEqual(await e.uno('select estado, numero from public.facturas'), { estado: 'emitida', numero: 1 });
});

prueba('si no llegó a ARCA, la duda se resuelve emitiéndola una sola vez', async (e) => {
  const { esc, periodo } = await escenario(e);
  const arca = crearArcaSimulado();
  arca.fallar('FECAESolicitar', 'cortar');                     // el pedido no llegó
  arca.fallar('FECompConsultar', 'cortar');
  await facturarMes(dependencias(e, esc, arca), esc.slug, periodo);
  const r = await facturarMes(dependencias(e, esc, arca, { ahora: () => new Date(Date.now() + 5 * 60_000) }), esc.slug, periodo);
  assert.deepEqual(r.emitidas.map((x) => x.numero), [1]);
  assert.equal(arca.comprobantes.size, 1);
});

prueba('si ARCA la rechaza, queda rechazada con el motivo y la próxima vez se vuelve a intentar', async (e) => {
  const { esc, periodo } = await escenario(e);
  const arca = crearArcaSimulado();
  arca.fallar('FECAESolicitar', 'rechazar', { codigo: 10015, mensaje: 'Fecha mal' });
  const r1 = await facturarMes(dependencias(e, esc, arca), esc.slug, periodo);
  assert.deepEqual(r1.rechazadas.map((x) => x.motivo), ['10015: Fecha mal']);
  assert.deepEqual(await e.uno('select estado, numero, observaciones from public.facturas'),
    { estado: 'rechazada', numero: null, observaciones: [{ codigo: 10015, mensaje: 'Fecha mal' }] });
  const enPantalla = (await e.foto(esc, esc.admin)).invoices[0];
  assert.deepEqual([enPantalla.status, enPantalla.number, enPantalla.notes[0].mensaje], ['rechazada', null, 'Fecha mal']);

  const r2 = await facturarMes(dependencias(e, esc, arca), esc.slug, periodo);
  assert.deepEqual(r2.emitidas.map((x) => x.numero), [1]);
});

prueba('dos a la vez: si otro está facturando esa numeración, no emite nada y avisa', async (e) => {
  const { esc, periodo } = await escenario(e);
  const arca = crearArcaSimulado();
  await e.comoRol('service_role', null, (c) => c.llamar('arca_candado', { p_clave: 'prueba:20123456786:1:11', p_dueno: 'otro', p_segundos: 60 }));
  const r = await facturarMes(dependencias(e, esc, arca), esc.slug, periodo);
  assert.equal(r.error.codigo, 'ocupado');
  assert.deepEqual(arca.pedidos, []);
  assert.equal((await e.uno('select estado from public.facturas')).estado, 'pendiente');
});

prueba('si ARCA no da el ticket, no se emite nada, se avisa el motivo y el candado queda libre', async (e) => {
  const { esc, periodo } = await escenario(e);
  const arca = crearArcaSimulado();
  arca.fallar('loginCms', 'cortar');
  const r = await facturarMes(dependencias(e, esc, arca), esc.slug, periodo);
  assert.equal(r.error.codigo, 'sin_respuesta');
  assert.equal(arca.cuantos('FECAESolicitar'), 0);
  assert.equal(await e.comoRol('service_role', null, (c) =>
    c.llamar('arca_candado', { p_clave: 'prueba:20123456786:1:11', p_dueno: 'otra corrida', p_segundos: 60 })), true);
  const otra = await facturarMes(dependencias(e, esc, crearArcaSimulado()), esc.slug, periodo);
  assert.equal(otra.error.codigo, 'ocupado');                // ahora lo tiene la «otra corrida»
});

prueba('la que no tiene CUIT o condición queda aparte y no frena a las demás', async (e) => {
  const { esc, periodo } = await escenario(e, { profesionales: ['lucia', 'caro'] });
  await e.sql('update public.miembros set condicion_iva = null where id = $1', [await e.miembro(esc, esc.caro)]);
  const r = await facturarMes(dependencias(e, esc, crearArcaSimulado()), esc.slug, periodo);
  assert.deepEqual(r.emitidas.map((x) => x.numero), [1]);
  assert.deepEqual(r.faltan.map((x) => [x.name, x.missing]), [['Carolina Méndez', 'condicion']]);
});

prueba('probar la conexión: servidores, ticket, puntos de venta y último número, sin emitir nada', async (e) => {
  const esc = await e.armar();
  const arca = crearArcaSimulado({ puntosDeVenta: [3] });
  assert.deepEqual(await probarConexion(dependencias(e, esc, arca), esc.slug), { ambiente: 'apagado' });
  await ambiente(e, esc, 'prueba');
  const r = await probarConexion(dependencias(e, esc, arca), esc.slug);
  assert.deepEqual(
    [r.ok, r.ambiente, r.servidores, r.puntosVenta, r.ultimoNumero, r.puntoVenta, typeof r.ticketVence],
    [true, 'prueba', { app: 'OK', base: 'OK', autenticacion: 'OK' }, [3], 0, 1, 'string'],
  );
  assert.equal(arca.cuantos('FECAESolicitar'), 0);
  const deLucia = { ...dependencias(e, esc, arca), rpcUsuario: (fn, args) => e.llamarComo(esc.lucia, fn, args) };
  await esperarError(probarConexion(deLucia, esc.slug), 'solo_admin');
  // si ARCA no contesta, lo dice sin cortar
  const caido = crearArcaSimulado();
  caido.fallar('FEDummy', 'cortar');
  const r2 = await probarConexion(dependencias(e, esc, caido), esc.slug);
  assert.deepEqual([r2.ok, r2.error.codigo], [false, 'sin_respuesta']);
});

test('normalizarPem: el certificado o la clave vuelven a ser PEM aunque se hayan pegado en una sola línea', () => {
  const cuerpo = 'A'.repeat(100) + 'B'.repeat(30);
  const pem = `-----BEGIN CERTIFICATE-----\n${'A'.repeat(64)}\n${'A'.repeat(36)}${'B'.repeat(28)}\nBB\n-----END CERTIFICATE-----\n`;
  assert.equal(normalizarPem(`-----BEGIN CERTIFICATE-----${cuerpo}-----END CERTIFICATE-----`), pem);      // sin saltos
  assert.equal(normalizarPem(`-----BEGIN CERTIFICATE-----\\n${cuerpo}\\n-----END CERTIFICATE-----`), pem); // con «\n» escritos
  assert.equal(normalizarPem(btoa(pem)), pem);                                                         // en base64
  assert.equal(normalizarPem(pem), pem);
  assert.throws(() => normalizarPem('cualquier cosa'), { codigo: 'certificado_invalido' });
});

prueba('si una queda en duda, no emite las demás de esa numeración hasta conciliarla', async (e) => {
  const { esc, periodo } = await escenario(e, { profesionales: ['lucia', 'caro'] });
  const arca = crearArcaSimulado();
  arca.fallar('FECAESolicitar', 'procesar-y-cortar');                       // la primera (Carolina) sale y se pierde la respuesta
  arca.fallar('FECompConsultar', 'cortar');
  const r1 = await facturarMes(dependencias(e, esc, arca), esc.slug, periodo);
  assert.deepEqual(r1.inciertas.map((x) => x.numero), [1]);
  assert.equal(r1.sinIntentar.length, 1);                                    // Lucía queda para la próxima
  assert.equal(arca.cuantos('FECAESolicitar'), 1);
  const despues = dependencias(e, esc, arca, { ahora: () => new Date(Date.now() + 5 * 60_000) });
  const r2 = await facturarMes(despues, esc.slug, periodo);                 // se concilia la duda y recién ahí sale la otra
  assert.deepEqual(r2.emitidas.map((x) => x.numero), [1, 2]);
  assert.equal(arca.cuantos('FECAESolicitar'), 2);
});

prueba('una incierta se concilia con la numeración con que salió, con el candado de esa numeración', async (e) => {
  const { esc, periodo } = await escenario(e);
  const arca = crearArcaSimulado();
  arca.fallar('FECAESolicitar', 'procesar-y-cortar');
  arca.fallar('FECompConsultar', 'cortar');
  await facturarMes(dependencias(e, esc, arca), esc.slug, periodo);          // sale por el punto de venta 1 y queda en duda
  // ahora el de prueba es el punto de venta 2, y otra corrida tiene tomado el 1
  await e.comoRol('service_role', null, (c) => c.llamar('arca_candado', { p_clave: 'prueba:20123456786:1:11', p_dueno: 'otra', p_segundos: 300 }));
  const conOtroPunto = dependencias(e, esc, arca, { prueba: { cuit: '20123456786', puntoVenta: 2 }, ahora: () => new Date(Date.now() + 5 * 60_000) });
  const r = await facturarMes(conOtroPunto, esc.slug, periodo);
  assert.equal(r.error.codigo, 'ocupado');
  assert.equal(arca.cuantos('FECompConsultar'), 1);                          // no tocó la duda sin su candado
  await e.sql(`update interno.arca_candados set hasta = now() - interval '1 second' where dueno = 'otra'`);
  const r2 = await facturarMes(conOtroPunto, esc.slug, periodo);
  assert.deepEqual(r2.emitidas.map((x) => x.numero), [1]);
  assert.deepEqual(await e.uno('select punto_venta, numero, estado from public.facturas'), { punto_venta: 1, numero: 1, estado: 'emitida' });
});

prueba('si otra corrida cambió la factura o le sacó el candado justo antes de mandarla, no la manda', async (e) => {
  const { esc, periodo } = await escenario(e);
  const arca = crearArcaSimulado();
  const base = dependencias(e, esc, arca);
  const cambia = {
    ...base,
    rpcServicio: async (fn, args) => {
      if (fn === 'arca_anotar') await e.sql('update public.facturas set total = total + 100');
      return base.rpcServicio(fn, args);
    },
  };
  const r1 = await facturarMes(cambia, esc.slug, periodo);
  assert.deepEqual([r1.emitidas, r1.sinIntentar.length], [[], 1]);
  assert.equal(arca.cuantos('FECAESolicitar'), 0);
  const roba = {
    ...base,
    rpcServicio: async (fn, args) => {
      if (fn === 'arca_anotar') await e.sql(`update interno.arca_candados set dueno = 'otra' where clave like 'prueba:%'`);
      return base.rpcServicio(fn, args);
    },
  };
  const r2 = await facturarMes(roba, esc.slug, periodo);
  assert.deepEqual([r2.error.codigo, r2.emitidas], ['ocupado', []]);
  assert.equal(arca.cuantos('FECAESolicitar'), 0);
});

prueba('el ticket se pide de a uno: si otra corrida lo está pidiendo, espera y no emite sin ticket', async (e) => {
  const { esc, periodo } = await escenario(e);
  const arca = crearArcaSimulado();
  await e.comoRol('service_role', null, (c) => c.llamar('arca_candado', { p_clave: 'ticket:prueba', p_dueno: 'otra', p_segundos: 60 }));
  let esperas = 0;
  const r = await facturarMes(dependencias(e, esc, arca, { dormir: async () => { esperas++; } }), esc.slug, periodo);
  assert.deepEqual([r.error.codigo, esperas, arca.cuantos('loginCms'), arca.cuantos('FECAESolicitar')], ['ocupado', 9, 0, 0]);
});
