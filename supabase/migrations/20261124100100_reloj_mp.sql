-- =====================================================================================================
-- Entreturno · Boxes — el reloj de Mercado Pago
-- =====================================================================================================
-- Cada minuto, la base mira si hay algo de Mercado Pago para hacer sin que nadie lo pida (un pago cuyo aviso no
-- llegó, una devolución que espera, una orden vieja para cerrar, un pase por vencer). Si hay, despierta a la función
-- de Supabase «mp», que es la que habla con Mercado Pago. Si no hay nada, no llama a nadie.
--
-- Este archivo se aplica solo en el proyecto real de Supabase, DESPUÉS de …_mercadopago.sql y de subir la función
-- «mp» (usa pg_cron, que las pruebas en la compu no tienen). Se puede volver a correr sin problema.
-- =====================================================================================================

-- La dirección de la función (la del proyecto real; el nombre del proyecto es público: está en web\config.js)
insert into interno.ajustes (clave, valor)
values ('funcion_mp_url', 'https://mgnzmjeyhzxzlyrgxotp.supabase.co/functions/v1/mp')
on conflict (clave) do update set valor = excluded.valor;

-- La clave con la que el reloj le habla a la función: se inventa acá, vive cifrada en el Vault y no sale de la base
-- (la función le pregunta a la base si la que recibió es esa). Si ya existe, se deja la que está.
do $$
begin
  if not exists (select 1 from vault.decrypted_secrets where name = 'mp_clave_reloj') then
    perform vault.create_secret(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 'mp_clave_reloj',
                                'Entreturno · clave del reloj de Mercado Pago');
  end if;
end $$;

select cron.schedule('entreturno-boxes-mp', '* * * * *', $$select interno.mp_reloj()$$);
