// Servidor de prueba: imita lo que la página usa de Supabase (ingreso y funciones de la base), con una base
// que vive en la memoria de este programa. Sirve para probar la página entera en la compu, sin internet y sin
// tocar el Supabase real. Al apagarlo se pierde todo.
//
//   node pruebas/servidor-local.mjs            → queda escuchando en http://localhost:8092  (PUERTO=… para cambiarlo)
//
// Qué imita:
//   POST /auth/v1/signup                         crear cuenta
//   POST /auth/v1/token?grant_type=password      entrar
//   POST /auth/v1/token?grant_type=refresh_token renovar el pase
//   POST /auth/v1/logout                         salir
//   POST /auth/v1/recover                        «olvidé mi contraseña»: manda el enlace para elegir otra
//   POST /auth/v1/resend                         volver a mandar el mail de confirmación
//   PUT  /auth/v1/user                           cambiar la contraseña o los datos anotados en la cuenta
//   POST /auth/v1/verify                         canjear el código del enlace de un mail por la sesión (nuestras plantillas)
//   GET  /auth/v1/verify                         el enlace de los mails de fábrica: vuelve a la página con la sesión después del #
//   GET  /__prueba/mails                         (solo acá) los mails que se «mandaron», para poder abrir sus enlaces
//   POST /rest/v1/rpc/<función>                  llamar una función de la base, con los parámetros por nombre en JSON
// Además sirve la carpeta web/ (la página) y arma un config.js que apunta a este mismo servidor.

import { createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { armarBase, comoRol, crearCuenta } from './base.mjs';
import { BOXES, CATEGORIAS, CLAVE_DE_PRUEBA, CONSULTORIO, DUENA, MAQUINAS, PROFESIONALES } from './datos-de-ejemplo.mjs';

const CARPETA_WEB = fileURLToPath(new URL('../web/', import.meta.url));
const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon' };
/** La clave pública de mentira que usa la página contra este servidor. */
export const CLAVE_PUBLICA = 'clave-publica-de-prueba';

const b64 = (x) => Buffer.from(x).toString('base64url');

export async function crearServidor({ puerto = 0, duracionPase = 3600, sembrar = true, confirmarMail = false } = {}) {
  const pg = await armarBase();
  const secreto = randomBytes(32);
  const cuentas = new Map();        // mail → { id, email, sal, hash }
  const renovaciones = new Map();   // código para renovar → id de la cuenta
  const firmasDeFunciones = new Map();
  const mails = [];                 // los mails de registro que «mandaría» Supabase: { para, asunto, enlace, enlaceDeFabrica }
  const enlaces = new Map();        // código del enlace → { cuenta, tipo }
  // «enlace» es el de nuestras plantillas: va a la página, con el código después del #, y la página lo canjea.
  // «enlaceDeFabrica» es el de las plantillas que trae Supabase: pasa por el servidor y vuelve con la sesión después del #.
  const mandarEnlace = (cuenta, tipo, asunto, volver, host) => {
    const codigo = randomBytes(28).toString('hex');
    const pagina = volver || `http://${host}/`;
    enlaces.set(codigo, { cuenta, tipo });
    mails.push({ para: cuenta.email, asunto, enlace: `${pagina}#token_hash=${codigo}&type=${tipo === 'signup' ? 'email' : tipo}`,
      enlaceDeFabrica: `http://${host}/auth/v1/verify?token=${codigo}&type=${tipo}&redirect_to=${encodeURIComponent(pagina)}` });
  };

  // ---------- pases (como los de Supabase: un JWT firmado, con vencimiento)
  const firmar = (datos) => {
    const cuerpo = `${b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64(JSON.stringify(datos))}`;
    return `${cuerpo}.${createHmac('sha256', secreto).update(cuerpo).digest('base64url')}`;
  };
  const leerPase = (pase) => {
    const [a, b, firma] = String(pase).split('.');
    if (!a || !b || !firma) return null;
    const esperada = createHmac('sha256', secreto).update(`${a}.${b}`).digest();
    const recibida = Buffer.from(firma, 'base64url');
    if (recibida.length !== esperada.length || !timingSafeEqual(recibida, esperada)) return null;
    try { return JSON.parse(Buffer.from(b, 'base64url').toString('utf8')); } catch { return null; }
  };
  const sesionPara = (cuenta) => {
    const ahora = Math.floor(Date.now() / 1000);
    const renovar = randomBytes(24).toString('base64url');
    renovaciones.set(renovar, cuenta.id);
    return { access_token: firmar({ sub: cuenta.id, role: 'authenticated', email: cuenta.email, user_metadata: cuenta.datos ?? {}, exp: ahora + duracionPase }),
      token_type: 'bearer', expires_in: duracionPase, expires_at: ahora + duracionPase, refresh_token: renovar,
      user: { id: cuenta.id, email: cuenta.email, user_metadata: cuenta.datos ?? {} } };
  };
  const huella = (clave, sal) => scryptSync(clave, sal, 32);

  async function altaDeCuenta(email, clave) {
    const sal = randomBytes(16);
    const cuenta = { id: await crearCuenta(pg, email), email, sal, hash: huella(clave, sal) };
    cuentas.set(email, cuenta);
    return cuenta;
  }

  // ---------- llamar una función de la base como lo hace la API de Supabase:
  // los parámetros llegan por nombre en un JSON y se pasan a los tipos de la función.
  async function firmaDe(nombre) {
    if (!firmasDeFunciones.has(nombre)) {
      const r = await pg.query(
        `select p.proargnames as nombres, (select array_agg(t::regtype::text order by n) from unnest(p.proargtypes) with ordinality as x(t, n)) as tipos
           from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = $1`, [nombre]);
      firmasDeFunciones.set(nombre, r.rows.length === 1 ? { nombres: r.rows[0].nombres ?? [], tipos: r.rows[0].tipos ?? [] } : null);
    }
    return firmasDeFunciones.get(nombre);
  }
  async function llamar(nombre, args, rol, sub) {
    if (!/^[a-z_][a-z0-9_]*$/.test(nombre)) return [404, { code: 'PGRST202', message: `Could not find the function public.${nombre} in the schema cache` }];
    const firma = await firmaDe(nombre);
    const claves = Object.keys(args).sort();
    if (!firma || JSON.stringify([...firma.nombres].sort()) !== JSON.stringify(claves)) {
      return [404, { code: 'PGRST202', message: `Could not find the function public.${nombre}(${claves.join(', ')}) in the schema cache`,
        hint: firma ? `Parámetros esperados: ${firma.nombres.join(', ')}` : null }];
    }
    const lista = firma.nombres.map((n) => `${n} => x.${n}`).join(', ');
    const columnas = firma.nombres.map((n, i) => `${n} ${firma.tipos[i]}`).join(', ');
    try {
      const r = await comoRol(pg, rol, sub, (tx) =>
        tx.query(`select public.${nombre}(${lista}) as r from jsonb_to_record($1::jsonb) as x(${columnas})`, [JSON.stringify(args)]));
      return [200, r.rows[0].r];
    } catch (e) {
      const cuerpo = { code: e.code ?? 'XX000', message: e.message, details: e.detail ?? null, hint: e.hint ?? null };
      if (e.code === '42501') return [sub ? 403 : 401, cuerpo];
      return [e.code === 'P0001' || String(e.code).startsWith('2') ? 400 : 500, cuerpo];
    }
  }

  // ---------- datos de ejemplo
  if (sembrar) {
    const c = (await pg.query(
      `insert into public.consultorios (slug, nombre, duena, letras, reglamento, fact_nombre, fact_cuit, fact_condicion, fact_punto_venta)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
      [CONSULTORIO.slug, CONSULTORIO.nombre, CONSULTORIO.duena, CONSULTORIO.letras, CONSULTORIO.reglamento, CONSULTORIO.facturacion.nombre,
        CONSULTORIO.facturacion.cuit, CONSULTORIO.facturacion.condicion, CONSULTORIO.facturacion.puntoVenta])).rows[0].id;
    const cat = {};
    for (const [i, k] of CATEGORIAS.entries()) {
      cat[k.clave] = (await pg.query(`insert into public.categorias (consultorio_id, nombre, nota, precio_hora, orden) values ($1, $2, $3, $4, $5) returning id`,
        [c, k.nombre, k.nota, k.precio, i + 1])).rows[0].id;
    }
    for (const b of BOXES) {
      const id = (await pg.query(`insert into public.boxes (consultorio_id, numero, nombre, resumen, equipamiento) values ($1, $2, $3, $4, $5) returning id`,
        [c, b.numero, b.nombre, b.resumen, b.equipamiento])).rows[0].id;
      for (const [clave, precio] of Object.entries(b.precios ?? {})) {
        await pg.query(`insert into public.box_precios (box_id, categoria_id, consultorio_id, precio_hora) values ($1, $2, $3, $4)`, [id, cat[clave], c, precio]);
      }
    }
    for (const m of MAQUINAS) {
      await pg.query(`insert into public.maquinas (consultorio_id, nombre, resumen, precio_hora, activa) values ($1, $2, $3, $4, $5)`, [c, m.nombre, m.resumen, m.precio, m.activa]);
    }
    const duena = await altaDeCuenta(DUENA.email, CLAVE_DE_PRUEBA);
    await pg.query(`select interno.alta_admin($1, $2, $3)`, [CONSULTORIO.slug, DUENA.email, DUENA.nombre]);
    for (const p of PROFESIONALES) {
      const cuenta = await altaDeCuenta(p.email, CLAVE_DE_PRUEBA);
      const [, pedido] = await llamar('pedir_acceso', { p_slug: CONSULTORIO.slug, p_nombre: p.nombre, p_profesion: p.profesion, p_categoria: cat[p.categoria],
        p_telefono: p.telefono, p_cuit: p.cuit }, 'authenticated', cuenta.id);
      if (p.estado === 'aprobado') {
        await llamar('cambiar_estado_profesional', { p_slug: CONSULTORIO.slug, p_miembro: pedido.id, p_estado: 'aprobado' }, 'authenticated', duena.id);
      }
    }
  }

  // ---------- el servidor
  const responder = (res, estado, cuerpo, cabeceras = {}) => {
    const texto = cuerpo === undefined ? '' : JSON.stringify(cuerpo);
    res.writeHead(estado, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store', ...cabeceras });
    res.end(texto);
  };
  const leerCuerpo = (req) => new Promise((resolver, rechazar) => {
    const trozos = [];
    let total = 0;
    req.on('data', (t) => { total += t.length; if (total > 2_000_000) { rechazar(new Error('demasiado')); req.destroy(); } else trozos.push(t); });
    req.on('end', () => { try { resolver(trozos.length ? JSON.parse(Buffer.concat(trozos).toString('utf8')) : {}); } catch (e) { rechazar(e); } });
    req.on('error', rechazar);
  });

  const servidor = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'apikey, authorization, content-type', 'Access-Control-Allow-Methods': 'POST, PUT, GET, OPTIONS' });
        return res.end();
      }
      if (req.method === 'GET') {
        if (url.pathname === '/__prueba/mails') return responder(res, 200, mails);
        if (url.pathname === '/auth/v1/verify') {        // el enlace que llega por mail: confirma la cuenta (o deja elegir otra clave) y vuelve a la página
          const codigo = url.searchParams.get('token'), dato = enlaces.get(codigo);
          const volver = url.searchParams.get('redirect_to') || `http://${req.headers.host}/`;
          if (!dato) { res.writeHead(302, { Location: `${volver}#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired` }); return res.end(); }
          enlaces.delete(codigo);
          dato.cuenta.confirmada = true;
          const ses = sesionPara(dato.cuenta);
          res.writeHead(302, { Location: `${volver}#access_token=${ses.access_token}&expires_at=${ses.expires_at}&expires_in=${ses.expires_in}&refresh_token=${ses.refresh_token}&token_type=bearer&type=${dato.tipo}` });
          return res.end();
        }
        if (url.pathname === '/config.js') {
          res.writeHead(200, { 'Content-Type': TIPOS['.js'], 'Cache-Control': 'no-store' });
          return res.end(`window.ENTRETURNO = ${JSON.stringify({ url: `http://${req.headers.host}`, key: CLAVE_PUBLICA, slug: CONSULTORIO.slug, prueba: true })};\n`);
        }
        const pedido = normalize(decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
        const ruta = join(CARPETA_WEB, pedido);
        if (!ruta.startsWith(CARPETA_WEB) || pedido.split(sep).includes('..')) return responder(res, 404, { message: 'no existe' });
        try {
          const datos = await readFile(ruta);
          res.writeHead(200, { 'Content-Type': TIPOS[extname(ruta)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
          return res.end(datos);
        } catch {
          return responder(res, 404, { message: 'no existe' });
        }
      }
      if (req.method === 'PUT' && url.pathname === '/auth/v1/user') {      // cambiar la contraseña o los datos de quien está adentro
        if (req.headers.apikey !== CLAVE_PUBLICA) return responder(res, 401, { message: 'No API key found in request' });
        const datos = leerPase(String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''));
        const cuenta = datos && datos.exp > Date.now() / 1000 && [...cuentas.values()].find((x) => x.id === datos.sub);
        if (!cuenta) return responder(res, 401, { code: 401, error_code: 'bad_jwt', msg: 'invalid JWT' });
        const pedido = await leerCuerpo(req);
        if (pedido.password !== undefined) {
          const nueva = String(pedido.password ?? '');
          if (nueva.length < 6) return responder(res, 422, { code: 422, error_code: 'weak_password', msg: 'Password should be at least 6 characters.' });
          if (timingSafeEqual(huella(nueva, cuenta.sal), cuenta.hash)) return responder(res, 422, { code: 422, error_code: 'same_password', msg: 'New password should be different from the old password.' });
          cuenta.sal = randomBytes(16); cuenta.hash = huella(nueva, cuenta.sal);
        }
        if (pedido.data && typeof pedido.data === 'object') {             // se suma a lo anotado; lo que viene en null se borra
          cuenta.datos = { ...(cuenta.datos ?? {}) };
          for (const [k, v] of Object.entries(pedido.data)) { if (v === null) delete cuenta.datos[k]; else cuenta.datos[k] = v; }
        }
        return responder(res, 200, { id: cuenta.id, email: cuenta.email, user_metadata: cuenta.datos ?? {} });
      }
      if (req.method !== 'POST') return responder(res, 405, { message: 'método no permitido' });
      if (req.headers.apikey !== CLAVE_PUBLICA) return responder(res, 401, { message: 'No API key found in request' });
      const cuerpo = await leerCuerpo(req);
      const pase = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');

      if (url.pathname === '/auth/v1/signup') {
        const email = String(cuerpo.email ?? '').trim().toLowerCase();
        const clave = String(cuerpo.password ?? '');
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return responder(res, 400, { code: 400, error_code: 'validation_failed', msg: 'Unable to validate email address: invalid format' });
        if (clave.length < 6) return responder(res, 422, { code: 422, error_code: 'weak_password', msg: 'Password should be at least 6 characters.' });
        const volver = url.searchParams.get('redirect_to');
        const yaEsta = cuentas.get(email);
        if (yaEsta && !confirmarMail) return responder(res, 422, { code: 422, error_code: 'user_already_exists', msg: 'User already registered' });
        if (yaEsta && yaEsta.confirmada !== false) {                // con confirmación prendida, Supabase no dice que la cuenta existe:
          return responder(res, 200, { id: randomUUID(), email, identities: [] });      // contesta con una de mentira y no manda nada
        }
        if (yaEsta) {                                                // todavía sin confirmar: se le manda el mail de nuevo
          mandarEnlace(yaEsta, 'signup', 'Confirmá tu cuenta', volver, req.headers.host);
          return responder(res, 200, { id: yaEsta.id, email, identities: [{ provider: 'email' }], confirmation_sent_at: new Date().toISOString() });
        }
        const nueva = await altaDeCuenta(email, clave);
        if (cuerpo.data && typeof cuerpo.data === 'object') nueva.datos = cuerpo.data;
        if (!confirmarMail) return responder(res, 200, sesionPara(nueva));
        nueva.confirmada = false;                                   // como Supabase con «Confirm email» prendido: sin sesión hasta abrir el enlace
        mandarEnlace(nueva, 'signup', 'Confirmá tu cuenta', volver, req.headers.host);
        return responder(res, 200, { id: nueva.id, email, identities: [{ provider: 'email' }], confirmation_sent_at: new Date().toISOString() });
      }
      if (url.pathname === '/auth/v1/token') {
        const tipo = url.searchParams.get('grant_type');
        if (tipo === 'password') {
          const cuenta = cuentas.get(String(cuerpo.email ?? '').trim().toLowerCase());
          const clave = String(cuerpo.password ?? '');
          if (!cuenta || !timingSafeEqual(huella(clave, cuenta.sal), cuenta.hash)) {
            return responder(res, 400, { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
          }
          if (cuenta.confirmada === false) return responder(res, 400, { code: 400, error_code: 'email_not_confirmed', msg: 'Email not confirmed' });
          return responder(res, 200, sesionPara(cuenta));
        }
        if (tipo === 'refresh_token') {
          const id = renovaciones.get(String(cuerpo.refresh_token ?? ''));
          const cuenta = id && [...cuentas.values()].find((x) => x.id === id);
          if (!cuenta) return responder(res, 400, { code: 400, error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token: Refresh Token Not Found' });
          renovaciones.delete(String(cuerpo.refresh_token));              // cada código de renovación se usa una sola vez
          return responder(res, 200, sesionPara(cuenta));
        }
        return responder(res, 400, { code: 400, error_code: 'invalid_request', msg: 'unsupported_grant_type' });
      }
      if (url.pathname === '/auth/v1/verify') {                      // canjear el código del enlace de un mail por la sesión
        if (!cuerpo.type) return responder(res, 400, { code: 400, error_code: 'validation_failed', msg: 'Verify requires a verification type' });
        if (!['email', 'signup', 'recovery', 'invite', 'magiclink', 'email_change'].includes(cuerpo.type)) return responder(res, 400, { code: 400, error_code: 'validation_failed', msg: 'Invalid email verification type' });
        const codigo = String(cuerpo.token_hash ?? ''), dato = enlaces.get(codigo);
        const coincide = dato && (dato.tipo === 'signup' ? ['email', 'signup'].includes(cuerpo.type) : dato.tipo === cuerpo.type);
        if (!coincide) return responder(res, 403, { code: 403, error_code: 'otp_expired', msg: 'Email link is invalid or has expired' });
        enlaces.delete(codigo);                                      // sirve una sola vez
        dato.cuenta.confirmada = true;
        return responder(res, 200, sesionPara(dato.cuenta));
      }
      if (url.pathname === '/auth/v1/resend') {                      // volver a mandar el mail de confirmación
        const cuenta = cuentas.get(String(cuerpo.email ?? '').trim().toLowerCase());
        if (cuerpo.type === 'signup' && cuenta && cuenta.confirmada === false) mandarEnlace(cuenta, 'signup', 'Confirmá tu cuenta', url.searchParams.get('redirect_to'), req.headers.host);
        return responder(res, 200, {});
      }
      if (url.pathname === '/auth/v1/recover') {                     // «olvidé mi contraseña»: contesta igual exista o no la cuenta
        const cuenta = cuentas.get(String(cuerpo.email ?? '').trim().toLowerCase());
        if (cuenta) mandarEnlace(cuenta, 'recovery', 'Elegí una contraseña nueva', url.searchParams.get('redirect_to'), req.headers.host);
        return responder(res, 200, {});
      }
      if (url.pathname === '/auth/v1/logout') {
        const datos = leerPase(pase);
        if (datos) for (const [codigo, id] of renovaciones) if (id === datos.sub) renovaciones.delete(codigo);
        res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
        return res.end();
      }
      const rpc = /^\/rest\/v1\/rpc\/([^/]+)$/.exec(url.pathname);
      if (rpc) {
        let rol = 'anon';
        let sub = null;
        if (pase !== CLAVE_PUBLICA) {
          const datos = leerPase(pase);
          if (!datos) return responder(res, 401, { code: 'PGRST301', message: 'JWSError JWSInvalidSignature' });
          if (datos.exp <= Math.floor(Date.now() / 1000)) return responder(res, 401, { code: 'PGRST301', message: 'JWT expired' });
          rol = 'authenticated';
          sub = datos.sub;
        }
        const [estado, salida] = await llamar(rpc[1], cuerpo ?? {}, rol, sub);
        return responder(res, estado, salida);
      }
      return responder(res, 404, { message: 'no existe' });
    } catch (e) {
      return responder(res, 500, { code: 'XX000', message: String(e?.message ?? e) });
    }
  });

  await new Promise((listo) => servidor.listen(puerto, '127.0.0.1', listo));
  const direccion = `http://localhost:${servidor.address().port}`;
  return {
    url: direccion,
    pg,
    /** Hace vencer ya mismo todos los pases emitidos de ahora en más (para probar la renovación). */
    set duracionPase(segundos) { duracionPase = segundos; },
    /** Prende o apaga «hay que confirmar el mail para entrar» (como la opción de Supabase). */
    set confirmarMail(valor) { confirmarMail = valor; },
    /** Los mails de registro que se «mandaron»: { para, asunto, enlace }. */
    mails,
    async cerrar() {
      await new Promise((listo) => servidor.close(listo));
      servidor.closeAllConnections?.();
      await pg.close();
    },
  };
}

// Corrido directo (node pruebas/servidor-local.mjs): queda prendido hasta que se lo corta con Ctrl + C
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const s = await crearServidor({ puerto: Number(process.env.PUERTO || 8092) });
  console.log(`Servidor de prueba listo en ${s.url}  (consultorio de ejemplo: ${CONSULTORIO.slug})`);
  console.log('Las cuentas y la clave de prueba están en pruebas/datos-de-ejemplo.mjs. Ctrl + C para apagarlo.');
}
