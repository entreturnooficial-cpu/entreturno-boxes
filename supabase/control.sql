-- Control para correr en el SQL Editor del proyecto real después de cargar las migraciones.
-- Tiene que dar: tablas 15 · sin_candado 0 · f_public 64 (65 en el proyecto real: public.rls_auto_enable)
--                sin_sesion «public.portada» · con_sesion 37 · arca_solo_servicio 5 · mp_solo_servicio 19 · copia_solo_servicio 3
--                interno_abierto false · legibles 0 · mp_tablas_abiertas 0 · ext «extensions» · lee_usuarios true · dueno «postgres»
-- (antes de la copia de seguridad, del 25/11/2026, daba f_public 61 en el real, sin copia_solo_servicio;
--  antes del aviso de datos personales, del 25/11/2026, daba f_public 59 en el real y con_sesion 34;
--  antes del cobro con Mercado Pago, del 24/11/2026, daba f_public 32 y con_sesion 27, sin mp_solo_servicio;
--  antes de las facturas con ARCA, del 23/11/2026, daba f_public 24 y con_sesion 24, sin arca_solo_servicio)
select
  (select count(*) from pg_tables where schemaname = 'public') as tablas,
  (select count(*) from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and not relrowsecurity) as sin_candado,
  (select count(*) from pg_proc where pronamespace = 'public'::regnamespace) as f_public,
  (select count(*) from pg_proc where pronamespace = 'interno'::regnamespace) as f_interno,
  (select string_agg(n.nspname || '.' || p.proname, ', ' order by 1) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'interno') and has_function_privilege('anon', p.oid, 'execute')) as sin_sesion,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'interno') and has_function_privilege('authenticated', p.oid, 'execute')) as con_sesion,
  (select count(*) from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.proname like 'arca\_%'
      and has_function_privilege('service_role', p.oid, 'execute')
      and not has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute')) as arca_solo_servicio,
  (select count(*) from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.proname like 'mp\_%'
      and has_function_privilege('service_role', p.oid, 'execute')
      and not has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute')) as mp_solo_servicio,
  (select count(*) from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.proname like 'copia\_%'
      and has_function_privilege('service_role', p.oid, 'execute')
      and not has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute')) as copia_solo_servicio,
  (has_schema_privilege('anon', 'interno', 'usage') or has_schema_privilege('authenticated', 'interno', 'usage')) as interno_abierto,
  (select count(*) from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
      and (has_table_privilege('anon', c.oid, 'select') or has_table_privilege('authenticated', c.oid, 'select'))) as legibles,
  -- las tablas de adentro (ahí viven la cuenta de Mercado Pago de cada consultorio y el ticket de ARCA): nadie de la página las lee
  (select count(*) from pg_class c where c.relnamespace = 'interno'::regnamespace and c.relkind in ('r', 'p')
      and (has_table_privilege('anon', c.oid, 'select') or has_table_privilege('authenticated', c.oid, 'select'))) as mp_tablas_abiertas,
  (select extnamespace::regnamespace::text from pg_extension where extname = 'btree_gist') as ext,
  has_table_privilege(current_user, 'auth.users', 'select') as lee_usuarios,
  (select pg_get_userbyid(proowner) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'foto') as dueno;
