-- Prueba de cobro de verdad en Punto Almagro (26/11/2026). Santiago: «Si dejala lista».
-- ARMAR (se corre una vez en el SQL Editor, todo o nada): pasa el consultorio a cobrar de verdad, arma la categoría «Prueba»
-- a $ 500 la hora (un turno de 4 horas sale $ 2.000 y la seña $ 1.000) y pone ahí a Santiago (profesional) para que reserve y pague.
-- Después: Yani se registra, se la pasa a dueña (interno.alta_admin), conecta su cuenta desde Configuración y cancela el turno
-- de prueba desde su panel (si lo cancela la profesional, la seña no vuelve).
do $$
declare
  c public.consultorios;
  v_soporte uuid;
  v_santiago uuid;
  v_prueba uuid;
begin
  select * into strict c from public.consultorios where slug = 'puntoalmagro';
  if c.pagos_modo <> 'mercadopago' or c.mp_ambiente <> 'prueba' then
    raise exception 'no estaba en modo prueba (% / %)', c.pagos_modo, c.mp_ambiente;
  end if;
  select usuario_id into v_soporte from public.miembros
   where consultorio_id = c.id and rol = 'admin' and estado = 'aprobado' order by desde limit 1;
  if v_soporte is null then raise exception 'no hay quien administre'; end if;
  select id into strict v_santiago from public.miembros
   where consultorio_id = c.id and rol = 'pro' and estado = 'aprobado' and nombre = 'Santiago';
  if exists (select 1 from public.categorias where consultorio_id = c.id and activa and nombre = 'Prueba') then
    raise exception 'ya hay una categoría Prueba';
  end if;

  perform interno.mp_pasar_a('puntoalmagro', 'real');

  perform set_config('request.jwt.claims', json_build_object('sub', v_soporte, 'role', 'authenticated')::text, true);
  v_prueba := (public.guardar_categoria('puntoalmagro', null, 'Prueba',
                 'Solo para la prueba de cobro de hoy. No la elijas.', 500) ->> 'id')::uuid;
  perform public.cambiar_categoria_profesional('puntoalmagro', v_santiago, v_prueba);
end $$;

select c.pagos_modo, c.mp_ambiente,
  (select string_agg(k.orden || ' ' || k.nombre || ' $ ' || k.precio_hora, ' · ' order by k.orden)
     from public.categorias k where k.consultorio_id = c.id and k.activa) as categorias,
  (select string_agg(m.nombre || ': ' || coalesce((select z.nombre from public.categorias z where z.id = m.categoria_id), '-'), ' · ' order by m.desde)
     from public.miembros m where m.consultorio_id = c.id) as miembros,
  (select count(*) from interno.mp_cuentas k where k.consultorio_id = c.id and k.estado = 'conectada') as cuentas_conectadas
from public.consultorios c where c.slug = 'puntoalmagro';

-- DESARMAR (cuando termine la prueba; Santiago estaba en «Médicos»):
-- do $$
-- declare
--   c public.consultorios;
--   v_soporte uuid;
--   v_santiago uuid;
--   v_prueba uuid;
--   v_medicos uuid;
-- begin
--   select * into strict c from public.consultorios where slug = 'puntoalmagro';
--   select usuario_id into v_soporte from public.miembros
--    where consultorio_id = c.id and rol = 'admin' and estado = 'aprobado' order by desde limit 1;
--   select id into strict v_santiago from public.miembros where consultorio_id = c.id and rol = 'pro' and nombre = 'Santiago';
--   select id into strict v_prueba from public.categorias where consultorio_id = c.id and activa and nombre = 'Prueba';
--   select id into strict v_medicos from public.categorias where consultorio_id = c.id and activa and nombre = 'Médicos';
--   perform set_config('request.jwt.claims', json_build_object('sub', v_soporte, 'role', 'authenticated')::text, true);
--   perform public.cambiar_categoria_profesional('puntoalmagro', v_santiago, v_medicos);
--   perform public.quitar_categoria('puntoalmagro', v_prueba);
-- end $$;
