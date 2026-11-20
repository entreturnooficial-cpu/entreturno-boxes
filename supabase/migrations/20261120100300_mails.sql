-- =====================================================================================================
-- Entreturno · Boxes — el envío de los avisos por mail (con Resend)
-- =====================================================================================================
-- Los avisos ya se guardaban en la tabla «avisos» cada vez que pasaba algo (reserva confirmada, recordatorio…).
-- Esto los manda: cada minuto toma unos pocos pendientes y se los pide al servicio de mails.
--
-- La clave del servicio es secreta y NO está en ningún archivo: se carga a mano en el Vault de Supabase con el
-- nombre «resend_api_key». Mientras no esté cargada, no se manda nada (los avisos esperan).
-- =====================================================================================================

create extension if not exists pg_net with schema extensions;

alter table public.avisos drop constraint avisos_estado_check;
alter table public.avisos add constraint avisos_estado_check
  check (estado in ('pendiente', 'enviando', 'enviado', 'error', 'descartado'));
alter table public.avisos add column pedido_id bigint;        -- el número del pedido al servicio de mails
alter table public.avisos add column pedido_en timestamptz;

create function interno.despachar_avisos() returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_clave text;
  a record;
  v_pedido bigint;
  n integer := 0;
begin
  -- 1) Qué contestó el servicio sobre los que ya se le pidieron: enviado, o a reintentar (hasta 3 veces)
  update public.avisos v
     set estado = case when r.status_code between 200 and 299 then 'enviado' when v.intentos >= 3 then 'error' else 'pendiente' end,
         enviado_en = case when r.status_code between 200 and 299 then now() end,
         error = case when r.status_code between 200 and 299 then null
                      else left(coalesce(nullif(r.error_msg, ''), nullif(r.content, ''), 'el servicio de mails no lo aceptó'), 300) end
    from net._http_response r
   where v.estado = 'enviando' and r.id = v.pedido_id;
  -- Los que se quedaron esperando una respuesta que nunca llegó
  update public.avisos
     set estado = case when intentos >= 3 then 'error' else 'pendiente' end, error = 'sin respuesta del servicio de mails'
   where estado = 'enviando' and pedido_en < now() - interval '10 minutes';
  -- Los que no tienen a quién mandarse
  update public.avisos set estado = 'descartado', error = 'sin dirección de mail' where estado = 'pendiente' and para not like '%_@_%';

  select decrypted_secret into v_clave from vault.decrypted_secrets where name = 'resend_api_key';
  if v_clave is null or btrim(v_clave) = '' then return 0; end if;       -- sin la clave cargada no se manda nada

  -- 2) Se piden de a dos por vez (el plan gratis del servicio acepta 2 pedidos por segundo y 100 mails por día)
  for a in
    select v.id, v.para, v.asunto, v.cuerpo, c.nombre as consultorio
      from public.avisos v join public.consultorios c on c.id = v.consultorio_id
     where v.estado = 'pendiente' and v.intentos < 3
     order by v.creado_en, v.id
     limit 2
       for update of v skip locked
  loop
    select net.http_post(
             url := 'https://api.resend.com/emails',
             body := jsonb_build_object(
                       'from', btrim(regexp_replace(a.consultorio, '[<>",;\r\n]', '', 'g')) || ' <avisos@entreturno.com.ar>',
                       'to', jsonb_build_array(a.para), 'subject', a.asunto, 'text', a.cuerpo),
             headers := jsonb_build_object('Authorization', 'Bearer ' || btrim(v_clave), 'Content-Type', 'application/json',
                                           'Idempotency-Key', a.id::text))     -- si se repite el pedido, el servicio no manda dos veces
      into v_pedido;
    update public.avisos set estado = 'enviando', pedido_id = v_pedido, pedido_en = now(), intentos = intentos + 1 where id = a.id;
    n := n + 1;
  end loop;
  return n;
end $$;

revoke all on function interno.despachar_avisos() from public, anon, authenticated;
