// ¿La base real es igual a la de las migraciones? Este programa NO se conecta a la base real: arma acá una base con las
// migraciones, saca la huella de cada función, columna, regla e índice, y escribe una consulta de SOLO LECTURA para correr
// en el SQL Editor del proyecto real. La consulta muestra un renglón de totales y, si las hay, las diferencias.
//
//   node pruebas/huellas.mjs                                         → todas las migraciones
//   node pruebas/huellas.mjs --hasta 20261123100000_facturas_arca.sql → solo hasta esa (para mirar ANTES de cargar la que sigue)
//   node pruebas/huellas.mjs --a E:\carpeta\consulta.sql              → la guarda en un archivo (si no, sale por pantalla)
//
// En el proyecto real es normal que «sobre» public.rls_auto_enable: la crea Supabase.
import { writeFileSync } from 'node:fs';

import { MIGRACIONES, armarBase } from './base.mjs';

const args = process.argv.slice(2);
const valor = (nombre) => { const i = args.indexOf(nombre); return i >= 0 ? args[i + 1] : null; };

const hasta = valor('--hasta');
if (hasta && !MIGRACIONES.includes(hasta)) throw new Error(`No existe la migración «${hasta}»`);
const migraciones = hasta ? MIGRACIONES.slice(0, MIGRACIONES.indexOf(hasta) + 1) : MIGRACIONES;

// La misma consulta corre acá y allá. Se sacan los retornos de carro: el editor del panel puede cambiarlos.
const HUELLAS = `
  select 'funcion' as tipo, n.nspname || '.' || p.proname || '(' || array_to_string(p.proargtypes::regtype[]::text[], ',') || ')' as nombre,
         left(md5(replace(p.prosrc, chr(13), '') || '|' || p.prosecdef::text || '|' || p.provolatile::text || '|' || p.proretset::text || '|'
                  || coalesce(array_to_string(p.proconfig, ','), '')), 12) as huella
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'interno')
  union all
  select 'columna', n.nspname || '.' || c.relname || '.' || a.attname,
         left(md5(format_type(a.atttypid, a.atttypmod) || '|' || a.attnotnull::text || '|' || coalesce(pg_get_expr(d.adbin, d.adrelid), '')), 12)
    from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
    left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
   where n.nspname in ('public', 'interno') and c.relkind in ('r', 'p') and a.attnum > 0 and not a.attisdropped
  union all
  select 'regla', k.conrelid::regclass::text || ' · ' || k.conname, left(md5(pg_get_constraintdef(k.oid)), 12)
    from pg_constraint k join pg_namespace n on n.oid = k.connamespace
   where n.nspname in ('public', 'interno') and k.conrelid <> 0 and k.contype <> 'n'
  union all
  select 'indice', x.schemaname || '.' || x.indexname, left(md5(x.indexdef), 12) from pg_indexes x where x.schemaname in ('public', 'interno')
  union all
  select 'disparador', t.tgrelid::regclass::text || ' · ' || t.tgname, left(md5(pg_get_triggerdef(t.oid)), 12)
    from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
   where not t.tgisinternal and n.nspname in ('public', 'interno')`;

const pg = await armarBase(migraciones);
let rows;
try {
  ({ rows } = await pg.query(`${HUELLAS}\n order by 1, 2`));
} catch (e) {                                                  // el error de PGlite trae su código entero: se muestra solo el mensaje
  console.error(`No salió la consulta de las huellas: ${e.message}${e.hint ? ` (${e.hint})` : ''}`);
  process.exit(1);
}
await pg.close();

const texto = (s) => `'${String(s).replace(/'/g, "''")}'`;
const consulta = `-- Huellas de la base según las migraciones ${migraciones[0].slice(0, 14)} a ${migraciones.at(-1)} (solo lectura)
with esperado (tipo, nombre, huella) as (values
${rows.map((r) => `  (${texto(r.tipo)}, ${texto(r.nombre)}, ${texto(r.huella)})`).join(',\n')}
), real as (${HUELLAS}
), cotejo as (
  select coalesce(e.tipo, r.tipo) as tipo, coalesce(e.nombre, r.nombre) as nombre,
         case when r.nombre is null then 'FALTA' when e.nombre is null then 'sobra' when e.huella <> r.huella then 'DISTINTA' else 'igual' end as estado
    from esperado e full join real r on r.tipo = e.tipo and r.nombre = e.nombre
)
select 0 as orden, 'TOTAL' as tipo,
       (select count(*) from cotejo where estado = 'igual') || ' iguales de ' || (select count(*) from esperado) || ' esperadas' as nombre,
       (select count(*) from cotejo where estado in ('FALTA', 'DISTINTA')) || ' mal · ' || (select count(*) from cotejo where estado = 'sobra') || ' de más' as estado
union all
select 1, tipo, nombre, estado from cotejo where estado <> 'igual'
order by 1, 2, 3;
`;

const destino = valor('--a');
if (destino) {
  writeFileSync(destino, consulta, 'utf8');
  const por = rows.reduce((a, r) => ({ ...a, [r.tipo]: (a[r.tipo] ?? 0) + 1 }), {});
  console.log(`Consulta guardada en ${destino}: ${rows.length} huellas (${Object.entries(por).map(([k, v]) => `${k} ${v}`).join(', ')}), ${consulta.length} caracteres`);
} else {
  console.log(consulta);
}
