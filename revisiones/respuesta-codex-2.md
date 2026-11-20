Encontré problemas en la aceptación del reglamento, el cierre de sesión y la recuperación ante fallas de red. La revisión fue **estática**: no modifiqué archivos ni ejecuté las pruebas. Los escenarios de concurrencia conviene reproducirlos con respuestas demoradas y, para autenticación, también contra Supabase real.

1. **Alta — Se puede registrar la aceptación de un reglamento que la profesional no vio.**  
   [index.html:930](</C:/Users/santi/Desktop/entreturno-boxes/web/index.html:930>), [index.html:2003](</C:/Users/santi/Desktop/entreturno-boxes/web/index.html:2003>) y [index.html:2014](</C:/Users/santi/Desktop/entreturno-boxes/web/index.html:2014>).

   La profesional abre la hoja y lee el reglamento versión 1. Mientras la hoja sigue abierta, la dueña guarda la versión 2. El refresco automático reemplaza `S`, pero no redibuja la hoja. La profesional acepta el texto viejo y confirma: se envía `S.config.terms.version`, que ahora es 2. La base acepta la reserva como si hubiera leído esa versión.

   **Arreglo:** guardar en el borrador la versión y el texto efectivamente mostrados y enviar esa versión. Si cambian, quitar la aceptación y exigir que se lea el texto nuevo. Agregar una prueba que cambie el reglamento mientras la hoja está abierta y espere el rechazo o la nueva aceptación.

2. **Alta — Una renovación en curso puede volver a iniciar sesión después de salir.**  
   [conexion.js:80](</C:/Users/santi/Desktop/entreturno-boxes/web/conexion.js:80>) y [conexion.js:137](</C:/Users/santi/Desktop/entreturno-boxes/web/conexion.js:137>).

   Una llamada empieza a renovar un pase vencido. Antes de que llegue la respuesta, la persona toca «Salir»: se borra la sesión local y se pide cerrar el pase anterior. Si luego llega la respuesta de renovación, `guardar(...)` vuelve a guardar la sesión. También podría pisar una cuenta distinta que haya ingresado durante la espera.

   **Arreglo:** asociar cada renovación a una generación de sesión y descartar su respuesta si entretanto hubo salida o cambio de cuenta. Invalidar también la sesión renovada cuando corresponda. Probar la secuencia demorando la respuesta de renovación hasta después de salir.

3. **Alta — La página puede informar que falló una operación que la base ya confirmó.**  
   [index.html:898](</C:/Users/santi/Desktop/entreturno-boxes/web/index.html:898>) y [index.html:2023](</C:/Users/santi/Desktop/entreturno-boxes/web/index.html:2023>).

   La reserva, el pago u otra operación termina correctamente en la base, pero falla la llamada posterior a `cargar()`. El mismo `catch` trata ambas fallas como si hubiera fallado la operación y devuelve `null`. Por ejemplo, la hoja de reserva queda abierta para reintentar aunque la reserva ya exista; la persona puede recibir luego un rechazo por horario ocupado o volver a ejecutar otra clase de acción.

   **Arreglo:** distinguir el resultado de la operación del resultado de actualizar la foto. Si la operación respondió bien, conservar ese resultado y avisar que falta actualizar la pantalla. Para una pérdida de conexión *antes de recibir la respuesta*, usar identificadores de operación idempotentes o reconciliar el estado antes de permitir el reintento.

4. **Media — La aceptación de precio puede quedar vieja durante la reserva.**  
   [index.html:930](</C:/Users/santi/Desktop/entreturno-boxes/web/index.html:930>), [index.html:1970](</C:/Users/santi/Desktop/entreturno-boxes/web/index.html:1970>) y [funciones.sql:608](</C:/Users/santi/Desktop/entreturno-boxes/supabase/migrations/20261120100100_funciones.sql:608>).

   La profesional ve un total y una seña en la hoja. La dueña cambia el precio o el porcentaje antes de confirmar. La hoja puede seguir mostrando los importes anteriores, mientras `reservar` calcula los nuevos. Después aparece el importe real para pagar, pero la reserva ya fue creada con condiciones distintas de las mostradas al confirmarla.

   **Arreglo:** enviar una versión de precios o los importes esperados para que la base rechace los cambios y obligue a revisarlos; alternativamente, introducir una confirmación explícita del importe devuelto antes de comprometer la reserva. Probar cambios de categoría, precio de box, máquina y seña durante la hoja.

5. **Media — Las fechas y horas dependen de la zona del dispositivo, no de la del consultorio.**  
   [index.html:726](</C:/Users/santi/Desktop/entreturno-boxes/web/index.html:726>), [index.html:731](</C:/Users/santi/Desktop/entreturno-boxes/web/index.html:731>) y [funciones.sql:557](</C:/Users/santi/Desktop/entreturno-boxes/supabase/migrations/20261120100100_funciones.sql:557>).

   Una profesional usa el sistema desde un dispositivo configurado en otra zona horaria. La página interpreta el inicio del turno en la zona del dispositivo; la base lo interpreta en `c.zona`. Según la diferencia, puede mostrar como reservable un turno que ya empezó, bloquearlo antes de tiempo, calcular mal el aviso de saldo vencido o mostrar una devolución distinta cerca del límite de días.

   **Arreglo:** incluir la zona del consultorio en la foto y usarla para convertir fechas y horas; para decisiones sensibles, preferir valores calculados por la base. Probar con el navegador en UTC y el consultorio en Buenos Aires, especialmente alrededor del inicio de un turno y del límite de devolución.

6. **Media — Dos pestañas pueden competir al renovar y una puede borrar la sesión de la otra.**  
   [conexion.js:80](</C:/Users/santi/Desktop/entreturno-boxes/web/conexion.js:80>) y [conexion.js:90](</C:/Users/santi/Desktop/entreturno-boxes/web/conexion.js:90>).

   Dos pestañas detectan al mismo tiempo que el pase necesita renovación. Ambas leen el mismo código antes de que alguna guarde el nuevo. `renovando` evita duplicados dentro de una instancia, pero no entre pestañas. Si una renovación es rechazada, su `catch` borra la sesión compartida, incluso si la otra ya guardó una nueva.

   El resultado concreto depende de la tolerancia de Supabase a reutilizar un código de renovación; el servidor local lo invalida al primer uso. La prueba existente cubre llamadas simultáneas dentro de una misma conexión, no esta carrera entre pestañas.

   **Arreglo:** coordinar la renovación entre pestañas y, antes de borrar por error, volver a leer el almacenamiento y comprobar que sigue conteniendo el mismo código que falló. Reproducir la carrera en el servidor local y verificarla en Supabase real.

7. **Media — Los refrescos lentos pueden acumularse y aplicar respuestas fuera de orden.**  
   [index.html:930](</C:/Users/santi/Desktop/entreturno-boxes/web/index.html:930>) y [index.html:2480](</C:/Users/santi/Desktop/entreturno-boxes/web/index.html:2480>).

   Si `foto` tarda varios segundos, el temporizador puede iniciar más refrescos porque `ocupada` no marca un refresco en curso y `ultimaCarga` se actualiza recién al terminar. Una respuesta más vieja puede llegar después de otra más nueva y reemplazar `S` con datos atrasados. También hay tráfico repetido mientras la conexión está lenta.

   **Arreglo:** permitir un solo refresco en vuelo y descartar respuestas que pertenezcan a una solicitud o sesión anterior. Probar respuestas artificialmente demoradas y entregadas en orden inverso.

8. **Media — Un error de validación puede borrar formularios completos.**  
   [index.html:2401](</C:/Users/santi/Desktop/entreturno-boxes/web/index.html:2401>), [index.html:2428](</C:/Users/santi/Desktop/entreturno-boxes/web/index.html:2428>) y [index.html:2445](</C:/Users/santi/Desktop/entreturno-boxes/web/index.html:2445>).

   La dueña escribe un reglamento, un bloqueo o una categoría y la base rechaza un dato —por ejemplo, por longitud—. Varios manejadores cierran la hoja o ejecutan `render()` aun cuando `accion` devuelve `null`; se pierde lo escrito y el cartel genérico no necesariamente permite identificar el campo.

   **Arreglo:** conservar el formulario y sus valores ante errores, mostrar el campo y el motivo cuando se conozcan, y cerrar o redibujar recién después de guardar. Probar con textos superiores al límite y con un error de red.

9. **Baja — Las direcciones de fotos no tienen una política de origen.**  
   [index.html:1471](</C:/Users/santi/Desktop/entreturno-boxes/web/index.html:1471>) y [funciones.sql:1047](</C:/Users/santi/Desktop/entreturno-boxes/supabase/migrations/20261120100100_funciones.sql:1047>).

   Una administradora puede guardar mediante RPC una dirección de imagen de un servidor externo. Al abrir la pantalla, los navegadores de las profesionales la solicitan a ese servidor, que puede registrar sus visitas y direcciones IP. Las comillas están escapadas; **no encontré una ejecución de `javascript:` demostrada** en estos `<img>`.

   **Arreglo:** cuando se habiliten fotos, aceptar únicamente direcciones HTTPS del depósito autorizado —idealmente, guardar una referencia al archivo y construir la URL— y establecer una política `img-src` acorde. Las cargas están ocultas hoy, pero el RPC de foto existe.

Revisé el escape de los textos interpolados que identifiqué en las pantallas, incluidos nombres, profesión, servicio, notas, reglamento y atributos de fotos; no encontré una inyección HTML demostrada en esos recorridos. También contrasté `saldos()` con el conteo de `reservar`: las condiciones principales coinciden, el pago de saldo de una reserva `cumplida` está contemplado y el candado del consultorio serializa las reservas y los cambios de configuración. La seña guardada en `deposit` se usa para mostrar el pago pendiente.

No doy por verificado el funcionamiento en Supabase real: esta lectura no sustituye las comprobaciones de autenticación, RPC y concurrencia que ya señala el proyecto.