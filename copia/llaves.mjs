// Las llaves con las que se cierran y se abren las copias de seguridad.
//   - La PÚBLICA cierra: va en supabase/functions/_compartido/copia-llaves.ts. No es secreta.
//   - La PRIVADA abre: queda en la compu de su dueño, protegida con una frase. Sin la frase el archivo no sirve.
// La frase no se guarda en ningún lado: si se pierde, esa llave no abre más nada. Por eso conviene que haya dos llaves, de dos personas.
import { createHash, generateKeyPairSync, randomBytes, randomInt, scryptSync, createCipheriv, createDecipheriv, createPrivateKey } from 'node:crypto';

// 2^17 vueltas: casi medio segundo por intento, para que probar frases una por una no sea negocio
const SCRYPT = { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };

// Palabras cortas, comunes, sin tildes ni eñes, que no se confunden entre sí (256: cada una suma 8 bits)
const PALABRAS = `abeja abrigo aceite aguja aldea alfombra almohada alto amigo ancla anillo antena arco arena armario arroz asado atlas avion azul
bahia balde banco barco barrio baston bicho bigote bolsa bomba bosque botella brazo brillo brujula buzon caballo cabra cafe caja calle camino
campana canasta cancha canela capa caracol carpeta carro casa cascada castillo cebolla ceja cesped cielo cinta ciruela clavo cobre cocina codo
cohete colina collar cometa copa corona cortina costa cristal cuadro cuaderno cuchara cuerda cueva dado dedo delfin desfile diario dibujo diente
disco domingo ducha dulce durazno eco edad elefante enano encaje enero escalera escoba escudo esfera espejo espiga estante estrella faro farol
feria fiesta fila flauta flecha flor foca fogon foto fresa frio fruta fuego fuente gaita galleta gallo ganso garza gato gaviota globo golpe gorra
gota granja grillo grua guante guitarra hacha hada hamaca harina helado hielo hierro higo hilo hoja hongo horno huella hueso humo iglesia imagen
isla jabon jardin jarra jaula jefe jirafa joya juego jugo julio junco lago lana lapiz lata leche lechuga lente leon letra libro limon linterna
llave lluvia lobo loro luna madera mago maiz maleta mango mano manta mapa mar marco mariposa martillo mate melon menta mesa metal miel mono
montana moto muelle mundo muro nave nido niebla nieve nube nuez oasis obra oca oliva olla onda oreja oro oso oveja pala palma paloma pan papel
pasto pato perla pez piano piedra pino pluma pozo puente`.split(/\s+/);

/** Una frase de seis palabras al azar. */
export function fraseNueva(cuantas = 6) {
  return Array.from({ length: cuantas }, () => PALABRAS[randomInt(PALABRAS.length)]).join(' ');
}

/** Se escribe a mano: da igual mayúsculas, tildes o espacios de más. */
export const normalizar = (frase) => frase.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim().split(/\s+/).join(' ');

/** Un par nuevo. `privada` ya viene protegida con la frase (se puede guardar en un pendrive o en la nube). */
export function generarPar(frase, dueno) {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 4096, publicKeyEncoding: { type: 'spki', format: 'der' }, privateKeyEncoding: { type: 'pkcs8', format: 'der' } });
  const id = `${dueno.normalize('NFD').replace(/[^a-zA-Z]/g, '').toLowerCase().slice(0, 12)}-${createHash('sha256').update(publicKey).digest('hex').slice(0, 8)}`;
  const sal = randomBytes(16);
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', scryptSync(normalizar(frase), sal, 32, SCRYPT), iv);
  c.setAAD(Buffer.from(id));
  const cerrada = Buffer.concat([c.update(privateKey), c.final()]);
  return {
    publica: { id, spki: publicKey.toString('base64') },
    privada: { que: 'Llave privada de las copias de Entreturno. Se abre con la frase de su dueño.', id, sal: sal.toString('base64'), iv: iv.toString('base64'),
      sello: c.getAuthTag().toString('base64'), llave: cerrada.toString('base64') },
  };
}

/** La llave privada lista para usar, o un error claro si la frase no es. */
export function abrirPrivada(privada, frase) {
  const d = createDecipheriv('aes-256-gcm', scryptSync(normalizar(frase), Buffer.from(privada.sal, 'base64'), 32, SCRYPT), Buffer.from(privada.iv, 'base64'));
  d.setAAD(Buffer.from(privada.id));
  d.setAuthTag(Buffer.from(privada.sello, 'base64'));
  try {
    return createPrivateKey({ key: Buffer.concat([d.update(Buffer.from(privada.llave, 'base64')), d.final()]), format: 'der', type: 'pkcs8' });
  } catch {
    throw new Error('Esa no es la frase de esta llave (o el archivo de la llave está dañado).');
  }
}

export const cuantasPalabras = new Set(PALABRAS).size;
