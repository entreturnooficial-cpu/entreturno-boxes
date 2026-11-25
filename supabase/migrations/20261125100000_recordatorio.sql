-- =====================================================================================================
-- Entreturno · Boxes — El recordatorio del turno (25/11/2026)
-- =====================================================================================================
-- En la primera prueba real se reservó un turno para el MISMO día: al minuto de confirmarlo salió un mail que decía
-- «Recordatorio: mañana tenés Box 2». Ahora:
--   - Quien reservó con menos de un día de anticipación no recibe recordatorio: le acaba de llegar «Reserva confirmada»,
--     que dice lo mismo.
--   - El texto dice «hoy» o «mañana» según la fecha (sirve si el reloj estuvo parado y el recordatorio sale tarde).
-- El resto de la función es igual a la de …_funciones.sql. No toca ninguna tabla ni ningún dato.
-- =====================================================================================================

create or replace function interno.mantener(p_consultorio uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c public.consultorios;
  r record;
  nl constant text := chr(10);
begin
  select * into c from public.consultorios where id = p_consultorio;

  for r in
    update public.reservas
       set estado = 'cancelada', cancelada_en = now(), cancelada_por = 'vencida', devolucion_monto = 0, devolucion_pct = 0
     where consultorio_id = p_consultorio and estado = 'pago' and vence_en is not null and vence_en < now()
    returning id, miembro_id, box_id, fecha
  loop
    update public.reserva_maquinas set activa = false where reserva_id = r.id;
    update public.pagos set estado = 'vencido' where reserva_id = r.id and estado = 'pendiente';
    perform interno.avisar(r.miembro_id, 'Se liberó tu reserva',
      'Hola ' || interno.primer_nombre((select nombre from public.miembros where id = r.miembro_id)) || ':' || nl || nl
      || 'No registramos el pago de ' || (select nombre from public.boxes where id = r.box_id) || ' del ' || interno.dia_largo(r.fecha)
      || ' a tiempo, así que el horario volvió a quedar libre. Si todavía lo querés, podés reservarlo de nuevo.' || nl || nl || c.nombre);
  end loop;

  update public.reservas set estado = 'cumplida'
   where consultorio_id = p_consultorio and estado = 'confirmada' and interno.instante(fecha, hasta, c.zona) < now();

  for r in
    update public.reservas set recordada = true
     where consultorio_id = p_consultorio and estado = 'confirmada' and not recordada
       and interno.instante(fecha, desde, c.zona) > now()
       and interno.instante(fecha, desde, c.zona) <= now() + interval '24 hours'
    returning id, miembro_id, box_id, fecha, desde, hasta, total, creada_en
  loop
    -- reservó hace un rato, con menos de un día de anticipación: no hace falta recordárselo
    continue when r.creada_en > interno.instante(r.fecha, r.desde, c.zona) - interval '24 hours';
    perform interno.avisar(r.miembro_id,
      'Recordatorio: ' || case when r.fecha = (now() at time zone c.zona)::date then 'hoy' else 'mañana' end
      || ' tenés ' || (select nombre from public.boxes where id = r.box_id),
      'Hola ' || interno.primer_nombre((select nombre from public.miembros where id = r.miembro_id)) || ':' || nl || nl
      || 'Te recordamos tu turno: ' || (select nombre from public.boxes where id = r.box_id) || ' · ' || interno.cap(interno.dia_largo(r.fecha))
      || ' · ' || r.desde || ' a ' || r.hasta || ' h.'
      || case when r.total > interno.pagado(r.id) then nl || 'Te queda pagar el saldo: ' || interno.plata(r.total - interno.pagado(r.id)) || '.' else '' end
      || nl || nl || c.nombre);
  end loop;
end $$;
