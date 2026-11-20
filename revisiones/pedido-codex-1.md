Sos un revisor adversario. NO modifiques ningún archivo: solo leé y contestá.

Proyecto: `entreturno-boxes`, sistema real (Supabase / Postgres) para alquilar boxes y máquinas de consultorios por turnos.
Varios consultorios comparten la misma base (cada fila lleva `consultorio_id`).

Qué leer:
- `supabase/migrations/20261120100000_tablas.sql` (tablas, restricciones, RLS sin políticas)
- `supabase/migrations/20261120100100_funciones.sql` (ayudantes en el esquema `interno` y las funciones que llama la página, todas `security definer`)
- `pruebas/sql/*.mjs` (arnés con PGlite y 47 pruebas que hoy pasan)
- `referencia/demo-de-la-que-se-partio.html` (la demo en el navegador: las reglas de negocio originales están en su JavaScript:
  `segments`, `canBook`, `priceFor`, `rateOf`, `refundFor`, `cancelBooking`, `autoUpdate`, `confirmDraft`, y los `case` de los formularios)

Buscá problemas REALES, con un escenario concreto que los dispare. Prioridades:

1. Seguridad: alguien sin sesión, una profesional (aprobada, pendiente, pausada o rechazada) o la dueña de OTRO consultorio que logre
   leer o cambiar algo que no le corresponde; datos personales o plata que se filtren en lo que devuelven `foto` o `portada`;
   funciones ejecutables de más; problemas de `security definer`, de `search_path` o de permisos; SQL dinámico peligroso.
2. Plata: cobrar de más o dos veces, devolver más de lo pagado, redondeos distintos de los de la demo, estados imposibles
   (confirmada sin pago, cancelada con máquinas tomadas), y carreras: dos pagos a la vez, pagar mientras se cancela o mientras vence.
3. Reservas: dos reservas que se pisen, una máquina en dos reservas, turnos que la demo no dejaría reservar y acá sí (o al revés),
   huecos en `interno.mantener`, el tope de reservas sin pagar, fechas y zona horaria (America/Argentina/Buenos_Aires).
4. Diferencias de comportamiento con la demo que parezcan un error y no una decisión.
5. Cosas que funcionan en PGlite pero fallarían en un proyecto real de Supabase (extensiones, permisos sobre `auth.users`,
   privilegios por defecto, PostgREST llamando funciones con parámetros con nombre, tipos de los parámetros desde JSON).
6. Huecos de las pruebas: reglas importantes que ninguna prueba cubre.

Formato de la respuesta, en castellano:
- Una lista numerada, de lo más grave a lo menos grave. Para cada hallazgo: gravedad (alta / media / baja), archivo y línea,
  el escenario paso a paso, por qué pasa y el arreglo que proponés (con el SQL si es corto).
- Al final, una lista corta de lo que revisaste y te pareció bien.
- No inventes: si no estás seguro de algo, decilo como duda y explicá cómo comprobarlo.
