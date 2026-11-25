// Comprueba desde afuera la función «mp» del proyecto REAL de Supabase, sin entrar con ninguna cuenta y sin cambiar nada:
// que conteste lo que corresponde a quien no tiene que pasar.
//   node pruebas/real-mp.mjs        (también: npm run test:real-mp)
// Con los 4 secretos de Mercado Pago todavía sin pegar, los avisos contestan 500 «falta_configurar»; después, 401 «firma_invalida».
import { readFileSync } from 'node:fs';

const config = readFileSync(new URL('../web/config.js', import.meta.url), 'utf8');
const base = config.match(/url:\s*"([^"]+)"/)[1];
const clave = config.match(/key:\s*"([^"]+)"/)[1];                 // la clave pública: está en la página
const mp = `${base}/functions/v1/mp`;
const PAGINA = 'https://yanina.entreturno.com.ar';

let fallas = 0;
async function ver(nombre, esperado, opciones, { url = mp, origen } = {}) {
  let estado = 0, texto = '', permitido = null;
  try {
    const r = await fetch(url, { redirect: 'manual', ...opciones, headers: { ...(opciones.headers ?? {}), ...(origen ? { Origin: origen } : {}) } });
    estado = r.status;
    texto = (await r.text()).slice(0, 140).replace(/\s+/g, ' ');
    permitido = r.headers.get('access-control-allow-origin');
  } catch (e) {
    texto = `sin respuesta: ${e.message}`;
  }
  const bien = esperado({ estado, texto, permitido });
  fallas += !bien;
  console.log(`  [${bien ? 'OK]   ' : 'FALLA]'} ${nombre.padEnd(62)} ${estado} ${texto}${permitido ? `  (permite ${permitido})` : ''}`);
}
const post = (cuerpo, headers = {}) => ({ method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(cuerpo) });
const uuid = '00000000-0000-4000-8000-000000000000';

console.log(`Función: ${mp}`);
await ver('volver de Mercado Pago sin datos', (r) => r.estado === 400 && /ya no sirve/.test(r.texto), { method: 'GET' });
await ver('volver de Mercado Pago con un permiso inventado', (r) => r.estado === 400 && /ya no sirve/.test(r.texto), { method: 'GET' },
  { url: `${mp}?code=TG-inventado&state=${'x'.repeat(43)}` });
await ver('un método que no se usa (PUT)', (r) => r.estado === 405, { method: 'PUT' });
await ver('el navegador pregunta desde la página de Yani', (r) => r.estado === 204 && r.permitido === PAGINA, { method: 'OPTIONS' }, { origen: PAGINA });
await ver('el navegador pregunta desde otro sitio', (r) => r.estado === 204 && r.permitido === null, { method: 'OPTIONS' }, { origen: 'https://otro-sitio.com' });
await ver('el navegador pregunta desde un sitio parecido', (r) => r.estado === 204 && r.permitido === null, { method: 'OPTIONS' },
  { origen: 'https://entreturno.com.ar.otro-sitio.com' });
await ver('pagar sin haber entrado', (r) => r.estado === 401 && /sin_sesion/.test(r.texto), post({ accion: 'pagar', slug: 'yanina', reserva: uuid, tipo: 'sena' }), { origen: PAGINA });
await ver('pagar con un pase inventado', (r) => r.estado === 401, post({ accion: 'pagar', slug: 'yanina', reserva: uuid, tipo: 'sena' }, { Authorization: 'Bearer abc.def.ghi' }), { origen: PAGINA });
await ver('pagar con la clave pública de la página', (r) => r.estado >= 400 && r.estado < 500, post({ accion: 'pagar', slug: 'yanina', reserva: uuid, tipo: 'sena' }, { Authorization: `Bearer ${clave}` }), { origen: PAGINA });
await ver('conectar la cuenta sin haber entrado', (r) => r.estado === 401, post({ accion: 'conectar', slug: 'yanina' }), { origen: PAGINA });
await ver('conectar la cuenta con la clave pública', (r) => r.estado >= 400 && r.estado < 500, post({ accion: 'conectar', slug: 'yanina' }, { Authorization: `Bearer ${clave}` }), { origen: PAGINA });
await ver('pedir desde otro sitio', (r) => r.estado === 403 && /origen_no_permitido/.test(r.texto), post({ accion: 'conectar', slug: 'yanina' }, { Authorization: 'Bearer abc.def.ghi' }), { origen: 'https://otro-sitio.com' });
await ver('pedir sin decir desde dónde', (r) => r.estado === 403 && /origen_no_permitido/.test(r.texto), post({ accion: 'conectar', slug: 'yanina' }, { Authorization: 'Bearer abc.def.ghi' }));
await ver('un aviso con firma inventada', (r) => (r.estado === 401 && /firma_invalida/.test(r.texto)) || (r.estado === 500 && /falta_configurar/.test(r.texto)),
  post({ type: 'order', data: { id: 'ORDPRUEBA' } }, { 'x-signature': `ts=${Math.floor(Date.now() / 1000)},v1=${'0'.repeat(64)}`, 'x-request-id': 'prueba' }), { url: `${mp}?data.id=ORDPRUEBA&type=order` });
await ver('hacerse pasar por el reloj', (r) => r.estado === 401 && /sin_permiso/.test(r.texto), post({}, { 'x-entreturno-reloj': 'clave-inventada-de-mas-de-treinta-y-dos-letras' }));
await ver('hacerse pasar por el reloj con la clave vacía', (r) => r.estado === 401 && /sin_permiso/.test(r.texto), post({}, { 'x-entreturno-reloj': '' }));

console.log(fallas ? `\n${fallas} FALLAS` : '\nTODO BIEN');
process.exit(fallas ? 1 : 0);
