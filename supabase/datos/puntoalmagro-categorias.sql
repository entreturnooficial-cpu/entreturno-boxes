-- Las categorías de Punto Almagro (pedido de Santiago, 25/11/2026): una por profesión; psicólogos, nutricionistas y coaches pagan lo mismo que
-- los médicos; se saca por completo lo de las emergencias y el seguro. Se corre una vez en el SQL Editor. Es todo o nada.
do $$
declare
  c public.consultorios;
  v_soporte uuid;
  v_medicos uuid;
  v_estetica uuid;
  v_nombre text;
begin
  select * into strict c from public.consultorios where slug = 'puntoalmagro';
  select usuario_id into v_soporte from public.miembros where consultorio_id = c.id and rol = 'admin' and estado = 'aprobado' order by desde limit 1;
  if v_soporte is null then raise exception 'no hay quien administre'; end if;
  if (select count(*) from public.categorias where consultorio_id = c.id and activa) <> 2 then raise exception 'las categorías no están como se esperaba'; end if;
  select id into strict v_medicos from public.categorias where consultorio_id = c.id and activa and nombre = 'Médicos' and precio_hora = 25000;
  select id into strict v_estetica from public.categorias where consultorio_id = c.id and activa and nombre = 'Profesionales de la estética' and precio_hora = 15000;
  perform set_config('request.jwt.claims', json_build_object('sub', v_soporte, 'role', 'authenticated')::text, true);

  perform public.guardar_categoria('puntoalmagro', v_medicos, 'Médicos', '', 25000);
  foreach v_nombre in array array['Psicólogos', 'Nutricionistas', 'Coaches'] loop
    perform public.guardar_categoria('puntoalmagro', null, v_nombre, '', 25000);
  end loop;
  perform public.guardar_categoria('puntoalmagro', v_estetica, 'Esteticistas', 'Tratamientos estéticos, sin práctica médica.', 15000);

  -- en qué orden se muestran
  update public.categorias k set orden = o.n
    from (values ('Médicos', 1), ('Psicólogos', 2), ('Nutricionistas', 3), ('Coaches', 4), ('Esteticistas', 5)) as o(nombre, n)
   where k.consultorio_id = c.id and k.activa and k.nombre = o.nombre;
end $$;

select string_agg(k.orden || ' ' || k.nombre || ' $ ' || k.precio_hora || case when k.nota <> '' then ' (' || k.nota || ')' else '' end, ' · ' order by k.orden) as categorias,
       (select count(*) from public.categorias x where x.nota ~* 'seguro|emergenc') as con_seguro,
       (select string_agg(m.nombre || ': ' || coalesce((select z.nombre from public.categorias z where z.id = m.categoria_id), '-'), ', ') from public.miembros m) as miembros
  from public.categorias k join public.consultorios c on c.id = k.consultorio_id where c.slug = 'puntoalmagro' and k.activa;
