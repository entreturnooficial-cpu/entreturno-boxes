// Qué navegador usan las pruebas de pantalla y dónde dejan las capturas. Está aparte para que anden en la compu de cualquiera:
//   - busca Edge o Chrome donde suelen estar (o el que diga la variable NAVEGADOR);
//   - guarda las capturas en E:\Entreturno boxes\pruebas si existe esa carpeta (la compu de Santiago) y, si no, en la carpeta
//     temporal (o en la que diga la variable CAPTURAS).
import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CANDIDATOS = [
  process.env.NAVEGADOR,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA && `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`,
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/microsoft-edge',
];

export const NAVEGADOR = CANDIDATOS.find((c) => c && existsSync(c));
if (!NAVEGADOR) throw new Error('No encontré Edge ni Chrome. Decime dónde está con la variable NAVEGADOR (la ruta completa del programa).');

const dos = (n) => String(n).padStart(2, '0');

/** Una carpeta nueva para las capturas de esta corrida: «<nombre> 2026-11-25 125358». */
export function carpetaDeCapturas(nombre) {
  const base = process.env.CAPTURAS ?? (existsSync('E:/Entreturno boxes') ? 'E:/Entreturno boxes/pruebas' : path.join(tmpdir(), 'entreturno-boxes'));
  const a = new Date();
  const carpeta = `${base.replace(/\\/g, '/')}/${nombre} ${a.getFullYear()}-${dos(a.getMonth() + 1)}-${dos(a.getDate())} ${dos(a.getHours())}${dos(a.getMinutes())}${dos(a.getSeconds())}`;
  mkdirSync(carpeta, { recursive: true });
  return carpeta;
}
