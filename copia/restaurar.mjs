// Volver a cargar una copia en una base NUEVA (con las migraciones ya puestas y sin datos).
// Arma el SQL: todo o nada (una sola transacción), y no hace nada si la base ya tiene consultorios.
//
// Los datos van como un solo texto JSON que la base desarma: acá no se los toca ni se los vuelve a armar (así no se pierde
// ninguna cifra ni ningún microsegundo).
import { randomBytes } from 'node:crypto';

export function sqlDeRestauracion(contenido) {
  const tablas = Object.keys(JSON.parse(contenido).tablas);                 // solo los nombres
  if (!tablas.includes('public.consultorios') || !tablas.includes('auth.users')) throw new Error('La copia no está completa.');
  for (const t of tablas) if (!/^(public|interno|auth)\.[a-z_]+$/.test(t)) throw new Error(`nombre de tabla raro: ${t}`);
  let marca;
  do marca = `$c${randomBytes(6).toString('hex')}$`; while (contenido.includes(marca));
  return `-- Restaurar una copia de Entreturno en una base NUEVA. Primero se cargan todas las migraciones; después, esto.
begin;
set local session_replication_role = replica;      -- sin disparadores ni orden entre tablas: son datos que ya estaban bien
do $restaurar$
declare
  v_doc jsonb := ${marca}${contenido}${marca}::jsonb;
  t text;
  v_columnas text;
  v_filas bigint;
begin
  if exists (select 1 from public.consultorios) then raise exception 'esta base ya tiene consultorios: no se restaura encima'; end if;
  -- lo que dejan puesto las migraciones (los textos del aviso, los ajustes) se reemplaza por lo de la copia
  for t in select key from jsonb_each(v_doc -> 'tablas') where key not like 'auth.%' order by key loop
    execute format('delete from %s', t::regclass);
  end loop;
  for t in select key from jsonb_each(v_doc -> 'tablas') order by key like 'auth.%' desc, key loop
    if to_regclass(t) is null then raise exception 'falta la tabla % en esta base: cargá primero todas las migraciones', t; end if;
    -- las columnas que están en la copia y en esta base, menos las que la base calcula sola
    select string_agg(format('%I', c.column_name), ', ' order by c.ordinal_position) into v_columnas
      from information_schema.columns c
     where c.table_schema || '.' || c.table_name = t and c.is_generated = 'NEVER'
       and exists (select 1 from jsonb_array_elements(v_doc -> 'tablas' -> t) f where f ? c.column_name);
    if v_columnas is not null then
      execute format('insert into %s (%s) select %s from jsonb_populate_recordset(null::%s, $1)', t::regclass, v_columnas, v_columnas, t::regclass)
        using v_doc -> 'tablas' -> t;
    end if;
    execute format('select count(*) from %s', t::regclass) into v_filas;
    if v_filas <> (v_doc -> 'filas' ->> t)::bigint then
      raise exception 'en % tenían que quedar % filas y quedaron %', t, v_doc -> 'filas' ->> t, v_filas;
    end if;
  end loop;
  -- Lo que no puede quedar como estaba:
  --   - las cuentas de Mercado Pago: sus pases no van en la copia, así que hay que conectarlas de nuevo
  --   - los mails que esperaban salir: son avisos viejos (o ya salieron), no se mandan otra vez
  --   - los ajustes que son de aquel proyecto (la dirección de su función, desde cuándo se vigila la copia): los pone de nuevo cada
  --     archivo de reloj, que se carga al final
  update interno.mp_cuentas set estado = 'caida', error = 'Se restauró una copia de seguridad: hay que conectar la cuenta de nuevo';
  update public.avisos set estado = 'descartado', error = 'se restauró una copia de seguridad' where estado in ('pendiente', 'enviando');
  delete from interno.ajustes where clave in ('funcion_mp_url', 'copia_desde', 'copia_avisada');
  -- las columnas que se numeran solas siguen desde el último número
  for t in select format('select setval(%L, greatest(1, (select coalesce(max(%I), 1) from %I.%I)))', pg_get_serial_sequence(format('%I.%I', c.table_schema, c.table_name), c.column_name),
                         c.column_name, c.table_schema, c.table_name)
             from information_schema.columns c
            where (v_doc -> 'tablas') ? (c.table_schema || '.' || c.table_name) and c.table_schema in ('public', 'interno')
              and pg_get_serial_sequence(format('%I.%I', c.table_schema, c.table_name), c.column_name) is not null loop
    execute t;
  end loop;
end $restaurar$;
commit;
`;
}
