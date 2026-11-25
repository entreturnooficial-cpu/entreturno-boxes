// Abre una copia de seguridad y ensaya restaurarla, en esta compu:
//   node copia/abrir.mjs <archivo.ecopia>                       la abre, la carga en una base de ensayo (en memoria) y dice si sirve
//   node copia/abrir.mjs <archivo.ecopia> --sql salida.sql      además arma el SQL para cargarla en un proyecto nuevo de Supabase
//   node copia/abrir.mjs <archivo.ecopia> --json salida.json    además deja los datos sin cifrar (borralos cuando termines: son datos de personas)
// Pide la frase de la llave. Busca la llave privada en el escritorio (carpeta «ENTRETURNO - COPIAS»), o donde diga --llave.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { huellaDe } from '../supabase/functions/_compartido/copia.ts';
import { descifrarCopia, encabezadoDe } from './descifrar.mjs';
import { ensayarRestauracion } from './ensayar.mjs';
import { abrirPrivada } from './llaves.mjs';
import { preguntarOculto } from './preguntar.mjs';
import { sqlDeRestauracion } from './restaurar.mjs';

const arg = (nombre) => { const i = process.argv.indexOf(nombre); return i > 0 ? process.argv[i + 1] : null; };
const archivo = process.argv[2];
const carpetas = [arg('--llave'), path.join(os.homedir(), 'Desktop', 'ENTRETURNO - COPIAS'), 'E:\\Entreturno boxes\\copias'].filter(Boolean);

function llavePrivada(ids) {
  for (const c of carpetas) {
    let nombres = [];
    try { nombres = c.endsWith('.json') ? [''] : readdirSync(c); } catch { /* esa carpeta no está */ }
    for (const n of nombres) {
      const ruta = n ? path.join(c, n) : c;
      if (!/llave-privada-.*\.json$/.test(ruta)) continue;
      const p = JSON.parse(readFileSync(ruta, 'utf8'));
      if (ids.includes(p.id)) return p;
    }
  }
  throw new Error(`No encontré la llave para abrirla. Se abre con: ${ids.join(', ')}.`);
}

try {
  if (!archivo || archivo.startsWith('--')) throw new Error('Arrastrá el archivo de la copia (termina en .ecopia) sobre el programa.');
  const bytes = readFileSync(archivo);
  const e = encabezadoDe(bytes);
  console.log(`\nCopia del ${new Date(e.hecha).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })} · ${bytes.length.toLocaleString('es-AR')} bytes`);
  console.log(`Huella: ${await huellaDe(new Uint8Array(bytes))}`);
  const privada = llavePrivada(e.llaves.map((l) => l.id));
  // (FRASE_DE_PRUEBA es solo para las pruebas automáticas: la de verdad se escribe en la ventana, y no se ve)
  const frase = process.env.FRASE_DE_PRUEBA ?? await preguntarOculto(`\nEscribí la frase de la llave «${privada.id}» (no se ve): `);
  const contenido = descifrarCopia(bytes, abrirPrivada(privada, frase), privada.id);
  console.log('\nLa copia se abrió bien. Ensayando restaurarla en una base nueva (en la memoria de esta compu)…');
  const r = await ensayarRestauracion(contenido);
  console.log('\nFilas de cada tabla:');
  for (const [t, n] of Object.entries(r.filas).sort()) console.log(`  ${String(n).padStart(6)}  ${t}`);
  console.log('\nConsultorios:');
  for (const c of r.consultorios) console.log(c.abre ? `  ${c.slug}: abre, con ${c.boxes} boxes, ${c.personas} personas y ${c.reservas} reservas` : `  ${c.slug}: no tiene una dueña aprobada`);
  for (const a of r.avisos) console.log(`\nOjo: ${a}`);
  if (arg('--sql')) { writeFileSync(arg('--sql'), sqlDeRestauracion(contenido)); console.log(`\nSQL para un proyecto nuevo: ${arg('--sql')} (tiene datos de personas: no lo subas a ningún lado)`); }
  if (arg('--json')) { writeFileSync(arg('--json'), contenido); console.log(`\nDatos sin cifrar: ${arg('--json')} (borralos cuando termines)`); }
  console.log('\nLA COPIA SIRVE: se abrió, se restauró y quedó igual.\n');
} catch (err) {
  console.log(`\nNO SIRVIÓ: ${err.message}\n`);
  process.exitCode = 1;
}
