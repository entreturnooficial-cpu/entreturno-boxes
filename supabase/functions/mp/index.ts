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
//   MP_WEBHOOK_SECRETO               la «firma secreta» de la aplicación (Webhooks → Configurar notificaciones)
//   MP_PRUEBA_TOKEN                  el Access Token de PRUEBA de la aplicación: con ese se cobra en modo prueba cuando
//                                    el consultorio todavía no conectó su cuenta
//
// En la aplicación de Mercado Pago hay que cargar la dirección de esta función (https://<proyecto>.supabase.co/functions/v1/mp)
// como «URL de redireccionamiento» y como dirección de Webhooks (eventos «Order (Mercado Pago)» y «Vinculación de aplicaciones»).
//
// Se despliega SIN «Enforce JWT verification», igual que «facturar». Para subirla desde el panel:
// publicar/armar_funcion.mjs la deja en un solo archivo (publicar/funcion-mp/index.ts).
import { ErrorDeCobro, avisoDeMp, despachar, iniciarConexion, pagar, terminarConexion, verificar, vueltaDelReloj } from "../_compartido/cobros.ts";
import type { DependenciasMp } from "../_compartido/cobros.ts";
import { firmaValida } from "../_compartido/mp.ts";

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
      clientId: (Deno.env.get("MP_CLIENT_ID") ?? "").trim(),
      clientSecret: (Deno.env.get("MP_CLIENT_SECRET") ?? "").trim(),
      redirectUri: `${supabase}/functions/v1/mp`,
      paseDePrueba: (Deno.env.get("MP_PRUEBA_TOKEN") ?? "").trim(),
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
      const secreto = (Deno.env.get("MP_WEBHOOK_SECRETO") ?? "").trim();
      if (!secreto) return responder(500, { code: "falta_configurar" });
      const dato = url.searchParams.get("data.id") ?? "";
      // una firma de hace más de dos días ya no vale (para entonces el reloj ya miró esa orden por su cuenta)
      const firmaOk = await firmaValida({ firma, pedido: req.headers.get("x-request-id"), dato, secreto, maxAntiguedadSeg: 2 * 86400 });
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
