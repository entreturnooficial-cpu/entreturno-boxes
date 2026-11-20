-- Alta del consultorio de la Dra. Yanina Onzari en el proyecto real (20/11/2026). Se corre una sola vez en el SQL Editor.
-- Datos que pasó Santiago ese día: $ 25.000 la hora para médicos y $ 20.000 para esteticistas; horarios y reglamento
-- todavía no están («dejemos todo libre por ahora»). Todo se puede cambiar después desde Configuración.
-- Quedan con los valores de fábrica: abre de 8 a 20, de lunes a sábado, turnos de 4 horas, seña del 50 %, pago de prueba.
do $$
declare
  c uuid;
begin
  if exists (select 1 from public.consultorios where slug = 'yanina') then
    raise notice 'El consultorio «yanina» ya existe: no se cambia nada.';
    return;
  end if;
  insert into public.consultorios (slug, nombre, duena, letras, reglamento, fact_nombre)
  values ('yanina', 'Consultorio Yani', 'Yani', 'YO',
          'El reglamento de uso se está terminando de definir. Ante cualquier duda, consultá con Yani antes de reservar.', 'Yanina Onzari')
  returning id into c;
  insert into public.categorias (consultorio_id, nombre, nota, precio_hora, orden) values
    (c, 'Médicas y médicos', 'Atención médica. Incluye el servicio de emergencias y el seguro.', 25000, 1),
    (c, 'Esteticistas', 'Tratamientos estéticos, sin práctica médica.', 20000, 2);
  insert into public.boxes (consultorio_id, numero, nombre) values (c, 1, 'Box 1'), (c, 2, 'Box 2'), (c, 3, 'Box 3');
end $$;

select c.slug, c.nombre, c.pagos_modo,
       (select string_agg(k.nombre || ' $ ' || k.precio_hora, ' · ' order by k.orden) from public.categorias k where k.consultorio_id = c.id) as categorias,
       (select count(*) from public.boxes b where b.consultorio_id = c.id) as boxes
  from public.consultorios c;

-- Después, cuando Yani (o quien vaya a administrar) ya creó su cuenta desde la página:
--   select interno.alta_admin('yanina', 'el-mail-con-que-se-registro', 'Yani');
--
-- Decisión de Santiago (20/11/2026): dos personas con acceso total. Yani como dueña y él como soporte. Para él:
--   select interno.alta_admin('yanina', 'el-mail-de-santiago', 'Santiago');
--   update public.miembros set profesion = 'Soporte Entreturno'
--    where consultorio_id = (select id from public.consultorios where slug = 'yanina') and email = 'el-mail-de-santiago';
