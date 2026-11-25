-- =====================================================================================================
-- Entreturno · Boxes — El aviso de datos personales y la constancia de quién lo aceptó (25/11/2026)
-- =====================================================================================================
-- El convenio con cada consultorio (11.4) dice que, antes de crear su cuenta, cada profesional es informada y acepta de
-- manera expresa que sus datos se guarden fuera de la Argentina, y que Entreturno guarda la constancia.
--
-- Qué pide la ley (leído en argentina.gob.ar el 25/11/2026):
--   - Ley 25.326, artículo 6: informar antes para qué se usan los datos, quiénes los reciben, quién es el responsable y su
--     domicilio, qué es obligatorio y qué no, qué pasa si no se dan, y los derechos de acceso, rectificación y supresión.
--   - Artículo 5: consentimiento libre, expreso e informado, destacado si va con otras declaraciones.
--   - Artículo 12 y Decreto 1558/2001, artículo 12: a países sin protección adecuada (Brasil y Estados Unidos no están en la
--     lista de la Disposición DNPDP 60/2016 y la Resolución AAIP 34/2019) se puede con el consentimiento expreso.
--   - Resolución AAIP 14/2018, artículo 3: el texto sobre la Agencia de Acceso a la Información Pública, tal cual.
--
-- Cómo funciona:
--   - El texto es una plantilla con versión, igual para todos los consultorios. Se completa con los datos de cada uno.
--   - La página muestra el texto completo y manda de vuelta su huella: solo vale si es la del texto que está vigente. Queda
--     anotado que esa persona, con su cuenta, mandó su aceptación de ese texto (que se guarda entero), y cuándo. No prueba
--     que lo haya leído: eso no lo puede probar ninguna página.
--   - Si se publica una versión nueva (un renglón más en interno.privacidad), la página la muestra y la pide de nuevo, y
--     nadie puede reservar sin aceptarla. Si solo cambian los datos del consultorio, no se vuelve a pedir.
--   - La dueña completa sus datos (responsable, domicilio y mail) en Configuración.
-- No borra nada. Hasta que se publique la página nueva, con la anterior no se puede pedir acceso ni reservar (contestan
-- privacidad_falta y esa página no tiene cómo aceptarlo): cargar esto y publicar seguido. Ver, pagar y cancelar siguen andando.
-- =====================================================================================================

alter table public.consultorios
  add column priv_responsable text not null default '' check (char_length(priv_responsable) <= 120),
  add column priv_domicilio   text not null default '' check (char_length(priv_domicilio) <= 160),
  add column priv_contacto    text not null default ''
    check (priv_contacto = '' or (char_length(priv_contacto) <= 254 and priv_contacto ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'));

-- La plantilla del aviso, con versión. Para cambiar el texto: un renglón nuevo, con la versión que sigue (nunca editar el viejo).
create table interno.privacidad (
  version integer primary key check (version > 0),
  texto   text not null check (char_length(texto) between 200 and 20000),
  desde   timestamptz not null default now()
);

-- Cada texto completo que alguien aceptó alguna vez (la plantilla con los datos del consultorio), para poder mostrarlo
create table interno.privacidad_textos (
  consultorio_id uuid not null references public.consultorios (id),
  huella         text not null,
  version        integer not null references interno.privacidad (version),
  texto          text not null,
  primera_vez    timestamptz not null default now(),
  primary key (consultorio_id, huella)
);

-- La constancia: quién aceptó, qué texto, y cuándo. No se edita ni se borra desde la página. Solo tiene números internos y la
-- fecha, así que puede quedar aunque la persona pida la baja y se borren sus datos (por eso no está atada a la tabla miembros).
create table interno.consentimientos (
  id             uuid primary key default gen_random_uuid(),
  consultorio_id uuid not null references public.consultorios (id),
  miembro_id     uuid not null,
  usuario_id     uuid not null,
  version        integer not null references interno.privacidad (version),
  huella         text not null,
  aviso          boolean not null check (aviso),
  exterior       boolean not null check (exterior),        -- aceptó, aparte y de manera expresa, que los datos se guarden fuera del país
  en             timestamptz not null default now(),
  foreign key (consultorio_id, huella) references interno.privacidad_textos (consultorio_id, huella)
);
create index on interno.consentimientos (miembro_id, version);

insert into interno.privacidad (version, texto) values (1, $aviso$Este aviso explica qué datos tuyos se guardan cuando usás esta página, para qué, dónde, y qué podés pedir. Es la versión 1, del 25 de noviembre de 2026.

## Quién responde por tus datos
Tus datos forman parte de una base de datos de {responsable}{domicilio}, responsable de «{consultorio}». Para cualquier pedido sobre tus datos: {contacto}.
Entreturno es la empresa que hace y mantiene esta página. Trata los datos por cuenta del consultorio, solo para que la página funcione, y tiene que guardar secreto sobre ellos.

## Qué datos se guardan
- Los que cargás al pedir acceso: nombre y apellido, profesión, qué vas a hacer en el consultorio, mail, teléfono, CUIT y condición frente al IVA.
- Tu contraseña, guardada de una forma que nadie puede leer: ni el consultorio ni Entreturno.
- Lo que hacés en la página: tus reservas (box, día, horario, máquinas y lo que escribas sobre la atención), tus pagos, devoluciones, saldos y facturas, y qué versión del reglamento y de este aviso aceptaste.
- Datos técnicos, por seguridad: la dirección de internet y el navegador con que entrás.
- En tu aparato: tu sesión, para no pedirte la contraseña cada vez (se borra cuando cerrás sesión), y cómo dejaste la pantalla. Mientras no confirmás tu mail, también los datos de tu pedido de acceso, sin la contraseña: hasta 7 días en tu aparato, y en tu cuenta hasta que el pedido se manda.
Los datos de tu tarjeta no pasan por esta página: los cargás directamente en Mercado Pago.
No cargues datos de pacientes ni datos de salud: la página no está hecha para guardarlos.

## Para qué se usan
Para evaluar tu solicitud y contactarte; para que puedas reservar, pagar y cancelar; para mandarte por mail los avisos de tus turnos; para llevar la cuenta de los pagos y los saldos; para hacer tus facturas y cumplir con los impuestos; y para cuidar la seguridad de la página. No se usan para publicidad, no se venden y no se le dan a nadie fuera de quienes figuran acá.

## Si no querés dar algún dato
El nombre, la profesión, la categoría, el mail, la CUIT y la condición frente al IVA hacen falta: sin ellos no se puede pedir acceso ni facturar. El teléfono es optativo. Si un dato es falso o está mal, la solicitud puede rechazarse o la factura salir mal hecha.

## Quiénes los ven
- El consultorio.
- Entreturno, para mantener la página.
- Las empresas que la hacen funcionar: Supabase (la base de datos y las cuentas), Cloudflare (publica la página y cuenta las visitas) y Resend (manda los mails).
- Mercado Pago, cuando pagás (le llegan tu mail y el detalle del pago), y ARCA, por las facturas.
- Una autoridad, si los pide como manda la ley.
Las otras profesionales no ven tus datos: ven tu horario como «ocupado».

## Dónde se guardan
La base de datos está en servidores de San Pablo, Brasil, y algunos de esos servicios también procesan datos en Estados Unidos. Ninguno de los dos países está en la lista de los que la autoridad argentina considera con protección adecuada (Disposición DNPDP 60/2016 y Resolución AAIP 34/2019). Por eso hace falta que lo aceptes de manera expresa (artículo 12 de la Ley 25.326 y artículo 12 del Decreto 1558/2001). Si no lo aceptás, no podés usar la página, porque tus datos se guardan ahí: podés hablar con el consultorio para coordinar de otra forma.

## Por cuánto tiempo
Mientras uses la página. Si pedís la baja, el consultorio y Entreturno borran tus datos (lo hacen ellos: no es automático), salvo lo que la ley obligue a conservar, como las facturas y los pagos. También se conserva la constancia de que aceptaste este aviso: qué versión y cuándo.

## Qué podés pedir
Podés pedir ver tus datos, y que los corrijan, los actualicen o los borren. {pedidos} Verlos es gratis cada seis meses, o antes si tenés un motivo legítimo. Te tienen que contestar en 10 días corridos si pedís verlos, y en 5 días hábiles si pedís corregirlos o borrarlos (artículos 14 y 16 de la Ley 25.326). También podés retirar tu aceptación cuando quieras: desde ese momento no vas a poder seguir usando la página, y lo hecho hasta ahí sigue valiendo.
LA AGENCIA DE ACCESO A LA INFORMACIÓN PÚBLICA, en su carácter de Órgano de Control de la Ley N° 25.326, tiene la atribución de atender las denuncias y reclamos que interpongan quienes resulten afectados en sus derechos por incumplimiento de las normas vigentes en materia de protección de datos personales.

## Si este aviso cambia
Si cambia algo importante, la página te lo muestra y te pide que lo aceptes de nuevo. Queda guardado qué versión aceptaste y cuándo.$aviso$);

-- ---------------------------------------------------------------------------------------------------
-- El texto de cada consultorio y su huella
-- ---------------------------------------------------------------------------------------------------
create function interno.privacidad_version() returns integer
language sql stable security definer set search_path = public, pg_temp as $$
  select max(version) from interno.privacidad
$$;

-- Los datos del responsable: los que puso para esto o, si no, los de sus facturas y su nombre. Lo que se inserta va en un solo
-- renglón y sin llaves: así no puede agregar títulos ni completar otros casilleros de la plantilla.
create function interno.privacidad_dato(p_valor text) returns text
language sql immutable set search_path = public, pg_temp as $$
  select nullif(btrim(regexp_replace(translate(coalesce(p_valor, ''), '{}', '()'), '\s+', ' ', 'g')), '')
$$;

create function interno.privacidad_texto(c public.consultorios) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select replace(replace(replace(replace(replace(p.texto,
           '{responsable}', coalesce(interno.privacidad_dato(c.priv_responsable), interno.privacidad_dato(c.fact_nombre), interno.privacidad_dato(c.duena), '')),
           '{domicilio}', coalesce(', con domicilio en ' || coalesce(interno.privacidad_dato(c.priv_domicilio), interno.privacidad_dato(c.fact_domicilio)), '')),
           '{consultorio}', coalesce(interno.privacidad_dato(c.nombre), '')),
           '{contacto}', coalesce(interno.privacidad_dato(c.priv_contacto), 'hablá con ' || coalesce(interno.privacidad_dato(c.duena), 'el consultorio'))),
           '{pedidos}', case when c.priv_contacto <> '' then 'Escribí a ' || interno.privacidad_dato(c.priv_contacto) || '.'
                             else 'Hablá con ' || coalesce(interno.privacidad_dato(c.duena), 'el consultorio') || '.' end)
    from interno.privacidad p where p.version = interno.privacidad_version()
$$;

create function interno.privacidad_huella(p_texto text) returns text
language sql immutable set search_path = public, pg_temp as $$
  select left(encode(sha256(convert_to(p_texto, 'UTF8')), 'hex'), 32)
$$;

-- ¿Esta persona ya aceptó la versión que está vigente? (la dueña no: es la responsable)
create function interno.privacidad_ok(m public.miembros) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select m.rol = 'admin'
      or exists (select 1 from interno.consentimientos k where k.miembro_id = m.id and k.version >= interno.privacidad_version())
$$;

-- Deja anotada la aceptación. Solo vale si la huella es la del texto vigente y si aceptó las dos cosas.
create function interno.privacidad_anotar(c public.consultorios, p_miembro uuid, p_huella text, p_exterior boolean) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_texto text;
  v_huella text;
begin
  if coalesce(p_huella, '') = '' then raise exception 'privacidad_falta'; end if;
  if p_exterior is not true then raise exception 'privacidad_exterior'; end if;
  v_texto := interno.privacidad_texto(c);
  v_huella := interno.privacidad_huella(v_texto);
  if p_huella <> v_huella then raise exception 'privacidad_cambio'; end if;
  insert into interno.privacidad_textos (huella, version, consultorio_id, texto)
  values (v_huella, interno.privacidad_version(), c.id, v_texto)
  on conflict (consultorio_id, huella) do nothing;
  insert into interno.consentimientos (consultorio_id, miembro_id, usuario_id, version, huella, aviso, exterior)
  values (c.id, p_miembro, auth.uid(), interno.privacidad_version(), v_huella, true, true);
end $$;

-- ---------------------------------------------------------------------------------------------------
-- Lo que se le manda a la página
-- ---------------------------------------------------------------------------------------------------
create or replace function interno.j_sitio(c public.consultorios) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('slug', c.slug, 'name', c.nombre, 'owner', c.duena, 'letters', c.letras, 'payments', c.pagos_modo,
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
                                 'totalBefore', c.pol_total_antes, 'totalAfter', c.pol_total_despues),
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

-- De cada persona, qué versión del aviso aceptó y cuándo (la dueña ve la de todas; cada profesional, la suya)
create or replace function interno.j_miembros(p_consultorio uuid, p_solo uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', m.id, 'role', m.rol, 'name', m.nombre, 'profession', m.profesion, 'category', m.categoria_id, 'cuit', m.cuit,
           'ivaCond', m.condicion_iva, 'email', m.email, 'phone', m.telefono, 'status', m.estado, 'since', interno.ms(m.desde),
           'privacy', (select jsonb_build_object('version', k.version, 'at', interno.ms(k.en))
                         from interno.consentimientos k where k.miembro_id = m.id order by k.version desc, k.en limit 1))
         order by m.desde, m.id), '[]'::jsonb)
    from public.miembros m where m.consultorio_id = p_consultorio and (p_solo is null or m.id = p_solo)
$$;

-- ---------------------------------------------------------------------------------------------------
-- Reservar pide, además de estar aprobada, haber aceptado el aviso vigente (la usa solo «reservar»)
-- ---------------------------------------------------------------------------------------------------
create or replace function interno.aprobada(p_consultorio uuid) returns public.miembros
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  m public.miembros;
begin
  m := interno.yo(p_consultorio);
  if m.id is null or m.rol <> 'pro' or m.estado <> 'aprobado' then raise exception 'no_aprobada'; end if;
  if not interno.privacidad_ok(m) then raise exception 'privacidad_falta'; end if;
  return m;
end $$;

-- ---------------------------------------------------------------------------------------------------
-- Pedir acceso: ahora con el aviso aceptado
-- ---------------------------------------------------------------------------------------------------
drop function public.pedir_acceso(text, text, text, uuid, text, text, integer);

create function public.pedir_acceso(p_slug text, p_nombre text, p_profesion text, p_categoria uuid, p_telefono text, p_cuit text,
                                    p_condicion_iva integer default null, p_privacidad text default null, p_exterior boolean default null)
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
  perform interno.privacidad_anotar(c, v_id, p_privacidad, p_exterior);       -- si falta o cambió, no queda nada guardado

  perform interno.avisar(v_id, 'Recibimos tu solicitud',
    'Hola ' || interno.primer_nombre(v_nombre) || ':' || nl || nl || 'Recibimos tu solicitud para alquilar boxes. ' || c.duena
    || ' te va a contactar para coordinar una entrevista.' || nl || nl || c.nombre);
  perform interno.avisar_admin(c.id, 'Nueva solicitud de acceso: ' || v_nombre,
    v_nombre || ' (' || v_profesion || ', categoría ' || k.nombre || ') pidió acceso para alquilar boxes.' || nl
    || 'Teléfono: ' || case when v_telefono = '' then '—' else v_telefono end || nl || 'Mail: ' || coalesce(v_email, '') || nl || nl
    || 'Coordiná la entrevista y después aprobala desde el panel.');
  return jsonb_build_object('id', v_id, 'status', 'pendiente');
end $$;

-- Quien ya tenía cuenta (o cuando hay una versión nueva) lo acepta desde la página
create function public.aceptar_privacidad(p_slug text, p_privacidad text, p_exterior boolean) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c public.consultorios;
  m public.miembros;
begin
  c := interno.consultorio(p_slug);
  m := interno.yo(c.id);
  if m.id is null then raise exception 'solo_miembros'; end if;
  if not interno.privacidad_ok(m) then perform interno.privacidad_anotar(c, m.id, p_privacidad, p_exterior); end if;
  return jsonb_build_object('ok', true);
end $$;

-- La dueña completa quién es la responsable, su domicilio y el mail para los pedidos
create function public.guardar_privacidad(p_slug text, p_responsable text, p_domicilio text, p_contacto text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c public.consultorios;
begin
  c := interno.consultorio(p_slug);
  perform interno.admin(c.id);
  c := interno.candado(c.id);
  begin
    update public.consultorios                                                -- en un solo renglón: van adentro del aviso
       set priv_responsable = interno.texto(regexp_replace(coalesce(p_responsable, ''), '\s+', ' ', 'g'), 120),
           priv_domicilio = interno.texto(regexp_replace(coalesce(p_domicilio, ''), '\s+', ' ', 'g'), 160),
           priv_contacto = lower(interno.texto(p_contacto, 254))
     where id = c.id;
  exception when check_violation then
    raise exception 'dato_invalido';
  end;
  return jsonb_build_object('ok', true);
end $$;

-- ===================================================================================================
-- Candado y permisos
-- ===================================================================================================
alter table interno.privacidad enable row level security;
alter table interno.privacidad_textos enable row level security;
alter table interno.consentimientos enable row level security;
revoke all on table interno.privacidad, interno.privacidad_textos, interno.consentimientos from public, anon, authenticated;

do $$
declare
  f record;
  v_sin_sesion constant text[] := array['portada'];
  v_con_sesion constant text[] := array['pedir_acceso', 'aceptar_privacidad', 'guardar_privacidad'];
begin
  for f in
    select p.oid::regprocedure::text as firma, n.nspname as esquema, p.proname as nombre
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where (n.nspname = 'interno' and (p.proname like 'privacidad%' or p.proname in ('j_sitio', 'j_config', 'j_miembros', 'aprobada')))
        or (n.nspname = 'public' and p.proname = any (v_con_sesion))
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.firma);
    if f.esquema = 'public' then
      execute format('grant execute on function %s to authenticated', f.firma);
      if f.nombre = any (v_sin_sesion) then execute format('grant execute on function %s to anon', f.firma); end if;
    end if;
  end loop;
end $$;
