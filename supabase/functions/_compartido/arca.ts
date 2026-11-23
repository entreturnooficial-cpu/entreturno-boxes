// Conexión con ARCA (ex AFIP): ticket de acceso (WSAA) y factura electrónica (WSFEv1).
//
// Corre igual en Supabase (Deno) y en las pruebas (Node 24). No importa nada: la firma recibe node-forge de afuera
// (en Supabase: `import forge from "npm:node-forge@1.4.3"`; en Node: `import forge from "node-forge"`).
//
// Cómo factura Entreturno: un solo certificado (el de Entreturno) para todos los consultorios. Cada consultorio le
// delega el servicio «Facturación Electrónica» en ARCA y las facturas salen con SU CUIT (va en `Credencial.cuit`).
//
// Lo que le toca al que use este módulo (la base y la función de Supabase), para no facturar dos veces ni perder nada:
// - emitir de a uno por numeración (ambiente + CUIT + punto de venta + tipo), con un candado que respeten todos;
// - guardar el pedido de cada comprobante (congelado: misma fecha y mismos datos en cada reintento) antes de mandarlo,
//   el número que avisa `antesDeEnviar`, y después el resultado completo;
// - si una emisión queda «incierta», no emitir ninguna otra de esa numeración hasta conciliarla (`pendiente`);
// - guardar el ticket en un lugar durable y pedirlo de a uno por certificado;
// - no registrar nunca el SOAP entero, el ticket, la firma ni las claves.
//
// Fuentes: manual del desarrollador de WSFEv1 v4.8 (arca.gob.ar/fe/ayuda/documentos/wsfev1-RG-4291.pdf), el WSDL de
// homologación (orden exacto de los campos) y la guía de certificados del WSAA. Desde el 1/12/2026 ARCA rechaza los
// comprobantes que no informan la condición frente al IVA del receptor (RG 5616): acá es obligatoria siempre.
// Revisado por Codex el 23/11/2026 (revisiones/respuesta-codex-4.md).

export type Ambiente = "prueba" | "real";

export const DIRECCIONES = {
  prueba: {
    wsaa: "https://wsaahomo.afip.gov.ar/ws/services/LoginCms",
    wsfe: "https://wswhomo.afip.gov.ar/wsfev1/service.asmx",
  },
  real: {
    wsaa: "https://wsaa.afip.gov.ar/ws/services/LoginCms",
    wsfe: "https://servicios1.afip.gov.ar/wsfev1/service.asmx",
  },
};

/** Tipos de comprobante (FEParamGetTiposCbte). */
export const TIPO = {
  factura: { A: 1, B: 6, C: 11 },
  notaCredito: { A: 3, B: 8, C: 13 },
};

/** Tipos de documento del receptor (FEParamGetTiposDoc). */
export const DOC = { cuit: 80, cuil: 86, dni: 96, sinIdentificar: 99 };

/** Condición frente al IVA del receptor (FEParamGetCondicionIvaReceptor; comprobado contra ARCA de prueba). */
export const CONDICION_IVA = {
  responsableInscripto: 1,
  exento: 4,
  consumidorFinal: 5,
  monotributo: 6,
  noCategorizado: 7,
  monotributoSocial: 13,
  noAlcanzado: 15,
  monotributoPromovido: 16,
};

/** Concepto del comprobante: un alquiler de box es «servicios». */
export const CONCEPTO = { productos: 1, servicios: 2, productosYServicios: 3 };

/** Antes de conciliar un número pendiente, esperar esto desde que se mandó (ARCA puede seguir procesándolo). */
export const ESPERA_CONCILIAR_MS = 3 * 60_000;

const IVA_21 = 5; // código de la alícuota del 21 % (FEParamGetTiposIva)
const NS_FE = "http://ar.gov.afip.dif.FEV1/";
const ESPERA_MS = 30_000;
const MAX_RESPUESTA = 1_000_000; // caracteres; una respuesta de ARCA pesa unos pocos kB

export type Ticket = { token: string; sign: string; vence: string };
export type Credencial = { token: string; sign: string; cuit: string | number };
export type Aviso = { codigo: number; mensaje: string };

export type Comprobante = {
  puntoVenta: number;
  tipo: number; // TIPO.factura.C, TIPO.notaCredito.C, …
  concepto?: number; // por defecto, servicios
  docTipo: number; // DOC.*
  docNro: string | number; // 0 si docTipo es DOC.sinIdentificar
  condicionIva: number; // CONDICION_IVA.* (obligatoria)
  total: number; // en pesos
  neto?: number; // solo clases A y B (IVA 21 %): neto + iva = total
  iva?: number;
  fecha: string; // aaaa-mm-dd o aaaammdd: se fija la primera vez y no cambia en los reintentos
  servicioDesde?: string; // el turno (obligatoria si el concepto no es «productos»)
  servicioHasta?: string; // por defecto, igual a servicioDesde
  vencePago?: string; // por defecto, la fecha del comprobante
  asociado?: { tipo: number; puntoVenta: number; numero: number; cuit: string | number; fecha: string }; // notas de crédito
};

export type Resultado = {
  resultado: "A" | "R"; // aprobado o rechazado
  numero: number;
  cae: string | null;
  caeVence: string | null; // aaaa-mm-dd
  fecha: string | null; // aaaa-mm-dd
  observaciones: Aviso[];
  errores: Aviso[];
};

export type Consulta = {
  numero: number;
  tipo: number;
  puntoVenta: number;
  resultado: string | null;
  cae: string | null;
  caeVence: string | null;
  fecha: string | null; // aaaa-mm-dd
  concepto: number;
  docTipo: number;
  docNro: string;
  total: number;
  neto: number;
  iva: number;
  servicioDesde: string | null;
  servicioHasta: string | null;
  vencePago: string | null;
  condicionIva: number | null;
  asociados: { tipo: number; puntoVenta: number; numero: number }[];
};

/**
 * Error de la conexión con ARCA.
 * - `transporte`: no se sabe si ARCA llegó a recibir el pedido.
 * - `codigo` «incierto» (con `numero`): una emisión que no se sabe si quedó; se concilia más tarde con `pendiente`.
 */
export class ErrorArca extends Error {
  codigo: string;
  transporte: boolean;
  errores: Aviso[];
  numero: number | null;
  constructor(codigo: string, mensaje: string, transporte = false, errores: Aviso[] = []) {
    super(mensaje);
    this.name = "ErrorArca";
    this.codigo = codigo;
    this.transporte = transporte;
    this.errores = errores;
    this.numero = null;
  }
}

const invalido = (mensaje: string) => new ErrorArca("dato_invalido", mensaje);
const rara = (mensaje: string) => new ErrorArca("respuesta_rara", mensaje, true);

// ---------------------------------------------------------------------------------------------------------------
// XML (las respuestas de ARCA son chicas y siempre iguales; se leen con expresiones simples y se valida lo que importa)
// ---------------------------------------------------------------------------------------------------------------

export function escaparXml(texto: string | number): string {
  return String(texto)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function desescaparXml(texto: string): string {
  return texto
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]{1,6});/gi, (_m, n) => String.fromCodePoint(Math.min(parseInt(n, 16), 0x10ffff)))
    .replace(/&#(\d{1,7});/g, (_m, n) => String.fromCodePoint(Math.min(Number(n), 0x10ffff)))
    .replace(/&amp;/g, "&");
}

function patron(nombre: string, banderas: string): RegExp {
  return new RegExp(`<(?:[\\w.-]+:)?${nombre}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w.-]+:)?${nombre}>`, banderas);
}

/** Contenido (sin desescapar) de la primera etiqueta con ese nombre, con o sin prefijo; null si no está. */
export function etiqueta(xml: string, nombre: string): string | null {
  const m = patron(nombre, "").exec(xml);
  return m ? m[1] : null;
}

/** Contenido de todas las etiquetas con ese nombre. */
export function etiquetas(xml: string, nombre: string): string[] {
  return [...xml.matchAll(patron(nombre, "g"))].map((m) => m[1]);
}

function texto(xml: string | null, nombre: string): string | null {
  const v = xml === null ? null : etiqueta(xml, nombre);
  return v === null ? null : desescaparXml(v).trim();
}

function avisos(xml: string | null, grupo: string, item: string): Aviso[] {
  const g = xml === null ? null : etiqueta(xml, grupo);
  if (g === null) return [];
  return etiquetas(g, item).map((x) => ({
    codigo: Number(texto(x, "Code")),
    mensaje: texto(x, "Msg") ?? "",
  }));
}

function exigirSinErrores(xml: string): void {
  const errores = avisos(xml, "Errors", "Err");
  if (errores.length) {
    throw new ErrorArca(
      `arca_${errores[0].codigo}`,
      errores.map((e) => `${e.codigo}: ${e.mensaje}`).join(" | "),
      false,
      errores,
    );
  }
}

const soloCodigo602 = (errores: Aviso[]) => errores.length > 0 && errores.every((e) => e.codigo === 602);

// ---------------------------------------------------------------------------------------------------------------
// Números, documentos y fechas
// ---------------------------------------------------------------------------------------------------------------

function entero(n: unknown, que: string, minimo = 0): number {
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < minimo) throw invalido(`${que}: número inválido`);
  return n;
}

function aCentavos(n: unknown, que: string): number {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) throw invalido(`${que}: importe inválido`);
  const c = Math.round(n * 100);
  if (!Number.isSafeInteger(c)) throw invalido(`${que}: importe inválido`);
  return c;
}

const pesos = (centavos: number) => (centavos / 100).toFixed(2);

/** Valida una CUIT o CUIL (formato y dígito verificador) y la devuelve con sus 11 números. */
export function cuitValida(cuit: string | number): string {
  const s = String(cuit).trim();
  if (!/^\d{2}-?\d{8}-?\d$/.test(s)) throw new ErrorArca("cuit_invalido", "La CUIT tiene que tener 11 números");
  const d = s.replace(/-/g, "");
  const factores = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const r = 11 - (factores.reduce((t, f, i) => t + f * Number(d[i]), 0) % 11);
  const verificador = r === 11 ? 0 : r;
  if (verificador !== Number(d[10])) throw new ErrorArca("cuit_invalido", "La CUIT no es válida (el último número no da)");
  return d;
}

function documento(docTipo: number, docNro: string | number): string {
  if (docTipo === DOC.sinIdentificar) return "0";
  if (docTipo === DOC.cuit || docTipo === DOC.cuil) return cuitValida(docNro);
  const s = String(docNro).trim();
  if (docTipo === DOC.dni) {
    const d = s.replace(/\./g, "");
    if (/[^\d.]/.test(s) || !/^\d{6,8}$/.test(d)) throw invalido("El DNI tiene que tener entre 6 y 8 números");
    return d;
  }
  if (!/^\d{1,11}$/.test(s)) throw invalido("Número de documento inválido");
  return s;
}

/** Fecha en la Argentina como «aaaammdd» (ARCA trabaja con la fecha argentina). */
export function fechaArca(d: Date = new Date()): string {
  if (Number.isNaN(d.getTime())) throw invalido("Fecha inválida");
  const partes = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Argentina/Buenos_Aires",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
  return partes.replace(/-/g, "");
}

/** Acepta «aaaammdd», «aaaa-mm-dd» (fechas que existen) o una fecha, y devuelve «aaaammdd». */
export function aFechaArca(f: string | Date): string {
  if (f instanceof Date) return fechaArca(f);
  const m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(String(f));
  if (!m) throw invalido(`Fecha inválida: ${f}`);
  const [a, me, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const x = new Date(Date.UTC(a, me - 1, d));
  if (a < 2000 || a > 2100 || x.getUTCMonth() !== me - 1 || x.getUTCDate() !== d) throw invalido(`Fecha inválida: ${f}`);
  return `${m[1]}${m[2]}${m[3]}`;
}

/** «aaaammdd» → «aaaa-mm-dd» (o null). */
export function desdeFechaArca(f: string | null): string | null {
  if (!f || !/^\d{8}$/.test(f)) return null;
  return `${f.slice(0, 4)}-${f.slice(4, 6)}-${f.slice(6, 8)}`;
}

function claseDe(tipo: number): "A" | "B" | "C" {
  if ([1, 2, 3].includes(tipo)) return "A";
  if ([6, 7, 8].includes(tipo)) return "B";
  if ([11, 12, 13].includes(tipo)) return "C";
  throw invalido(`Tipo de comprobante no previsto: ${tipo}`);
}

const esNotaCredito = (tipo: number) => [3, 8, 13].includes(tipo);

// ---------------------------------------------------------------------------------------------------------------
// Pedidos SOAP
// ---------------------------------------------------------------------------------------------------------------

async function soap(url: string, accion: string, sobre: string, fetchFn: typeof fetch): Promise<string> {
  let resp: Response;
  let cuerpo: string;
  try {
    resp = await fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: accion },
      body: sobre,
      signal: AbortSignal.timeout(ESPERA_MS),
    });
    if (Number(resp.headers.get("content-length") ?? 0) > MAX_RESPUESTA) throw rara("Respuesta demasiado grande");
    cuerpo = await resp.text();
  } catch (e) {
    if (e instanceof ErrorArca) throw e;
    throw new ErrorArca("sin_respuesta", `ARCA no respondió: ${e instanceof Error ? e.name : "falla de red"}`, true);
  }
  if (cuerpo.length > MAX_RESPUESTA) throw rara("Respuesta demasiado grande");
  const falla = texto(cuerpo, "faultstring");
  if (falla !== null) {
    const codigo = (texto(cuerpo, "faultcode") ?? "falla").replace(/^[\w.-]+:/, "");
    throw new ErrorArca(codigo, falla.slice(0, 500));
  }
  if (!resp.ok) {
    // Un 5xx sin explicación puede venir de un intermediario: no se sabe si el pedido llegó.
    throw new ErrorArca(`http_${resp.status}`, `ARCA respondió ${resp.status}`, resp.status >= 500);
  }
  return cuerpo;
}

async function llamarWsfe(ambiente: Ambiente, metodo: string, interior: string, fetchFn: typeof fetch): Promise<string> {
  const sobre =
    `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ar="${NS_FE}">` +
    `<soap:Body><ar:${metodo}>${interior}</ar:${metodo}></soap:Body></soap:Envelope>`;
  return await soap(DIRECCIONES[ambiente].wsfe, `"${NS_FE}${metodo}"`, sobre, fetchFn);
}

function xmlAuth(c: Credencial): string {
  return (
    `<ar:Auth><ar:Token>${escaparXml(c.token)}</ar:Token><ar:Sign>${escaparXml(c.sign)}</ar:Sign>` +
    `<ar:Cuit>${cuitValida(c.cuit)}</ar:Cuit></ar:Auth>`
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Ticket de acceso (WSAA)
// ---------------------------------------------------------------------------------------------------------------

/** Pedido de acceso (TRA) para un servicio, válido 10 minutos para cada lado de `ahora`. */
export function armarTRA(servicio: string, ahora: Date = new Date()): string {
  const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
  return (
    `<?xml version="1.0" encoding="UTF-8"?><loginTicketRequest version="1.0"><header>` +
    `<uniqueId>${Math.floor(ahora.getTime() / 1000)}</uniqueId>` +
    `<generationTime>${iso(ahora.getTime() - 10 * 60_000)}</generationTime>` +
    `<expirationTime>${iso(ahora.getTime() + 10 * 60_000)}</expirationTime>` +
    `</header><service>${escaparXml(servicio)}</service></loginTicketRequest>`
  );
}

/** Firma el TRA (CMS/PKCS#7 con el contenido adentro) y lo devuelve en base64, como lo pide el WSAA. */
// deno-lint-ignore no-explicit-any
export function firmarTRA(forge: any, tra: string, certificadoPem: string, clavePem: string, ahora = new Date()): string {
  // deno-lint-ignore no-explicit-any
  let certificado: any;
  // deno-lint-ignore no-explicit-any
  let clave: any;
  try {
    certificado = forge.pki.certificateFromPem(certificadoPem);
    clave = forge.pki.privateKeyFromPem(clavePem);
  } catch {
    // sin el detalle de la librería: no tiene que viajar nada de la clave en un mensaje
    throw new ErrorArca("certificado_invalido", "No se pudo leer el certificado o la clave");
  }
  if (!clave?.n || !certificado?.publicKey?.n) throw new ErrorArca("certificado_invalido", "No se pudo leer el certificado o la clave");
  if (!certificado.publicKey.n.equals(clave.n) || !certificado.publicKey.e.equals(clave.e)) {
    throw new ErrorArca("clave_no_corresponde", "La clave privada no corresponde a ese certificado");
  }
  if (ahora > certificado.validity.notAfter) throw new ErrorArca("certificado_vencido", "El certificado de ARCA está vencido");
  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(tra, "utf8");
  p7.addCertificate(certificado);
  p7.addSigner({
    key: clave,
    certificate: certificado,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
      { type: forge.pki.oids.signingTime, value: ahora },
    ],
  });
  p7.sign();
  return forge.util.encode64(forge.asn1.toDer(p7.toAsn1()).getBytes());
}

/** Pide el ticket al WSAA con el TRA firmado. */
export async function pedirTicket(ambiente: Ambiente, cms: string, fetchFn: typeof fetch = fetch): Promise<Ticket> {
  if (!/^[A-Za-z0-9+/=]+$/.test(cms)) throw invalido("El TRA firmado tiene que estar en base64");
  const sobre =
    `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" ` +
    `xmlns:wsaa="http://wsaa.view.sua.dvadac.desein.afip.gov"><soapenv:Header/><soapenv:Body>` +
    `<wsaa:loginCms><wsaa:in0>${cms}</wsaa:in0></wsaa:loginCms></soapenv:Body></soapenv:Envelope>`;
  const resp = await soap(DIRECCIONES[ambiente].wsaa, '""', sobre, fetchFn);
  const ret = etiqueta(resp, "loginCmsReturn");
  if (ret === null) throw rara("El WSAA no devolvió el ticket");
  const ticket = desescaparXml(ret);
  const token = texto(ticket, "token");
  const sign = texto(ticket, "sign");
  const vence = texto(ticket, "expirationTime");
  if (!token || !sign || !vence || Number.isNaN(Date.parse(vence))) throw rara("El ticket del WSAA vino incompleto");
  return { token, sign, vence: new Date(vence).toISOString() };
}

/** ¿Es un ticket completo y sirve por lo menos `margenMinutos` más? */
export function ticketVigente(t: Ticket | null | undefined, ahora: Date = new Date(), margenMinutos = 10): boolean {
  return (
    !!t &&
    typeof t.token === "string" &&
    t.token.length > 0 &&
    typeof t.sign === "string" &&
    t.sign.length > 0 &&
    Date.parse(t.vence) - ahora.getTime() > margenMinutos * 60_000
  );
}

/**
 * Devuelve un ticket vigente: el guardado o uno nuevo. ARCA no da otro ticket para el mismo certificado y servicio
 * mientras el anterior siga valiendo (hasta 12 horas), así que siempre hay que guardarlo y reusarlo.
 * Si ARCA dice que ya dio uno (otra corrida lo pidió, o se pidió antes de tiempo), se usa el guardado mientras sirva.
 */
export async function obtenerTicket(o: {
  ambiente: Ambiente;
  servicio?: string;
  leer: () => Promise<Ticket | null>;
  guardar: (t: Ticket) => Promise<void>;
  firmar: (tra: string) => string | Promise<string>;
  fetchFn?: typeof fetch;
  ahora?: Date;
  dormir?: (ms: number) => Promise<void>;
}): Promise<Ticket> {
  const dormir = o.dormir ?? ((ms: number) => new Promise<void>((listo) => setTimeout(listo, ms)));
  const ahora = o.ahora ?? new Date();
  const guardado = await o.leer();
  if (ticketVigente(guardado, ahora)) return guardado as Ticket;
  const cms = await o.firmar(armarTRA(o.servicio ?? "wsfe", ahora));
  let nuevo: Ticket;
  try {
    nuevo = await pedirTicket(o.ambiente, cms, o.fetchFn ?? fetch);
  } catch (e) {
    if (!(e instanceof ErrorArca && /alreadyAuthenticated/i.test(e.codigo))) throw e;
    for (let i = 0; i < 4; i++) {
      const otro = await o.leer();
      if (ticketVigente(otro, o.ahora ?? new Date(), 1)) return otro as Ticket;
      if (i < 3) await dormir(1500);
    }
    throw new ErrorArca(
      "ticket_perdido",
      "ARCA ya entregó un ticket que no quedó guardado: hay que esperar a que venza (hasta 12 horas)",
    );
  }
  for (let intento = 1; ; intento++) {
    try {
      await o.guardar(nuevo);
      return nuevo;
    } catch {
      if (intento >= 3) {
        throw new ErrorArca(
          "ticket_sin_guardar",
          "ARCA dio el ticket pero no se pudo guardar: hasta que venza (hasta 12 horas) no va a dar otro",
        );
      }
      await dormir(500);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Armado del comprobante
// ---------------------------------------------------------------------------------------------------------------

type Normalizado = {
  clase: "A" | "B" | "C";
  puntoVenta: number;
  tipo: number;
  concepto: number;
  docTipo: number;
  docNro: string;
  condicionIva: number;
  fecha: string; // aaaammdd
  totalC: number; // centavos
  netoC: number;
  ivaC: number;
  servicioDesde: string | null;
  servicioHasta: string | null;
  vencePago: string | null;
  asociado: { tipo: number; puntoVenta: number; numero: number; cuit: string; fecha: string } | null;
};

/** Valida el comprobante y lo deja con los valores exactos que viajan a ARCA. */
export function normalizar(c: Comprobante): Normalizado {
  const clase = claseDe(entero(c.tipo, "El tipo", 1));
  const puntoVenta = entero(c.puntoVenta, "El punto de venta", 1);
  const concepto = c.concepto ?? CONCEPTO.servicios;
  if (![1, 2, 3].includes(concepto)) throw invalido("Concepto inválido");
  if (!Number.isInteger(c.condicionIva) || c.condicionIva <= 0) {
    throw invalido("Falta la condición frente al IVA de quien recibe la factura");
  }
  if (!c.fecha) throw invalido("Falta la fecha del comprobante (se fija la primera vez y no cambia en los reintentos)");
  const fecha = aFechaArca(c.fecha);
  if (clase === "A" && c.docTipo !== DOC.cuit) throw invalido("La factura A va siempre a una CUIT");
  const docTipo = entero(c.docTipo, "El tipo de documento", 1);
  const docNro = documento(docTipo, c.docNro);

  const totalC = aCentavos(c.total, "El total");
  if (totalC <= 0) throw invalido("El total tiene que ser mayor que cero");
  let netoC: number;
  let ivaC: number;
  if (clase === "C") {
    if (c.iva !== undefined && c.iva !== 0) throw invalido("La factura C no lleva IVA");
    netoC = totalC;
    ivaC = 0;
  } else {
    netoC = aCentavos(c.neto, "El neto");
    ivaC = aCentavos(c.iva, "El IVA");
    if (netoC + ivaC !== totalC) throw invalido("Neto más IVA no da el total");
    if (Math.abs(ivaC - Math.round(netoC * 0.21)) > 1) throw invalido("El IVA no es el 21 % del neto");
  }

  let servicioDesde: string | null = null;
  let servicioHasta: string | null = null;
  let vencePago: string | null = null;
  if (concepto !== CONCEPTO.productos) {
    if (!c.servicioDesde) throw invalido("Faltan las fechas del servicio (el turno)");
    servicioDesde = aFechaArca(c.servicioDesde);
    servicioHasta = c.servicioHasta ? aFechaArca(c.servicioHasta) : servicioDesde;
    if (servicioHasta < servicioDesde) throw invalido("El servicio termina antes de empezar");
    vencePago = c.vencePago ? aFechaArca(c.vencePago) : fecha;
    if (vencePago < fecha) throw invalido("El vencimiento del pago no puede ser anterior a la fecha del comprobante");
  }

  let asociado: Normalizado["asociado"] = null;
  if (esNotaCredito(c.tipo) && !c.asociado) throw invalido("La nota de crédito tiene que decir a qué factura corresponde");
  if (c.asociado) {
    const a = c.asociado;
    const tipo = entero(a.tipo, "El tipo asociado", 1);
    if (claseDe(tipo) !== clase || esNotaCredito(tipo)) throw invalido("El comprobante asociado tiene que ser una factura de la misma clase");
    asociado = {
      tipo,
      puntoVenta: entero(a.puntoVenta, "El punto de venta asociado", 1),
      numero: entero(a.numero, "El número asociado", 1),
      cuit: cuitValida(a.cuit),
      fecha: aFechaArca(a.fecha),
    };
    if (asociado.fecha > fecha) throw invalido("La factura asociada no puede ser posterior a la nota de crédito");
  }

  return {
    clase, puntoVenta, tipo: c.tipo, concepto, docTipo, docNro, condicionIva: c.condicionIva, fecha,
    totalC, netoC, ivaC, servicioDesde, servicioHasta, vencePago, asociado,
  };
}

/** XML del detalle de un comprobante (FECAEDetRequest), con los campos en el orden del WSDL. */
export function armarDetalle(c: Comprobante, numero: number): string {
  const n = normalizar(c);
  entero(numero, "El número", 1);
  let x =
    `<ar:Concepto>${n.concepto}</ar:Concepto>` +
    `<ar:DocTipo>${n.docTipo}</ar:DocTipo><ar:DocNro>${n.docNro}</ar:DocNro>` +
    `<ar:CbteDesde>${numero}</ar:CbteDesde><ar:CbteHasta>${numero}</ar:CbteHasta>` +
    `<ar:CbteFch>${n.fecha}</ar:CbteFch>` +
    `<ar:ImpTotal>${pesos(n.totalC)}</ar:ImpTotal><ar:ImpTotConc>0.00</ar:ImpTotConc>` +
    `<ar:ImpNeto>${pesos(n.netoC)}</ar:ImpNeto><ar:ImpOpEx>0.00</ar:ImpOpEx><ar:ImpTrib>0.00</ar:ImpTrib>` +
    `<ar:ImpIVA>${pesos(n.ivaC)}</ar:ImpIVA>`;
  if (n.servicioDesde !== null) {
    x +=
      `<ar:FchServDesde>${n.servicioDesde}</ar:FchServDesde><ar:FchServHasta>${n.servicioHasta}</ar:FchServHasta>` +
      `<ar:FchVtoPago>${n.vencePago}</ar:FchVtoPago>`;
  }
  x +=
    `<ar:MonId>PES</ar:MonId><ar:MonCotiz>1</ar:MonCotiz>` +
    `<ar:CondicionIVAReceptorId>${n.condicionIva}</ar:CondicionIVAReceptorId>`;
  if (n.asociado) {
    const a = n.asociado;
    x +=
      `<ar:CbtesAsoc><ar:CbteAsoc><ar:Tipo>${a.tipo}</ar:Tipo><ar:PtoVta>${a.puntoVenta}</ar:PtoVta>` +
      `<ar:Nro>${a.numero}</ar:Nro><ar:Cuit>${a.cuit}</ar:Cuit><ar:CbteFch>${a.fecha}</ar:CbteFch>` +
      `</ar:CbteAsoc></ar:CbtesAsoc>`;
  }
  if (n.clase !== "C") {
    x +=
      `<ar:Iva><ar:AlicIva><ar:Id>${IVA_21}</ar:Id><ar:BaseImp>${pesos(n.netoC)}</ar:BaseImp>` +
      `<ar:Importe>${pesos(n.ivaC)}</ar:Importe></ar:AlicIva></ar:Iva>`;
  }
  return `<ar:FECAEDetRequest>${x}</ar:FECAEDetRequest>`;
}

// ---------------------------------------------------------------------------------------------------------------
// Factura electrónica (WSFEv1)
// ---------------------------------------------------------------------------------------------------------------

/** Estado de los servidores de facturación (no pide ticket). */
export async function estadoServidores(ambiente: Ambiente, fetchFn: typeof fetch = fetch) {
  const r = await llamarWsfe(ambiente, "FEDummy", "", fetchFn);
  return { app: texto(r, "AppServer"), base: texto(r, "DbServer"), autenticacion: texto(r, "AuthServer") };
}

/** Último número autorizado para ese punto de venta y tipo (0 si no hay ninguno). */
export async function ultimoAutorizado(
  ambiente: Ambiente,
  cred: Credencial,
  puntoVenta: number,
  tipo: number,
  fetchFn: typeof fetch = fetch,
): Promise<number> {
  const r = await llamarWsfe(
    ambiente,
    "FECompUltimoAutorizado",
    `${xmlAuth(cred)}<ar:PtoVta>${entero(puntoVenta, "El punto de venta", 1)}</ar:PtoVta>` +
      `<ar:CbteTipo>${entero(tipo, "El tipo", 1)}</ar:CbteTipo>`,
    fetchFn,
  );
  exigirSinErrores(r);
  const n = texto(etiqueta(r, "FECompUltimoAutorizadoResult"), "CbteNro");
  if (n === null || !/^\d+$/.test(n)) throw rara("ARCA no devolvió el último número");
  return Number(n);
}

/** Condiciones frente al IVA que acepta ARCA, con la clase de comprobante (A, B, C…) en la que vale cada una. */
export async function condicionesIva(
  ambiente: Ambiente,
  cred: Credencial,
  clase?: string,
  fetchFn: typeof fetch = fetch,
) {
  const r = await llamarWsfe(
    ambiente,
    "FEParamGetCondicionIvaReceptor",
    xmlAuth(cred) + (clase ? `<ar:ClaseCmp>${escaparXml(clase)}</ar:ClaseCmp>` : ""),
    fetchFn,
  );
  exigirSinErrores(r);
  return etiquetas(r, "CondicionIvaReceptor").map((x) => ({
    id: Number(texto(x, "Id")),
    descripcion: texto(x, "Desc") ?? "",
    clase: texto(x, "Cmp_Clase") ?? "",
  }));
}

/** Puntos de venta para web services de esa CUIT ([] si no tiene). Sirve para comprobar una delegación. */
export async function puntosVenta(ambiente: Ambiente, cred: Credencial, fetchFn: typeof fetch = fetch) {
  const r = await llamarWsfe(ambiente, "FEParamGetPtosVenta", xmlAuth(cred), fetchFn);
  if (soloCodigo602(avisos(r, "Errors", "Err"))) return []; // 602: sin resultados
  exigirSinErrores(r);
  if (etiqueta(r, "FEParamGetPtosVentaResult") === null) throw rara("Respuesta de puntos de venta incompleta");
  return etiquetas(r, "PtoVenta").map((x) => ({
    numero: Number(texto(x, "Nro")),
    tipo: texto(x, "EmisionTipo") ?? "",
    bloqueado: (texto(x, "Bloqueado") ?? "N") === "S",
    baja: texto(x, "FchBaja"),
  }));
}

/**
 * Pide el CAE para un comprobante con un número dado.
 * Un rechazo bien formado de ARCA vuelve como «R». Cualquier otra cosa (corte, respuesta incompleta o rara) es un
 * ErrorArca con `transporte`: no se sabe si quedó.
 * ARCA suele avisar los problemas del detalle como «Obs» y los generales como «Err»: se guardan los dos.
 */
export async function pedirCAE(
  ambiente: Ambiente,
  cred: Credencial,
  c: Comprobante,
  numero: number,
  fetchFn: typeof fetch = fetch,
): Promise<Resultado> {
  const interior =
    `${xmlAuth(cred)}<ar:FeCAEReq><ar:FeCabReq><ar:CantReg>1</ar:CantReg>` +
    `<ar:PtoVta>${entero(c.puntoVenta, "El punto de venta", 1)}</ar:PtoVta>` +
    `<ar:CbteTipo>${entero(c.tipo, "El tipo", 1)}</ar:CbteTipo></ar:FeCabReq>` +
    `<ar:FeDetReq>${armarDetalle(c, numero)}</ar:FeDetReq></ar:FeCAEReq>`;
  const r = await llamarWsfe(ambiente, "FECAESolicitar", interior, fetchFn);
  const cuerpo = etiqueta(r, "FECAESolicitarResult");
  if (cuerpo === null) throw rara("ARCA respondió algo que no es la respuesta de una factura");
  const errores = avisos(cuerpo, "Errors", "Err");
  const detalle = etiqueta(cuerpo, "FECAEDetResponse");
  const cabecera = etiqueta(cuerpo, "FeCabResp");
  let resultado = texto(detalle, "Resultado") ?? texto(cabecera, "Resultado");
  if (resultado === null && errores.length) resultado = "R"; // rechazo general (por ejemplo, de la delegación)
  if (resultado !== "A" && resultado !== "R") throw rara(`Resultado de ARCA inesperado: ${resultado ?? "ninguno"}`);
  const desde = texto(detalle, "CbteDesde");
  if (detalle !== null && desde !== null && Number(desde) !== numero) throw rara("ARCA respondió por otro número");
  const cae = texto(detalle, "CAE");
  if (resultado === "A" && !/^\d{14}$/.test(cae ?? "")) throw rara("ARCA aprobó pero no vino el CAE");
  return {
    resultado,
    numero,
    cae: resultado === "A" ? cae : null,
    caeVence: resultado === "A" ? desdeFechaArca(texto(detalle, "CAEFchVto")) : null,
    fecha: desdeFechaArca(texto(detalle, "CbteFch")),
    observaciones: avisos(detalle, "Observaciones", "Obs"),
    errores,
  };
}

/** Busca un comprobante ya emitido. null solo si ARCA dice expresamente que no existe (602). */
export async function consultarComprobante(
  ambiente: Ambiente,
  cred: Credencial,
  puntoVenta: number,
  tipo: number,
  numero: number,
  fetchFn: typeof fetch = fetch,
): Promise<Consulta | null> {
  const r = await llamarWsfe(
    ambiente,
    "FECompConsultar",
    `${xmlAuth(cred)}<ar:FeCompConsReq><ar:CbteTipo>${entero(tipo, "El tipo", 1)}</ar:CbteTipo>` +
      `<ar:CbteNro>${entero(numero, "El número", 1)}</ar:CbteNro>` +
      `<ar:PtoVta>${entero(puntoVenta, "El punto de venta", 1)}</ar:PtoVta></ar:FeCompConsReq>`,
    fetchFn,
  );
  if (soloCodigo602(avisos(r, "Errors", "Err"))) return null;
  exigirSinErrores(r);
  const g = etiqueta(r, "ResultGet");
  if (g === null) throw rara("La consulta de ARCA vino sin el comprobante");
  if (Number(texto(g, "CbteDesde")) !== numero) throw rara("La consulta de ARCA trajo otro número");
  const num = (nombre: string) => Number(texto(g, nombre) ?? "NaN");
  const condicion = texto(g, "CondicionIVAReceptorId");
  return {
    numero,
    tipo,
    puntoVenta,
    resultado: texto(g, "Resultado"),
    cae: texto(g, "CodAutorizacion"),
    caeVence: desdeFechaArca(texto(g, "FchVto")),
    fecha: desdeFechaArca(texto(g, "CbteFch")),
    concepto: num("Concepto"),
    docTipo: num("DocTipo"),
    docNro: texto(g, "DocNro") ?? "",
    total: num("ImpTotal"),
    neto: num("ImpNeto"),
    iva: num("ImpIVA"),
    servicioDesde: desdeFechaArca(texto(g, "FchServDesde")),
    servicioHasta: desdeFechaArca(texto(g, "FchServHasta")),
    vencePago: desdeFechaArca(texto(g, "FchVtoPago")),
    condicionIva: condicion === null || condicion === "" ? null : Number(condicion),
    asociados: etiquetas(g, "CbteAsoc").map((a) => ({
      tipo: Number(texto(a, "Tipo")),
      puntoVenta: Number(texto(a, "PtoVta")),
      numero: Number(texto(a, "Nro")),
    })),
  };
}

/** ¿El comprobante que tiene ARCA es exactamente el nuestro? Compara todo lo que ARCA devuelve. */
export function coincide(q: Consulta, c: Comprobante): boolean {
  const n = normalizar(c);
  const centavos = (x: number) => (Number.isFinite(x) ? Math.round(x * 100) : NaN);
  const f = (x: string | null) => (x === null ? null : x.replace(/-/g, ""));
  return (
    q.resultado === "A" &&
    /^\d{14}$/.test(q.cae ?? "") &&
    q.concepto === n.concepto &&
    q.docTipo === n.docTipo &&
    q.docNro === n.docNro &&
    f(q.fecha) === n.fecha &&
    centavos(q.total) === n.totalC &&
    centavos(q.neto) === n.netoC &&
    centavos(q.iva) === n.ivaC &&
    f(q.servicioDesde) === n.servicioDesde &&
    f(q.servicioHasta) === n.servicioHasta &&
    f(q.vencePago) === n.vencePago &&
    (q.condicionIva === null || q.condicionIva === n.condicionIva) &&
    (n.asociado === null ||
      q.asociados.some(
        (a) => a.tipo === n.asociado!.tipo && a.puntoVenta === n.asociado!.puntoVenta && a.numero === n.asociado!.numero,
      ))
  );
}

function incierto(numero: number, motivo: string): ErrorArca {
  const e = new ErrorArca(
    "incierto",
    `No se sabe si ARCA autorizó el número ${numero} (${motivo}). No emitir otro de esa numeración hasta conciliarlo.`,
    true,
  );
  e.numero = numero;
  return e;
}

/**
 * Emite un comprobante con el número que sigue, sin facturar dos veces la misma cosa (ver las reglas al principio).
 * - `antesDeEnviar(numero)` (obligatorio) anota el número en la base antes de mandarlo.
 * - `pendiente`: un número que quedó «incierto» en una corrida anterior; primero se concilia.
 * Devuelve el resultado (A o R) o corta con ErrorArca:
 * - «incierto» (con `numero`): no se sabe si ARCA lo autorizó; la próxima corrida lo pasa como `pendiente`;
 * - «pendiente_no_coincide»: ARCA tiene otra cosa con ese número; hay que mirarlo a mano;
 * - cualquier otro: no se emitió nada.
 */
export async function emitirComprobante(o: {
  ambiente: Ambiente;
  cred: Credencial;
  comprobante: Comprobante;
  antesDeEnviar: (numero: number) => Promise<void>;
  pendiente?: { numero: number; desde: string | Date } | null;
  fetchFn?: typeof fetch;
  ahora?: Date;
}): Promise<Resultado & { recuperado: boolean }> {
  const { ambiente, cred, comprobante: c } = o;
  const fetchFn = o.fetchFn ?? fetch;
  if (typeof o.antesDeEnviar !== "function") throw invalido("Falta antesDeEnviar: el número se anota antes de mandarlo");
  normalizar(c); // un dato mal corta acá, antes de tocar ARCA
  const recuperar = (q: Consulta) => ({
    resultado: "A" as const,
    numero: q.numero,
    cae: q.cae,
    caeVence: q.caeVence,
    fecha: q.fecha,
    observaciones: [],
    errores: [],
    recuperado: true,
  });

  if (o.pendiente) {
    const p = o.pendiente;
    const desde = p.desde instanceof Date ? p.desde.getTime() : Date.parse(p.desde);
    if (Number.isNaN(desde) || (o.ahora ?? new Date()).getTime() - desde < ESPERA_CONCILIAR_MS) {
      throw incierto(p.numero, "todavía es pronto para conciliarlo");
    }
    const q = await consultarComprobante(ambiente, cred, c.puntoVenta, c.tipo, p.numero, fetchFn);
    if (q) {
      if (coincide(q, c)) return recuperar(q);
      const e = new ErrorArca("pendiente_no_coincide", `ARCA tiene otro comprobante con el número ${p.numero}`);
      e.numero = p.numero;
      throw e;
    }
    const u = await ultimoAutorizado(ambiente, cred, c.puntoVenta, c.tipo, fetchFn);
    if (u >= p.numero) {
      const e = new ErrorArca("pendiente_no_coincide", `ARCA ya pasó el número ${p.numero} pero no lo encuentra`);
      e.numero = p.numero;
      throw e;
    }
    // ARCA no lo tiene y no llegó a ese número: el pendiente nunca quedó. Se sigue como una emisión nueva.
  }

  for (let intento = 1; intento <= 3; intento++) {
    const numero = (await ultimoAutorizado(ambiente, cred, c.puntoVenta, c.tipo, fetchFn)) + 1;
    await o.antesDeEnviar(numero);
    let r: Resultado;
    try {
      r = await pedirCAE(ambiente, cred, c, numero, fetchFn);
    } catch (e) {
      // Una falla después de mandar deja la duda: se mira si quedó, y si no se puede saber, queda «incierto».
      let q: Consulta | null = null;
      try {
        q = await consultarComprobante(ambiente, cred, c.puntoVenta, c.tipo, numero, fetchFn);
      } catch {
        // sigue la duda
      }
      if (q && coincide(q, c)) return recuperar(q);
      throw incierto(numero, e instanceof ErrorArca ? e.codigo : "falla al mandar");
    }
    const desfasado = r.resultado === "R" && [...r.errores, ...r.observaciones].some((x) => x.codigo === 10016);
    if (desfasado && intento < 3) continue; // otro tomó el número: se pide el último de nuevo
    return { ...r, recuperado: false };
  }
  throw new ErrorArca("sin_numero", "No se pudo conseguir el número que sigue después de 3 intentos");
}
