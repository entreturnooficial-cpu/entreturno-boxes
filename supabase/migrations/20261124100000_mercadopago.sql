-- =====================================================================================================
-- Entreturno · Boxes — Cobro real con Mercado Pago (24/11/2026)
-- =====================================================================================================
-- Cada consultorio cobra en SU cuenta de Mercado Pago. La dueña la conecta autorizándola desde Mercado Pago
-- (no pasa ninguna clave) y la plata de las reservas entra directo ahí. Entreturno nunca la toca.
--
-- Quién hace qué:
--   - La página pide «quiero pagar esta reserva». La base revisa todo (de quién es, cuánto, hasta cuándo) y deja
--     anotado el intento de pago.
--   - La función de Supabase «mp» (supabase/functions/mp) crea la orden en Mercado Pago con el pase de la cuenta del
--     consultorio y le devuelve a la página la dirección donde se paga.
--   - Mercado Pago avisa a la función cuando el pago se aprueba. La función NO le cree al aviso: vuelve a preguntarle
--     a Mercado Pago por esa orden y recién ahí le pasa el resultado a la base, que es la que confirma la reserva.
--   - Las devoluciones las decide la base (como siempre, con la política de cancelación) y las ejecuta la función.
--
-- Casos que no pueden quedar mal (cada uno tiene su prueba):
--   - Un pago que llega cuando el plazo ya venció: si el horario sigue libre, la reserva revive; si no, la plata se
--     devuelve entera, sola.
--   - Un pago repetido o de una reserva cancelada: se devuelve entero, solo («sobrante»).
--   - Un aviso repetido de Mercado Pago no acredita dos veces.
--   - Una devolución no sale dos veces: lo que se va a devolver se anota antes de pedirlo.
--
-- Los pases de cada cuenta se guardan cifrados en el Vault de Supabase, no en una tabla.
-- =====================================================================================================

-- ---------------------------------------------------------------------------------------------------
-- El consultorio: en qué ambiente de Mercado Pago cobra
-- ---------------------------------------------------------------------------------------------------
-- «prueba»: órdenes de prueba de Mercado Pago (tarjetas de prueba, no se mueve plata). «real»: plata de verdad.
-- Igual que pagos_modo, se cambia solo desde el SQL Editor, nunca desde la página.
alter table public.consultorios
  add column mp_ambiente text not null default 'prueba' check (mp_ambiente in ('prueba', 'real'));

-- ---------------------------------------------------------------------------------------------------
-- Pagos: estados nuevos y lo que hace falta para seguir cada orden
-- ---------------------------------------------------------------------------------------------------
--   sobrante: Mercado Pago lo cobró, pero no corresponde a ninguna deuda (llegó tarde, estaba repetido o la reserva
--             ya estaba cancelada). No cuenta como pagado: se devuelve entero.
--   devuelto: un sobrante que ya se devolvió.
--   revisar:  algo no cierra (el monto no coincide, la orden no es la esperada): hay que mirarlo a mano.
alter table public.pagos drop constraint pagos_estado_check;
alter table public.pagos add constraint pagos_estado_check
  check (estado in ('pendiente', 'aprobado', 'rechazado', 'vencido', 'sobrante', 'devuelto', 'revisar'));
alter table public.pagos
  add column vence_en       timestamptz,                    -- hasta cuándo se puede pagar esa orden
  add column enlace         text check (enlace is null or (enlace ~ '^https?://' and char_length(enlace) <= 600)),
  add column intentos       integer not null default 0,     -- veces que se intentó (crear la orden o devolver)
  add column error          text check (error is null or char_length(error) <= 300),
  add column actualizado_en timestamptz not null default now();
create index pagos_mp_abiertos on public.pagos (estado, actualizado_en) where proveedor = 'mercadopago';

-- ---------------------------------------------------------------------------------------------------
-- La cuenta de Mercado Pago de cada consultorio (sin los pases: esos van al Vault)
-- ---------------------------------------------------------------------------------------------------
create table interno.mp_cuentas (
  consultorio_id uuid primary key references public.consultorios (id),
  ambiente       text not null check (ambiente in ('prueba', 'real')),
  -- por_confirmar: Mercado Pago ya autorizó, falta que la dueña confirme en la página que esa es SU cuenta
  estado         text not null default 'por_confirmar' check (estado in ('por_confirmar', 'conectada', 'caida')),
  mp_user_id     text not null check (mp_user_id ~ '^[0-9]{1,20}$'),
  nombre         text not null default '' check (char_length(nombre) <= 120),
  email          text not null default '' check (char_length(email) <= 254),
  vence          timestamptz not null,                      -- hasta cuándo sirve el pase (se renueva solo antes)
  miembro_id     uuid,                                      -- quién la conectó
  conectada_en   timestamptz not null default now(),
  confirmada_en  timestamptz,
  renovada_en    timestamptz,
  error          text check (error is null or char_length(error) <= 300)
);
create index on interno.mp_cuentas (mp_user_id);

-- Cada intento de conectar una cuenta: el código que va y vuelve de Mercado Pago (sirve una sola vez y 15 minutos)
create table interno.mp_estados (
  estado         text primary key check (estado ~ '^[A-Za-z0-9_-]{32,128}$'),
  consultorio_id uuid not null references public.consultorios (id),
  miembro_id     uuid not null,
  ambiente       text not null check (ambiente in ('prueba', 'real')),
  verificador    text not null check (verificador ~ '^[A-Za-z0-9._~-]{43,128}$'),
  -- a dónde vuelve la dueña después de autorizar: solo páginas de Entreturno (si no, la vuelta serviría para mandar gente a cualquier lado)
  volver_a       text not null check (char_length(volver_a) <= 200
                                      and (volver_a ~ '^https://([a-z0-9-]+\.)?entreturno\.com\.ar/$'
                                           or volver_a ~ '^https://([a-z0-9-]+\.)?[a-z0-9-]+-entreturno\.pages\.dev/$'
                                           or volver_a ~ '^http://(localhost|127\.0\.0\.1)(:[0-9]{1,5})?/$')),
  creado_en      timestamptz not null default now(),
  usado_en       timestamptz
);

-- Ajustes del sistema que no son de ningún consultorio (la dirección de la función, para el reloj)
create table interno.ajustes (
  clave text primary key,
  valor text not null
);

-- ---------------------------------------------------------------------------------------------------
-- El Vault: guardar, leer y borrar un secreto por su nombre
-- ---------------------------------------------------------------------------------------------------
create function interno.secreto_leer(p_nombre text) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select decrypted_secret from vault.decrypted_secrets where name = p_nombre
$$;

create function interno.secreto_guardar(p_nombre text, p_valor text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid;
begin
  if coalesce(p_nombre, '') = '' or coalesce(p_valor, '') = '' then raise exception 'dato_invalido'; end if;
  select id into v_id from vault.decrypted_secrets where name = p_nombre;
  if v_id is null then
    perform vault.create_secret(p_valor, p_nombre, 'Entreturno · Mercado Pago');
  else
    perform vault.update_secret(v_id, p_valor);
  end if;
end $$;

create function interno.secreto_borrar(p_nombre text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid;
begin
  select id into v_id from vault.decrypted_secrets where name = p_nombre;
  if v_id is null then return; end if;
  begin
    delete from vault.secrets where id = v_id;
  exception when others then
    perform vault.update_secret(v_id, 'borrado');     -- si no se puede borrar, al menos deja de servir
  end;
end $$;

-- ---------------------------------------------------------------------------------------------------
-- ¿Este consultorio tiene con qué cobrar?
-- ---------------------------------------------------------------------------------------------------
-- En «prueba» alcanza con la cuenta de prueba de Entreturno (la función la usa si el consultorio no conectó la suya).
-- En «real» hace falta la cuenta del consultorio, conectada y confirmada, del mismo ambiente.
create function interno.mp_lista(c public.consultorios) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select c.pagos_modo = 'mercadopago'
     and (c.mp_ambiente = 'prueba'
          or exists (select 1 from interno.mp_cuentas k
                      where k.consultorio_id = c.id and k.estado = 'conectada' and k.ambiente = c.mp_ambiente))
$$;

-- ---------------------------------------------------------------------------------------------------
-- Lo que se le manda a la página
-- ---------------------------------------------------------------------------------------------------
create or replace function interno.j_sitio(c public.consultorios) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('slug', c.slug, 'name', c.nombre, 'owner', c.duena, 'letters', c.letras, 'payments', c.pagos_modo,
                            'mp', case when c.pagos_modo = 'mercadopago'
                                       then jsonb_build_object('env', c.mp_ambiente, 'ready', interno.mp_lista(c)) end)
$$;

-- La cuenta de Mercado Pago, como la ve la dueña en Configuración
create function interno.j_mp(c public.consultorios) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'mode', c.pagos_modo, 'env', c.mp_ambiente,
    'account', (select jsonb_build_object('status', k.estado, 'env', k.ambiente, 'userId', k.mp_user_id, 'name', k.nombre,
                                          'email', k.email, 'since', interno.ms(k.conectada_en), 'error', k.error)
                  from interno.mp_cuentas k where k.consultorio_id = c.id))
$$;

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
                                                         'start', c.fact_inicio) end,
    'mp', case when p_admin then interno.j_mp(c) end)
$$;

-- Una reserva con todo su detalle. Lo nuevo:
--   payments: como siempre, los pagos aprobados y la devolución en camino (los intentos de pago no van acá);
--   pending:  el intento de pago que está abierto en Mercado Pago, si hay uno;
--   surplus:  plata que Mercado Pago cobró de más y se está devolviendo (o ya se devolvió).
create or replace function interno.j_reserva(r public.reservas) returns jsonb
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

-- ===================================================================================================
-- CONECTAR LA CUENTA DE MERCADO PAGO
-- ===================================================================================================

-- La dueña aprieta «Conectar Mercado Pago». La función de Supabase arma el código que va y vuelve y lo anota acá
-- (con el pase de la dueña: así la base comprueba que es ella). Devuelve en qué ambiente se conecta.
create function public.mp_conexion_iniciar(p_slug text, p_estado text, p_verificador text, p_volver_a text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c public.consultorios;
  m public.miembros;
begin
  c := interno.consultorio(p_slug);
  m := interno.admin(c.id);
  delete from interno.mp_estados where creado_en < now() - interval '1 day';
  begin
    insert into interno.mp_estados (estado, consultorio_id, miembro_id, ambiente, verificador, volver_a)
    values (p_estado, c.id, m.id, c.mp_ambiente, p_verificador, p_volver_a);
  exception when check_violation or not_null_violation or unique_violation then
    raise exception 'dato_invalido';
  end;
  return jsonb_build_object('ambiente', c.mp_ambiente);
end $$;

-- Mercado Pago volvió con el código: la función pide los datos de ese intento. Sirve una sola vez y 15 minutos.
create function public.mp_conexion_tomar(p_estado text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  e interno.mp_estados;
  c public.consultorios;
begin
  update interno.mp_estados set usado_en = now()
   where estado = p_estado and usado_en is null and creado_en > now() - interval '15 minutes'
  returning * into e;
  if not found then return null; end if;
  select * into c from public.consultorios where id = e.consultorio_id;
  return jsonb_build_object('consultorio', c.id, 'slug', c.slug, 'ambiente', e.ambiente, 'verificador', e.verificador,
                            'volverA', e.volver_a, 'miembro', e.miembro_id);
end $$;

-- Lo que todavía depende de la cuenta de Mercado Pago que está conectada: cobros abiertos que alguien puede estar pagando,
-- devoluciones que esperan y pagos que entraron de más. Mientras haya alguno, esa cuenta no se puede sacar ni cambiar por
-- otra: con otro pase esas órdenes no se pueden leer ni devolver.
create function interno.mp_obligaciones(p_consultorio uuid) returns integer
language sql stable security definer set search_path = public, pg_temp as $$
  select count(*)::integer from public.pagos p
   where p.consultorio_id = p_consultorio and p.proveedor = 'mercadopago'
     and ((p.tipo <> 'devolucion' and p.estado = 'pendiente' and p.proveedor_id is not null and p.vence_en > now() - interval '1 day')
          or (p.tipo = 'devolucion' and p.estado = 'pendiente')
          or p.estado = 'sobrante')
$$;

-- La función ya cambió el código por los pases: se guardan (cifrados, en el Vault).
-- Una cuenta nueva queda «por confirmar». Si es la misma que la dueña ya había confirmado (la reconectó porque se había
-- caído), sigue sirviendo sin confirmar de nuevo. Y no se cambia por OTRA cuenta mientras la anterior tenga algo pendiente.
create function public.mp_cuenta_guardar(p_consultorio uuid, p_ambiente text, p_user_id text, p_acceso text, p_renovar text,
                                         p_segundos integer, p_nombre text, p_email text, p_miembro uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  k interno.mp_cuentas;
  v_misma boolean;
begin
  if coalesce(p_acceso, '') = '' or coalesce(p_segundos, 0) <= 0 or p_ambiente is null or p_ambiente not in ('prueba', 'real')
     or coalesce(p_user_id, '') !~ '^[0-9]{1,20}$'
     or not exists (select 1 from public.consultorios where id = p_consultorio) then
    raise exception 'dato_invalido';
  end if;
  select * into k from interno.mp_cuentas where consultorio_id = p_consultorio for update;
  v_misma := found and k.mp_user_id = p_user_id and k.ambiente = p_ambiente and k.confirmada_en is not null;
  if found and (k.mp_user_id <> p_user_id or k.ambiente <> p_ambiente) and k.confirmada_en is not null
     and interno.mp_obligaciones(p_consultorio) > 0 then
    raise exception 'mp_con_pendientes';
  end if;
  perform interno.secreto_guardar('mp_acceso_' || p_consultorio, p_acceso);
  if coalesce(p_renovar, '') <> '' then
    perform interno.secreto_guardar('mp_renovar_' || p_consultorio, p_renovar);
  else
    perform interno.secreto_borrar('mp_renovar_' || p_consultorio);
  end if;
  insert into interno.mp_cuentas as x (consultorio_id, ambiente, estado, mp_user_id, nombre, email, vence, miembro_id)
  values (p_consultorio, p_ambiente, 'por_confirmar', p_user_id, left(btrim(coalesce(p_nombre, '')), 120),
          left(btrim(coalesce(p_email, '')), 254), now() + make_interval(secs => p_segundos), p_miembro)
  on conflict (consultorio_id) do update
     set ambiente = excluded.ambiente, estado = case when v_misma then 'conectada' else 'por_confirmar' end,
         mp_user_id = excluded.mp_user_id, nombre = excluded.nombre, email = excluded.email, vence = excluded.vence,
         miembro_id = excluded.miembro_id, conectada_en = now(),
         confirmada_en = case when v_misma then x.confirmada_en end, renovada_en = null, error = null;
  return jsonb_build_object('estado', case when v_misma then 'conectada' else 'por_confirmar' end);
end $$;

-- La dueña mira en la página qué cuenta quedó conectada y confirma que es la suya. Recién ahí se puede cobrar con ella.
-- Manda el número de la cuenta que vio: si mientras miraba alguien conectó otra, no se confirma la que no vio.
create function public.mp_conexion_confirmar(p_slug text, p_user_id text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c public.consultorios;
  k interno.mp_cuentas;
begin
  c := interno.consultorio(p_slug);
  perform interno.admin(c.id);
  select * into k from interno.mp_cuentas where consultorio_id = c.id for update;
  if not found or k.estado <> 'por_confirmar' then raise exception 'mp_sin_cuenta'; end if;
  if k.mp_user_id is distinct from p_user_id then raise exception 'mp_cuenta_cambio'; end if;
  update interno.mp_cuentas set estado = 'conectada', confirmada_en = now() where consultorio_id = c.id;
  return jsonb_build_object('status', 'conectada', 'name', k.nombre, 'email', k.email);
end $$;

-- La dueña saca la cuenta del sistema (los pases se borran). En Mercado Pago, además, puede quitarle el permiso a la
-- aplicación cuando quiera. Una cuenta ya confirmada no se saca mientras tenga cobros abiertos o devoluciones esperando.
create function public.mp_desconectar(p_slug text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c public.consultorios;
  k interno.mp_cuentas;
begin
  c := interno.consultorio(p_slug);
  perform interno.admin(c.id);
  select * into k from interno.mp_cuentas where consultorio_id = c.id for update;
  if found and k.confirmada_en is not null and interno.mp_obligaciones(c.id) > 0 then raise exception 'mp_con_pendientes'; end if;
  delete from interno.mp_cuentas where consultorio_id = c.id;
  perform interno.secreto_borrar('mp_acceso_' || c.id);
  perform interno.secreto_borrar('mp_renovar_' || c.id);
  return jsonb_build_object('ok', true);
end $$;

-- Los consultorios que cobran con una cuenta de Mercado Pago (para comprobar si esa cuenta sigue autorizando a la aplicación)
create function public.mp_cuentas_de(p_user_id text) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(k.consultorio_id), '[]'::jsonb) from interno.mp_cuentas k
   where k.mp_user_id = p_user_id and k.estado = 'conectada'
$$;

-- Con qué pase se cobra en un consultorio (solo la función). «acceso» viene vacío si no hay cuenta que sirva.
create function public.mp_credencial(p_consultorio uuid, p_con_renovar boolean default false) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  c public.consultorios;
  k interno.mp_cuentas;
  v_sirve boolean;
begin
  select * into c from public.consultorios where id = p_consultorio;
  if not found then raise exception 'consultorio_inexistente'; end if;
  select * into k from interno.mp_cuentas where consultorio_id = c.id;
  -- para cobrar hace falta la cuenta confirmada y del ambiente de hoy; una «caída» no sirve hasta que se reconecte
  v_sirve := found and k.estado = 'conectada' and k.ambiente = c.mp_ambiente;
  return jsonb_build_object(
    'slug', c.slug, 'modo', c.pagos_modo, 'ambiente', c.mp_ambiente,
    'cuenta', case when k.consultorio_id is not null then jsonb_build_object(
                'estado', k.estado, 'ambiente', k.ambiente, 'userId', k.mp_user_id, 'vence', k.vence) end,
    'acceso', case when v_sirve then interno.secreto_leer('mp_acceso_' || c.id) end,
    'renovar', case when v_sirve and p_con_renovar then interno.secreto_leer('mp_renovar_' || c.id) end);
end $$;

-- Mercado Pago dio pases nuevos (se renuevan solos, sin que la dueña haga nada)
create function public.mp_cuenta_renovada(p_consultorio uuid, p_acceso text, p_renovar text, p_segundos integer) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if coalesce(p_acceso, '') = '' or coalesce(p_segundos, 0) <= 0 then raise exception 'dato_invalido'; end if;
  if not exists (select 1 from interno.mp_cuentas where consultorio_id = p_consultorio) then raise exception 'mp_sin_cuenta'; end if;
  perform interno.secreto_guardar('mp_acceso_' || p_consultorio, p_acceso);
  if coalesce(p_renovar, '') <> '' then perform interno.secreto_guardar('mp_renovar_' || p_consultorio, p_renovar); end if;
  update interno.mp_cuentas set vence = now() + make_interval(secs => p_segundos), renovada_en = now(), error = null
   where consultorio_id = p_consultorio;
end $$;

-- No se pudo renovar esta vez (un corte): queda anotado y se prueba de nuevo al día siguiente
create function public.mp_cuenta_reintento(p_consultorio uuid, p_error text) returns void
language sql security definer set search_path = public, pg_temp as $$
  update interno.mp_cuentas set renovada_en = now(), error = left(coalesce(p_error, ''), 300) where consultorio_id = p_consultorio
$$;

-- La cuenta dejó de servir (la dueña le quitó el permiso en Mercado Pago, cambió la contraseña o el pase venció):
-- se avisa una sola vez a la dueña para que la conecte de nuevo. Se la busca por consultorio o por su número de cuenta.
create function public.mp_cuenta_caida(p_consultorio uuid, p_user_id text, p_motivo text) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  k record;
  n integer := 0;
  nl constant text := chr(10);
begin
  for k in
    update interno.mp_cuentas set estado = 'caida', error = left(coalesce(p_motivo, ''), 300)
     where estado <> 'caida'
       and ((p_consultorio is not null and consultorio_id = p_consultorio)
            or (p_consultorio is null and p_user_id is not null and mp_user_id = p_user_id))
    returning consultorio_id
  loop
    n := n + 1;
    perform interno.avisar_admin(k.consultorio_id, 'Hay que volver a conectar Mercado Pago',
      'La cuenta de Mercado Pago del consultorio dejó de estar conectada, así que por ahora no se pueden cobrar reservas '
      || 'ni hacer devoluciones.' || nl || nl
      || 'Para arreglarlo: entrá a la página, andá a Configuración → Mercado Pago y tocá «Conectar».');
  end loop;
  return n;
end $$;

-- ===================================================================================================
-- PAGAR UNA RESERVA
-- ===================================================================================================

-- La profesional aprieta «Pagar con Mercado Pago». Mismas reglas que el pago de prueba; deja anotado el intento y
-- devuelve lo que la función necesita para crear la orden. Si ya había una orden abierta que sirve, devuelve esa.
create function public.mp_pago_preparar(p_slug text, p_reserva uuid, p_tipo text) returns jsonb
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
  c := interno.consultorio(p_slug);
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
  if found then
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

-- La orden ya existe en Mercado Pago: se anota su número, la dirección donde se paga y en qué cuenta se cobra
-- (si más adelante el consultorio cambia de cuenta, se sabe que esa plata hay que devolverla desde la anterior).
--   p_sin_vencimiento: Mercado Pago no aceptó el plazo en minutos y la orden quedó sin vencimiento propio (la cierra el reloj)
create function public.mp_pago_orden(p_pago uuid, p_orden text, p_enlace text, p_cuenta text, p_sin_vencimiento boolean default false) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if coalesce(p_orden, '') !~ '^[A-Za-z0-9_-]{6,80}$' or coalesce(p_enlace, '') !~ '^https?://'
     or coalesce(p_cuenta, '') !~ '^[0-9]{1,20}$' then
    raise exception 'dato_invalido';
  end if;
  update public.pagos
     set proveedor_id = p_orden, enlace = p_enlace, error = null, actualizado_en = now(),
         datos = datos || jsonb_build_object('cuenta', p_cuenta)
                       || case when coalesce(p_sin_vencimiento, false) then jsonb_build_object('sin_vencimiento', true) else '{}'::jsonb end
   where id = p_pago and proveedor = 'mercadopago' and tipo <> 'devolucion' and (proveedor_id is null or proveedor_id = p_orden);
  if not found then raise exception 'pago_inexistente'; end if;
end $$;

-- No se pudo crear la orden: queda anotado por qué. El intento sigue abierto para probar de nuevo.
--   p_definitivo: Mercado Pago contestó que no (el próximo pedido va con otra clave). Si solo se cortó la conexión,
--   no se sabe si la orden llegó a crearse: el próximo pedido repite la misma clave y Mercado Pago devuelve la misma orden.
create function public.mp_pago_fallo(p_pago uuid, p_error text, p_definitivo boolean) returns void
language sql security definer set search_path = public, pg_temp as $$
  update public.pagos set error = left(coalesce(p_error, ''), 300),
                          intentos = intentos + case when coalesce(p_definitivo, false) then 1 else 0 end,
                          actualizado_en = now() - interval '1 minute'      -- no frena el próximo clic
   where id = p_pago and proveedor = 'mercadopago' and tipo <> 'devolucion' and estado = 'pendiente' and proveedor_id is null
$$;

-- Mercado Pago avisó de una orden: a qué pago nuestro corresponde (por el número de orden o por nuestra referencia)
create function public.mp_pago_ubicar(p_orden text, p_referencia text) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('pago', p.id, 'consultorio', p.consultorio_id, 'estado', p.estado, 'monto', p.monto,
                            'orden', p.proveedor_id, 'tipo', p.tipo)
    from public.pagos p
   where p.proveedor = 'mercadopago' and p.tipo <> 'devolucion'
     and ((p_orden is not null and p.proveedor_id = p_orden)
          or (p_referencia ~ '^[0-9a-fA-F-]{36}$' and p.id = p_referencia::uuid))
   order by (p.proveedor_id = p_orden) desc nulls last
   limit 1
$$;

-- ¿Ese pago es de quien pregunta? (para «ya pagué, fijate»): la profesional dueña de la reserva o la dueña del consultorio
create function public.mp_pago_mio(p_slug text, p_pago uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  c public.consultorios;
  m public.miembros;
  v jsonb;
begin
  c := interno.consultorio(p_slug);
  m := interno.yo(c.id);
  if m.id is null then raise exception 'pago_inexistente'; end if;
  select jsonb_build_object('pago', p.id, 'consultorio', p.consultorio_id, 'estado', p.estado, 'monto', p.monto,
                            'orden', p.proveedor_id, 'tipo', p.tipo, 'reserva', p.reserva_id)
    into v
    from public.pagos p join public.reservas r on r.id = p.reserva_id
   where p.id = p_pago and p.consultorio_id = c.id and p.proveedor = 'mercadopago' and p.tipo <> 'devolucion'
     and (r.miembro_id = m.id or (m.rol = 'admin' and m.estado = 'aprobado'));
  if v is null then raise exception 'pago_inexistente'; end if;
  return v;
end $$;

-- ¿Quien pregunta es de este consultorio? (para pedir que salgan ya las devoluciones que estén esperando)
create function public.mp_consultorio_mio(p_slug text) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  c public.consultorios;
  m public.miembros;
begin
  c := interno.consultorio(p_slug);
  m := interno.yo(c.id);
  if m.id is null then raise exception 'solo_miembros'; end if;
  return jsonb_build_object('consultorio', c.id, 'admin', m.rol = 'admin' and m.estado = 'aprobado');
end $$;

-- Deja la plata donde corresponde cuando Mercado Pago confirma un pago. Devuelve qué pasó:
--   «aprobado» (se acreditó), «revivio» (el plazo había vencido, pero el horario seguía libre) o «sobrante» (se devuelve entero).
create function interno.mp_aplicar(p_pago uuid, p_transaccion text) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  p public.pagos;
  r public.reservas;
  c public.consultorios;
  m public.miembros;
  v_consultorio uuid;
  v_box text;
  v_pagado integer;
  v_resultado text;
  v_motivo text;
  v_datos jsonb;
  nl constant text := chr(10);
begin
  select consultorio_id into v_consultorio from public.pagos where id = p_pago;
  if not found then raise exception 'pago_inexistente'; end if;
  c := interno.candado(v_consultorio);              -- de acá en más nadie más toca la agenda de este consultorio
  select * into p from public.pagos where id = p_pago for update;
  select * into r from public.reservas where id = p.reserva_id for update;
  select * into m from public.miembros where id = r.miembro_id;
  select nombre into v_box from public.boxes where id = r.box_id;
  v_pagado := interno.pagado(r.id);
  v_datos := p.datos || jsonb_build_object('transaccion', p_transaccion);

  if r.estado = 'pago' and p.tipo = r.plan then
    -- lo normal: estaba esperando este pago (aunque el plazo se haya pasado por segundos, el turno todavía es suyo)
    v_resultado := 'aprobado';
  elsif r.estado in ('confirmada', 'cumplida') and p.tipo = 'saldo' and v_pagado + p.monto <= r.total then
    v_resultado := 'aprobado';
  elsif r.estado = 'cancelada' and r.cancelada_por = 'vencida' and p.tipo = r.plan and v_pagado = 0
        and interno.instante(r.fecha, r.desde, c.zona) > now() and m.estado = 'aprobado'
        and not exists (select 1 from public.reserva_maquinas rm join public.maquinas q on q.id = rm.maquina_id
                         where rm.reserva_id = r.id and (not q.activa or q.quitada))
        and not exists (select 1 from public.bloqueos b join public.bloqueo_boxes bb on bb.bloqueo_id = b.id
                         where bb.box_id = r.box_id and b.creado_en > r.cancelada_en
                           and ((b.recurrente and b.dia_semana = interno.dia_semana(r.fecha)) or (not b.recurrente and b.fecha = r.fecha))
                           and b.desde < r.hasta and b.hasta > r.desde) then
    -- el plazo venció y el turno se había liberado, pero nadie lo tomó: revive
    begin
      update public.reservas set estado = 'confirmada', cancelada_en = null, cancelada_por = null, devolucion_monto = null,
                                 devolucion_pct = null, vence_en = null
       where id = r.id;
      update public.reserva_maquinas set activa = true where reserva_id = r.id;
      v_resultado := 'revivio';
    exception when exclusion_violation then
      v_resultado := 'sobrante';                    -- en el medio alguien tomó el horario o una de las máquinas
      v_motivo := 'el plazo para pagar había vencido y el horario ya lo tomó otra persona';
    end;
  else
    v_resultado := 'sobrante';
    v_motivo := case when r.estado = 'cancelada' and r.cancelada_por = 'vencida' then 'el plazo para pagar había vencido y el horario ya no estaba disponible'
                     when r.estado = 'cancelada' then 'la reserva ya estaba cancelada'
                     else 'ese pago ya estaba hecho' end;
  end if;

  if v_resultado = 'sobrante' then
    update public.pagos set estado = 'sobrante', aprobado_en = now(), datos = v_datos, error = left(v_motivo, 300), intentos = 0,
                            actualizado_en = now() - interval '1 hour'      -- que la devolución salga en la próxima vuelta
     where id = p.id;
    perform interno.avisar(m.id, 'Te devolvemos un pago',
      'Hola ' || interno.primer_nombre(m.nombre) || ':' || nl || nl
      || 'Recibimos tu pago de ' || interno.plata(p.monto) || ' por ' || v_box || ' del ' || interno.dia_largo(r.fecha)
      || ', pero ' || v_motivo || '.' || nl || nl
      || 'Te lo devolvemos entero por el mismo medio con el que pagaste (puede tardar unos días). No tenés que hacer nada.'
      || nl || nl || c.nombre);
    perform interno.avisar_admin(c.id, 'Pago para devolver: ' || m.nombre,
      m.nombre || ' pagó ' || interno.plata(p.monto) || ' por ' || v_box || ' del ' || interno.dia_largo(r.fecha)
      || ', pero ' || v_motivo || '.' || nl || 'El sistema se lo devuelve entero desde tu cuenta de Mercado Pago.');
    return v_resultado;
  end if;

  update public.pagos set estado = 'aprobado', aprobado_en = now(), datos = v_datos, error = null, actualizado_en = now()
   where id = p.id;
  if r.estado = 'pago' then
    update public.reservas set estado = 'confirmada', vence_en = null where id = r.id;
  end if;
  if p.tipo = 'saldo' then
    perform interno.avisar(m.id, 'Recibimos tu pago',
      'Hola ' || interno.primer_nombre(m.nombre) || ':' || nl || nl
      || 'Recibimos ' || interno.plata(p.monto) || ' para ' || v_box || ' del ' || interno.dia_largo(r.fecha) || '. '
      || case when r.total > v_pagado + p.monto then 'Te queda ' || interno.plata(r.total - v_pagado - p.monto) || '.'
              else 'Tu turno está pago completo.' end
      || nl || nl || c.nombre);
  else
    perform interno.avisar_confirmada(r.id);
  end if;
  return v_resultado;
end $$;

-- Lo que contestó Mercado Pago sobre una orden (la función ya comprobó que la orden es de esa cuenta y de ese pago).
--   p_estado: el estado de la orden («processed», «failed», «canceled», «refunded»…)
--   p_pagado: lo que Mercado Pago dice que se pagó · p_transaccion: el número del pago adentro de la orden
--   p_cuenta: la cuenta de Mercado Pago que cobró esa orden
create function public.mp_pago_resultado(p_pago uuid, p_orden text, p_estado text, p_detalle text, p_pagado numeric,
                                         p_transaccion text, p_cuenta text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  p public.pagos;
  v_consultorio uuid;
  v_reserva uuid;
  v_que text;
  nl constant text := chr(10);
begin
  select consultorio_id, reserva_id into v_consultorio, v_reserva from public.pagos
   where id = p_pago and proveedor = 'mercadopago' and tipo <> 'devolucion';
  if not found then raise exception 'pago_inexistente'; end if;
  -- Los candados se toman SIEMPRE en el mismo orden (consultorio → reserva → pago), como en reservar y cancelar:
  -- así un aviso que llega mientras alguien cancela espera su turno en lugar de trabarse con la cancelación.
  perform interno.candado(v_consultorio);
  perform 1 from public.reservas where id = v_reserva for update;
  select * into p from public.pagos where id = p_pago for update;
  if coalesce(p_orden, '') = '' or (p.proveedor_id is not null and p.proveedor_id <> p_orden) then
    -- la orden no es la que se anotó para este pago: no se toca la plata, se mira a mano
    if p.estado in ('pendiente', 'vencido', 'rechazado') then
      update public.pagos set estado = 'revisar', error = 'la orden de Mercado Pago no es la de este pago', actualizado_en = now() where id = p.id;
      perform interno.avisar_admin(p.consultorio_id, 'Un pago para revisar',
        'Mercado Pago informó una orden que no coincide con el pago anotado. No se acreditó nada: avisale a Entreturno.');
    end if;
    return jsonb_build_object('estado', 'revisar');
  end if;
  if p.proveedor_id is null or (p_cuenta ~ '^[0-9]{1,20}$' and not (p.datos ? 'cuenta')) then
    -- la orden se había creado, pero no llegó a anotarse (o le faltaba en qué cuenta se cobró)
    update public.pagos
       set proveedor_id = p_orden,
           datos = datos || case when p_cuenta ~ '^[0-9]{1,20}$' and not (datos ? 'cuenta') then jsonb_build_object('cuenta', p_cuenta) else '{}'::jsonb end
     where id = p.id
    returning * into p;
  end if;
  if p.datos ? 'sin_comprobar' then                                        -- ya se pudo leer la orden: deja de estar en duda
    update public.pagos set datos = datos - 'sin_comprobar' where id = p.id returning * into p;
  end if;

  if p_estado in ('processed', 'refunded') and p.estado in ('aprobado', 'sobrante', 'devuelto', 'revisar') then
    return jsonb_build_object('estado', p.estado, 'repetido', true);       -- aviso repetido: ya estaba aplicado
  end if;

  if p_estado = 'processed' then
    if p_pagado is null or round(p_pagado) <> p.monto or coalesce(p_transaccion, '') = '' then
      update public.pagos set estado = 'revisar', actualizado_en = now(),
                              error = left('Mercado Pago informa ' || coalesce(p_pagado::text, 'nada') || ' y se esperaban ' || p.monto, 300)
       where id = p.id;
      perform interno.avisar_admin(p.consultorio_id, 'Un pago para revisar',
        'Mercado Pago informó un pago por un importe distinto del esperado. No se acreditó nada: avisale a Entreturno.');
      return jsonb_build_object('estado', 'revisar');
    end if;
    v_que := interno.mp_aplicar(p.id, p_transaccion);
    return jsonb_build_object('estado', case when v_que = 'sobrante' then 'sobrante' else 'aprobado' end, 'que', v_que);
  end if;

  if p.estado = 'pendiente' then
    if p_estado = 'failed' then
      update public.pagos set estado = 'rechazado', error = left(coalesce(nullif(p_detalle, ''), 'rechazado'), 300), actualizado_en = now()
       where id = p.id;
      return jsonb_build_object('estado', 'rechazado', 'detalle', p_detalle);
    elsif p_estado in ('canceled', 'expired', 'refunded') then
      -- cancelada, vencida, o pagada y devuelta desde Mercado Pago antes de que llegara a acreditarse: no entró plata
      update public.pagos set estado = 'vencido', actualizado_en = now(), datos = datos || jsonb_build_object('cerrada', true)
       where id = p.id;
      return jsonb_build_object('estado', 'vencido');
    end if;
    update public.pagos set actualizado_en = now() where id = p.id;       -- sigue abierta: se vuelve a mirar más tarde
  elsif p.estado in ('vencido', 'rechazado') and p_estado in ('canceled', 'expired', 'failed', 'refunded') then
    update public.pagos set datos = datos || jsonb_build_object('cerrada', true), actualizado_en = now() where id = p.id;
  end if;
  return jsonb_build_object('estado', p.estado);
end $$;

-- Una orden vieja ya quedó cerrada en Mercado Pago (cancelada): no hace falta volver a mirarla
create function public.mp_pago_cerrado(p_pago uuid) returns void
language sql security definer set search_path = public, pg_temp as $$
  update public.pagos set datos = datos || jsonb_build_object('cerrada', true), actualizado_en = now()
   where id = p_pago and proveedor = 'mercadopago' and tipo <> 'devolucion' and estado in ('vencido', 'rechazado')
$$;

-- Mercado Pago avisó de una orden y no se pudo leer (lo más común: la cuenta del consultorio está desconectada).
-- Queda marcada: el reloj la sigue mirando hasta poder comprobarla, aunque el intento ya esté cerrado o sea viejo.
-- Si el aviso decía que estaba pagada, la dueña se entera (una vez).
create function public.mp_pago_sin_comprobar(p_pago uuid, p_pagada boolean) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  p public.pagos;
  nl constant text := chr(10);
begin
  select * into p from public.pagos
   where id = p_pago and proveedor = 'mercadopago' and tipo <> 'devolucion' and estado in ('pendiente', 'vencido', 'rechazado')
     for update;
  if not found or p.datos ? 'sin_comprobar' then return; end if;
  update public.pagos set datos = datos || jsonb_build_object('sin_comprobar', true), actualizado_en = now() where id = p.id;
  if coalesce(p_pagada, false) then
    perform interno.avisar_admin(p.consultorio_id, 'Un pago de Mercado Pago sin comprobar',
      'Mercado Pago avisó de un pago de ' || interno.plata(p.monto) || ', pero no se pudo comprobar porque la cuenta de Mercado Pago '
      || 'del consultorio no está conectada.' || nl || nl
      || 'Entrá a la página, andá a Configuración → Mercado Pago y conectá la cuenta de nuevo: el sistema lo comprueba solo y '
      || 'confirma la reserva o devuelve la plata, según corresponda.');
  end if;
end $$;

-- ===================================================================================================
-- CANCELAR: la devolución sale por Mercado Pago solo si la plata entró por Mercado Pago
-- ===================================================================================================
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

-- ===================================================================================================
-- DEVOLVER
-- ===================================================================================================

-- La función toma una devolución para ejecutarla. Acá se decide, UNA sola vez, de qué pagos sale cada parte
-- (del más nuevo al más viejo) y queda anotado antes de pedirle nada a Mercado Pago: si se corta en el medio,
-- la vuelta siguiente repite exactamente los mismos pedidos y Mercado Pago no devuelve dos veces.
-- Mientras una vuelta la tiene tomada (un minuto y medio), ninguna otra la ejecuta ni se puede marcar «a mano».
create function public.mp_devolucion_tomar(p_devolucion uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  d public.pagos;
  x record;
  v_reserva uuid;
  v_partes jsonb := '[]'::jsonb;
  v_falta integer;
  v_parte integer;
  n integer := 0;
begin
  select reserva_id into v_reserva from public.pagos where id = p_devolucion and tipo = 'devolucion' and proveedor = 'mercadopago';
  if not found then return null; end if;
  perform 1 from public.reservas where id = v_reserva for update;        -- mismo orden de candados que en todo lo demás: reserva → pago
  select * into d from public.pagos
   where id = p_devolucion and tipo = 'devolucion' and proveedor = 'mercadopago' and estado = 'pendiente'
     for update;
  if not found then return null; end if;
  if (d.datos ->> 'tomada_hasta')::timestamptz > now() then return null; end if;      -- otra vuelta la está ejecutando ahora
  if not (d.datos ? 'partes') then
    v_falta := d.monto;
    for x in
      select p.id, p.proveedor_id, p.datos ->> 'transaccion' as transaccion, p.monto,
             coalesce((p.datos ->> 'devuelto')::integer, 0) as devuelto
        from public.pagos p
       where p.reserva_id = d.reserva_id and p.proveedor = 'mercadopago' and p.tipo <> 'devolucion' and p.estado = 'aprobado'
         and p.proveedor_id is not null
       order by p.aprobado_en desc, p.id
         for update of p
    loop
      exit when v_falta <= 0;
      v_parte := least(v_falta, x.monto - x.devuelto);
      continue when v_parte <= 0;
      n := n + 1;
      v_partes := v_partes || jsonb_build_object('n', n, 'pago', x.id, 'orden', x.proveedor_id, 'transaccion', x.transaccion,
                                                 'monto', v_parte, 'entera', v_parte = x.monto and x.devuelto = 0, 'estado', 'pendiente');
      v_falta := v_falta - v_parte;
    end loop;
    -- lo que no entró por Mercado Pago (pagos de prueba de antes) no tiene plata que devolver
    update public.pagos set datos = datos || jsonb_build_object('partes', v_partes, 'sin_plata', greatest(v_falta, 0)) where id = d.id
    returning * into d;
  end if;
  if not exists (select 1 from jsonb_array_elements(d.datos -> 'partes') e where e ->> 'estado' <> 'hecha') then
    update public.pagos set estado = 'aprobado', aprobado_en = now(), error = null, actualizado_en = now(), datos = datos - 'tomada_hasta'
     where id = d.id;
    return jsonb_build_object('devolucion', d.id, 'consultorio', d.consultorio_id, 'partes', '[]'::jsonb, 'lista', true);
  end if;
  update public.pagos set datos = datos || jsonb_build_object('tomada_hasta', now() + interval '90 seconds'), actualizado_en = now()
   where id = d.id
  returning * into d;
  -- cada parte lleva en qué cuenta se cobró ese pago y cuánto se le lleva devuelto (para reconocer una devolución que ya salió)
  return jsonb_build_object('devolucion', d.id, 'consultorio', d.consultorio_id, 'lista', false,
    'partes', (select jsonb_agg(e.x || jsonb_build_object('cuenta', o.datos ->> 'cuenta',
                                                          'devueltoAntes', coalesce((o.datos ->> 'devuelto')::integer, 0))
                                order by (e.x ->> 'n')::integer)
                 from jsonb_array_elements(d.datos -> 'partes') as e(x) join public.pagos o on o.id = (e.x ->> 'pago')::uuid
                where e.x ->> 'estado' <> 'hecha'));
end $$;

-- Cómo salió una de las partes. Con la última, la devolución queda hecha. Si falla, queda para reintentar.
-- La dueña se entera por mail cuando Mercado Pago dijo que no (p_definitivo; lo más común: su cuenta no tiene saldo)
-- o cuando ya van tres intentos, y después una vez por semana mientras siga sin salir.
create function public.mp_devolucion_parte(p_devolucion uuid, p_n integer, p_hecha boolean, p_referencia text, p_error text,
                                           p_definitivo boolean default false) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  d public.pagos;
  e jsonb;
  v_reserva uuid;
  v_partes jsonb := '[]'::jsonb;
  v_estaba boolean := false;
  v_intentos integer;
  v_avisar boolean;
  v_quien text;
  nl constant text := chr(10);
begin
  select reserva_id into v_reserva from public.pagos where id = p_devolucion and tipo = 'devolucion' and proveedor = 'mercadopago';
  if not found then raise exception 'pago_inexistente'; end if;
  perform 1 from public.reservas where id = v_reserva for update;
  select * into d from public.pagos
   where id = p_devolucion and tipo = 'devolucion' and proveedor = 'mercadopago' and estado = 'pendiente' and datos ? 'partes'
     for update;
  if not found then raise exception 'pago_inexistente'; end if;
  for e in select t.x from jsonb_array_elements(d.datos -> 'partes') as t(x) order by (t.x ->> 'n')::integer loop
    if (e ->> 'n')::integer = p_n then
      v_estaba := true;
      if e ->> 'estado' <> 'hecha' and p_hecha then
        update public.pagos set datos = datos || jsonb_build_object('devuelto', coalesce((datos ->> 'devuelto')::integer, 0) + (e ->> 'monto')::integer)
         where id = (e ->> 'pago')::uuid;
        e := e || jsonb_build_object('estado', 'hecha', 'referencia', p_referencia);
      end if;
    end if;
    v_partes := v_partes || e;
  end loop;
  if not v_estaba then raise exception 'dato_invalido'; end if;

  if p_hecha then
    if not exists (select 1 from jsonb_array_elements(v_partes) x where x ->> 'estado' <> 'hecha') then
      update public.pagos set estado = 'aprobado', aprobado_en = now(), error = null, actualizado_en = now(),
                              datos = (datos - 'tomada_hasta') || jsonb_build_object('partes', v_partes)
       where id = d.id;
      return jsonb_build_object('estado', 'aprobado');
    end if;
    update public.pagos set datos = datos || jsonb_build_object('partes', v_partes), actualizado_en = now() where id = d.id;
    return jsonb_build_object('estado', 'pendiente');
  end if;

  v_intentos := d.intentos + 1;
  v_avisar := (not (d.datos ? 'avisada') and (coalesce(p_definitivo, false) or v_intentos >= 3)) or v_intentos % 28 = 0;
  update public.pagos set intentos = v_intentos, error = left(coalesce(nullif(p_error, ''), 'Mercado Pago no la aceptó'), 300),
                          actualizado_en = now(),
                          datos = (datos - 'tomada_hasta') || case when v_avisar then jsonb_build_object('avisada', true) else '{}'::jsonb end
   where id = d.id;
  if v_avisar then
    select m.nombre into v_quien from public.reservas r join public.miembros m on m.id = r.miembro_id where r.id = d.reserva_id;
    perform interno.avisar_admin(d.consultorio_id, 'Una devolución no pudo salir: ' || v_quien,
      'El sistema quiso devolverle ' || interno.plata(d.monto) || ' a ' || v_quien || ' y Mercado Pago no lo aceptó.' || nl
      || 'Motivo: ' || coalesce(nullif(p_error, ''), 'sin detalle') || nl || nl
      || 'Lo más común es que la cuenta de Mercado Pago no tenga saldo disponible. El sistema lo va a seguir intentando; '
      || 'si preferís hacerla vos desde Mercado Pago, después marcala como hecha en la página (Pagos).');
  end if;
  return jsonb_build_object('estado', 'pendiente', 'intentos', v_intentos);
end $$;

-- La dueña hizo la devolución por su cuenta (desde Mercado Pago o en mano) y la marca como hecha.
-- No se puede justo mientras el sistema la está intentando: podrían salir las dos.
create function public.mp_devolucion_a_mano(p_slug text, p_devolucion uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c public.consultorios;
  m public.miembros;
  d public.pagos;
begin
  c := interno.consultorio(p_slug);
  m := interno.admin(c.id);
  select * into d from public.pagos
   where id = p_devolucion and consultorio_id = c.id
     and ((tipo = 'devolucion' and estado = 'pendiente') or (tipo <> 'devolucion' and estado = 'sobrante'))
     for update;
  if not found then raise exception 'pago_inexistente'; end if;
  if (d.datos ->> 'tomada_hasta')::timestamptz > now() then raise exception 'mp_en_curso'; end if;
  update public.pagos set estado = case when d.tipo = 'devolucion' then 'aprobado' else 'devuelto' end,
                          aprobado_en = case when d.tipo = 'devolucion' then now() else aprobado_en end,
                          error = null, actualizado_en = now(), datos = datos || jsonb_build_object('a_mano', m.id)
   where id = d.id;
  return jsonb_build_object('ok', true);
end $$;

-- La función toma un pago que entró de más para devolverlo entero. Igual que con las devoluciones: de a una vuelta por vez.
create function public.mp_sobrante_tomar(p_pago uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  p public.pagos;
begin
  select * into p from public.pagos where id = p_pago and proveedor = 'mercadopago' and estado = 'sobrante' and proveedor_id is not null
     for update;
  if not found or (p.datos ->> 'tomada_hasta')::timestamptz > now() then return null; end if;
  update public.pagos set datos = datos || jsonb_build_object('tomada_hasta', now() + interval '90 seconds'), actualizado_en = now()
   where id = p.id;
  return jsonb_build_object('pago', p.id, 'consultorio', p.consultorio_id, 'orden', p.proveedor_id, 'cuenta', p.datos ->> 'cuenta');
end $$;

-- Cómo salió la devolución de un sobrante (se devuelve la orden entera)
create function public.mp_sobrante_resultado(p_pago uuid, p_hecha boolean, p_error text, p_definitivo boolean default false) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  p public.pagos;
  v_intentos integer;
  v_avisar boolean;
  nl constant text := chr(10);
begin
  select * into p from public.pagos where id = p_pago and proveedor = 'mercadopago' and estado = 'sobrante' for update;
  if not found then return; end if;
  if p_hecha then
    update public.pagos set estado = 'devuelto', intentos = intentos + 1, actualizado_en = now(), datos = datos - 'tomada_hasta' where id = p.id;
    return;
  end if;
  v_intentos := p.intentos + 1;
  v_avisar := (not (p.datos ? 'avisada') and (coalesce(p_definitivo, false) or v_intentos >= 3)) or v_intentos % 28 = 0;
  update public.pagos set intentos = v_intentos, actualizado_en = now(),
                          datos = (datos - 'tomada_hasta') || jsonb_build_object('falla', left(coalesce(p_error, ''), 300))
                                  || case when v_avisar then jsonb_build_object('avisada', true) else '{}'::jsonb end
   where id = p.id;
  if v_avisar then
    perform interno.avisar_admin(p.consultorio_id, 'Una devolución no pudo salir',
      'El sistema quiso devolver un pago de ' || interno.plata(p.monto) || ' que entró de más y Mercado Pago no lo aceptó.' || nl
      || 'Motivo: ' || coalesce(nullif(p_error, ''), 'sin detalle') || nl || nl
      || 'Lo más común es que la cuenta de Mercado Pago no tenga saldo disponible. El sistema lo va a seguir intentando; '
      || 'si preferís hacerla vos desde Mercado Pago, después marcala como hecha en la página (Pagos).');
  end if;
end $$;

-- ===================================================================================================
-- EL RELOJ: lo que hay que mirar sin que nadie lo pida
-- ===================================================================================================
-- (por si un aviso de Mercado Pago no llegó, para que salgan las devoluciones y para renovar los pases)
-- Nada se abandona en silencio: lo que no se pudo resolver en su plazo pasa a «revisar» con un aviso (interno.mp_vencidos),
-- y las devoluciones se siguen intentando hasta que salgan o la dueña las marque como hechas.
create function public.mp_pendientes(p_consultorio uuid default null) returns jsonb
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
                            where k.estado = 'conectada' and k.vence < now() + interval '30 days'
                              and (k.renovada_en is null or k.renovada_en < now() - interval '1 day')), '[]'::jsonb)
               else '[]'::jsonb end)
$$;

-- Lo que se pasó de plazo sin poder resolverse: no queda «pendiente» para siempre, pasa a «revisar» y la dueña se entera.
--   - un intento que nunca llegó a tener orden y ya venció: se cierra, nadie pudo pagarlo (no hubo dónde);
--   - una orden que no se pudo consultar en Mercado Pago en 3 días (o en 60, si Mercado Pago había avisado de ella).
create function interno.mp_vencidos() returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  p record;
  n integer := 0;
begin
  update public.pagos set estado = 'vencido', actualizado_en = now()
   where proveedor = 'mercadopago' and tipo <> 'devolucion' and estado = 'pendiente' and proveedor_id is null
     and vence_en < now() - interval '10 minutes';
  for p in
    update public.pagos set estado = 'revisar', actualizado_en = now(),
                            error = 'No se pudo consultar esta orden en Mercado Pago'
     where proveedor = 'mercadopago' and tipo <> 'devolucion' and proveedor_id is not null
       and ((estado = 'pendiente' and not (datos ? 'sin_comprobar') and creado_en < now() - interval '3 days')
            or (estado in ('pendiente', 'vencido', 'rechazado') and datos ? 'sin_comprobar' and creado_en < now() - interval '60 days'))
    returning consultorio_id, monto
  loop
    n := n + 1;
    perform interno.avisar_admin(p.consultorio_id, 'Un pago para revisar',
      'Hay un cobro de ' || interno.plata(p.monto) || ' que el sistema no pudo consultar en Mercado Pago durante varios días. '
      || 'Avisale a Entreturno para que lo revise con vos en tu cuenta de Mercado Pago.');
  end loop;
  return n;
end $$;

create function interno.mp_hay_trabajo() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from jsonb_each(public.mp_pendientes()) t where jsonb_array_length(t.value) > 0)
$$;

-- La clave con la que el reloj le habla a la función. Vive en el Vault; la función le pregunta a la base si es esa.
create function public.mp_reloj_clave(p_clave text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(char_length(p_clave) >= 32 and p_clave = interno.secreto_leer('mp_clave_reloj'), false)
$$;

-- Lo corre el reloj del servidor cada minuto: cierra lo que se pasó de plazo y, si hay algo para hacer, despierta a la función.
create function interno.mp_reloj() returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_url text;
  v_clave text;
begin
  perform interno.mp_vencidos();
  if not interno.mp_hay_trabajo() then return false; end if;
  select valor into v_url from interno.ajustes where clave = 'funcion_mp_url';
  v_clave := interno.secreto_leer('mp_clave_reloj');
  if coalesce(v_url, '') !~ '^https://' or coalesce(v_clave, '') = '' then return false; end if;
  perform net.http_post(url := v_url, body := jsonb_build_object('accion', 'reloj'),
                        headers := jsonb_build_object('Content-Type', 'application/json', 'x-entreturno-reloj', v_clave));
  return true;
end $$;

-- ===================================================================================================
-- Candado y permisos
-- ===================================================================================================
alter table interno.mp_cuentas enable row level security;
alter table interno.mp_estados enable row level security;
alter table interno.ajustes enable row level security;
revoke all on table interno.mp_cuentas, interno.mp_estados, interno.ajustes from public, anon, authenticated;

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
    'facturacion_preparar', 'facturacion_estado',
    'mp_conexion_iniciar', 'mp_conexion_confirmar', 'mp_desconectar', 'mp_pago_preparar', 'mp_pago_mio', 'mp_consultorio_mio',
    'mp_devolucion_a_mano'];
  v_servicio constant text[] := array[
    'arca_ticket', 'arca_guardar_ticket', 'arca_candado', 'arca_anotar', 'arca_resultado',
    'mp_conexion_tomar', 'mp_cuenta_guardar', 'mp_credencial', 'mp_cuenta_renovada', 'mp_cuenta_reintento', 'mp_cuenta_caida',
    'mp_cuentas_de', 'mp_pago_orden', 'mp_pago_fallo', 'mp_pago_ubicar', 'mp_pago_resultado', 'mp_pago_cerrado',
    'mp_pago_sin_comprobar', 'mp_devolucion_tomar', 'mp_devolucion_parte', 'mp_sobrante_tomar', 'mp_sobrante_resultado',
    'mp_pendientes', 'mp_reloj_clave'];
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
