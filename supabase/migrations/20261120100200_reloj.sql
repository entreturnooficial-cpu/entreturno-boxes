-- =====================================================================================================
-- Entreturno · Boxes — el reloj del servidor
-- =====================================================================================================
-- Cada 5 minutos corre el mantenimiento de todos los consultorios: libera las reservas que no se pagaron
-- a tiempo, da por cumplidos los turnos que ya terminaron y deja listo el recordatorio del día anterior.
-- Así nada de eso depende de que alguien entre a la página.
--
-- Este archivo se aplica solo en el proyecto real de Supabase (usa la extensión pg_cron, que las pruebas
-- en la compu no tienen). Se puede volver a correr sin problema: reemplaza la tarea si ya existía.
-- =====================================================================================================

create extension if not exists pg_cron;

select cron.schedule('entreturno-boxes-mantener', '*/5 * * * *', $$select interno.mantener_todos()$$);

-- Cada minuto: manda los avisos por mail que esten esperando (ver el archivo de los mails).
select cron.schedule('entreturno-boxes-avisos', '* * * * *', $$select interno.despachar_avisos()$$);
