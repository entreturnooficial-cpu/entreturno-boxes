-- El modo prueba de Mercado Pago, de verdad de prueba (25/11/2026)
--
-- Qué pasó ese día: se ensayó conectar una cuenta con el consultorio en modo prueba. Mercado Pago dio un pase de prueba que su
-- API de órdenes no acepta; el sistema lo renovó solo (como hace cuando un pase deja de servir) y el pase renovado vino REAL.
-- La orden que se creó era de verdad (ORD01…) aunque la página decía «modo prueba». Nadie pagó: Mercado Pago no aceptó el
-- comprador de prueba, y la orden venció sola.
--
-- Desde ahora:
--   1) En modo prueba se cobra SIEMPRE con el pase de prueba de la aplicación. Una cuenta conectada en prueba sirve para ensayar
--      la conexión y nada más: su pase no se entrega y no se renueva.
--   2) Una orden de prueba (su número empieza con ORDTST) no se puede anotar en un consultorio que cobra de verdad, ni una de
--      verdad en uno que está en prueba.
--   3) Un enlace de pago que quedó de otro modo no se vuelve a entregar, y un pago no se aprueba con una orden de otro modo.
--   4) Pasar un consultorio de prueba a real (o al revés) se hace con interno.mp_pasar_a, que mira que no quede nada colgado.
-- (3 y 4 completados con la revisión 8 de Codex: revisiones/respuesta-codex-8.md)

-- ---------------------------------------------------------------------------------------------------
-- ¿Esa orden es de prueba? Mercado Pago numera ORDTST… las de prueba y ORD01… las de verdad.
-- ---------------------------------------------------------------------------------------------------
create function interno.mp_es_de_prueba(p_orden text) returns boolean
language sql immutable set search_path = public, pg_temp as $$
  select coalesce(p_orden, '') like 'ORDTST%'
$$;

-- El candado final: ninguna orden queda anotada en un pago, ni lo deja aprobado, si no es del ambiente de su consultorio.
-- (Mira solo cuando el número cambia o cuando se aprueba: los pagos de prueba viejos se quedan como están cuando el consultorio
-- pasa a real.)
create function interno.mp_orden_del_ambiente() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.proveedor = 'mercadopago' and new.tipo <> 'devolucion' and new.proveedor_id is not null
     and (tg_op = 'INSERT' or new.proveedor_id is distinct from old.proveedor_id
          or (new.estado = 'aprobado' and old.estado is distinct from 'aprobado'))
     and interno.mp_es_de_prueba(new.proveedor_id)
         <> exists (select 1 from public.consultorios c where c.id = new.consultorio_id and c.mp_ambiente = 'prueba') then
    raise exception 'mp_otro_ambiente';
  end if;
  return new;
end $$;

create trigger pagos_orden_del_ambiente before insert or update of proveedor_id, estado on public.pagos
  for each row execute function interno.mp_orden_del_ambiente();

-- ---------------------------------------------------------------------------------------------------
-- El pase de la cuenta conectada se entrega solo para cobrar de verdad
-- ---------------------------------------------------------------------------------------------------
create or replace function public.mp_credencial(p_consultorio uuid, p_con_renovar boolean default false) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  c public.consultorios;
  k interno.mp_cuentas;
  v_sirve boolean;
begin
  select * into c from public.consultorios where id = p_consultorio;
  if not found then raise exception 'consultorio_inexistente'; end if;
  select * into k from interno.mp_cuentas where consultorio_id = c.id;
  -- para cobrar hace falta la cuenta confirmada y del ambiente de hoy; una «caída» no sirve hasta que se reconecte.
  -- En modo prueba no se entrega nunca: se cobra con el pase de prueba de la aplicación.
  v_sirve := found and k.estado = 'conectada' and k.ambiente = c.mp_ambiente and c.mp_ambiente = 'real';
  return jsonb_build_object(
    'slug', c.slug, 'modo', c.pagos_modo, 'ambiente', c.mp_ambiente,
    'cuenta', case when k.consultorio_id is not null then jsonb_build_object(
                'estado', k.estado, 'ambiente', k.ambiente, 'userId', k.mp_user_id, 'vence', k.vence) end,
    'acceso', case when v_sirve then interno.secreto_leer('mp_acceso_' || c.id) end,
    'renovar', case when v_sirve and p_con_renovar then interno.secreto_leer('mp_renovar_' || c.id) end);
end $$;

-- Igual que antes, salvo «renovar»: solo los pases de las cuentas con las que hoy se cobra de verdad (los de prueba no se usan,
-- y si el consultorio está en otro ambiente no hay con qué renovarlos: antes eso daba la cuenta por caída).
create or replace function public.mp_pendientes(p_consultorio uuid default null) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    -- órdenes abiertas hace más de un minuto, y las que Mercado Pago avisó y no se pudieron leer: preguntarle cómo están
    'pagos', coalesce((select jsonb_agg(jsonb_build_object('pago', x.id, 'consultorio', x.consultorio_id, 'orden', x.proveedor_id,
                                                           'monto', x.monto, 'estado', x.estado) order by x.actualizado_en)
                         from (select p.id, p.consultorio_id, p.proveedor_id, p.actualizado_en, p.monto, p.estado from public.pagos p
                                where p.proveedor = 'mercadopago' and p.tipo <> 'devolucion' and p.proveedor_id is not null
                                  and ((p.estado = 'pendiente' and p.actualizado_en < now() - interval '1 minute')
                                       or (p.estado in ('pendiente', 'vencido', 'rechazado') and p.datos ? 'sin_comprobar'
                                           and p.actualizado_en < now() - interval '10 minutes'))
                                  and (p_consultorio is null or p.consultorio_id = p_consultorio)
                                order by p.actualizado_en limit 20) x), '[]'::jsonb),
    -- órdenes de intentos que ya cerramos nosotros: cancelarlas en Mercado Pago (y si alguien las pagó, se devuelve)
    'cerrar', coalesce((select jsonb_agg(jsonb_build_object('pago', x.id, 'consultorio', x.consultorio_id, 'orden', x.proveedor_id,
                                                            'monto', x.monto, 'estado', x.estado) order by x.actualizado_en)
                          from (select p.id, p.consultorio_id, p.proveedor_id, p.actualizado_en, p.monto, p.estado from public.pagos p
                                 where p.proveedor = 'mercadopago' and p.tipo <> 'devolucion' and p.estado in ('vencido', 'rechazado')
                                   and p.proveedor_id is not null and not (p.datos ? 'cerrada') and not (p.datos ? 'sin_comprobar')
                                   and p.creado_en > now() - interval '2 days'
                                   and (p_consultorio is null or p.consultorio_id = p_consultorio)
                                 order by p.actualizado_en limit 20) x), '[]'::jsonb),
    -- devoluciones que esperan: enseguida la primera vez, cada 10 minutos las primeras veces y después cada 6 horas
    'devoluciones', coalesce((select jsonb_agg(jsonb_build_object('devolucion', x.id, 'consultorio', x.consultorio_id) order by x.creado_en)
                                from (select p.id, p.consultorio_id, p.creado_en from public.pagos p
                                       where p.proveedor = 'mercadopago' and p.tipo = 'devolucion' and p.estado = 'pendiente'
                                         and coalesce((p.datos ->> 'tomada_hasta')::timestamptz, '-infinity') < now()
                                         and p.actualizado_en < now() - case when p.intentos = 0 then interval '5 seconds'
                                                                             when p.intentos < 6 then interval '10 minutes'
                                                                             else interval '6 hours' end
                                         and (p_consultorio is null or p.consultorio_id = p_consultorio)
                                       order by p.creado_en limit 20) x), '[]'::jsonb),
    'sobrantes', coalesce((select jsonb_agg(jsonb_build_object('pago', x.id, 'consultorio', x.consultorio_id, 'orden', x.proveedor_id) order by x.creado_en)
                             from (select p.id, p.consultorio_id, p.proveedor_id, p.creado_en from public.pagos p
                                    where p.proveedor = 'mercadopago' and p.estado = 'sobrante' and p.proveedor_id is not null
                                      and coalesce((p.datos ->> 'tomada_hasta')::timestamptz, '-infinity') < now()
                                      and p.actualizado_en < now() - case when p.intentos = 0 then interval '5 seconds'
                                                                          when p.intentos < 6 then interval '10 minutes'
                                                                          else interval '6 hours' end
                                      and (p_consultorio is null or p.consultorio_id = p_consultorio)
                                    order by p.creado_en limit 20) x), '[]'::jsonb),
    -- pases que vencen en menos de 30 días: se renuevan (una vez por día como mucho)
    'renovar', case when p_consultorio is null then
                 coalesce((select jsonb_agg(k.consultorio_id) from interno.mp_cuentas k
                             join public.consultorios c on c.id = k.consultorio_id
                            where k.estado = 'conectada' and k.ambiente = 'real' and c.mp_ambiente = 'real'
                              and k.vence < now() + interval '30 days'
                              and (k.renovada_en is null or k.renovada_en < now() - interval '1 day')), '[]'::jsonb)
               else '[]'::jsonb end)
$$;

-- ---------------------------------------------------------------------------------------------------
-- Preparar un pago: igual que antes, salvo dos cosas.
--   - Toma el candado del consultorio antes que nada, así no se cruza con un cambio de modo (interno.mp_pasar_a).
--   - Si había una orden abierta del otro modo, no la entrega: queda para revisar y se arma una nueva.
-- ---------------------------------------------------------------------------------------------------
create or replace function public.mp_pago_preparar(p_slug text, p_reserva uuid, p_tipo text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c public.consultorios;
  m public.miembros;
  r public.reservas;
  p public.pagos;
  v_monto integer;
  v_vence timestamptz;
  v_box text;
  v_cerrar text;
  v_reusar boolean := false;
begin
  c := interno.candado((interno.consultorio(p_slug)).id);
  m := interno.yo(c.id);
  if c.pagos_modo <> 'mercadopago' then raise exception 'pagos_simulados'; end if;
  select * into r from public.reservas where id = p_reserva and consultorio_id = c.id for update;
  if not found or m.id is null or r.miembro_id <> m.id then raise exception 'reserva_inexistente'; end if;

  if r.estado = 'pago' then
    if r.vence_en is not null and r.vence_en < now() then raise exception 'pago_vencido'; end if;
    if p_tipo is distinct from r.plan then raise exception 'pago_invalido'; end if;
    v_monto := case when r.plan = 'sena' then r.monto_sena else r.total end;
    v_vence := r.vence_en;
  elsif r.estado in ('confirmada', 'cumplida') and p_tipo = 'saldo' then      -- el saldo también se puede pagar después del turno
    v_monto := r.total - interno.pagado(r.id);
    v_vence := now() + interval '30 minutes';
  else
    raise exception 'pago_invalido';
  end if;
  if v_monto <= 0 then raise exception 'nada_que_pagar'; end if;
  if not interno.mp_lista(c) then raise exception 'mp_sin_cuenta'; end if;
  -- con menos de un minuto no se llega a pagar: mejor decirlo ahora que cobrar tarde
  if v_vence is null or v_vence < now() + interval '1 minute' then raise exception 'pago_vencido'; end if;

  select * into p from public.pagos
   where reserva_id = r.id and tipo = p_tipo and proveedor = 'mercadopago' and estado = 'pendiente'
   order by creado_en desc limit 1
     for update;
  if found and p.proveedor_id is not null and interno.mp_es_de_prueba(p.proveedor_id) <> (c.mp_ambiente = 'prueba') then
    -- esa orden quedó del otro modo (no debería pasar: mp_pasar_a no deja cambiar con cobros abiertos). No se entrega más su
    -- enlace y no se la puede cerrar con el pase de este modo: se mira a mano.
    update public.pagos set estado = 'revisar', error = 'la orden es del otro modo (prueba o real)', actualizado_en = now() where id = p.id;
    perform interno.avisar_admin(c.id, 'Un pago para revisar',
      'Quedó abierto un cobro de ' || interno.plata(p.monto) || ' hecho en otro modo de Mercado Pago (de prueba o de verdad). '
      || 'Avisale a Entreturno para que lo revise con vos.');
  elsif found then
    if p.monto = v_monto and p.vence_en > now() + interval '1 minute' then
      if p.enlace is not null then
        return jsonb_build_object('pago', p.id, 'nuevo', false, 'enlace', p.enlace, 'consultorio', c.id);
      end if;
      -- otro clic (u otra pestaña) está creando la orden en este momento: que la página espere unos segundos
      if p.actualizado_en > now() - interval '20 seconds' then raise exception 'pago_en_curso'; end if;
      -- quedó a medio crear: se repite el mismo pedido con el mismo intento (Mercado Pago no crea dos órdenes iguales)
      update public.pagos set actualizado_en = now() where id = p.id returning * into p;
      v_reusar := true;
    else
      -- ese intento ya no sirve (venció o cambió el monto): se cierra y se abre uno nuevo
      update public.pagos set estado = 'vencido', actualizado_en = now() where id = p.id;
      v_cerrar := p.proveedor_id;
    end if;
  end if;

  if not v_reusar then
    insert into public.pagos (consultorio_id, reserva_id, tipo, monto, estado, proveedor, vence_en)
    values (c.id, r.id, p_tipo, v_monto, 'pendiente', 'mercadopago', v_vence)
    returning * into p;
  end if;
  select nombre into v_box from public.boxes where id = r.box_id;
  return jsonb_build_object(
    'pago', p.id, 'nuevo', true, 'consultorio', c.id, 'slug', c.slug, 'ambiente', c.mp_ambiente, 'monto', v_monto,
    -- si Mercado Pago rechazó el pedido anterior, el siguiente va con otra clave; si solo se cortó, con la misma
    'clave', p.id || '-' || p.intentos,
    -- los minutos se cuentan desde que se anotó el intento: así, si hay que repetir el pedido, sale idéntico
    'minutos', greatest(1, ceil(extract(epoch from (p.vence_en - p.creado_en)) / 60.0)::integer),
    'titulo', left((case p_tipo when 'sena' then 'Seña' when 'saldo' then 'Saldo' else 'Alquiler' end) || ' · ' || v_box || ' · '
                   || interno.dia_largo(r.fecha) || ' · ' || r.desde || ' a ' || r.hasta || ' h', 120),
    'descripcion', left(c.nombre || ': alquiler de ' || v_box, 120),
    'email', nullif(m.email, ''), 'cerrar', v_cerrar);
end $$;

-- ---------------------------------------------------------------------------------------------------
-- Pasar un consultorio a cobrar de verdad, o devolverlo a prueba. Solo desde el SQL Editor:
--   select interno.mp_pasar_a('yanina', 'real');
-- Después, la dueña conecta su cuenta desde Configuración (una cuenta conectada en prueba no sirve para cobrar de verdad).
-- Con el modo cambiado, lo que quedó abierto en el otro no se puede leer, cerrar ni devolver: por eso mira tanto.
-- ---------------------------------------------------------------------------------------------------
create function interno.mp_pasar_a(p_slug text, p_ambiente text) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c public.consultorios;
begin
  if p_ambiente is null or p_ambiente not in ('prueba', 'real') then raise exception 'dato_invalido'; end if;
  c := interno.candado((interno.consultorio(p_slug)).id);
  if c.pagos_modo = 'mercadopago' and c.mp_ambiente = p_ambiente then
    return format('%s ya cobraba con Mercado Pago en modo %s: no se cambió nada', c.slug, p_ambiente);
  end if;
  if exists (
       select 1 from public.pagos p
        where p.consultorio_id = c.id and p.proveedor = 'mercadopago'
          and (p.estado in ('pendiente', 'sobrante', 'revisar')      -- intentos (con número o sin él), devoluciones sin salir, dudosos
               or (p.tipo <> 'devolucion' and p.datos ? 'sin_comprobar')
               -- intentos cerrados por nosotros cuya orden todavía no se canceló en Mercado Pago (el reloj lo hace en un minuto)
               or (p.tipo <> 'devolucion' and p.estado in ('vencido', 'rechazado') and p.proveedor_id is not null
                   and not (p.datos ? 'cerrada') and p.creado_en > now() - interval '2 days'))) then
    raise exception 'mp_con_pendientes';
  end if;
  if exists (select 1 from public.reservas r where r.consultorio_id = c.id and r.estado = 'pago') then
    raise exception 'hay_reservas_esperando_pago';
  end if;
  -- Turnos por venir ya pagados en el otro modo. Pagado de mentira: al pasar a real quedaría como pagado de verdad.
  -- Pagado de verdad: si se cancela estando en prueba, la devolución no podría salir. Primero se cancelan.
  if exists (
       select 1 from public.reservas r join public.pagos p on p.reserva_id = r.id and p.tipo <> 'devolucion' and p.estado = 'aprobado'
        where r.consultorio_id = c.id and r.estado = 'confirmada' and r.fecha >= interno.hoy(c.zona)
          and case when p_ambiente = 'real' then p.proveedor = 'simulado' or interno.mp_es_de_prueba(p.proveedor_id)
                   else p.proveedor = 'mercadopago' and not interno.mp_es_de_prueba(p.proveedor_id) end) then
    raise exception 'hay_turnos_pagados_en_el_otro_modo';
  end if;
  update public.consultorios set pagos_modo = 'mercadopago', mp_ambiente = p_ambiente where id = c.id;
  return format('%s cobra con Mercado Pago en modo %s%s', c.slug, p_ambiente,
                case when p_ambiente = 'real' and not exists (select 1 from interno.mp_cuentas k where k.consultorio_id = c.id
                                                                and k.estado = 'conectada' and k.ambiente = 'real')
                     then ': falta que la dueña conecte su cuenta desde Configuración' else '' end);
end $$;

-- ---------------------------------------------------------------------------------------------------
-- Permisos: lo nuevo es todo de adentro (y las tres que se reemplazan conservan los suyos)
-- ---------------------------------------------------------------------------------------------------
revoke all on function interno.mp_es_de_prueba(text) from public, anon, authenticated;
revoke all on function interno.mp_orden_del_ambiente() from public, anon, authenticated;
revoke all on function interno.mp_pasar_a(text, text) from public, anon, authenticated;
