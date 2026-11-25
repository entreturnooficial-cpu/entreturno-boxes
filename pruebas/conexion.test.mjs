// La conexión de la página con el servidor, de punta a punta: web/conexion.js hablando por la red con el servidor de prueba.
// Acá se comprueba lo que las pruebas de la base no ven: el ingreso, la sesión que se renueva sola y que los datos
// que manda la página (listas, fechas, objetos) lleguen a la base con el tipo correcto.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import '../web/conexion.js';
import { CLAVE_DE_PRUEBA, DUENA, PROFESIONALES } from './datos-de-ejemplo.mjs';
import { CLAVE_PUBLICA, crearServidor } from './servidor-local.mjs';

const { crearConexion } = globalThis;
const [LUCIA, CARO, MARTINA] = PROFESIONALES;

function almacen() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

let s;
before(async () => { s = await crearServidor(); });
after(async () => { await s.cerrar(); });

const conexion = (alm = almacen(), extra = {}) => crearConexion({ url: s.url, key: CLAVE_PUBLICA, slug: 'lavanda', almacen: alm, ...extra });
const falla = (promesa, codigo) => assert.rejects(promesa, (e) => {
  assert.equal(e.code, codigo, `se esperaba ${codigo} y vino ${e.code} (${e.status})`);
  return true;
});
async function entrarComo(persona, alm = almacen(), extra = {}) {
  const c = conexion(alm, extra);
  await c.entrar(persona.email, CLAVE_DE_PRUEBA);
  return c;
}
/** El primer día de lunes a sábado, a `dias` días de hoy o después (el servidor trabaja con la fecha de Buenos Aires). */
function diaHabil(dias) {
  const d = new Date(Date.now() - 3 * 3600 * 1000);
  d.setUTCDate(d.getUTCDate() + dias);
  if (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

test('sin entrar se ve la portada y nada más', async () => {
  const c = conexion();
  assert.equal(c.sesion, null);
  const p = await c.rpc('portada');
  assert.deepEqual([p.site.name, p.site.owner, p.boxCount, p.config.categories.length], ['Consultorio Lavanda', 'Laura', 3, 2]);
  await falla(c.rpc('foto'), '42501');
  await falla(c.rpc('reservar', { p_box: 1, p_fecha: diaHabil(3), p_desde: 8, p_hasta: 12, p_servicio: '', p_plan: 'sena', p_maquinas: [], p_reglamento_version: 1 }), '42501');
  await falla(crearConexion({ url: s.url, key: CLAVE_PUBLICA, slug: 'no-existe', almacen: almacen() }).rpc('portada'), 'consultorio_inexistente');
});

test('entrar: clave equivocada no entra; la sesión queda guardada para la próxima vez', async () => {
  const alm = almacen();
  const c = conexion(alm);
  await falla(c.entrar(LUCIA.email, 'otra-clave'), 'invalid_credentials');
  await falla(c.entrar('nadie@lavanda.prueba', CLAVE_DE_PRUEBA), 'invalid_credentials');
  assert.equal(c.sesion, null);
  const avisos = [];
  c.alCambiar((ses) => avisos.push(ses ? ses.user.email : null));
  await c.entrar(LUCIA.email.toUpperCase(), CLAVE_DE_PRUEBA);
  assert.equal(c.sesion.user.email, LUCIA.email);
  assert.deepEqual(avisos, [LUCIA.email]);
  const foto = await c.rpc('foto');
  assert.deepEqual(foto.users.map((u) => [u.name, u.status]), [['Lucía Ferrari', 'aprobado']]);
  // Otra pestaña (misma memoria del navegador) ya está adentro, sin volver a poner la clave
  const otra = conexion(alm);
  assert.equal(otra.sesion.user.email, LUCIA.email);
  assert.equal((await otra.rpc('foto')).me, foto.me);
  // Salir: no queda nada guardado y la renovación vieja deja de servir
  const renovacion = c.sesion.refresh_token;
  await c.salir();
  assert.deepEqual([c.sesion, alm.getItem('et-sesion'), avisos.at(-1)], [null, null, null]);
  await falla(c.rpc('foto'), '42501');
  alm.setItem('et-sesion', JSON.stringify({ access_token: 'x.y.z', refresh_token: renovacion, expires_at: 1, user: {} }));
  await falla(conexion(alm).rpc('foto'), 'refresh_token_not_found');
});

test('crear la cuenta y pedir acceso', async () => {
  const c = conexion();
  await falla(c.crearCuenta('sin-arroba', 'clave-larga-1'), 'validation_failed');
  await falla(c.crearCuenta('ana@lavanda.prueba', '123'), 'weak_password');
  await falla(c.crearCuenta(LUCIA.email, 'clave-larga-1'), 'user_already_exists');
  await c.crearCuenta('ana@lavanda.prueba', 'clave-larga-1');
  // Con cuenta pero sin haber pedido acceso: ve la portada y sabe que todavía no es nadie acá
  const antes = await c.rpc('foto');
  assert.deepEqual([antes.me, antes.site.name, antes.bookings], [null, 'Consultorio Lavanda', undefined]);
  const pedido = await c.rpc('pedir_acceso', { p_nombre: 'Ana Paz', p_profesion: 'Kinesióloga', p_categoria: antes.config.categories[1].id, p_telefono: '11 5555-0199', p_cuit: '', p_privacidad: antes.site.privacy.hash, p_exterior: true });
  assert.equal(pedido.status, 'pendiente');
  const foto = await c.rpc('foto');
  assert.deepEqual(foto.users.map((u) => [u.name, u.status, u.email]), [['Ana Paz', 'pendiente', 'ana@lavanda.prueba']]);
  assert.deepEqual([foto.bookings, foto.blocks], [[], []]);
  await falla(c.rpc('pedir_acceso', { p_nombre: 'Ana Paz', p_profesion: 'Kinesióloga', p_categoria: antes.config.categories[1].id, p_telefono: '', p_cuit: '' }), 'ya_sos_miembro');
});

test('recorrido completo por la red: aprobar, reservar con máquina, pagar, bloquear, configurar y cancelar', async () => {
  const duena = await entrarComo(DUENA);
  const lucia = await entrarComo(LUCIA);
  const martina = await entrarComo(MARTINA);
  const dia = diaHabil(4);

  // La dueña aprueba a Martina
  await falla(martina.rpc('reservar', { p_box: 1, p_fecha: dia, p_desde: 8, p_hasta: 12, p_servicio: '', p_plan: 'sena', p_maquinas: [], p_reglamento_version: 1 }), 'no_aprobada');
  const panel = await duena.rpc('foto');
  const pendiente = panel.users.find((u) => u.name === 'Martina Sosa');
  await falla(lucia.rpc('cambiar_estado_profesional', { p_miembro: pendiente.id, p_estado: 'aprobado' }), 'solo_admin');
  await duena.rpc('cambiar_estado_profesional', { p_miembro: pendiente.id, p_estado: 'aprobado' });

  // Lucía reserva el box 3 con el láser (lista de máquinas como la manda la página)
  const laser = panel.machines.find((m) => m.name === 'Láser de depilación');
  const r = await lucia.rpc('reservar', { p_box: 3, p_fecha: dia, p_desde: 8, p_hasta: 12, p_servicio: 'Dermatología', p_plan: 'sena', p_maquinas: [laser.id], p_reglamento_version: 1 });
  assert.deepEqual([r.total, r.amount, r.status], [48000 + 64000, 56000, 'pago']);
  await falla(martina.rpc('reservar', { p_box: 3, p_fecha: dia, p_desde: 8, p_hasta: 12, p_servicio: '', p_plan: 'total', p_maquinas: [], p_reglamento_version: 1 }), 'horario_no_disponible');
  await falla(martina.rpc('reservar', { p_box: 1, p_fecha: dia, p_desde: 8, p_hasta: 12, p_servicio: '', p_plan: 'total', p_maquinas: [laser.id], p_reglamento_version: 1 }), 'maquina_no_disponible');
  assert.deepEqual(await lucia.rpc('simular_pago', { p_reserva: r.id, p_tipo: 'sena' }), { status: 'confirmada', paid: 56000, balance: 56000 });

  // Martina ve ese horario como ocupado, sin datos de Lucía
  const vista = await martina.rpc('foto');
  assert.deepEqual(vista.bookings.map((b) => [b.userId, b.boxId, b.date, b.start, b.end, b.status]), [[null, 3, dia, 8, 12, 'ocupado']]);
  assert.ok(!JSON.stringify(vista).includes('Lucía') && !JSON.stringify(vista).includes('Dermatología'));

  // La dueña bloquea dos boxes (lista de números), publica un rato y cambia la configuración (listas, textos y objetos)
  const b = await duena.rpc('bloquear', { p_boxes: [1, 2], p_fecha: dia, p_desde: 8, p_hasta: 16, p_semanal: false, p_nota: 'Atiendo yo' });
  assert.equal(b.clashes, 0);
  const rato = await duena.rpc('publicar_rato', { p_box: 2, p_fecha: dia, p_desde: 12, p_hasta: 14 });
  await falla(martina.rpc('reservar', { p_box: 1, p_fecha: dia, p_desde: 8, p_hasta: 12, p_servicio: '', p_plan: 'total', p_maquinas: [], p_reglamento_version: 1 }), 'horario_no_disponible');
  const corto = await martina.rpc('reservar', { p_box: 2, p_fecha: dia, p_desde: 12, p_hasta: 14, p_servicio: 'Limpieza', p_plan: 'total', p_maquinas: [], p_reglamento_version: 1 });
  assert.equal(corto.total, 12000);
  await duena.rpc('guardar_turnos', { p_turno_horas: 4, p_abre: 8, p_cierra: 20, p_dias: [6, 1, 2, 3, 4, 5] });
  const medica = panel.config.categories[0].id;
  await duena.rpc('guardar_box', { p_numero: 1, p_nombre: 'Box 1', p_resumen: 'Camilla · lavatorio', p_equipamiento: ['Camilla eléctrica', 'Lavatorio, con agua caliente'], p_precios: { [medica]: '11000' } });
  await duena.rpc('guardar_reglamento', { p_texto: 'Reglamento nuevo.' });
  const despues = await duena.rpc('foto');
  assert.deepEqual(despues.config.days, [1, 2, 3, 4, 5, 6]);
  assert.deepEqual([despues.boxes[0].equipment, despues.boxes[0].prices], [['Camilla eléctrica', 'Lavatorio, con agua caliente'], { [medica]: 11000 }]);
  assert.equal(despues.config.terms.version, 2);
  assert.deepEqual(despues.blocks.map((x) => [x.boxIds, x.date, x.start, x.end, x.note]), [[[1, 2], dia, 8, 16, 'Atiendo yo']]);
  assert.deepEqual(despues.releases, [{ id: rato.id, boxId: 2, date: dia, start: 12, end: 14 }]);
  assert.equal(despues.bookings.length, 2);

  // Lucía cancela con menos de 7 días: pagó solo la seña, no se le devuelve
  assert.deepEqual(await lucia.rpc('cancelar_reserva', { p_reserva: r.id }), { amount: 0, pct: 0, paid: 56000, by: 'pro' });
  // La dueña cancela la de Martina (sin pagar): queda libre
  assert.equal((await duena.rpc('cancelar_reserva', { p_reserva: corto.id })).by, 'admin');
  await duena.rpc('quitar_bloqueo', { p_bloqueo: b.id });
  assert.deepEqual([(await duena.rpc('foto')).blocks, (await duena.rpc('foto')).releases], [[], []]);
});

test('un parámetro mal escrito o que falta se rechaza antes de llegar a la base', async () => {
  const lucia = await entrarComo(LUCIA);
  await falla(lucia.rpc('cancelar_reserva', { p_reservas: '00000000-0000-0000-0000-000000000000' }), 'PGRST202');
  await falla(lucia.rpc('cancelar_reserva', {}), 'PGRST202');
  await falla(lucia.rpc('funcion_que_no_existe', {}), 'PGRST202');
  await falla(lucia.rpc('cancelar_reserva', { p_reserva: 'no-es-un-id' }), '22P02');
});

test('la sesión se renueva sola, una sola vez aunque haya varias llamadas juntas', async () => {
  let adelanto = 0;
  const alm = almacen();
  const lucia = await entrarComo(LUCIA, alm, { ahora: () => Date.now() + adelanto });
  const primera = { ...lucia.sesion };
  adelanto = 2 * 3600 * 1000;                           // para la página pasaron dos horas: el pase ya venció
  const [a, b, c] = await Promise.all([lucia.rpc('foto'), lucia.rpc('foto'), lucia.rpc('portada')]);
  assert.deepEqual([a.me, b.me, c.site.name], [a.me, a.me, 'Consultorio Lavanda']);
  assert.notEqual(lucia.sesion.refresh_token, primera.refresh_token);
  assert.equal(JSON.parse(alm.getItem('et-sesion')).refresh_token, lucia.sesion.refresh_token);
  // El código de renovación viejo se usó una sola vez: si se hubiera pedido dos veces, la segunda habría fallado
  await falla(crearConexion({ url: s.url, key: CLAVE_PUBLICA, slug: 'lavanda', almacen: { ...almacen(), getItem: () => JSON.stringify({ ...primera, expires_at: 1 }) } }).rpc('foto'),
    'refresh_token_not_found');
});

test('si el servidor dice que el pase venció, se renueva y la llamada se repite sola', async () => {
  s.duracionPase = -30;                                 // el pase nace vencido (como si el reloj de la compu estuviera mal)
  const lucia = await entrarComo(LUCIA, almacen(), { ahora: () => Date.now() - 3600 * 1000 });   // y la página cree que sigue vigente
  s.duracionPase = 3600;
  const antes = lucia.sesion.access_token;
  assert.ok((await lucia.rpc('foto')).me);
  assert.notEqual(lucia.sesion.access_token, antes);
});

test('salir mientras se está renovando el pase no vuelve a dejar la sesión iniciada', async () => {
  let soltar;
  const espera = new Promise((r) => { soltar = r; });
  let adelanto = 0;
  // La renovación sale bien en el servidor, pero la respuesta llega tarde: después de que la persona tocó «Salir»
  const lento = async (url, opciones) => { const r = await fetch(url, opciones); if (String(url).includes('grant_type=refresh_token')) await espera; return r; };
  const alm = almacen();
  const lucia = await entrarComo(LUCIA, alm, { ahora: () => Date.now() + adelanto, fetch: lento });
  adelanto = 2 * 3600 * 1000;
  const llamada = lucia.rpc('foto');                    // necesita renovar: queda esperando la respuesta
  llamada.catch(() => {});
  await new Promise((r) => setTimeout(r, 80));
  await lucia.salir();
  soltar();
  await falla(llamada, 'sin_sesion');
  assert.deepEqual([lucia.sesion, alm.getItem('et-sesion')], [null, null]);
  // Y si en el medio entró otra persona, la respuesta vieja tampoco pisa su sesión
  let soltar2;
  const espera2 = new Promise((r) => { soltar2 = r; });
  const lento2 = async (url, opciones) => { const r = await fetch(url, opciones); if (String(url).includes('grant_type=refresh_token')) await espera2; return r; };
  adelanto = 0;
  const c = conexion(alm, { ahora: () => Date.now() + adelanto, fetch: lento2 });
  await c.entrar(LUCIA.email, CLAVE_DE_PRUEBA);
  adelanto = 2 * 3600 * 1000;
  const vieja = c.rpc('foto');
  vieja.catch(() => {});
  await new Promise((r) => setTimeout(r, 80));
  adelanto = 0;
  await c.entrar(CARO.email, CLAVE_DE_PRUEBA);
  soltar2();
  await falla(vieja, 'sin_sesion');
  assert.equal(c.sesion.user.email, CARO.email);
  assert.deepEqual((await c.rpc('foto')).users.map((u) => u.name), ['Carolina Méndez']);
});

test('si la sesión ya no se puede renovar, queda afuera y la página se entera', async () => {
  const alm = almacen();
  const lucia = await entrarComo(LUCIA, alm);
  const avisos = [];
  lucia.alCambiar((ses) => avisos.push(ses));
  alm.setItem('et-sesion', JSON.stringify({ ...lucia.sesion, refresh_token: 'inventado', expires_at: 1 }));
  lucia.releer();
  await falla(lucia.rpc('foto'), 'refresh_token_not_found');
  assert.deepEqual([lucia.sesion, avisos, alm.getItem('et-sesion')], [null, [null], null]);
});

test('sin conexión avisa «sin_conexion» y no pierde la sesión', async () => {
  const alm = almacen();
  const lucia = await entrarComo(LUCIA, alm);
  const cortada = crearConexion({ url: 'http://127.0.0.1:9', key: CLAVE_PUBLICA, slug: 'lavanda', almacen: alm });
  await falla(cortada.rpc('foto'), 'sin_conexion');
  assert.equal(cortada.sesion.user.email, LUCIA.email);
  assert.ok((await lucia.rpc('foto')).me);
});

/** Abre un enlace de los mails de fábrica de Supabase como lo haría el navegador y devuelve adónde vuelve. */
async function abrirEnlaceDeFabrica(enlace) {
  const r = await fetch(enlace, { redirect: 'manual' });
  assert.equal(r.status, 302);
  return new URL(r.headers.get('location'));
}

test('con confirmación de mail: la cuenta se crea, pero no entra hasta abrir el enlace', async () => {
  s.confirmarMail = true;
  try {
    const alm = almacen();
    const c = conexion(alm);
    const pedido = { slug: 'lavanda', p_nombre: 'Eva Ñandú', p_profesion: 'Nutricionista', p_telefono: '11 5555-0142' };
    const antes = s.mails.length;
    await falla(c.crearCuenta('eva@lavanda.prueba', 'clave-larga-1', 'http://pagina.prueba/boxes/', { pedido }), 'confirmar_mail');
    assert.deepEqual([c.sesion, alm.getItem('et-sesion'), s.mails.length], [null, null, antes + 1]);
    const mail = s.mails.at(-1);
    assert.deepEqual([mail.para, mail.asunto], ['eva@lavanda.prueba', 'Confirmá tu cuenta']);
    assert.match(mail.enlace, /^http:\/\/pagina\.prueba\/boxes\/#token_hash=[0-9a-f]{56}&type=email$/);      // va a la página, con el código después del #
    assert.match(mail.enlaceDeFabrica, /type=signup&redirect_to=http%3A%2F%2Fpagina\.prueba%2Fboxes%2F$/);
    await falla(c.entrar('eva@lavanda.prueba', 'clave-larga-1'), 'email_not_confirmed');
    // Pedir la cuenta otra vez sin haber confirmado, o tocar «mandarlo de nuevo», manda otro mail
    await falla(c.crearCuenta('eva@lavanda.prueba', 'clave-larga-1', 'http://pagina.prueba/boxes/'), 'confirmar_mail');
    await c.reenviar('eva@lavanda.prueba', 'http://pagina.prueba/boxes/');
    await c.reenviar('nadie@lavanda.prueba', 'http://pagina.prueba/boxes/');             // sin cuenta: contesta igual y no manda nada
    assert.equal(s.mails.length, antes + 3);
    // Un mail que ya tiene cuenta confirmada: contesta lo mismo (no cuenta quién tiene cuenta) y no sale ningún mail
    await falla(c.crearCuenta(LUCIA.email, 'clave-larga-1', 'http://pagina.prueba/boxes/'), 'confirmar_mail');
    assert.equal(s.mails.length, antes + 3);

    // La página canjea el código del enlace por la sesión
    const fragmento = new URL(mail.enlace).hash;
    assert.deepEqual([c.hayEnlace(''), c.hayEnlace('#reservar'), c.hayEnlace(fragmento), c.hayEnlace('#error=access_denied')], [false, false, true, true]);
    assert.deepEqual([await c.entrarPorEnlace(''), await c.entrarPorEnlace('#reservar'), c.sesion], [null, null, null]);
    assert.equal(await c.entrarPorEnlace(fragmento.replace('type=email', 'type=recovery')), 'error');     // un código de confirmación no sirve para cambiar la contraseña
    assert.equal(c.sesion, null);
    await falla(crearConexion({ url: 'http://127.0.0.1:9', key: CLAVE_PUBLICA, slug: 'lavanda', almacen: almacen() }).entrarPorEnlace(fragmento), 'sin_conexion');
    const avisos = [];
    c.alCambiar((ses) => avisos.push(ses && ses.user.email));
    assert.equal(await c.entrarPorEnlace(fragmento), 'email');
    assert.deepEqual([c.sesion.user.email, avisos, JSON.parse(alm.getItem('et-sesion')).user.email], ['eva@lavanda.prueba', ['eva@lavanda.prueba'], 'eva@lavanda.prueba']);
    assert.deepEqual(c.datosDeLaCuenta().pedido, pedido);                                // con la ñ y el acento sanos
    assert.equal((await c.rpc('foto')).me, null);
    // Usado una vez, el enlace ya no sirve: avisa el error y no toca la sesión que había
    assert.equal(await c.entrarPorEnlace(fragmento), 'error');
    assert.equal(await c.entrarPorEnlace('#error=access_denied&error_code=otp_expired'), 'error');
    assert.equal(c.sesion.user.email, 'eva@lavanda.prueba');
    // Los mails de fábrica de Supabase (el enlace pasa por el servidor y vuelve con la sesión armada) también se entienden
    await c.salir();
    await falla(c.crearCuenta('ines@lavanda.prueba', 'clave-larga-1', 'http://pagina.prueba/boxes/'), 'confirmar_mail');
    const vuelta = await abrirEnlaceDeFabrica(s.mails.at(-1).enlaceDeFabrica);
    assert.equal(vuelta.origin + vuelta.pathname, 'http://pagina.prueba/boxes/');
    assert.equal(await c.entrarPorEnlace(vuelta.hash), 'signup');
    assert.equal(c.sesion.user.email, 'ines@lavanda.prueba');
    assert.equal((await c.rpc('foto')).me, null);
    // Un pase armado a mano con el mail de otra persona, junto con un código de renovación propio: no entra y no queda nada guardado
    const armado = `x.${Buffer.from(JSON.stringify({ sub: 'otra-persona', email: LUCIA.email, exp: 4102444800 })).toString('base64url')}.y`;
    const almTrampa = almacen();
    const trampa = conexion(almTrampa);
    assert.equal(await trampa.entrarPorEnlace(`#access_token=${armado}&refresh_token=${c.sesion.refresh_token}&expires_in=3600&type=signup`), 'error');
    assert.deepEqual([trampa.sesion, almTrampa.getItem('et-sesion')], [null, null]);
    await c.salir();
    await c.entrar('eva@lavanda.prueba', 'clave-larga-1');
    // Lo anotado en la cuenta se puede borrar; el pase que ya estaba emitido lo sigue trayendo hasta renovarse
    await c.guardarDatos({ pedido: null });
    const otra = conexion();
    await otra.entrar('eva@lavanda.prueba', 'clave-larga-1');
    assert.deepEqual(otra.datosDeLaCuenta(), {});
  } finally {
    s.confirmarMail = false;
  }
});

test('olvidé mi contraseña: el enlace del mail deja elegir una nueva', async () => {
  const c = conexion();
  await c.crearCuenta('olga@lavanda.prueba', 'clave-vieja-1');
  await c.salir();
  const antes = s.mails.length;
  await c.recuperar('nadie@lavanda.prueba', 'http://pagina.prueba/');                     // no dice si la cuenta existe
  assert.equal(s.mails.length, antes);
  await c.recuperar('OLGA@lavanda.prueba', 'http://pagina.prueba/');
  const mail = s.mails.at(-1);
  assert.deepEqual([s.mails.length, mail.para, mail.asunto], [antes + 1, 'olga@lavanda.prueba', 'Elegí una contraseña nueva']);
  await falla(c.cambiarClave('clave-nueva-2'), 'bad_jwt');                                // sin haber vuelto del mail no se puede
  assert.match(mail.enlace, /^http:\/\/pagina\.prueba\/#token_hash=[0-9a-f]{56}&type=recovery$/);
  assert.equal(await c.entrarPorEnlace('#otra-cosa' + new URL(mail.enlace).hash), 'recovery');      // vale lo que viene después del último #
  assert.equal(c.sesion.user.email, 'olga@lavanda.prueba');
  await falla(c.cambiarClave('123'), 'weak_password');
  await falla(c.cambiarClave('clave-vieja-1'), 'same_password');
  await c.cambiarClave('clave-nueva-2');
  await c.salir();
  await falla(c.entrar('olga@lavanda.prueba', 'clave-vieja-1'), 'invalid_credentials');
  await c.entrar('olga@lavanda.prueba', 'clave-nueva-2');
  assert.equal(c.sesion.user.email, 'olga@lavanda.prueba');
});

test('el servidor de prueba entrega la página y su configuración, y nada de afuera de la carpeta web', async () => {
  const config = await (await fetch(`${s.url}/config.js`)).text();
  assert.match(config, /^window\.ENTRETURNO = \{"url":"http:\/\/localhost:\d+","key":"clave-publica-de-prueba","slug":"lavanda","prueba":true\};/);
  assert.equal((await fetch(`${s.url}/conexion.js`)).status, 200);
  for (const ruta of ['/../package.json', '/..%2Fpackage.json', '/%2e%2e/pruebas/datos-de-ejemplo.mjs', '/no-existe.js']) {
    assert.equal((await fetch(`${s.url}${ruta}`)).status, 404, ruta);
  }
  assert.equal((await fetch(`${s.url}/rest/v1/rpc/portada`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"p_slug":"lavanda"}' })).status, 401);
});
