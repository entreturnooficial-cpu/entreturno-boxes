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

import {
  ErrorMp,
  aleatorio,
  cancelarOrden,
  canjearCodigo,
  crearOrden,
  cuerpoDeOrden,
  desafioDe,
  devolverOrden,
  esDireccionDePago,
  leerOrden,
  quienSoy,
  renovarPase,
  urlAutorizar,
} from "./mp.ts";
import type { Orden } from "./mp.ts";

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
    /** El pase de prueba de la aplicación: con ese se cobra en «prueba» si el consultorio no conectó su cuenta. */
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

/** Con qué pase se cobra en ese consultorio: el de su cuenta o, en «prueba» y sin cuenta, el de prueba de Entreturno. */
async function credencialDe(dep: DependenciasMp, consultorio: string): Promise<Credencial> {
  const c = await dep.rpcServicio("mp_credencial", { p_consultorio: consultorio });
  if (c?.acceso) return { acceso: c.acceso, usuario: c.cuenta?.userId ?? null, propia: true, ambiente: c.ambiente };
  if (c?.ambiente === "prueba") {
    if (!dep.app.paseDePrueba) throw new ErrorDeCobro("falta_configurar");
    return { acceso: dep.app.paseDePrueba, usuario: null, propia: false, ambiente: "prueba" };
  }
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
    // en «real» no sirve un pase de prueba
    if (t.ambiente === "real" && p.real === false) return { volverA: t.volverA, ok: false, motivo: "ambiente" };
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
    orden = await conPase(dep, prep.consultorio, (c) => crearOrden({
      acceso: c.acceso, clave: prep.clave, fetchFn: dep.fetchFn,
      cuerpo: cuerpoDeOrden({
        monto: prep.monto, referencia: prep.pago, titulo: prep.titulo, descripcion: prep.descripcion,
        email: c.ambiente === "real" ? prep.email : null,        // en prueba, Mercado Pago pide el mail en su pantalla
        minutos: prep.minutos, volverA,
      }),
    }));
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
  let leida: { o: Orden; usuario: string | null };
  try {
    leida = await conPase(dep, info.consultorio, async (c) => ({
      o: await leerOrden({ acceso: c.acceso, orden: id, fetchFn: dep.fetchFn }), usuario: c.usuario,
    }));
  } catch (e) {
    if (e instanceof ErrorMp && e.estado === 404) return { estado: info.estado ?? "pendiente", sinOrden: true };
    throw e;
  }
  const o = leida.o;
  const esDeEstePago = o.referencia === info.pago && o.moneda === "ARS" && Math.round(o.total) === info.monto
    && (leida.usuario === null || o.usuario === leida.usuario);
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
