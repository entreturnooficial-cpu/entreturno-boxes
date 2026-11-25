// ARMADO con publicar/armar_funcion.mjs: no editar acá, editar los originales en supabase/functions.
// ============ _compartido/copia.ts ============
// La copia de seguridad: cifrar lo que entrega la base para que se pueda abrir solo con la llave privada de Entreturno.
//
// El archivo (.ecopia) es:
//   ECOPIA1 y un salto de renglón
//   un encabezado en JSON, en un renglón: { v, hecha, iv, llaves: [{ id, clave }] }
//   el contenido: AES-256-GCM de gzip(datos), con el encabezado como dato autenticado (si alguien toca una letra, no abre)
// La clave AES es nueva en cada copia. Viaja adentro del encabezado, cifrada con RSA-OAEP para cada llave pública de la lista:
// con cualquiera de las llaves privadas que corresponden se puede abrir.
//
// Corre igual en Supabase (Deno) y en las pruebas (Node 24). Para abrirla: copia/descifrar.mjs (en la compu, nunca en un servidor).

export type LlavePublica = { /** corto, para saber con cuál se abre */ id: string; /** SPKI en base64 */ spki: string };

const letras = new TextEncoder();
export const MARCA_DE_COPIA = "ECOPIA1\n";


type Bytes = Uint8Array;

function aBase64(b: Uint8Array): string {
  let t = "";
  for (let i = 0; i < b.length; i += 8192) t += String.fromCharCode(...b.subarray(i, i + 8192));
  return btoa(t);
}

function deBase64(t: string): Bytes {
  return Uint8Array.from(atob(t), (c) => c.charCodeAt(0));
}

async function comprimir(b: Bytes): Promise<Bytes> {
  return new Uint8Array(await new Response(new Blob([b]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
}

/** El archivo cifrado. `contenido` son los datos tal como los entregó la base: no se tocan (ni se vuelven a armar). */
export async function cifrarCopia(p: { contenido: string; llaves: LlavePublica[]; hecha: string }): Promise<Bytes> {
  if (!p.llaves.length) throw new Error("no hay ninguna llave para cifrar la copia");
  const clave = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const llaves: { id: string; clave: string }[] = [];
  for (const l of p.llaves) {
    const rsa = await crypto.subtle.importKey("spki", deBase64(l.spki), { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
    llaves.push({ id: l.id, clave: aBase64(new Uint8Array(await crypto.subtle.encrypt({ name: "RSA-OAEP" }, rsa, clave))) });
  }
  const encabezado = letras.encode(JSON.stringify({ v: 1, hecha: p.hecha, iv: aBase64(iv), llaves }));
  const aes = await crypto.subtle.importKey("raw", clave, { name: "AES-GCM" }, false, ["encrypt"]);
  const cifrado = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encabezado }, aes, await comprimir(letras.encode(p.contenido))));
  const marca = letras.encode(MARCA_DE_COPIA);
  const todo = new Uint8Array(marca.length + encabezado.length + 1 + cifrado.length);
  todo.set(marca, 0);
  todo.set(encabezado, marca.length);
  todo[marca.length + encabezado.length] = 10;                 // salto de renglón
  todo.set(cifrado, marca.length + encabezado.length + 1);
  return todo;
}

async function sha256(b: Bytes): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", b));
}

/** El SHA-256 de unos bytes, en hexadecimal. */
export async function huellaDe(b: Bytes): Promise<string> {
  return Array.from(await sha256(b), (x) => x.toString(16).padStart(2, "0")).join("");
}

/** ¿Es la misma clave? Compara las huellas, sin cortar en la primera letra distinta. */
export async function mismaClave(a: string, b: string): Promise<boolean> {
  const [x, y] = [await sha256(letras.encode(a)), await sha256(letras.encode(b))];
  let distinto = 0;
  for (let i = 0; i < x.length; i++) distinto |= x[i] ^ y[i];
  return distinto === 0;
}

// ============ _compartido/copia-llaves.ts ============
// Las llaves PÚBLICAS con las que se cierran las copias de seguridad. Son públicas: con esto se puede cerrar una copia, no abrirla.
// Cada una la genera su dueño en su compu con copia/generar-llave.mjs; la privada queda con él (nunca en GitHub ni en Supabase).
// Con cualquiera de las privadas se abre la copia: conviene que haya dos, de dos personas.
// Agregar o sacar una vale desde la copia siguiente (las anteriores se abren con las llaves que había ese día).

export const LLAVES_DE_COPIA: LlavePublica[] = [
  // la de Santiago, generada el 25/11/2026
  {
    id: "santiago-aab9c821",
    spki: "MIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAy6iLVdo5Bw8Vx2g/+U3i1wKyKUlbC87RPuzSbZRB9PTGajNwR/E5LKm/iwVaFEY/PfzOiJKSAnTCu4yUp31LLJgcxe/k3e821CeNYJbNhyhjcWsRRTPL/3rPulTr+ybISneVrZdBzLbDy72NYRozhwBHSNkVJmbfrco2cI4JMLd0OlErSLWdTNqO2g4rz+5gLg5wDj4FAYSlPMiYCotEmONSluXiTHdhsUdyQhocXe7tRsR0g+kOSXzART8uULm4GJ4EvtksWCeKaKTvjWsh8+wlB2qFlkIepDxtQcOP/5dDRWALCN8UZNZB1N9kJzJj4Q10IXE0IHEMQq2EDD6x20MLOlGRgMeyLGyNLu+JjB9q0gf4kCnu6yMmQt7p7Dvmm9sHEL3QXXztdAnvmct69SEVPM9dUGQJJlCvg7/JfM70TYYLKgwpJpJ5c/Ovr4G5G1I8uT6Ghs22g522381E3ajzZUPEniXKyG4s/F0arJRoXnbGVEFYO3eQ3rjbwq8f5EmWSiBOQOeA0uSck1+mw9CQyd2131xK36a2Cn3wBpla9TJfMguTUEwBuKdtDg3qhi6FJWN+k+cns0TitipqQvX/03ROiV7sT5P+dLRxeUgj2OG4aZtGRcTD9eCN5GBX6MvuacMBBnjA72ssJpQSRLjzvZu6BH+qZ6suD5DpnNMCAwEAAQ==",
  },
];

// ============ copia/index.ts ============
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
