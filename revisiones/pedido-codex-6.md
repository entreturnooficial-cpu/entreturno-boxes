# Revisión 6 — Cobro real con Mercado Pago: la base, la función de Supabase y la página

Sos un revisor experto en seguridad, en Postgres/Supabase (RLS, security definer, PostgREST, Vault, pg_cron/pg_net, Edge
Functions en Deno) y en integraciones de pago (OAuth de terceros, webhooks firmados, idempotencia, reembolsos).
Revisá SOLO LECTURA: no cambies ningún archivo. Respondé en castellano, corto y concreto.

## Qué es esto

Sistema de alquiler de boxes de consultorios (una página + Supabase), multi-consultorio. Hasta hoy el pago era «de prueba»
(`simular_pago`). Este tramo agrega el cobro real: **cada consultorio cobra en SU cuenta de Mercado Pago** (la dueña la
autoriza por OAuth; Entreturno no toca la plata ni cobra comisión). Se usa Checkout Pro por la **API de Orders**
(`POST /v1/orders` → `checkout_url`; avisos del tópico «order» con `x-signature`; `POST /v1/orders/{id}/refund`).
Lo que se leyó de la documentación de Mercado Pago el 24/11/2026 está resumido en la cabecera de
`supabase/functions/_compartido/mp.ts`. No se probó todavía contra Mercado Pago de verdad: solo contra un simulador propio.

Nada de esto está cargado en el Supabase real ni publicado. Mueve plata de terceros: buscá con ganas.

## Qué se agregó (lo que hay que revisar)

1. `supabase/migrations/20261124100000_mercadopago.sql`:
   - `consultorios.mp_ambiente` («prueba» / «real»; `pagos_modo` ya existía: «simulado» / «mercadopago»; los dos se cambian
     solo por SQL);
   - `pagos`: estados nuevos «sobrante» (cobrado de más: se devuelve entero), «devuelto» y «revisar»; columnas `vence_en`,
     `enlace`, `intentos`, `error`, `actualizado_en`;
   - `interno.mp_cuentas` (sin los pases: van al Vault con los nombres `mp_acceso_<consultorio>` y `mp_renovar_<consultorio>`),
     `interno.mp_estados` (el `state` de OAuth, de un solo uso, con el verificador PKCE) e `interno.ajustes`;
   - para la página (rol authenticated): `mp_conexion_iniciar`, `mp_conexion_confirmar`, `mp_desconectar`,
     `mp_pago_preparar`, `mp_pago_mio`, `mp_consultorio_mio`, `mp_devolucion_a_mano`; y `cancelar_reserva` reescrita;
   - solo para la función (rol service_role): `mp_conexion_tomar`, `mp_cuenta_guardar`, `mp_credencial`,
     `mp_cuenta_renovada`, `mp_cuenta_reintento`, `mp_cuenta_caida`, `mp_pago_orden`, `mp_pago_fallo`, `mp_pago_ubicar`,
     `mp_pago_resultado` (→ `interno.mp_aplicar`: confirma, revive una reserva vencida si el horario sigue libre, o marca
     «sobrante»), `mp_pago_cerrado`, `mp_devolucion_tomar`, `mp_devolucion_parte`, `mp_sobrante_resultado`, `mp_pendientes`,
     `mp_reloj_clave`;
   - `interno.mp_reloj()` (lo llama pg_cron cada minuto: si hay trabajo, despierta a la función con pg_net y una clave
     que vive en el Vault) y el bloque de permisos del final.
   - `supabase/migrations/20261124100100_reloj_mp.sql` (solo proyecto real): la URL de la función, la clave del reloj y el cron.
2. `supabase/functions/_compartido/mp.ts`: cliente de Mercado Pago (pases, órdenes, devoluciones), `firmaValida`, PKCE.
3. `supabase/functions/_compartido/cobros.ts`: `iniciarConexion`, `terminarConexion`, `pagar`, `conciliar`, `avisoDeMp`,
   `verificar`, `vueltaDelReloj`, `despachar`.
4. `supabase/functions/mp/index.ts`: la función (Deno), SIN «Enforce JWT verification». Atiende cuatro orígenes con
   pruebas de identidad distintas: la página (pase del usuario + Origin permitido), la vuelta de OAuth (GET con `state`),
   el aviso de Mercado Pago (`x-signature`) y el reloj (`x-entreturno-reloj`). `publicar/armar_funcion.mjs` la arma en un
   solo archivo (`publicar/funcion-mp/index.ts`).
5. `web/index.html`: hoja «Pagar con Mercado Pago» (`mpIr`), la vuelta de pagar (`mirarVueltaDeMp`, `atenderVueltaDeMp`),
   la tarjeta «Mercado Pago» de Configuración (`mpPanel`, `openMpConfirm`), «Devoluciones que están saliendo» en Pagos.
6. Pruebas: `pruebas/sql/mercadopago.test.mjs`, `pruebas/sql/cobros-mp.test.mjs` (con `pruebas/mp-simulado.mjs`),
   `pruebas/mp.test.mjs`, `pruebas/funcion-mp.test.mjs`, `pruebas/pantallas-mp.mjs` y
   `pruebas/sql/migracion-sobre-datos.test.mjs`. Resultado: `npm test` 187 de 187, `npm run test:pantallas` 103 de 103
   y `npm run test:pantallas-mp` 51 de 51.

## Qué quiero que busques

A. **Plata**: caminos donde alguien paga y se queda sin turno y sin devolución; donde se acredita sin que Mercado Pago
   haya cobrado; donde se cobra o se devuelve dos veces; donde una devolución sale por más de lo cobrado o de la cuenta
   equivocada; donde un pago queda «pendiente» para siempre. Mirá en especial `interno.mp_aplicar`, `mp_pago_resultado`,
   `mp_pago_preparar` (reuso del intento y de la clave de idempotencia), `mp_devolucion_tomar` / `mp_devolucion_parte`,
   `cancelar_reserva`, y en `cobros.ts`: `conciliar`, `pagar`, `devolver`, `vueltaDelReloj`.
B. **Concurrencia**: el aviso de Mercado Pago, «verificar» de la página y el reloj llegando a la vez por el mismo pago;
   cancelar mientras llega el pago; `interno.mantener` venciendo la reserva mientras se acredita; dos vueltas del reloj
   superpuestas ejecutando la misma devolución; orden de candados (¿puede haber un abrazo mortal entre
   `interno.candado`, el `for update` de `pagos` y el de `reservas`?).
C. **Seguridad**: ¿alguien sin permiso (otra profesional, la dueña de otro consultorio, alguien sin sesión, un sitio
   ajeno, quien conozca la URL de la función) puede: conectar una cuenta de Mercado Pago a un consultorio ajeno, hacer
   que la plata de un consultorio vaya a otra cuenta, disparar devoluciones, leer pases, falsificar un aviso, usar la
   vuelta de OAuth como redirección abierta, o agotar algo (base, Mercado Pago, mails) con pedidos baratos?
   ¿El flujo OAuth (state de un solo uso + PKCE + «la dueña confirma viendo qué cuenta es») alcanza contra el CSRF de
   conexión? ¿Las funciones `mp_*` de servicio quedan realmente cerradas para anon/authenticated con los privilegios por
   defecto de Supabase? ¿Algo filtra pases, el client_secret o la firma secreta en respuestas, errores o registros?
   ¿Los pases en el Vault están bien usados (`vault.create_secret` / `update_secret` / `decrypted_secrets`)?
D. **Supuestos sobre Mercado Pago que pueden estar mal** (no los pude comprobar sin credenciales): el manifiesto de la
   firma con el id de orden en mayúsculas; `expiration_time` en minutos (`PT15M`); `capture_mode: "automatic"` como
   modo binario; el cuerpo del reembolso parcial; que los avisos de órdenes creadas con el pase de una vendedora
   conectada por OAuth lleguen al webhook de la aplicación; `test_token: true`; el aviso `mp-connect` de desvinculación.
   Decime cuáles te parecen más riesgosos y cómo dejar el código tolerante si el supuesto no se cumple.
E. **La migración en el proyecto real**: ¿se puede cargar tal cual en el SQL Editor sobre la base que ya existe (con
   reservas y pagos de prueba, y la migración de ARCA ya cargada)? ¿`create or replace` de `j_sitio`, `j_config`,
   `j_reserva` y `cancelar_reserva` rompe algo de lo que ya anda (la página publicada hoy es la vieja, hasta que se
   publique la nueva)? ¿El Vault real se comporta como lo uso?
F. **La página**: XSS con datos que vienen de Mercado Pago (nombre y mail de la cuenta, motivos de error) o de la barra de
   direcciones al volver; redirecciones a sitios que no sean Mercado Pago; botones que se pueden apretar dos veces;
   mensajes que confundan o que prometan algo que el sistema no hace.
G. **Pruebas que faltan.**

## Cómo responder

Una lista numerada. Cada punto: archivo y función, qué pasa (con un ejemplo concreto), qué tan grave (alta, media, baja) y
cómo arreglarlo en una o dos líneas. Separá errores de sugerencias. No más de 18 puntos.
