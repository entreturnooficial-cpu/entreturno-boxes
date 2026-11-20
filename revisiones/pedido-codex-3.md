# Revisión 3 — los mails de registro (confirmar la cuenta, mandarlo de nuevo, olvidé mi contraseña)

Sos un revisor experto en seguridad web y en Supabase Auth (GoTrue). Revisá SOLO LECTURA: no cambies ningún archivo.
Respondé en castellano, corto y concreto.

## Qué es esto

Sistema de alquiler de boxes de un consultorio. Una sola página estática (`web/index.html` + `web/conexion.js` + `web/config.js`)
que habla con Supabase por `fetch` (sin supabase-js): `/auth/v1/*` para el ingreso y `/rest/v1/rpc/*` para todo lo demás.
En el proyecto real de Supabase está prendido «Confirm email» y el envío sale por SMTP propio (Resend).

## Qué se agregó en este tramo (lo que hay que revisar)

1. `web/conexion.js`:
   - `crearCuenta(email, clave, volverA, datos)`: manda `redirect_to` y `data` (queda en `user_metadata`); si la respuesta no trae
     sesión tira `confirmar_mail`, y si trae `identities: []` tira `user_already_exists`.
   - `reenviar`, `recuperar`, `cambiarClave`, `guardarDatos`, `datosDeLaCuenta` (lee `user_metadata` del pase, sin verificar firma).
   - `hayEnlace(fragmento)` y `entrarPorEnlace(fragmento)`: el mail trae un enlace a la página misma con
     `#token_hash=...&type=email|recovery`; la página lo canjea con `POST /auth/v1/verify { type, token_hash }` y guarda la sesión.
     También entiende el formato de fábrica (`#access_token=...&refresh_token=...&type=...`) y `#error=...`.
2. `web/index.html` (buscá estos nombres): `mirarDireccion`, `enlaceDeLlegada`, `llegoPor`, `pasoDeIngreso`, `eligiendoClave`,
   `guardarPedido`, `pedidoGuardado`, `mandarPedidoGuardado`, `despuesDeEntrar`, `intentar`, `entrarCon`, `pasoDelIngreso`,
   `renderClaveNueva`, `puedeDibujar` (ahora con `form[data-sucio]`), los `case` `"login"`, `"register"`, `"olvide"`,
   `"clave-nueva"`, `"auth-paso"`, `"reenviar-mail"`, `"clave-despues"`, y el final de `iniciar()` + el `hashchange`.
   Idea: al pedir acceso con confirmación prendida, los datos del pedido (nombre, profesión, categoría, teléfono, CUIT; nunca la
   contraseña) quedan en `localStorage` (`et-pedido-<slug>`, 7 días) y anotados en `user_metadata.pedido`; al volver del mail
   (en ese navegador o en otro aparato) la página manda sola `pedir_acceso` y limpia.
3. `supabase/mails/*.html`: las dos plantillas cargadas en Supabase (Confirm sign up y Reset password). Supabase las procesa
   con `html/template` de Go. `{{ .RedirectTo }}` es el `redirect_to` ya validado (mismo host que el Site URL, o en la lista).
4. `pruebas/servidor-local.mjs`: el servidor de prueba que imita esos caminos (solo para pruebas; no es producción).
5. `pruebas/conexion.test.mjs` y `pruebas/pantallas.mjs`: las pruebas nuevas.

## Qué quiero que busques

A. **Seguridad**: fuga del código o del pase (URL, historial, Referer, almacenamiento, el contador de visitas que Cloudflare
   inyecta al final del HTML), XSS con datos que vienen de la dirección, del pase o de `user_metadata`, fijación de sesión /
   «login CSRF» por `#access_token` o `#token_hash` ajenos (decí qué riesgo real hay y si conviene dejar de aceptar el formato
   de fábrica), abuso de `redirect_to`, enumeración de cuentas, y cualquier forma de que una persona termine mandando el pedido
   de acceso con datos de otra.
B. **Errores de lógica y carreras**: `iniciar()` llamada dos veces a la vez (evento `storage`, `hashchange`, «Probar de nuevo»),
   dos pestañas mandando el pedido, el pedido que se pierde o se manda dos veces, `eligiendoClave` que queda prendido, sesión que
   se pierde a mitad de camino, `ocupada` que queda trabada, lo que pasa sin conexión en cada paso.
C. **Compatibilidad con Supabase real**: ¿las llamadas y las respuestas que espera la página coinciden con GoTrue?
   (`/signup` con confirmación, `/resend`, `/recover`, `PUT /user`, `POST /verify` con `token_hash`, códigos de error,
   `identities: []`, `user_metadata` en el pase). Marcá lo que dependa de una opción del proyecto.
D. **Las plantillas**: ¿el `href` con `{{ .RedirectTo }}#token_hash={{ .TokenHash }}&amp;type=...` sale bien con `html/template`?
   ¿Algún cliente de correo lo puede romper? ¿Algo engañoso o que huela a phishing?
E. **Lo que no se probó** y debería tener prueba.

## Formato de la respuesta

Lista numerada, de más grave a menos. Para cada punto: gravedad (ALTA / MEDIA / BAJA), archivo y función o renglón, qué pasa
(con un ejemplo concreto de cómo se llega), y el arreglo que proponés en una o dos frases. Si algo está bien resuelto, no lo
elogies: seguí. Si no encontrás nada grave, decilo en una línea. No propongas reescrituras grandes ni pasar a supabase-js.
