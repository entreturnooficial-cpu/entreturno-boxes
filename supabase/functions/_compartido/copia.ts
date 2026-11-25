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
