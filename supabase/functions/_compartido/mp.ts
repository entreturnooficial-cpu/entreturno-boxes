// Mercado Pago, lo justo que usa Entreturno Boxes:
//   - conectar la cuenta de un consultorio (la dueña la autoriza en Mercado Pago; acá se cambia el código por los pases),
//   - crear la orden de cobro (Checkout Pro por la API de Orders), leerla, cancelarla y devolver plata,
//   - comprobar que un aviso viene de verdad de Mercado Pago (la firma).
//
// Corre igual en Supabase (Deno) y en las pruebas (Node 24). No guarda nada ni decide nada: eso es de la base.
// Nunca pone un pase ni una clave en un mensaje de error.
//
// Leído en la documentación de Mercado Pago el 24/11/2026 (mercadopago.com.ar/developers):
//   Autorizar:  https://auth.mercadopago.com/authorization?client_id=…&response_type=code&platform_id=mp&state=…&redirect_uri=…
//               (con PKCE: &code_challenge=…&code_challenge_method=S256). El código dura 10 minutos.
//   Pases:      POST /oauth/token  { client_id, client_secret, grant_type, code | refresh_token, redirect_uri, code_verifier }
//               El pase dura 180 días; al renovarlo cambia también el de renovar. test_token: true da pases de prueba.
//   Orden:      POST /v1/orders (con X-Idempotency-Key) · GET /v1/orders/{id} · POST /v1/orders/{id}/cancel
//               POST /v1/orders/{id}/refund (sin cuerpo: todo; con { transactions: [{ id, amount }] }: una parte)
//   Aviso:      POST <nuestra dirección>?data.id=ORD…&type=order, con x-signature: ts=…,v1=… y x-request-id.
//               v1 = HMAC-SHA256(firma secreta, "id:<data.id>;request-id:<x-request-id>;ts:<ts>;") en hexadecimal.

// deno-lint-ignore no-explicit-any
type Json = any;

export const API_MP = "https://api.mercadopago.com";
export const AUTORIZAR_MP = "https://auth.mercadopago.com/authorization";

/** Algo que Mercado Pago no aceptó o no contestó. `definitivo`: dijo que no (repetir el mismo pedido no sirve). */
export class ErrorMp extends Error {
  codigo: string;
  estado: number;
  definitivo: boolean;
  constructor(codigo: string, estado: number, definitivo: boolean, mensaje = "") {
    super(mensaje || codigo);
    this.name = "ErrorMp";
    this.codigo = codigo;
    this.estado = estado;
    this.definitivo = definitivo;
  }
}

const letras = new TextEncoder();
const aBase64Url = (bytes: Uint8Array) => {
  let t = "";
  for (const b of bytes) t += String.fromCharCode(b);
  return btoa(t).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const aHex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** Un texto al azar, sin caracteres raros (32 bytes dan 43 caracteres). */
export function aleatorio(bytes = 32): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return aBase64Url(b);
}

/** El «desafío» de PKCE: SHA-256 del verificador, en base64 para direcciones. */
export async function desafioDe(verificador: string): Promise<string> {
  return aBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", letras.encode(verificador))));
}

function igualesSinApuro(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let distinto = 0;
  for (let i = 0; i < a.length; i++) distinto |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return distinto === 0;
}

/**
 * ¿El aviso lo mandó Mercado Pago? Recalcula la firma con la «firma secreta» de la aplicación.
 * El número de la orden viene en mayúsculas («ORD01…»): se prueba tal cual y en minúsculas, porque la documentación
 * no dice con cuál firma (hace falta la firma secreta en los dos casos, así que no se pierde nada).
 *
 * OJO: la firma cubre el número (data.id), el número de pedido y el momento. NO cubre el tipo de aviso ni el cuerpo:
 * a eso no se le cree nunca (ver avisoDeMp en cobros.ts).
 * Con `maxAntiguedadSeg`, un aviso firmado hace más de ese tiempo (o con fecha del futuro) no vale: así una firma vieja
 * que alguien haya copiado no sirve para siempre.
 */
export async function firmaValida(p: {
  firma: string | null; pedido: string | null; dato: string | null; secreto: string; ahora?: number; maxAntiguedadSeg?: number;
}): Promise<boolean> {
  if (!p.firma || !p.secreto) return false;
  let ts = "";
  let v1 = "";
  for (const parte of p.firma.split(",")) {
    const i = parte.indexOf("=");
    if (i < 0) continue;
    const clave = parte.slice(0, i).trim().toLowerCase();
    const valor = parte.slice(i + 1).trim();
    if (clave === "ts") ts = valor;
    else if (clave === "v1") v1 = valor.toLowerCase();
  }
  if (!/^\d{1,20}$/.test(ts) || !/^[0-9a-f]{64}$/.test(v1)) return false;
  const llave = await crypto.subtle.importKey("raw", letras.encode(p.secreto), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const dato = (p.dato ?? "").trim();
  const pedido = (p.pedido ?? "").trim();
  const candidatos = dato ? [...new Set([dato, dato.toLowerCase()])] : [""];
  let vale = false;
  for (const d of candidatos) {
    const manifiesto = [d ? `id:${d}` : "", pedido ? `request-id:${pedido}` : "", `ts:${ts}`].filter(Boolean).join(";") + ";";
    const calculada = aHex(new Uint8Array(await crypto.subtle.sign("HMAC", llave, letras.encode(manifiesto))));
    if (igualesSinApuro(calculada, v1)) vale = true;       // sin cortar antes: tarda lo mismo acierte o no
  }
  if (vale && p.maxAntiguedadSeg !== undefined) {
    // el momento viene en segundos (10 cifras) o en milésimas (13): se lleva a milésimas según cuántas cifras trae
    const momento = Number(ts) * 10 ** (13 - ts.length);
    const hace = (p.ahora ?? Date.now()) - momento;
    if (!Number.isFinite(momento) || hace > p.maxAntiguedadSeg * 1000 || hace < -3600 * 1000) return false;
  }
  return vale;
}

/** ¿Es una dirección de Mercado Pago? Solo ahí se manda a la gente a pagar (en las pruebas, también al servidor local). */
export function esDireccionDePago(direccion: string, permitirLocal = false): boolean {
  let u: URL;
  try {
    u = new URL(direccion);
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  if (permitirLocal && u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1")) return true;
  if (u.protocol !== "https:" || u.port) return false;
  return ["mercadopago.com.ar", "mercadopago.com"].some((d) => u.hostname === d || u.hostname.endsWith(`.${d}`));
}

type Pedido = { acceso?: string; cuerpo?: unknown; clave?: string; fetchFn?: typeof fetch; ms?: number };

const limpio = (v: unknown, largo: number) => String(v ?? "").replace(/[^\w .,:;()\/\-áéíóúñÁÉÍÓÚÑ]/g, " ").replace(/\s+/g, " ").trim().slice(0, largo);

async function pedir(metodo: string, ruta: string, o: Pedido): Promise<Json> {
  const pedirWeb = o.fetchFn ?? fetch;
  const corte = new AbortController();
  const reloj = setTimeout(() => corte.abort(), o.ms ?? 12000);
  let r: Response;
  let texto: string;
  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (o.acceso) headers.Authorization = `Bearer ${o.acceso}`;
    if (o.clave) headers["X-Idempotency-Key"] = o.clave.slice(0, 128);
    let body: string | undefined;
    if (o.cuerpo !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(o.cuerpo);
    }
    r = await pedirWeb(API_MP + ruta, { method: metodo, headers, body, signal: corte.signal });
    texto = (await r.text()).slice(0, 400000);
  } catch {
    throw new ErrorMp("sin_respuesta", 0, false, "Mercado Pago no contestó");
  } finally {
    clearTimeout(reloj);
  }
  let j: Json = null;
  try {
    j = texto ? JSON.parse(texto) : null;
  } catch {
    j = null;
  }
  if (!r.ok) {
    const primero = Array.isArray(j?.errors) ? j.errors[0] : null;
    const codigo = limpio(primero?.code ?? j?.error ?? j?.code ?? j?.message ?? `http_${r.status}`, 80) || `http_${r.status}`;
    const detalle = limpio([primero?.message, Array.isArray(primero?.details) ? primero.details.join(" ") : "", j?.message, j?.error_description]
      .filter(Boolean).join(" · "), 200);
    // 408, 423 (clave ocupada), 425 y 429 (demasiados pedidos) y los 5xx se pueden repetir tal cual
    const definitivo = r.status >= 400 && r.status < 500 && ![408, 423, 425, 429].includes(r.status);
    throw new ErrorMp(codigo, r.status, definitivo, detalle);
  }
  if (j === null || typeof j !== "object") throw new ErrorMp("respuesta_rara", r.status, false, "Mercado Pago contestó algo que no se entiende");
  return j;
}

// ---------------------------------------------------------------------------------------------------
// Conectar una cuenta
// ---------------------------------------------------------------------------------------------------

/** La dirección de Mercado Pago donde la dueña autoriza a la aplicación. */
export function urlAutorizar(p: { clientId: string; estado: string; redirectUri: string; desafio: string }): string {
  const q = new URLSearchParams({
    client_id: p.clientId, response_type: "code", platform_id: "mp", state: p.estado, redirect_uri: p.redirectUri,
    code_challenge: p.desafio, code_challenge_method: "S256",
  });
  return `${AUTORIZAR_MP}?${q}`;
}

export type Pases = { acceso: string; renovar: string; segundos: number; usuario: string; real: boolean | null };

function pasesDe(j: Json): Pases {
  const segundos = Number(j?.expires_in);
  const usuario = String(j?.user_id ?? "");
  if (typeof j?.access_token !== "string" || !j.access_token || !(segundos > 0) || !/^\d{1,20}$/.test(usuario)) {
    throw new ErrorMp("respuesta_rara", 200, false, "Mercado Pago no devolvió los pases");
  }
  return {
    acceso: j.access_token, renovar: typeof j.refresh_token === "string" ? j.refresh_token : "", segundos: Math.floor(segundos), usuario,
    real: typeof j.live_mode === "boolean" ? j.live_mode : null,
  };
}

/** Cambia el código que volvió de Mercado Pago por los pases de esa cuenta. */
export async function canjearCodigo(p: {
  clientId: string; clientSecret: string; codigo: string; redirectUri: string; verificador: string; prueba: boolean; fetchFn?: typeof fetch;
}): Promise<Pases> {
  const cuerpo: Record<string, unknown> = {
    client_id: p.clientId, client_secret: p.clientSecret, grant_type: "authorization_code", code: p.codigo,
    redirect_uri: p.redirectUri, code_verifier: p.verificador,
  };
  if (p.prueba) cuerpo.test_token = true;
  return pasesDe(await pedir("POST", "/oauth/token", { cuerpo, fetchFn: p.fetchFn }));
}

/** Pide pases nuevos con el pase de renovar (sin que la dueña haga nada). */
export async function renovarPase(p: { clientId: string; clientSecret: string; renovar: string; fetchFn?: typeof fetch }): Promise<Pases> {
  const cuerpo = { client_id: p.clientId, client_secret: p.clientSecret, grant_type: "refresh_token", refresh_token: p.renovar };
  return pasesDe(await pedir("POST", "/oauth/token", { cuerpo, fetchFn: p.fetchFn }));
}

/** De quién es ese pase (para mostrarle a la dueña qué cuenta conectó). */
export async function quienSoy(acceso: string, fetchFn?: typeof fetch): Promise<{ usuario: string; nombre: string; email: string; pais: string }> {
  const j = await pedir("GET", "/users/me", { acceso, fetchFn });
  const persona = [j?.first_name, j?.last_name].filter((x: unknown) => typeof x === "string" && x).join(" ");
  return {
    usuario: String(j?.id ?? ""), nombre: limpio(persona || j?.nickname || "", 120),
    email: typeof j?.email === "string" && /^[^\s@]{1,100}@[^\s@]{1,150}$/.test(j.email) ? j.email : "", pais: limpio(j?.site_id, 6),
  };
}

// ---------------------------------------------------------------------------------------------------
// Órdenes
// ---------------------------------------------------------------------------------------------------

export type Orden = {
  id: string;
  /** created, processing, processed, action_required, failed, canceled, refunded… */
  estado: string;
  detalle: string;
  /** nuestra referencia: el número de nuestro pago */
  referencia: string;
  /** la cuenta de Mercado Pago que cobra */
  usuario: string;
  moneda: string;
  total: number;
  pagado: number;
  /** el pago adentro de la orden (lo que se usa para devolver una parte) */
  transaccion: string;
  /** lo ya devuelto de ese pago */
  devuelto: number;
  /** dónde se paga */
  enlace: string;
  /** la última devolución anotada en la orden */
  devolucion: string;
  /** al crearla: Mercado Pago no aceptó el plazo en minutos y quedó sin vencimiento propio (la cierra el reloj) */
  sinVencimiento?: boolean;
};

const numero = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export function resumenDe(j: Json): Orden {
  const pagos: Json[] = Array.isArray(j?.transactions?.payments) ? j.transactions.payments : [];
  const devoluciones: Json[] = Array.isArray(j?.transactions?.refunds) ? j.transactions.refunds : [];
  const principal = pagos.find((x) => x?.status === "processed" || x?.status === "refunded") ?? pagos[0] ?? null;
  const id = String(j?.id ?? "");
  if (!/^[A-Za-z0-9_-]{6,80}$/.test(id)) throw new ErrorMp("respuesta_rara", 200, false, "Mercado Pago no devolvió el número de la orden");
  const transaccion = principal ? String(principal.id ?? "") : "";
  const devueltoPorLista = devoluciones.filter((d) => !transaccion || String(d?.transaction_id ?? transaccion) === transaccion)
    .reduce((a, d) => a + numero(d?.amount), 0);
  return {
    id, estado: limpio(j?.status, 40), detalle: limpio(j?.status_detail, 80), referencia: String(j?.external_reference ?? ""),
    usuario: String(j?.user_id ?? ""), moneda: limpio(j?.currency, 6), total: numero(j?.total_amount), pagado: numero(j?.total_paid_amount),
    transaccion, devuelto: Math.max(numero(principal?.refunded_amount), devueltoPorLista),
    enlace: typeof j?.checkout_url === "string" ? j.checkout_url : "",
    devolucion: devoluciones.length ? String(devoluciones[devoluciones.length - 1]?.id ?? "") : "",
  };
}

/** Lo que se le manda a Mercado Pago para cobrar. Sale siempre igual para el mismo intento de pago. */
export function cuerpoDeOrden(p: {
  monto: number; referencia: string; titulo: string; descripcion: string; email: string | null; minutos: number; volverA: string;
}): Json {
  const importe = p.monto.toFixed(2);
  return {
    type: "online",
    processing_mode: "manual",
    capture_mode: "automatic",                  // aprobado o rechazado en el momento, sin quedar «pendiente»
    total_amount: importe,
    external_reference: p.referencia,
    description: p.descripcion,
    expiration_time: `PT${Math.max(1, Math.floor(p.minutos))}M`,
    ...(p.email ? { payer: { email: p.email } } : {}),
    items: [{ title: p.titulo, quantity: 1, unit_price: importe }],
    config: {
      online: {
        success_url: `${p.volverA}?mp=ok`, failure_url: `${p.volverA}?mp=no`, pending_url: `${p.volverA}?mp=espera`, auto_return: "all",
      },
      // sin efectivo ni cajero: tardan días y el turno se guarda unos minutos
      payment_method: { not_allowed_types: ["ticket", "atm"] },
    },
  };
}

/** Crea la orden. Con la misma clave y el mismo cuerpo, Mercado Pago devuelve la misma orden (no crea dos). */
export async function crearOrden(p: { acceso: string; clave: string; cuerpo: Json; fetchFn?: typeof fetch }): Promise<Orden> {
  try {
    return resumenDe(await pedir("POST", "/v1/orders", { acceso: p.acceso, clave: p.clave, cuerpo: p.cuerpo, fetchFn: p.fetchFn }));
  } catch (e) {
    // si lo único que no le gustó es el vencimiento en minutos, se crea sin vencimiento (igual la cerramos nosotros)
    if (e instanceof ErrorMp && e.estado === 400 && /expiration/i.test(`${e.codigo} ${e.message}`) && p.cuerpo?.expiration_time) {
      const { expiration_time: _fuera, ...resto } = p.cuerpo;
      const orden = resumenDe(await pedir("POST", "/v1/orders", { acceso: p.acceso, clave: `${p.clave}-sv`, cuerpo: resto, fetchFn: p.fetchFn }));
      return { ...orden, sinVencimiento: true };
    }
    throw e;
  }
}

const ruta = (orden: string, cola = "") => `/v1/orders/${encodeURIComponent(orden)}${cola}`;

export async function leerOrden(p: { acceso: string; orden: string; fetchFn?: typeof fetch }): Promise<Orden> {
  return resumenDe(await pedir("GET", ruta(p.orden), { acceso: p.acceso, fetchFn: p.fetchFn }));
}

/** Cierra una orden que todavía no se pagó, para que nadie la pague tarde. */
export async function cancelarOrden(p: { acceso: string; orden: string; fetchFn?: typeof fetch }): Promise<Orden> {
  return resumenDe(await pedir("POST", ruta(p.orden, "/cancel"), { acceso: p.acceso, clave: `cerrar-${p.orden}`, fetchFn: p.fetchFn }));
}

/** Devuelve plata de una orden: entera (sin transacción ni monto) o una parte de un pago. */
export async function devolverOrden(p: {
  acceso: string; orden: string; clave: string; transaccion?: string; monto?: number; fetchFn?: typeof fetch;
}): Promise<Orden> {
  const parte = p.transaccion && p.monto ? { transactions: [{ id: p.transaccion, amount: p.monto.toFixed(2) }] } : undefined;
  return resumenDe(await pedir("POST", ruta(p.orden, "/refund"), { acceso: p.acceso, clave: p.clave, cuerpo: parte, fetchFn: p.fetchFn }));
}
