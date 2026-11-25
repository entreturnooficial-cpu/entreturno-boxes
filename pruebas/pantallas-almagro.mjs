// Las reglas de «Punto Almagro» en la página: el lema, la seña que no se devuelve, ningún saldo pendiente y cambiar un turno de día.
//   node pruebas/pantallas-almagro.mjs      (npm run test:pantallas-almagro)
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { CLAVE_DE_PRUEBA, DUENA, PROFESIONALES } from './datos-de-ejemplo.mjs';
import { comoRol } from './base.mjs';
import { NAVEGADOR, carpetaDeCapturas } from './navegador.mjs';
import { crearServidor } from './servidor-local.mjs';

const [LUCIA, CARO] = PROFESIONALES;
const dos = (n) => String(n).padStart(2, '0');
const CAPTURAS = carpetaDeCapturas('pantallas-almagro');
const PUERTO = +(process.env.PUERTO || 9474);
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

const s = await crearServidor();
const nav = spawn(NAVEGADOR, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--remote-debugging-port=${PUERTO}`,
  `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'edge-boxes-al-'))}`, '--window-size=1366,768', '--host-resolver-rules=MAP *.entreturno.com.ar 127.0.0.1', 'about:blank'], { stdio: 'ignore' });      // (esas direcciones, en esta prueba, son esta compu)
let info;
for (let i = 0; i < 80 && !info; i++) { try { info = (await (await fetch(`http://127.0.0.1:${PUERTO}/json`)).json()).find((t) => t.type === 'page'); } catch {} if (!info) await dormir(250); }
const ws = new WebSocket(info.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
let id = 0; const pend = new Map(); const errores = []; const pedidas = [];      // pedidas: las páginas que quiso abrir
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); }
  // (la vuelta de Mercado Pago trae una dirección larguísima: se le saca lo que va después del «?» para que se lea dónde falló)
  if (d.method === 'Runtime.exceptionThrown') errores.push((d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text).replace(/\?[^\s:)]*/g, '').slice(0, 700));
  if (d.method === 'Network.requestWillBeSent' && d.params.type === 'Document') pedidas.push(d.params.request.url);
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
const DIA = diaHabil(9);
const OTRO = diaHabil(13);

try {
  await cdp('Page.enable'); await cdp('Runtime.enable'); await cdp('Log.enable'); await cdp('Network.enable');
  await s.pg.query(`update public.consultorios set lema = 'Alquiler de consultorios y gabinetes profesionales', sena_no_vuelve = true, pol_total_antes = 100, pol_total_despues = 0,
                      max_saldos = 0, repro_max = 1, repro_dias = 3 where slug = 'lavanda'`);
  const usuario = async (email) => (await s.pg.query('select usuario_id from public.miembros where email = $1', [email])).rows[0].usuario_id;
  const lucia = await usuario(LUCIA.email), caro = await usuario(CARO.email);
  const deQuien = async (quien, sql, params) => Object.values((await comoRol(s.pg, 'authenticated', quien, (tx) => tx.query(sql, params))).rows[0])[0];
  const como = (sql, params) => deQuien(lucia, sql, params);
  const maquina = (await s.pg.query(`select m.id from public.maquinas m join public.consultorios c on c.id = m.consultorio_id where c.slug = 'lavanda' and m.activa and not m.quitada order by m.nombre limit 1`)).rows[0].id;
  const r = await como(`select public.reservar('lavanda', 1, $1::date, 8, 12, 'Consulta', 'sena', array[$2::uuid], 1)`, [DIA, maquina]);
  await como(`select public.simular_pago('lavanda', $1, 'sena')`, [r.id]);
  // el otro día, a la tarde, esa máquina la tiene otra profesional
  const deCaro = await deQuien(caro, `select public.reservar('lavanda', 1, $1::date, 16, 20, 'Consulta', 'total', array[$2::uuid], 1)`, [OTRO, maquina]);
  await deQuien(caro, `select public.simular_pago('lavanda', $1, 'total')`, [deCaro.id]);
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: `${s.url}/` });
  await hasta(`typeof fase !== "undefined" && fase === "lista"`, 15000);

  console.log('--- el lema ---');
  ver('en el ingreso', await texto('.auth-side'), (v) => v.includes('Alquiler de consultorios y gabinetes profesionales') && v.includes('Tu espacio equipado, por turnos') && v.includes('3 espacios equipados'));
  ver('en el título', await js('document.title'), 'Consultorio Lavanda · Alquiler de consultorios y gabinetes profesionales');

  ver('de qué consultorio es cada dirección', await js(`['yanina.entreturno.com.ar', 'entreturno-boxes.pages.dev', 'localhost', 'yanina.entreturno.com.ar.malo.com', 'a.b.entreturno.com.ar', 'entreturno.com.ar'].map(x => consultorioDe(x) || '-').join(' ')`), (v) => v === 'yanina - - - - -');
  ver('a dónde sigue si cambió de dirección', await js(`[direccionNueva('yanina.entreturno.com.ar', 'puntoalmagro'), direccionNueva('puntoalmagro.entreturno.com.ar', 'puntoalmagro'), direccionNueva('yanina.otro.com', 'puntoalmagro'), direccionNueva('yanina.entreturno.com.ar', 'a.b/c'), direccionNueva('localhost', 'lavanda')].map(x => x || '-').join(' ')`), (v) => v === 'https://puntoalmagro.entreturno.com.ar - - - -');

  console.log('--- la profesional ---');
  await entrar(LUCIA);
  await menu('mis'); await clic('[data-action="tab"][data-v="proximas"]');
  ver('le dice que le falta pagar', await texto('main'), (v) => v.includes('Te falta pagar') && v.includes('Hasta pagarlo no podés reservar otro'));
  ver('puede cambiarlo de día', await js(`[...document.querySelectorAll('.bk .acts button')].map(b => b.textContent.trim()).join(', ')`), (v) => v.includes('Cambiar de día') && v.includes('Cancelar'));
  await foto('mis-reservas');
  await menu('reservar'); await irAlDia(OTRO);
  await clic('button.seg-free[data-action="book"][data-box="2"][data-start="12"]');
  ver('no puede reservar otro', [await aviso(), await js(`!!document.querySelector('.overlay .sheet')`)], (v) => v[0].includes('Tenés un turno sin terminar de pagar') && v[1] === false);
  await menu('mis');
  await clic('[data-action="cancel"]');
  ver('al cancelar, en palabras', await hoja(), (v) => v.includes('La seña no se devuelve. Si cancelás con 7 días o más, te devolvemos todo menos la seña. Con menos, no hay devolución.') && v.includes('son la seña') && v.includes('Mejor cambiarlo de día') && v.includes('no corresponde devolución'));
  await foto('cancelar');
  await boton('Mejor cambiarlo de día');
  ver('la hoja para cambiarlo', await hoja(), (v) => v.includes('Cambiar de día') && v.includes('Ahora: ') && v.includes('Lugares libres') && v.includes('Podés cambiarlo de día una sola vez, si hay lugar y avisás con 3 días o más.') && v.includes('se cuentan desde la fecha más temprana que tuvo'));
  ver('muestra todos los días del plazo', await js(`(() => { const c = S.config, d = [...document.querySelectorAll('#mover-dia option')].map(x => x.value); const u = addDays(mondayOf(todayIso()), 7 * c.weeksAhead + 6); let n = 0; for (let x = todayIso(); x <= u; x = addDays(x, 1)) if (c.days.includes(weekday(x))) n++; return [d.length, n, c.weeksAhead].join(' '); })()`), (v) => v.split(' ')[0] === v.split(' ')[1] && +v.split(' ')[0] > 45);
  ver('sin elegir no se puede', await js(`document.querySelector('[data-action="mover-ok"]').disabled`), (v) => v === true);
  await js(`(() => { const e = document.querySelector('#mover-dia'); e.value = '${OTRO}'; e.dispatchEvent(new Event('change', { bubbles: true })); return 1; })()`); await dormir(200);
  const lugares = () => js(`[...document.querySelectorAll('[data-mover="lugar"]')].map(x => x.value).join(' ')`);
  ver('los lugares de ese día', await lugares(), (v) => v === '1|8 1|12 2|8 2|12');          // el box 3 tiene otro precio: no se ofrece
  ver('la máquina ocupada saca el horario', await lugares(), (v) => !v.includes('|16'));
  await js(`(() => { const e = document.querySelector('#mover-dia'); e.value = '${DIA}'; e.dispatchEvent(new Event('change', { bubbles: true })); return 1; })()`); await dormir(200);
  ver('la propia no se tapa a sí misma', await lugares(), (v) => v.includes('2|8') && !v.includes('1|8'));
  await js(`S.blocks.push({ id: 'p1', boxIds: [1], date: '${DIA}', start: 8, end: 16, recurring: false }); S.releases.push({ id: 'p2', boxId: 1, date: '${DIA}', start: 8, end: 16 }); renderMover(); 1`); await dormir(100);
  ver('adentro de un rato libre, como la base', await lugares(), (v) => !v.includes('1|8') && !v.includes('1|12') && v.includes('1|16'));
  await js(`S.blocks.pop(); S.releases.pop(); S.boxes.find(x => x.id === 3).prices = {}; renderMover(); 1`); await dormir(100);
  ver('al mismo precio sí se ofrece', await lugares(), (v) => v.includes('2|8') && v.includes('3|8'));
  await js(`S.boxes.forEach(x => { x.prices = { [findB(mudanza.id).category]: 99999 }; }); renderMover(); 1`); await dormir(100);
  ver('si aumentó, solo en el mismo', await lugares(), (v) => v.includes('1|12') && !v.includes('2|') && !v.includes('3|'));
  await js(`refrescar().then(() => 1)`); await dormir(200);
  await js(`(() => { const e = document.querySelector('#mover-dia'); e.value = '${OTRO}'; e.dispatchEvent(new Event('change', { bubbles: true })); return 1; })()`); await dormir(200);
  await js(`(() => { const e = document.querySelector('[data-mover="lugar"][value="2|12"]'); e.click(); return 1; })()`); await dormir(200);
  ver('elegido', await js(`[document.querySelector('#mover-dia').value, document.querySelector('[data-mover="lugar"]:checked').value, document.querySelector('[data-action="mover-ok"]').disabled].join(' ')`), `${OTRO} 2|12 false`);
  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }); await dormir(250);
  ver('en celular, sin desborde', await js(`document.documentElement.scrollWidth <= window.innerWidth + 1`), (v) => v === true);
  await foto('cambiar-de-dia-celular');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false }); await dormir(200);
  await clic('[data-action="mover-ok"]'); await dormir(400);
  ver('cambiado', [await aviso(), (await s.pg.query(`select to_char(fecha, 'YYYY-MM-DD') as dia, desde, reprogramada from public.reservas where id = $1`, [r.id])).rows[0]],
    (v) => v[0].startsWith('Listo: ahora es el') && /12 a 16/.test(v[0].replace(/\s/g, ' ')) && v[1].dia === OTRO && v[1].desde === 12 && v[1].reprogramada === 1);
  ver('queda dicho y no se puede otra vez', await texto('.bk'), (v) => v.includes('(antes ') && v.includes('Ya lo cambiaste de día una vez.') && !v.includes('Cambiar de día'));
  await clic('[data-action="cancel"]');
  ver('al cancelar ya no lo ofrece', await hoja(), (v) => !v.includes('Mejor cambiarlo de día') && /Faltan 8 días para la fecha que tenía antes \(/.test(v));
  await js(`S.config.policy.depositKept = false; openCancel(findB('${r.id}')); 1`); await dormir(150);
  ver('también si la seña se devuelve', await hoja(), (v) => (v.match(/para la fecha que tenía antes \(/g) || []).length === 2 && !v.includes('para el turno'));
  await js(`findB('${r.id}').policyFrom = Date.now() - 864e5; openCancel(findB('${r.id}')); 1`); await dormir(150);
  ver('y si esa fecha ya pasó', await hoja(), (v) => v.includes('Ya pasó la fecha que tenía antes ('));
  await clic('.overlay [data-action="close-sheet"]');
  await js(`refrescar().then(() => 1)`);
  await como(`select public.simular_pago('lavanda', $1, 'saldo')`, [r.id]);
  await js(`refrescar().then(() => 1)`);
  await menu('reservar'); await irAlDia(OTRO);
  await clic('button.seg-free[data-action="book"][data-box="3"][data-start="8"]');
  await boton('Continuar');
  ver('al día, reserva y ve la política', await hoja(), (v) => v.includes('La seña no se devuelve. Si cancelás con 7 días o más, te devolvemos todo menos la seña.') && v.includes('Podés cambiarlo de día una sola vez'));
  await clic('.overlay [data-action="close-sheet"]');
  await salir();

  console.log('--- la dueña ---');
  await entrar(DUENA);
  await menu('config');
  ver('las reglas en Configuración', await js(`[document.querySelector('[name="depositKept"]').checked, document.querySelector('[name="moves"]').value, document.querySelector('[name="moveDays"]').value, document.querySelector('[name="maxSaldos"]').selectedOptions[0].textContent.trim()].join(' | ')`), 'true | 1 | 3 | Ninguno: hasta pagar, no reserva otro');
  await poner('[name="moves"]', '2'); await poner('[name="moveDays"]', '5');
  await enviar('form[data-form="cfg-politica"]');
  ver('se guardan', [await aviso(), (await s.pg.query(`select repro_max, repro_dias, sena_no_vuelve from public.consultorios where slug = 'lavanda'`)).rows[0]], (v) => v[0] === 'Política de cancelación guardada.' && v[1].repro_max === 2 && v[1].repro_dias === 5 && v[1].sena_no_vuelve === true);
  await js(`document.querySelector('form[data-form="cfg-politica"]').scrollIntoView({ block: 'center' }); 1`);
  await foto('config-politica');
  await js(`openAdminBooking(S.bookings.find(b => b.id === '${r.id}')); 1`); await dormir(300);
  ver('ve el cambio en la reserva', await hoja(), (v) => v.includes('Cambio de día') && v.includes('Era el') && v.includes('lo cambió una vez') && v.includes('Cambiar de día'));
  await clic('[data-action="mover"]');
  ver('y la puede mover', await hoja(), (v) => v.includes('Lo que ya pagó sigue valiendo'));
  await clic('.overlay [data-action="close-sheet"]');

  console.log('--- errores ---');
  const propios = errores.filter((e) => !/Failed to load resource.*(400|401|403)/.test(e));      // los rechazos esperados no cuentan
  ver('errores de la página', propios, (v) => v.length === 0);

  console.log('--- la dirección, con nombres como los de verdad (config.js fija «lavanda», igual que lo publicado) ---');
  const puerto = new URL(s.url).port;
  await salir();
  await cdp('Page.navigate', { url: `http://lavanda.entreturno.com.ar:${puerto}/` });
  await hasta(`typeof fase !== "undefined" && fase === "lista"`, 15000); await dormir(500);
  ver('en la suya, se queda', await js(`[location.host, SLUG, document.title].join(' ')`), `lavanda.entreturno.com.ar:${puerto} lavanda Consultorio Lavanda`);
  await cdp('Page.navigate', { url: `http://otra.entreturno.com.ar:${puerto}/` });
  await hasta(`typeof fase !== "undefined" && fase === "error"`, 15000);
  ver('en una que no es de nadie, no entra', await js(`[SLUG, fase, document.body.innerText.replace(/\\s+/g, ' ').slice(0, 120)].join(' · ')`), 'otra · error');
  await s.pg.query(`update public.consultorios set slugs_viejos = '{vieja}' where slug = 'lavanda'`);
  await cdp('Page.navigate', { url: `http://vieja.entreturno.com.ar:${puerto}/?x=1` });
  for (let t = 0; t < 8000 && !pedidas.some((u) => u.startsWith('https://')); t += 200) await dormir(200);
  ver('en la vieja, sigue en la nueva', pedidas.filter((u) => u.startsWith('https://')), (v) => v.length >= 1 && v[0] === 'https://lavanda.entreturno.com.ar/?x=1');
} catch (e) {
  fallas++;
  console.log('  [FALLA] la prueba se cortó:', e);
} finally {
  ws.close(); nav.kill(); await s.cerrar();
}
console.log(fallas ? `\n${fallas} DE ${hechas} COMPROBACIONES FALLARON` : `\nLAS ${hechas} COMPROBACIONES PASARON`);
console.log('Capturas:', CAPTURAS);
process.exit(fallas ? 1 : 0);
