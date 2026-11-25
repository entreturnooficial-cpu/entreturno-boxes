-- =====================================================================================================
-- Entreturno · Boxes — las reglas que pidió Yani para «Punto Almagro» (25/11/2026)
-- =====================================================================================================
-- Son opciones de cada consultorio: con los valores de fábrica, todo sigue como estaba.
--   1) Lema: la frase que va debajo del nombre («Alquiler de consultorios y gabinetes profesionales»).
--   2) La seña no se devuelve: lo que se devuelve al cancelar se calcula sobre lo pagado de más que la seña.
--   3) Turnos señados sin pagar: ahora puede ser «ninguno» (cero): hasta terminar de pagar, no reserva otro.
--   4) Reprogramar: la profesional puede mover un turno confirmado, las veces y con la anticipación que diga el consultorio, si hay
--      lugar y cuesta lo mismo. La dueña puede mover cualquiera. Lo pagado sigue valiendo.
--   5) Direcciones anteriores: si el consultorio cambia de dirección (yanina → puntoalmagro), la vieja sigue valiendo.
-- =====================================================================================================

alter table public.consultorios
  add column lema           text not null default 'Alquiler de boxes' check (char_length(btrim(lema)) between 1 and 80),
  add column sena_no_vuelve boolean not null default false,
  add column repro_max      integer not null default 0 check (repro_max between 0 and 5),     -- cuántas veces puede mover cada turno (0 = no se puede)
  add column repro_dias     integer not null default 3 check (repro_dias between 0 and 60),   -- con cuántos días de anticipación, como mínimo
  add column slugs_viejos   text[] not null default '{}' check (cardinality(slugs_viejos) <= 5 and not (slug = any (slugs_viejos)) and not ('' = any (slugs_viejos)));   -- direcciones que tuvo
alter table public.consultorios drop constraint consultorios_max_saldos_check;
alter table public.consultorios add constraint consultorios_max_saldos_check check (max_saldos is null or max_saldos between 0 and 20);

alter table public.reservas
  add column reprogramada   integer not null default 0 check (reprogramada >= 0),     -- cuántas veces la movió la profesional
  add column fecha_original date,                                                      -- cuándo era antes de moverla por primera vez
  add column desde_original integer check (desde_original between 0 and 23),
  add column politica_desde timestamptz,                                               -- lo más temprano que tuvo el turno por cambios de ella: de ahí se cuentan los días al cancelar
  add constraint original_completo check ((fecha_original is null) = (desde_original is null));

-- El consultorio se busca por su dirección de hoy o, si nadie la usa hoy, por una que tuvo un solo consultorio (si la tuvieron dos, no se adivina)
create or replace function interno.consultorio(p_slug text) returns public.consultorios
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  c public.consultorios;
  v_slug constant text := lower(btrim(coalesce(p_slug, '')));
begin
  select * into c from public.consultorios where activo and slug = v_slug;
  if not found then
    select * into c from public.consultorios
     where activo and v_slug = any (slugs_viejos)
       and (select count(*) from public.consultorios x where x.activo and v_slug = any (x.slugs_viejos)) = 1;
    if not found then raise exception 'consultorio_inexistente'; end if;
  end if;
  return c;
end $$;

-- Cada cambio, para poder mirar qué pasó
create table interno.reprogramaciones (
  id             uuid primary key default gen_random_uuid(),
  consultorio_id uuid not null references public.consultorios (id),
  reserva_id     uuid not null,
  quien          uuid not null,                       -- el miembro que la movió
  box_antes      uuid not null,
  fecha_antes    date not null,
  desde_antes    integer not null,
  hasta_antes    integer not null,
  box_despues    uuid not null,
  fecha_despues  date not null,
  desde_despues  integer not null,
  hasta_despues  integer not null,
  en             timestamptz not null default now(),
  foreign key (reserva_id, consultorio_id) references public.reservas (id, consultorio_id)
);
create index on interno.reprogramaciones (reserva_id);

-- ---------------------------------------------------------------------------------------------------
-- ¿Ese box se puede reservar en ese horario? (lo usan reservar y reprogramar)
--   · un rato libre publicado: entero, o el pedazo entero que quedó libre si ya hay una reserva adentro
--     (empieza donde empieza el rato o donde termina otra reserva, y termina donde termina el rato o donde empieza otra);
--   · o un turno entero de la grilla, sin bloqueos ni ratos adentro.
-- No mira si ya está tomado: eso lo impide la base (dos reservas no se pueden pisar). p_salvo: la reserva que se está moviendo.
-- ---------------------------------------------------------------------------------------------------
create function interno.horario_reservable(c public.consultorios, p_box uuid, p_fecha date, p_desde integer, p_hasta integer, p_salvo uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
       select 1 from public.ratos_libres r
        where r.box_id = p_box and r.fecha = p_fecha
          and greatest(r.desde, c.abre) <= p_desde and p_hasta <= least(r.hasta, c.cierra)
          and (p_desde = greatest(r.desde, c.abre)
               or exists (select 1 from public.reservas x
                           where x.box_id = p_box and x.fecha = p_fecha and x.estado <> 'cancelada' and x.hasta = p_desde and x.id is distinct from p_salvo))
          and (p_hasta = least(r.hasta, c.cierra)
               or exists (select 1 from public.reservas x
                           where x.box_id = p_box and x.fecha = p_fecha and x.estado <> 'cancelada' and x.desde = p_hasta and x.id is distinct from p_salvo)))
    or ((p_desde - c.abre) % c.turno_horas = 0 and p_hasta - p_desde = c.turno_horas
        and not interno.hay_bloqueo(p_box, p_fecha, p_desde, p_hasta)
        and not exists (select 1 from public.ratos_libres r where r.box_id = p_box and r.fecha = p_fecha and r.desde < p_hasta and r.hasta > p_desde))
$$;

create or replace function public.reservar(p_slug text, p_box integer, p_fecha date, p_desde integer, p_hasta integer, p_servicio text,
                                p_plan text, p_maquinas uuid[], p_reglamento_version integer)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c public.consultorios;
  m public.miembros;
  b public.boxes;
  k public.categorias;
  q public.maquinas;
  v_servicio text := interno.texto(p_servicio, 120);
  v_hoy date;
  v_horas integer;
  v_precio integer;
  v_total bigint;
  v_sena integer;
  v_pagar integer;
  v_saldos integer;
  v_vencidos integer;
  v_id uuid;
  v_maq uuid;
  v_vence timestamptz;
  v_restriccion text;
begin
  c := interno.consultorio(p_slug);
  m := interno.aprobada(c.id);                                          -- solo profesionales aprobadas
  c := interno.candado(c.id);                                           -- de acá en más nadie más toca la agenda de este consultorio
  perform interno.mantener(c.id);                                       -- libera lo que venció antes de mirar
  if p_plan is null or p_plan not in ('sena', 'total') then raise exception 'plan_invalido'; end if;
  if p_reglamento_version is distinct from c.reglamento_version then raise exception 'reglamento_cambio'; end if;

  select * into b from public.boxes where consultorio_id = c.id and numero = p_box and activo;
  if not found then raise exception 'box_inexistente'; end if;

  v_hoy := interno.hoy(c.zona);
  if p_fecha is null or p_desde is null or p_hasta is null or p_hasta <= p_desde or p_desde < c.abre or p_hasta > c.cierra
     or not (interno.dia_semana(p_fecha) = any (c.dias))
     or interno.instante(p_fecha, p_desde, c.zona) < now() then
    raise exception 'horario_no_disponible';
  end if;
  if p_fecha > interno.lunes(v_hoy) + c.semanas_adelante * 7 + 6 then raise exception 'fuera_de_rango'; end if;

  if not interno.horario_reservable(c, b.id, p_fecha, p_desde, p_hasta, null) then raise exception 'horario_no_disponible'; end if;

  if (select count(*) from public.reservas where miembro_id = m.id and estado = 'pago') >= c.max_sin_pagar then
    raise exception 'demasiadas_sin_pagar';
  end if;

  -- Saldos pendientes: los turnos que señó y todavía no terminó de pagar (confirmados, ya usados, o que está por señar).
  -- Cada profesional puede tener hasta «max_saldos». Con cero, hasta terminar de pagar el que tiene no reserva ningún otro (ni pagándolo
  -- entero). Con un número, al llegar a él:
  --   · si alguno es de un turno que ya empezó, no reserva nada hasta pagarlo;
  --   · si está al día, puede seguir reservando, pero pagando el turno nuevo completo.
  if c.max_saldos is not null then
    select count(*), count(*) filter (where x.estado <> 'pago' and interno.instante(x.fecha, x.desde, c.zona) <= now())
      into v_saldos, v_vencidos
      from public.reservas x
     where x.miembro_id = m.id
       and ((x.estado in ('confirmada', 'cumplida') and interno.pagado(x.id) < x.total)
            or (x.estado = 'pago' and x.plan = 'sena'));
    if c.max_saldos = 0 and v_saldos > 0 then raise exception 'saldo_pendiente'; end if;
    if c.max_saldos > 0 and v_saldos >= c.max_saldos then
      if v_vencidos > 0 then raise exception 'saldo_vencido'; end if;
      if p_plan = 'sena' and c.sena_pct < 100 then raise exception 'demasiados_saldos'; end if;
    end if;
  end if;

  -- El precio sale de la categoría de la profesional, salvo que el box tenga su propio precio para esa categoría
  select * into k from public.categorias where id = m.categoria_id;
  if not found then raise exception 'sin_categoria'; end if;
  select coalesce((select bp.precio_hora from public.box_precios bp where bp.box_id = b.id and bp.categoria_id = k.id), k.precio_hora)
    into v_precio;
  v_horas := p_hasta - p_desde;
  v_total := v_precio::bigint * v_horas;
  v_vence := now() + make_interval(mins => c.minutos_pago);
  if (select count(distinct x) from unnest(coalesce(p_maquinas, '{}'::uuid[])) as x where x is not null) > 10 then
    raise exception 'dato_invalido';
  end if;

  begin
    insert into public.reservas (consultorio_id, miembro_id, box_id, fecha, desde, hasta, servicio, categoria_id, categoria_nombre,
                                 precio_hora, monto_box, total, monto_sena, plan, estado, reglamento_version, vence_en)
    values (c.id, m.id, b.id, p_fecha, p_desde, p_hasta, v_servicio, k.id, k.nombre, v_precio, v_precio * v_horas, v_precio * v_horas, 0,
            p_plan, 'pago', c.reglamento_version, v_vence)
    returning id into v_id;

    for v_maq in select distinct x from unnest(coalesce(p_maquinas, '{}'::uuid[])) as x where x is not null loop
      select * into q from public.maquinas where id = v_maq and consultorio_id = c.id and activa and not quitada;
      if not found then raise exception 'maquina_no_disponible'; end if;
      insert into public.reserva_maquinas (reserva_id, maquina_id, consultorio_id, nombre, horas, precio_hora, monto, fecha, desde, hasta)
      values (v_id, q.id, c.id, q.nombre, v_horas, q.precio_hora, q.precio_hora * v_horas, p_fecha, p_desde, p_hasta);
      v_total := v_total + q.precio_hora::bigint * v_horas;
    end loop;
  exception when exclusion_violation then
    get stacked diagnostics v_restriccion = constraint_name;
    if v_restriccion = 'maquina_no_se_pisa' then raise exception 'maquina_no_disponible'; end if;
    raise exception 'horario_no_disponible';
  end;
  if v_total > 2000000000 then raise exception 'dato_invalido'; end if;

  -- La seña queda fija en este momento: si después la dueña cambia el porcentaje, esta reserva paga lo que se le informó
  v_sena := interno.sena(v_total::integer, c.sena_pct);
  v_pagar := case when p_plan = 'sena' then v_sena else v_total::integer end;
  if v_pagar = 0 then
    -- No hay nada para cobrar ahora (precio en cero): queda confirmada sin pasar por el pago
    update public.reservas set total = v_total, monto_sena = v_sena, estado = 'confirmada', vence_en = null where id = v_id;
    perform interno.avisar_confirmada(v_id);
    v_vence := null;
  else
    update public.reservas set total = v_total, monto_sena = v_sena where id = v_id;
  end if;
  return jsonb_build_object('id', v_id, 'total', v_total, 'amount', v_pagar, 'expiresAt', interno.ms(v_vence),
                            'status', case when v_pagar = 0 then 'confirmada' else 'pago' end);
end $$;

-- ---------------------------------------------------------------------------------------------------
-- Cancelar: igual que antes, más «la seña no se devuelve» y la fecha original de las reprogramadas
-- ---------------------------------------------------------------------------------------------------
create or replace function public.cancelar_reserva(p_slug text, p_reserva uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c public.consultorios;
  m public.miembros;
  r public.reservas;
  v_por text;
  v_pagado integer;
  v_por_mp integer;
  v_dias numeric;
  v_antes boolean;
  v_pct integer;
  v_monto integer;
  v_box text;
  v_quien text;
  nl constant text := chr(10);
begin
  c := interno.consultorio(p_slug);
  m := interno.yo(c.id);
  if m.id is null then raise exception 'reserva_inexistente'; end if;
  select * into r from public.reservas where id = p_reserva and consultorio_id = c.id for update;
  if not found then raise exception 'reserva_inexistente'; end if;
  if m.rol = 'admin' and m.estado = 'aprobado' then v_por := 'admin';
  elsif r.miembro_id = m.id then v_por := 'pro';
  else raise exception 'reserva_inexistente';
  end if;
  if r.estado not in ('pago', 'confirmada') then raise exception 'no_se_puede_cancelar'; end if;

  v_pagado := interno.pagado(r.id);
  select coalesce(sum(monto), 0)::integer into v_por_mp from public.pagos
   where reserva_id = r.id and estado = 'aprobado' and tipo <> 'devolucion' and proveedor = 'mercadopago';
  -- si lo cambió de día, cuenta la fecha más temprana que tuvo (la de ahora o alguna de antes): moverlo no sirve para esquivar la política
  v_dias := extract(epoch from (least(interno.instante(r.fecha, r.desde, c.zona), r.politica_desde) - now())) / 86400.0;
  v_antes := v_dias >= c.pol_dias;
  if c.sena_no_vuelve and v_por = 'pro' then
    -- la seña no se devuelve nunca: el porcentaje corre sobre lo que pagó de más que la seña
    v_monto := round(greatest(0, v_pagado - r.monto_sena)::numeric * (case when v_antes then c.pol_total_antes else c.pol_total_despues end) / 100)::integer;
    v_pct := case when v_pagado > 0 then round(v_monto * 100.0 / v_pagado)::integer else 0 end;
  else
    v_pct := case when v_por = 'admin' then 100
                  when v_pagado >= r.total then (case when v_antes then c.pol_total_antes else c.pol_total_despues end)
                  else (case when v_antes then c.pol_sena_antes else c.pol_sena_despues end) end;
    v_monto := round(v_pagado::numeric * v_pct / 100)::integer;
  end if;

  update public.reservas set estado = 'cancelada', cancelada_en = now(), cancelada_por = v_por,
                             devolucion_monto = v_monto, devolucion_pct = v_pct, vence_en = null
   where id = r.id;
  update public.reserva_maquinas set activa = false where reserva_id = r.id;
  -- los intentos de pago abiertos se cierran (si alguno se paga igual en Mercado Pago, esa plata se devuelve sola)
  update public.pagos set estado = 'vencido', actualizado_en = now() where reserva_id = r.id and estado = 'pendiente' and tipo <> 'devolucion';
  if v_monto > 0 then
    if v_por_mp > 0 then
      -- la plata entró por Mercado Pago: la devolución queda pendiente hasta que Mercado Pago la confirma
      insert into public.pagos (consultorio_id, reserva_id, tipo, monto, estado, proveedor, actualizado_en)
      values (c.id, r.id, 'devolucion', v_monto, 'pendiente', 'mercadopago', now() - interval '1 hour');
    else
      -- eran pagos de prueba: no hay plata que devolver
      insert into public.pagos (consultorio_id, reserva_id, tipo, monto, estado, proveedor, aprobado_en)
      values (c.id, r.id, 'devolucion', v_monto, 'aprobado', 'simulado', now());
    end if;
  end if;

  select nombre into v_box from public.boxes where id = r.box_id;
  select nombre into v_quien from public.miembros where id = r.miembro_id;
  perform interno.avisar(r.miembro_id, 'Reserva cancelada: ' || v_box || ', ' || interno.dia_largo(r.fecha),
    'Hola ' || interno.primer_nombre(v_quien) || ':' || nl || nl
    || case when v_por = 'admin' then 'La administradora canceló' else 'Cancelaste' end || ' tu reserva de ' || v_box || ' del '
    || interno.dia_largo(r.fecha) || ' (' || r.desde || ' a ' || r.hasta || ' h).' || nl || nl
    || 'Pagado: ' || interno.plata(v_pagado) || nl || 'Devolución: ' || interno.plata(v_monto) || ' (' || v_pct || ' %)' || nl
    || case when v_monto = 0 then 'Según la política de cancelación, no corresponde devolución.'
            else 'Te devolvemos ' || interno.plata(v_monto) || ' por el mismo medio con el que pagaste (puede tardar unos días).' end
    || nl || nl || c.nombre);
  if v_por = 'pro' then
    perform interno.avisar_admin(c.id, 'Cancelación: ' || v_quien,
      v_quien || ' canceló ' || v_box || ' del ' || interno.dia_largo(r.fecha) || ' (' || r.desde || ' a ' || r.hasta || ' h).' || nl
      || 'Devolución: ' || interno.plata(v_monto) || '.' || nl || 'El horario volvió a quedar libre.');
  end if;
  return jsonb_build_object('amount', v_monto, 'pct', v_pct, 'paid', v_pagado, 'by', v_por);
end $$;

-- ---------------------------------------------------------------------------------------------------
-- Mover un turno confirmado. Lo pagado sigue valiendo: por eso tiene que durar y costar lo mismo.
-- ---------------------------------------------------------------------------------------------------
create function public.reprogramar_reserva(p_slug text, p_reserva uuid, p_box integer, p_fecha date, p_desde integer) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c public.consultorios;
  m public.miembros;
  r public.reservas;
  b public.boxes;
  v_admin boolean;
  v_hasta integer;
  v_antes text;
  v_despues text;
  v_quien text;
  v_restriccion text;
  nl constant text := chr(10);
begin
  c := interno.candado((interno.consultorio(p_slug)).id);
  m := interno.yo(c.id);
  if m.id is null then raise exception 'reserva_inexistente'; end if;
  v_admin := m.rol = 'admin' and m.estado = 'aprobado';
  select * into r from public.reservas where id = p_reserva and consultorio_id = c.id for update;
  if not found or not (v_admin or r.miembro_id = m.id) then raise exception 'reserva_inexistente'; end if;
  if r.estado <> 'confirmada' or interno.instante(r.fecha, r.desde, c.zona) <= now() then raise exception 'no_se_puede_reprogramar'; end if;
  if not v_admin then
    m := interno.aprobada(c.id);
    if c.repro_max = 0 then raise exception 'sin_reprogramacion'; end if;
    if r.reprogramada >= c.repro_max then raise exception 'ya_reprogramada'; end if;
    if extract(epoch from (interno.instante(r.fecha, r.desde, c.zona) - now())) / 86400.0 < c.repro_dias then raise exception 'tarde_para_reprogramar'; end if;
  end if;

  select * into b from public.boxes where consultorio_id = c.id and numero = p_box and activo;
  if not found then raise exception 'box_inexistente'; end if;
  v_hasta := p_desde + (r.hasta - r.desde);
  if p_fecha is null or p_desde is null or p_desde < c.abre or v_hasta > c.cierra or not (interno.dia_semana(p_fecha) = any (c.dias))
     or interno.instante(p_fecha, p_desde, c.zona) < now() then
    raise exception 'horario_no_disponible';
  end if;
  if p_fecha > interno.lunes(interno.hoy(c.zona)) + c.semanas_adelante * 7 + 6 then raise exception 'fuera_de_rango'; end if;
  if b.id = r.box_id and p_fecha = r.fecha and p_desde = r.desde then raise exception 'mismo_horario'; end if;
  -- a otro box, solo si hoy cuesta lo mismo que lo que se le cobró por hora: así lo que pagó y lo que debe no cambian
  if b.id <> r.box_id and r.precio_hora is distinct from
     (select coalesce((select bp.precio_hora from public.box_precios bp where bp.box_id = b.id and bp.categoria_id = r.categoria_id), k.precio_hora)
        from public.categorias k where k.id = r.categoria_id) then
    raise exception 'otro_precio';
  end if;
  if not interno.horario_reservable(c, b.id, p_fecha, p_desde, v_hasta, r.id) then raise exception 'horario_no_disponible'; end if;

  begin
    update public.reservas
       set box_id = b.id, fecha = p_fecha, desde = p_desde, hasta = v_hasta, recordada = false,
           reprogramada = reprogramada + case when v_admin then 0 else 1 end,
           fecha_original = coalesce(fecha_original, r.fecha), desde_original = coalesce(desde_original, r.desde),
           politica_desde = case when v_admin then politica_desde else least(politica_desde, interno.instante(r.fecha, r.desde, c.zona)) end
     where id = r.id;
    update public.reserva_maquinas set fecha = p_fecha, desde = p_desde, hasta = v_hasta where reserva_id = r.id and activa;
  exception when exclusion_violation then
    get stacked diagnostics v_restriccion = constraint_name;
    if v_restriccion = 'maquina_no_se_pisa' then raise exception 'maquina_no_disponible'; end if;
    raise exception 'horario_no_disponible';
  end;
  insert into interno.reprogramaciones (consultorio_id, reserva_id, quien, box_antes, fecha_antes, desde_antes, hasta_antes,
                                        box_despues, fecha_despues, desde_despues, hasta_despues)
  values (c.id, r.id, m.id, r.box_id, r.fecha, r.desde, r.hasta, b.id, p_fecha, p_desde, v_hasta);

  select nombre || ', ' || interno.dia_largo(r.fecha) || ', de ' || r.desde || ' a ' || r.hasta || ' h' into v_antes from public.boxes where id = r.box_id;
  v_despues := b.nombre || ', ' || interno.dia_largo(p_fecha) || ', de ' || p_desde || ' a ' || v_hasta || ' h';
  select nombre into v_quien from public.miembros where id = r.miembro_id;
  perform interno.avisar(r.miembro_id, 'Turno reprogramado: ' || b.nombre || ', ' || interno.dia_largo(p_fecha),
    'Hola ' || interno.primer_nombre(v_quien) || ':' || nl || nl
    || case when v_admin then 'La administradora cambió tu turno.' else 'Cambiaste tu turno.' end || nl || nl
    || 'Antes: ' || v_antes || '.' || nl || 'Ahora: ' || v_despues || '.' || nl || nl || 'Lo que ya pagaste sigue valiendo.' || nl || nl || c.nombre);
  if not v_admin then
    perform interno.avisar_admin(c.id, 'Turno reprogramado: ' || v_quien,
      v_quien || ' cambió su turno.' || nl || nl || 'Antes: ' || v_antes || '.' || nl || 'Ahora: ' || v_despues || '.');
  end if;
  return jsonb_build_object('id', r.id, 'date', p_fecha, 'start', p_desde, 'end', v_hasta);
end $$;

-- La política entera, en un solo paso (los tres últimos, si no vienen, quedan como están: así la página anterior sigue andando)
drop function public.guardar_politica(text, integer, integer, integer, integer, integer);
create function public.guardar_politica(p_slug text, p_dias integer, p_sena_antes integer, p_sena_despues integer,
                                        p_total_antes integer, p_total_despues integer,
                                        p_sena_no_vuelve boolean default null, p_repro_max integer default null, p_repro_dias integer default null)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c public.consultorios;
begin
  c := interno.consultorio(p_slug);
  perform interno.admin(c.id);
  c := interno.candado(c.id);
  if p_dias is null or p_sena_antes is null or p_sena_despues is null or p_total_antes is null or p_total_despues is null then
    raise exception 'dato_invalido';
  end if;
  begin
    update public.consultorios
       set pol_dias = p_dias, pol_sena_antes = p_sena_antes, pol_sena_despues = p_sena_despues,
           pol_total_antes = p_total_antes, pol_total_despues = p_total_despues,
           sena_no_vuelve = coalesce(p_sena_no_vuelve, sena_no_vuelve), repro_max = coalesce(p_repro_max, repro_max),
           repro_dias = coalesce(p_repro_dias, repro_dias)
     where id = c.id;
  exception when check_violation then
    raise exception 'dato_invalido';
  end;
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------------------------------------------
-- Lo que se le manda a la página
-- ---------------------------------------------------------------------------------------------------
create or replace function interno.j_sitio(c public.consultorios) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('slug', c.slug, 'name', c.nombre, 'owner', c.duena, 'letters', c.letras, 'tagline', c.lema, 'payments', c.pagos_modo,
                            'mp', case when c.pagos_modo = 'mercadopago'
                                       then jsonb_build_object('env', c.mp_ambiente, 'ready', interno.mp_lista(c)) end,
                            'privacy', (select jsonb_build_object('version', interno.privacidad_version(), 'text', t.texto,
                                                                  'hash', interno.privacidad_huella(t.texto))
                                          from (select interno.privacidad_texto(c) as texto) t))
$$;

create or replace function interno.j_config(c public.consultorios, p_admin boolean) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'open', c.abre, 'close', c.cierra, 'days', to_jsonb(c.dias), 'turnHours', c.turno_horas,
    'weeksAhead', c.semanas_adelante, 'depositPct', c.sena_pct, 'mpMinutes', c.minutos_pago, 'maxUnpaid', c.max_sin_pagar,
    'maxOpenBalances', c.max_saldos,
    'policy', jsonb_build_object('days', c.pol_dias, 'senaBefore', c.pol_sena_antes, 'senaAfter', c.pol_sena_despues,
                                 'totalBefore', c.pol_total_antes, 'totalAfter', c.pol_total_despues,
                                 'depositKept', c.sena_no_vuelve, 'moves', c.repro_max, 'moveDays', c.repro_dias),
    'categories', interno.j_categorias(c.id),
    'terms', jsonb_build_object('version', c.reglamento_version, 'text', c.reglamento),
    'billing', case when p_admin then jsonb_build_object('name', c.fact_nombre, 'cuit', c.fact_cuit, 'cond', c.fact_condicion,
                                                         'pos', c.fact_punto_venta, 'env', c.fact_ambiente,
                                                         'address', c.fact_domicilio, 'iibb', c.fact_iibb,
                                                         'start', c.fact_inicio) end,
    'privacy', case when p_admin then jsonb_build_object('name', c.priv_responsable, 'address', c.priv_domicilio, 'contact', c.priv_contacto,
                                                         'complete', c.priv_responsable <> '' and c.priv_domicilio <> '' and c.priv_contacto <> '') end,
    'mp', case when p_admin then interno.j_mp(c) end)
$$;

create or replace function interno.j_reserva(r public.reservas) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'id', r.id, 'moved', r.reprogramada,
    'original', case when r.fecha_original is not null then jsonb_build_object('date', r.fecha_original, 'start', r.desde_original) end,
    'policyFrom', interno.ms(r.politica_desde), 'userId', r.miembro_id, 'boxId', (select numero from public.boxes where id = r.box_id),
    'date', r.fecha, 'start', r.desde, 'end', r.hasta, 'service', r.servicio,
    'category', r.categoria_id, 'categoryName', r.categoria_nombre, 'rate', r.precio_hora, 'boxAmount', r.monto_box,
    'machines', coalesce((select jsonb_agg(jsonb_build_object('id', rm.maquina_id, 'name', rm.nombre, 'hours', rm.horas,
                                                              'rate', rm.precio_hora, 'amount', rm.monto) order by rm.nombre, rm.maquina_id)
                            from public.reserva_maquinas rm where rm.reserva_id = r.id), '[]'::jsonb),
    'total', r.total, 'deposit', r.monto_sena, 'plan', r.plan, 'status', r.estado,
    'payments', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'kind', p.tipo, 'amount', p.monto, 'status', p.estado,
                                                              'at', interno.ms(coalesce(p.aprobado_en, p.creado_en)),
                                                              'via', p.proveedor, 'note', p.error)
                                           order by p.creado_en, p.id)
                            from public.pagos p
                           where p.reserva_id = r.id
                             and (p.estado = 'aprobado' or (p.tipo = 'devolucion' and p.estado = 'pendiente'))), '[]'::jsonb),
    'pending', (select jsonb_build_object('id', p.id, 'kind', p.tipo, 'amount', p.monto, 'expiresAt', interno.ms(p.vence_en),
                                          'started', p.enlace is not null)
                  from public.pagos p
                 where p.reserva_id = r.id and p.proveedor = 'mercadopago' and p.tipo <> 'devolucion' and p.estado = 'pendiente'
                   and p.vence_en > now()
                 order by p.creado_en desc limit 1),
    'surplus', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'amount', p.monto, 'done', p.estado = 'devuelto',
                                                             'at', interno.ms(coalesce(p.aprobado_en, p.creado_en)), 'note', p.error)
                                          order by p.creado_en, p.id)
                           from public.pagos p where p.reserva_id = r.id and p.estado in ('sobrante', 'devuelto')), '[]'::jsonb),
    'termsVersion', r.reglamento_version, 'createdAt', interno.ms(r.creada_en), 'expiresAt', interno.ms(r.vence_en),
    'cancelledAt', interno.ms(r.cancelada_en), 'cancelledBy', r.cancelada_por,
    'refund', case when r.estado = 'cancelada' then jsonb_build_object(
                'amount', coalesce(r.devolucion_monto, 0), 'pct', coalesce(r.devolucion_pct, 0),
                'done', coalesce(r.devolucion_monto, 0) = 0
                        or exists (select 1 from public.pagos p where p.reserva_id = r.id and p.tipo = 'devolucion' and p.estado = 'aprobado')) end)
$$;


-- ---------------------------------------------------------------------------------------------------
-- Candado y permisos
-- ---------------------------------------------------------------------------------------------------
alter table interno.reprogramaciones enable row level security;
revoke all on table interno.reprogramaciones from public, anon, authenticated;
revoke all on function interno.horario_reservable(public.consultorios, uuid, date, integer, integer, uuid) from public, anon, authenticated;
do $$
declare
  f record;
begin
  for f in select oid::regprocedure as firma from pg_proc where pronamespace = 'public'::regnamespace and proname in ('reprogramar_reserva', 'guardar_politica') loop
    execute format('revoke all on function %s from public, anon, authenticated', f.firma);
    execute format('grant execute on function %s to authenticated', f.firma);
  end loop;
end $$;
