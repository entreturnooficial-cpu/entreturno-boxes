-- =====================================================================================================
-- Entreturno · Boxes — Facturas con ARCA (23/11/2026)
-- =====================================================================================================
-- Una factura por profesional y por mes, con un clic («Facturar todo el mes», como lo pidió Yani). La emite la
-- función de Supabase «facturar» (supabase/functions/facturar), que habla con ARCA con el certificado de Entreturno
-- (supabase/functions/_compartido/arca.ts). La página nunca habla con ARCA.
--
-- Lo nuevo:
--   - Cada profesional guarda su condición frente al IVA (desde el 1/12/2026 ARCA no emite sin ese dato) y su CUIT
--     validada con el dígito verificador.
--   - El consultorio guarda si factura «apagado», «prueba» (ambiente de prueba de ARCA: facturas que no valen) o «real»,
--     y los datos que van impresos en la factura (domicilio, Ingresos Brutos, inicio de actividades).
--   - La tabla de facturas se rehace (estaba vacía: los botones nunca estuvieron prendidos). Cada factura guarda lo que se
--     manda a ARCA congelado y su estado: pendiente → incierta (número anotado, esperando respuesta) → emitida / rechazada,
--     o «revisar» si hay que mirarla a mano.
--   - El ticket de ARCA y un candado por numeración viven en «interno» y solo los toca la función (rol service_role).
-- =====================================================================================================

-- ---------------------------------------------------------------------------------------------------
-- CUIT: formato y dígito verificador
-- ---------------------------------------------------------------------------------------------------
create function interno.cuit_valida(p_cuit text) returns boolean
language plpgsql immutable set search_path = public, pg_temp as $$
declare
  v_digitos text := replace(coalesce(p_cuit, ''), '-', '');
  v_factores constant integer[] := array[5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  v_suma integer := 0;
  v_verificador integer;
begin
  if coalesce(p_cuit, '') !~ '^[0-9]{2}-?[0-9]{8}-?[0-9]$' then return false; end if;
  for i in 1..10 loop
    v_suma := v_suma + v_factores[i] * substr(v_digitos, i, 1)::integer;
  end loop;
  v_verificador := 11 - (v_suma % 11);
  if v_verificador = 11 then v_verificador := 0; end if;
  return v_verificador = substr(v_digitos, 11, 1)::integer;   -- si da 10, ningún dígito coincide: no es válida
end $$;

-- «20123456786» o «20-12345678-6» → «20-12345678-6»
create function interno.cuit_formato(p_cuit text) returns text
language sql immutable set search_path = public, pg_temp as $$
  select substr(d, 1, 2) || '-' || substr(d, 3, 8) || '-' || substr(d, 11, 1) from (select replace(p_cuit, '-', '') as d) x
$$;

-- ---------------------------------------------------------------------------------------------------
-- Datos fiscales de la profesional y del consultorio
-- ---------------------------------------------------------------------------------------------------
-- Códigos de ARCA: 1 responsable inscripta, 4 exenta, 5 consumidora final, 6 monotributista
-- (la columna acepta todos los de ARCA; la página y las funciones ofrecen estos cuatro)
alter table public.miembros
  add column condicion_iva integer check (condicion_iva in (1, 4, 5, 6, 7, 8, 9, 10, 13, 15, 16));

alter table public.consultorios
  add column fact_ambiente  text not null default 'apagado' check (fact_ambiente in ('apagado', 'prueba', 'real')),
  add column fact_domicilio text not null default '' check (char_length(fact_domicilio) <= 160),
  add column fact_iibb      text not null default '' check (char_length(fact_iibb) <= 30),
  add column fact_inicio    date;

-- ---------------------------------------------------------------------------------------------------
-- Facturas: se rehace la tabla (tiene que estar vacía)
-- ---------------------------------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from public.facturas) then
    raise exception 'La tabla facturas no está vacía: revisar a mano antes de cargar esta migración';
  end if;
end $$;

drop table public.facturas;

create table public.facturas (
  id               uuid primary key default gen_random_uuid(),
  consultorio_id   uuid not null references public.consultorios (id),
  miembro_id       uuid not null,
  periodo          text not null check (periodo ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  ambiente         text not null check (ambiente in ('prueba', 'real')),
  estado           text not null default 'pendiente' check (estado in ('pendiente', 'incierta', 'emitida', 'rechazada', 'revisar')),
  -- lo que se manda a ARCA, congelado al preparar (no cambia en los reintentos)
  cbte_tipo        integer not null,
  letra            text not null check (letra in ('A', 'B', 'C')),
  doc_tipo         integer not null,
  doc_nro          text not null check (doc_nro ~ '^[0-9]{1,11}$'),
  condicion_iva    integer not null,
  fecha            date not null,                          -- fecha del comprobante
  servicio_desde   date not null,
  servicio_hasta   date not null,
  horas            integer not null check (horas >= 0),
  total            integer not null check (total > 0),
  lineas           jsonb not null default '[]',
  -- lo que se anota al mandarla y lo que contestó ARCA
  emisor_cuit      text check (emisor_cuit ~ '^[0-9]{11}$'),
  punto_venta      integer check (punto_venta between 1 and 99998),
  numero           integer check (numero > 0),
  anotado_en       timestamptz,
  cae              text check (cae ~ '^[0-9]{14}$'),
  cae_vence        date,
  observaciones    jsonb not null default '[]',
  creada_en        timestamptz not null default now(),
  emitida_en       timestamptz,
  foreign key (miembro_id, consultorio_id) references public.miembros (id, consultorio_id),
  unique (consultorio_id, miembro_id, periodo, ambiente),
  constraint servicio_ordenado check (servicio_hasta >= servicio_desde),
  constraint incierta_con_numero check (estado <> 'incierta' or (numero is not null and anotado_en is not null
                                                                  and emisor_cuit is not null and punto_venta is not null)),
  constraint emitida_completa check (estado <> 'emitida' or (numero is not null and cae is not null and emitida_en is not null))
);
create index on public.facturas (consultorio_id, periodo);
-- Un número de ARCA no se repite (los rechazados no cuentan: ARCA no los usó)
create unique index facturas_numero_unico on public.facturas (ambiente, emisor_cuit, punto_venta, cbte_tipo, numero)
  where estado in ('emitida', 'incierta', 'revisar');

alter table public.facturas enable row level security;
revoke all on table public.facturas from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------------
-- Lo que guarda la función de ARCA: el ticket (dura 12 h y ARCA no da otro mientras vale) y el candado de cada
-- numeración (para emitir de a una)
-- ---------------------------------------------------------------------------------------------------
create table interno.arca_tickets (
  ambiente    text not null check (ambiente in ('prueba', 'real')),
  servicio    text not null default 'wsfe',
  token       text not null,
  sign        text not null,
  vence       timestamptz not null,
  guardado_en timestamptz not null default now(),
  primary key (ambiente, servicio)
);

create table interno.arca_candados (
  clave  text primary key,
  dueno  text not null,
  hasta  timestamptz not null
);

-- ---------------------------------------------------------------------------------------------------
-- Lo que devuelve la foto: condición de IVA, datos de facturación y facturas con su estado
-- ---------------------------------------------------------------------------------------------------
create or replace function interno.j_config(c public.consultorios, p_admin boolean) returns jsonb
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
                                                         'pos', c.fact_punto_venta, 'env', c.fact_ambiente,
                                                         'address', c.fact_domicilio, 'iibb', c.fact_iibb,
                                                         'start', c.fact_inicio) end)
$$;

create or replace function interno.j_miembros(p_consultorio uuid, p_solo uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', m.id, 'role', m.rol, 'name', m.nombre, 'profession', m.profesion, 'category', m.categoria_id, 'cuit', m.cuit,
           'ivaCond', m.condicion_iva, 'email', m.email, 'phone', m.telefono, 'status', m.estado, 'since', interno.ms(m.desde))
         order by m.desde, m.id), '[]'::jsonb)
    from public.miembros m where m.consultorio_id = p_consultorio and (p_solo is null or m.id = p_solo)
$$;

-- La dueña ve las facturas del ambiente en que factura hoy (las de prueba no se mezclan con las reales);
-- cada profesional ve solo sus facturas reales ya emitidas.
create or replace function interno.j_facturas(p_consultorio uuid, p_solo uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', f.id, 'userId', f.miembro_id, 'period', f.periodo, 'letter', f.letra, 'env', f.ambiente, 'status', f.estado,
           'number', case when f.estado = 'emitida'
                          then lpad(f.punto_venta::text, 4, '0') || '-' || lpad(f.numero::text, 8, '0') end,
           'cae', f.cae, 'caeDue', f.cae_vence, 'date', f.fecha, 'at', interno.ms(coalesce(f.emitida_en, f.creada_en)),
           'docNro', f.doc_nro, 'ivaCond', f.condicion_iva, 'issuerCuit', f.emisor_cuit,
           'hours', f.horas, 'total', f.total, 'lines', f.lineas, 'notes', f.observaciones)
         order by f.creada_en, f.id), '[]'::jsonb)
    from public.facturas f join public.consultorios c on c.id = f.consultorio_id
   where f.consultorio_id = p_consultorio
     and case when p_solo is null then f.ambiente = c.fact_ambiente
              else f.miembro_id = p_solo and f.ambiente = 'real' and f.estado = 'emitida' end
$$;

-- Huella de lo que va a ARCA: si cambia entre que se prepara y se manda, no se manda (Codex 5, punto 2)
create function interno.huella_factura(f public.facturas) returns text
language sql immutable set search_path = public, pg_temp as $$
  select md5(concat_ws('|', f.cbte_tipo, f.doc_tipo, f.doc_nro, f.condicion_iva, f.fecha, f.servicio_desde, f.servicio_hasta, f.total))
$$;

-- Lo que necesita la función de ARCA para emitir (o conciliar) una factura
create function interno.j_para_emitir(f public.facturas) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'id', f.id, 'userId', f.miembro_id, 'name', (select m.nombre from public.miembros m where m.id = f.miembro_id),
    'estado', f.estado, 'numero', f.numero, 'anotadoEn', f.anotado_en, 'version', interno.huella_factura(f), 'periodo', f.periodo,
    'emisorCuit', f.emisor_cuit, 'puntoVenta', f.punto_venta,
    'comprobante', jsonb_build_object('tipo', f.cbte_tipo, 'docTipo', f.doc_tipo, 'docNro', f.doc_nro,
                                      'condicionIva', f.condicion_iva, 'total', f.total, 'fecha', f.fecha,
                                      'servicioDesde', f.servicio_desde, 'servicioHasta', f.servicio_hasta))
$$;

-- ---------------------------------------------------------------------------------------------------
-- Pedir acceso: ahora con la condición frente al IVA y la CUIT validada
-- ---------------------------------------------------------------------------------------------------
drop function public.pedir_acceso(text, text, text, uuid, text, text);

create function public.pedir_acceso(p_slug text, p_nombre text, p_profesion text, p_categoria uuid, p_telefono text, p_cuit text,
                                    p_condicion_iva integer default null)
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
  if v_cuit <> '' then
    if not interno.cuit_valida(v_cuit) then raise exception 'cuit_invalido'; end if;
    v_cuit := interno.cuit_formato(v_cuit);
  end if;
  if p_condicion_iva is not null and p_condicion_iva not in (1, 4, 5, 6) then raise exception 'condicion_invalida'; end if;
  select * into k from public.categorias where id = p_categoria and consultorio_id = c.id and activa;
  if not found then raise exception 'categoria_inexistente'; end if;
  select coalesce(email, '') into v_email from auth.users where id = auth.uid();

  insert into public.miembros (consultorio_id, usuario_id, rol, estado, nombre, profesion, categoria_id, cuit, condicion_iva,
                               email, telefono)
  values (c.id, auth.uid(), 'pro', 'pendiente', v_nombre, v_profesion, k.id, v_cuit, p_condicion_iva, coalesce(v_email, ''),
          v_telefono)
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

-- La dueña corrige la CUIT o la condición frente al IVA de una profesional
create function public.cambiar_datos_fiscales_profesional(p_slug text, p_miembro uuid, p_cuit text, p_condicion_iva integer)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c public.consultorios;
  v_cuit text := interno.texto(p_cuit, 13);
begin
  c := interno.consultorio(p_slug);
  perform interno.admin(c.id);
  c := interno.candado(c.id);
  if v_cuit <> '' then
    if not interno.cuit_valida(v_cuit) then raise exception 'cuit_invalido'; end if;
    v_cuit := interno.cuit_formato(v_cuit);
  end if;
  if p_condicion_iva is not null and p_condicion_iva not in (1, 4, 5, 6) then raise exception 'condicion_invalida'; end if;
  update public.miembros set cuit = v_cuit, condicion_iva = p_condicion_iva
   where id = p_miembro and consultorio_id = c.id and rol = 'pro';
  if not found then raise exception 'profesional_inexistente'; end if;
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------------------------------------------
-- Datos de facturación del consultorio (ahora con domicilio, Ingresos Brutos e inicio de actividades).
-- El ambiente (apagado, prueba o real) NO se cambia desde la página: lo pone Entreturno.
-- ---------------------------------------------------------------------------------------------------
drop function public.guardar_facturacion(text, text, text, text, integer);

create function public.guardar_facturacion(p_slug text, p_nombre text, p_cuit text, p_condicion text, p_punto_venta integer,
                                           p_domicilio text default null, p_iibb text default null, p_inicio date default null)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c public.consultorios;
  v_nombre text := interno.texto(p_nombre, 120);
  v_cuit text := interno.texto(p_cuit, 13);
begin
  c := interno.consultorio(p_slug);
  perform interno.admin(c.id);
  c := interno.candado(c.id);
  if v_cuit <> '' then
    if not interno.cuit_valida(v_cuit) then raise exception 'cuit_invalido'; end if;
    v_cuit := interno.cuit_formato(v_cuit);
  end if;
  begin
    update public.consultorios
       set fact_nombre = case when v_nombre = '' then fact_nombre else v_nombre end, fact_cuit = v_cuit,
           fact_condicion = p_condicion, fact_punto_venta = p_punto_venta,
           fact_domicilio = case when p_domicilio is null then fact_domicilio else interno.texto(p_domicilio, 160) end,
           fact_iibb = case when p_iibb is null then fact_iibb else interno.texto(p_iibb, 30) end,
           fact_inicio = coalesce(p_inicio, fact_inicio)
     where id = c.id;
  exception when check_violation or not_null_violation then
    raise exception 'dato_invalido';
  end;
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------------------------------------------
-- «Facturar todo el mes»: deja lista una factura por profesional con lo que alquiló en el mes
-- ---------------------------------------------------------------------------------------------------
-- La llama la función de ARCA con el pase de la dueña (así se revisa que sea ella). No habla con ARCA: arma o pone al
-- día las facturas pendientes o rechazadas, deja como están las emitidas, y devuelve lo que hay que emitir o conciliar.
-- Lo que se factura es lo mismo que muestra la pantalla: las reservas confirmadas o cumplidas del mes, con sus máquinas.
create function public.facturacion_preparar(p_slug text, p_periodo text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c public.consultorios;
  v_desde date;
  v_hasta date;
  v_hoy date;
  m record;
  f public.facturas;
  v_lineas jsonb;
  v_emitir jsonb := '[]'::jsonb;
  v_faltan jsonb := '[]'::jsonb;
  v_revisar jsonb := '[]'::jsonb;
begin
  c := interno.consultorio(p_slug);
  perform interno.admin(c.id);
  c := interno.candado(c.id);
  if c.fact_ambiente = 'apagado' then raise exception 'facturacion_apagada'; end if;
  if c.fact_condicion <> 'Monotributo' then raise exception 'solo_monotributo'; end if;   -- por ahora, solo Factura C
  if c.fact_ambiente = 'real' and not interno.cuit_valida(c.fact_cuit) then raise exception 'faltan_datos_facturacion'; end if;
  if p_periodo is null or p_periodo !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then raise exception 'dato_invalido'; end if;
  v_desde := to_date(p_periodo || '-01', 'YYYY-MM-DD');
  v_hasta := (v_desde + interval '1 month')::date - 1;
  v_hoy := interno.hoy(c.zona);
  if v_desde > v_hoy then raise exception 'periodo_futuro'; end if;
  -- una sola factura por profesional y por mes: se factura cuando el mes terminó (Codex 5, punto 6)
  if v_desde >= date_trunc('month', v_hoy)::date then raise exception 'mes_en_curso'; end if;

  -- Primero, las «inciertas» de este ambiente, de cualquier mes y tengan o no reservas hoy: hay que conciliarlas antes de
  -- emitir otra de la misma numeración (Codex 5, puntos 1 y 4)
  for f in
    select * from public.facturas
     where consultorio_id = c.id and ambiente = c.fact_ambiente and estado = 'incierta' order by anotado_en, id
  loop
    v_emitir := v_emitir || jsonb_build_array(interno.j_para_emitir(f));
  end loop;
  select coalesce(jsonb_agg(jsonb_build_object('userId', f2.miembro_id, 'name', m2.nombre) order by m2.nombre), '[]'::jsonb)
    into v_revisar
    from public.facturas f2 join public.miembros m2 on m2.id = f2.miembro_id
   where f2.consultorio_id = c.id and f2.ambiente = c.fact_ambiente and f2.periodo = p_periodo and f2.estado = 'revisar';

  for m in
    select mi.id, mi.nombre, mi.cuit, mi.condicion_iva,
           sum(r.hasta - r.desde)::integer as horas, sum(r.total)::bigint as total,
           min(r.fecha) as primero, max(r.fecha) as ultimo
      from public.reservas r join public.miembros mi on mi.id = r.miembro_id
     where r.consultorio_id = c.id and r.estado in ('confirmada', 'cumplida') and r.fecha between v_desde and v_hasta
     group by mi.id, mi.nombre, mi.cuit, mi.condicion_iva
    having sum(r.total) > 0
     order by mi.nombre, mi.id
  loop
    select * into f from public.facturas
     where consultorio_id = c.id and miembro_id = m.id and periodo = p_periodo and ambiente = c.fact_ambiente;
    if found and f.estado in ('emitida', 'revisar', 'incierta') then
      continue;                                         -- emitida: no se toca; revisar e incierta: ya están arriba
    end if;
    if not interno.cuit_valida(m.cuit) or m.condicion_iva is null then
      v_faltan := v_faltan || jsonb_build_array(jsonb_build_object(
        'userId', m.id, 'name', m.nombre, 'missing', case when not interno.cuit_valida(m.cuit) then 'cuit' else 'condicion' end));
      continue;
    end if;
    if m.total > 2000000000 then raise exception 'dato_invalido'; end if;

    select coalesce(jsonb_agg(jsonb_build_object('text', t.texto, 'amount', t.monto) order by t.orden, t.texto), '[]'::jsonb)
      into v_lineas
      from (select 1 as orden, 'Box ' || x.numero || ' · ' || sum(r.hasta - r.desde) || ' h × ' || interno.plata(r.precio_hora) as texto,
                   sum(r.monto_box)::bigint as monto
              from public.reservas r join public.boxes x on x.id = r.box_id
             where r.consultorio_id = c.id and r.miembro_id = m.id and r.estado in ('confirmada', 'cumplida')
               and r.fecha between v_desde and v_hasta
             group by x.numero, r.precio_hora
            union all
            select 2, rm.nombre || ' · ' || sum(rm.horas) || ' h × ' || interno.plata(rm.precio_hora), sum(rm.monto)::bigint
              from public.reserva_maquinas rm join public.reservas r on r.id = rm.reserva_id
             where r.consultorio_id = c.id and r.miembro_id = m.id and r.estado in ('confirmada', 'cumplida')
               and r.fecha between v_desde and v_hasta and rm.activa
             group by rm.nombre, rm.precio_hora) t;

    insert into public.facturas (consultorio_id, miembro_id, periodo, ambiente, estado, cbte_tipo, letra, doc_tipo, doc_nro,
                                 condicion_iva, fecha, servicio_desde, servicio_hasta, horas, total, lineas)
    values (c.id, m.id, p_periodo, c.fact_ambiente, 'pendiente', 11, 'C', 80, replace(m.cuit, '-', ''),
            m.condicion_iva, v_hoy, m.primero, m.ultimo, m.horas, m.total::integer, v_lineas)
    on conflict (consultorio_id, miembro_id, periodo, ambiente) do update
       set estado = 'pendiente', doc_tipo = excluded.doc_tipo, doc_nro = excluded.doc_nro,
           condicion_iva = excluded.condicion_iva, fecha = excluded.fecha, servicio_desde = excluded.servicio_desde,
           servicio_hasta = excluded.servicio_hasta, horas = excluded.horas, total = excluded.total, lineas = excluded.lineas,
           emisor_cuit = null, punto_venta = null, numero = null, anotado_en = null, observaciones = '[]'::jsonb
     where public.facturas.estado in ('pendiente', 'rechazada')
    returning * into f;
    v_emitir := v_emitir || jsonb_build_array(interno.j_para_emitir(f));
  end loop;

  return jsonb_build_object(
    'ambiente', c.fact_ambiente, 'periodo', p_periodo,
    'emisorCuit', replace(c.fact_cuit, '-', ''), 'puntoVenta', c.fact_punto_venta,
    'emitir', v_emitir, 'faltan', v_faltan, 'revisar', v_revisar);
end $$;

-- Con qué se factura hoy (para «Probar la conexión con ARCA»): solo la dueña, y sin tocar nada
create function public.facturacion_estado(p_slug text) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  c public.consultorios;
begin
  c := interno.consultorio(p_slug);
  perform interno.admin(c.id);
  return jsonb_build_object('ambiente', c.fact_ambiente, 'emisorCuit', replace(c.fact_cuit, '-', ''),
                            'puntoVenta', c.fact_punto_venta);
end $$;

-- ---------------------------------------------------------------------------------------------------
-- Funciones que usa SOLO la función de ARCA (rol service_role; la página no puede llamarlas)
-- ---------------------------------------------------------------------------------------------------
create function public.arca_ticket(p_ambiente text) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('token', t.token, 'sign', t.sign, 'vence', t.vence)
    from interno.arca_tickets t where t.ambiente = p_ambiente and t.servicio = 'wsfe'
$$;

create function public.arca_guardar_ticket(p_ambiente text, p_token text, p_sign text, p_vence timestamptz) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if coalesce(p_token, '') = '' or coalesce(p_sign, '') = '' or p_vence is null then raise exception 'dato_invalido'; end if;
  insert into interno.arca_tickets (ambiente, servicio, token, sign, vence) values (p_ambiente, 'wsfe', p_token, p_sign, p_vence)
  on conflict (ambiente, servicio) do update set token = excluded.token, sign = excluded.sign, vence = excluded.vence,
                                                 guardado_en = now();
end $$;

-- Toma o renueva el candado de una numeración por unos segundos (true si quedó a nombre de quien lo pide).
-- Con p_segundos = 0 lo suelta.
create function public.arca_candado(p_clave text, p_dueno text, p_segundos integer) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_tomado boolean;
begin
  if coalesce(p_clave, '') = '' or coalesce(p_dueno, '') = '' then raise exception 'dato_invalido'; end if;
  if coalesce(p_segundos, 0) <= 0 then
    update interno.arca_candados set hasta = now() where clave = p_clave and dueno = p_dueno;
    return true;
  end if;
  insert into interno.arca_candados as k (clave, dueno, hasta)
  values (p_clave, p_dueno, now() + make_interval(secs => least(p_segundos, 600)))
  on conflict (clave) do update set dueno = excluded.dueno, hasta = excluded.hasta
   where k.hasta < now() or k.dueno = excluded.dueno
  returning true into v_tomado;
  return coalesce(v_tomado, false);
end $$;

-- Antes de mandar una factura: anota con qué CUIT, punto de venta y número sale (queda «incierta» hasta la respuesta).
-- Solo si quien la manda tiene tomado el candado de ESA numeración, y si lo congelado sigue siendo lo que se va a mandar.
create function public.arca_anotar(p_factura uuid, p_emisor_cuit text, p_punto_venta integer, p_numero integer,
                                   p_version text, p_dueno text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  f public.facturas;
begin
  select * into f from public.facturas where id = p_factura for update;
  if not found or f.estado not in ('pendiente', 'rechazada', 'incierta') then raise exception 'factura_inexistente'; end if;
  if not exists (select 1 from interno.arca_candados
                  where clave = f.ambiente || ':' || p_emisor_cuit || ':' || p_punto_venta || ':' || f.cbte_tipo
                    and dueno = p_dueno and hasta > now()) then
    raise exception 'candado_perdido';
  end if;
  if interno.huella_factura(f) is distinct from p_version then raise exception 'factura_cambio'; end if;
  update public.facturas
     set emisor_cuit = p_emisor_cuit, punto_venta = p_punto_venta, numero = p_numero, anotado_en = now(), estado = 'incierta'
   where id = p_factura;
end $$;

-- Lo que contestó ARCA: emitida (con CAE), rechazada (con el motivo) o «revisar» (hay que mirarla a mano)
create function public.arca_resultado(p_factura uuid, p_estado text, p_cae text, p_cae_vence date, p_observaciones jsonb)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  f public.facturas;
  c public.consultorios;
  v_mes text;
  nl constant text := chr(10);
begin
  if p_estado is null or p_estado not in ('emitida', 'rechazada', 'revisar') then raise exception 'dato_invalido'; end if;
  if p_estado = 'emitida' and coalesce(p_cae, '') !~ '^[0-9]{14}$' then raise exception 'dato_invalido'; end if;
  update public.facturas
     set estado = p_estado,
         cae = case when p_estado = 'emitida' then p_cae end,
         cae_vence = case when p_estado = 'emitida' then p_cae_vence end,
         emitida_en = case when p_estado = 'emitida' then now() end,
         numero = case when p_estado = 'rechazada' then null else numero end,
         anotado_en = case when p_estado = 'rechazada' then null else anotado_en end,
         observaciones = coalesce(p_observaciones, '[]'::jsonb)
   where id = p_factura and estado in ('pendiente', 'incierta')
     and (p_estado <> 'emitida' or numero is not null)
  returning * into f;
  if not found then raise exception 'factura_inexistente'; end if;

  if p_estado = 'emitida' and f.ambiente = 'real' then
   begin   -- si el aviso falla, el CAE queda guardado igual
    select * into c from public.consultorios where id = f.consultorio_id;
    v_mes := (array['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre',
                    'noviembre', 'diciembre'])[substr(f.periodo, 6, 2)::integer] || ' de ' || substr(f.periodo, 1, 4);
    perform interno.avisar(f.miembro_id, 'Tu factura de ' || v_mes,
      'Hola:' || nl || nl || 'Ya está tu factura por los alquileres de ' || v_mes || ': Factura ' || f.letra || ' '
      || lpad(f.punto_venta::text, 4, '0') || '-' || lpad(f.numero::text, 8, '0') || ', por ' || interno.plata(f.total) || '.'
      || nl || 'Número de autorización de ARCA (CAE): ' || f.cae || nl || nl
      || 'También la ves en «Mis Comprobantes» de ARCA.' || nl || nl || c.nombre);
   exception when others then
    null;
   end;
  end if;
end $$;

-- ===================================================================================================
-- Permisos: la página solo puede ejecutar las suyas; las de ARCA, solo la función (service_role)
-- ===================================================================================================
do $$
declare
  f record;
  v_sin_sesion constant text[] := array['portada'];
  v_con_sesion constant text[] := array[
    'portada', 'foto', 'pedir_acceso', 'reservar', 'simular_pago', 'cancelar_reserva',
    'bloquear', 'publicar_rato', 'liberar_dia', 'quitar_rato', 'quitar_bloqueo',
    'cambiar_estado_profesional', 'cambiar_categoria_profesional', 'cambiar_datos_fiscales_profesional',
    'guardar_turnos', 'guardar_pago', 'guardar_politica', 'guardar_reglamento', 'guardar_box', 'guardar_foto_box',
    'guardar_categoria', 'quitar_categoria', 'guardar_maquina', 'quitar_maquina', 'guardar_facturacion',
    'facturacion_preparar', 'facturacion_estado'];
  v_servicio constant text[] := array['arca_ticket', 'arca_guardar_ticket', 'arca_candado', 'arca_anotar', 'arca_resultado'];
begin
  for f in
    select p.oid::regprocedure::text as firma, n.nspname as esquema, p.proname as nombre
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'interno' or (n.nspname = 'public' and (p.proname = any (v_con_sesion) or p.proname = any (v_servicio)))
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.firma);
    if f.esquema = 'public' and f.nombre = any (v_servicio) then
      execute format('grant execute on function %s to service_role', f.firma);
    elsif f.esquema = 'public' then
      execute format('grant execute on function %s to authenticated', f.firma);
      if f.nombre = any (v_sin_sesion) then execute format('grant execute on function %s to anon', f.firma); end if;
    end if;
  end loop;
end $$;
