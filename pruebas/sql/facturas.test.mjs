// Facturas con ARCA, del lado de la base: datos fiscales de cada profesional, «Facturar todo el mes» (una factura por
// profesional con lo que alquiló) y las funciones que usa solo la función de Supabase que habla con ARCA.
import assert from 'node:assert/strict';

import { FUNCIONES_DE_SERVICIO, esperarError, esperarSinPermiso, prueba } from './entorno.mjs';

const pad = (n) => String(n).padStart(2, '0');

/** El mes anterior al de hoy: su período («2026-10») y sus días. */
async function mesAnterior(e) {
  const [a, m] = (await e.fecha(0)).split('-').map(Number);
  const d = new Date(Date.UTC(a, m - 2, 1));
  const periodo = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
  return { periodo, dia: (n) => `${periodo}-${pad(n)}` };
}

/** Un turno reservado y pagado completo, corrido después a un día del mes que se factura. */
async function alquilado(e, esc, usuario, { dia, box = 2, desde = 8, hasta = 12, maquinas = [] }) {
  const r = await e.reservar(esc, usuario, { box, fecha: await e.diaHabil(3), desde, hasta, maquinas, plan: 'total' });
  await e.pagar(esc, usuario, r.id, 'total');
  await e.sql('update public.reservas set fecha = $2 where id = $1', [r.id, dia]);
  await e.sql('update public.reserva_maquinas set fecha = $2 where reserva_id = $1', [r.id, dia]);
  return r.id;
}

const preparar = (e, esc, periodo, quien = esc.admin) =>
  e.llamarComo(quien, 'facturacion_preparar', { p_slug: esc.slug, p_periodo: periodo });
const servicio = (e, fn, args) => e.comoRol('service_role', null, (c) => c.llamar(fn, args));
const ambiente = (e, esc, valor, cuit = '27-30111222-5') =>
  e.sql('update public.consultorios set fact_ambiente = $2, fact_cuit = $3 where id = $1', [esc.id, valor, cuit]);
/** Lo que hace la función antes de mandar una factura: toma el candado de esa numeración y anota el número. */
async function anotar(e, id, numero, { dueno = 'pruebas', cuit = '20123456786', pv = 1, version } = {}) {
  const f = await e.uno('select ambiente, cbte_tipo, interno.huella_factura(f) as v from public.facturas f where id = $1', [id]);
  await servicio(e, 'arca_candado', { p_clave: `${f.ambiente}:${cuit}:${pv}:${f.cbte_tipo}`, p_dueno: dueno, p_segundos: 300 });
  return servicio(e, 'arca_anotar', {
    p_factura: id, p_emisor_cuit: cuit, p_punto_venta: pv, p_numero: numero, p_version: version ?? f.v, p_dueno: dueno,
  });
}
const resultado = (e, id, estado, extra = {}) =>
  servicio(e, 'arca_resultado', {
    p_factura: id, p_estado: estado, p_cae: estado === 'emitida' ? '86471093086417' : null,
    p_cae_vence: estado === 'emitida' ? '2026-12-03' : null, p_observaciones: '[]', ...extra,
  });

// ---------------------------------------------------------------------------------------------------------------
// Datos fiscales
// ---------------------------------------------------------------------------------------------------------------

prueba('pedir acceso: la CUIT se valida y queda con guiones, y la condición frente al IVA queda anotada', async (e) => {
  const esc = await e.armar();
  const pedir = async (cambios) =>
    e.llamarComo(await e.crearUsuario(), 'pedir_acceso', {
      p_slug: esc.slug, p_nombre: 'Ana Paz', p_profesion: 'Kinesióloga', p_categoria: esc.medica, p_telefono: '',
      p_cuit: '27111111117', p_condicion_iva: 1, ...cambios,
    });
  await esperarError(pedir({ p_cuit: '27-11111111-1' }), 'cuit_invalido');          // el último número no da
  await esperarError(pedir({ p_cuit: '2711111111' }), 'cuit_invalido');             // le falta un número
  await esperarError(pedir({ p_condicion_iva: 99 }), 'condicion_invalida');
  await esperarError(pedir({ p_condicion_iva: 13 }), 'condicion_invalida');          // la página ofrece cuatro
  const r = await pedir({});
  assert.deepEqual(await e.uno('select cuit, condicion_iva from public.miembros where id = $1', [r.id]),
    { cuit: '27-11111111-7', condicion_iva: 1 });
  // un pedido sin CUIT ni condición (por ejemplo, uno viejo guardado en el navegador) también entra: la dueña lo completa
  const s = await pedir({ p_cuit: '', p_condicion_iva: null });
  assert.deepEqual(await e.uno('select cuit, condicion_iva from public.miembros where id = $1', [s.id]), { cuit: '', condicion_iva: null });
  const foto = await e.foto(esc, esc.admin);
  assert.equal(foto.users.find((u) => u.id === r.id).ivaCond, 1);
});

prueba('la dueña corrige la CUIT y la condición de una profesional', async (e) => {
  const esc = await e.armar();
  const lucia = await e.miembro(esc, esc.lucia);
  const cambiar = (args) => e.llamarComo(esc.admin, 'cambiar_datos_fiscales_profesional', {
    p_slug: esc.slug, p_miembro: lucia, p_cuit: '20-12345678-6', p_condicion_iva: 1, ...args,
  });
  await esperarError(cambiar({ p_cuit: '20-12345678-9' }), 'cuit_invalido');
  await esperarError(cambiar({ p_condicion_iva: 2 }), 'condicion_invalida');
  await esperarError(cambiar({ p_miembro: await e.miembro(esc, esc.admin) }), 'profesional_inexistente');
  await cambiar({ p_cuit: '20123456786' });
  assert.deepEqual(await e.uno('select cuit, condicion_iva from public.miembros where id = $1', [lucia]),
    { cuit: '20-12345678-6', condicion_iva: 1 });
});

prueba('datos de facturación del consultorio: domicilio, Ingresos Brutos e inicio; el ambiente no se toca desde la página', async (e) => {
  const esc = await e.armar();
  await e.llamarComo(esc.admin, 'guardar_facturacion', {
    p_slug: esc.slug, p_nombre: 'Laura Benítez', p_cuit: '27301112225', p_condicion: 'Monotributo', p_punto_venta: 2,
    p_domicilio: 'Av. Siempreviva 742, CABA', p_iibb: '27-30111222-5', p_inicio: '2020-03-01',
  });
  assert.deepEqual((await e.foto(esc, esc.admin)).config.billing, {
    name: 'Laura Benítez', cuit: '27-30111222-5', cond: 'Monotributo', pos: 2, env: 'apagado',
    address: 'Av. Siempreviva 742, CABA', iibb: '27-30111222-5', start: '2020-03-01',
  });
  // sin esos datos (una página vieja), quedan los que había
  await e.llamarComo(esc.admin, 'guardar_facturacion', {
    p_slug: esc.slug, p_nombre: 'Laura Benítez', p_cuit: '27301112225', p_condicion: 'Monotributo', p_punto_venta: 3,
  });
  const b = (await e.foto(esc, esc.admin)).config.billing;
  assert.deepEqual([b.pos, b.address, b.start], [3, 'Av. Siempreviva 742, CABA', '2020-03-01']);
});

// ---------------------------------------------------------------------------------------------------------------
// «Facturar todo el mes»
// ---------------------------------------------------------------------------------------------------------------

prueba('facturar el mes: apagado, solo Factura C, mes que no llegó y datos del consultorio para facturar en real', async (e) => {
  const esc = await e.armar();
  const { periodo } = await mesAnterior(e);
  await esperarError(preparar(e, esc, periodo), 'facturacion_apagada');
  await ambiente(e, esc, 'prueba');
  await esperarError(preparar(e, esc, '2026-13'), 'dato_invalido');
  const [a, m] = (await e.fecha(0)).split('-').map(Number);
  await esperarError(preparar(e, esc, m === 12 ? `${a + 1}-01` : `${a}-${pad(m + 1)}`), 'periodo_futuro');
  await e.sql(`update public.consultorios set fact_condicion = 'Responsable inscripta' where id = $1`, [esc.id]);
  await esperarError(preparar(e, esc, periodo), 'solo_monotributo');
  await e.sql(`update public.consultorios set fact_condicion = 'Monotributo' where id = $1`, [esc.id]);
  await ambiente(e, esc, 'real', '');
  await esperarError(preparar(e, esc, periodo), 'faltan_datos_facturacion');
  await ambiente(e, esc, 'real');
  const r = await preparar(e, esc, periodo);                  // un mes sin alquileres no deja nada
  assert.deepEqual([r.ambiente, r.emisorCuit, r.emitir, r.faltan, r.revisar], ['real', '27301112225', [], [], []]);
  await esperarError(preparar(e, esc, `${a}-${pad(m)}`), 'mes_en_curso');   // una factura por mes: el mes tiene que haber terminado
});

prueba('facturar el mes: una factura por profesional con todo lo que alquiló; la que no tiene datos queda aparte', async (e) => {
  const esc = await e.armar();
  await ambiente(e, esc, 'prueba');
  const { periodo, dia } = await mesAnterior(e);
  const hoy = await e.fecha(0);
  // Lucía (médica, box 2 a $ 10.000 la hora): un turno de 4 h y otro de 4 h con el láser ($ 16.000 la hora)
  await alquilado(e, esc, esc.lucia, { dia: dia(5) });
  await alquilado(e, esc, esc.lucia, { dia: dia(12), maquinas: [esc.maquinas.laser] });
  // un turno cancelado y uno de otro mes no entran
  const cancelada = await e.reservar(esc, esc.lucia, { box: 1, fecha: await e.diaHabil(10) });
  await e.pagar(esc, esc.lucia, cancelada.id, 'sena');
  await e.llamarComo(esc.lucia, 'cancelar_reserva', { p_slug: esc.slug, p_reserva: cancelada.id });
  await e.sql('update public.reservas set fecha = $2 where id = $1', [cancelada.id, dia(6)]);
  await alquilado(e, esc, esc.lucia, { dia: await e.diaHabil(20), box: 1 });
  // Caro (esteticista, box 3 con precio propio de $ 8.000): no tiene cargada la condición frente al IVA
  await alquilado(e, esc, esc.caro, { dia: dia(7), box: 3 });
  const caro = await e.miembro(esc, esc.caro);
  await e.sql('update public.miembros set condicion_iva = null where id = $1', [caro]);

  const r = await preparar(e, esc, periodo);
  assert.equal(r.ambiente, 'prueba');
  assert.equal(r.emitir.length, 1);
  const f = r.emitir[0];
  assert.equal(f.estado, 'pendiente');
  assert.equal(f.numero, null);
  assert.deepEqual(f.comprobante, {
    tipo: 11, docTipo: 80, docNro: '27111111117', condicionIva: 6, total: 80000 + 64000, fecha: hoy,
    servicioDesde: dia(5), servicioHasta: dia(12),
  });
  assert.deepEqual(r.faltan, [{ userId: caro, name: 'Carolina Méndez', missing: 'condicion' }]);
  const fila = await e.uno('select horas, total, letra, lineas from public.facturas where id = $1', [f.id]);
  assert.deepEqual(fila, {
    horas: 8, total: 144000, letra: 'C',
    lineas: [{ text: 'Box 2 · 8 h × $ 10.000', amount: 80000 }, { text: 'Láser · 4 h × $ 16.000', amount: 64000 }],
  });
  // la profesional sin CUIT válida también queda aparte
  await e.sql(`update public.miembros set condicion_iva = 6, cuit = '27-11111111-1' where id = $1`, [caro]);
  assert.deepEqual((await preparar(e, esc, periodo)).faltan, [{ userId: caro, name: 'Carolina Méndez', missing: 'cuit' }]);
});

prueba('volver a facturar no duplica: la rechazada se pone al día, la emitida no se toca y la incierta queda congelada', async (e) => {
  const esc = await e.armar();
  await ambiente(e, esc, 'prueba');
  const { periodo, dia } = await mesAnterior(e);
  await alquilado(e, esc, esc.lucia, { dia: dia(5) });
  await alquilado(e, esc, esc.caro, { dia: dia(7), box: 3 });
  const r1 = await preparar(e, esc, periodo);
  const deLucia = r1.emitir.find((x) => x.comprobante.total === 40000);   // 4 h × $ 10.000
  const deCaro = r1.emitir.find((x) => x.comprobante.total === 32000);    // 4 h × $ 8.000
  assert.ok(deLucia && deCaro);

  await anotar(e, deLucia.id, 7);
  await resultado(e, deLucia.id, 'emitida');
  await anotar(e, deCaro.id, 8);
  await resultado(e, deCaro.id, 'rechazada', { p_observaciones: JSON.stringify([{ codigo: 10016, mensaje: 'no es el próximo' }]) });
  await alquilado(e, esc, esc.caro, { dia: dia(20), box: 3 });   // después de rechazada, Caro suma otro turno

  const r2 = await preparar(e, esc, periodo);
  assert.deepEqual(r2.emitir.map((x) => [x.id, x.estado, x.numero, x.comprobante.total]), [[deCaro.id, 'pendiente', null, 64000]]);

  await anotar(e, deCaro.id, 9);                                    // se manda y queda sin respuesta
  await alquilado(e, esc, esc.caro, { dia: dia(21), box: 3 });   // aunque cambie lo alquilado, la incierta no se toca
  const r3 = await preparar(e, esc, periodo);
  assert.deepEqual(r3.emitir.map((x) => [x.id, x.estado, x.numero, x.emisorCuit, x.puntoVenta, x.comprobante.total]),
    [[deCaro.id, 'incierta', 9, '20123456786', 1, 64000]]);
  assert.equal((await e.uno('select count(*)::int as n from public.facturas')).n, 2);

  // «revisar»: no vuelve a la lista para emitir; se avisa aparte
  await resultado(e, deCaro.id, 'revisar');
  const r4 = await preparar(e, esc, periodo);
  assert.deepEqual([r4.emitir, r4.revisar.map((x) => x.name)], [[], ['Carolina Méndez']]);
});

// ---------------------------------------------------------------------------------------------------------------
// Lo que usa solo la función de ARCA
// ---------------------------------------------------------------------------------------------------------------

prueba('las funciones de ARCA no se pueden llamar desde la página, y anotar y resultado siguen los pasos', async (e) => {
  const esc = await e.armar();
  await ambiente(e, esc, 'prueba');
  const { periodo, dia } = await mesAnterior(e);
  await alquilado(e, esc, esc.lucia, { dia: dia(5) });
  const [f] = (await preparar(e, esc, periodo)).emitir;

  const ejemplo = {
    arca_ticket: { p_ambiente: 'prueba' },
    arca_guardar_ticket: { p_ambiente: 'prueba', p_token: 't', p_sign: 's', p_vence: '2030-01-01T00:00:00Z' },
    arca_candado: { p_clave: 'x', p_dueno: 'y', p_segundos: 60 },
    arca_anotar: { p_factura: f.id, p_emisor_cuit: '20123456786', p_punto_venta: 1, p_numero: 1, p_version: 'x', p_dueno: 'y' },
    arca_resultado: { p_factura: f.id, p_estado: 'rechazada', p_cae: null, p_cae_vence: null, p_observaciones: '[]' },
  };
  // (las de Mercado Pago tienen la misma comprobación en mercadopago.test.mjs)
  assert.deepEqual(Object.keys(ejemplo).sort(), FUNCIONES_DE_SERVICIO.filter((n) => n.startsWith('arca_')).sort());
  for (const [fn, args] of Object.entries(ejemplo)) {
    await esperarSinPermiso(e.llamarComo(esc.admin, fn, args));
    await esperarSinPermiso(e.comoAnon((c) => c.llamar(fn, args)));
  }

  await esperarError(resultado(e, f.id, 'emitida'), 'factura_inexistente');                   // emitida sin número: no
  await esperarError(resultado(e, f.id, 'emitida', { p_cae: '123' }), 'dato_invalido');
  await esperarError(resultado(e, f.id, 'otra cosa'), 'dato_invalido');
  await anotar(e, f.id, 7);
  assert.deepEqual(await e.uno('select estado, numero, anotado_en is not null as anotada from public.facturas where id = $1', [f.id]),
    { estado: 'incierta', numero: 7, anotada: true });
  await resultado(e, f.id, 'emitida');
  assert.deepEqual(await e.uno('select estado, numero, cae, emitida_en is not null as emitida from public.facturas where id = $1', [f.id]),
    { estado: 'emitida', numero: 7, cae: '86471093086417', emitida: true });
  await esperarError(anotar(e, f.id, 8), 'factura_inexistente');                               // emitida: no se toca más
  await esperarError(resultado(e, f.id, 'rechazada'), 'factura_inexistente');

  // en prueba: no se le avisa a la profesional, y ella no la ve; la dueña sí, con su número
  assert.equal((await e.uno(`select count(*)::int as n from public.avisos where asunto like 'Tu factura%'`)).n, 0);
  const deLaDuena = (await e.foto(esc, esc.admin)).invoices;
  assert.deepEqual(deLaDuena.map((x) => [x.number, x.status, x.env, x.cae]), [['0001-00000007', 'emitida', 'prueba', '86471093086417']]);
  assert.deepEqual((await e.foto(esc, esc.lucia)).invoices, []);
});

prueba('en real, la factura emitida le llega por mail a la profesional y la ve solo ella', async (e) => {
  const esc = await e.armar();
  await ambiente(e, esc, 'real');
  const { periodo, dia } = await mesAnterior(e);
  await alquilado(e, esc, esc.lucia, { dia: dia(5) });
  const [f] = (await preparar(e, esc, periodo)).emitir;
  await anotar(e, f.id, 3);
  await resultado(e, f.id, 'emitida');
  const aviso = await e.uno(`select asunto, cuerpo from public.avisos where asunto like 'Tu factura%'`);
  assert.match(aviso.asunto, /^Tu factura de [a-z]+ de \d{4}$/);
  assert.match(aviso.cuerpo, /Factura C 0001-00000003, por \$ 40\.000\./);
  assert.match(aviso.cuerpo, /CAE\): 86471093086417/);
  assert.equal((await e.foto(esc, esc.lucia)).invoices[0].number, '0001-00000003');
  assert.deepEqual((await e.foto(esc, esc.caro)).invoices, []);
  // si el consultorio vuelve a prueba, la pantalla de la dueña ya no las mezcla
  await ambiente(e, esc, 'prueba');
  assert.deepEqual((await e.foto(esc, esc.admin)).invoices, []);
});

prueba('el candado de cada numeración y el ticket de ARCA', async (e) => {
  const tomar = (dueno, segundos = 60) =>
    servicio(e, 'arca_candado', { p_clave: 'prueba:20123456786:1:11', p_dueno: dueno, p_segundos: segundos });
  assert.equal(await tomar('a'), true);
  assert.equal(await tomar('b'), false);
  assert.equal(await tomar('a'), true);                    // quien lo tiene lo renueva
  await tomar('a', 0);                                      // y lo suelta
  assert.equal(await tomar('b'), true);
  await e.sql(`update interno.arca_candados set hasta = now() - interval '1 second'`);
  assert.equal(await tomar('c'), true);                    // vencido, lo toma otro

  assert.equal(await servicio(e, 'arca_ticket', { p_ambiente: 'prueba' }), null);
  const guardar = (token) => servicio(e, 'arca_guardar_ticket', { p_ambiente: 'prueba', p_token: token, p_sign: 's', p_vence: '2030-01-01T03:00:00Z' });
  await guardar('t1');
  await guardar('t2');
  const t = await servicio(e, 'arca_ticket', { p_ambiente: 'prueba' });
  assert.deepEqual([t.token, t.sign, Date.parse(t.vence)], ['t2', 's', Date.parse('2030-01-01T03:00:00Z')]);
  assert.equal(await servicio(e, 'arca_ticket', { p_ambiente: 'real' }), null);
  await esperarError(guardar(''), 'dato_invalido');
});

prueba('anotar el número: solo con el candado de esa numeración y si lo que se manda es lo que quedó congelado', async (e) => {
  const esc = await e.armar();
  await ambiente(e, esc, 'prueba');
  const { periodo, dia } = await mesAnterior(e);
  await alquilado(e, esc, esc.lucia, { dia: dia(5) });
  const [f] = (await preparar(e, esc, periodo)).emitir;
  const anotarSin = (args) => servicio(e, 'arca_anotar', {
    p_factura: f.id, p_emisor_cuit: '20123456786', p_punto_venta: 1, p_numero: 1, p_version: f.version, p_dueno: 'pruebas', ...args,
  });
  await esperarError(anotarSin({}), 'candado_perdido');                                        // nadie tomó el candado
  await servicio(e, 'arca_candado', { p_clave: 'prueba:20123456786:1:11', p_dueno: 'otra corrida', p_segundos: 300 });
  await esperarError(anotarSin({}), 'candado_perdido');                                        // lo tiene otra corrida
  await e.sql(`update interno.arca_candados set dueno = 'pruebas', hasta = now() - interval '1 second'`);
  await esperarError(anotarSin({}), 'candado_perdido');                                        // es suyo, pero venció
  await servicio(e, 'arca_candado', { p_clave: 'prueba:20123456786:1:11', p_dueno: 'pruebas', p_segundos: 300 });
  await esperarError(anotarSin({ p_punto_venta: 2 }), 'candado_perdido');                      // el candado es de otro punto de venta
  // otra corrida volvió a preparar la factura con otro total: lo que se iba a mandar ya no es lo congelado
  await e.sql('update public.facturas set total = total + 1 where id = $1', [f.id]);
  await esperarError(anotarSin({}), 'factura_cambio');
  await e.sql('update public.facturas set total = total - 1 where id = $1', [f.id]);
  await anotarSin({});
  assert.equal((await e.uno('select estado from public.facturas where id = $1', [f.id])).estado, 'incierta');
});

prueba('una factura en duda se concilia aunque ya no tenga reservas, y aunque se facture otro mes', async (e) => {
  const esc = await e.armar();
  await ambiente(e, esc, 'prueba');
  const { periodo, dia } = await mesAnterior(e);
  const reserva = await alquilado(e, esc, esc.lucia, { dia: dia(5) });
  const [f] = (await preparar(e, esc, periodo)).emitir;
  await anotar(e, f.id, 4);                                                        // salió y quedó sin respuesta
  await e.sql(`update public.reservas set fecha = fecha - interval '3 months' where id = $1`, [reserva]);   // ya no está en el mes
  const r1 = await preparar(e, esc, periodo);
  assert.deepEqual(r1.emitir.map((x) => [x.id, x.estado, x.numero]), [[f.id, 'incierta', 4]]);
  // facturando otro mes (dos meses atrás), también vuelve primero
  const [a, m] = (await e.fecha(0)).split('-').map(Number);
  const otro = new Date(Date.UTC(a, m - 3, 1));
  const r2 = await preparar(e, esc, `${otro.getUTCFullYear()}-${pad(otro.getUTCMonth() + 1)}`);
  assert.deepEqual(r2.emitir.map((x) => [x.id, x.estado, x.periodo]), [[f.id, 'incierta', periodo]]);
});

prueba('la foto muestra la factura con los datos con que salió, aunque después cambien', async (e) => {
  const esc = await e.armar();
  await ambiente(e, esc, 'prueba');
  const { periodo, dia } = await mesAnterior(e);
  await alquilado(e, esc, esc.lucia, { dia: dia(5) });
  const [f] = (await preparar(e, esc, periodo)).emitir;
  await anotar(e, f.id, 2);
  await resultado(e, f.id, 'emitida');
  await e.llamarComo(esc.admin, 'cambiar_datos_fiscales_profesional', {
    p_slug: esc.slug, p_miembro: await e.miembro(esc, esc.lucia), p_cuit: '20-12345678-6', p_condicion_iva: 1,
  });
  const [inv] = (await e.foto(esc, esc.admin)).invoices;
  assert.deepEqual([inv.docNro, inv.ivaCond, inv.issuerCuit, inv.number], ['27111111117', 6, '20123456786', '0001-00000002']);
});
