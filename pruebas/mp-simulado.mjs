// Mercado Pago de mentira, para las pruebas y para el servidor local: contesta los pedidos que arma
// supabase/functions/_compartido/mp.ts (pases, órdenes, devoluciones) con la forma que describe la documentación de
// Mercado Pago (leída el 24/11/2026) y guarda todo en memoria. No mueve plata ni sale a internet.
//
// Para las pruebas:
//   mp.cuenta('111', { nombre, email })                  crea una cuenta de vendedora
//   mp.autorizar('111', { desafio, redirectUri })        la dueña autoriza a la aplicación: devuelve el código que vuelve
//   mp.pagar(orden, 'aprobado' | 'rechazado' | 'vencer') lo que haría la profesional en la pantalla de Mercado Pago;
//                                                        devuelve el aviso firmado que mandaría Mercado Pago
//   mp.fallar('crear', 'cortar')                         el próximo pedido de ese tipo no llega
//   mp.fallar('crear', 'procesar-y-cortar')              llega y se procesa, pero la respuesta se pierde
//   mp.fallar('devolver', 'estado', { status: 400, cuerpo: {…} })   contesta eso
//   mp.fallar('crear', 'sin-minutos')                    no acepta el vencimiento en minutos
// Tipos de pedido: pases, quien, crear, leer, cancelar, devolver.
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';

const json = (estado, cuerpo) => new Response(JSON.stringify(cuerpo), { status: estado, headers: { 'Content-Type': 'application/json' } });
const errorDeOrden = (estado, codigo, mensaje) => json(estado, { errors: [{ code: codigo, message: mensaje }] });
const plata = (n) => Number(n).toFixed(2);
const idLargo = (prefijo) => prefijo + randomBytes(13).toString('hex').toUpperCase();

export function crearMpSimulado({
  clientId = '8772548647196351', clientSecret = 'secreto-de-la-aplicacion', secretoAvisos = 'firma-secreta-de-los-avisos',
  paginaDePago = 'https://www.mercadopago.com.ar/checkout/v1/redirect',
} = {}) {
  const cuentas = new Map();      // número de cuenta → { usuario, nombre, email, acceso, renovar, sinSaldo, real }
  const codigos = new Map();      // código → { usuario, desafio, redirectUri }
  const ordenes = new Map();      // número de orden → la orden
  const claves = new Map();       // clave de idempotencia → { huella, estado, cuerpo }
  const pedidos = [];             // { que, metodo, ruta, clave, cuerpo }
  const fallas = [];
  let pagina = paginaDePago;      // a dónde manda el checkout_url (el servidor local lo apunta a su pantalla de pago simulada)

  const porAcceso = (acceso) => [...cuentas.values()].find((c) => c.acceso === acceso) ?? null;
  const porRenovar = (renovar) => [...cuentas.values()].find((c) => c.renovar === renovar) ?? null;
  const pasesNuevos = (c) => {
    c.acceso = `APP_USR-${randomBytes(12).toString('hex')}-${c.usuario}`;
    c.renovar = `TG-${randomBytes(12).toString('hex')}-${c.usuario}`;
  };
  function cuenta(usuario, { nombre = 'Vendedora De Prueba', email = `cuenta${usuario}@mp.prueba`, real = true } = {}) {
    if (!cuentas.has(usuario)) {
      const c = { usuario: String(usuario), nombre, email, real, sinSaldo: false, acceso: '', renovar: '' };
      pasesNuevos(c);
      cuentas.set(String(usuario), c);
    }
    return cuentas.get(String(usuario));
  }
  /** El pase de prueba de la aplicación (la cuenta de Entreturno, en modo prueba). */
  const dePrueba = cuenta('900900900', { nombre: 'Entreturno Prueba', real: false });

  const firmar = (dato, pedido, ts = Date.now()) => {
    const manifiesto = [dato ? `id:${dato}` : '', pedido ? `request-id:${pedido}` : '', `ts:${ts}`].filter(Boolean).join(';') + ';';
    return `ts=${ts},v1=${createHmac('sha256', secretoAvisos).update(manifiesto).digest('hex')}`;
  };

  /** El aviso que Mercado Pago mandaría por una orden, con su firma. */
  function aviso(id, accion) {
    const o = ordenes.get(id);
    const pedido = randomUUID();
    return {
      tipo: 'order', dato: id, pedido, firma: firmar(id, pedido),
      cuerpo: {
        action: accion ?? `order.${o.status}`, api_version: 'v1', application_id: clientId, date_created: new Date().toISOString(),
        live_mode: cuentas.get(o.user_id)?.real ?? true, type: 'order', user_id: o.user_id,
        data: { id, external_reference: o.external_reference, status: o.status, status_detail: o.status_detail,
          total_amount: o.total_amount, total_paid_amount: o.total_paid_amount, type: 'online' },
      },
    };
  }

  /** Lo que haría la profesional en la pantalla de Mercado Pago. Devuelve el aviso que le sigue. */
  function pagar(id, que = 'aprobado', { monto } = {}) {
    const o = ordenes.get(id);
    if (!o) throw new Error(`no existe la orden ${id}`);
    if (o.status !== 'created') throw new Error(`la orden ${id} ya está ${o.status}`);
    if (que === 'vencer') {
      Object.assign(o, { status: 'canceled', status_detail: 'canceled' });
    } else if (que === 'rechazado') {
      Object.assign(o, { status: 'failed', status_detail: 'rejected_by_issuer' });
      o.transactions.payments = [{ id: idLargo('PAY'), status: 'failed', status_detail: 'rejected_by_issuer', amount: o.total_amount,
        paid_amount: '0.00', refunded_amount: '0.00', payment_method: { id: 'master', type: 'credit_card', installments: 1 } }];
    } else {
      const pagado = plata(monto ?? o.total_amount);
      Object.assign(o, { status: 'processed', status_detail: 'accredited', total_paid_amount: pagado });
      o.transactions.payments = [{ id: idLargo('PAY'), status: 'processed', status_detail: 'accredited', amount: o.total_amount,
        paid_amount: pagado, refunded_amount: '0.00', payment_method: { id: 'master', type: 'credit_card', installments: 1 } }];
    }
    o.last_updated_date = new Date().toISOString();
    return aviso(id);
  }

  function crearOrden(c, cuerpo, falla) {
    if (cuerpo?.type !== 'online' || cuerpo?.processing_mode !== 'manual') return errorDeOrden(400, 'property_value', 'type o processing_mode inválido');
    if (typeof cuerpo.total_amount !== 'string' || !/^\d+(\.\d{2})?$/.test(cuerpo.total_amount)) return errorDeOrden(400, 'property_type', 'total_amount tiene que ser un texto con dos decimales o ninguno');
    if (Number(cuerpo.total_amount) <= 0) return errorDeOrden(400, 'invalid_total_amount', 'El monto total de la order no puede ser cero');
    const suma = (cuerpo.items ?? []).reduce((a, i) => a + Number(i.unit_price) * Number(i.quantity), 0);
    if (cuerpo.items && Math.abs(suma - Number(cuerpo.total_amount)) > 0.001) return errorDeOrden(400, 'order_items_total_amount_mismatch', 'total_amount no coincide con los ítems');
    if (cuerpo.external_reference && !/^[A-Za-z0-9_-]{1,64}$/.test(cuerpo.external_reference)) return errorDeOrden(400, 'property_value', 'external_reference inválida');
    if (cuerpo.expiration_time !== undefined) {
      if (falla?.tipo === 'sin-minutos' && /^PT\d+M$/.test(cuerpo.expiration_time)) return errorDeOrden(400, 'property_value', 'expiration_time: valor no soportado');
      if (!/^P(\d+D|T\d+[HM])$/.test(cuerpo.expiration_time)) return errorDeOrden(400, 'property_value', 'expiration_time: formato inválido');
    }
    if (cuerpo.payer && !/^[^\s@]+@[^\s@]+$/.test(cuerpo.payer.email ?? '')) return errorDeOrden(400, 'required_properties', 'payer.email es obligatorio');
    const id = idLargo('ORD');
    const ahora = new Date().toISOString();
    const o = {
      id, type: 'online', processing_mode: 'manual', status: 'created', status_detail: 'created',
      capture_mode: cuerpo.capture_mode ?? 'automatic_async', external_reference: cuerpo.external_reference ?? '',
      description: cuerpo.description ?? '', total_amount: plata(cuerpo.total_amount), total_paid_amount: '0.00',
      checkout_url: `${pagina}?order_id=${id}`, client_token: 'eyJhbGciOiJSUzI1NiIs...',
      expiration_time: cuerpo.expiration_time ?? 'P1D', country_code: 'ARG', user_id: c.usuario, currency: 'ARS',
      created_date: ahora, last_updated_date: ahora, integration_data: { application_id: clientId },
      config: { online: { ...(cuerpo.config?.online ?? {}), retries: { allowed: false } }, payment_method: cuerpo.config?.payment_method ?? {} },
      items: cuerpo.items ?? [], payer: cuerpo.payer ?? null, transactions: { payments: [], refunds: [] },
    };
    ordenes.set(id, o);
    return json(201, o);
  }

  function devolverOrden(c, o, cuerpo) {
    const pago = o.transactions.payments.find((p) => p.status === 'processed' || p.status === 'refunded');
    if (!pago || !['processed', 'refunded'].includes(o.status)) return errorDeOrden(400, 'cannot_refund_order', 'La order no tiene un pago acreditado');
    const queda = Number(pago.paid_amount) - Number(pago.refunded_amount);
    let monto = queda;
    if (cuerpo?.transactions?.length) {
      const t = cuerpo.transactions[0];
      if (t.id !== pago.id) return errorDeOrden(400, 'transaction_not_found', 'La transacción no es de esta order');
      if (typeof t.amount !== 'string' || !/^\d+(\.\d{2})?$/.test(t.amount)) return errorDeOrden(400, 'property_type', 'amount tiene que ser un texto');
      monto = Number(t.amount);
    }
    if (monto <= 0 || monto > queda + 0.001) return errorDeOrden(400, 'refund_amount_exceeded', 'El monto supera lo que queda por devolver');
    if (c.sinSaldo) return errorDeOrden(400, 'insufficient_money', 'No hay saldo disponible en la cuenta para devolver');
    pago.refunded_amount = plata(Number(pago.refunded_amount) + monto);
    o.transactions.refunds.push({ id: idLargo('REF'), transaction_id: pago.id, amount: plata(monto), status: 'processed' });
    const todo = Number(pago.refunded_amount) >= Number(pago.paid_amount) - 0.001;
    if (todo) pago.status = 'refunded';
    Object.assign(o, todo ? { status: 'refunded', status_detail: 'refunded' } : { status: 'processed', status_detail: 'partially_refunded' });
    o.last_updated_date = new Date().toISOString();
    return json(201, o);
  }

  async function atender(metodo, ruta, { acceso, clave, cuerpo }) {
    const partes = ruta.split('?')[0].split('/').filter(Boolean);
    const que = ruta.startsWith('/oauth/token') ? 'pases' : ruta.startsWith('/users/me') ? 'quien'
      : partes[0] === 'v1' && partes[1] === 'orders' && partes.length === 2 ? 'crear'
        : partes[3] === 'cancel' ? 'cancelar' : partes[3] === 'refund' ? 'devolver' : 'leer';
    pedidos.push({ que, metodo, ruta, clave: clave ?? null, cuerpo: cuerpo ?? null });
    const i = fallas.findIndex((f) => f.que === que);
    const falla = i >= 0 ? fallas.splice(i, 1)[0] : null;
    if (falla?.tipo === 'cortar') throw new TypeError('fetch failed (falla pedida a propósito)');
    if (falla?.tipo === 'estado') return json(falla.datos.status, falla.datos.cuerpo ?? {});

    let respuesta;
    if (que === 'pases') {
      if (cuerpo?.client_id !== clientId || cuerpo?.client_secret !== clientSecret) {
        respuesta = json(400, { message: 'invalid client_id or client_secret', error: 'invalid_client', status: 400, cause: [] });
      } else if (cuerpo.grant_type === 'authorization_code') {
        const dato = codigos.get(cuerpo.code);
        const desafio = createHash('sha256').update(String(cuerpo.code_verifier ?? '')).digest('base64url');
        if (!dato || dato.redirectUri !== cuerpo.redirect_uri || dato.desafio !== desafio) {
          respuesta = json(400, { message: 'Error validating grant. Your authorization code or refresh token may be expired or it was already used', error: 'invalid_grant', status: 400, cause: [] });
        } else {
          codigos.delete(cuerpo.code);                    // sirve una sola vez
          const c = cuentas.get(dato.usuario);
          pasesNuevos(c);
          c.revocada = false;                             // volvió a autorizar: la aplicación tiene permiso de nuevo
          c.real = cuerpo.test_token !== true;
          respuesta = json(200, { access_token: c.acceso, token_type: 'bearer', expires_in: 15552000, scope: 'offline_access read write',
            user_id: Number(c.usuario), refresh_token: c.renovar, public_key: 'APP_USR-publica', live_mode: c.real });
        }
      } else if (cuerpo.grant_type === 'refresh_token') {
        const c = porRenovar(cuerpo.refresh_token);
        if (!c || c.revocada) {
          respuesta = json(400, { message: 'invalid refresh token', error: 'invalid_grant', status: 400, cause: [] });
        } else {
          pasesNuevos(c);
          respuesta = json(200, { access_token: c.acceso, token_type: 'bearer', expires_in: 15552000, scope: 'offline_access read write',
            user_id: Number(c.usuario), refresh_token: c.renovar, public_key: 'APP_USR-publica', live_mode: c.real });
        }
      } else {
        respuesta = json(400, { message: 'unsupported grant_type', error: 'unsupported_grant_type', status: 400, cause: [] });
      }
    } else {
      const c = porAcceso(acceso);
      if (!c || c.revocada) {
        respuesta = errorDeOrden(401, 'invalid_credentials', 'El valor enviado como Access Token es incorrecto');
      } else if (que === 'quien') {
        const [nombre, ...resto] = c.nombre.split(' ');
        respuesta = json(200, { id: Number(c.usuario), nickname: c.nombre.toUpperCase().replace(/\s+/g, ''), email: c.email,
          first_name: nombre, last_name: resto.join(' '), site_id: c.pais ?? 'MLA' });
      } else if (que === 'crear') {
        if (!clave) respuesta = errorDeOrden(400, 'empty_required_header', 'El header X-Idempotency-Key es requerido');
        else {
          const huella = JSON.stringify(cuerpo);
          const antes = claves.get(`${c.usuario}:${clave}`);
          if (antes && antes.huella !== huella) respuesta = errorDeOrden(409, 'idempotency_key_already_used', 'La clave de idempotencia ya fue utilizada');
          else if (antes) respuesta = json(antes.estado, ordenes.get(antes.orden) ?? antes.cuerpo);
          else {
            respuesta = crearOrden(c, cuerpo, falla);
            if (respuesta.status === 201) claves.set(`${c.usuario}:${clave}`, { huella, estado: 201, orden: (await respuesta.clone().json()).id });
          }
        }
      } else {
        const o = ordenes.get(decodeURIComponent(partes[2] ?? ''));
        if (!o || o.user_id !== c.usuario) respuesta = errorDeOrden(404, 'order_not_found', 'La order no existe');
        else if (que === 'leer') respuesta = json(200, o);
        else if (que === 'cancelar') {
          if (o.status === 'created') {
            Object.assign(o, { status: 'canceled', status_detail: 'canceled', last_updated_date: new Date().toISOString() });
            respuesta = json(200, o);
          } else respuesta = errorDeOrden(409, 'cannot_cancel_order', `La order está ${o.status} y no se puede cancelar`);
        } else {
          const llave = `${c.usuario}:dev:${clave}`;
          if (clave && claves.has(llave)) respuesta = json(201, o);        // el mismo pedido otra vez: no devuelve de nuevo
          else {
            respuesta = devolverOrden(c, o, cuerpo);
            if (clave && respuesta.status === 201) claves.set(llave, true);
          }
        }
      }
    }
    if (falla?.tipo === 'procesar-y-cortar') throw new TypeError('fetch failed (la respuesta se perdió, a propósito)');
    return respuesta;
  }

  return {
    clientId, clientSecret, secretoAvisos, paseDePrueba: dePrueba.acceso,
    cuentas, ordenes, pedidos, cuenta, pagar, aviso, firmar,
    set paginaDePago(valor) { pagina = valor; },
    /** La dueña entra a Mercado Pago y autoriza a la aplicación: devuelve el código con el que vuelve. */
    autorizar(usuario, { desafio, redirectUri }) {
      cuenta(usuario);
      const codigo = `TG-${randomBytes(16).toString('hex')}`;
      codigos.set(codigo, { usuario: String(usuario), desafio, redirectUri });
      return codigo;
    },
    /** La dueña le quita el permiso a la aplicación (o cambia la contraseña): los pases dejan de servir. */
    revocar(usuario, { tambienRenovar = true } = {}) {
      const c = cuentas.get(String(usuario));
      if (tambienRenovar) c.revocada = true;
      else c.acceso = `APP_USR-vencido-${randomBytes(6).toString('hex')}`;      // solo se venció el pase: renovarlo anda
    },
    fallar(que, tipo, datos) {
      fallas.push({ que, tipo, datos });
    },
    cuantos: (que) => pedidos.filter((p) => p.que === que).length,
    /** Los pedidos, como los hace mp.ts (fetch). */
    async fetchFn(url, init = {}) {
      const u = new URL(String(url));
      const cabeceras = new Headers(init.headers ?? {});
      let cuerpo;
      try {
        cuerpo = init.body ? JSON.parse(init.body) : undefined;
      } catch {
        return json(400, { errors: [{ code: 'json_syntax_error', message: 'JSON inválido' }] });
      }
      const acceso = (cabeceras.get('authorization') ?? '').replace(/^Bearer /, '');
      return atender((init.method ?? 'GET').toUpperCase(), u.pathname + u.search, { acceso, clave: cabeceras.get('x-idempotency-key'), cuerpo });
    },
  };
}
