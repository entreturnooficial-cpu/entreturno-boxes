**Errores**

1. **Alta — [facturar.ts, `facturarMes`](/C:/Users/santi/Desktop/entreturno-boxes/supabase/functions/_compartido/facturar.ts:126).** Si una factura queda incierta, la corrida sigue con la siguiente numeración. Si ARCA todavía procesa la primera, la siguiente puede competir por su número. Detener la corrida ante cualquier incertidumbre y conciliarla antes de emitir otra de esa numeración.

2. **Alta — [migración, `facturacion_preparar` y `arca_anotar`](/C:/Users/santi/Desktop/entreturno-boxes/supabase/migrations/20261123100000_facturas_arca.sql:375).** La preparación ocurre antes de tomar el candado de ARCA. Otra corrida puede actualizar una factura pendiente mientras la primera conserva en memoria sus datos anteriores: ARCA recibe un importe y la base guarda otro. Coordinar preparación y emisión bajo el mismo bloqueo y verificar atómicamente la versión de los datos antes de enviar.

3. **Alta — [facturar.ts, `facturarMes`](/C:/Users/santi/Desktop/entreturno-boxes/supabase/functions/_compartido/facturar.ts:82).** El candado se calcula con la configuración *actual*, pero una factura incierta se concilia con la CUIT y el punto de venta guardados. Si cambiaron, se opera sobre la numeración anterior sin su candado. Tomar el candado correspondiente a cada factura congelada y bloquear su numeración hasta conciliarla.

4. **Alta — [migración, `facturacion_preparar`](/C:/Users/santi/Desktop/entreturno-boxes/supabase/migrations/20261123100000_facturas_arca.sql:332).** Solo busca facturas a partir de reservas actuales. Si se cancela la única reserva de una factura incierta, esta desaparece de la preparación y no se concilia, aunque ARCA pudiera haberla emitido. Buscar primero todas las inciertas y pendientes de revisión, independientemente de las reservas vigentes.

5. **Alta — [migración, `facturacion_preparar`](/C:/Users/santi/Desktop/entreturno-boxes/supabase/migrations/20261123100000_facturas_arca.sql:344).** Una factura emitida se omite para siempre: agregar o cancelar después un turno del mismo mes deja diferencias sin advertencia; la página puede decir «Todo facturado». Detectar y mostrar diferencias contra lo facturado y definir su tratamiento fiscal antes de permitir cambios.

6. **Alta — [migración, `facturacion_preparar`](/C:/Users/santi/Desktop/entreturno-boxes/supabase/migrations/20261123100000_facturas_arca.sql:326).** La base permite facturar el mes en curso, aunque la página deshabilita el botón. Una llamada directa autenticada puede incluir turnos futuros y cerrar prematuramente la única factura mensual. Exigir el mes cerrado en la base, no solo en la interfaz.

7. **Media — [facturar.ts, `facturarMes`](/C:/Users/santi/Desktop/entreturno-boxes/supabase/functions/_compartido/facturar.ts:48).** El candado vence a los 120 segundos y solo se renueva entre facturas. Si una operación excede ese plazo, otra corrida puede tomarlo mientras la primera sigue activa. Usar renovación durante la operación y una protección transaccional que impida actuar con un candado vencido.

8. **Media — [migración, `facturacion_preparar`](/C:/Users/santi/Desktop/entreturno-boxes/supabase/migrations/20261123100000_facturas_arca.sql:349) y [página, `paraFacturar`](/C:/Users/santi/Desktop/entreturno-boxes/web/index.html:1117).** Una incierta conserva los datos originales, pero la confirmación muestra los turnos y datos fiscales actuales. Si cambiaron, la dueña puede confirmar un total distinto del que se conciliará; incluso el botón puede quedar deshabilitado. Mostrar el comprobante congelado y permitir su conciliación sin depender de los datos actuales.

9. **Media — [página, `openInvoice`](/C:/Users/santi/Desktop/entreturno-boxes/web/index.html:2447).** La factura emitida muestra nombre y CUIT actuales de la profesional y datos actuales del consultorio. Si se corrigen después, la hoja presenta datos distintos de los enviados a ARCA. Congelar y mostrar los datos fiscales correspondientes a la emisión.

10. **Media — [facturar.ts, `ticketDe`](/C:/Users/santi/Desktop/entreturno-boxes/supabase/functions/_compartido/facturar.ts:50).** El ticket se comparte por ambiente, pero el candado es por numeración; dos consultorios o una prueba de conexión simultánea pueden pedir a WSAA el mismo ticket a la vez. Serializar su renovación por ambiente y contemplar la pérdida de respuesta o de guardado.

11. **Media — [migración, `arca_resultado`](/C:/Users/santi/Desktop/entreturno-boxes/supabase/migrations/20261123100000_facturas_arca.sql:467).** Guardar el CAE y crear el aviso comparten transacción: si falla el aviso después de la aprobación de ARCA, también se revierte el estado emitido. La factura queda incierta y depende de una conciliación posterior. Desacoplar la notificación del registro durable del CAE y permitir reintentarla.

**Sugerencias y verificaciones pendientes**

12. **Media — [pruebas de facturación](/C:/Users/santi/Desktop/entreturno-boxes/pruebas/sql/facturar-arca.test.mjs:127).** Agregar pruebas con dos corridas realmente simultáneas, preparación intercalada con emisión, vencimiento del candado, cambio de CUIT/punto de venta y caída inmediatamente después de aprobar ARCA. La prueba actual del candado tomado no reproduce esas intercalaciones.

13. **Media — [migración, bloque de permisos](/C:/Users/santi/Desktop/entreturno-boxes/supabase/migrations/20261123100000_facturas_arca.sql:495).** El `REVOKE` explícito a `PUBLIC`, `anon` y `authenticated` cubre los privilegios de ejecución por defecto de las `arca_*`. Verificar además en el proyecto real roles heredados, permisos previos y exposición del esquema `interno`, y ensayar las llamadas con JWT de cada rol. CORS limita la lectura desde navegadores; la autorización efectiva debe seguir siendo la de la base.

14. **Media — migración y página.** Antes de cargar en producción, ensayar la migración completa sobre una copia fiel de la base existente, incluyendo dependencias de la tabla anterior, foto, avisos y solicitudes guardadas con la versión anterior de la página. La revisión estática no alcanza para afirmar que se puede aplicar tal cual.

No modifiqué archivos ni ejecuté las pruebas. Los motivos de ARCA y nombres revisados se escapan al mostrarse; no encontré una filtración directa de ticket o clave en los registros examinados.