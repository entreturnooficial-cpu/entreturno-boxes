-- Las tablas de cuentas como las tiene el Supabase de verdad (leídas del proyecto real el 25/11/2026), para que el ensayo de
-- restauración sea fiel: mismas columnas, mismos tipos, las que se calculan solas y las que no pueden quedar vacías.
alter table auth.users
  add column instance_id uuid, add column aud varchar(255), add column role varchar(255), add column encrypted_password varchar(255),
  add column email_confirmed_at timestamptz, add column invited_at timestamptz, add column confirmation_token varchar(255),
  add column confirmation_sent_at timestamptz, add column recovery_token varchar(255), add column recovery_sent_at timestamptz,
  add column email_change_token_new varchar(255), add column email_change varchar(255), add column email_change_sent_at timestamptz,
  add column last_sign_in_at timestamptz, add column raw_app_meta_data jsonb, add column is_super_admin boolean, add column updated_at timestamptz,
  add column phone text default null::varchar, add column phone_confirmed_at timestamptz, add column phone_change text default ''::varchar,
  add column phone_change_token varchar(255) default ''::varchar, add column phone_change_sent_at timestamptz,
  add column confirmed_at timestamptz generated always as (least(email_confirmed_at, phone_confirmed_at)) stored,
  add column email_change_token_current varchar(255) default ''::varchar, add column email_change_confirm_status smallint default 0,
  add column banned_until timestamptz, add column reauthentication_token varchar(255) default ''::varchar, add column reauthentication_sent_at timestamptz,
  add column is_sso_user boolean not null default false, add column deleted_at timestamptz, add column is_anonymous boolean not null default false;
alter table auth.users alter column raw_user_meta_data drop not null, alter column raw_user_meta_data drop default, alter column created_at drop not null;
create table auth.identities (
  provider_id text not null, user_id uuid not null references auth.users (id) on delete cascade, identity_data jsonb not null, provider text not null,
  last_sign_in_at timestamptz, created_at timestamptz, updated_at timestamptz,
  email text generated always as (lower(identity_data ->> 'email')) stored, id uuid primary key default gen_random_uuid(),
  unique (provider_id, provider)
);
