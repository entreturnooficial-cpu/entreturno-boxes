// Arma la función de Supabase «facturar» en UN solo archivo, para pegarla en el editor del panel de Supabase
// (Edge Functions → «Deploy a new function» → «Via Editor»), que no ve la carpeta _compartido.
//
//   node publicar/armar_funcion.mjs     →  publicar/funcion-facturar/index.ts
//
// Junta arca.ts + facturar.ts + facturar/index.ts sacando los import entre ellos (los nombres no se pisan: lo controla
// pruebas/funcion.test.mjs, que además corre este mismo archivo armado). La única dependencia es npm:node-forge.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const raiz = new URL('../supabase/functions/', import.meta.url);
const leer = (ruta) => readFileSync(new URL(ruta, raiz), 'utf8');
// los import entre nuestros archivos (de una o varias líneas, siempre con llaves)
const sinImportsLocales = (t) => t.replace(/^import\s+(?:type\s+)?\{[^}]*\}\s+from\s+"\.\.?\/[^"]*";\n/gm, '');

const entrada = leer('facturar/index.ts');
const forge = /^import forge from "npm:node-forge@[\d.]+";\n/m.exec(entrada)?.[0];
if (!forge) throw new Error('facturar/index.ts tiene que importar node-forge con versión fija');

const partes = [
  forge,
  '// ============ _compartido/arca.ts ============\n',
  leer('_compartido/arca.ts'),
  '\n// ============ _compartido/facturar.ts ============\n',
  sinImportsLocales(leer('_compartido/facturar.ts')),
  '\n// ============ facturar/index.ts ============\n',
  sinImportsLocales(entrada.replace(forge, '')),
];
const todo = `// ARMADO con publicar/armar_funcion.mjs: no editar acá, editar los originales en supabase/functions.\n${partes.join('')}`;
if (/from\s+"\.\.?\//.test(todo)) throw new Error('quedó un import local sin resolver');

const salida = new URL('funcion-facturar/', import.meta.url);
mkdirSync(salida, { recursive: true });
writeFileSync(new URL('index.ts', salida), todo);
console.log(`publicar/funcion-facturar/index.ts: ${todo.length} caracteres, sha256 ${createHash('sha256').update(todo).digest('hex').slice(0, 12)}`);
