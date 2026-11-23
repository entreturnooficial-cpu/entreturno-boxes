// Función de Supabase «facturar»: «Facturar todo el mes» y «Probar la conexión con ARCA».
//
// La llama la página (web/conexion.js → servidor.funcion("facturar", { accion, periodo })) con el pase de quien está
// adentro. No decide nada sola: la base revisa que sea la dueña y arma lo que hay que facturar
// (facturacion_preparar); acá solo se habla con ARCA y se anota cada paso (supabase/functions/_compartido/facturar.ts).
//
// Secretos (Supabase → Edge Functions → Secrets; los carga Santiago y nunca van al repositorio):
//   ARCA_PRUEBA_CERT, ARCA_PRUEBA_CLAVE  certificado y clave de PRUEBA (WSASS)
//   ARCA_PRUEBA_CUIT                     la CUIT autorizada en el WSASS (en prueba se factura con esa)
//   ARCA_REAL_CERT, ARCA_REAL_CLAVE      certificado y clave reales de Entreturno (para facturar de verdad)
// Los certificados se pueden pegar tal cual, aunque el campo los deje en una sola línea (normalizarPem los arregla).
//
// Se despliega SIN «Enforce JWT verification»: el pase lo revisa la base en cada llamada (y así responde el aviso
// previo del navegador, que llega sin pase). Para subirla desde el panel: publicar/armar_funcion.mjs la deja en un
// solo archivo.
import forge from "npm:node-forge@1.4.3";
import { ErrorArca, firmarTRA } from "../_compartido/arca.ts";
import type { Ambiente } from "../_compartido/arca.ts";
import { facturarMes, normalizarPem, probarConexion } from "../_compartido/facturar.ts";
import type { Dependencias } from "../_compartido/facturar.ts";

const ORIGEN_PERMITIDO =
  /^https:\/\/([a-z0-9-]+\.)?entreturno\.com\.ar$|^https:\/\/([a-z0-9-]+\.)?[a-z0-9-]+-entreturno\.pages\.dev$|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

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
  if (req.method !== "POST") return responder(405, { code: "metodo_no_permitido" });

  const pase = req.headers.get("Authorization") ?? "";
  if (!/^Bearer [\w.-]+$/.test(pase)) return responder(401, { code: "sin_sesion" });
  let pedido: { accion?: unknown; slug?: unknown; periodo?: unknown };
  try {
    pedido = await req.json();
  } catch {
    return responder(400, { code: "dato_invalido" });
  }

  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const publica = claveDeSupabase("SUPABASE_ANON_KEY", "SUPABASE_PUBLISHABLE_KEYS");
  const secreta = claveDeSupabase("SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEYS");
  if (!url || !publica || !secreta) return responder(500, { code: "falta_configurar" });
  const comoServicio: Record<string, string> = secreta.startsWith("sb_secret_")
    ? { apikey: secreta }
    : { apikey: secreta, Authorization: `Bearer ${secreta}` };

  async function rpc(funcion: string, args: Record<string, unknown>, cabeceras: Record<string, string>) {
    const r = await fetch(`${url}/rest/v1/rpc/${funcion}`, {
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

  const secretoDe = (nombre: string) => {
    const v = Deno.env.get(nombre);
    if (!v) throw new ErrorArca("falta_configurar", `Falta cargar ${nombre} en los secretos de la función`);
    return normalizarPem(v);
  };
  const dep: Dependencias = {
    rpcUsuario: (fn, args) => rpc(fn, args, { apikey: publica, Authorization: pase }),
    rpcServicio: (fn, args) => rpc(fn, args, comoServicio),
    firmar: (ambiente: Ambiente, tra: string) => {
      const sufijo = ambiente === "prueba" ? "PRUEBA" : "REAL";
      return firmarTRA(forge, tra, secretoDe(`ARCA_${sufijo}_CERT`), secretoDe(`ARCA_${sufijo}_CLAVE`));
    },
    prueba: {
      cuit: (Deno.env.get("ARCA_PRUEBA_CUIT") ?? "").replace(/\D/g, ""),
      puntoVenta: Number(Deno.env.get("ARCA_PRUEBA_PUNTO_VENTA") ?? "1") || 1,
    },
  };

  try {
    const slug = String(pedido.slug ?? "");
    if (pedido.accion === "facturar") return responder(200, await facturarMes(dep, slug, String(pedido.periodo ?? "")));
    if (pedido.accion === "probar") return responder(200, await probarConexion(dep, slug));
    return responder(400, { code: "dato_invalido" });
  } catch (e) {
    if (e instanceof ErrorDeBase) return responder(e.estado === 401 ? 401 : e.estado >= 500 ? 502 : 400, { code: e.codigo });
    // sin detalles en los registros: nada de pases, tickets ni claves
    console.error("facturar: falla", e instanceof Error ? e.name : typeof e);
    return responder(500, { code: "falla" });
  }
});
