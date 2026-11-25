-- =====================================================================================================
-- Entreturno · Boxes — el reloj que vigila la copia de seguridad
-- =====================================================================================================
-- Una vez por hora mira si hace más de 30 horas que GitHub no confirma una copia guardada. Si es así, manda un mail a
-- Entreturno (uno por día). Cuenta desde que se carga este archivo: por eso se carga cuando la copia ya está andando.
--
-- Este archivo se aplica solo en el proyecto real de Supabase, DESPUÉS de …_copia.sql (usa pg_cron, que las pruebas en la
-- compu no tienen). Se puede volver a correr sin problema.
-- =====================================================================================================

insert into interno.ajustes (clave, valor) values ('mail_soporte', 'entreturnooficial@gmail.com')
on conflict (clave) do update set valor = excluded.valor;
insert into interno.ajustes (clave, valor) values ('copia_desde', now()::text) on conflict (clave) do nothing;

select cron.schedule('entreturno-boxes-copia', '47 * * * *', $$select interno.copias_vigilar()$$);
