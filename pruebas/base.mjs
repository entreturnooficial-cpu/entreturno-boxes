// La base de datos de prueba: un Postgres que corre adentro de Node (PGlite), preparado como lo deja Supabase
// (roles anon / authenticated / service_role, auth.users, auth.uid()) y con las migraciones cargadas tal cual.
// Lo usan las pruebas de la base (pruebas/sql) y el servidor de prueba (pruebas/servidor-local.mjs).

import { readFileSync } from 'node:fs';

import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';

const CARPETA_MIGRACIONES = new URL('../supabase/migrations/', import.meta.url);
/** El archivo del reloj (pg_cron) no va acá: solo existe en el proyecto real. */
export const MIGRACIONES = ['20261120100000_tablas.sql', '20261120100100_funciones.sql', '20261120100300_mails.sql',
  '20261123100000_facturas_arca.sql', '20261124100000_mercadopago.sql', '20261125100000_recordatorio.sql'];
export const ZONA = 'America/Argentina/Buenos_Aires';

/** Dueño de tablas y funciones (en Supabase es `postgres`, que NO es superusuario). */
export const DUENO = 'dueno';

// Lo que Supabase ya trae antes de las migraciones.
const PREPARAR_SUPABASE = `
  create role anon nologin noinherit;
  create role authenticated nologin noinherit;
  create role service_role nologin noinherit bypassrls;
  create role supabase_auth_admin nologin noinherit;
  create role ${DUENO} nologin noinherit;

  create schema extensions;
  create extension btree_gist with schema extensions;
  grant usage on schema extensions to public;

  create schema auth;
  create table auth.users (
    id uuid primary key default gen_random_uuid(),
    email text,
    raw_user_meta_data jsonb not null default '{}',
    created_at timestamptz not null default now()
  );
  create function auth.uid() returns uuid language sql stable as $$
    select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid
  $$;
  grant usage on schema auth to anon, authenticated, service_role, supabase_auth_admin, ${DUENO};
  grant execute on function auth.uid() to anon, authenticated, service_role, ${DUENO};
  grant all on auth.users to supabase_auth_admin;
  grant select, references, trigger on auth.users to ${DUENO};

  -- pg_net simulado: guarda cada pedido para poder mirarlo. Las pruebas cargan en _http_response lo que «contestó» el servicio.
  create schema net;
  create table net.llamadas (id bigserial primary key, url text, body jsonb, params jsonb, headers jsonb, timeout_milliseconds int);
  create function net.http_post(url text, body jsonb default '{}'::jsonb, params jsonb default '{}'::jsonb,
                                headers jsonb default '{"Content-Type": "application/json"}'::jsonb, timeout_milliseconds int default 5000)
  returns bigint language sql security definer as $$
    insert into net.llamadas (url, body, params, headers, timeout_milliseconds) values (url, body, params, headers, timeout_milliseconds) returning id
  $$;
  create table net._http_response (id bigint, status_code int, content_type text, headers jsonb, content text, timed_out bool, error_msg text,
                                   created timestamptz not null default now());
  grant usage on schema net to ${DUENO};
  grant execute on function net.http_post(text, jsonb, jsonb, jsonb, int) to ${DUENO};
  grant select on net._http_response to ${DUENO};
  -- El Vault simulado: donde se guardan la clave del servicio de mails y los pases de Mercado Pago de cada consultorio.
  -- Tiene lo que se usa del de Supabase: la vista decrypted_secrets y las funciones create_secret y update_secret.
  create schema vault;
  create table vault.secrets (id uuid primary key default gen_random_uuid(), name text unique, description text not null default '',
                              secret text not null);
  create view vault.decrypted_secrets as select id, name, description, secret as decrypted_secret from vault.secrets;
  create function vault.create_secret(new_secret text, new_name text default null, new_description text default '') returns uuid
  language sql security definer as $$
    insert into vault.secrets (secret, name, description) values (new_secret, new_name, new_description) returning id
  $$;
  create function vault.update_secret(secret_id uuid, new_secret text default null, new_name text default null,
                                      new_description text default null) returns void
  language sql security definer as $$
    update vault.secrets set secret = coalesce(new_secret, secret), name = coalesce(new_name, name),
                             description = coalesce(new_description, description)
     where id = secret_id
  $$;
  grant usage on schema vault to ${DUENO};
  grant select on vault.decrypted_secrets to ${DUENO};
  grant select, delete on vault.secrets to ${DUENO};
  grant execute on function vault.create_secret(text, text, text), vault.update_secret(uuid, text, text, text) to ${DUENO};

  -- Privilegios por defecto de Supabase: todo lo nuevo en public queda abierto para la API.
  do $$ begin execute format('grant create on database %I to ${DUENO}', current_database()); end $$;
  grant usage, create on schema public to ${DUENO};
  grant usage on schema public to anon, authenticated, service_role;
  alter default privileges for role ${DUENO} in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges for role ${DUENO} in schema public grant all on sequences to anon, authenticated, service_role;
  alter default privileges for role ${DUENO} in schema public grant all on functions to anon, authenticated, service_role;
`;

/** Texto de una migración sin las líneas "create extension" (acá la extensión ya está cargada). */
export function leerMigracion(nombre) {
  return readFileSync(new URL(nombre, CARPETA_MIGRACIONES), 'utf8')
    .split('\n')
    .filter((linea) => !/^\s*create\s+extension\b/i.test(linea))
    .join('\n');
}

/** Base nueva, ya migrada. */
export async function armarBase(migraciones = MIGRACIONES) {
  const pg = await PGlite.create({ extensions: { btree_gist } });
  await pg.exec(PREPARAR_SUPABASE);
  await pg.exec(`set role ${DUENO}`);
  for (const nombre of migraciones) {
    try {
      await pg.exec(leerMigracion(nombre));
    } catch (e) {
      throw new Error(`Falló la migración ${nombre}: ${e.message}${e.where ? `\n${e.where}` : ''}`);
    }
  }
  await pg.exec('reset role');
  return pg;
}

/** Corre fn con un rol y los datos de sesión, dentro de una transacción (como hace la API de Supabase). */
export function comoRol(pg, rol, sub, fn) {
  return pg.transaction(async (tx) => {
    const claims = JSON.stringify(sub ? { sub, role: rol } : { role: rol });
    await tx.query(
      `select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claim.role', $2, true),
              set_config('request.jwt.claims', $3, true)`,
      [sub ?? '', rol, claims],
    );
    await tx.exec(`set local role ${rol}`);
    return fn(tx);
  });
}

/** Crea la cuenta como lo hace Supabase Auth. Devuelve el id de la cuenta. */
export function crearCuenta(pg, email) {
  return pg.transaction(async (tx) => {
    await tx.exec('set local role supabase_auth_admin; set local search_path = auth');
    const r = await tx.query('insert into auth.users (email) values ($1) returning id', [email]);
    return r.rows[0].id;
  });
}
