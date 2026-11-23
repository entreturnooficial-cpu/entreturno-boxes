// Prueba de la página entera (web\index.html) en un Edge sin ventana, contra el servidor de prueba.
//   node pruebas/pantallas.mjs          (npm run test:pantallas)
// Hace lo que haría una persona: pide acceso, la dueña la aprueba, bloquea y publica un rato libre, cambia ajustes;
// una profesional reserva con una máquina, paga, llega al tope de saldos, paga un saldo y cancela; otra ve «ocupado».
// También mira el tamaño de celular, el modo oscuro, que la sesión siga al recargar y que no haya errores.
// Y los mails de registro: confirmar la cuenta desde el enlace, mandarlo de nuevo y «olvidé mi contraseña».
// No toca internet ni datos reales. Las capturas quedan en E:\Entreturno boxes\pruebas\pantallas <fecha y hora>.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { CLAVE_DE_PRUEBA, DUENA, PROFESIONALES } from './datos-de-ejemplo.mjs';
import { CLAVE_PUBLICA, crearServidor } from './servidor-local.mjs';

const [LUCIA, CARO] = PROFESIONALES;
const dos = (n) => String(n).padStart(2, '0');
const AHORA = new Date();
const CAPTURAS = `E:/Entreturno boxes/pruebas/pantallas ${AHORA.getFullYear()}-${dos(AHORA.getMonth() + 1)}-${dos(AHORA.getDate())} ${dos(AHORA.getHours())}${dos(AHORA.getMinutes())}${dos(AHORA.getSeconds())}`;
mkdirSync(CAPTURAS, { recursive: true });
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PUERTO = +(process.env.PUERTO || 9471);
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

const s = await crearServidor();
const nav = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--remote-debugging-port=${PUERTO}`,
  `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'edge-boxes-'))}`, '--window-size=1366,768', 'about:blank'], { stdio: 'ignore' });
let info;
for (let i = 0; i < 80 && !info; i++) { try { info = (await (await fetch(`http://127.0.0.1:${PUERTO}/json`)).json()).find((t) => t.type === 'page'); } catch {} if (!info) await dormir(250); }
const ws = new WebSocket(info.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
let id = 0; const pend = new Map(); const errores = [];
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); }
  if (d.method === 'Runtime.exceptionThrown') errores.push((d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text).slice(0, 300));
  if (d.method === 'Log.entryAdded' && d.params.entry.level === 'error') errores.push(`${d.params.entry.text.slice(0, 160)} ${d.params.entry.url ?? ''}`); };
const cdp = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const js = async (expr) => { const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return r.result?.result?.value ?? ('ERROR: ' + (r.result?.exceptionDetails?.exception?.description || JSON.stringify(r.result))); };

let fallas = 0, hechas = 0, numero = 0;
function ver(nombre, valor, espera) {
  const texto = typeof valor === 'string' ? valor : JSON.stringify(valor);
  const ok = typeof espera === 'function' ? !!espera(valor) : texto.includes(espera);
  hechas++; if (!ok) fallas++;
  console.log(`  ${ok ? '[OK]   ' : '[FALLA]'} ${nombre.padEnd(34)} ${texto.replace(/\s+/g, ' ').slice(0, 250)}`);
}
const foto = async (nombre) => { const r = await cdp('Page.captureScreenshot', { format: 'png' }); writeFileSync(`${CAPTURAS}/${dos(++numero)}-${nombre}.png`, Buffer.from(r.result.data, 'base64')); };
/** Espera hasta que la expresión dé verdadero (o 6 segundos). */
async function hasta(expr, ms = 6000) { for (let t = 0; t < ms; t += 100) { if (await js(`!!(${expr})`) === true) return true; await dormir(100); } return false; }
const quieta = () => hasta(`fase === "lista" && !ocupada`);
const clic = async (sel) => { const r = await js(`(() => { const e = [...document.querySelectorAll(${JSON.stringify(sel)})].filter(x => x.offsetParent !== null || x.closest('.overlay'))[0]; if (!e) return 'NO ESTÁ ' + ${JSON.stringify(sel)}; e.click(); return 'ok'; })()`); await dormir(120); await quieta(); return r; };
const boton = async (texto) => { const r = await js(`(() => { const b = [...document.querySelectorAll('.overlay button, main button, .auth button')].filter(e => (e.offsetParent !== null || e.closest('.overlay')) && e.textContent.trim().startsWith(${JSON.stringify(texto)})).pop(); if (!b) return 'NO ESTÁ el botón ' + ${JSON.stringify(texto)}; b.click(); return 'ok'; })()`); await dormir(120); await quieta(); return r; };
const poner = (sel, valor) => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return 'NO ESTÁ ' + ${JSON.stringify(sel)}; if (e.type === 'radio' || e.type === 'checkbox') { e.checked = true; } else e.value = ${JSON.stringify(String(valor))}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); return 'ok'; })()`);
const enviar = async (sel) => { const r = await js(`(() => { const f = document.querySelector(${JSON.stringify(sel)}); if (!f) return 'NO ESTÁ ' + ${JSON.stringify(sel)}; f.requestSubmit(); return 'ok'; })()`); await dormir(150); await quieta(); return r; };
const menu = (v) => clic(`.sidebar [data-nav="${v}"]`);
const aviso = () => js(`document.querySelector('#toast').textContent`);
const texto = (sel) => js(`(document.querySelector(${JSON.stringify(sel)})?.innerText ?? 'NO ESTÁ').replace(/\\s+/g, ' ').trim()`);
async function entrar(persona, clave = CLAVE_DE_PRUEBA) {
  await poner('#le', persona.email); await poner('#lp', clave);
  return enviar('form[data-form="login"]');
}
const salir = () => clic('[data-action="logout"]');
/** El primer día de lunes a sábado, a `dias` días de hoy o después. */
function diaHabil(dias) {
  const d = new Date(); d.setDate(d.getDate() + dias);
  if (d.getDay() === 0) d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())}`;
}
/** Lleva el calendario a ese día (pasando de semana si hace falta). */
async function irAlDia(fecha) {
  for (let i = 0; i < 9 && !(await js(`!!document.querySelector('.day[data-date="${fecha}"]')`)); i++) await clic('[data-action="cal-week"][data-dir="1"]');
  return clic(`.day[data-date="${fecha}"]`);
}
const DIA = diaHabil(3);

try {
  await cdp('Page.enable'); await cdp('Runtime.enable'); await cdp('Log.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: `${s.url}/` });
  await hasta(`typeof fase !== "undefined" && fase === "lista"`, 15000);
  await js(`document.fonts.ready.then(() => 1)`);

  console.log('--- antes de entrar ---');
  ver('ingreso', await js(`({ pestaña: document.title, marca: document.querySelector('.auth .brand-name')?.textContent, letras: [...document.querySelectorAll('.auth .mono text')].map(t => t.textContent).join('|'), barraDemo: !!document.querySelector('.demobar'), cuentasDeMuestra: document.querySelectorAll('.demo-user').length })`),
    (v) => v.pestaña === 'Consultorio Lavanda · Alquiler de boxes' && v.marca === 'Consultorio Lavanda' && v.letras === 'C|L' && !v.barraDemo && v.cuentasDeMuestra === 0);
  ver('texto del ingreso', await texto('.auth-side'), (v) => v.includes('3 boxes equipados, turnos de 4 h') && v.includes('Pagás seña del 50 % o el total') && v.includes('aprobados por Laura'));
  await foto('ingreso');
  ver('clave equivocada', (await entrar(LUCIA, 'otra-clave'), await aviso()), 'El mail o la contraseña no coinciden.');
  await clic('[data-action="auth-tab"][data-tab="register"]');
  ver('pedir acceso: categorías', await js(`[...document.querySelectorAll('form[data-form="register"] input[name="category"]')].map(i => i.closest('label').innerText.replace(/\\s+/g, ' ').trim()).join(' / ')`),
    (v) => v.includes('Médicas y médicos') && v.includes('$ 10.000 la hora') && v.includes('$ 6.000 la hora'));
  await poner('#rn', 'Ana Paz'); await poner('#rp', 'Kinesióloga'); await poner('form[data-form="register"] input[name="category"]:last-of-type', '');
  await js(`document.querySelectorAll('form[data-form="register"] input[name="category"]')[1].click(); 1`);
  await poner('#rm', 'ana@lavanda.prueba'); await poner('#rt', '11 5555-0199'); await poner('#rc', '27-22333444-5'); await poner('#ri', '6'); await poner('#rw', 'una-clave-de-prueba');
  await enviar('form[data-form="register"]');
  ver('solicitud enviada', await texto('main'), (v) => v.includes('Tu solicitud está en revisión') && v.includes('Laura te va a contactar') && v.includes('Entrevista con Laura'));
  ver('menú de la pendiente', await js(`[...document.querySelectorAll('.sidebar .nav a')].map(a => a.textContent.trim()).join(', ')`), (v) => v === 'Mi solicitud, Los boxes, Máquinas');
  await foto('solicitud-en-revision');
  await menu('boxes');
  ver('los boxes (pendiente)', await texto('main'), (v) => v.includes('Box 3') && v.includes('$ 8.000 la hora') && !v.includes('Ilustración'));
  await salir();

  console.log('--- la dueña ---');
  await entrar(DUENA);
  ver('panel', await texto('main'), (v) => v.includes('Hoy en el consultorio') && v.includes('2 profesionales pidieron acceso') && v.includes('Ana Paz') && v.includes('Martina Sosa'));
  ver('menú de la dueña', await js(`[...document.querySelectorAll('.sidebar .nav a span:first-of-type')].map(a => a.textContent.trim()).join(', ')`), (v) => v === 'Inicio, Agenda, Reservas, Pagos, Facturación, Profesionales, Configuración');
  await foto('panel');
  await js(`[...document.querySelectorAll('main .li')].find(li => li.textContent.includes('Ana Paz')).querySelector('[data-s="aprobado"]').click(); 1`); await dormir(150); await quieta();
  ver('aprobar', await aviso(), 'Ana Paz ya puede reservar.');
  // Agenda: bloquea el box 1 de 8 a 16 y publica un rato libre adentro
  await menu('agenda');
  await clic('[data-action="adm-new-block"]');
  await js(`document.querySelectorAll('form[data-form="new-block"] input[name="boxes"]').forEach((c, i) => { c.checked = i === 0; }); 1`);
  await poner('#bd', DIA); await poner('#bs', 8); await poner('#be', 16);
  await enviar('form[data-form="new-block"]');
  ver('bloquear', await aviso(), 'Horario bloqueado.');
  ver('el bloqueo en la agenda', await js(`[...document.querySelectorAll('.seg-block')].map(e => e.innerText.replace(/\\s+/g, ' ').trim()).join(' / ')`), 'Atiendo yo 8 a 16 h');
  await clic('.seg-block.admin');
  await poner('#rs', 12); await poner('#re', 14);
  await enviar('form[data-form="release"]');
  ver('publicar un rato libre', await aviso(), 'Publicaste un rato libre de 2 h.');
  ver('el rato en la agenda', await js(`[...document.querySelectorAll('.seg-rel')].map(e => e.innerText.replace(/\\s+/g, ' ').trim()).join(' / ')`), '12 a 14 h');
  await foto('agenda-con-bloqueo-y-rato');
  for (const v of ['semana', 'mes', 'dias', 'dia']) await clic(`[data-action="ag-view"][data-v="${v}"]`);
  // Ajustes
  await menu('config');
  ver('ajustes sin rótulos de ejemplo', await texto('main'), (v) => v.includes('Lo que cambiás acá vale para las reservas nuevas') && !v.includes('Ejemplo, a definir') && v.includes('Turnos con saldo pendiente') && v.includes('ARCA: todavía sin conectar'));
  ver('tope de saldos por defecto', await js(`document.querySelector('#ms').selectedOptions[0].textContent`), 'Hasta 2');
  await poner('#ms', 1); await enviar('form[data-form="cfg-precio"]');
  ver('guardar seña y pago', [await aviso(), await js(`document.querySelector('#ms').selectedOptions[0].textContent + ' / ' + S.config.maxOpenBalances`)], (v) => v[0] === 'Seña y pago guardados.' && v[1] === 'Uno solo / 1');
  await poner('#ms', 2); await enviar('form[data-form="cfg-precio"]');
  await clic('[data-action="cat-edit"]'); await poner('#kp', 11000); await enviar('form[data-form="cat-save"]');
  ver('cambiar un precio', [await aviso(), await js(`S.config.categories[0].pricePerHour`)], (v) => v[0].includes('$ 11.000 la hora') && v[1] === 11000);
  await clic('[data-action="cat-edit"]'); await poner('#kp', 10000); await enviar('form[data-form="cat-save"]');
  await poner('textarea#tt', 'Dejá el box limpio.\nRespetá el horario.'); await enviar('form[data-form="cfg-terms"]');
  ver('reglamento', await aviso(), 'Reglamento guardado (versión 2).');
  await poner('#bn1', 'Box 1'); await poner('input[name^="price_1_"]', 11000); await enviar('form[data-form="cfg-boxes"]');
  ver('boxes', [await aviso(), await js(`Object.values(S.boxes[0].prices)`)], (v) => v[0] === 'Boxes guardados.' && v[1].length === 1 && v[1][0] === 11000);
  await foto('ajustes');
  await menu('profesionales'); await clic('[data-action="tab"][data-v="aprobadas"]');
  ver('profesionales aprobadas', await js(`[...document.querySelectorAll('main .li .t')].map(e => e.textContent.trim()).join(', ')`), (v) => v.includes('Lucía Ferrari') && v.includes('Carolina Méndez') && v.includes('Ana Paz'));
  ver('sin «Crear cuenta»', await texto('main .title-row'), (v) => v.includes('piden acceso desde ahí') && !v.includes('Crear cuenta'));
  ver('CUIT y condición en Profesionales', await texto('main'), (v) => v.includes('CUIT 27-28111222-3 · Monotributista'));
  await menu('facturacion');
  ver('facturación apagada', await texto('main'), (v) => v.includes('La facturación con ARCA todavía no está prendida') && !v.includes('de muestra') && !v.includes('Demostración'));
  ver('sin ARCA, el botón no se prende', await js(`document.querySelector('[data-action="inv-facturar"]').disabled`), true);
  await salir();

  console.log('--- una profesional ---');
  await entrar(LUCIA);
  ver('reservar', await texto('main .title-row'), (v) => v.includes('Reservar un box') && v.includes('$ 10.000 la hora') && v.includes('Box 3, $ 12.000 la hora'));
  await irAlDia(DIA);
  ver('ve el bloqueo sin la nota y el rato', await js(`({ bloqueado: [...document.querySelectorAll('.seg-block')].map(e => e.innerText.trim()).join('/'), rato: [...document.querySelectorAll('.seg-rel')].map(e => e.innerText.replace(/\\s+/g, ' ').trim()).join('/') })`),
    (v) => v.bloqueado.includes('No disponible') && !v.bloqueado.includes('Atiendo') && v.rato.includes('Rato libre 12 a 14 h $ 22.000'));
  await clic('button.seg-free[data-action="book"][data-box="3"][data-start="8"]');
  await js(`(() => { const i = [...document.querySelectorAll('[data-draft-machine]')].find(x => !x.disabled); i.click(); return 1; })()`); await dormir(200);
  ver('reserva con máquina', await texto('.overlay .summary'), (v) => v.includes('Box: 4 h a $ 12.000') && v.includes('Láser de depilación: 4 h a $ 16.000') && v.includes('$ 112.000'));
  await poner('#svc', 'Dermatología'); await boton('Continuar');
  ver('paso de pago', await texto('.overlay .sheet-b'), (v) => v.includes('Seña del 50 %') && v.includes('$ 56.000') && v.includes('Modo de prueba') && v.includes('no se cobra plata de verdad'));
  await foto('reserva-paso-pago');
  await boton('Continuar'); await js(`document.querySelector('[data-draft="accepted"]').click(); 1`); await dormir(150);
  await boton('Ir a pagar');
  ver('hoja de pago', await texto('.overlay .sheet'), (v) => v.includes('Modo de prueba') && v.includes('Seña') && v.includes('$ 56.000') && v.includes('Quedan'));
  await boton('Pagar $');
  ver('confirmada', await texto('.overlay .sheet'), (v) => v.includes('¡Reserva confirmada!') && v.includes('Pago aprobado') && v.includes('Confirmada'));
  await foto('reserva-confirmada');
  await boton('Ver mis reservas');
  ver('mis reservas', await texto('main'), (v) => v.includes('Box 3') && v.includes('Pagaste $ 56.000 de seña · saldo $ 56.000') && v.includes('Láser de depilación'));
  // Segundo turno señado: llega al tope de dos saldos pendientes
  await menu('reservar'); await irAlDia(DIA);
  await clic('button.seg-free[data-action="book"][data-box="2"][data-start="16"]');
  await boton('Continuar'); await boton('Continuar'); await js(`document.querySelector('[data-draft="accepted"]').click(); 1`); await dormir(150);
  await boton('Ir a pagar'); await boton('Pagar $'); await boton('Seguir mirando');
  await clic('button.seg-free[data-action="book"][data-box="3"][data-start="12"]');
  await boton('Continuar');
  ver('tope de saldos: va completo', await js(`({ texto: document.querySelector('.overlay .sheet-b').innerText.replace(/\\s+/g, ' '), señaApagada: document.querySelector('.overlay input[value="sena"]').disabled, total: document.querySelector('.overlay input[value="total"]').checked })`),
    (v) => v.señaApagada && v.total && v.texto.includes('Ya tenés 2 turnos con saldo pendiente: este va completo'));
  await foto('tope-de-saldos');
  await clic('.overlay [data-action="close-sheet"]');
  await menu('mis');
  await clic('[data-action="pay-balance"]'); await boton('Pagar $');
  ver('pagar el saldo', await texto('.overlay .sheet'), (v) => v.includes('¡Listo! Pagaste el saldo'));
  await boton('Ver mis reservas');
  ver('una paga completa', await texto('main'), (v) => v.includes('Pagaste el total: $ 112.000'));
  await clic('[data-action="cancel"]');
  ver('cancelar: muestra la devolución', await texto('.overlay .sheet'), (v) => v.includes('¿Cancelar tu reserva?') && v.includes('Con 7 días o más') && (v.includes('Te devolvemos') || v.includes('no corresponde')));
  await boton('Sí, cancelar');
  ver('cancelada', await aviso(), 'Reserva cancelada.');
  await foto('mis-reservas');

  console.log('--- plazos y saldos ---');
  const aceptarYPedirPago = async () => { await boton('Continuar'); await boton('Continuar'); await js(`document.querySelector('[data-draft="accepted"]').click(); 1`); await dormir(150); return boton('Ir a pagar'); };
  // Reserva sin pagar: cuando se le acaba el plazo, el servidor la libera y la página lo muestra
  await menu('reservar'); await irAlDia(DIA);
  await clic('button.seg-free[data-action="book"][data-box="2"][data-start="8"]');
  await aceptarYPedirPago(); await boton('Ahora no');
  ver('queda esperando el pago', await js(`S.bookings.filter(b => b.status === "pago").length + ' · ' + (document.querySelector('.sidebar [data-nav="mis"] .badge')?.textContent ?? '')`), '1 · 1');
  await s.pg.query(`update public.reservas set vence_en = now() - interval '1 minute' where estado = 'pago'`);
  await js(`refrescar().then(() => 1)`);
  await menu('mis'); await clic('[data-action="tab"][data-v="historial"]');
  ver('se liberó sola', await texto('main'), 'Se liberó porque no se registró el pago a tiempo.');
  // Saldo de un turno que ya pasó, con el tope en uno: no puede reservar hasta pagarlo
  await s.pg.query(`update public.consultorios set max_saldos = 1`);
  await s.pg.query(`update public.reservas set fecha = (now() at time zone 'America/Argentina/Buenos_Aires')::date - 1 where estado = 'confirmada'`);
  await js(`refrescar().then(() => 1)`);
  await clic('[data-action="tab"][data-v="proximas"]');
  ver('saldo de un turno que ya pasó', await texto('main'), (v) => v.includes('el saldo de un turno que ya pasó sin pagar') && v.includes('$ 20.000') && v.includes('Pagalo para volver a reservar') && v.includes('te falta el saldo'));
  ver('aviso en el menú', await js(`document.querySelector('.sidebar [data-nav="mis"] .badge')?.textContent ?? ''`), '1');
  await foto('saldo-vencido');
  await menu('reservar'); await irAlDia(DIA); await clic('button.seg-free[data-action="book"]');
  ver('no puede reservar hasta pagar', [await aviso(), await js(`S.ui.view + ' · ' + !!document.querySelector('.overlay')`)], (v) => v[0].includes('Tenés el saldo de un turno que ya pasó') && v[1] === 'mis · false');
  // La dueña ve quién debe y cuánto
  await salir(); await entrar(DUENA);
  ver('la dueña ve el saldo por cobrar', await texto('main .kpis'), 'Saldos por cobrar $ 20.000');
  await menu('profesionales'); await clic('[data-action="tab"][data-v="aprobadas"]');
  ver('la dueña ve quién debe', await js(`[...document.querySelectorAll('main .li')].find(li => li.textContent.includes('Lucía Ferrari')).innerText.replace(/\\s+/g, ' ')`), 'debe $ 20.000 de 1 turno (1 ya pasó)');
  await salir(); await entrar(LUCIA);
  // Paga el saldo y vuelve a poder reservar
  await menu('mis'); await clic('[data-action="pay-balance"]'); await boton('Pagar $');
  ver('paga el saldo del turno que ya pasó', await texto('.overlay .sheet'), '¡Listo! Pagaste el saldo');
  await boton('Seguir mirando');
  await menu('reservar'); await irAlDia(DIA);
  await clic('button.seg-free[data-action="book"][data-box="3"][data-start="16"]');
  ver('ya puede reservar de nuevo', await texto('.overlay .sheet-h'), 'Reservar Box 3');
  await poner('#svc', 'Dermatología'); await boton('Continuar'); await js(`document.querySelector('.overlay input[value="total"]').click(); 1`); await dormir(150);
  await boton('Continuar'); await js(`document.querySelector('[data-draft="accepted"]').click(); 1`); await dormir(150);
  await boton('Ir a pagar'); await boton('Pagar $'); await boton('Seguir mirando');
  await s.pg.query(`update public.consultorios set max_saldos = 2`);
  // La sesión sigue al recargar la página
  await cdp('Page.reload'); await hasta(`typeof fase !== "undefined" && fase === "lista"`, 15000);
  ver('sigue adentro al recargar', await js(`document.querySelector('.side-foot .who b')?.textContent`), 'Lucía Ferrari');
  await salir();

  console.log('--- una cuenta que todavía no pidió acceso ---');
  await fetch(`${s.url}/auth/v1/signup`, { method: 'POST', headers: { apikey: CLAVE_PUBLICA, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'bea@lavanda.prueba', password: 'otra-clave-de-prueba' }) });
  await entrar({ email: 'bea@lavanda.prueba' }, 'otra-clave-de-prueba');
  ver('le pide los datos', await texto('.auth-card'), (v) => v.includes('Pedí acceso') && v.includes('Entraste como bea@lavanda.prueba') && v.includes('Salir de esta cuenta'));
  await foto('cuenta-sin-pedido');
  await poner('#rn', 'Bea Luna'); await poner('#rp', 'Podóloga'); await js(`document.querySelectorAll('form[data-form="pedido"] input[name="category"]')[1].click(); 1`);
  await poner('#rc', '27-22333444-5'); await poner('#ri', '4');
  await enviar('form[data-form="pedido"]');
  ver('se guardó su CUIT y su condición', (await s.pg.query(`select cuit, condicion_iva from public.miembros where email = 'bea@lavanda.prueba'`)).rows[0], (v) => v.cuit === '27-22333444-5' && v.condicion_iva === 4);
  ver('queda pendiente', await texto('main'), 'Tu solicitud está en revisión');
  await salir();
  ver('al salir vuelve el ingreso', await js(`!!document.querySelector('form[data-form="login"]') && !document.querySelector('#toast').classList.contains('show')`), (v) => v === true);

  console.log('--- otra profesional ---');
  await entrar(CARO);
  await irAlDia(DIA);
  ver('ve «ocupado», sin datos ajenos', await js(`({ ocupados: document.querySelectorAll('.seg-busy').length, pagina: document.body.innerText.includes('Lucía') || document.body.innerText.includes('Dermatología'), datos: JSON.stringify(S.bookings).includes('Dermatología') })`),
    (v) => v.ocupados >= 1 && !v.pagina && !v.datos);
  ver('su precio', await texto('main .title-row .sub'), '$ 6.000 la hora');
  // Lo que hace otra persona aparece al refrescar, sin recargar la página
  const antes = await js(`document.querySelectorAll('.seg-busy').length`);
  const lucia = (await s.pg.query(`select id, usuario_id from public.miembros where nombre = 'Lucía Ferrari'`)).rows[0];
  await s.pg.query(`update public.consultorios set max_saldos = null`);
  await js(`refrescar().then(() => 1)`);
  ver('refresco sin recargar', await js(`S.config.maxOpenBalances === null && document.querySelectorAll('.seg-busy').length === ${antes}`), (v) => v === true && !!lucia);

  console.log('--- celular y modo oscuro ---');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await dormir(300);
  const sinDesborde = () => js(`document.documentElement.scrollWidth <= window.innerWidth + 1`);
  ver('celular: reservar', await sinDesborde(), (v) => v === true); await foto('celular-reservar');
  await clic('.bottomnav [data-nav="mis"]'); ver('celular: mis reservas', await sinDesborde(), (v) => v === true);
  await clic('.bottomnav [data-nav="maquinas"]'); ver('celular: máquinas', [await sinDesborde(), await texto('main')], (v) => v[0] === true && v[1].includes('Láser de depilación') && !v[1].includes('Ultrasonido'));
  await clic('.topbar [data-action="toggle-theme"]'); await dormir(900);          // el cambio de modo es un fundido: se espera a que termine
  const claridad = (sel, prop) => js(`(() => { const m = getComputedStyle(document.querySelector('${sel}'))['${prop}'].match(/[\\d.]+/g).map(Number); return Math.round(0.299 * m[0] + 0.587 * m[1] + 0.114 * m[2]); })()`);
  ver('modo oscuro', [await js(`document.documentElement.dataset.theme`), await claridad('body', 'backgroundColor'), await claridad('main h1', 'color')], (v) => v[0] === 'dark' && v[1] < 60 && v[2] > 180);
  await foto('celular-oscuro');
  await clic('.topbar [data-action="toggle-theme"]'); await dormir(900);
  await clic('.topbar [data-action="logout"]');
  ver('celular: ingreso', [await sinDesborde(), await js(`!!document.querySelector('form[data-form="login"]')`)], (v) => v[0] === true && v[1] === true); await foto('celular-ingreso');
  await entrar(DUENA);
  ver('celular: panel de la dueña', [await sinDesborde(), await js(`[...document.querySelectorAll('.bottomnav a span:first-of-type')].map(a => a.textContent).join(', ')`)], (v) => v[0] === true && v[1] === 'Inicio, Agenda, Reservas, Pagos, Más'); await foto('celular-panel');
  await clic('.bottomnav [data-nav="pagos"]');
  ver('celular: pagos', [await sinDesborde(), await texto('main')], (v) => v[0] === true && v[1].includes('Modo de prueba') && v[1].includes('Lucía Ferrari') && v[1].includes('Devolución'));
  await clic('.bottomnav [data-nav="reservas"]'); ver('celular: reservas', await sinDesborde(), (v) => v === true);

  console.log('--- textos con trampa ---');
  // Alguien pide acceso con un nombre que intenta meter código, y un box queda con un nombre con símbolos:
  // la página los tiene que mostrar como texto y nada más.
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false });
  const TRAMPA = '<img src=x onerror=window.__trampa=1> <script>window.__trampa=2</' + 'script>';
  const cuenta = await (await fetch(`${s.url}/auth/v1/signup`, { method: 'POST', headers: { apikey: CLAVE_PUBLICA, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'trampa@lavanda.prueba', password: 'otra-clave-de-prueba' }) })).json();
  const categoria = (await s.pg.query(`select id from public.categorias order by orden limit 1`)).rows[0].id;
  const pedido = await fetch(`${s.url}/rest/v1/rpc/pedir_acceso`, { method: 'POST', headers: { apikey: CLAVE_PUBLICA, Authorization: `Bearer ${cuenta.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_slug: 'lavanda', p_nombre: TRAMPA, p_profesion: '"><b onclick=alert(1)>x</b>', p_categoria: categoria, p_telefono: '<i>11</i>', p_cuit: '' }) });
  await js(`servidor.rpc("guardar_box", { p_numero: 2, p_nombre: 'Box "2" <b>azul</b>', p_resumen: "<u>amplio</u>", p_equipamiento: ["<s>Camilla</s>"], p_precios: {} }).then(() => refrescar()).then(() => 1)`);
  await clic('.sidebar [data-nav="inicio"]');
  const limpio = `({ ejecuto: window.__trampa ?? null, colados: document.querySelectorAll('main img[src="x"], main script, main b[onclick], main u, main s').length })`;
  ver('pedido con trampa: se ve como texto', [pedido.status, await js(limpio), await texto('main')], (v) => v[0] === 200 && v[1].ejecuto === null && v[1].colados === 0 && v[2].includes('<img src=x onerror=window.__trampa=1>') && v[2].includes('<i>11</i>'));
  await menu('profesionales'); await clic('[data-action="tab"][data-v="solicitudes"]');
  ver('en profesionales, igual', [await js(limpio), await texto('main')], (v) => v[0].ejecuto === null && v[0].colados === 0 && v[1].includes('<b onclick=alert(1)>x</b>'));
  await menu('agenda');
  ver('box con símbolos en la agenda', [await js(limpio), await texto('main .cal')], (v) => v[0].ejecuto === null && v[0].colados === 0 && v[1].includes('Box "2" <b>azul</b>'));
  await menu('config');
  ver('y en los ajustes', [await js(limpio), await js(`document.querySelector('#bn2').value`)], (v) => v[0].ejecuto === null && v[0].colados === 0 && v[1] === 'Box "2" <b>azul</b>');
  await salir(); await entrar(CARO); await irAlDia(DIA);
  ver('la profesional lo ve como texto', [await js(limpio), await js(`document.querySelector('button.seg-free[data-box="2"]')?.getAttribute('aria-label') ?? 'sin turno libre en el box 2'`)], (v) => v[0].ejecuto === null && v[0].colados === 0 && v[1].startsWith('Reservar Box "2" <b>azul</b>, '));
  await menu('boxes');
  ver('y en «Los boxes»', [await js(limpio), await texto('main')], (v) => v[0].ejecuto === null && v[0].colados === 0 && v[1].includes('<u>amplio</u>') && v[1].includes('<s>Camilla</s>'));

  console.log('--- cambios mientras hay algo abierto ---');
  // El reglamento cambia mientras la profesional tiene la hoja abierta: no puede aceptar uno que no vio
  await menu('reservar'); await irAlDia(DIA);
  await clic('button.seg-free[data-action="book"][data-box="1"][data-start="16"]');
  await boton('Continuar'); await boton('Continuar');
  const antesDeCambiar = await js(`S.bookings.filter(b => b.userId).length`);
  await s.pg.query(`update public.consultorios set reglamento = 'Regla nueva: se entra con guardapolvo.', reglamento_version = reglamento_version + 1`);
  await js(`refrescar().then(() => 1)`);
  await js(`document.querySelector('[data-draft="accepted"]').click(); 1`); await dormir(150);
  await boton('Ir a pagar');
  ver('reglamento cambiado con la hoja abierta', [await aviso(), await js(`({ paso: document.querySelector('.overlay .sheet-h .sub')?.textContent, texto: document.querySelector('.overlay .terms')?.innerText, tildado: document.querySelector('[data-draft="accepted"]')?.checked, reservas: S.bookings.filter(b => b.userId).length })`)],
    (v) => v[0].includes('El reglamento cambió recién') && v[1].paso === 'Paso 3 de 3' && v[1].texto.includes('guardapolvo') && v[1].tildado === false && v[1].reservas === antesDeCambiar);
  await clic('.overlay [data-action="close-sheet"]');
  // Un dato que la base rechaza no borra lo que la dueña había escrito
  await salir(); await entrar(DUENA); await menu('config');
  await poner('textarea#tt', 'x'.repeat(8001)); await enviar('form[data-form="cfg-terms"]');
  const avisoDelError = await aviso();
  await js(`document.activeElement && document.activeElement.blur(); refrescar().then(() => 1)`);       // sin el foco en el campo, y con un refresco de por medio
  await dormir(1400);                                                                                   // más de una vuelta del reloj de la página
  ver('un error no borra lo escrito', [avisoDelError, await js(`document.querySelector('textarea#tt').value.length`)], (v) => v[0].includes('Revisá los datos') && v[1] === 8001);
  await menu('inicio'); await menu('config');
  ver('al volver a entrar, lo guardado', await js(`document.querySelector('textarea#tt').value`), (v) => v === 'Regla nueva: se entra con guardapolvo.');

  console.log('--- mails de registro: confirmar la cuenta y olvidé mi contraseña ---');
  await salir();
  s.confirmarMail = true;                                     // como va a quedar el Supabase real: sin abrir el enlace del mail no se entra
  // Como al tocar el enlace desde el correo: se abre en una pestaña limpia, con la página cargando de cero
  const abrirEnlace = async (enlace) => { await cdp('Page.navigate', { url: 'about:blank' }); await dormir(150); await cdp('Page.navigate', { url: enlace }); await hasta(`typeof fase !== "undefined" && fase === "lista" && !ocupada`, 15000); await dormir(250); await quieta(); };
  const enRevision = () => hasta(`document.querySelector('main') && document.querySelector('main').innerText.includes('en revisión')`);
  const pedirAcceso = async (nombre, mail, clave) => {
    await clic('[data-action="auth-tab"][data-tab="register"]');
    await poner('#rn', nombre); await poner('#rp', 'Nutricionista'); await js(`document.querySelectorAll('form[data-form="register"] input[name="category"]')[1].click(); 1`);
    await poner('#rm', mail); await poner('#rt', '11 5555-0142'); await poner('#rc', '27-22333444-5'); await poner('#ri', '5'); await poner('#rw', clave);
    return enviar('form[data-form="register"]');
  };
  const mailsAntes = s.mails.length;
  await pedirAcceso('Eva Ñandú', 'eva@lavanda.prueba', 'clave-de-eva-1');
  ver('pide confirmar el mail', [await texto('.auth-card'), await js(`({ adentro: !!servidor.sesion, guardado: !!localStorage.getItem('et-pedido-lavanda'), conClave: (localStorage.getItem('et-pedido-lavanda') || '').includes('clave-de-eva') })`), s.mails.length - mailsAntes],
    (v) => v[0].includes('Confirmá tu mail') && v[0].includes('eva@lavanda.prueba') && v[0].includes('Mandarlo de nuevo') && !v[1].adentro && v[1].guardado && !v[1].conClave && v[2] === 1);
  await foto('confirma-tu-mail');
  await boton('Mandarlo de nuevo');
  ver('mandarlo de nuevo', [await aviso(), s.mails.length - mailsAntes, s.mails.at(-1).para], (v) => v[0] === 'Listo, te lo mandamos de nuevo.' && v[1] === 2 && v[2] === 'eva@lavanda.prueba');
  await boton('Volver a ingresar');
  await entrar({ email: 'eva@lavanda.prueba' }, 'clave-de-eva-1');
  ver('sin confirmar no entra', [await texto('.auth-card'), await js(`!!servidor.sesion`)], (v) => v[0].includes('Confirmá tu mail') && v[0].includes('eva@lavanda.prueba') && v[1] === false);
  const enlaceDeEva = s.mails.at(-1).enlace;
  await abrirEnlace(enlaceDeEva); await enRevision();
  ver('el enlace del mail la deja adentro', [await texto('main'), await aviso(), await js(`({ barra: location.href, guardado: localStorage.getItem('et-pedido-lavanda'), nombre: me() && me().name })`)],
    (v) => v[0].includes('Tu solicitud está en revisión') && v[1] === 'Tu mail quedó confirmado y tu solicitud ya está enviada.' && !v[2].barra.includes('#') && !v[2].barra.includes('token') && v[2].guardado === null && v[2].nombre === 'Eva Ñandú');
  await foto('mail-confirmado');
  await abrirEnlace(enlaceDeEva);
  ver('con una cuenta adentro, pregunta antes', [await texto('.auth-card'), await js(`location.href`)], (v) => v[0].includes('Abriste un enlace de mail') && v[0].includes('eva@lavanda.prueba') && v[0].includes('Seguir con esta cuenta') && !v[1].includes('token'));
  await boton('Usar el enlace');
  ver('el enlace ya usado, estando adentro', [await aviso(), await js(`!!me() && !location.href.includes('error')`)], (v) => v[0].includes('Ese enlace ya se usó o venció') && v[1] === true);
  await salir();
  await abrirEnlace(enlaceDeEva);
  ver('el enlace ya usado, sin sesión', [await texto('.auth-card'), await js(`location.href`)], (v) => v[0].includes('Ese enlace ya no sirve') && v[0].includes('Pedir un enlace nuevo') && !v[1].includes('error'));
  await foto('enlace-que-ya-no-sirve');
  // Se anota en la compu y abre el mail en el celular: ahí no hay nada guardado, pero el pedido viaja anotado en la cuenta
  await boton('Ingresar');
  await pedirAcceso('Fede Ruiz', 'fede@lavanda.prueba', 'clave-de-fede-1');
  await js(`localStorage.removeItem('et-pedido-lavanda'); 1`);
  ver('el enlace va a la página misma', s.mails.at(-1).enlace, (v) => new RegExp('^' + s.url + '/#token_hash=[0-9a-f]{56}&type=email$').test(v));
  await abrirEnlace(s.mails.at(-1).enlaceDeFabrica); await enRevision();          // y de paso: con el mail de fábrica de Supabase también anda
  ver('abre el mail en otro aparato', [await texto('main'), await js(`me() && me().name`), await aviso(), await js(`location.href`)], (v) => v[0].includes('Tu solicitud está en revisión') && v[1] === 'Fede Ruiz' && v[2].includes('tu solicitud ya está enviada') && !v[3].includes('token'));
  await cdp('Page.reload'); await hasta(`typeof fase !== "undefined" && fase === "lista" && !ocupada`, 15000); await dormir(300);
  ver('al recargar no lo manda dos veces', [await texto('main'), await js(`document.querySelector('#toast').classList.contains('show')`)], (v) => v[0].includes('Tu solicitud está en revisión') && v[1] === false);
  await salir();
  // Un mail que ya tiene cuenta: se avisa y lo escrito no se pierde
  const mailsHastaAca = s.mails.length;
  await pedirAcceso('Lucía Otra', LUCIA.email, 'otra-clave-larga');
  ver('mail que ya tiene cuenta: dice lo mismo', [await texto('.auth-card'), s.mails.length - mailsHastaAca, await js(`!!servidor.sesion`)], (v) => v[0].includes('Confirmá tu mail') && v[0].includes('Si ya tenías una cuenta con ese mail') && v[1] === 0 && v[2] === false);
  await boton('Volver a ingresar');
  // Olvidé mi contraseña
  await clic('[data-action="auth-tab"][data-tab="login"]');
  await boton('Olvidé mi contraseña');
  await poner('#om', 'nadie@lavanda.prueba'); await enviar('form[data-form="olvide"]');
  ver('olvidé: con un mail sin cuenta', [await texto('.auth-card'), s.mails.length - mailsHastaAca], (v) => v[0].includes('Revisá tu mail') && v[0].includes('Si hay una cuenta con nadie@lavanda.prueba') && v[1] === 0);
  await boton('Volver a ingresar'); await boton('Olvidé mi contraseña');
  await poner('#om', 'eva@lavanda.prueba'); await enviar('form[data-form="olvide"]');
  ver('olvidé: manda el enlace', [await texto('.auth-card'), s.mails.at(-1).asunto, s.mails.at(-1).para, s.mails.length - mailsHastaAca], (v) => v[0].includes('Si hay una cuenta con eva@lavanda.prueba') && v[1] === 'Elegí una contraseña nueva' && v[2] === 'eva@lavanda.prueba' && v[3] === 1);
  await foto('olvide-revisa-tu-mail');
  // Esta vez el enlace se abre en la misma pestaña que ya tenía la página: la dirección cambia sin recargar
  await js(`location.href = ${JSON.stringify(s.mails.at(-1).enlace)}; 1`);
  await hasta(`!!document.querySelector('form[data-form="clave-nueva"]')`); await quieta();
  ver('el enlace lleva a elegir la contraseña', [await texto('.auth-card'), await js(`location.href`)], (v) => v[0].includes('Elegí tu contraseña nueva') && v[0].includes('eva@lavanda.prueba') && !v[1].includes('token'));
  await foto('clave-nueva');
  await poner('#cn', 'clave-de-eva-2'); await poner('#cr', 'clave-de-eva-3'); await enviar('form[data-form="clave-nueva"]');
  ver('las dos tienen que coincidir', [await aviso(), await js(`!!document.querySelector('form[data-form="clave-nueva"]')`)], (v) => v[0] === 'Las dos contraseñas no coinciden.' && v[1] === true);
  await poner('#cr', 'clave-de-eva-2'); await enviar('form[data-form="clave-nueva"]');
  ver('contraseña cambiada', [await aviso(), await texto('main')], (v) => v[0] === 'Listo: ya podés entrar con tu contraseña nueva.' && v[1].includes('Tu solicitud está en revisión'));
  await salir();
  ver('la contraseña vieja ya no sirve', (await entrar({ email: 'eva@lavanda.prueba' }, 'clave-de-eva-1'), await aviso()), 'El mail o la contraseña no coinciden.');
  await entrar({ email: 'eva@lavanda.prueba' }, 'clave-de-eva-2');
  ver('entra con la nueva', await texto('main'), 'Tu solicitud está en revisión');
  await salir();
  // Compu compartida: Eva dejó su cuenta abierta y Gabi abre ahí el mail de su propia cuenta. No cambia de cuenta sin preguntar.
  await pedirAcceso('Gabi Sol', 'gabi@lavanda.prueba', 'clave-de-gabi-1');
  const enlaceDeGabi = s.mails.at(-1).enlace;
  await boton('Volver a ingresar');
  await entrar({ email: 'eva@lavanda.prueba' }, 'clave-de-eva-2');
  await abrirEnlace(enlaceDeGabi);
  ver('enlace de otra cuenta: pregunta', await texto('.auth-card'), (v) => v.includes('Abriste un enlace de mail') && v.includes('eva@lavanda.prueba') && v.includes('Usar el enlace'));
  await foto('enlace-con-otra-cuenta-adentro');
  await boton('Seguir con esta cuenta');
  ver('sigue con la cuenta que tenía', await js(`me() && me().name`), (v) => v === 'Eva Ñandú');
  await abrirEnlace(enlaceDeGabi); await boton('Usar el enlace'); await enRevision();
  ver('si elige usarlo, pasa a la otra', [await js(`me() && me().name`), await aviso(), await texto('main')], (v) => v[0] === 'Gabi Sol' && v[1].includes('tu solicitud ya está enviada') && v[2].includes('Tu solicitud está en revisión'));
  await salir();
  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }); await dormir(300);
  await boton('Olvidé mi contraseña');
  ver('celular: olvidé mi contraseña', [await sinDesborde(), await texto('.auth-card')], (v) => v[0] === true && v[1].includes('¿Olvidaste tu contraseña?') && v[1].includes('Mandarme el enlace'));
  await foto('celular-olvide');
  await boton('Volver a ingresar');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false });
  s.confirmarMail = false;

  console.log('--- facturar todo el mes (ARCA simulado, modo prueba) ---');
  // Al final, para no tocar los saldos de las pruebas de arriba: un turno cumplido de Lucía el mes pasado
  await s.pg.query(`update public.consultorios set fact_ambiente = 'prueba' where slug = 'lavanda'`);
  await s.pg.query(`
    insert into public.reservas (consultorio_id, miembro_id, box_id, fecha, desde, hasta, servicio, categoria_id, categoria_nombre,
                                 precio_hora, monto_box, total, monto_sena, plan, estado, reglamento_version)
    select c.id, m.id, b.id, (date_trunc('month', now() at time zone c.zona) - interval '20 days')::date, 8, 12, 'Consulta',
           k.id, k.nombre, k.precio_hora, k.precio_hora * 4, k.precio_hora * 4, k.precio_hora * 2, 'total', 'cumplida', c.reglamento_version
      from public.consultorios c join public.miembros m on m.consultorio_id = c.id and m.email = $1
      join public.boxes b on b.consultorio_id = c.id and b.numero = 1 join public.categorias k on k.id = m.categoria_id
     where c.slug = 'lavanda'`, [LUCIA.email]);
  await entrar(DUENA);
  await menu('facturacion');
  await clic('[data-action="inv-month"][data-go="-1"]');
  ver('facturación en prueba', await texto('main'), (v) => v.includes('Modo prueba') && v.includes('Lucía Ferrari') && v.includes('Sin facturar'));
  ver('botón facturar prendido', await js(`document.querySelector('[data-action="inv-facturar"]').disabled`), false);
  await clic('[data-action="inv-facturar"]');
  const aEmitir = await js(`billingRows(S.ui.invYm).filter(paraFacturar).length`);
  ver('hoja para facturar', await texto('.overlay'), (v) => v.includes(aEmitir === 1 ? 'Emitir 1 factura' : `Emitir ${aEmitir} facturas`) && v.includes('Lucía Ferrari') && v.includes('Monotributista'));
  await foto('facturar-el-mes');
  await clic('[data-action="inv-facturar-ok"]');
  await hasta(`document.querySelector('.overlay') && document.querySelector('.overlay').innerText.includes('Facturadas')`);
  ver('resultado de facturar', await texto('.overlay'), (v) => v.includes('Facturadas') && v.includes('Lucía Ferrari') && v.includes('Número 0000000') && v.includes('Modo prueba'));
  await foto('facturacion-resultado');
  await clic('.overlay [data-action="close-sheet"]');
  await hasta(`!document.querySelector('.overlay')`);
  ver('quedaron facturadas', await texto('main'), (v) => v.includes('Facturada') && v.includes('C 0001-0000000') && !v.includes('Sin facturar'));
  ver('ARCA recibió una por profesional', [s.arca.cuantos('FECAESolicitar'), aEmitir], (v) => v[0] === v[1] && v[0] >= 1);
  ver('ya no queda nada para facturar', await js(`document.querySelector('[data-action="inv-facturar"]').disabled`), true);
  await clic('[data-action="inv-open"]');
  await hasta(`document.querySelector('.overlay') && document.querySelector('.overlay').innerText.includes('Detalle')`);
  ver('la factura', await texto('.overlay'), (v) => /Factura C 0001-0000000\d/.test(v) && v.includes('Factura de prueba') && v.includes('CAE'));
  await clic('.overlay [data-action="close-sheet"]');
  await hasta(`!document.querySelector('.overlay')`);
  await menu('config');
  await clic('[data-action="inv-probar"]');
  await hasta(`document.querySelector('.overlay') && document.querySelector('.overlay').innerText.includes('ARCA responde')`);
  ver('probar la conexión con ARCA', await texto('.overlay'), (v) => v.includes('ARCA responde') && v.includes(`Último número emitido: ${aEmitir}`));
  await clic('.overlay [data-action="close-sheet"]');
  await salir();

  console.log('--- errores ---');
  const propios = errores.filter((e) => !/Failed to load resource.*(400|401|403)/.test(e));      // los rechazos esperados (clave equivocada) no cuentan
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
