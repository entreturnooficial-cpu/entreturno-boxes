// Ensayo de restauración: arma una base nueva en la memoria de esta compu (la misma de las pruebas), le carga las migraciones y la
// copia, y comprueba que quede igual. No toca internet ni el proyecto real, y no escribe ningún dato en el disco.
import { readFileSync } from 'node:fs';

import { DUENO, armarBase } from '../pruebas/base.mjs';
import { sqlDeRestauracion } from './restaurar.mjs';

// Cómo se compara cada tabla: fila por fila, menos lo que la restauración cambia a propósito (ver restaurar.mjs)
const COMPARAR = {
  'interno.mp_cuentas': "f - 'estado' - 'error'",
  'public.avisos': "case when f ->> 'estado' in ('pendiente', 'enviando', 'descartado') then f - 'estado' - 'error' else f end",
};
const SALVO = { 'interno.ajustes': "f ->> 'clave' in ('funcion_mp_url', 'copia_desde', 'copia_avisada')" };

/** Cuántas filas cambian entre dos copias, sin importar el orden. Se compara adentro de la base: así no se redondea nada en JavaScript. */
const distintas = (como, salvo = 'false') => `
  with a as (select ${como} as x from jsonb_array_elements($1::jsonb -> 'tablas' -> $3) f where not (${salvo})),
       b as (select ${como} as x from jsonb_array_elements($2::jsonb -> 'tablas' -> $3) f where not (${salvo}))
  select (select count(*) from (select x from a except all select x from b) q) + (select count(*) from (select x from b except all select x from a) q) as n`;

/**
 * Restaura la copia en una base nueva y la controla. Devuelve { hecha, filas, consultorios, avisos } o tira un error que dice qué falló.
 * `conBase(pg)`: para mirar algo más en la base restaurada, antes de cerrarla.
 */
export async function ensayarRestauracion(contenido, conBase) {
  const doc = JSON.parse(contenido);
  const pg = await armarBase();
  const avisos = [];
  try {
    // las tablas de cuentas, como en el Supabase de verdad
    await pg.exec(readFileSync(new URL('./auth-de-supabase.sql', import.meta.url), 'utf8'));
    await pg.exec(`grant select on auth.identities to ${DUENO}`);
    for (const t of Object.keys(doc.tablas)) {
      if (!(await pg.query('select to_regclass($1) as r', [t])).rows[0].r) throw new Error(`la copia tiene la tabla ${t} y las migraciones de esta carpeta no: actualizá el proyecto (git pull)`);
    }
    await pg.exec(sqlDeRestauracion(contenido));
    const otra = (await pg.query('select public.copia_datos()::text as t')).rows[0].t;
    for (const t of Object.keys(doc.tablas)) {
      let como = COMPARAR[t] ?? 'f';
      // si Supabase sumó (o sacó) columnas en sus tablas de cuentas, se compara lo que está en las dos y se dice
      if (t.startsWith('auth.')) {
        const { rows } = await pg.query(`with k as (select distinct jsonb_object_keys(f) as c from jsonb_array_elements($1::jsonb -> 'tablas' -> $2) f),
             m as (select column_name::text as c from information_schema.columns where table_schema || '.' || table_name = $2)
           select c, 'copia' as donde from (select c from k except select c from m) q union all select c, 'ensayo' from (select c from m except select c from k) q`, [contenido, t]);
        if (rows.length && doc.filas[t]) {
          avisos.push(`${t}: columnas que cambiaron en Supabase (${rows.map((f) => `${f.c}, solo en ${f.donde === 'copia' ? 'la copia' : 'el ensayo'}`).join('; ')}): poner al día copia/auth-de-supabase.sql`);
          como = `f - '{${rows.map((f) => f.c).join(',')}}'::text[]`;
        }
      }
      const { n } = (await pg.query(distintas(como, SALVO[t]), [contenido, otra, t])).rows[0];
      if (Number(n)) throw new Error(`la tabla ${t} no quedó igual: ${n} diferencias`);
    }
    const colgadas = (await pg.query(`select (select count(*) from interno.mp_cuentas where estado <> 'caida')::int as cuentas, (select count(*) from public.avisos where estado in ('pendiente', 'enviando'))::int as mails`)).rows[0];
    const deOtro = (await pg.query(`select count(*)::int as n from interno.ajustes where clave in ('funcion_mp_url', 'copia_desde', 'copia_avisada')`)).rows[0].n;
    if (deOtro) throw new Error('quedaron ajustes del otro proyecto');
    if (colgadas.cuentas || colgadas.mails) throw new Error('quedaron cuentas de Mercado Pago conectadas sin pase, o mails viejos por salir');
    // cada consultorio abre con su dueña (o con Soporte): es lo que hace la página al entrar
    const consultorios = [];
    for (const c of (await pg.query('select id, slug from public.consultorios order by slug')).rows) {
      const admin = (await pg.query(`select usuario_id from public.miembros where consultorio_id = $1 and rol = 'admin' and estado = 'aprobado' limit 1`, [c.id])).rows[0];
      if (!admin) { consultorios.push({ slug: c.slug, abre: false }); continue; }
      const foto = await pg.transaction(async (tx) => {
        await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: admin.usuario_id, role: 'authenticated' })]);
        await tx.exec('set local role authenticated');
        return (await tx.query('select public.foto($1) as f', [c.slug])).rows[0].f;
      });
      consultorios.push({ slug: c.slug, abre: true, boxes: foto.boxes.length, personas: foto.users.length, reservas: foto.bookings.length });
    }
    if (conBase) await conBase(pg);
    return { hecha: doc.hecha, filas: doc.filas, consultorios, avisos };
  } finally {
    await pg.close();
  }
}
