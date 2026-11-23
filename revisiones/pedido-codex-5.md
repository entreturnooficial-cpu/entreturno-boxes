# Revisión 5 — «Facturar todo el mes»: la base, la función de Supabase y la página

Sos un revisor experto en seguridad, en Postgres/Supabase (RLS, security definer, PostgREST, Edge Functions en Deno) y en
factura electrónica de ARCA. Revisá SOLO LECTURA: no cambies ningún archivo. Respondé en castellano, corto y concreto.

## Qué es esto

Sistema de alquiler de boxes de consultorios (una página + Supabase). La revisión 4 (`revisiones/respuesta-codex-4.md`)
fue sobre el módulo que habla con ARCA (`supabase/functions/_compartido/arca.ts`); sus arreglos ya están. Este tramo lo
conecta con la base y la página: la dueña aprieta «Facturar todo el mes» y se emite UNA Factura C por profesional con todas
sus horas del mes (decisión de la clienta). Cada consultorio factura con su CUIT; Entreturno tiene un solo certificado.
Ambientes por consultorio: «apagado», «prueba» (ARCA de prueba, con la CUIT autorizada en el WSASS) y «real».

## Qué se agregó (lo que hay que revisar)

1. `supabase/migrations/20261123100000_facturas_arca.sql`:
   - `miembros.condicion_iva`, `consultorios.fact_ambiente/fact_domicilio/fact_iibb/fact_inicio`;
   - la tabla `facturas` rehecha (estado pendiente → incierta → emitida / rechazada / revisar; lo que va a ARCA congelado);
   - `interno.arca_tickets` y `interno.arca_candados`;
   - funciones para la página: `pedir_acceso` (ahora con condición y CUIT validada), `cambiar_datos_fiscales_profesional`,
     `guardar_facturacion` (más datos), `facturacion_preparar` (la dueña: arma/pone al día las facturas del mes) y
     `facturacion_estado`;
   - funciones SOLO para la función de Supabase (rol service_role): `arca_ticket`, `arca_guardar_ticket`, `arca_candado`,
     `arca_anotar`, `arca_resultado`;
   - el bloque de permisos del final.
2. `supabase/functions/_compartido/facturar.ts`: `facturarMes` (candado por numeración, ticket guardado en la base, una
   factura por vez, conciliación de las «inciertas») y `probarConexion`; `normalizarPem` (certificados pegados en una línea).
3. `supabase/functions/facturar/index.ts`: la función de Supabase (Deno). Se despliega SIN «Enforce JWT verification»:
   llama a `facturacion_preparar` con el pase de quien pide (la base revisa que sea la dueña) y a las `arca_*` con la clave
   secreta. CORS solo para `*.entreturno.com.ar`, `*-entreturno.pages.dev` y localhost. `publicar/armar_funcion.mjs` la
   junta en un solo archivo para pegarla en el panel de Supabase.
4. `web/index.html` y `web/conexion.js`: campos de CUIT y condición en «Pedir acceso», botón «Facturar todo el mes»,
   hojas de confirmación y resultado, «Probar la conexión con ARCA», corrección de CUIT/condición de una profesional.
5. Pruebas: `pruebas/sql/facturas.test.mjs`, `pruebas/sql/facturar-arca.test.mjs` (con `pruebas/arca-simulado.mjs`),
   `pruebas/funcion.test.mjs` (la función armada, corrida con un Deno de mentira) y `pruebas/pantallas.mjs`.
   Resultado: `npm test` 135 de 135 y `npm run test:pantallas` 103 de 103.

## Qué quiero que busques

A. **Seguridad**: ¿alguien que no sea la dueña (otra profesional, otra dueña, alguien sin sesión, un sitio ajeno) puede
   emitir, ver o tocar facturas, tickets o candados de otro? ¿Las funciones `arca_*` quedan realmente cerradas para
   anon/authenticated en Supabase (pensá en los privilegios por defecto)? ¿Algo de la función filtra el ticket, la firma,
   la clave o el SOAP en una respuesta o en los registros? ¿La regla de CORS se puede saltear de una forma que importe?
B. **No facturar dos veces / no perder facturas** en el camino base + función: dos clics a la vez, dos dueñas a la vez,
   la función cortada a mitad (tiempo máximo de Supabase), la base que falla justo después de que ARCA aprobó, una factura
   «incierta» que se concilia con otros datos de configuración, `facturacion_preparar` corriendo mientras otra corrida emite.
C. **Datos**: ¿el total, las horas y las líneas coinciden siempre con lo que muestra la pantalla? ¿Qué pasa con turnos que
   se agregan o cancelan después de facturar (hoy: una factura por profesional y mes)? ¿Fechas del servicio y del comprobante?
D. **La migración en el proyecto real**: ¿se puede cargar tal cual en el SQL Editor sobre la base que ya existe (con la tabla
   `facturas` vacía)? ¿Algo que rompa lo que ya anda (pedidos de acceso viejos guardados en el navegador, la foto, mails)?
E. **La página**: XSS con datos que vienen de ARCA (motivos de rechazo) o de las profesionales, botones que se pueden apretar
   dos veces, mensajes que confundan.
F. **Pruebas que faltan.**

## Cómo responder

Una lista numerada. Cada punto: archivo y función, qué pasa (con un ejemplo concreto), qué tan grave (alta, media, baja) y
cómo arreglarlo en una o dos líneas. Separá errores de sugerencias. No más de 15 puntos.
