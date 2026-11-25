-- =====================================================================================================
-- Entreturno · Boxes — la copia de seguridad de todos los días
-- =====================================================================================================
-- Cómo es: todas las noches GitHub le pide la copia a la función de Supabase «copia» (con una clave). La función le pide los
-- datos a la base (copia_datos), los cifra con la llave PÚBLICA de Entreturno y entrega el archivo ya cifrado: ni GitHub ni
-- quien tenga esa clave lo pueden leer. Se abre solo con la llave privada, que no está en ningún servidor.
-- GitHub lo guarda 30 días (lo que promete el convenio), confirma que lo guardó (copia_guardada) y después se borra solo.
--
-- Qué NO se copia: lo que se puede volver a pedir y sería peligroso tener guardado: los pases de Mercado Pago y la clave de los
-- mails (viven en el Vault), el ticket de ARCA, los candados y los intentos de conexión, y los códigos de los mails de registro.
-- =====================================================================================================

-- Lo que no va en la copia (con nombre y apellido: cualquier tabla nueva entra sola; las pruebas piden revisar cada columna nueva)
create function interno.copia_tablas() returns table (esquema text, tabla text)
language sql stable security definer set search_path = public, pg_temp as $$
  select n.nspname::text, c.relname::text
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where c.relkind in ('r', 'p') and n.nspname in ('public', 'interno')
     and not (n.nspname = 'interno' and c.relname in ('arca_tickets', 'arca_candados', 'mp_estados'))
   order by 1, 2
$$;

-- Todos los datos, de una sola foto: es STABLE, así que todas las consultas de adentro ven el mismo instante (no puede
-- salir una reserva sin su pago porque alguien pagó en el medio).
create function public.copia_datos() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  t record;
  v_filas jsonb;
  v_tablas jsonb := '{}'::jsonb;
begin
  for t in select esquema, tabla from interno.copia_tablas() loop
    execute format('select coalesce(jsonb_agg(to_jsonb(x)), ''[]''::jsonb) from %I.%I x', t.esquema, t.tabla) into v_filas;
    v_tablas := v_tablas || jsonb_build_object(t.esquema || '.' || t.tabla, v_filas);
  end loop;
  -- Las cuentas (con la contraseña como la guarda Supabase, que no se puede leer), sin los códigos de los mails de registro
  -- (todo lo que se llame «token»). Van vacíos y no nulos: así los espera Supabase al volver a cargarlas.
  select coalesce(jsonb_agg(x.fila || coalesce((select jsonb_object_agg(k, '') from jsonb_object_keys(x.fila) k where k like '%token%'), '{}'::jsonb)), '[]'::jsonb)
    into v_filas from (select to_jsonb(u) as fila from auth.users u) x;
  v_tablas := v_tablas || jsonb_build_object('auth.users', v_filas);
  if to_regclass('auth.identities') is not null then
    execute 'select coalesce(jsonb_agg(to_jsonb(i)), ''[]''::jsonb) from auth.identities i' into v_filas;
    v_tablas := v_tablas || jsonb_build_object('auth.identities', v_filas);
  end if;
  return jsonb_build_object('formato', 1, 'hecha', now(),
    'filas', (select jsonb_object_agg(e.key, jsonb_array_length(e.value)) from jsonb_each(v_tablas) e), 'tablas', v_tablas);
end $$;

-- ---------------------------------------------------------------------------------------------------
-- La constancia de cada copia (sin ningún dato): cuándo salió y cuándo confirmó GitHub que la guardó
-- ---------------------------------------------------------------------------------------------------
create table interno.copias (
  id          uuid primary key default gen_random_uuid(),
  hecha_en    timestamptz not null default now(),
  guardada_en timestamptz,                                           -- GitHub confirmó que la guardó
  bytes       integer not null check (bytes > 0),                    -- del archivo cifrado
  datos       integer not null check (datos > 0),                    -- de los datos sin comprimir: para ver venir que crece
  huella      text not null unique check (huella ~ '^[0-9a-f]{64}$'),      -- SHA-256 del archivo cifrado, para comparar con el que se bajó
  llaves      text not null check (char_length(llaves) between 1 and 300)  -- con qué llaves se puede abrir
);
create index on interno.copias (hecha_en);

create function public.copia_anotar(p_bytes integer, p_datos integer, p_huella text, p_llaves text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into interno.copias (bytes, datos, huella, llaves) values (p_bytes, p_datos, p_huella, p_llaves);
  delete from interno.copias where hecha_en < now() - interval '400 days';
end $$;

-- GitHub confirma que el archivo con esa huella quedó guardado (solo una copia de hoy, y una sola vez)
create function public.copia_guardada(p_huella text) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update interno.copias set guardada_en = now() where huella = p_huella and guardada_en is null and hecha_en > now() - interval '1 day';
  return found;
end $$;

-- El vigía. Una vez por hora mira, y le manda un mail a Entreturno si hace falta:
--   - «falta»: hace más de 30 horas que GitHub no confirma una copia guardada (desde que se puso en marcha, aunque nunca haya
--     salido ninguna). Uno por día.
--   - «grande»: los datos pasaron los 15 MB; esta forma de copiar anda bien hasta unos 40. Uno por semana.
-- Si el servicio de mails no aceptó el aviso, lo manda de nuevo a la hora.
create function interno.copias_vigilar() returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_desde timestamptz;
  v_ultima timestamptz;
  v_datos integer;
  v_que text;
  v_aviso jsonb;
  v_estado integer;
  v_para text;
  v_clave text;
  v_pedido bigint;
  nl constant text := chr(10);
begin
  select valor::timestamptz into v_desde from interno.ajustes where clave = 'copia_desde';
  if v_desde is null then return false; end if;                         -- todavía no está en marcha
  select max(guardada_en) into v_ultima from interno.copias;
  select datos into v_datos from interno.copias order by hecha_en desc limit 1;
  v_que := case when coalesce(v_ultima, v_desde) < now() - interval '30 hours' then 'falta' when v_datos > 15000000 then 'grande' end;
  if v_que is null then return false; end if;

  select valor::jsonb into v_aviso from interno.ajustes where clave = 'copia_avisada';
  if v_aviso ->> 'que' = v_que
     and (v_aviso ->> 'en')::timestamptz > now() - (case v_que when 'falta' then interval '24 hours' else interval '7 days' end) then
    if v_aviso ? 'salio' then return false; end if;
    select status_code into v_estado from net._http_response where id = (v_aviso ->> 'pedido')::bigint;
    if v_estado between 200 and 299 then
      update interno.ajustes set valor = (v_aviso || '{"salio": true}')::text where clave = 'copia_avisada';
      return false;
    end if;
    if v_estado is null and (v_aviso ->> 'en')::timestamptz > now() - interval '50 minutes' then return false; end if;      -- todavía no contestó
  end if;

  select valor into v_para from interno.ajustes where clave = 'mail_soporte';
  select decrypted_secret into v_clave from vault.decrypted_secrets where name = 'resend_api_key';
  if v_para is null or v_para not like '%_@_%' or v_clave is null or btrim(v_clave) = '' then return false; end if;
  select net.http_post(
    url := 'https://api.resend.com/emails',
    body := jsonb_build_object('from', 'Entreturno <avisos@entreturno.com.ar>', 'to', jsonb_build_array(v_para),
      'subject', case v_que when 'falta' then 'No está saliendo la copia de seguridad' else 'La copia de seguridad está creciendo' end,
      'text', case v_que when 'falta' then
          'La última copia de seguridad de la base de Entreturno ' || case when v_ultima is null then 'todavía no se guardó ni una vez'
              else 'se guardó el ' || to_char(v_ultima at time zone 'America/Argentina/Buenos_Aires', 'DD/MM/YYYY "a las" HH24:MI') end || '.' || nl || nl
          || 'Tiene que salir una por noche. Mirá en GitHub (repositorio entreturno-boxes, pestaña Actions, «Copia diaria») qué dice la última, '
          || 'y probá apretar «Run workflow». Los pasos están en el LEEME, sección «Copia de seguridad».'
        else 'Los datos que se copian ya pesan ' || round(v_datos / 1000000.0) || ' MB. Esta forma de copiar anda bien hasta unos 40: '
          || 'antes de llegar hay que pasar a copias por partes, o al plan pago de Supabase (que las hace solo).' end),
    headers := jsonb_build_object('Authorization', 'Bearer ' || btrim(v_clave), 'Content-Type', 'application/json',
                                  'Idempotency-Key', 'copia-' || v_que || '-' || to_char(now(), 'YYYYMMDDHH24')))
    into v_pedido;
  insert into interno.ajustes (clave, valor) values ('copia_avisada', jsonb_build_object('que', v_que, 'en', now(), 'pedido', v_pedido)::text)
    on conflict (clave) do update set valor = excluded.valor;
  return true;
end $$;

-- ---------------------------------------------------------------------------------------------------
-- Candado y permisos: los datos los pide solo la función de Supabase (service_role)
-- ---------------------------------------------------------------------------------------------------
alter table interno.copias enable row level security;
revoke all on table interno.copias from public, anon, authenticated;
revoke all on function interno.copia_tablas() from public, anon, authenticated;
revoke all on function interno.copias_vigilar() from public, anon, authenticated;
revoke all on function public.copia_datos() from public, anon, authenticated;
revoke all on function public.copia_anotar(integer, integer, text, text) from public, anon, authenticated;
revoke all on function public.copia_guardada(text) from public, anon, authenticated;
grant execute on function public.copia_datos() to service_role;
grant execute on function public.copia_anotar(integer, integer, text, text) to service_role;
grant execute on function public.copia_guardada(text) to service_role;
