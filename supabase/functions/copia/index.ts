// Función de Supabase «copia»: entrega la copia de seguridad de todos los días, ya cifrada.
//
// La pide GitHub todas las noches (.github/workflows/copia-diaria.yml) con un POST y la cabecera x-entreturno-copia. Sin esa clave no
// se hace nada. Y quien tenga la clave se lleva solo un archivo cifrado: para leerlo hace falta la llave privada de Entreturno, que no
// está en ningún servidor (ver copia/ y el LEEME, «Copia de seguridad»).
// Después de guardarla, GitHub vuelve a llamar con la cabecera x-entreturno-guardada (la huella del archivo): recién ahí cuenta como hecha.
//
// Secretos (Supabase → Edge Functions → Secrets; lo pega Santiago y nunca va al repositorio):
//   COPIA_CLAVE    la clave con la que GitHub pide la copia (la misma que está en los secretos del repositorio)
// Las llaves PÚBLICAS están en _compartido/copia-llaves.ts (son públicas: sirven para cerrar, no para abrir).
//
// Se despliega SIN «Enforce JWT verification». Para subirla desde el panel: publicar/armar_funcion.mjs la deja en un solo archivo
// (publicar/funcion-copia/index.ts).
import { cifrarCopia, huellaDe, mismaClave } from "../_compartido/copia.ts";
import { LLAVES_DE_COPIA } from "../_compartido/copia-llaves.ts";

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

/** Un secreto cargado a mano: sin los espacios que sobren, y vacío si son los puntitos con que un panel tapa la clave. */
function secretoDe(nombre: string): string {
  const v = (Deno.env.get(nombre) ?? "").trim();
  return /^[•·*●.]+$/.test(v) ? "" : v;
}

Deno.serve(async (req: Request) => {
  const responder = (estado: number, cuerpo: unknown) =>
    new Response(JSON.stringify(cuerpo), { status: estado, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  if (req.method !== "POST") return responder(405, { code: "metodo_no_permitido" });

  const esperada = secretoDe("COPIA_CLAVE");
  const supabase = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, "");
  const secreta = claveDeSupabase("SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEYS");
  if (esperada.length < 32 || !supabase || !secreta || !LLAVES_DE_COPIA.length) return responder(500, { code: "falta_configurar" });
  if (!(await mismaClave((req.headers.get("x-entreturno-copia") ?? "").trim(), esperada))) return responder(401, { code: "sin_permiso" });

  const comoServicio: Record<string, string> = secreta.startsWith("sb_secret_")
    ? { apikey: secreta }
    : { apikey: secreta, Authorization: `Bearer ${secreta}` };
  const rpc = async (funcion: string, args: Record<string, unknown>): Promise<string> => {
    const r = await fetch(`${supabase}/rest/v1/rpc/${funcion}`, {
      method: "POST", headers: { ...comoServicio, "Content-Type": "application/json" }, body: JSON.stringify(args),
    });
    const t = await r.text();
    if (!r.ok) throw new Error(`la base contestó ${r.status} a ${funcion}`);       // sin el cuerpo: podría traer datos
    return t;
  };

  try {
    const guardada = (req.headers.get("x-entreturno-guardada") ?? "").trim();
    if (guardada) {
      if (!/^[0-9a-f]{64}$/.test(guardada)) return responder(400, { code: "dato_invalido" });
      return (await rpc("copia_guardada", { p_huella: guardada })).trim() === "true" ? responder(200, { ok: true }) : responder(404, { code: "copia_desconocida" });
    }
    const datos = await rpc("copia_datos", {});
    // si no vino entera, mejor que falle acá (y se note) que guardar una copia que no sirve
    if (!datos.startsWith("{") || !datos.endsWith("}") || !datos.includes('"public.consultorios"') || !datos.includes('"auth.users"')) {
      throw new Error("la base no entregó los datos completos");
    }
    const archivo = await cifrarCopia({ contenido: datos, llaves: LLAVES_DE_COPIA, hecha: new Date().toISOString() });
    const huella = await huellaDe(archivo);
    await rpc("copia_anotar", { p_bytes: archivo.length, p_datos: datos.length, p_huella: huella, p_llaves: LLAVES_DE_COPIA.map((l) => l.id).join(",") });
    return new Response(archivo, {
      headers: { "Content-Type": "application/octet-stream", "Cache-Control": "no-store", "x-copia-huella": huella },
    });
  } catch (e) {
    console.error("copia: falla", e instanceof Error ? e.message : typeof e);       // los mensajes son los de arriba: no llevan datos
    return responder(500, { code: "falla" });
  }
});
