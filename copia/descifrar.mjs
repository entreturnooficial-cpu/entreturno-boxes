// Abrir una copia de seguridad (.ecopia) con la llave privada. Corre en la compu, nunca en un servidor.
import { constants, createDecipheriv, privateDecrypt } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

const MARCA = Buffer.from('ECOPIA1\n');

/** El encabezado (no tiene datos: versión, fecha y con qué llaves se abre). */
export function encabezadoDe(archivo) {
  if (!archivo.subarray(0, MARCA.length).equals(MARCA)) throw new Error('Eso no es una copia de Entreturno.');
  const fin = archivo.indexOf(10, MARCA.length);
  if (fin < 0) throw new Error('La copia está cortada.');
  const crudo = archivo.subarray(MARCA.length, fin);
  let e;
  try {
    e = JSON.parse(crudo.toString('utf8'));
  } catch {
    throw new Error('La copia está dañada (el encabezado no se entiende).');
  }
  if (e.v !== 1) throw new Error(`Esta copia es de una versión que este programa no conoce (${e.v}).`);
  return { ...e, crudo, contenido: archivo.subarray(fin + 1) };
}

/** Los datos, tal como los entregó la base (texto JSON). Si alguien tocó una letra del archivo, da error. */
export function descifrarCopia(archivo, privada, id) {
  const e = encabezadoDe(archivo);
  const l = e.llaves.find((x) => x.id === id);
  if (!l) throw new Error(`Esta copia no se abre con la llave «${id}». Se abre con: ${e.llaves.map((x) => x.id).join(', ')}.`);
  try {
    const clave = privateDecrypt({ key: privada, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(l.clave, 'base64'));
    const sello = e.contenido.subarray(e.contenido.length - 16);
    const d = createDecipheriv('aes-256-gcm', clave, Buffer.from(e.iv, 'base64'));
    d.setAAD(e.crudo);
    d.setAuthTag(sello);
    return gunzipSync(Buffer.concat([d.update(e.contenido.subarray(0, e.contenido.length - 16)), d.final()])).toString('utf8');
  } catch {
    throw new Error('La copia está dañada, o la llave no es la que corresponde.');
  }
}
