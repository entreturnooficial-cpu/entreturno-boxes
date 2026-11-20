Encontré problemas en el vencimiento, la agenda y los importes. La revisión fue estática: no modifiqué archivos ni ejecuté pruebas de concurrencia o contra Supabase real. Indico como hipótesis lo que depende de una configuración externa que no pude verificar.

1. **Alta — El mantenimiento puede revertirse justo cuando hace falta que se confirme.**  
   [funciones.sql:168](</C:/Users/santi/Desktop/entreturno-boxes/supabase/migrations/20261120100100_funciones.sql:168>), [funciones.sql:582](</C:/Users/santi/Desktop/entreturno-boxes/supabase/migrations/20261120100100_funciones.sql:582>) y [funciones.sql:621](</C:/Users/santi/Desktop/entreturno-boxes/supabase/migrations/20261120100100_funciones.sql:621>).

   Una reserva vence; la profesional intenta pagarla. `mantener` la cancela, libera sus máquinas y prepara el aviso, pero `simular_pago` después detecta que ya no se puede pagar y lanza `pago_invalido`. La excepción revierte toda la transacción, incluido el mantenimiento. Lo mismo ocurre si intenta cancelarla y se obtiene `no_se_puede_cancelar`.

   La reserva permanece en estado `pago`, con sus máquinas activas, hasta que otra llamada que haga mantenimiento termine exitosamente. **Arreglo:** ejecutar el mantenimiento mediante un proceso independiente y confirmado, o hacer que las operaciones posteriores al mantenimiento devuelvan un resultado de negocio sin lanzar una excepción que deshaga esos cambios. Conviene probar explícitamente el estado de la base después del error.

2. **Alta — El tope de reservas sin pagar se puede superar con llamadas simultáneas.**  
   [funciones.sql:531](</C:/Users/santi/Desktop/entreturno-boxes/supabase/migrations/20261120100100_funciones.sql:531>).

   Una profesional tiene dos reservas pendientes y el máximo es tres. Envía dos solicitudes simultáneas para horarios distintos; ambas cuentan dos, ambas pasan el control e insertan una reserva. Termina con cuatro. La restricción de solapamiento no ayuda porque los horarios son distintos.

   **Arreglo:** serializar las reservas de la misma profesional, por ejemplo bloqueando su fila de `miembros` con `SELECT … FOR UPDATE` antes de contar e insertar. Agregar una prueba con dos conexiones reales y transacciones concurrentes; la prueba actual del tope es secuencial ([reservas.test.mjs:130](</C:/Users/santi/Desktop/entreturno-boxes/pruebas/sql/reservas.test.mjs:130>)).

3. **Alta — Una reserva puede crearse sobre un bloqueo agregado al mismo tiempo.**  
   [funciones.sql:519](</C:/Users/santi/Desktop/entreturno-boxes/supabase/migrations/20261120100100_funciones.sql:519>) y [funciones.sql:692](</C:/Users/santi/Desktop/entreturno-boxes/supabase/migrations/20261120100100_funciones.sql:692>).

   La profesional verifica que el turno está libre mientras, en otra transacción, la dueña crea un bloqueo para ese box y horario. Si ninguna transacción ve todavía la escritura de la otra, la reserva y el bloqueo pueden quedar confirmados; además, el conteo de `clashes` puede devolver cero. La exclusión de reservas protege contra otras reservas, no contra bloqueos.

   **Arreglo:** serializar las modificaciones de agenda y las reservas sobre el mismo box —incluyendo bloqueos recurrentes, ratos y cambios de horario— con un bloqueo común y en un orden consistente. Después del bloqueo, volver a evaluar disponibilidad y choques.

4. **Media — La seña cobrada puede diferir de la informada al reservar.**  
   [funciones.sql:565](</C:/Users/santi/Desktop/entreturno-boxes/supabase/migrations/20261120100100_funciones.sql:565>) y [funciones.sql:588](</C:/Users/santi/Desktop/entreturno-boxes/supabase/migrations/20261120100100_funciones.sql:588>).

   La profesional reserva $40.000 con seña del 50 % y recibe `amount: 20000`. Antes de pagar, la dueña cambia la seña al 80 %. `simular_pago` vuelve a calcular con la configuración vigente y cobra $32.000. También puede cobrar menos de lo informado.

   **Arreglo:** guardar en la reserva el porcentaje o, mejor, el monto de seña ofrecido al crearla y usar ese valor para el primer pago. Probar el cambio de configuración entre reserva y pago.

5. **Media — Los precios admitidos pueden producir reservas imposibles de confirmar o errores por desbordamiento.**  
   [tablas.sql:72](</C:/Users/santi/Desktop/entreturno-boxes/supabase/migrations/20261120100000_tablas.sql:72>), [funciones.sql:541](</C:/Users/santi/Desktop/entreturno-boxes/supabase/migrations/20261120100100_funciones.sql:541>) y [funciones.sql:594](</C:/Users/santi/Desktop/entreturno-boxes/supabase/migrations/20261120100100_funciones.sql:594>).

   Se permite precio cero. Una reserva de total cero queda en `pago`, pero `simular_pago` responde `nada_que_pagar`; nunca se confirma y termina venciendo. También puede ocurrir con una seña que redondea a cero: por ejemplo, total $1 y seña 1 %. Además, los importes son `integer`: suficientes máquinas al precio máximo permitido pueden superar 2.147.483.647 durante la suma y hacer fallar la reserva.

   **Arreglo:** definir y aplicar una regla explícita para reservas gratuitas y señas redondeadas a cero; por ejemplo, confirmar las gratuitas sin insertar un pago de monto cero. Usar `bigint` para importes y operaciones intermedias, o imponer límites coherentes al total.

6. **Media — Un rato libre parcialmente ocupado queda inutilizable, aunque la demo ofrece el resto.**  
   [funciones.sql:520](</C:/Users/santi/Desktop/entreturno-boxes/supabase/migrations/20261120100100_funciones.sql:520>), [demo:1042](</C:/Users/santi/Desktop/entreturno-boxes/referencia/demo-de-la-que-se-partio.html:1042>).

   Hay una reserva de 8 a 10; la dueña bloquea de 8 a 16 y publica ese tramo como rato libre. La demo parte el rato alrededor de la reserva y presenta de 10 a 16 como reservable. El servidor exige que el pedido coincida con el rato completo, de 8 a 16, y ese pedido choca con la reserva existente; rechaza también 10 a 16.

   **Arreglo:** calcular los segmentos efectivos, descontando reservas existentes, y validar que el pedido coincida con un segmento ofrecido por la agenda. Agregar el caso de una reserva preexistente dentro de un rato publicado.

7. **Media — `liberar_dia` puede usar un bloqueo ajeno al box o a la fecha indicada.**  
   [funciones.sql:732](</C:/Users/santi/Desktop/entreturno-boxes/supabase/migrations/20261120100100_funciones.sql:732>).

   La dueña tiene un bloqueo A de 8 a 12 para el box 1 y otro B de 8 a 16 para el box 2. Llama `liberar_dia` con el ID de A, el box 2 y una fecha en la que rige B. La función toma las horas de A y `publicar_rato` acepta 8 a 12 porque está dentro de *algún* bloqueo del box 2. Se libera un tramo que no corresponde al bloqueo elegido. Una fecha equivocada puede producir el mismo efecto si otro bloqueo cubre ese día.

   **Arreglo:** comprobar que el bloqueo indicado incluya ese box y que corresponda a la fecha —fecha exacta o día de semana recurrente— antes de publicar el rato.

8. **Media — El recordatorio y el vencimiento dependen de que alguien entre.**  
   [funciones.sql:166](</C:/Users/santi/Desktop/entreturno-boxes/supabase/migrations/20261120100100_funciones.sql:166>) y [funciones.sql:194](</C:/Users/santi/Desktop/entreturno-boxes/supabase/migrations/20261120100100_funciones.sql:194>).

   Si nadie llama una función que ejecute `mantener` durante las 24 horas previas al turno, no se crea el recordatorio; una vez iniciado el turno, ya no cumple la condición para crearlo. Los vencimientos también quedan sin procesar hasta una llamada posterior. Esto reproduce la naturaleza interactiva de `autoUpdate` de la demo, pero en un sistema real impide garantizar el aviso.

   **Arreglo:** programar mantenimiento periódico por consultorio y conservar la ejecución previa a las operaciones como respaldo. La prueba actual verifica el resultado al invocar mantenimiento, no su ejecución autónoma ([ajustes.test.mjs:207](</C:/Users/santi/Desktop/entreturno-boxes/pruebas/sql/ajustes.test.mjs:207>)).

9. **Media — La validación de reglamento tiene una carrera.**  
   [funciones.sql:502](</C:/Users/santi/Desktop/entreturno-boxes/supabase/migrations/20261120100100_funciones.sql:502>) y [funciones.sql:506](</C:/Users/santi/Desktop/entreturno-boxes/supabase/migrations/20261120100100_funciones.sql:506>).

   Una profesional envía la versión 1. La reserva lee esa configuración y la valida; simultáneamente, la dueña guarda la versión 2 antes de que se confirme la reserva. Puede quedar una reserva nueva con versión 1 después del cambio. Esto importa si la intención es exigir siempre el reglamento vigente al momento de confirmar.

   **Arreglo:** serializar la lectura y el cambio de reglamento mediante un bloqueo de la fila del consultorio, o establecer una regla precisa sobre qué instante determina la versión aceptable. Además, conservar el texto histórico de cada versión si se necesita acreditar qué se aceptó: actualmente solo se guarda el número.

10. **Media — Hay que verificar los permisos efectivos y las migraciones en Supabase real.**  
    [funciones.sql:1049](</C:/Users/santi/Desktop/entreturno-boxes/supabase/migrations/20261120100100_funciones.sql:1049>) y [entorno.mjs:71](</C:/Users/santi/Desktop/entreturno-boxes/pruebas/sql/entorno.mjs:71>).

    **Es una duda de despliegue, no una vulnerabilidad demostrada.** El arnés elimina la sentencia `create extension` y prepara su propio entorno, por lo que no demuestra que la extensión `btree_gist`, el acceso del propietario de las funciones a `auth.users`, las concesiones heredadas o PostgREST funcionen igual en el proyecto real. El bloque final revoca `PUBLIC`, `anon` y `authenticated`, pero permisos directos concedidos por privilegios por defecto a otros roles no quedan descartados por esa lectura.

    **Comprobación y arreglo:** aplicar ambas migraciones en un proyecto Supabase de prueba con el mismo rol de despliegue; consultar `has_function_privilege` y `has_schema_privilege` para los roles efectivos, y llamar los RPC por PostgREST con JSON y parámetros nombrados. Revisar también que ningún rol de la API pueda crear objetos en un esquema incluido en el `search_path` de las funciones `security definer`.

Revisé también el aislamiento básico de `foto` y `portada`: en el código leído no encontré una filtración demostrada de datos personales o importes de otras profesionales. Las reservas ajenas se reducen a ocupación y máquinas, y las notas de bloqueos se reservan para la administradora. Las exclusiones de Postgres para reservas y máquinas, las claves foráneas con `consultorio_id`, y el bloqueo de la reserva al pagar o cancelar son buenas defensas; las pruebas cubren esos comportamientos en casos secuenciales.