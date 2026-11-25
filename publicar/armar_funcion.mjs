// Arma las funciones de Supabase en UN solo archivo cada una, para pegarlas en el editor del panel de Supabase
// (Edge Functions → «Deploy a new function» → «Via Editor»), que no ve la carpeta _compartido.
//
//   node publicar/armar_funcion.mjs     →  publicar/funcion-facturar/index.ts   (facturas con ARCA)
//                                          publicar/funcion-mp/index.ts         (cobro con Mercado Pago)
//
// Junta los archivos de _compartido con el index de cada función, sacando los import entre ellos. Los nombres no se
// pisan: lo controlan pruebas/funcion.test.mjs y pruebas/funcion-mp.test.mjs, que además corren estos mismos archivos armados.
// La única dependencia de afuera es npm:node-forge, y solo en «facturar».
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const raiz = new URL('../supabase/functions/', import.meta.url);
const leer = (ruta) => readFileSync(new URL(ruta, raiz), 'utf8');
// los import entre nuestros archivos (de una o varias líneas, siempre con llaves)
const sinImportsLocales = (t) => t.replace(/^import\s+(?:type\s+)?\{[^}]*\}\s+from\s+"\.\.?\/[^"]*";\n/gm, '');

function armar(nombre, compartidos, { conForge = false } = {}) {
  let entrada = leer(`${nombre}/index.ts`);
  const partes = [];
  if (conForge) {
    const forge = /^import forge from "npm:node-forge@[\d.]+";\n/m.exec(entrada)?.[0];
    if (!forge) throw new Error(`${nombre}/index.ts tiene que importar node-forge con versión fija`);
    partes.push(forge);
    entrada = entrada.replace(forge, '');
  }
  compartidos.forEach((archivo, i) => {
    partes.push(`${i ? '\n' : ''}// ============ _compartido/${archivo} ============\n`);
    // el primero no tiene imports de los nuestros; los demás sí
    partes.push(i ? sinImportsLocales(leer(`_compartido/${archivo}`)) : leer(`_compartido/${archivo}`));
  });
  partes.push(`\n// ============ ${nombre}/index.ts ============\n`, sinImportsLocales(entrada));
  const todo = `// ARMADO con publicar/armar_funcion.mjs: no editar acá, editar los originales en supabase/functions.\n${partes.join('')}`;
  if (/from\s+"\.\.?\//.test(todo)) throw new Error(`${nombre}: quedó un import local sin resolver`);
  if (!conForge && /^import\s/m.test(todo)) throw new Error(`${nombre}: no tendría que importar nada de afuera`);

  const salida = new URL(`funcion-${nombre}/`, import.meta.url);
  mkdirSync(salida, { recursive: true });
  writeFileSync(new URL('index.ts', salida), todo);
  console.log(`publicar/funcion-${nombre}/index.ts: ${todo.length} caracteres, sha256 ${createHash('sha256').update(todo).digest('hex').slice(0, 12)}`);
}

armar('facturar', ['arca.ts', 'facturar.ts'], { conForge: true });
armar('mp', ['mp.ts', 'cobros.ts']);
