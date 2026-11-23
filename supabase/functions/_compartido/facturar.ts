// Lo que hace la función de Supabase «facturar»: «Facturar todo el mes» y «Probar la conexión con ARCA».
//
// Corre igual en Supabase (Deno) y en las pruebas (Node 24): todo lo de afuera (la base, la firma, la red) llega en `dep`.
// La base decide qué se factura (facturacion_preparar, con el pase de la dueña); acá solo se habla con ARCA y se anota
// cada paso en la base, de a una factura por vez y con el candado de cada numeración tomado.
//
// Reglas (revisiones 4 y 5 de Codex):
// - Cada factura sale con el candado de SU numeración (ambiente + CUIT + punto de venta + tipo). Una «incierta» se
//   concilia con la numeración con la que se mandó, aunque después haya cambiado la configuración.
// - Primero se concilian las «inciertas». Si alguna sigue en duda, NO se emite ninguna otra en esta corrida: podría
//   pelear por el mismo número mientras ARCA todavía procesa la anterior.
// - La base anota el número solo si el candado sigue siendo de esta corrida y si lo que se va a mandar es exactamente lo
//   que quedó congelado (huella); si no, esa factura no se manda.
// - El ticket se pide de a uno por ambiente (otro candado) y se guarda en la base.

import {
  CONCEPTO,
  ErrorArca,
  TIPO,
  emitirComprobante,
  estadoServidores,
  obtenerTicket,
  puntosVenta,
  ticketVigente,
  ultimoAutorizado,
} from "./arca.ts";
import type { Ambiente, Ticket } from "./arca.ts";

// deno-lint-ignore no-explicit-any
type Json = any;

export type Dependencias = {
  /** Llama una función de la base con el pase de quien hizo el pedido (así la base revisa que sea la dueña). */
  rpcUsuario: (funcion: string, args: Record<string, unknown>) => Promise<Json>;
  /** Llama una función de la base con la clave secreta (solo las «arca_…»). */
  rpcServicio: (funcion: string, args: Record<string, unknown>) => Promise<Json>;
  /** Firma el pedido de acceso con el certificado de ese ambiente. */
  firmar: (ambiente: Ambiente, tra: string) => string | Promise<string>;
  /** En prueba se factura con la CUIT autorizada en el WSASS (la de Entreturno), no con la del consultorio. */
  prueba: { cuit: string; puntoVenta: number };
  fetchFn?: typeof fetch;
  ahora?: () => Date;
  dormir?: (ms: number) => Promise<void>;
  /** Nombre de quien toma los candados (por defecto, uno al azar). */
  dueno?: string;
};

export type Resumen = {
  ambiente: string;
  periodo: string;
  emitidas: { userId: string; numero: number; cae: string | null }[];
  rechazadas: { userId: string; motivo: string }[];
  inciertas: { userId: string; numero: number | null }[];
  revisar: { userId: string; name: string }[];
  faltan: { userId: string; name: string; missing: string }[];
  /** Las que no se intentaron en esta corrida (quedan para la próxima) y por qué. */
  sinIntentar: { userId: string; motivo: string }[];
  error?: { codigo: string; mensaje: string };
};

const SEGUNDOS_CANDADO = 300;
const SEGUNDOS_CANDADO_TICKET = 60;

const mensajeDe = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Un ticket vigente para ese ambiente: el guardado o uno nuevo, pedido de a uno (candado «ticket:ambiente»). */
async function ticketDe(dep: Dependencias, ambiente: Ambiente, dueno: string): Promise<Ticket> {
  const dormir = dep.dormir ?? ((ms: number) => new Promise<void>((listo) => setTimeout(listo, ms)));
  const leer = () => dep.rpcServicio("arca_ticket", { p_ambiente: ambiente });
  const guardado = await leer();
  if (ticketVigente(guardado)) return guardado;
  const clave = `ticket:${ambiente}`;
  for (let intento = 1; ; intento++) {
    if (await dep.rpcServicio("arca_candado", { p_clave: clave, p_dueno: dueno, p_segundos: SEGUNDOS_CANDADO_TICKET })) break;
    if (intento >= 10) throw new ErrorArca("ocupado", "Otra corrida está pidiendo el acceso a ARCA: probá de nuevo en un minuto");
    await dormir(1000);
    const otro = await leer(); // la otra corrida lo pudo haber guardado recién
    if (ticketVigente(otro)) return otro;
  }
  try {
    return await obtenerTicket({
      ambiente,
      leer,
      guardar: async (t: Ticket) => {
        await dep.rpcServicio("arca_guardar_ticket", { p_ambiente: ambiente, p_token: t.token, p_sign: t.sign, p_vence: t.vence });
      },
      firmar: (tra: string) => dep.firmar(ambiente, tra),
      fetchFn: dep.fetchFn,
      dormir: dep.dormir,
    });
  } finally {
    try {
      await dep.rpcServicio("arca_candado", { p_clave: clave, p_dueno: dueno, p_segundos: 0 });
    } catch {
      // vence solo en un minuto
    }
  }
}

function emisorDe(dep: Dependencias, ambiente: Ambiente, base: { emisorCuit: string; puntoVenta: number }) {
  return ambiente === "prueba" ? { cuit: dep.prueba.cuit, puntoVenta: dep.prueba.puntoVenta } : { cuit: base.emisorCuit, puntoVenta: base.puntoVenta };
}

const textoDe = (avisos: { codigo: number; mensaje: string }[]) => avisos.map((a) => `${a.codigo}: ${a.mensaje}`).join(" | ");

/** «Facturar todo el mes»: concilia las dudas y emite una factura por profesional. Lo que no se pudo queda para la próxima. */
export async function facturarMes(dep: Dependencias, slug: string, periodo: string): Promise<Resumen> {
  const prep = await dep.rpcUsuario("facturacion_preparar", { p_slug: slug, p_periodo: periodo });
  const ambiente = prep.ambiente as Ambiente;
  const emisor = emisorDe(dep, ambiente, prep);
  const resumen: Resumen = {
    ambiente, periodo, emitidas: [], rechazadas: [], inciertas: [], revisar: [...prep.revisar], faltan: [...prep.faltan], sinIntentar: [],
  };
  if (!prep.emitir.length) return resumen;
  if (!/^\d{11}$/.test(emisor.cuit)) {
    resumen.error = { codigo: "faltan_datos_facturacion", mensaje: "Falta la CUIT con la que se factura" };
    return resumen;
  }

  const dueno = dep.dueno ?? crypto.randomUUID();
  const tomados = new Set<string>();
  /** Toma (o renueva) el candado de una numeración; si es de otra corrida, corta. */
  const tomar = async (cuit: string, puntoVenta: number) => {
    const clave = `${ambiente}:${cuit}:${puntoVenta}:${TIPO.factura.C}`;
    const ok = await dep.rpcServicio("arca_candado", { p_clave: clave, p_dueno: dueno, p_segundos: SEGUNDOS_CANDADO });
    if (!ok) throw new ErrorArca("ocupado", "Ya se está facturando: probá de nuevo en un par de minutos");
    tomados.add(clave);
  };
  const quedanSinIntentar = (desde: number, motivo: string) => {
    for (const f of prep.emitir.slice(desde)) resumen.sinIntentar.push({ userId: f.userId, motivo });
  };

  try {
    await tomar(emisor.cuit, emisor.puntoVenta);
    const ticket = await ticketDe(dep, ambiente, dueno);
    for (let i = 0; i < prep.emitir.length; i++) {
      const fila = prep.emitir[i];
      const cuit = fila.emisorCuit ?? emisor.cuit; // una «incierta» se concilia con lo que quedó anotado
      const puntoVenta = fila.puntoVenta ?? emisor.puntoVenta;
      await tomar(cuit, puntoVenta);
      const comprobante = { ...fila.comprobante, puntoVenta, concepto: CONCEPTO.servicios };
      try {
        const r = await emitirComprobante({
          ambiente,
          cred: { token: ticket.token, sign: ticket.sign, cuit },
          comprobante,
          antesDeEnviar: async (numero: number) => {
            await dep.rpcServicio("arca_anotar", {
              p_factura: fila.id, p_emisor_cuit: cuit, p_punto_venta: puntoVenta, p_numero: numero, p_version: fila.version, p_dueno: dueno,
            });
          },
          pendiente: fila.estado === "incierta" && fila.numero ? { numero: fila.numero, desde: fila.anotadoEn } : null,
          fetchFn: dep.fetchFn,
          ahora: dep.ahora?.(),
        });
        const avisos = [...r.errores, ...r.observaciones];
        if (r.resultado === "A") {
          await dep.rpcServicio("arca_resultado", {
            p_factura: fila.id, p_estado: "emitida", p_cae: r.cae, p_cae_vence: r.caeVence, p_observaciones: avisos,
          });
          resumen.emitidas.push({ userId: fila.userId, numero: r.numero, cae: r.cae });
        } else {
          await dep.rpcServicio("arca_resultado", {
            p_factura: fila.id, p_estado: "rechazada", p_cae: null, p_cae_vence: null, p_observaciones: avisos,
          });
          resumen.rechazadas.push({ userId: fila.userId, motivo: textoDe(avisos) || "ARCA la rechazó sin decir por qué" });
        }
      } catch (e) {
        if (e instanceof ErrorArca && e.codigo === "incierto") {
          // queda «incierta» con su número; hasta conciliarla no se emite ninguna otra (podría pelear por el número)
          resumen.inciertas.push({ userId: fila.userId, numero: e.numero });
          quedanSinIntentar(i + 1, "Hay una factura en duda: primero se concilia");
          break;
        }
        if (e instanceof ErrorArca && e.codigo === "pendiente_no_coincide") {
          await dep.rpcServicio("arca_resultado", {
            p_factura: fila.id, p_estado: "revisar", p_cae: null, p_cae_vence: null, p_observaciones: [{ codigo: 0, mensaje: e.message }],
          });
          resumen.revisar.push({ userId: fila.userId, name: fila.name ?? "" });
          continue;
        }
        if (mensajeDe(e) === "factura_cambio") {
          // cambió lo que había que mandar (otra corrida la preparó de nuevo): no se mandó nada; va en la próxima
          resumen.sinIntentar.push({ userId: fila.userId, motivo: "Cambió mientras se facturaba: volvé a facturar" });
          continue;
        }
        if (mensajeDe(e) === "candado_perdido") throw new ErrorArca("ocupado", "Ya se está facturando: probá de nuevo en un par de minutos");
        throw e; // otra cosa (ARCA caída, el ticket, la base): se corta acá; lo que ya salió quedó anotado
      }
    }
  } catch (e) {
    resumen.error = { codigo: e instanceof ErrorArca ? e.codigo : "falla", mensaje: mensajeDe(e) };
  } finally {
    for (const clave of tomados) {
      try {
        await dep.rpcServicio("arca_candado", { p_clave: clave, p_dueno: dueno, p_segundos: 0 });
      } catch {
        // vence solo en unos minutos
      }
    }
  }
  return resumen;
}

/** «Probar la conexión con ARCA»: servidores, ticket, puntos de venta de la CUIT y último número. No emite nada. */
export async function probarConexion(dep: Dependencias, slug: string) {
  const est = await dep.rpcUsuario("facturacion_estado", { p_slug: slug });
  if (est.ambiente === "apagado") return { ambiente: "apagado" };
  const ambiente = est.ambiente as Ambiente;
  const emisor = emisorDe(dep, ambiente, est);
  const fetchFn = dep.fetchFn ?? fetch;
  const salida: Json = { ambiente, puntoVenta: emisor.puntoVenta };
  try {
    salida.servidores = await estadoServidores(ambiente, fetchFn);
    const ticket = await ticketDe(dep, ambiente, dep.dueno ?? crypto.randomUUID());
    salida.ticketVence = ticket.vence;
    const cred = { token: ticket.token, sign: ticket.sign, cuit: emisor.cuit };
    salida.puntosVenta = (await puntosVenta(ambiente, cred, fetchFn)).map((p) => p.numero);
    salida.ultimoNumero = await ultimoAutorizado(ambiente, cred, emisor.puntoVenta, TIPO.factura.C, fetchFn);
    salida.ok = true;
  } catch (e) {
    salida.ok = false;
    salida.error = { codigo: e instanceof ErrorArca ? e.codigo : "falla", mensaje: mensajeDe(e) };
  }
  return salida;
}

/**
 * Un certificado o una clave guardados como secreto pueden llegar con los saltos de línea perdidos (al pegarlos en un
 * campo de una sola línea), con «\n» escritos, o enteros en base64. Esto los deja como PEM de nuevo.
 */
export function normalizarPem(valor: string): string {
  let v = String(valor ?? "").trim().replace(/\\n/g, "\n");
  if (!v.includes("-----BEGIN")) {
    try {
      const decodificado = atob(v.replace(/\s+/g, ""));
      if (decodificado.includes("-----BEGIN")) v = decodificado;
    } catch {
      // no era base64
    }
  }
  const m = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/.exec(v);
  if (!m) throw new ErrorArca("certificado_invalido", "No se pudo leer el certificado o la clave guardados");
  const cuerpo = m[2].replace(/\s+/g, "");
  const lineas = cuerpo.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${m[1]}-----\n${lineas.join("\n")}\n-----END ${m[1]}-----\n`;
}
