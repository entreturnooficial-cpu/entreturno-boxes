-- Deja como «Soporte Entreturno» (acceso total) a la única persona que pidió acceso al consultorio de Yani.
-- Si hay más de una, no cambia nada y avisa.
do $$
declare
  m record;
  n integer;
begin
  select count(*) into n from public.miembros mm join public.consultorios c on c.id = mm.consultorio_id where c.slug = 'yanina';
  if n <> 1 then raise exception 'En yanina hay % personas anotadas: hay que elegir a mano', n; end if;
  select mm.* into m from public.miembros mm join public.consultorios c on c.id = mm.consultorio_id where c.slug = 'yanina';
  perform interno.alta_admin('yanina', m.email, m.nombre);
  update public.miembros set profesion = 'Soporte Entreturno' where id = m.id;
end $$;
select nombre, rol, estado, profesion, left(email, 3) || '...' as mail
  from public.miembros where consultorio_id = (select id from public.consultorios where slug = 'yanina');