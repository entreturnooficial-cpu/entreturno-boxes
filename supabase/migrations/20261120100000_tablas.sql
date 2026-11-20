-- =====================================================================================================
-- Entreturno · Boxes — 1 de 2: las tablas
-- =====================================================================================================
-- Un solo sistema para todos los consultorios: cada fila lleva su consultorio_id.
--
-- Seguridad, en dos candados:
--   1) Todas las tablas tienen RLS activado y NINGUNA política: desde la página no se puede leer ni
--      escribir una tabla directo. Además se les quitan los permisos a los roles de la página.
--   2) La página solo llama funciones de "public" (archivo 2 de 2), que revisan quién llama y a qué
--      consultorio pertenece. Los ayudantes viven en el esquema "interno", que la API no publica.
--
-- La plata va en pesos enteros (sin centavos). Las horas son enteras (8 = las 8, 20 = las 20).
-- Los días de la semana: 0 domingo … 6 sábado.
-- =====================================================================================================

create extension if not exists btree_gist with schema extensions;

create schema if not exists interno;
revoke all on schema interno from public;

-- ---------------------------------------------------------------------------------------------------
-- El consultorio y su configuración
-- ---------------------------------------------------------------------------------------------------
create table public.consultorios (
  id                 uuid primary key default gen_random_uuid(),
  slug               text not null unique check (slug ~ '^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$'),  -- yanina → yanina.entreturno.com.ar
  nombre             text not null check (char_length(btrim(nombre)) between 1 and 80),             -- «Consultorio Yani»
  duena              text not null check (char_length(btrim(duena)) between 1 and 40),              -- «Yani»: cómo la nombran los textos
  letras             text not null default '' check (char_length(letras) <= 2),                     -- monograma: «YO»
  zona               text not null default 'America/Argentina/Buenos_Aires',
  activo             boolean not null default true,
  -- turnos y horarios
  abre               integer not null default 8,
  cierra             integer not null default 20,
  dias               integer[] not null default '{1,2,3,4,5,6}',
  turno_horas        integer not null default 4,
  semanas_adelante   integer not null default 8 check (semanas_adelante between 1 and 52),          -- hasta cuándo se puede reservar
  -- seña y pago
  sena_pct           integer not null default 50 check (sena_pct between 1 and 100),
  minutos_pago       integer not null default 15 check (minutos_pago between 5 and 180),
  max_sin_pagar      integer not null default 3 check (max_sin_pagar between 1 and 20),             -- reservas sin pagar a la vez, por profesional
  max_saldos         integer default 2 check (max_saldos is null or max_saldos between 1 and 20),   -- turnos señados sin terminar de pagar que puede tener cada profesional (vacío = sin tope)
  pagos_modo         text not null default 'simulado' check (pagos_modo in ('simulado', 'mercadopago')),
  -- política de cancelación: qué porcentaje de lo pagado se devuelve
  pol_dias           integer not null default 7 check (pol_dias between 0 and 60),
  pol_sena_antes     integer not null default 100 check (pol_sena_antes between 0 and 100),
  pol_sena_despues   integer not null default 0 check (pol_sena_despues between 0 and 100),
  pol_total_antes    integer not null default 100 check (pol_total_antes between 0 and 100),
  pol_total_despues  integer not null default 50 check (pol_total_despues between 0 and 100),
  -- reglamento de uso: cada reserva guarda la versión que aceptó
  reglamento         text not null default '' check (char_length(reglamento) <= 8000),
  reglamento_version integer not null default 1,
  -- datos para facturar
  fact_nombre        text not null default '' check (char_length(fact_nombre) <= 120),
  fact_cuit          text not null default '' check (fact_cuit ~ '^[0-9-]{0,13}$'),
  fact_condicion     text not null default 'Monotributo' check (fact_condicion in ('Monotributo', 'Responsable inscripta')),
  fact_punto_venta   integer not null default 1 check (fact_punto_venta between 1 and 9998),
  creado_en          timestamptz not null default now(),
  constraint horario_valido check (abre >= 0 and cierra <= 24 and cierra > abre
                                   and turno_horas between 1 and 12 and (cierra - abre) % turno_horas = 0),
  constraint dias_validos check (dias <@ '{0,1,2,3,4,5,6}'::integer[])
);

-- Cada versión del reglamento queda guardada, para poder mostrar qué texto aceptó cada reserva
create table public.reglamentos (
  consultorio_id uuid not null references public.consultorios (id),
  version        integer not null,
  texto          text not null,
  desde          timestamptz not null default now(),
  primary key (consultorio_id, version)
);

create function interno.guardar_reglamento_inicial() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.reglamentos (consultorio_id, version, texto) values (new.id, new.reglamento_version, new.reglamento);
  return new;
end $$;

create trigger consultorio_nuevo_guarda_reglamento after insert on public.consultorios
  for each row execute function interno.guardar_reglamento_inicial();

-- ---------------------------------------------------------------------------------------------------
-- Categorías: cada profesional paga el precio por hora de la suya
-- ---------------------------------------------------------------------------------------------------
create table public.categorias (
  id             uuid primary key default gen_random_uuid(),
  consultorio_id uuid not null references public.consultorios (id),
  nombre         text not null check (char_length(btrim(nombre)) between 1 and 60),
  nota           text not null default '' check (char_length(nota) <= 200),
  precio_hora    integer not null check (precio_hora between 0 and 10000000),
  activa         boolean not null default true,           -- «quitar» una categoría la apaga: las reservas viejas la siguen nombrando
  orden          integer not null default 0,
  creada_en      timestamptz not null default now(),
  unique (id, consultorio_id)
);
create index on public.categorias (consultorio_id);

-- ---------------------------------------------------------------------------------------------------
-- Boxes y su precio propio por categoría (vacío = el general de la categoría)
-- ---------------------------------------------------------------------------------------------------
create table public.boxes (
  id             uuid primary key default gen_random_uuid(),
  consultorio_id uuid not null references public.consultorios (id),
  numero         integer not null check (numero between 1 and 99),     -- el número con que la página nombra al box
  nombre         text not null check (char_length(btrim(nombre)) between 1 and 60),
  resumen        text not null default '' check (char_length(resumen) <= 120),
  equipamiento   text[] not null default '{}' check (cardinality(equipamiento) <= 30),
  foto           text check (foto is null or (foto ~ '^https://' and char_length(foto) <= 500)),
  activo         boolean not null default true,
  unique (consultorio_id, numero),
  unique (id, consultorio_id)
);

create table public.box_precios (
  box_id         uuid not null,
  categoria_id   uuid not null,
  consultorio_id uuid not null,
  precio_hora    integer not null check (precio_hora between 0 and 10000000),
  primary key (box_id, categoria_id),
  foreign key (box_id, consultorio_id) references public.boxes (id, consultorio_id) on delete cascade,
  foreign key (categoria_id, consultorio_id) references public.categorias (id, consultorio_id) on delete cascade
);

-- ---------------------------------------------------------------------------------------------------
-- Máquinas: se alquilan por hora, aparte del box, y no pueden estar en dos reservas a la vez
-- ---------------------------------------------------------------------------------------------------
create table public.maquinas (
  id             uuid primary key default gen_random_uuid(),
  consultorio_id uuid not null references public.consultorios (id),
  nombre         text not null check (char_length(btrim(nombre)) between 1 and 80),
  resumen        text not null default '' check (char_length(resumen) <= 200),
  precio_hora    integer not null check (precio_hora between 0 and 10000000),
  activa         boolean not null default true,           -- disponible para alquilar
  quitada        boolean not null default false,          -- «quitar» la esconde: las reservas que ya la tenían no cambian
  foto           text check (foto is null or (foto ~ '^https://' and char_length(foto) <= 500)),
  creada_en      timestamptz not null default now(),
  unique (id, consultorio_id)
);
create index on public.maquinas (consultorio_id);

-- ---------------------------------------------------------------------------------------------------
-- Miembros: la dueña (admin) y las profesionales (pro) de cada consultorio.
-- Una misma cuenta puede ser miembro de más de un consultorio.
-- ---------------------------------------------------------------------------------------------------
create table public.miembros (
  id             uuid primary key default gen_random_uuid(),
  consultorio_id uuid not null references public.consultorios (id),
  usuario_id     uuid not null references auth.users (id),
  rol            text not null default 'pro' check (rol in ('admin', 'pro')),
  estado         text not null default 'pendiente' check (estado in ('pendiente', 'aprobado', 'rechazado', 'bloqueado')),
  nombre         text not null check (char_length(btrim(nombre)) between 1 and 80),
  profesion      text not null default '' check (char_length(profesion) <= 80),
  categoria_id   uuid,
  cuit           text not null default '' check (cuit ~ '^[0-9-]{0,13}$'),
  email          text not null default '' check (char_length(email) <= 254),
  telefono       text not null default '' check (char_length(telefono) <= 40),
  desde          timestamptz not null default now(),
  unique (consultorio_id, usuario_id),
  unique (id, consultorio_id),
  foreign key (categoria_id, consultorio_id) references public.categorias (id, consultorio_id),
  constraint pro_con_categoria check (rol = 'admin' or categoria_id is not null)
);
create index on public.miembros (usuario_id);

-- ---------------------------------------------------------------------------------------------------
-- Bloqueos (horarios que usa la dueña) y ratos libres (un pedazo de un bloqueo que ella publica)
-- ---------------------------------------------------------------------------------------------------
create table public.bloqueos (
  id             uuid primary key default gen_random_uuid(),
  consultorio_id uuid not null references public.consultorios (id),
  recurrente     boolean not null,                        -- true: todas las semanas, el mismo día
  dia_semana     integer,
  fecha          date,
  desde          integer not null,
  hasta          integer not null,
  nota           text not null default '' check (char_length(nota) <= 120),
  creado_en      timestamptz not null default now(),
  unique (id, consultorio_id),
  constraint horas_validas check (desde >= 0 and hasta <= 24 and hasta > desde),
  constraint un_dia_o_todas_las_semanas check ((recurrente and dia_semana between 0 and 6 and fecha is null)
                                               or (not recurrente and fecha is not null and dia_semana is null))
);
create index on public.bloqueos (consultorio_id);

create table public.bloqueo_boxes (
  bloqueo_id     uuid not null,
  box_id         uuid not null,
  consultorio_id uuid not null,
  primary key (bloqueo_id, box_id),
  foreign key (bloqueo_id, consultorio_id) references public.bloqueos (id, consultorio_id) on delete cascade,
  foreign key (box_id, consultorio_id) references public.boxes (id, consultorio_id) on delete cascade
);
create index on public.bloqueo_boxes (box_id);

create table public.ratos_libres (
  id             uuid primary key default gen_random_uuid(),
  consultorio_id uuid not null references public.consultorios (id),
  box_id         uuid not null,
  fecha          date not null,
  desde          integer not null,
  hasta          integer not null,
  creado_en      timestamptz not null default now(),
  foreign key (box_id, consultorio_id) references public.boxes (id, consultorio_id) on delete cascade,
  constraint horas_validas check (desde >= 0 and hasta <= 24 and hasta > desde),
  -- dos ratos libres del mismo box no se pisan
  constraint ratos_no_se_pisan exclude using gist (box_id with =, fecha with =, int4range(desde, hasta) with &&)
);
create index on public.ratos_libres (consultorio_id, fecha);

-- ---------------------------------------------------------------------------------------------------
-- Reservas. Estados: pago (falta pagar, con vencimiento) → confirmada → cumplida; o cancelada.
-- La base misma impide que dos reservas vivas se pisen en un box (y que una máquina esté en dos).
-- ---------------------------------------------------------------------------------------------------
create table public.reservas (
  id                 uuid primary key default gen_random_uuid(),
  consultorio_id     uuid not null references public.consultorios (id),
  miembro_id         uuid not null,
  box_id             uuid not null,
  fecha              date not null,
  desde              integer not null,
  hasta              integer not null,
  servicio           text not null default '' check (char_length(servicio) <= 120),   -- qué va a atender: solo lo ve la dueña
  categoria_id       uuid,
  categoria_nombre   text not null default '',            -- como se llamaba la categoría al reservar
  precio_hora        integer not null check (precio_hora >= 0),
  monto_box          integer not null check (monto_box >= 0),
  total              integer not null check (total >= 0),
  monto_sena         integer not null check (monto_sena >= 0),   -- la seña que se le informó al reservar: no cambia aunque cambie el porcentaje
  plan               text not null check (plan in ('sena', 'total')),
  estado             text not null default 'pago' check (estado in ('pago', 'confirmada', 'cumplida', 'cancelada')),
  reglamento_version integer not null,
  creada_en          timestamptz not null default now(),
  vence_en           timestamptz,                          -- hasta cuándo se guarda el turno sin pagar
  cancelada_en       timestamptz,
  cancelada_por      text check (cancelada_por in ('pro', 'admin', 'vencida')),
  devolucion_monto   integer check (devolucion_monto >= 0),
  devolucion_pct     integer check (devolucion_pct between 0 and 100),
  recordada          boolean not null default false,
  unique (id, consultorio_id),
  foreign key (miembro_id, consultorio_id) references public.miembros (id, consultorio_id),
  foreign key (box_id, consultorio_id) references public.boxes (id, consultorio_id),
  constraint horas_validas check (desde >= 0 and hasta <= 24 and hasta > desde),
  constraint sena_hasta_el_total check (monto_sena <= total),
  constraint cancelada_completa check ((estado = 'cancelada') = (cancelada_en is not null and cancelada_por is not null)),
  constraint reservas_no_se_pisan exclude using gist (box_id with =, fecha with =, int4range(desde, hasta) with &&)
    where (estado <> 'cancelada')
);
create index on public.reservas (consultorio_id, fecha);
create index on public.reservas (miembro_id);
create index on public.reservas (consultorio_id, estado) where estado in ('pago', 'confirmada');

create table public.reserva_maquinas (
  reserva_id     uuid not null,
  maquina_id     uuid not null,
  consultorio_id uuid not null,
  nombre         text not null,                           -- como se llamaba la máquina al reservar
  horas          integer not null check (horas > 0),
  precio_hora    integer not null check (precio_hora >= 0),
  monto          integer not null check (monto >= 0),
  fecha          date not null,
  desde          integer not null,
  hasta          integer not null,
  activa         boolean not null default true,           -- se apaga cuando la reserva se cancela
  primary key (reserva_id, maquina_id),
  foreign key (reserva_id, consultorio_id) references public.reservas (id, consultorio_id) on delete cascade,
  foreign key (maquina_id, consultorio_id) references public.maquinas (id, consultorio_id),
  constraint maquina_no_se_pisa exclude using gist (maquina_id with =, fecha with =, int4range(desde, hasta) with &&)
    where (activa)
);

-- ---------------------------------------------------------------------------------------------------
-- Pagos y devoluciones de cada reserva
-- ---------------------------------------------------------------------------------------------------
create table public.pagos (
  id             uuid primary key default gen_random_uuid(),
  consultorio_id uuid not null references public.consultorios (id),
  reserva_id     uuid not null,
  tipo           text not null check (tipo in ('sena', 'total', 'saldo', 'devolucion')),
  monto          integer not null check (monto > 0),
  estado         text not null default 'pendiente' check (estado in ('pendiente', 'aprobado', 'rechazado', 'vencido')),
  proveedor      text not null default 'simulado' check (proveedor in ('simulado', 'mercadopago')),
  proveedor_id   text,                                     -- el número del pago o de la orden en Mercado Pago
  datos          jsonb not null default '{}',
  creado_en      timestamptz not null default now(),
  aprobado_en    timestamptz,
  foreign key (reserva_id, consultorio_id) references public.reservas (id, consultorio_id)
);
create index on public.pagos (reserva_id);
create index on public.pagos (consultorio_id, creado_en);
create unique index pagos_proveedor_id_unico on public.pagos (proveedor, proveedor_id) where proveedor_id is not null;

-- ---------------------------------------------------------------------------------------------------
-- Facturas del mes (se emiten con ARCA: etapa 3; la tabla ya queda lista)
-- ---------------------------------------------------------------------------------------------------
create table public.facturas (
  id             uuid primary key default gen_random_uuid(),
  consultorio_id uuid not null references public.consultorios (id),
  miembro_id     uuid not null,
  periodo        text not null check (periodo ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  letra          text not null check (letra in ('A', 'B', 'C')),
  punto_venta    integer not null,
  numero         integer not null,
  cae            text not null,
  cae_vence      date,
  horas          integer not null,
  total          integer not null,
  lineas         jsonb not null default '[]',
  emitida_en     timestamptz not null default now(),
  foreign key (miembro_id, consultorio_id) references public.miembros (id, consultorio_id),
  unique (consultorio_id, miembro_id, periodo),
  unique (consultorio_id, letra, punto_venta, numero)
);

-- ---------------------------------------------------------------------------------------------------
-- Avisos: la cola de mails que el sistema tiene que mandar (el envío se conecta después)
-- ---------------------------------------------------------------------------------------------------
create table public.avisos (
  id             uuid primary key default gen_random_uuid(),
  consultorio_id uuid not null references public.consultorios (id),
  miembro_id     uuid,                                     -- a quién va
  para           text not null default '',                 -- su mail en ese momento
  asunto         text not null,
  cuerpo         text not null,
  estado         text not null default 'pendiente' check (estado in ('pendiente', 'enviado', 'error')),
  intentos       integer not null default 0,
  error          text,
  creado_en      timestamptz not null default now(),
  enviado_en     timestamptz,
  foreign key (miembro_id, consultorio_id) references public.miembros (id, consultorio_id)
);
create index on public.avisos (estado, creado_en);

-- ---------------------------------------------------------------------------------------------------
-- Candado: RLS activado sin políticas y sin permisos para los roles de la página
-- ---------------------------------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['consultorios', 'reglamentos', 'categorias', 'boxes', 'box_precios', 'maquinas', 'miembros', 'bloqueos',
                           'bloqueo_boxes', 'ratos_libres', 'reservas', 'reserva_maquinas', 'pagos', 'facturas', 'avisos']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
  end loop;
end $$;
