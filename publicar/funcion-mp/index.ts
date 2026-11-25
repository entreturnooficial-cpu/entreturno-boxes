// ARMADO con publicar/armar_funcion.mjs: no editar acá, editar los originales en supabase/functions.
// ============ _compartido/mp.ts ============
// Mercado Pago, lo justo que usa Entreturno Boxes:
//   - conectar la cuenta de un consultorio (la dueña la autoriza en Mercado Pago; acá se cambia el código por los pases),
//   - crear la orden de cobro (Checkout Pro por la API de Orders), leerla, cancelarla y devolver plata,
//   - comprobar que un aviso viene de verdad de Mercado Pago (la firma).
//
// Corre igual en Supabase (Deno) y en las pruebas (Node 24). No guarda nada ni decide nada: eso es de la base.
// Nunca pone un pase ni una clave en un mensaje de error.
//
// Leído en la documentación de Mercado Pago el 24/11/2026 (mercadopago.com.ar/developers):
//   Autorizar:  https://auth.mercadopago.com.ar/authorization?client_id=…&response_type=code&platform_id=mp&state=…&redirect_uri=…
//               (con PKCE: &code_challenge=…&code_challenge_method=S256). El código dura 10 minutos.
//   Pases:      POST /oauth/token  { client_id, client_secret, grant_type, code | refresh_token, redirect_uri, code_verifier }
//               El pase dura 180 días; al renovarlo cambia también el de renovar. test_token: true da pases de prueba, que NO sirven
//               para /v1/orders (visto el 25/11/2026: los rechaza, y el pase renovado con refresh_token viene REAL).
//   Orden:      (las de prueba se numeran ORDTST…; las de verdad, ORD01…)
//               POST /v1/orders (con X-Idempotency-Key) · GET /v1/orders/{id} · POST /v1/orders/{id}/cancel
//               POST /v1/orders/{id}/refund (sin cuerpo: todo; con { transactions: [{ id, amount }] }: una parte)
//   Aviso:      POST <nuestra dirección>?data.id=ORD…&type=order, con x-signature: ts=…,v1=… y x-request-id.
//               v1 = HMAC-SHA256(firma secreta, "id:<data.id>;request-id:<x-request-id>;ts:<ts>;") en hexadecimal.

// deno-lint-ignore no-explicit-any
type Json = any;

export const API_MP = "https://api.mercadopago.com";
// La de Argentina: con auth.mercadopago.com (sin país) aparece antes una pantalla que pide elegir el país (visto el 25/11/2026).
export const AUTORIZAR_MP = "https://auth.mercadopago.com.ar/authorization";

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

/** `real`: si el pase cobra de verdad (true), si es de prueba (false) o si Mercado Pago no lo dijo (null). */
export type Pases = { acceso: string; renovar: string; segundos: number; usuario: string; real: boolean | null };

function pasesDe(j: Json): Pases {
  const segundos = Number(j?.expires_in);
  const usuario = String(j?.user_id ?? "");
  if (typeof j?.access_token !== "string" || !j.access_token || !(segundos > 0) || !/^\d{1,20}$/.test(usuario)) {
    throw new ErrorMp("respuesta_rara", 200, false, "Mercado Pago no devolvió los pases");
  }
  return {
    acceso: j.access_token, renovar: typeof j.refresh_token === "string" ? j.refresh_token : "", segundos: Math.floor(segundos), usuario,
    real: typeof j.live_mode === "boolean" ? j.live_mode : j.access_token.startsWith("TEST-") ? false : null,
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

/** ¿Esa orden es de prueba? Mercado Pago numera ORDTST… las de prueba. */
export const esOrdenDePrueba = (id: string) => id.startsWith("ORDTST");

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

// ============ _compartido/cobros.ts ============
// Lo que hace la función de Supabase «mp»: conectar la cuenta de un consultorio, cobrar una reserva, atender los
// avisos de Mercado Pago y hacer las devoluciones.
//
// Corre igual en Supabase (Deno) y en las pruebas (Node 24): todo lo de afuera (la base, la red, los secretos) llega
// en `dep`. Acá no se decide nada de plata: la base dice cuánto se cobra, qué se confirma y qué se devuelve
// (supabase/migrations/…_mercadopago.sql). Esto solo habla con Mercado Pago y le cuenta a la base lo que contestó.
//
// Reglas (la revisión 6 de Codex está en revisiones/respuesta-codex-6.md):
// - A un aviso de Mercado Pago no se le cree: se vuelve a leer la orden con el pase del consultorio y se comprueba
//   que sea de ese pago (referencia), de esa cuenta, en pesos y por el importe esperado. Del aviso solo viene firmado
//   el número de la orden: ni el tipo ni el cuerpo. Por eso un aviso de «le quitaron el permiso a la aplicación» tampoco
//   se cree: se prueba el pase de esa cuenta.
// - Cada intento de pago crea UNA orden: la clave del pedido sale de la base, así repetirlo no crea otra.
// - Una devolución se toma de a una vuelta por vez y se pide con una clave fija por parte: repetirla no devuelve dos veces.
// - Lo que se cobró con una cuenta se devuelve con esa cuenta: si el consultorio cambió de cuenta, se dice y no se intenta.
// - Si Mercado Pago rechaza el pase, se prueba renovarlo una vez; si tampoco, la cuenta queda «caída» y la dueña
//   recibe un aviso para conectarla de nuevo.
// - En modo prueba se cobra siempre con el pase de prueba de la aplicación, nunca con el de una cuenta conectada; y una orden que
//   no es del ambiente del consultorio se cierra y no se le manda a nadie (el 25/11/2026 una «de prueba» salió de verdad).


// deno-lint-ignore no-explicit-any
type Dato = any;

export type DependenciasMp = {
  /** Llama una función de la base con el pase de quien hizo el pedido (así la base revisa quién es). */
  rpcUsuario: (funcion: string, args: Record<string, unknown>) => Promise<Dato>;
  /** Llama una función de la base con la clave secreta (solo las «mp_…» de servicio). */
  rpcServicio: (funcion: string, args: Record<string, unknown>) => Promise<Dato>;
  /** La aplicación «Entreturno» de Mercado Pago. Todo sale de los secretos de la función. */
  app: {
    clientId: string;
    clientSecret: string;
    /** A dónde vuelve Mercado Pago después de autorizar: la dirección de esta función, siempre la misma. */
    redirectUri: string;
    /** El pase de prueba de la aplicación: con ese se cobra en «prueba», haya o no una cuenta conectada. */
    paseDePrueba: string;
    /** Solo en el servidor de prueba de la compu: se acepta que la «pantalla de pago» esté en localhost. */
    pagoLocal?: boolean;
  };
  fetchFn?: typeof fetch;
  /** Hasta cuándo puede seguir trabajando una vuelta del reloj (milisegundos desde 1970). */
  hasta?: number;
};

/** Algo que no se puede hacer, con el código corto que entiende la página. */
export class ErrorDeCobro extends Error {
  codigo: string;
  constructor(codigo: string) {
    super(codigo);
    this.name = "ErrorDeCobro";
    this.codigo = codigo;
  }
}

const codigoDe = (e: unknown) => (e instanceof ErrorMp ? `${e.codigo}${e.message && e.message !== e.codigo ? `: ${e.message}` : ""}` : "falla").slice(0, 280);
/** El código con el que cortó la base (en Supabase viene en «codigo»; en las pruebas, en el mensaje). */
const codigoDeLaBase = (e: unknown) => String((e as Dato)?.codigo ?? (e as Dato)?.message ?? "");

type Credencial = { acceso: string; usuario: string | null; propia: boolean; ambiente: string };

/** Con qué pase se cobra en ese consultorio: el de su cuenta o, en «prueba», siempre el de prueba de Entreturno. */
async function credencialDe(dep: DependenciasMp, consultorio: string): Promise<Credencial> {
  const c = await dep.rpcServicio("mp_credencial", { p_consultorio: consultorio });
  if (c?.ambiente === "prueba") {
    if (!dep.app.paseDePrueba) throw new ErrorDeCobro("falta_configurar");
    return { acceso: dep.app.paseDePrueba, usuario: null, propia: false, ambiente: "prueba" };
  }
  if (c?.ambiente === "real" && c.acceso) return { acceso: c.acceso, usuario: c.cuenta?.userId ?? null, propia: true, ambiente: "real" };
  throw new ErrorDeCobro("mp_sin_cuenta");
}

/** Pide pases nuevos para la cuenta del consultorio y los guarda. Si Mercado Pago dice que no, la cuenta queda caída. */
async function renovar(dep: DependenciasMp, consultorio: string): Promise<boolean> {
  const c = await dep.rpcServicio("mp_credencial", { p_consultorio: consultorio, p_con_renovar: true });
  if (!c?.renovar) {
    await dep.rpcServicio("mp_cuenta_caida", { p_consultorio: consultorio, p_user_id: null, p_motivo: "Mercado Pago rechazó el pase y no hay con qué renovarlo" });
    return false;
  }
  try {
    const p = await renovarPase({ clientId: dep.app.clientId, clientSecret: dep.app.clientSecret, renovar: c.renovar, fetchFn: dep.fetchFn });
    if (p.real === false) throw new ErrorMp("ambiente", 200, true, "Mercado Pago devolvió un pase de prueba");
    await dep.rpcServicio("mp_cuenta_renovada", { p_consultorio: consultorio, p_acceso: p.acceso, p_renovar: p.renovar, p_segundos: p.segundos });
    return true;
  } catch (e) {
    if (e instanceof ErrorMp && e.definitivo) {
      await dep.rpcServicio("mp_cuenta_caida", { p_consultorio: consultorio, p_user_id: null, p_motivo: `No se pudo renovar el pase (${codigoDe(e)})` });
      return false;
    }
    await dep.rpcServicio("mp_cuenta_reintento", { p_consultorio: consultorio, p_error: codigoDe(e) });
    throw e;
  }
}

/** Hace un pedido a Mercado Pago con el pase del consultorio. Si lo rechaza por el pase (401), lo renueva y prueba una vez más. */
async function conPase<T>(dep: DependenciasMp, consultorio: string, pedido: (c: Credencial) => Promise<T>): Promise<T> {
  const c = await credencialDe(dep, consultorio);
  try {
    return await pedido(c);
  } catch (e) {
    if (!(e instanceof ErrorMp) || e.estado !== 401) throw e;
    if (!c.propia) throw new ErrorDeCobro("falta_configurar");          // el pase de prueba de Entreturno está mal cargado
    if (!(await renovar(dep, consultorio))) throw new ErrorDeCobro("mp_sin_cuenta");
    return await pedido(await credencialDe(dep, consultorio));
  }
}

// ---------------------------------------------------------------------------------------------------
// Conectar la cuenta
// ---------------------------------------------------------------------------------------------------

/** La dueña aprieta «Conectar Mercado Pago»: devuelve la dirección de Mercado Pago donde autoriza. */
export async function iniciarConexion(dep: DependenciasMp, slug: string, volverA: string): Promise<{ url: string }> {
  if (!dep.app.clientId || !dep.app.clientSecret) throw new ErrorDeCobro("falta_configurar");
  const estado = aleatorio(32);
  const verificador = aleatorio(48);
  await dep.rpcUsuario("mp_conexion_iniciar", { p_slug: slug, p_estado: estado, p_verificador: verificador, p_volver_a: volverA });
  return { url: urlAutorizar({ clientId: dep.app.clientId, estado, redirectUri: dep.app.redirectUri, desafio: await desafioDe(verificador) }) };
}

/**
 * Mercado Pago volvió después de autorizar. Cambia el código por los pases y deja la cuenta «por confirmar».
 * Devuelve a qué página hay que mandar a la dueña (o nada, si el intento no existe o venció).
 */
export async function terminarConexion(
  dep: DependenciasMp, vuelta: { codigo: string; estado: string },
): Promise<{ volverA: string | null; ok: boolean; motivo?: string }> {
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(vuelta.estado)) return { volverA: null, ok: false, motivo: "vencido" };
  const t = await dep.rpcServicio("mp_conexion_tomar", { p_estado: vuelta.estado });
  if (!t) return { volverA: null, ok: false, motivo: "vencido" };
  if (!vuelta.codigo) return { volverA: t.volverA, ok: false, motivo: "cancelado" };       // dijo que no en Mercado Pago
  try {
    const p = await canjearCodigo({
      clientId: dep.app.clientId, clientSecret: dep.app.clientSecret, codigo: vuelta.codigo, redirectUri: dep.app.redirectUri,
      verificador: t.verificador, prueba: t.ambiente === "prueba", fetchFn: dep.fetchFn,
    });
    // en «real» no sirve un pase de prueba, y en «prueba» no se guarda uno que cobra de verdad (ni uno que no se sabe)
    if (t.ambiente === "real" ? p.real === false : p.real !== false) {
      return { volverA: t.volverA, ok: false, motivo: t.ambiente === "real" ? "ambiente" : "ambiente-prueba" };
    }
    let quien = { usuario: p.usuario, nombre: "", email: "", pais: "" };
    try {
      quien = await quienSoy(p.acceso, dep.fetchFn);
    } catch {
      // sin el nombre igual sirve: la dueña ve el número de la cuenta
    }
    if (quien.pais && quien.pais !== "MLA") return { volverA: t.volverA, ok: false, motivo: "pais" };
    try {
      await dep.rpcServicio("mp_cuenta_guardar", {
        p_consultorio: t.consultorio, p_ambiente: t.ambiente, p_user_id: p.usuario, p_acceso: p.acceso, p_renovar: p.renovar,
        p_segundos: p.segundos, p_nombre: quien.nombre, p_email: quien.email, p_miembro: t.miembro,
      });
    } catch (e) {
      // es OTRA cuenta y la anterior todavía tiene cobros abiertos o devoluciones esperando: no se cambia
      if (codigoDeLaBase(e).includes("mp_con_pendientes")) return { volverA: t.volverA, ok: false, motivo: "pendientes" };
      throw e;
    }
    return { volverA: t.volverA, ok: true };
  } catch (e) {
    if (e instanceof ErrorMp) return { volverA: t.volverA, ok: false, motivo: e.definitivo ? "rechazado" : "sin_respuesta" };
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------------
// Cobrar
// ---------------------------------------------------------------------------------------------------

/** La profesional aprieta «Pagar con Mercado Pago»: devuelve la dirección donde se paga. */
export async function pagar(dep: DependenciasMp, slug: string, reserva: string, tipo: string, volverA: string): Promise<{ pago: string; enlace: string }> {
  const prep = await dep.rpcUsuario("mp_pago_preparar", { p_slug: slug, p_reserva: reserva, p_tipo: tipo });
  if (!prep.nuevo) return { pago: prep.pago, enlace: prep.enlace };
  if (prep.cerrar) {
    // había una orden vieja abierta para lo mismo: se cierra (si falla, la cierra el reloj)
    try {
      await conPase(dep, prep.consultorio, (c) => cancelarOrden({ acceso: c.acceso, orden: prep.cerrar, fetchFn: dep.fetchFn }));
    } catch {
      // sigue
    }
  }
  let orden: Orden;
  try {
    orden = await conPase(dep, prep.consultorio, async (c) => {
      const nueva = await crearOrden({
        acceso: c.acceso, clave: prep.clave, fetchFn: dep.fetchFn,
        cuerpo: cuerpoDeOrden({
          monto: prep.monto, referencia: prep.pago, titulo: prep.titulo, descripcion: prep.descripcion,
          email: c.ambiente === "real" ? prep.email : null,        // en prueba, Mercado Pago pide el mail en su pantalla
          minutos: prep.minutos, volverA,
        }),
      });
      if (esOrdenDePrueba(nueva.id) !== (c.ambiente === "prueba")) {
        // una de verdad en modo prueba (o al revés): se cierra enseguida y la página no llega a recibir dónde pagarla
        let comoQuedo = "cerrada";
        try {
          await cancelarOrden({ acceso: c.acceso, orden: nueva.id, fetchFn: dep.fetchFn });
        } catch {
          comoQuedo = "quedó sin cerrar";        // nadie tiene la dirección para pagarla; el número queda anotado para mirarla a mano
        }
        throw new ErrorMp("otro_ambiente", 200, true, `la orden ${nueva.id} no es del modo de este consultorio (${comoQuedo})`);
      }
      return nueva;
    });
    if (!esDireccionDePago(orden.enlace, dep.app.pagoLocal === true) || !/^\d{1,20}$/.test(orden.usuario)) {
      throw new ErrorMp("respuesta_rara", 200, false, "Mercado Pago no devolvió dónde se paga");
    }
  } catch (e) {
    if (e instanceof ErrorMp) {
      await dep.rpcServicio("mp_pago_fallo", { p_pago: prep.pago, p_error: codigoDe(e), p_definitivo: e.definitivo });
      throw new ErrorDeCobro(e.definitivo ? "mp_rechazo" : "mp_sin_respuesta");
    }
    if (e instanceof ErrorDeCobro) await dep.rpcServicio("mp_pago_fallo", { p_pago: prep.pago, p_error: e.codigo, p_definitivo: false });
    throw e;
  }
  await dep.rpcServicio("mp_pago_orden", {
    p_pago: prep.pago, p_orden: orden.id, p_enlace: orden.enlace, p_cuenta: orden.usuario, p_sin_vencimiento: orden.sinVencimiento === true,
  });
  return { pago: prep.pago, enlace: orden.enlace };
}

type PagoUbicado = { pago: string; consultorio: string; orden: string | null; monto: number; estado?: string };

/**
 * Le pregunta a Mercado Pago cómo está la orden de un pago y le pasa la respuesta a la base (que confirma la reserva,
 * la revive, o manda a devolver). `avisada`: el número de orden que trajo el aviso, por si el nuestro no llegó a anotarse.
 */
export async function conciliar(dep: DependenciasMp, info: PagoUbicado, avisada?: string): Promise<Dato> {
  const id = info.orden ?? avisada;
  if (!id) return { estado: info.estado ?? "pendiente" };
  let leida: { o: Orden; usuario: string | null; ambiente: string };
  try {
    leida = await conPase(dep, info.consultorio, async (c) => ({
      o: await leerOrden({ acceso: c.acceso, orden: id, fetchFn: dep.fetchFn }), usuario: c.usuario, ambiente: c.ambiente,
    }));
  } catch (e) {
    if (e instanceof ErrorMp && e.estado === 404) return { estado: info.estado ?? "pendiente", sinOrden: true };
    throw e;
  }
  const o = leida.o;
  const esDeEstePago = o.referencia === info.pago && o.moneda === "ARS" && Math.round(o.total) === info.monto
    && (leida.usuario === null || o.usuario === leida.usuario) && esOrdenDePrueba(o.id) === (leida.ambiente === "prueba");
  if (!esDeEstePago && o.estado !== "processed") return { estado: info.estado ?? "pendiente", ajena: true };   // nadie pagó nada: se ignora
  return await dep.rpcServicio("mp_pago_resultado", {
    p_pago: info.pago, p_orden: esDeEstePago ? o.id : "", p_estado: o.estado, p_detalle: o.detalle, p_pagado: o.pagado,
    p_transaccion: o.transaccion, p_cuenta: /^\d{1,20}$/.test(o.usuario) ? o.usuario : null,
  });
}

/**
 * Un aviso de Mercado Pago (ya con la firma comprobada). La firma cubre solo el número (`dato`): el tipo y el cuerpo
 * pueden venir cambiados, así que de ahí no se toma ninguna decisión; solo pistas para saber qué ir a comprobar.
 */
export async function avisoDeMp(dep: DependenciasMp, aviso: { tipo: string; dato: string; cuerpo: Dato }): Promise<Dato> {
  if (aviso.tipo === "order") {
    if (!/^[A-Za-z0-9_-]{6,80}$/.test(aviso.dato)) return { ignorado: "sin orden" };
    const referencia = String(aviso.cuerpo?.data?.external_reference ?? "");
    const info = await dep.rpcServicio("mp_pago_ubicar", { p_orden: aviso.dato, p_referencia: /^[0-9a-fA-F-]{36}$/.test(referencia) ? referencia : null });
    if (!info) return { ignorado: "orden desconocida" };
    try {
      return await conciliar(dep, info, aviso.dato);
    } catch (e) {
      // no se pudo leer la orden: queda marcada para que el reloj la siga mirando (aunque el intento ya esté cerrado).
      // Si es porque la cuenta no está conectada y el aviso habla de un pago hecho, la dueña se entera.
      const sinCuenta = e instanceof ErrorDeCobro && e.codigo === "mp_sin_cuenta";
      try {
        await dep.rpcServicio("mp_pago_sin_comprobar", { p_pago: info.pago, p_pagada: sinCuenta && aviso.cuerpo?.data?.status === "processed" });
      } catch {
        // se informa el error original
      }
      throw e;
    }
  }
  if (aviso.tipo === "mp-connect") {
    // «una cuenta cambió el permiso que le dio a la aplicación». No se le cree: se prueba el pase de los consultorios que
    // cobran con esa cuenta. Si el pase ya no sirve y no se puede renovar, conPase la deja «caída» y avisa a la dueña.
    const usuario = String(aviso.cuerpo?.user_id ?? aviso.cuerpo?.data?.id ?? aviso.dato ?? "");
    if (!/^\d{1,20}$/.test(usuario)) return { ignorado: "mp-connect" };
    const consultorios: string[] = (await dep.rpcServicio("mp_cuentas_de", { p_user_id: usuario })) ?? [];
    let caidas = 0;
    for (const c of consultorios.slice(0, 5)) {
      try {
        await conPase(dep, c, (cred) => quienSoy(cred.acceso, dep.fetchFn));
      } catch (e) {
        if (e instanceof ErrorDeCobro && e.codigo === "mp_sin_cuenta") caidas++;
      }
    }
    return { cuentasComprobadas: Math.min(consultorios.length, 5), cuentasCaidas: caidas };
  }
  return { ignorado: aviso.tipo };
}

/** «Ya pagué, fijate»: la página lo pide al volver de Mercado Pago. Devuelve cómo quedó ese pago. */
export async function verificar(dep: DependenciasMp, slug: string, pago: string): Promise<{ estado: string; reserva: string }> {
  const info = await dep.rpcUsuario("mp_pago_mio", { p_slug: slug, p_pago: pago });
  if (info.orden && ["pendiente", "vencido", "rechazado"].includes(info.estado)) {
    try {
      await conciliar(dep, info);
    } catch (e) {
      if (!(e instanceof ErrorMp) && !(e instanceof ErrorDeCobro)) throw e;      // si Mercado Pago no contesta, se dice cómo está hoy
    }
  }
  const fin = await dep.rpcUsuario("mp_pago_mio", { p_slug: slug, p_pago: pago });
  return { estado: fin.estado, reserva: fin.reserva };
}

// ---------------------------------------------------------------------------------------------------
// El reloj: lo que se hace sin que nadie lo pida
// ---------------------------------------------------------------------------------------------------

export type Vuelta = { pagos: number; cerradas: number; devoluciones: number; sobrantes: number; renovadas: number; fallas: number };

type Parte = { orden: string; transaccion?: string; monto: number; entera: boolean; cuenta?: string | null; devueltoAntes?: number };
type Devuelta = { hecha: boolean; referencia?: string; error?: string; definitivo?: boolean };

async function devolver(dep: DependenciasMp, consultorio: string, clave: string, parte: Parte): Promise<Devuelta> {
  // lo que se cobró con una cuenta se devuelve con esa cuenta
  const conLaMisma = (c: Credencial) => {
    if (parte.cuenta && c.usuario && c.usuario !== parte.cuenta) throw new ErrorDeCobro("otra_cuenta");
    return c.acceso;
  };
  try {
    const o = await conPase(dep, consultorio, (c) => devolverOrden({
      acceso: conLaMisma(c), orden: parte.orden, clave, fetchFn: dep.fetchFn,
      transaccion: parte.entera ? undefined : parte.transaccion, monto: parte.entera ? undefined : parte.monto,
    }));
    return { hecha: true, referencia: o.devolucion || "hecha" };
  } catch (e) {
    if (e instanceof ErrorDeCobro) {
      const texto = e.codigo === "otra_cuenta" ? "otra_cuenta: ese pago se cobró con otra cuenta de Mercado Pago"
        : e.codigo === "mp_sin_cuenta" ? "sin_cuenta: la cuenta de Mercado Pago no está conectada" : "falta configurar Mercado Pago";
      return { hecha: false, error: texto, definitivo: e.codigo !== "falta_configurar" };
    }
    if (!(e instanceof ErrorMp)) throw e;
    if (e.definitivo) {
      // ¿ya estaba devuelta? (la dueña la hizo desde Mercado Pago, o la respuesta de la vez anterior se perdió):
      // lo que Mercado Pago muestra devuelto de ese pago alcanza lo que teníamos anotado más esta parte
      try {
        const o = await conPase(dep, consultorio, (c) => leerOrden({ acceso: conLaMisma(c), orden: parte.orden, fetchFn: dep.fetchFn }));
        const yaSalio = parte.entera ? o.estado === "refunded" : o.estado === "refunded" || o.devuelto >= (parte.devueltoAntes ?? 0) + parte.monto;
        if (yaSalio) return { hecha: true, referencia: o.devolucion || "ya estaba devuelta" };
      } catch {
        // se informa el error original
      }
    }
    return { hecha: false, error: codigoDe(e), definitivo: e.definitivo };
  }
}

/**
 * Una vuelta del reloj: mira las órdenes abiertas, cierra las que ya no sirven, hace las devoluciones que esperan y
 * renueva los pases que están por vencer. Con `consultorio`, solo lo de ese consultorio (sin renovar pases).
 */
export async function vueltaDelReloj(dep: DependenciasMp, consultorio: string | null = null): Promise<Vuelta> {
  const v: Vuelta = { pagos: 0, cerradas: 0, devoluciones: 0, sobrantes: 0, renovadas: 0, fallas: 0 };
  const hayTiempo = () => !dep.hasta || Date.now() < dep.hasta;
  const pend = await dep.rpcServicio("mp_pendientes", consultorio ? { p_consultorio: consultorio } : {});

  for (const p of pend.pagos ?? []) {
    if (!hayTiempo()) return v;
    try {
      await conciliar(dep, p);
      v.pagos++;
    } catch {
      v.fallas++;
    }
  }

  for (const p of pend.cerrar ?? []) {
    if (!hayTiempo()) return v;
    try {
      await conPase(dep, p.consultorio, (c) => cancelarOrden({ acceso: c.acceso, orden: p.orden, fetchFn: dep.fetchFn }));
      await dep.rpcServicio("mp_pago_cerrado", { p_pago: p.pago });
      v.cerradas++;
    } catch (e) {
      // no se dejó cancelar: o ya estaba cerrada, o alguien la pagó. Se mira cómo quedó y la base decide.
      try {
        if (e instanceof ErrorMp && e.estado === 404) await dep.rpcServicio("mp_pago_cerrado", { p_pago: p.pago });
        else await conciliar(dep, p);
        v.cerradas++;
      } catch {
        v.fallas++;
      }
    }
  }

  for (const d of pend.devoluciones ?? []) {
    if (!hayTiempo()) return v;
    try {
      const t = await dep.rpcServicio("mp_devolucion_tomar", { p_devolucion: d.devolucion });
      if (!t) continue;                             // ya está hecha, o la está ejecutando otra vuelta
      let fallo = false;
      for (const parte of t.partes ?? []) {
        const r = await devolver(dep, t.consultorio, `dev-${d.devolucion}-${parte.n}`, parte);
        await dep.rpcServicio("mp_devolucion_parte", {
          p_devolucion: d.devolucion, p_n: parte.n, p_hecha: r.hecha, p_referencia: r.referencia ?? null, p_error: r.error ?? null,
          p_definitivo: r.definitivo === true,
        });
        if (!r.hecha) {
          fallo = true;
          break;                                    // las partes que siguen esperan a la próxima vuelta
        }
      }
      if (fallo) v.fallas++;
      else v.devoluciones++;
    } catch {
      v.fallas++;
    }
  }

  for (const s of pend.sobrantes ?? []) {
    if (!hayTiempo()) return v;
    try {
      const t = await dep.rpcServicio("mp_sobrante_tomar", { p_pago: s.pago });
      if (!t) continue;
      const r = await devolver(dep, t.consultorio, `sob-${t.pago}`, { orden: t.orden, monto: 0, entera: true, cuenta: t.cuenta });
      await dep.rpcServicio("mp_sobrante_resultado", { p_pago: t.pago, p_hecha: r.hecha, p_error: r.error ?? null, p_definitivo: r.definitivo === true });
      if (r.hecha) v.sobrantes++;
      else v.fallas++;
    } catch {
      v.fallas++;
    }
  }

  for (const c of pend.renovar ?? []) {
    if (!hayTiempo()) return v;
    try {
      if (await renovar(dep, c)) v.renovadas++;
      else v.fallas++;
    } catch {
      v.fallas++;
    }
  }
  return v;
}

/** Alguien del consultorio acaba de cancelar: que las devoluciones salgan ya, sin esperar al reloj. */
export async function despachar(dep: DependenciasMp, slug: string): Promise<Vuelta> {
  const quien = await dep.rpcUsuario("mp_consultorio_mio", { p_slug: slug });
  return await vueltaDelReloj(dep, quien.consultorio);
}

// ============ mp/index.ts ============
// Función de Supabase «mp»: el cobro con Mercado Pago.
//
// Atiende cuatro cosas distintas, y a cada una le pide una prueba distinta de quién es:
//   1) La página (POST con el pase de quien está adentro): «conectar» la cuenta, «pagar» una reserva, «verificar» un
//      pago al volver de Mercado Pago y «despachar» las devoluciones. La base revisa el pase en cada llamada.
//   2) Mercado Pago que vuelve después de que la dueña autorizó (GET con ?code=…&state=…): vale por el «state», que
//      se anotó al empezar, sirve una sola vez y vence a los 15 minutos.
//   3) Los avisos de Mercado Pago (POST con la cabecera x-signature): vale por la firma, y aun así no se le cree al
//      aviso: se vuelve a leer la orden en Mercado Pago.
//   4) El reloj de la base (POST con la cabecera x-entreturno-reloj): vale por una clave que solo conoce la base.
//
// Secretos (Supabase → Edge Functions → Secrets; los carga Santiago y nunca van al repositorio):
//   MP_CLIENT_ID, MP_CLIENT_SECRET   los de la aplicación «Entreturno» de Mercado Pago (Credenciales de producción)
//   MP_WEBHOOK_SECRETO               la «firma secreta» de los avisos del ambiente Prueba (Configuración de webhooks)
//   MP_WEBHOOK_SECRETO_REAL          la «firma secreta» de los avisos del ambiente Producción (son dos aplicaciones distintas
//                                    para Mercado Pago, así que son dos firmas). Alcanza con que esté cargada una.
//   MP_PRUEBA_TOKEN                  el Access Token de PRUEBA de la aplicación: con ese se cobra en modo prueba cuando
//                                    el consultorio todavía no conectó su cuenta
// Un secreto que son solo puntitos (lo que muestra el panel para tapar la clave) cuenta como que falta: pasó el 25/11/2026.
//
// En la aplicación de Mercado Pago hay que cargar la dirección de esta función (https://<proyecto>.supabase.co/functions/v1/mp)
// como «URL de redireccionamiento» y como dirección de Webhooks (eventos «Order (Mercado Pago)» y «Vinculación de aplicaciones»).
//
// Se despliega SIN «Enforce JWT verification», igual que «facturar». Para subirla desde el panel:
// publicar/armar_funcion.mjs la deja en un solo archivo (publicar/funcion-mp/index.ts).

const ORIGEN_PERMITIDO =
  /^https:\/\/([a-z0-9-]+\.)?entreturno\.com\.ar$|^https:\/\/([a-z0-9-]+\.)?[a-z0-9-]+-entreturno\.pages\.dev$|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cabecerasDeOrigen(origen: string | null): Record<string, string> {
  const h: Record<string, string> = {
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
  if (origen && ORIGEN_PERMITIDO.test(origen)) h["Access-Control-Allow-Origin"] = origen;
  return h;
}

/** Una clave de Supabase: la de siempre o, en los proyectos con claves nuevas, la «default» de la lista. */
function claveDeSupabase(simple: string, lista: string): string {
  const v = Deno.env.get(simple);
  if (v) return v;
  try {
    const j = JSON.parse(Deno.env.get(lista) ?? "{}");
    return String(j.default ?? Object.values(j)[0] ?? "");
  } catch {
    return "";
  }
}

/** Un secreto cargado a mano: sin los espacios que sobren, y vacío si son los puntitos con que el panel tapa la clave. */
function secretoDe(nombre: string): string {
  const v = (Deno.env.get(nombre) ?? "").trim();
  return /^[•·*●.]+$/.test(v) ? "" : v;
}

class ErrorDeBase extends Error {
  codigo: string;
  estado: number;
  constructor(codigo: string, estado: number) {
    super(codigo);
    this.codigo = codigo;
    this.estado = estado;
  }
}

Deno.serve(async (req: Request) => {
  const origen = req.headers.get("Origin");
  const responder = (estado: number, cuerpo: unknown) =>
    new Response(JSON.stringify(cuerpo), {
      status: estado,
      headers: { ...cabecerasDeOrigen(origen), "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cabecerasDeOrigen(origen) });

  const supabase = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, "");
  const publica = claveDeSupabase("SUPABASE_ANON_KEY", "SUPABASE_PUBLISHABLE_KEYS");
  const secreta = claveDeSupabase("SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEYS");
  if (!supabase || !publica || !secreta) return responder(500, { code: "falta_configurar" });
  const comoServicio: Record<string, string> = secreta.startsWith("sb_secret_")
    ? { apikey: secreta }
    : { apikey: secreta, Authorization: `Bearer ${secreta}` };
  const pase = req.headers.get("Authorization") ?? "";

  async function rpc(funcion: string, args: Record<string, unknown>, cabeceras: Record<string, string>) {
    const r = await fetch(`${supabase}/rest/v1/rpc/${funcion}`, {
      method: "POST",
      headers: { ...cabeceras, "Content-Type": "application/json" },
      body: JSON.stringify(args),
    });
    const texto = await r.text();
    // deno-lint-ignore no-explicit-any
    let j: any = null;
    try {
      j = texto ? JSON.parse(texto) : null;
    } catch {
      j = null;
    }
    if (!r.ok) throw new ErrorDeBase(String(j?.code === "P0001" && j?.message ? j.message : j?.code ?? `http_${r.status}`), r.status);
    return j;
  }

  const dep: DependenciasMp = {
    rpcUsuario: (fn, args) => rpc(fn, args, { apikey: publica, Authorization: pase }),
    rpcServicio: (fn, args) => rpc(fn, args, comoServicio),
    app: {
      clientId: secretoDe("MP_CLIENT_ID"),
      clientSecret: secretoDe("MP_CLIENT_SECRET"),
      redirectUri: `${supabase}/functions/v1/mp`,
      paseDePrueba: secretoDe("MP_PRUEBA_TOKEN"),
    },
  };
  const url = new URL(req.url);

  try {
    // 2) Mercado Pago vuelve después de que la dueña autorizó (o dijo que no)
    if (req.method === "GET") {
      const fin = await terminarConexion(dep, { codigo: url.searchParams.get("code") ?? "", estado: url.searchParams.get("state") ?? "" });
      if (!fin.volverA) {
        return new Response("Ese enlace ya no sirve. Volvé a la página del consultorio y tocá «Conectar» de nuevo.", {
          status: 400, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
        });
      }
      const marca = fin.ok ? "conectada" : `error-${fin.motivo ?? "falla"}`;
      return new Response(null, { status: 302, headers: { Location: `${fin.volverA}#mp=${marca}`, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
    }
    if (req.method !== "POST") return responder(405, { code: "metodo_no_permitido" });

    // deno-lint-ignore no-explicit-any
    let cuerpo: any = null;
    try {
      const texto = (await req.text()).slice(0, 200000);
      cuerpo = texto ? JSON.parse(texto) : null;
    } catch {
      cuerpo = null;
    }

    // 4) El reloj de la base
    const claveDelReloj = req.headers.get("x-entreturno-reloj");
    if (claveDelReloj !== null) {
      if (!(await dep.rpcServicio("mp_reloj_clave", { p_clave: claveDelReloj }))) return responder(401, { code: "sin_permiso" });
      return responder(200, await vueltaDelReloj({ ...dep, hasta: Date.now() + 45000 }));
    }

    // 3) Un aviso de Mercado Pago
    const firma = req.headers.get("x-signature");
    if (firma !== null) {
      // Prueba y Producción firman cada una con la suya. Da igual con cuál venga: el aviso solo dice «mirá esta orden», y la orden
      // se vuelve a leer en Mercado Pago con el pase de la cuenta que la creó.
      const secretos = [secretoDe("MP_WEBHOOK_SECRETO"), secretoDe("MP_WEBHOOK_SECRETO_REAL")].filter(Boolean);
      if (!secretos.length) return responder(500, { code: "falta_configurar" });
      const dato = url.searchParams.get("data.id") ?? "";
      let firmaOk = false;
      for (const secreto of secretos) {
        // una firma de hace más de dos días ya no vale (para entonces el reloj ya miró esa orden por su cuenta)
        firmaOk = firmaOk || await firmaValida({ firma, pedido: req.headers.get("x-request-id"), dato, secreto, maxAntiguedadSeg: 2 * 86400 });
      }
      if (!firmaOk) return responder(401, { code: "firma_invalida" });
      const tipo = String(url.searchParams.get("type") ?? cuerpo?.type ?? "");
      try {
        await avisoDeMp(dep, { tipo, dato: dato || String(cuerpo?.data?.id ?? ""), cuerpo });
      } catch (e) {
        // no se pudo procesar ahora (Mercado Pago o la base no contestaron): con un 503 Mercado Pago lo manda de nuevo
        console.error("mp: aviso sin procesar", e instanceof Error ? e.name : typeof e);
        return responder(503, { code: "reintentar" });
      }
      return responder(200, { ok: true });
    }

    // 1) La página
    if (!/^Bearer [\w.-]+$/.test(pase)) return responder(401, { code: "sin_sesion" });
    if (!origen || !ORIGEN_PERMITIDO.test(origen)) return responder(403, { code: "origen_no_permitido" });
    const volverA = `${origen}/`;
    const slug = String(cuerpo?.slug ?? "");
    switch (cuerpo?.accion) {
      case "conectar":
        return responder(200, await iniciarConexion(dep, slug, volverA));
      case "pagar":
        if (!UUID.test(String(cuerpo.reserva ?? "")) || !["sena", "total", "saldo"].includes(String(cuerpo.tipo ?? ""))) return responder(400, { code: "dato_invalido" });
        return responder(200, await pagar(dep, slug, cuerpo.reserva, cuerpo.tipo, volverA));
      case "verificar":
        if (!UUID.test(String(cuerpo.pago ?? ""))) return responder(400, { code: "dato_invalido" });
        return responder(200, await verificar(dep, slug, cuerpo.pago));
      case "despachar":
        return responder(200, await despachar({ ...dep, hasta: Date.now() + 25000 }, slug));
      default:
        return responder(400, { code: "dato_invalido" });
    }
  } catch (e) {
    if (e instanceof ErrorDeBase) return responder(e.estado === 401 ? 401 : e.estado >= 500 ? 502 : 400, { code: e.codigo });
    if (e instanceof ErrorDeCobro) return responder(400, { code: e.codigo });
    // sin detalles en los registros: nada de pases ni claves
    console.error("mp: falla", e instanceof Error ? e.name : typeof e);
    return responder(500, { code: "falla" });
  }
});
