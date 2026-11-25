// Prueba del cobro con Mercado Pago en la página entera (web\index.html), en un Edge sin ventana, contra el servidor
// de prueba con el Mercado Pago simulado (sus «pantallas» son /__mp/autorizar y /__mp/pagar).
//   node pruebas/pantallas-mp.mjs          (npm run test:pantallas-mp)
// Hace lo que haría una persona: la dueña conecta su cuenta y la confirma; una profesional reserva, sale a pagar y
// vuelve confirmada; paga el saldo aunque el aviso no llegue; le rechazan la tarjeta, vuelve sin pagar y reintenta;
// cancela y la devolución sale sola; la cuenta se queda sin saldo y la dueña lo ve; sin cuenta no se puede pagar.
// No toca internet ni plata. Al final dice en qué carpeta quedaron las capturas (ver navegador.mjs).
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { CLAVE_DE_PRUEBA, DUENA, PROFESIONALES } from './datos-de-ejemplo.mjs';
import { NAVEGADOR, carpetaDeCapturas } from './navegador.mjs';
import { crearServidor } from './servidor-local.mjs';

const [LUCIA, CARO] = PROFESIONALES;
const dos = (n) => String(n).padStart(2, '0');
const CAPTURAS = carpetaDeCapturas('pantallas-mp');
const PUERTO = +(process.env.PUERTO || 9473);
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

const s = await crearServidor({ pagos: 'mercadopago', mpAmbiente: 'real' });
const nav = spawn(NAVEGADOR, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--remote-debugging-port=${PUERTO}`,
  `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'edge-boxes-mp-'))}`, '--window-size=1366,768', 'about:blank'], { stdio: 'ignore' });
let info;
for (let i = 0; i < 80 && !info; i++) { try { info = (await (await fetch(`http://127.0.0.1:${PUERTO}/json`)).json()).find((t) => t.type === 'page'); } catch {} if (!info) await dormir(250); }
const ws = new WebSocket(info.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
let id = 0; const pend = new Map(); const errores = [];
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); }
  // (la vuelta de Mercado Pago trae una dirección larguísima: se le saca lo que va después del «?» para que se lea dónde falló)
  if (d.method === 'Runtime.exceptionThrown') errores.push((d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text).replace(/\?[^\s:)]*/g, '').slice(0, 700));
  if (d.method === 'Log.entryAdded' && d.params.entry.level === 'error') errores.push(`${d.params.entry.text.slice(0, 160)} ${d.params.entry.url ?? ''}`); };
const cdp = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const js = async (expr) => { const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return r.result?.result?.value ?? ('ERROR: ' + (r.result?.exceptionDetails?.exception?.description || JSON.stringify(r.result))); };

let fallas = 0, hechas = 0, numero = 0;
function ver(nombre, valor, espera) {
  const texto = typeof valor === 'string' ? valor : JSON.stringify(valor);
  const ok = typeof espera === 'function' ? !!espera(valor) : texto.includes(espera);
  hechas++; if (!ok) fallas++;
  console.log(`  ${ok ? '[OK]   ' : '[FALLA]'} ${nombre.padEnd(38)} ${texto.replace(/\s+/g, ' ').slice(0, 260)}`);
}
const foto = async (nombre) => { const r = await cdp('Page.captureScreenshot', { format: 'png' }); writeFileSync(`${CAPTURAS}/${dos(++numero)}-${nombre}.png`, Buffer.from(r.result.data, 'base64')); };
async function hasta(expr, ms = 6000) { for (let t = 0; t < ms; t += 100) { if (await js(`!!(${expr})`) === true) return true; await dormir(100); } return false; }
const EN_LA_PAGINA = `typeof fase !== "undefined" && fase === "lista" && !ocupada`;
const quieta = () => hasta(EN_LA_PAGINA);
const clic = async (sel) => { const r = await js(`(() => { const e = [...document.querySelectorAll(${JSON.stringify(sel)})].filter(x => x.offsetParent !== null || x.closest('.overlay'))[0]; if (!e) return 'NO ESTÁ ' + ${JSON.stringify(sel)}; e.click(); return 'ok'; })()`); await dormir(120); await quieta(); return r; };
const boton = async (texto) => { const r = await js(`(() => { const b = [...document.querySelectorAll('.overlay button, main button, .auth button')].filter(e => (e.offsetParent !== null || e.closest('.overlay')) && e.textContent.trim().startsWith(${JSON.stringify(texto)})).pop(); if (!b) return 'NO ESTÁ el botón ' + ${JSON.stringify(texto)}; b.click(); return 'ok'; })()`); await dormir(120); await quieta(); return r; };
const poner = (sel, valor) => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return 'NO ESTÁ ' + ${JSON.stringify(sel)}; e.value = ${JSON.stringify(String(valor))}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); return 'ok'; })()`);
const enviar = async (sel) => { const r = await js(`(() => { const f = document.querySelector(${JSON.stringify(sel)}); if (!f) return 'NO ESTÁ ' + ${JSON.stringify(sel)}; f.requestSubmit(); return 'ok'; })()`); await dormir(150); await quieta(); return r; };
const menu = (v) => clic(`.sidebar [data-nav="${v}"]`);
const aviso = () => js(`document.querySelector('#toast').textContent`);
const texto = (sel) => js(`(document.querySelector(${JSON.stringify(sel)})?.innerText ?? 'NO ESTÁ').replace(/\\s+/g, ' ').trim()`);
const hoja = () => texto('.overlay .sheet');
async function entrar(persona) { await poner('#le', persona.email); await poner('#lp', CLAVE_DE_PRUEBA); return enviar('form[data-form="login"]'); }
const salir = () => clic('[data-action="logout"]');
function diaHabil(dias) {
  const d = new Date(); d.setDate(d.getDate() + dias);
  if (d.getDay() === 0) d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())}`;
}
async function irAlDia(fecha) {
  for (let i = 0; i < 9 && !(await js(`!!document.querySelector('.day[data-date="${fecha}"]')`)); i++) await clic('[data-action="cal-week"][data-dir="1"]');
  return clic(`.day[data-date="${fecha}"]`);
}
/** Aprieta algo que saca de la página (hacia el «Mercado Pago» del servidor de prueba) y espera a estar ahí. */
async function salirHacia(sel, camino) {
  const r = await js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return 'NO ESTÁ ' + ${JSON.stringify(sel)}; e.click(); return 'ok'; })()`);
  const llego = await hasta(`location.pathname.startsWith(${JSON.stringify(camino)})`, 10000);
  return llego ? r : `${r} · no llegó a ${camino}`;
}
/** En la pantalla de «Mercado Pago»: toca una opción y espera a estar de vuelta en la página, ya cargada. */
async function enMp(accion) {
  const r = await js(`(() => { const e = document.querySelector('[data-accion="${accion}"]'); if (!e) return 'NO ESTÁ ${accion}'; e.click(); return 'ok'; })()`);
  const volvio = await hasta(`location.pathname === "/" && typeof fase !== "undefined" && fase === "lista"`, 12000);
  return volvio ? r : `${r} · no volvió`;
}
/** Espera a que la hoja abierta diga algo (la confirmación de un pago puede tardar unos segundos). */
const hojaDice = async (algo, ms = 30000) => { await hasta(`(document.querySelector('.overlay .sheet')?.innerText ?? '').includes(${JSON.stringify(algo)})`, ms); await quieta(); return hoja(); };
/** Reserva un turno entero como quien está adentro, hasta dejar abierta la hoja de pago. */
async function reservarHastaElPago(fecha, box, desde) {
  await menu('reservar'); await irAlDia(fecha);
  await clic(`button.seg-free[data-action="book"][data-box="${box}"][data-start="${desde}"]`);
  await boton('Continuar'); await boton('Continuar');
  await js(`document.querySelector('[data-draft="accepted"]').click(); 1`); await dormir(150);
  return boton('Ir a pagar');
}
const DIA = diaHabil(3);
const LEJOS = diaHabil(10);
const laBarra = () => js(`location.href`);

try {
  await cdp('Page.enable'); await cdp('Runtime.enable'); await cdp('Log.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: `${s.url}/` });
  await hasta(`typeof fase !== "undefined" && fase === "lista"`, 15000);
  await js(`document.fonts.ready.then(() => 1)`);

  console.log('--- la dueña conecta su cuenta de Mercado Pago ---');
  await entrar(DUENA);
  await menu('config');
  ver('la tarjeta, sin cuenta', await texto('#cfg-mp'), (v) => v.includes('La cuenta donde entra la plata de las reservas') && v.includes('Todavía no hay ninguna cuenta conectada') && v.includes('Conectar Mercado Pago') && !v.includes('modo prueba'));
  await js(`document.querySelector('#cfg-mp').scrollIntoView({ block: 'center' }); 1`);
  await foto('config-sin-cuenta');
  ver('sale a Mercado Pago', await salirHacia('[data-action="mp-conectar"]', '/__mp/autorizar'), 'ok');
  ver('lo que viaja en la dirección', await js(`Object.fromEntries(new URLSearchParams(location.search))`),
    (v) => v.response_type === 'code' && v.platform_id === 'mp' && v.code_challenge_method === 'S256' && /^[A-Za-z0-9_-]{43}$/.test(v.state) && v.redirect_uri === `${s.url}/functions/v1/mp` && !JSON.stringify(v).includes('secret'));
  ver('la dueña dice que no', await enMp('no-autorizar'), 'ok');
  await hasta(`document.querySelector('#toast').classList.contains('show')`);
  ver('vuelve sin cuenta y se lo dice', [await aviso(), await laBarra(), await texto('#cfg-mp')], (v) => v[0].includes('No se conectó ninguna cuenta') && v[1] === `${s.url}/` && v[2].includes('Todavía no hay ninguna cuenta conectada'));
  await salirHacia('[data-action="mp-conectar"]', '/__mp/autorizar');
  ver('autoriza', await enMp('autorizar'), 'ok');
  ver('vuelve y le pregunta si es su cuenta', await hojaDice('¿Es tu cuenta de Mercado Pago?'), (v) => v.includes('La plata de las reservas va a entrar acá') && v.includes('Laura Lavanda') && v.includes('cobros@lavanda.prueba') && v.includes('111222333'));
  ver('la barra quedó limpia', await laBarra(), (v) => v === `${s.url}/`);
  ver('todavía no se puede cobrar', await js(`S.site.mp`), (v) => v.env === 'real' && v.ready === false);
  await foto('confirmar-la-cuenta');
  await boton('Sí, es mi cuenta');
  ver('confirmada', [await aviso(), await texto('#cfg-mp'), await js(`S.site.mp.ready`)], (v) => v[0] === 'Cuenta confirmada. Ya se puede cobrar con Mercado Pago.' && v[1].includes('Laura Lavanda') && v[1].includes('Conectada') && v[1].includes('Desconectar') && v[2] === true);
  ver('los pases no llegan a la página', await js(`JSON.stringify(S).includes('APP_USR') || JSON.stringify(S).includes('TG-')`), (v) => v === false);
  await js(`document.querySelector('#cfg-mp').scrollIntoView({ block: 'center' }); 1`);
  await foto('config-conectada');
  // el nombre y el mail de la cuenta vienen de Mercado Pago: si trajeran código, la página los muestra como texto y nada más
  await s.pg.query(`update interno.mp_cuentas set nombre = $1, email = $2`, ['<img src=x onerror="window.__trampa=1">', '"><script>window.__trampa=2</script>@x.com']);
  await js(`refrescar().then(() => 1)`);
  ver('datos de la cuenta con trampa', await js(`({ texto: document.querySelector('#cfg-mp').innerText, corrio: window.__trampa ?? null, imagenes: document.querySelectorAll('#cfg-mp img, #cfg-mp script').length })`),
    (v) => v.texto.includes('<img src=x onerror="window.__trampa=1">') && v.texto.includes('<script>window.__trampa=2</script>@x.com') && v.corrio === null && v.imagenes === 0);
  await s.pg.query(`update interno.mp_cuentas set nombre = 'Laura Lavanda', email = 'cobros@lavanda.prueba'`);
  await js(`refrescar().then(() => 1)`);
  await salir();

  console.log('--- una profesional reserva y paga ---');
  await entrar(LUCIA);
  await menu('reservar'); await irAlDia(DIA);
  await clic('button.seg-free[data-action="book"][data-box="2"][data-start="8"]');
  await boton('Continuar');
  ver('paso de pago', await texto('.overlay .sheet-b'), (v) => v.includes('Mercado Pago: tarjeta o dinero en cuenta') && !v.includes('Modo de prueba') && !v.includes('modo prueba'));
  await boton('Continuar'); await js(`document.querySelector('[data-draft="accepted"]').click(); 1`); await dormir(150);
  await boton('Ir a pagar');
  ver('hoja de pago', await hoja(), (v) => v.includes('Pagar con Mercado Pago') && v.includes('Seña') && v.includes('$ 20.000') && v.includes('Te llevamos a Mercado Pago') && v.includes('Quedan') && v.includes('Ir a pagar $ 20.000') && !v.includes('prueba'));
  await foto('hoja-de-pago');
  ver('sale a pagar', await salirHacia('[data-action="mp-ir"]', '/__mp/pagar'), 'ok');
  ver('lo que ve en Mercado Pago', await texto('body'), (v) => v.includes('Pagar $ 20.000') && v.includes('Seña · Box 2'));
  ver('paga', await enMp('pagar'), 'ok');
  ver('vuelve confirmada', await hojaDice('¡Reserva confirmada!'), (v) => v.includes('Pago aprobado') && v.includes('Confirmada') && v.includes('Box 2'));
  ver('la barra quedó limpia', await laBarra(), (v) => v === `${s.url}/`);
  await foto('reserva-confirmada');
  await boton('Ver mis reservas');
  ver('mis reservas', await texto('main'), (v) => v.includes('Pagaste $ 20.000 de seña · saldo $ 20.000'));
  ver('la plata fue a la cuenta del consultorio', [...s.mp.ordenes.values()].map((o) => [o.user_id, o.status, o.total_amount]), (v) => v.length === 1 && v[0].join() === '111222333,processed,20000.00');

  console.log('--- paga el saldo y el aviso de Mercado Pago no llega ---');
  await clic('[data-action="pay-balance"]');
  ver('hoja del saldo', await hoja(), (v) => v.includes('Saldo') && v.includes('Ir a pagar $ 20.000'));
  await salirHacia('[data-action="mp-ir"]', '/__mp/pagar');
  await enMp('pagar-sin-aviso');
  ver('la página lo confirma igual', await hojaDice('¡Listo! Pagaste el saldo'), 'Tu turno está pago completo.');
  await boton('Ver mis reservas');
  ver('paga completa', await texto('main'), 'Pagaste el total: $ 40.000');

  console.log('--- le rechazan la tarjeta, vuelve sin pagar y reintenta ---');
  await reservarHastaElPago(DIA, 3, 8);                          // box 3: $ 48.000, seña $ 24.000
  await salirHacia('[data-action="mp-ir"]', '/__mp/pagar');
  // se arrepiente y vuelve con «Atrás» del navegador: la página no puede quedar con los botones apagados
  await js(`history.back(); 1`);
  await hasta(`location.pathname === "/" && typeof fase !== "undefined" && fase === "lista"`, 12000);
  await dormir(400); await quieta();
  ver('volver con «Atrás» no deja la página trabada', await js(`({ trabada: document.body.classList.contains('is-busy'), ocupada })`), (v) => v.trabada === false && v.ocupada === false);
  await js(`closeSheet(true); 1`);
  await menu('mis'); await clic('[data-action="tab"][data-v="proximas"]');
  ver('y puede retomar el pago', await clic('[data-action="pay-now"]'), 'ok');
  await salirHacia('[data-action="mp-ir"]', '/__mp/pagar');
  await enMp('rechazar');
  ver('tarjeta rechazada', await hojaDice('El pago no se hizo'), (v) => v.includes('Mercado Pago rechazó el pago') && v.includes('Intentar de nuevo'));
  await foto('pago-rechazado');
  await boton('Intentar de nuevo');
  ver('se abre otra vez la hoja de pago', await hoja(), 'Ir a pagar $ 24.000');
  await salirHacia('[data-action="mp-ir"]', '/__mp/pagar');
  await enMp('volver');
  ver('volvió sin pagar', await hojaDice('El pago no se hizo'), (v) => v.includes('No se cobró nada') && v.includes('Intentar de nuevo'));
  await boton('Intentar de nuevo');
  await salirHacia('[data-action="mp-ir"]', '/__mp/pagar');
  ver('es el mismo cobro, no uno nuevo', [...s.mp.ordenes.values()].filter((o) => o.total_amount === '24000.00').map((o) => o.status), (v) => v.join() === 'failed,created');
  await enMp('pagar');
  ver('al tercer intento, confirmada', await hojaDice('¡Reserva confirmada!'), 'Box 3');
  await boton('Seguir mirando');
  ver('nada cobrado de más', await js(`S.bookings.filter(b => b.userId).map(b => [b.total, b.payments.filter(p => p.status === "aprobado").reduce((a, p) => a + p.amount, 0), (b.surplus || []).length]).sort((x, y) => x[0] - y[0])`), (v) => JSON.stringify(v) === '[[40000,40000,0],[48000,24000,0]]');

  console.log('--- cancela y la devolución sale sola ---');
  await reservarHastaElPago(LEJOS, 1, 8);
  await salirHacia('[data-action="mp-ir"]', '/__mp/pagar');
  await enMp('pagar');
  await hojaDice('¡Reserva confirmada!'); await boton('Ver mis reservas');
  const lejana = await js(`S.bookings.find(b => b.date === ${JSON.stringify(LEJOS)}).id`);
  await clic(`[data-action="cancel"][data-id="${lejana}"]`);
  ver('cancelar: muestra la devolución', await hoja(), (v) => v.includes('¿Cancelar tu reserva?') && v.includes('Te devolvemos') && v.includes('$ 20.000'));
  await boton('Sí, cancelar');
  ver('cancelada', await aviso(), 'Reserva cancelada. Devolución: $ 20.000.');
  await hasta(`S.bookings.find(b => b.id === ${JSON.stringify(lejana)}).refund.done === true`, 8000);
  ver('la devolución salió', [await js(`S.bookings.find(b => b.id === ${JSON.stringify(lejana)}).refund`), [...s.mp.ordenes.values()].filter((o) => o.status === 'refunded').map((o) => o.transactions.refunds.map((x) => x.amount).join())],
    (v) => v[0].done === true && v[0].amount === 20000 && v[1].join() === '20000.00');
  await clic('[data-action="tab"][data-v="historial"]');
  ver('en el historial', await texto('main'), (v) => v.includes('Devolución $ 20.000 (100 %)') && !v.includes('en camino'));

  console.log('--- la cuenta de la dueña se queda sin saldo ---');
  s.mp.cuenta('111222333').sinSaldo = true;
  await reservarHastaElPago(LEJOS, 2, 8);
  await salirHacia('[data-action="mp-ir"]', '/__mp/pagar');
  await enMp('pagar');
  await hojaDice('¡Reserva confirmada!'); await boton('Ver mis reservas');
  const otra = await js(`S.bookings.find(b => b.date === ${JSON.stringify(LEJOS)} && b.status === "confirmada").id`);
  await clic(`[data-action="cancel"][data-id="${otra}"]`); await boton('Sí, cancelar');
  await hasta(`!!S.bookings.find(b => b.id === ${JSON.stringify(otra)}).payments.find(p => p.kind === "devolucion" && p.note)`, 8000);
  await clic('[data-action="tab"][data-v="historial"]');
  ver('la profesional la ve en camino', await texto('main'), 'Devolución $ 20.000 (100 %) · en camino');
  await salir();
  await entrar(DUENA);
  await menu('pagos');
  ver('la dueña ve la devolución esperando', await texto('#devoluciones-esperan'), (v) => v.includes('Devoluciones que están saliendo') && v.includes('Lucía Ferrari · $ 20.000') && v.includes('Devolución por cancelación') && v.includes('no salió: la cuenta de Mercado Pago no tiene saldo disponible') && v.includes('Ya la devolví yo') && !v.includes('insufficient'));
  ver('y le llegó el aviso por mail', (await s.pg.query(`select asunto from public.avisos where asunto like 'Una devolución no pudo salir%'`)).rows.length, (v) => v === 1);
  await foto('devolucion-esperando');
  // todavía sin saldo: se lo dice
  await s.pg.query(`update public.pagos set actualizado_en = now() - interval '11 minutes' where tipo = 'devolucion' and estado = 'pendiente'`);
  await boton('Intentar ahora');
  ver('sigue sin poder salir', await aviso(), 'Alguna devolución todavía no pudo salir');
  // con saldo, sale
  s.mp.cuenta('111222333').sinSaldo = false;
  await s.pg.query(`update public.pagos set actualizado_en = now() - interval '11 minutes' where tipo = 'devolucion' and estado = 'pendiente'`);
  await boton('Intentar ahora');
  ver('con saldo, sale', [await aviso(), await js(`!!document.querySelector('#devoluciones-esperan')`)], (v) => v[0] === 'Listo: las devoluciones salieron.' && v[1] === false);
  ver('en la lista de pagos', await texto('main'), (v) => v.includes('− $ 20.000') && v.includes('Los cobros y las devoluciones pasan por Mercado Pago'));

  console.log('--- la dueña marca una devolución como hecha por su cuenta ---');
  s.mp.cuenta('111222333').sinSaldo = true;
  await menu('reservas');
  const deBox3 = await js(`S.bookings.find(b => b.total === 48000 && b.status === "confirmada").id`);
  await js(`openAdminBooking(findB(${JSON.stringify(deBox3)})); 1`); await dormir(150);
  await boton('Cancelar reserva'); await boton('Sí, cancelar');
  await hasta(`!!S.bookings.find(b => b.id === ${JSON.stringify(deBox3)}).payments.find(p => p.kind === "devolucion" && p.note)`, 8000);
  await menu('pagos');
  ver('espera otra devolución', await texto('#devoluciones-esperan'), 'Lucía Ferrari · $ 24.000');
  // con una devolución esperando no se puede sacar la cuenta: quedaría sin poder salir
  await menu('config');
  await clic('[data-action="mp-quitar"]'); await boton('Quitar la cuenta');
  ver('no deja quitar la cuenta con algo pendiente', [await aviso(), await texto('#cfg-mp')], (v) => v[0].includes('todavía hay cobros abiertos o devoluciones saliendo') && v[1].includes('Conectada'));
  await menu('pagos');
  await clic('[data-action="mp-a-mano"]');
  ver('antes de anotarla, pregunta', await hoja(), (v) => v.includes('¿Ya hiciste vos esta devolución?') && v.includes('Lucía Ferrari') && v.includes('$ 24.000') && v.includes('fijate en tu Mercado Pago que no haya salido sola'));
  await foto('devolucion-a-mano');
  await boton('Sí, ya la devolví');
  ver('marcada como hecha', [await aviso(), await js(`!!document.querySelector('#devoluciones-esperan')`), [...s.mp.ordenes.values()].filter((o) => o.total_amount === '24000.00' && o.status === 'processed').length],
    (v) => v[0] === 'Listo: quedó anotada como devuelta.' && v[1] === false && v[2] === 1);
  s.mp.cuenta('111222333').sinSaldo = false;

  console.log('--- sin cuenta conectada no se puede pagar ---');
  await menu('config');
  await clic('[data-action="mp-quitar"]');
  ver('avisa qué pasa si la quita', await hoja(), (v) => v.includes('¿Quitar la cuenta de Mercado Pago?') && v.includes('no se van a poder cobrar reservas ni hacer devoluciones'));
  await boton('Quitar la cuenta');
  ver('desconectada', [await aviso(), await texto('#cfg-mp')], (v) => v[0] === 'La cuenta de Mercado Pago quedó desconectada.' && v[1].includes('Todavía no hay ninguna cuenta conectada'));
  await salir();
  await entrar(CARO);
  await reservarHastaElPago(DIA, 1, 8);
  ver('no se puede pagar', await hoja(), (v) => v.includes('Por ahora el consultorio no puede cobrar con Mercado Pago') && v.includes('Avisale a Laura') && !v.includes('Ir a pagar $'));
  await clic('.overlay [data-action="close-sheet"]');

  console.log('--- modo prueba ---');
  await s.pg.query(`update public.consultorios set mp_ambiente = 'prueba' where slug = 'lavanda'`);
  await js(`refrescar().then(() => 1)`);
  await menu('mis'); await clic('[data-action="tab"][data-v="proximas"]');      // (la pestaña elegida se recuerda de la cuenta anterior)
  ver('abre el pago desde Mis reservas', await clic('[data-action="pay-now"]'), 'ok');
  ver('hoja de pago en modo prueba', await hoja(), (v) => v.includes('Modo prueba: no se cobra plata de verdad') && v.includes('usá una tarjeta de prueba') && v.includes('Ir a pagar $ 12.000'));
  ver('dice con qué mail pagar en la prueba', await hoja(), (v) => v.includes('test@testuser.com') && v.includes('sin entrar a tu cuenta de Mercado Pago'));
  await foto('hoja-de-pago-modo-prueba');
  await salirHacia('[data-action="mp-ir"]', '/__mp/pagar');
  await enMp('pagar');
  ver('confirmada con el pase de prueba', [await hojaDice('¡Reserva confirmada!'), [...s.mp.ordenes.values()].at(-1).user_id], (v) => v[0].includes('Box 1') && v[1] === '900900900');
  await boton('Seguir mirando');
  await salir();
  await entrar(DUENA);
  await menu('config');
  ver('la dueña ve el modo prueba', await texto('#cfg-mp'), (v) => v.includes('Mercado Pago está en modo prueba') && v.includes('no se mueve plata de verdad'));

  console.log('--- celular y modo oscuro ---');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await dormir(300);
  const sinDesborde = () => js(`document.documentElement.scrollWidth <= window.innerWidth + 1`);
  await js(`document.querySelector('#cfg-mp').scrollIntoView({ block: 'start' }); 1`);
  ver('configuración en celular: sin desborde', await sinDesborde(), true);
  await foto('celular-config');
  await js(`go('pagos'); 1`); await dormir(200);
  ver('pagos en celular: sin desborde', await sinDesborde(), true);
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await dormir(200);
  await foto('celular-pagos-oscuro');
  await cdp('Emulation.setEmulatedMedia', { features: [] });

  console.log('--- errores ---');
  const propios = errores.filter((e) => !/Failed to load resource.*(400|401|403)/.test(e));      // los rechazos esperados no cuentan
  ver('errores de la página', propios, (v) => v.length === 0);
} catch (e) {
  fallas++;
  console.log('  [FALLA] la prueba se cortó:', e);
} finally {
  ws.close(); nav.kill(); await s.cerrar();
}
console.log(fallas ? `\n${fallas} DE ${hechas} COMPROBACIONES FALLARON` : `\nLAS ${hechas} COMPROBACIONES PASARON`);
console.log('Capturas:', CAPTURAS);
process.exit(fallas ? 1 : 0);
