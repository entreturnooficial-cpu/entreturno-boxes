-- =====================================================================================================
-- Entreturno · Boxes — 2 de 2: las funciones
-- =====================================================================================================
-- La página solo puede llamar las funciones de "public" de la lista del final. Cada una:
--   · averigua el consultorio por su nombre corto (p_slug: «yanina»),
--   · averigua quién llama (auth.uid()) y qué es en ese consultorio (dueña, profesional aprobada…),
--   · hace el trabajo y, si algo no corresponde, corta con un código corto («horario_no_disponible»).
-- Los precios, la seña y las devoluciones se calculan SIEMPRE acá, nunca con lo que mande la página.
-- =====================================================================================================

-- ---------------------------------------------------------------------------------------------------
-- Ayudantes
-- ---------------------------------------------------------------------------------------------------
create function interno.consultorio(p_slug text) returns public.consultorios
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  c public.consultorios;
begin
  select * into c from public.consultorios where slug = lower(btrim(coalesce(p_slug, ''))) and activo;
  if not found then raise exception 'consultorio_inexistente'; end if;
  return c;
end $$;

-- Quién llama, dentro de ese consultorio. Sin sesión corta; si no es miembro, devuelve todo en nulo.
create function interno.yo(p_consultorio uuid) returns public.miembros
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  m public.miembros;
begin
  if auth.uid() is null then raise exception 'sin_sesion'; end if;
  select * into m from public.miembros where consultorio_id = p_consultorio and usuario_id = auth.uid();
  return m;
end $$;

-- El candado del consultorio: todo lo que cambia la agenda (reservar, bloquear, publicar ratos, cambiar horarios o
-- el reglamento) corre de a una operación por vez en cada consultorio. Así dos pedidos simultáneos no se pisan.
-- Devuelve el consultorio leído DESPUÉS de esperar su turno, o sea con los datos al día.
create function interno.candado(p_consultorio uuid) returns public.consultorios
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c public.consultorios;
begin
  select * into c from public.consultorios where id = p_consultorio for no key update;
  return c;
end $$;

create function interno.admin(p_consultorio uuid) returns public.miembros
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  m public.miembros;
begin
  m := interno.yo(p_consultorio);
  if m.id is null or m.rol <> 'admin' or m.estado <> 'aprobado' then raise exception 'solo_admin'; end if;
  return m;
end $$;

create function interno.aprobada(p_consultorio uuid) returns public.miembros
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  m public.miembros;
begin
  m := interno.yo(p_consultorio);
  if m.id is null or m.rol <> 'pro' or m.estado <> 'aprobado' then raise exception 'no_aprobada'; end if;
  return m;
end $$;

-- Fechas y horas del consultorio
create function interno.instante(p_fecha date, p_hora integer, p_zona text) returns timestamptz
language sql stable set search_path = public, pg_temp as $$
  select (p_fecha::timestamp + make_interval(hours => p_hora)) at time zone p_zona
$$;

create function interno.hoy(p_zona text) returns date
language sql stable set search_path = public, pg_temp as $$
  select (now() at time zone p_zona)::date
$$;

create function interno.lunes(p_fecha date) returns date
language sql immutable set search_path = public, pg_temp as $$
  select p_fecha - ((extract(dow from p_fecha)::integer + 6) % 7)
$$;

create function interno.dia_semana(p_fecha date) returns integer
language sql immutable set search_path = public, pg_temp as $$
  select extract(dow from p_fecha)::integer
$$;

-- Un instante como lo usa la página: milisegundos
create function interno.ms(p_t timestamptz) returns bigint
language sql immutable set search_path = public, pg_temp as $$
  select (extract(epoch from p_t) * 1000)::bigint
$$;

-- Textos
create function interno.plata(p_n integer) returns text
language sql immutable set search_path = public, pg_temp as $$
  select '$ ' || regexp_replace(p_n::text, '(\d)(?=(\d{3})+$)', '\1.', 'g')
$$;

create function interno.dia_largo(p_fecha date) returns text
language sql immutable set search_path = public, pg_temp as $$
  select (array['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'])[extract(dow from p_fecha)::integer + 1]
         || ' ' || extract(day from p_fecha)::integer || ' de '
         || (array['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre',
                   'noviembre', 'diciembre'])[extract(month from p_fecha)::integer]
$$;

create function interno.cap(p_t text) returns text
language sql immutable set search_path = public, pg_temp as $$
  select upper(left(p_t, 1)) || substr(p_t, 2)
$$;

create function interno.primer_nombre(p_nombre text) returns text
language sql immutable set search_path = public, pg_temp as $$
  select split_part(btrim(p_nombre), ' ', 1)
$$;

-- Un texto que mandó la página: sin espacios de más, con tope de largo y, si hace falta, obligatorio
create function interno.texto(p_valor text, p_max integer, p_obligatorio boolean default false) returns text
language plpgsql immutable set search_path = public, pg_temp as $$
declare
  v text := btrim(coalesce(p_valor, ''));
begin
  if char_length(v) > p_max or (p_obligatorio and v = '') then raise exception 'dato_invalido'; end if;
  return v;
end $$;

-- ---------------------------------------------------------------------------------------------------
-- Avisos (la cola de mails)
-- ---------------------------------------------------------------------------------------------------
create function interno.avisar(p_miembro uuid, p_asunto text, p_cuerpo text) returns void
language sql security definer set search_path = public, pg_temp as $$
  insert into public.avisos (consultorio_id, miembro_id, para, asunto, cuerpo)
  select m.consultorio_id, m.id, m.email, p_asunto, p_cuerpo from public.miembros m where m.id = p_miembro
$$;

create function interno.avisar_admin(p_consultorio uuid, p_asunto text, p_cuerpo text) returns void
language sql security definer set search_path = public, pg_temp as $$
  insert into public.avisos (consultorio_id, miembro_id, para, asunto, cuerpo)
  select m.consultorio_id, m.id, m.email, p_asunto, p_cuerpo
    from public.miembros m where m.consultorio_id = p_consultorio and m.rol = 'admin' and m.estado = 'aprobado'
$$;

-- ---------------------------------------------------------------------------------------------------
-- Agenda: bloqueos, plata pagada y mantenimiento
-- ---------------------------------------------------------------------------------------------------
create function interno.hay_bloqueo(p_box uuid, p_fecha date, p_desde integer, p_hasta integer) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.bloqueos b join public.bloqueo_boxes bb on bb.bloqueo_id = b.id
     where bb.box_id = p_box
       and ((b.recurrente and b.dia_semana = interno.dia_semana(p_fecha)) or (not b.recurrente and b.fecha = p_fecha))
       and b.desde < p_hasta and b.hasta > p_desde)
$$;

-- ¿Ese tramo entra entero dentro de un bloqueo de ese box y ese día?
create function interno.dentro_de_bloqueo(p_box uuid, p_fecha date, p_desde integer, p_hasta integer) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.bloqueos b join public.bloqueo_boxes bb on bb.bloqueo_id = b.id
     where bb.box_id = p_box
       and ((b.recurrente and b.dia_semana = interno.dia_semana(p_fecha)) or (not b.recurrente and b.fecha = p_fecha))
       and b.desde <= p_desde and b.hasta >= p_hasta)
$$;

-- Lo cobrado de una reserva: pagos aprobados, sin contar devoluciones
create function interno.pagado(p_reserva uuid) returns integer
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(monto), 0)::integer from public.pagos
   where reserva_id = p_reserva and estado = 'aprobado' and tipo <> 'devolucion'
$$;

create function interno.sena(p_total integer, p_pct integer) returns integer
language sql immutable set search_path = public, pg_temp as $$
  select round(p_total::numeric * p_pct / 100)::integer
$$;

-- Se llama antes de mirar o tocar la agenda: libera las reservas que no se pagaron a tiempo,
-- da por cumplidos los turnos que ya terminaron y deja listo el recordatorio del día anterior.
create function interno.mantener(p_consultorio uuid) returns void
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
    returning id, miembro_id, box_id, fecha, desde, hasta, total
  loop
    perform interno.avisar(r.miembro_id, 'Recordatorio: mañana tenés ' || (select nombre from public.boxes where id = r.box_id),
      'Hola ' || interno.primer_nombre((select nombre from public.miembros where id = r.miembro_id)) || ':' || nl || nl
      || 'Te recordamos tu turno: ' || (select nombre from public.boxes where id = r.box_id) || ' · ' || interno.cap(interno.dia_largo(r.fecha))
      || ' · ' || r.desde || ' a ' || r.hasta || ' h.'
      || case when r.total > interno.pagado(r.id) then nl || 'Te queda pagar el saldo: ' || interno.plata(r.total - interno.pagado(r.id)) || '.' else '' end
      || nl || nl || c.nombre);
  end loop;
end $$;

-- Lo mismo para todos los consultorios: lo corre el reloj del servidor cada pocos minutos (ver el archivo del reloj),
-- para que los vencimientos y los recordatorios no dependan de que alguien entre a la página.
create function interno.mantener_todos() returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c record;
  n integer := 0;
begin
  for c in select id from public.consultorios where activo loop
    perform interno.mantener(c.id);
    n := n + 1;
  end loop;
  return n;
end $$;

-- El mail de «reserva confirmada»
create function interno.avisar_confirmada(p_reserva uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r public.reservas;
  v_consultorio text;
  v_box text;
  v_equipos text;
  v_pagado integer;
  nl constant text := chr(10);
begin
  select * into r from public.reservas where id = p_reserva;
  select nombre into v_consultorio from public.consultorios where id = r.consultorio_id;
  select nombre into v_box from public.boxes where id = r.box_id;
  select string_agg(nombre, ', ' order by nombre) into v_equipos from public.reserva_maquinas where reserva_id = r.id;
  v_pagado := interno.pagado(r.id);
  perform interno.avisar(r.miembro_id, 'Reserva confirmada: ' || v_box || ', ' || interno.dia_largo(r.fecha),
    'Hola ' || interno.primer_nombre((select nombre from public.miembros where id = r.miembro_id)) || ':' || nl || nl
    || 'Tu reserva está confirmada.' || nl
    || v_box || ' · ' || interno.cap(interno.dia_largo(r.fecha)) || ' · ' || r.desde || ' a ' || r.hasta || ' h'
    || case when v_equipos is not null then nl || 'Equipos: ' || v_equipos else '' end || nl || nl
    || case when r.total = 0 then 'No hay nada para pagar.'
            else 'Pagaste ' || interno.plata(v_pagado)
                 || case when r.total > v_pagado then '. Saldo a pagar antes del turno: ' || interno.plata(r.total - v_pagado) else ' (total)' end || '.' end
    || nl || nl || 'Recordá dejar el box limpio y ordenado.' || nl || nl || v_consultorio);
end $$;

-- Deja acreditado un pago y, si la reserva estaba esperando el pago, la confirma.
create function interno.acreditar(p_reserva uuid, p_tipo text, p_monto integer, p_proveedor text, p_proveedor_id text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r public.reservas;
  v_consultorio text;
  v_box text;
  v_pagado integer;
  nl constant text := chr(10);
begin
  select * into r from public.reservas where id = p_reserva for update;
  if not found then raise exception 'reserva_inexistente'; end if;

  insert into public.pagos (consultorio_id, reserva_id, tipo, monto, estado, proveedor, proveedor_id, aprobado_en)
  values (r.consultorio_id, r.id, p_tipo, p_monto, 'aprobado', p_proveedor, p_proveedor_id, now());
  if r.estado = 'pago' then
    update public.reservas set estado = 'confirmada', vence_en = null where id = r.id;
    perform interno.avisar_confirmada(r.id);
  else
    select nombre into v_consultorio from public.consultorios where id = r.consultorio_id;
    select nombre into v_box from public.boxes where id = r.box_id;
    v_pagado := interno.pagado(r.id);
    perform interno.avisar(r.miembro_id, 'Recibimos tu pago',
      'Hola ' || interno.primer_nombre((select nombre from public.miembros where id = r.miembro_id)) || ':' || nl || nl
      || 'Recibimos ' || interno.plata(p_monto) || ' para ' || v_box || ' del ' || interno.dia_largo(r.fecha) || '. '
      || case when r.total > v_pagado then 'Te queda ' || interno.plata(r.total - v_pagado) || '.' else 'Tu turno está pago completo.' end
      || nl || nl || v_consultorio);
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------------
-- Lo que se le manda a la página (con los mismos nombres que usa la página)
-- ---------------------------------------------------------------------------------------------------
create function interno.j_categorias(p_consultorio uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', k.id, 'name', k.nombre, 'note', k.nota, 'pricePerHour', k.precio_hora)
                            order by k.orden, k.creada_en, k.id), '[]'::jsonb)
    from public.categorias k where k.consultorio_id = p_consultorio and k.activa
$$;

create function interno.j_sitio(c public.consultorios) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('slug', c.slug, 'name', c.nombre, 'owner', c.duena, 'letters', c.letras, 'payments', c.pagos_modo)
$$;

-- Lo que puede ver cualquiera antes de entrar: el nombre del consultorio y las categorías con su precio
create function interno.j_portada(c public.consultorios) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'site', interno.j_sitio(c),
    'config', jsonb_build_object('turnHours', c.turno_horas, 'depositPct', c.sena_pct, 'categories', interno.j_categorias(c.id)),
    'boxCount', (select count(*) from public.boxes b where b.consultorio_id = c.id and b.activo))
$$;

create function interno.j_config(c public.consultorios, p_admin boolean) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'open', c.abre, 'close', c.cierra, 'days', to_jsonb(c.dias), 'turnHours', c.turno_horas,
    'weeksAhead', c.semanas_adelante, 'depositPct', c.sena_pct, 'mpMinutes', c.minutos_pago, 'maxUnpaid', c.max_sin_pagar,
    'maxOpenBalances', c.max_saldos,
    'policy', jsonb_build_object('days', c.pol_dias, 'senaBefore', c.pol_sena_antes, 'senaAfter', c.pol_sena_despues,
                                 'totalBefore', c.pol_total_antes, 'totalAfter', c.pol_total_despues),
    'categories', interno.j_categorias(c.id),
    'terms', jsonb_build_object('version', c.reglamento_version, 'text', c.reglamento),
    'billing', case when p_admin then jsonb_build_object('name', c.fact_nombre, 'cuit', c.fact_cuit, 'cond', c.fact_condicion,
                                                         'pos', c.fact_punto_venta) end)
$$;

create function interno.j_boxes(p_consultorio uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', b.numero, 'name', b.nombre, 'short', b.resumen, 'equipment', to_jsonb(b.equipamiento), 'photo', b.foto,
           'prices', coalesce((select jsonb_object_agg(bp.categoria_id::text, bp.precio_hora)
                                 from public.box_precios bp join public.categorias k on k.id = bp.categoria_id and k.activa
                                where bp.box_id = b.id), '{}'::jsonb))
         order by b.numero), '[]'::jsonb)
    from public.boxes b where b.consultorio_id = p_consultorio and b.activo
$$;

create function interno.j_maquinas(p_consultorio uuid, p_admin boolean) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', q.id, 'name', q.nombre, 'short', q.resumen, 'pricePerHour', q.precio_hora,
                                               'active', q.activa, 'photo', q.foto)
                            order by q.creada_en, q.id), '[]'::jsonb)
    from public.maquinas q where q.consultorio_id = p_consultorio and not q.quitada and (p_admin or q.activa)
$$;

-- p_solo: nulo = todas las personas del consultorio (para la dueña); si no, solo esa
create function interno.j_miembros(p_consultorio uuid, p_solo uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', m.id, 'role', m.rol, 'name', m.nombre, 'profession', m.profesion, 'category', m.categoria_id, 'cuit', m.cuit,
           'email', m.email, 'phone', m.telefono, 'status', m.estado, 'since', interno.ms(m.desde))
         order by m.desde, m.id), '[]'::jsonb)
    from public.miembros m where m.consultorio_id = p_consultorio and (p_solo is null or m.id = p_solo)
$$;

-- Las profesionales ven los bloqueos sin la nota (la nota es solo para la dueña) y solo los que siguen vigentes
create function interno.j_bloqueos(p_consultorio uuid, p_admin boolean, p_desde date) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', b.id, 'recurring', b.recurrente, 'weekday', b.dia_semana, 'date', b.fecha, 'start', b.desde, 'end', b.hasta,
           'note', case when p_admin then b.nota else '' end,
           'boxIds', coalesce((select jsonb_agg(x.numero order by x.numero) from public.bloqueo_boxes bb join public.boxes x on x.id = bb.box_id
                                where bb.bloqueo_id = b.id), '[]'::jsonb))
         order by b.creado_en, b.id), '[]'::jsonb)
    from public.bloqueos b where b.consultorio_id = p_consultorio and (p_admin or b.recurrente or b.fecha >= p_desde)
$$;

create function interno.j_ratos(p_consultorio uuid, p_desde date) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'boxId', x.numero, 'date', r.fecha, 'start', r.desde, 'end', r.hasta)
                            order by r.fecha, r.desde, r.id), '[]'::jsonb)
    from public.ratos_libres r join public.boxes x on x.id = r.box_id
   where r.consultorio_id = p_consultorio and r.fecha >= p_desde
$$;

-- Una reserva con todo su detalle: para su dueña y para la administradora
create function interno.j_reserva(r public.reservas) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'id', r.id, 'userId', r.miembro_id, 'boxId', (select numero from public.boxes where id = r.box_id),
    'date', r.fecha, 'start', r.desde, 'end', r.hasta, 'service', r.servicio,
    'category', r.categoria_id, 'categoryName', r.categoria_nombre, 'rate', r.precio_hora, 'boxAmount', r.monto_box,
    'machines', coalesce((select jsonb_agg(jsonb_build_object('id', rm.maquina_id, 'name', rm.nombre, 'hours', rm.horas,
                                                              'rate', rm.precio_hora, 'amount', rm.monto) order by rm.nombre, rm.maquina_id)
                            from public.reserva_maquinas rm where rm.reserva_id = r.id), '[]'::jsonb),
    'total', r.total, 'deposit', r.monto_sena, 'plan', r.plan, 'status', r.estado,
    'payments', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'kind', p.tipo, 'amount', p.monto, 'status', p.estado,
                                                              'at', interno.ms(coalesce(p.aprobado_en, p.creado_en)))
                                           order by p.creado_en, p.id)
                            from public.pagos p where p.reserva_id = r.id and p.estado in ('aprobado', 'pendiente')), '[]'::jsonb),
    'termsVersion', r.reglamento_version, 'createdAt', interno.ms(r.creada_en), 'expiresAt', interno.ms(r.vence_en),
    'cancelledAt', interno.ms(r.cancelada_en), 'cancelledBy', r.cancelada_por,
    'refund', case when r.estado = 'cancelada' then jsonb_build_object(
                'amount', coalesce(r.devolucion_monto, 0), 'pct', coalesce(r.devolucion_pct, 0),
                'done', coalesce(r.devolucion_monto, 0) = 0
                        or exists (select 1 from public.pagos p where p.reserva_id = r.id and p.tipo = 'devolucion' and p.estado = 'aprobado')) end)
$$;

-- Una reserva ajena, como la ve otra profesional: ocupado, sin nombre ni servicio ni plata
create function interno.j_ocupado(r public.reservas) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'id', 'x' || substr(md5(r.id::text), 1, 12), 'userId', null, 'boxId', (select numero from public.boxes where id = r.box_id),
    'date', r.fecha, 'start', r.desde, 'end', r.hasta, 'status', 'ocupado', 'total', 0, 'payments', '[]'::jsonb,
    'machines', coalesce((select jsonb_agg(jsonb_build_object('id', rm.maquina_id) order by rm.maquina_id)
                            from public.reserva_maquinas rm where rm.reserva_id = r.id and rm.activa), '[]'::jsonb))
$$;

create function interno.j_facturas(p_consultorio uuid, p_solo uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', f.id, 'userId', f.miembro_id, 'period', f.periodo, 'letter', f.letra,
           'number', lpad(f.punto_venta::text, 4, '0') || '-' || lpad(f.numero::text, 8, '0'),
           'cae', f.cae, 'at', interno.ms(f.emitida_en), 'hours', f.horas, 'total', f.total, 'lines', f.lineas)
         order by f.emitida_en, f.id), '[]'::jsonb)
    from public.facturas f where f.consultorio_id = p_consultorio and (p_solo is null or f.miembro_id = p_solo)
$$;

-- ===================================================================================================
-- FUNCIONES QUE LLAMA LA PÁGINA
-- ===================================================================================================

-- Antes de entrar: nombre del consultorio y categorías (para la pantalla de ingreso y «Pedir acceso»)
create function public.portada(p_slug text) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  return interno.j_portada(interno.consultorio(p_slug));
end $$;

-- Todo lo que esa persona puede ver del consultorio, de una sola vez
create function public.foto(p_slug text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c public.consultorios;
  m public.miembros;
  v_admin boolean;
  v_aprobada boolean;
  v_hoy date;
  v_reservas jsonb;
begin
  c := interno.consultorio(p_slug);
  m := interno.yo(c.id);
  if m.id is null then      -- tiene cuenta pero todavía no pidió acceso a este consultorio
    return interno.j_portada(c) || jsonb_build_object('v', 1, 'me', null);
  end if;
  perform interno.mantener(c.id);
  v_admin := m.rol = 'admin' and m.estado = 'aprobado';
  v_aprobada := m.estado = 'aprobado';
  v_hoy := interno.hoy(c.zona);

  if v_admin then
    select coalesce(jsonb_agg(interno.j_reserva(r) order by r.fecha, r.desde, r.id), '[]'::jsonb) into v_reservas
      from public.reservas r where r.consultorio_id = c.id and r.fecha >= v_hoy - 400;
  else
    select coalesce(jsonb_agg(case when r.miembro_id = m.id then interno.j_reserva(r) else interno.j_ocupado(r) end
                              order by r.fecha, r.desde, r.id), '[]'::jsonb) into v_reservas
      from public.reservas r
     where r.consultorio_id = c.id
       and (r.miembro_id = m.id
            or (v_aprobada and r.estado <> 'cancelada' and r.fecha >= v_hoy - 7
                and r.fecha <= v_hoy + (c.semanas_adelante + 2) * 7));
  end if;

  return jsonb_build_object(
    'v', 1, 'now', interno.ms(now()), 'today', v_hoy, 'site', interno.j_sitio(c), 'me', m.id,
    'config', interno.j_config(c, v_admin),
    'boxes', interno.j_boxes(c.id),
    'machines', interno.j_maquinas(c.id, v_admin),
    'users', interno.j_miembros(c.id, case when v_admin then null else m.id end),
    'blocks', case when v_aprobada then interno.j_bloqueos(c.id, v_admin, v_hoy - 7) else '[]'::jsonb end,
    'releases', case when v_aprobada then interno.j_ratos(c.id, case when v_admin then v_hoy - 60 else v_hoy - 7 end) else '[]'::jsonb end,
    'bookings', v_reservas,
    'invoices', interno.j_facturas(c.id, case when v_admin then null else m.id end));
end $$;

-- Una persona con cuenta pide acceso al consultorio: queda pendiente hasta que la dueña la apruebe
create function public.pedir_acceso(p_slug text, p_nombre text, p_profesion text, p_categoria uuid, p_telefono text, p_cuit text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c public.consultorios;
  k public.categorias;
  v_nombre text := interno.texto(p_nombre, 80, true);
  v_profesion text := interno.texto(p_profesion, 80, true);
  v_telefono text := interno.texto(p_telefono, 40);
  v_cuit text := interno.texto(p_cuit, 13);
  v_email text;
  v_id uuid;
  nl constant text := chr(10);
begin
  c := interno.consultorio(p_slug);
  if auth.uid() is null then raise exception 'sin_sesion'; end if;
  if exists (select 1 from public.miembros where consultorio_id = c.id and usuario_id = auth.uid()) then
    raise exception 'ya_sos_miembro';
  end if;
  if v_cuit !~ '^[0-9-]*$' then raise exception 'cuit_invalido'; end if;
  select * into k from public.categorias where id = p_categoria and consultorio_id = c.id and activa;
  if not found then raise exception 'categoria_inexistente'; end if;
  select coalesce(email, '') into v_email from auth.users where id = auth.uid();

  insert into public.miembros (consultorio_id, usuario_id, rol, estado, nombre, profesion, categoria_id, cuit, email, telefono)
  values (c.id, auth.uid(), 'pro', 'pendiente', v_nombre, v_profesion, k.id, v_cuit, coalesce(v_email, ''), v_telefono)
  returning id into v_id;

  perform interno.avisar(v_id, 'Recibimos tu solicitud',
    'Hola ' || interno.primer_nombre(v_nombre) || ':' || nl || nl || 'Recibimos tu solicitud para alquilar boxes. ' || c.duena
    || ' te va a contactar para coordinar una entrevista.' || nl || nl || c.nombre);
  perform interno.avisar_admin(c.id, 'Nueva solicitud de acceso: ' || v_nombre,
    v_nombre || ' (' || v_profesion || ', categoría ' || k.nombre || ') pidió acceso para alquilar boxes.' || nl
    || 'Teléfono: ' || case when v_telefono = '' then '—' else v_telefono end || nl || 'Mail: ' || coalesce(v_email, '') || nl || nl
    || 'Coordiná la entrevista y después aprobala desde el panel.');
  return jsonb_build_object('id', v_id, 'status', 'pendiente');
end $$;

-- ---------------------------------------------------------------------------------------------------
-- Reservar, pagar y cancelar
-- ---------------------------------------------------------------------------------------------------
create function public.reservar(p_slug text, p_box integer, p_fecha date, p_desde integer, p_hasta integer, p_servicio text,
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

  -- Qué se puede reservar:
  --   · un rato libre publicado: entero, o el pedazo entero que quedó libre si ya hay una reserva adentro
  --     (empieza donde empieza el rato o donde termina otra reserva, y termina donde termina el rato o donde empieza otra);
  --   · o un turno entero de la grilla, sin bloqueos ni ratos adentro.
  if not exists (
       select 1 from public.ratos_libres r
        where r.box_id = b.id and r.fecha = p_fecha
          and greatest(r.desde, c.abre) <= p_desde and p_hasta <= least(r.hasta, c.cierra)
          and (p_desde = greatest(r.desde, c.abre)
               or exists (select 1 from public.reservas x
                           where x.box_id = b.id and x.fecha = p_fecha and x.estado <> 'cancelada' and x.hasta = p_desde))
          and (p_hasta = least(r.hasta, c.cierra)
               or exists (select 1 from public.reservas x
                           where x.box_id = b.id and x.fecha = p_fecha and x.estado <> 'cancelada' and x.desde = p_hasta))) then
    if (p_desde - c.abre) % c.turno_horas <> 0 or p_hasta - p_desde <> c.turno_horas
       or interno.hay_bloqueo(b.id, p_fecha, p_desde, p_hasta)
       or exists (select 1 from public.ratos_libres r
                   where r.box_id = b.id and r.fecha = p_fecha and r.desde < p_hasta and r.hasta > p_desde) then
      raise exception 'horario_no_disponible';
    end if;
  end if;

  if (select count(*) from public.reservas where miembro_id = m.id and estado = 'pago') >= c.max_sin_pagar then
    raise exception 'demasiadas_sin_pagar';
  end if;

  -- Saldos pendientes: los turnos que señó y todavía no terminó de pagar (confirmados, ya usados, o que está por señar).
  -- Cada profesional puede tener hasta «max_saldos». Al llegar a ese número:
  --   · si alguno es de un turno que ya empezó, no reserva nada hasta pagarlo;
  --   · si está al día, puede seguir reservando, pero pagando el turno nuevo completo.
  if c.max_saldos is not null then
    select count(*), count(*) filter (where x.estado <> 'pago' and interno.instante(x.fecha, x.desde, c.zona) <= now())
      into v_saldos, v_vencidos
      from public.reservas x
     where x.miembro_id = m.id
       and ((x.estado in ('confirmada', 'cumplida') and interno.pagado(x.id) < x.total)
            or (x.estado = 'pago' and x.plan = 'sena'));
    if v_saldos >= c.max_saldos then
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

-- Pago de prueba: solo mientras el consultorio no tenga conectado Mercado Pago
create function public.simular_pago(p_slug text, p_reserva uuid, p_tipo text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c public.consultorios;
  m public.miembros;
  r public.reservas;
  v_monto integer;
begin
  c := interno.consultorio(p_slug);
  m := interno.yo(c.id);
  if c.pagos_modo <> 'simulado' then raise exception 'pagos_no_simulados'; end if;
  select * into r from public.reservas where id = p_reserva and consultorio_id = c.id for update;
  if not found or m.id is null or r.miembro_id <> m.id then raise exception 'reserva_inexistente'; end if;

  if r.estado = 'pago' then
    -- Se le acabó el plazo: el turno ya no está guardado (lo libera el mantenimiento)
    if r.vence_en is not null and r.vence_en < now() then raise exception 'pago_vencido'; end if;
    if p_tipo is distinct from r.plan then raise exception 'pago_invalido'; end if;
    v_monto := case when r.plan = 'sena' then r.monto_sena else r.total end;
  elsif r.estado in ('confirmada', 'cumplida') and p_tipo = 'saldo' then      -- el saldo también se puede pagar después del turno
    v_monto := r.total - interno.pagado(r.id);
  else
    raise exception 'pago_invalido';
  end if;
  if v_monto <= 0 then raise exception 'nada_que_pagar'; end if;

  perform interno.acreditar(r.id, p_tipo, v_monto, 'simulado', null);
  return jsonb_build_object('status', case when r.estado = 'cumplida' then 'cumplida' else 'confirmada' end,
                            'paid', interno.pagado(r.id), 'balance', greatest(0, r.total - interno.pagado(r.id)));
end $$;

-- Cancela una reserva. La profesional cancela las suyas (con la devolución que diga la política);
-- la dueña puede cancelar cualquiera (y ahí se devuelve todo lo pagado).
create function public.cancelar_reserva(p_slug text, p_reserva uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c public.consultorios;
  m public.miembros;
  r public.reservas;
  v_por text;
  v_pagado integer;
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
  v_dias := extract(epoch from (interno.instante(r.fecha, r.desde, c.zona) - now())) / 86400.0;
  v_antes := v_dias >= c.pol_dias;
  v_pct := case when v_por = 'admin' then 100
                when v_pagado >= r.total then (case when v_antes then c.pol_total_antes else c.pol_total_despues end)
                else (case when v_antes then c.pol_sena_antes else c.pol_sena_despues end) end;
  v_monto := round(v_pagado::numeric * v_pct / 100)::integer;

  update public.reservas set estado = 'cancelada', cancelada_en = now(), cancelada_por = v_por,
                             devolucion_monto = v_monto, devolucion_pct = v_pct, vence_en = null
   where id = r.id;
  update public.reserva_maquinas set activa = false where reserva_id = r.id;
  update public.pagos set estado = 'vencido' where reserva_id = r.id and estado = 'pendiente' and tipo <> 'devolucion';
  if v_monto > 0 then
    -- Con Mercado Pago conectado la devolución queda pendiente hasta que Mercado Pago la confirma
    insert into public.pagos (consultorio_id, reserva_id, tipo, monto, estado, proveedor, aprobado_en)
    values (c.id, r.id, 'devolucion', v_monto, case when c.pagos_modo = 'simulado' then 'aprobado' else 'pendiente' end,
            c.pagos_modo, case when c.pagos_modo = 'simulado' then now() end);
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
-- La dueña: bloqueos y ratos libres
-- ---------------------------------------------------------------------------------------------------
create function public.bloquear(p_slug text, p_boxes integer[], p_fecha date, p_desde integer, p_hasta integer, p_semanal boolean,
                                p_nota text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c public.consultorios;
  v_ids uuid[];
  v_nota text := interno.texto(p_nota, 120);
  v_id uuid;
  v_choques integer;
  v_semanal boolean := coalesce(p_semanal, false);
begin
  c := interno.consultorio(p_slug);
  perform interno.admin(c.id);
  c := interno.candado(c.id);
  if p_fecha is null or p_desde is null or p_hasta is null or p_hasta <= p_desde or p_desde < c.abre or p_hasta > c.cierra then
    raise exception 'horario_invalido';
  end if;
  select array_agg(b.id) into v_ids from public.boxes b
   where b.consultorio_id = c.id and b.activo and b.numero = any (coalesce(p_boxes, '{}'::integer[]));
  if v_ids is null or cardinality(v_ids) <> (select count(distinct x) from unnest(p_boxes) as x) then raise exception 'box_inexistente'; end if;

  insert into public.bloqueos (consultorio_id, recurrente, dia_semana, fecha, desde, hasta, nota)
  values (c.id, v_semanal, case when v_semanal then interno.dia_semana(p_fecha) end, case when v_semanal then null else p_fecha end,
          p_desde, p_hasta, case when v_nota = '' then 'Lo uso yo' else v_nota end)
  returning id into v_id;
  insert into public.bloqueo_boxes (bloqueo_id, box_id, consultorio_id) select v_id, x, c.id from unnest(v_ids) as x;

  -- Las reservas ya tomadas en ese horario siguen en pie: se le avisa cuántas son
  select count(*) into v_choques from public.reservas r
   where r.consultorio_id = c.id and r.estado <> 'cancelada' and r.box_id = any (v_ids) and r.desde < p_hasta and r.hasta > p_desde
     and case when v_semanal then interno.dia_semana(r.fecha) = interno.dia_semana(p_fecha) and r.fecha >= interno.hoy(c.zona)
              else r.fecha = p_fecha end;
  return jsonb_build_object('id', v_id, 'clashes', v_choques);
end $$;

-- Publica un rato libre dentro de un horario bloqueado: cualquier profesional aprobada lo puede reservar
create function public.publicar_rato(p_slug text, p_box integer, p_fecha date, p_desde integer, p_hasta integer) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c public.consultorios;
  v_box uuid;
  v_id uuid;
begin
  c := interno.consultorio(p_slug);
  perform interno.admin(c.id);
  c := interno.candado(c.id);
  select id into v_box from public.boxes where consultorio_id = c.id and numero = p_box and activo;
  if not found then raise exception 'box_inexistente'; end if;
  if p_fecha is null or p_desde is null or p_hasta is null or p_hasta <= p_desde or p_desde < c.abre or p_hasta > c.cierra then
    raise exception 'horario_invalido';
  end if;
  if not interno.dentro_de_bloqueo(v_box, p_fecha, p_desde, p_hasta) then raise exception 'fuera_de_bloqueo'; end if;
  begin
    insert into public.ratos_libres (consultorio_id, box_id, fecha, desde, hasta) values (c.id, v_box, p_fecha, p_desde, p_hasta)
    returning id into v_id;
  exception when exclusion_violation then
    raise exception 'rato_superpuesto';
  end;
  return jsonb_build_object('id', v_id);
end $$;

-- Libera un día entero de un bloqueo (por ejemplo, «este martes no atiendo»)
create function public.liberar_dia(p_slug text, p_bloqueo uuid, p_box integer, p_fecha date) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c public.consultorios;
  b public.bloqueos;
  v_box uuid;
begin
  c := interno.consultorio(p_slug);
  perform interno.admin(c.id);
  c := interno.candado(c.id);
  select * into b from public.bloqueos where id = p_bloqueo and consultorio_id = c.id;
  if not found then raise exception 'bloqueo_inexistente'; end if;
  select id into v_box from public.boxes where consultorio_id = c.id and numero = p_box and activo;
  if not found then raise exception 'box_inexistente'; end if;
  -- El bloqueo elegido tiene que ser de ese box y valer para ese día
  if p_fecha is null
     or not exists (select 1 from public.bloqueo_boxes bb where bb.bloqueo_id = b.id and bb.box_id = v_box)
     or not ((b.recurrente and b.dia_semana = interno.dia_semana(p_fecha)) or (not b.recurrente and b.fecha = p_fecha)) then
    raise exception 'fuera_de_bloqueo';
  end if;
  return public.publicar_rato(p_slug, p_box, p_fecha, greatest(b.desde, c.abre), least(b.hasta, c.cierra));
end $$;

create function public.quitar_rato(p_slug text, p_rato uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c public.consultorios;
begin
  c := interno.consultorio(p_slug);
  perform interno.admin(c.id);
  c := interno.candado(c.id);
  delete from public.ratos_libres where id = p_rato and consultorio_id = c.id;
  if not found then raise exception 'rato_inexistente'; end if;
  return jsonb_build_object('ok', true);
end $$;

-- Quita un bloqueo. Los ratos libres que vivían adentro y quedan sin ningún bloqueo se van con él.
create function public.quitar_bloqueo(p_slug text, p_bloqueo uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c public.consultorios;
begin
  c := interno.consultorio(p_slug);
  perform interno.admin(c.id);
  c := interno.candado(c.id);
  delete from public.bloqueos where id = p_bloqueo and consultorio_id = c.id;
  if not found then raise exception 'bloqueo_inexistente'; end if;
  delete from public.ratos_libres r
   where r.consultorio_id = c.id and r.fecha >= interno.hoy(c.zona)
     and not interno.dentro_de_bloqueo(r.box_id, r.fecha, r.desde, r.hasta);
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------------------------------------------
-- La dueña: profesionales
-- ---------------------------------------------------------------------------------------------------
create function public.cambiar_estado_profesional(p_slug text, p_miembro uuid, p_estado text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c public.consultorios;
  p public.miembros;
  v_nombre text;
  nl constant text := chr(10);
begin
  c := interno.consultorio(p_slug);
  perform interno.admin(c.id);
  c := interno.candado(c.id);
  select * into p from public.miembros where id = p_miembro and consultorio_id = c.id and rol = 'pro' for update;
  if not found then raise exception 'profesional_inexistente'; end if;
  -- Pasos permitidos: pendiente → aprobada o rechazada; aprobada → pausada; pausada o rechazada → aprobada
  if not ((p.estado = 'pendiente' and p_estado in ('aprobado', 'rechazado'))
          or (p.estado = 'aprobado' and p_estado = 'bloqueado')
          or (p.estado in ('bloqueado', 'rechazado') and p_estado = 'aprobado')) then
    raise exception 'cambio_invalido';
  end if;
  update public.miembros set estado = p_estado where id = p.id;

  v_nombre := interno.primer_nombre(p.nombre);
  if p_estado = 'aprobado' then
    perform interno.avisar(p.id, '¡Ya podés reservar!', 'Hola ' || v_nombre || ':' || nl || nl || c.duena
      || ' aprobó tu cuenta. Ya podés entrar, ver los horarios libres de los boxes y reservar.' || nl || nl || c.nombre);
  elsif p_estado = 'rechazado' then
    perform interno.avisar(p.id, 'Sobre tu solicitud', 'Hola ' || v_nombre || ':' || nl || nl
      || 'Gracias por tu interés. Por ahora no podemos habilitarte para alquilar boxes.' || nl || nl || c.nombre);
  else
    perform interno.avisar(p.id, 'Tu acceso está pausado', 'Hola ' || v_nombre || ':' || nl || nl
      || 'Tu acceso a las reservas quedó pausado. Tus reservas ya confirmadas se mantienen.' || nl || nl || c.nombre);
  end if;
  return jsonb_build_object('id', p.id, 'status', p_estado);
end $$;

-- Cambia la categoría de una profesional: vale para sus reservas nuevas
create function public.cambiar_categoria_profesional(p_slug text, p_miembro uuid, p_categoria uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c public.consultorios;
begin
  c := interno.consultorio(p_slug);
  perform interno.admin(c.id);
  c := interno.candado(c.id);
  if not exists (select 1 from public.categorias where id = p_categoria and consultorio_id = c.id and activa) then
    raise exception 'categoria_inexistente';
  end if;
  update public.miembros set categoria_id = p_categoria where id = p_miembro and consultorio_id = c.id and rol = 'pro';
  if not found then raise exception 'profesional_inexistente'; end if;
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------------------------------------------
-- La dueña: configuración
-- ---------------------------------------------------------------------------------------------------
create function public.guardar_turnos(p_slug text, p_turno_horas integer, p_abre integer, p_cierra integer, p_dias integer[]) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c public.consultorios;
begin
  c := interno.consultorio(p_slug);
  perform interno.admin(c.id);
  c := interno.candado(c.id);
  if p_turno_horas is null or p_abre is null or p_cierra is null or p_dias is null then raise exception 'horario_invalido'; end if;
  begin
    update public.consultorios
       set turno_horas = p_turno_horas, abre = p_abre, cierra = p_cierra,
           dias = (select coalesce(array_agg(distinct x order by x), '{}'::integer[]) from unnest(p_dias) as x)
     where id = c.id;
  exception when check_violation then
    raise exception 'horario_invalido';
  end;
  return jsonb_build_object('ok', true);
end $$;

-- p_max_saldos: cuántos turnos señados sin terminar de pagar puede tener cada profesional (vacío = sin tope)
create function public.guardar_pago(p_slug text, p_sena_pct integer, p_minutos_pago integer, p_max_saldos integer) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c public.consultorios;
begin
  c := interno.consultorio(p_slug);
  perform interno.admin(c.id);
  c := interno.candado(c.id);
  if p_sena_pct is null or p_minutos_pago is null then raise exception 'dato_invalido'; end if;
  begin
    update public.consultorios set sena_pct = p_sena_pct, minutos_pago = p_minutos_pago, max_saldos = p_max_saldos where id = c.id;
  exception when check_violation then
    raise exception 'dato_invalido';
  end;
  return jsonb_build_object('ok', true);
end $$;

create function public.guardar_politica(p_slug text, p_dias integer, p_sena_antes integer, p_sena_despues integer,
                                        p_total_antes integer, p_total_despues integer)
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
           pol_total_antes = p_total_antes, pol_total_despues = p_total_despues
     where id = c.id;
  exception when check_violation then
    raise exception 'dato_invalido';
  end;
  return jsonb_build_object('ok', true);
end $$;

-- Si el texto cambia, sube la versión: cada reserva guarda la versión que aceptó
create function public.guardar_reglamento(p_slug text, p_texto text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c public.consultorios;
  v_texto text := interno.texto(p_texto, 8000);
  v_version integer;
begin
  c := interno.consultorio(p_slug);
  perform interno.admin(c.id);
  c := interno.candado(c.id);
  if c.reglamento is not distinct from v_texto then return jsonb_build_object('version', c.reglamento_version); end if;
  update public.consultorios set reglamento_version = reglamento_version + 1, reglamento = v_texto where id = c.id
  returning reglamento_version into v_version;
  insert into public.reglamentos (consultorio_id, version, texto) values (c.id, v_version, v_texto);
  return jsonb_build_object('version', v_version);
end $$;

-- p_precios: { "<id de categoría>": precio por hora }. Las categorías que no vengan (o vengan vacías) usan el precio general.
create function public.guardar_box(p_slug text, p_numero integer, p_nombre text, p_resumen text, p_equipamiento text[], p_precios jsonb)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c public.consultorios;
  b public.boxes;
  v_nombre text := interno.texto(p_nombre, 60);
  v_resumen text := interno.texto(p_resumen, 120);
  v_equipo text[];
  k record;
  v_valor text;
begin
  c := interno.consultorio(p_slug);
  perform interno.admin(c.id);
  c := interno.candado(c.id);
  select * into b from public.boxes where consultorio_id = c.id and numero = p_numero and activo for update;
  if not found then raise exception 'box_inexistente'; end if;
  select coalesce(array_agg(left(btrim(x), 80)), '{}'::text[]) into v_equipo
    from unnest(coalesce(p_equipamiento, '{}'::text[])) as x where btrim(coalesce(x, '')) <> '';
  if cardinality(v_equipo) > 30 then raise exception 'dato_invalido'; end if;
  update public.boxes set nombre = case when v_nombre = '' then nombre else v_nombre end, resumen = v_resumen, equipamiento = v_equipo
   where id = b.id;

  delete from public.box_precios where box_id = b.id;
  for k in select id from public.categorias where consultorio_id = c.id and activa loop
    v_valor := btrim(coalesce(p_precios ->> k.id::text, ''));
    if v_valor <> '' then
      if v_valor !~ '^[0-9]{1,8}$' or v_valor::integer > 10000000 then raise exception 'dato_invalido'; end if;
      insert into public.box_precios (box_id, categoria_id, consultorio_id, precio_hora) values (b.id, k.id, c.id, v_valor::integer);
    end if;
  end loop;
  return jsonb_build_object('ok', true);
end $$;

create function public.guardar_foto_box(p_slug text, p_numero integer, p_foto text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c public.consultorios;
begin
  c := interno.consultorio(p_slug);
  perform interno.admin(c.id);
  c := interno.candado(c.id);
  begin
    update public.boxes set foto = nullif(btrim(coalesce(p_foto, '')), '') where consultorio_id = c.id and numero = p_numero and activo;
    if not found then raise exception 'box_inexistente'; end if;
  exception when check_violation then
    raise exception 'dato_invalido';
  end;
  return jsonb_build_object('ok', true);
end $$;

-- p_id nulo: categoría nueva
create function public.guardar_categoria(p_slug text, p_id uuid, p_nombre text, p_nota text, p_precio_hora integer) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c public.consultorios;
  v_nombre text := interno.texto(p_nombre, 60, true);
  v_nota text := interno.texto(p_nota, 200);
  v_id uuid;
begin
  c := interno.consultorio(p_slug);
  perform interno.admin(c.id);
  c := interno.candado(c.id);
  if p_precio_hora is null or p_precio_hora < 0 or p_precio_hora > 10000000 then raise exception 'dato_invalido'; end if;
  if p_id is null then
    insert into public.categorias (consultorio_id, nombre, nota, precio_hora, orden)
    values (c.id, v_nombre, v_nota, p_precio_hora, (select coalesce(max(orden), 0) + 1 from public.categorias where consultorio_id = c.id))
    returning id into v_id;
  else
    update public.categorias set nombre = v_nombre, nota = v_nota, precio_hora = p_precio_hora
     where id = p_id and consultorio_id = c.id and activa
    returning id into v_id;
    if not found then raise exception 'categoria_inexistente'; end if;
  end if;
  return jsonb_build_object('id', v_id);
end $$;

-- Se puede quitar si no la usa ninguna profesional y queda al menos otra
create function public.quitar_categoria(p_slug text, p_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c public.consultorios;
begin
  c := interno.consultorio(p_slug);
  perform interno.admin(c.id);
  c := interno.candado(c.id);
  if not exists (select 1 from public.categorias where id = p_id and consultorio_id = c.id and activa) then
    raise exception 'categoria_inexistente';
  end if;
  if exists (select 1 from public.miembros where consultorio_id = c.id and rol = 'pro' and categoria_id = p_id) then
    raise exception 'categoria_en_uso';
  end if;
  if (select count(*) from public.categorias where consultorio_id = c.id and activa) <= 1 then raise exception 'ultima_categoria'; end if;
  update public.categorias set activa = false where id = p_id;
  delete from public.box_precios where categoria_id = p_id;
  return jsonb_build_object('ok', true);
end $$;

-- p_id nulo: máquina nueva
create function public.guardar_maquina(p_slug text, p_id uuid, p_nombre text, p_resumen text, p_precio_hora integer, p_activa boolean,
                                       p_foto text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c public.consultorios;
  v_nombre text := interno.texto(p_nombre, 80, true);
  v_resumen text := interno.texto(p_resumen, 200);
  v_foto text := nullif(btrim(coalesce(p_foto, '')), '');
  v_id uuid;
begin
  c := interno.consultorio(p_slug);
  perform interno.admin(c.id);
  c := interno.candado(c.id);
  if p_precio_hora is null or p_precio_hora < 0 or p_precio_hora > 10000000 then raise exception 'dato_invalido'; end if;
  begin
    if p_id is null then
      insert into public.maquinas (consultorio_id, nombre, resumen, precio_hora, activa, foto)
      values (c.id, v_nombre, v_resumen, p_precio_hora, coalesce(p_activa, true), v_foto)
      returning id into v_id;
    else
      update public.maquinas set nombre = v_nombre, resumen = v_resumen, precio_hora = p_precio_hora, activa = coalesce(p_activa, true),
                                 foto = v_foto
       where id = p_id and consultorio_id = c.id and not quitada
      returning id into v_id;
      if not found then raise exception 'maquina_inexistente'; end if;
    end if;
  exception when check_violation then
    raise exception 'dato_invalido';
  end;
  return jsonb_build_object('id', v_id);
end $$;

-- Las reservas que ya la tenían no cambian
create function public.quitar_maquina(p_slug text, p_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c public.consultorios;
begin
  c := interno.consultorio(p_slug);
  perform interno.admin(c.id);
  c := interno.candado(c.id);
  update public.maquinas set quitada = true, activa = false where id = p_id and consultorio_id = c.id and not quitada;
  if not found then raise exception 'maquina_inexistente'; end if;
  return jsonb_build_object('ok', true);
end $$;

create function public.guardar_facturacion(p_slug text, p_nombre text, p_cuit text, p_condicion text, p_punto_venta integer) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c public.consultorios;
  v_nombre text := interno.texto(p_nombre, 120);
  v_cuit text := interno.texto(p_cuit, 13);
begin
  c := interno.consultorio(p_slug);
  perform interno.admin(c.id);
  c := interno.candado(c.id);
  begin
    update public.consultorios
       set fact_nombre = case when v_nombre = '' then fact_nombre else v_nombre end, fact_cuit = v_cuit,
           fact_condicion = p_condicion, fact_punto_venta = p_punto_venta
     where id = c.id;
  exception when check_violation or not_null_violation then
    raise exception 'dato_invalido';
  end;
  return jsonb_build_object('ok', true);
end $$;

-- ===================================================================================================
-- Altas que hace Entreturno (no la página): un consultorio nuevo y su dueña
-- ===================================================================================================
-- Deja a una persona que ya tiene cuenta como dueña (administradora) de un consultorio.
create function interno.alta_admin(p_slug text, p_email text, p_nombre text) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c public.consultorios;
  v_usuario uuid;
  v_id uuid;
begin
  c := interno.consultorio(p_slug);
  select id into v_usuario from auth.users where lower(email) = lower(btrim(p_email));
  if not found then raise exception 'usuario_inexistente'; end if;
  insert into public.miembros (consultorio_id, usuario_id, rol, estado, nombre, profesion, email)
  values (c.id, v_usuario, 'admin', 'aprobado', btrim(p_nombre), 'Administradora', lower(btrim(p_email)))
  on conflict (consultorio_id, usuario_id)
    do update set rol = 'admin', estado = 'aprobado', nombre = excluded.nombre, profesion = 'Administradora'
  returning id into v_id;
  return v_id;
end $$;

-- ===================================================================================================
-- Permisos: la página solo puede ejecutar estas funciones
-- ===================================================================================================
do $$
declare
  f record;
  v_sin_sesion constant text[] := array['portada'];
  v_con_sesion constant text[] := array[
    'portada', 'foto', 'pedir_acceso', 'reservar', 'simular_pago', 'cancelar_reserva',
    'bloquear', 'publicar_rato', 'liberar_dia', 'quitar_rato', 'quitar_bloqueo',
    'cambiar_estado_profesional', 'cambiar_categoria_profesional',
    'guardar_turnos', 'guardar_pago', 'guardar_politica', 'guardar_reglamento', 'guardar_box', 'guardar_foto_box',
    'guardar_categoria', 'quitar_categoria', 'guardar_maquina', 'quitar_maquina', 'guardar_facturacion'];
begin
  for f in
    select p.oid::regprocedure::text as firma, n.nspname as esquema, p.proname as nombre
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'interno' or (n.nspname = 'public' and p.proname = any (v_con_sesion))
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.firma);
    if f.esquema = 'public' then
      execute format('grant execute on function %s to authenticated', f.firma);
      if f.nombre = any (v_sin_sesion) then execute format('grant execute on function %s to anon', f.firma); end if;
    end if;
  end loop;
end $$;
