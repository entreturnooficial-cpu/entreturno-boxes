// Genera la llave con la que se abren las copias de seguridad. Lo corre cada dueño de una llave, en su compu:
//   node copia/generar-llave.mjs [carpeta]
// Deja dos archivos en la carpeta: la llave privada (protegida con una frase) y la pública (la que va al proyecto).
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';

import { abrirPrivada, fraseNueva, generarPar, normalizar } from './llaves.mjs';

const carpeta = process.argv[2] ?? path.join(os.homedir(), 'Desktop', 'ENTRETURNO - COPIAS');
const SEGUNDA = 'E:\\Entreturno boxes\\copias';
const rl = createInterface({ input: process.stdin, output: process.stdout });
const linea = '-'.repeat(70);

try {
  mkdirSync(carpeta, { recursive: true });
  const ya = readdirSync(carpeta).find((f) => /^llave-privada-.*\.json$/.test(f));
  if (ya) {
    console.log(`\nYa hay una llave en esta carpeta (${ya}). No se toca nada.\n`);
    process.exit(0);
  }
  console.log(`\n${linea}\nLA LLAVE DE LAS COPIAS DE SEGURIDAD\n${linea}`);
  const nombre = (await rl.question('\nTu nombre (para saber de quién es la llave): ')).trim() || 'entreturno';
  const frase = fraseNueva();
  console.log(`\nEsta es tu frase. Sin ella la llave no abre nada, y no se puede recuperar:\n\n     ${frase}\n`);
  console.log('Anotala ahora en un papel (y en tu gestor de contraseñas, si usás).');
  console.log('No la mandes por WhatsApp, no le saques foto y no se la pases a Claude.');
  let bien = false;
  for (let i = 0; i < 3 && !bien; i++) {
    const escrita = await rl.question('\nCuando la tengas anotada, escribila acá mirando el papel: ');
    bien = normalizar(escrita) === frase;
    if (!bien) console.log('No es igual. Fijate en el papel y probá de nuevo.');
  }
  if (!bien) {
    console.log('\nNo se generó ninguna llave. Abrí este programa otra vez para empezar de nuevo.\n');
    process.exit(1);
  }
  console.log('\nGenerando la llave (unos segundos)…');
  const { publica, privada } = generarPar(frase, nombre);
  abrirPrivada(privada, frase);                                            // que abra, antes de guardarla
  const archivo = path.join(carpeta, `llave-privada-${publica.id}.json`);
  writeFileSync(archivo, `${JSON.stringify(privada, null, 2)}\n`);
  writeFileSync(path.join(carpeta, `llave-publica-${publica.id}.json`), `${JSON.stringify(publica, null, 2)}\n`);
  let donde = carpeta;
  if (existsSync(path.parse(SEGUNDA).root)) {
    mkdirSync(SEGUNDA, { recursive: true });
    copyFileSync(archivo, path.join(SEGUNDA, path.basename(archivo)));
    donde += `\n  y una segunda copia en ${SEGUNDA}`;
  }
  console.clear();
  console.log(`\n${linea}\nLISTO\n${linea}\n\nLa llave quedó en:\n  ${donde}\n`);
  console.log('Guardá también la llave privada en un pendrive o en otra compu: si se pierden todas, las copias no se pueden abrir.');
  console.log('\nYa podés cerrar esta ventana y avisarle a Claude que está.\n');
} finally {
  rl.close();
}
