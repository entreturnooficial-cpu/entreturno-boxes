-- Control para correr en el SQL Editor del proyecto real después de cargar las migraciones.
-- Tiene que dar: tablas 15 · sin_candado 0 · f_public 32 (33 en el proyecto real: public.rls_auto_enable)
--                sin_sesion «public.portada» · con_sesion 27 · arca_solo_servicio 5
--                interno_abierto false · legibles 0 · ext «extensions» · lee_usuarios true · dueno «postgres»
-- (antes de las facturas con ARCA, del 23/11/2026, daba f_public 24 y con_sesion 24, sin arca_solo_servicio)
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
  (has_schema_privilege('anon', 'interno', 'usage') or has_schema_privilege('authenticated', 'interno', 'usage')) as interno_abierto,
  (select count(*) from pg_tables t where t.schemaname = 'public'
      and (has_table_privilege('anon', 'public.' || t.tablename, 'select') or has_table_privilege('authenticated', 'public.' || t.tablename, 'select'))) as legibles,
  (select extnamespace::regnamespace::text from pg_extension where extname = 'btree_gist') as ext,
  has_table_privilege(current_user, 'auth.users', 'select') as lee_usuarios,
  (select pg_get_userbyid(proowner) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'foto') as dueno;
