# Entreturno · Boxes — el sistema real

La versión de verdad de la página de alquiler de boxes (la demo es `Desktop\Consultorio Yani - Boxes\index.html`;
una copia de la que se partió está en `referencia\`). Primera clienta: la Dra. Yanina Onzari, que aceptó el 20/11/2026.

Un solo sistema para todos los consultorios: cada uno tiene su dirección (`nombre.entreturno.com.ar`), su marca, sus
datos separados y su Mercado Pago. La base de datos vive en Supabase (plan gratis para arrancar; pasar al pago es
cambiar el plan, sin mudar nada) y la página en Cloudflare Pages.

## Cómo está hoy (25/11/2026)

| Parte | Estado |
| --- | --- |
| Base de datos de la etapa 1 (cuentas, agenda, reservas, pagos de prueba, cancelaciones, saldos, ajustes, cola de avisos) | **Hecha y probada en la compu: 65 pruebas** |
| Conexión de la página con el servidor (entrar, crear cuenta, sesión que se renueva sola, enlaces de los mails) | **Hecha y probada contra el servidor de prueba: 13 pruebas** |
| La página (`web\index.html`): las pantallas de la demo, ya conectadas a la base | **Hecha y probada de punta a punta en un navegador sin ventana: 91 comprobaciones** |
| Revisión independiente de la base (Codex, 20/11) | 10 puntos: 9 corregidos con su prueba; el otro es comprobar en el Supabase real |
| Revisión independiente de la página (Codex, 20/11) | 9 puntos: 6 corregidos con su prueba; 3 anotados más abajo. No encontró forma de meter código |
| Revisión independiente de los mails de registro (Codex, 20/11) | 10 puntos: 6 corregidos, 2 comprobados y 2 que dependen de la prueba real (detalle más abajo). No encontró forma de meter código |
| Proyecto real en Supabase | **Creado el 20/11/2026**: organización «Entreturno», proyecto `entreturno` (San Pablo, plan gratis). Base cargada desde el SQL Editor, controlada con `supabase\control.sql` y comprobada desde afuera con `npm run test:real` (8 de 8). El reloj (`pg_cron`) quedó programado. Consultorio `yanina` cargado (`supabase\datos\yanina.sql`) y página publicada en `yanina.entreturno.com.ar` el 20/11 (`publicar\armar_para_publicar.py`; comprobado, 3 de 3 archivos). Santiago entra como «Soporte Entreturno» (admin, `supabase\datos\yanina-soporte.sql`). Falta Yani como dueña: primero crea su cuenta en la página y después `select interno.alta_admin('puntoalmagro', '<su mail>', 'Yani')` |
| Cobro real con Mercado Pago | **Hecho y probado en la compu el 24/11/2026, contra un Mercado Pago simulado** (base, función de Supabase `mp` y página), con una revisión de Codex (la 6): `npm test` 197 de 197, `npm run test:pantallas-mp` 56 de 56 y `npm run test:pantallas` 103 de 103 (las tres corridas otra vez el 25/11). **Cargado en Supabase y publicado el 25/11/2026, con el OK de Santiago**: base (control 15 / 0 / 59 / 34 / 5 / 19 / 0 y huellas 543 de 543), función `mp` subida, reloj andando y página TODO BIEN. La función contesta bien desde afuera: `npm run test:real-mp` 16 de 16. **Primera prueba real (ambiente de prueba de Mercado Pago) el 25/11: pago, confirmación, avisos firmados y devolución, todo bien** (ver «Cobro con Mercado Pago»); desde ese día el consultorio está en `mercadopago` / `prueba` y solo sirven tarjetas de prueba. **Producción activada el 25/11 a la tarde**, con las tres claves y los avisos reales comprobados; conectar una cuenta también anduvo (en esa prueba salió una orden de verdad en modo prueba: corregido y publicado). Falta: Yani como dueña, `interno.mp_pasar_a('puntoalmagro', 'real')`, que conecte su cuenta y un primer pago real chico. Lo lleva la sesión de Claude «Yanina Onzari página web (fork)»; si otra sesión necesita `web\index.html` o las funciones de pagos, que avise antes. Ver «Cobro con Mercado Pago» más abajo |
| Aviso de datos personales (Ley 25.326) | **Cargado y publicado el 25/11/2026.** Se lee sin entrar; hay que aceptarlo para pedir acceso y para reservar, y queda la constancia. Faltan: que lo revise una abogada y los datos de Yani (responsable, domicilio y mail). Ver «Aviso de datos personales» |
| Avisos por mail del consultorio (solicitud, reserva confirmada, recordatorio…) | **Andando desde el 20/11**: cola `avisos` → Resend, cada minuto (`…_mails.sql`, 5 pruebas). La clave está en el Vault de Supabase (`resend_api_key`). El primer mail real llegó a Recibidos de Gmail |
| Mails de registro (confirmar la cuenta, mandarlo de nuevo, olvidé mi contraseña) | **Hechos el 20/11** y publicados: ver «Los mails de registro» más abajo. «Confirm email» está **prendido** en Supabase. **«Olvidé mi contraseña» probado de verdad por Santiago el 20/11 a las 17:41**: el mail salió, llegó en menos de 20 segundos, el botón lo dejó adentro y apareció la pantalla de contraseña nueva (visto en los registros de Supabase: `recover` 200, `verify` 200). Puso la misma contraseña que tenía y Supabase la rechazó, como corresponde. **«Pedir acceso» con una cuenta nueva probado de verdad el 25/11** (mail, confirmación, pedido y aprobación). **Falta probar de verdad:** guardar una contraseña distinta |
| Fotos de boxes y máquinas | Falta (necesita el depósito de archivos del proyecto real); los botones de subir foto están escondidos |
| Facturas con ARCA | **«Facturar todo el mes» hecho y probado en la compu (23/11)**: base, función de Supabase y página, con dos revisiones de Codex (4 y 5). `npm test` 143 de 143, `test:pantallas` 103 de 103 y `test:arca` 10 de 10 contra el ambiente de prueba de ARCA. **Cargado en Supabase y publicado el 23/11** (control 15 / 0 / 33 / 27 / 5; página TODO BIEN; `yanina` en modo prueba). **Secretos de ARCA pegados por Santiago el 23/11 a las 12:26 y comprobados por huella (5 de 5). «Probar la conexión con ARCA» salió bien desde la página a las 12:37** (modo prueba: ARCA responde, ticket vigente, punto de venta 0001). Falta el PDF con QR |
| Copia de seguridad diaria | **Andando desde el 25/11/2026**: cada noche GitHub pide la copia, que sale cifrada, y la guarda 30 días; si falta, llega un mail. La primera se abrió y se restauró en la compu. Ver «Copia de seguridad» |
| Reglas de «Punto Almagro» (lo que respondió Yani) | **Cargadas y publicadas el 25/11/2026** (OK de Santiago: «Sí, todo»): lema, seña que no se devuelve, ningún turno señado sin pagar, cambiar un turno de día, datos de Yani y dirección `puntoalmagro.entreturno.com.ar` (la de yanina sigue andando y lleva ahí). Ver «Las reglas de Punto Almagro» |
| «Crear cuenta» desde el panel de la dueña | Falta. Hoy cada profesional se registra sola y la dueña la aprueba |
| Probarla en un celular real | Falta |

## Probar

```
npm install               (una sola vez)
npm test                  (247 pruebas: base de datos + conexión + ARCA simulado + Mercado Pago simulado + copia de seguridad; un minuto y medio)
npm run test:pantallas    (127 comprobaciones de la página en un Edge o Chrome sin ventana; al final dice dónde dejó las capturas)
npm run test:pantallas-mp (60 comprobaciones del cobro con Mercado Pago en la página: conectar la cuenta, pagar, rechazos, devoluciones)
npm run test:pantallas-almagro (33 comprobaciones de las reglas de Punto Almagro, con direcciones como las de verdad)
npm run test:real         (21 comprobaciones contra el proyecto real, sin entrar con ninguna cuenta: no cambia nada)
npm run test:real-mp      (16 comprobaciones de la función «mp» real, sin entrar con ninguna cuenta: no cambia nada)
npm run test:arca         (10 comprobaciones contra el ambiente de PRUEBA de ARCA: emite facturas de mentira; ver «Facturas con ARCA»)
npm run servidor          (la página andando en http://localhost:8092, con el consultorio de ejemplo «lavanda» y pagos de prueba)
node pruebas/huellas.mjs  (escribe una consulta de SOLO LECTURA que compara la base real, pieza por pieza, con las migraciones)
```

`huellas.mjs` no se conecta a ningún lado: se pega su consulta en el SQL Editor del proyecto real. Con `--hasta <migración>`
sirve para mirar, ANTES de cargar una migración nueva, que la base real sea la que se espera. El 25/11/2026 dio 456 de 456
antes de cargar Mercado Pago, 543 de 543 después, 590 de 590 con el aviso de datos personales, 594 de 594 con el modo prueba
corregido, 615 de 615 con la copia de seguridad y 651 de 651 con las reglas de Punto Almagro (lo único de más es
`public.rls_auto_enable`, que es de Supabase).

Para ver en la compu la página cobrando con el Mercado Pago simulado (en PowerShell):
`$env:PAGOS = 'mercadopago'; npm run servidor` (y `$env:MP_AMBIENTE = 'real'` para probar con la cuenta conectada).
Las «pantallas de Mercado Pago» de ese servidor son páginas propias (`/__mp/autorizar` y `/__mp/pagar`): no sale a internet.

Las pruebas usan un Postgres que corre adentro de Node (PGlite), preparado como lo deja Supabase. No tocan internet
ni ningún dato real. Las cuentas y la clave del servidor de prueba están en `pruebas\datos-de-ejemplo.mjs`.
Desde Claude: `preview_start` con el nombre `entreturno-boxes` abre esa misma página en el navegador de la app.

## Carpetas

- `supabase\migrations\` — la base: `…_tablas.sql`, `…_funciones.sql`, `…_mails.sql` y `…_reloj.sql` (este último solo en el proyecto real).
  `supabase\datos\` — el alta del consultorio de Yani. `supabase\control.sql` — control de permisos para el proyecto real.
  `supabase\mails\` — los textos de los mails de registro, que se cargan a mano en el panel de Supabase (tiene su LEEME).
- `publicar\armar_para_publicar.py` — arma `publicar\yanina\`, lo que se publica (lo corre Cloudflare solo en cada `push`).
  `publicar\comprobar_publicado.py` — después del `push`: baja la página como un navegador y avisa si algo no coincide.
- `web\index.html` — la página entera (estilos y lógica). `web\conexion.js` — lo único que habla con el servidor.
  `web\config.js` tiene la dirección y la clave pública del proyecto real (el servidor de prueba arma el suyo y no lo usa).
- `pruebas\sql\` — pruebas de la base. `pruebas\conexion.test.mjs` — de punta a punta por la red.
  `pruebas\pantallas.mjs` — la página en un navegador. `pruebas\servidor-local.mjs` — imita lo que se usa de Supabase.
- `supabase\functions\_compartido\arca.ts` — la conexión con ARCA (ticket y factura electrónica). Corre en Supabase (Deno) y en
  las pruebas (Node). `pruebas\arca.test.mjs` (sin internet) y `pruebas\arca-real.mjs` (contra el ambiente de prueba de ARCA).
- `supabase\functions\_compartido\facturar.ts` — «Facturar todo el mes» y «Probar la conexión con ARCA».
  `supabase\functions\facturar\index.ts` — la función de Supabase. `publicar\armar_funcion.mjs` la junta en un solo archivo
  (`publicar\funcion-facturar\index.ts`) para pegarla en el panel. `pruebas\arca-simulado.mjs` — un ARCA de mentira.
- `supabase\functions\_compartido\mp.ts` — lo que habla con Mercado Pago (pases, órdenes, devoluciones, firma de los avisos).
  `supabase\functions\_compartido\cobros.ts` — conectar la cuenta, cobrar, atender los avisos, devolver y el reloj.
  `supabase\functions\mp\index.ts` — la función de Supabase. `publicar\armar_funcion.mjs` también la junta en un solo archivo
  (`publicar\funcion-mp\index.ts`). `pruebas\mp-simulado.mjs` — un Mercado Pago de mentira.
- `referencia\` — la demo de la que se partió y `como-se-paso-la-demo.py` (qué se le cambió; se corrió una sola vez).
- `revisiones\` — los pedidos a Codex y sus respuestas.

## Publicar (y por qué los archivos llevan una marca)

**Desde el 25/11/2026 a las 11:13, un `push` a `main` ES la publicación.** Cloudflare (proyecto de Pages `entreturno-boxes`,
conectado a GitHub) arma la página y la publica sola en `puntoalmagro.entreturno.com.ar` y `yanina.entreturno.com.ar`. Ya no se sube nada a mano. Lo conectó la
sesión «Paso a paso» por pedido de Santiago; ese día se comprobó acá: 30 pedidos de 30 bien y todo igual a lo armado.

```
npm test · npm run test:pantallas · npm run test:pantallas-mp · npm run test:pantallas-almagro    (antes de subir)
   … si la página nueva necesita algo de la base o de una función: cargar Supabase PRIMERO y correr control.sql
python -X utf8 publicar\armar_para_publicar.py                   (arma publicar\yanina, para comparar después)
git pull --ff-only · git add -A · git commit -F <archivo> · git push
python -X utf8 publicar\comprobar_publicado.py --esperar         (espera hasta 3 minutos; tiene que terminar en TODO BIEN)
```

- Como subir es publicar, un cambio de la página se sube **con el OK de Santiago**, igual que antes hacía falta para publicar.
  Lo que no toca la página (LEEME, pruebas) se puede subir cuando se quiera: se publica otra vez lo mismo.
- Cloudflare corre `npm clean-install` antes de armar: si se agrega una dependencia, subir `package.json` y
  `package-lock.json` juntos. Si no coinciden, la publicación falla y queda en línea la anterior.
- Para volver atrás: en Cloudflare, proyecto `entreturno-boxes` → Deployments → la versión anterior → «Rollback» (sin probar
  todavía), o `git revert` del cambio y `push`.
- El proyecto viejo, `yanina-entreturno` (subida a mano), quedó sin dominio, de respaldo, con la página del 25/11 a las 10:53.
- En `entreturno-boxes.pages.dev` (la misma página con otra dirección) no andan «Facturar» ni Mercado Pago: las funciones solo
  aceptan `*.entreturno.com.ar`, `*-entreturno.pages.dev` y localhost. Para probar eso, usar la dirección real.


En la dirección propia (`*.entreturno.com.ar`), Cloudflare le dice al navegador que guarde **4 horas** los `.js`, aunque
el `_headers` del sitio pida lo contrario (en `…pages.dev` sí lo respeta). El 20/11/2026 eso rompió la primera prueba real:
Santiago tenía guardado un `conexion.js` de antes de los mails, la página nueva lo usó y «Olvidé mi contraseña» falló sin
llegar a salir de su compu. Por eso el index publicado pide `config.js?v=…` y `conexion.js?v=…` con una marca del contenido:
si el archivo cambia, cambia la dirección y el navegador lo baja de nuevo. El index mismo no se guarda nunca.
**Si se suma otro archivo a la página (estilos, imágenes que cambien), tiene que llevar la misma marca.**
Además, un error que no viene del servidor ahora se muestra como «Algo falló en la página. Recargala y probá de nuevo.»

## Seguridad, en corto

- Todas las tablas tienen RLS activado y ninguna política: desde la página no se lee ni se escribe ninguna tabla.
- La página solo puede llamar 24 funciones (lista al final de `…_funciones.sql`); cada una revisa quién llama y a qué
  consultorio pertenece. Sin sesión solo existe `portada`.
- Precios, seña y devoluciones se calculan siempre en la base, nunca con lo que manda la página.
- La base misma impide que dos reservas se pisen en un box o que una máquina esté en dos reservas a la vez.
- Otra profesional ve un horario ajeno como «ocupado»: sin nombre, servicio ni plata.
- Todo lo que cambia la agenda o los ajustes de un consultorio corre de a una operación por vez (`interno.candado`).
- En la página, todo texto que escribe una persona pasa por `esc(...)` antes de mostrarse (hay una prueba con nombres «con trampa»).
- Con Mercado Pago: la página nunca ve los pases de la cuenta del consultorio (están cifrados en el Vault); un aviso de
  Mercado Pago vale solo con su firma y aun así se vuelve a leer la orden antes de acreditar; y la página solo manda a pagar
  a direcciones de Mercado Pago.
- El enlace de los mails trae un código de un solo uso después del `#` (esa parte de la dirección no viaja a ningún servidor):
  la página lo saca de la barra apenas carga y lo canjea por la sesión. La contraseña nunca se guarda en el navegador.

## La regla de los saldos pendientes (pedido de Santiago, 20/11/2026)

Cada profesional puede tener hasta **2 turnos señados sin terminar de pagar** (cuentan los confirmados, los ya usados y los
que está por señar). Al llegar a ese número:

- si alguno de esos saldos es de un turno que **ya pasó**, no puede reservar nada hasta pagarlo;
- si está al día, puede seguir reservando, pero el turno nuevo lo paga **completo** (o salda uno antes).

El número lo elige la dueña en Configuración → «Seña y pago»: ninguno (desde el 25/11/2026: hasta terminar de pagar el que señó no reserva
otro, ni pagándolo entero; es lo que usa Punto Almagro), uno solo, 2, 3, 5 o sin tope
(`consultorios.max_saldos`). El saldo de un turno ya usado se puede pagar desde «Mis reservas», donde aparece arriba de todo.
La dueña ve en «Profesionales» quién debe y cuánto, y en el Inicio el total de saldos por cobrar.

## Los mails de registro (20/11/2026)

Son los que manda Supabase (no la cola `avisos`): salen por SMTP con Resend, como «Entreturno <avisos@entreturno.com.ar>».

Qué hace la página:

- **Pedir acceso**: la cuenta se crea, pero no entra hasta abrir el enlace del mail. La pantalla dice «Confirmá tu mail» y
  tiene «Mandarlo de nuevo». Los datos del pedido (nombre, profesión, categoría, teléfono, CUIT; nunca la contraseña) esperan
  en ese navegador 7 días (`et-pedido-<consultorio>`) y también quedan anotados en la cuenta (`user_metadata.pedido`):
  al volver del mail, en ese navegador o en otro aparato, el pedido de acceso sale solo. Si no se puede, la persona ve
  «Pedí acceso» y los completa de nuevo.
- **Ingresar sin haber confirmado**: muestra la misma pantalla, con «Mandarlo de nuevo».
- **Olvidé mi contraseña**: pide el mail, manda el enlace (dice lo mismo exista o no la cuenta) y, al volver, pide la
  contraseña nueva dos veces.
- **Un mail que ya tiene cuenta**: muestra lo mismo que con una cuenta nueva y no manda nada (así nadie puede averiguar
  quién tiene cuenta); la pantalla aclara: «Si ya tenías una cuenta con ese mail, no te va a llegar nada…».
- **Enlace usado o vencido**: lo explica y ofrece ingresar o pedir otro.
- **Enlace abierto donde ya hay una cuenta adentro**: no cambia de cuenta solo. Pregunta «Seguir con esta cuenta» o
  «Usar el enlace» (por si alguien manda un enlace de su propia cuenta para que otra persona cargue datos ahí).

Cómo es el enlace: `https://<consultorio>.entreturno.com.ar/#token_hash=…&type=email` (o `recovery`). Va a la página misma y
la página canjea el código (`POST /auth/v1/verify`). Así el mail muestra la dirección del consultorio y un filtro de correo
que «abre» los enlaces antes que la persona no lo gasta. La página también entiende los enlaces de fábrica de Supabase.

Lo configurado en el panel de Supabase (Authentication):

- Sign In / Providers: «Confirm email» prendido. Email: contraseña de 6 o más, el enlace vence en 1 hora (3600 s),
  «Secure password change» y «Require current password» apagados (si se prenden, hay que revisar «olvidé mi contraseña»).
- Emails → SMTP Settings: `smtp.resend.com`, puerto 465, usuario `resend`, la clave de Resend (la pegó Santiago).
- Emails → Templates: «Confirm sign up» y «Reset password» en castellano (`supabase\mails\`). Las demás, de fábrica.
- URL Configuration: Site URL `https://puntoalmagro.entreturno.com.ar` (desde el 25/11/2026); Redirect URLs: esa y la de yanina, solas y con `/**`.
  **Al sumar otro consultorio hay que agregar su dirección a Redirect URLs** (si no, sus mails llevarían a la página de Yani).
- Rate Limits: 30 mails de registro por hora en todo el proyecto y uno por minuto por persona. Resend gratis: 100 mails por día
  y 3.000 por mes, sumando avisos y registro.

Lo que falta de esto: la prueba real (cuenta nueva y «olvidé mi contraseña»), pasar a castellano las otras plantillas cuando se
usen, y prender el aviso «Password changed» (hoy apagado; su texto de fábrica está en inglés).

La revisión de Codex (`revisiones\respuesta-codex-3.md`), punto por punto:

1. Quién es la persona se sacaba de un pase sin revisar (enlaces de fábrica) → **corregido**: se le pregunta al servidor. Con prueba.
2. Un enlace ajeno cambiaba de cuenta sin avisar → **corregido** cuando ya hay alguien adentro (pregunta antes). Sin nadie adentro,
   el enlace entra, como en cualquier sistema con enlaces por mail; la pantalla siempre muestra con qué cuenta se está.
3. La página podía arrancar dos veces a la vez y gastar el mismo código → **corregido**: arranca de a una y toma el enlace una sola vez.
4. El pedido guardado se borraba ante una falla pasajera y no se limpiaba si ya había llegado → **corregido**.
5. Si la cuenta se creaba pero fallaba traer los datos, no se mostraba «Confirmá tu mail» → **corregido**.
6. Se podía averiguar si un mail tenía cuenta → **corregido** (respuesta igual en los dos casos). Con prueba.
7. ¿El código del enlace le llega al contador de visitas de Cloudflare? → **comprobado que no**: la página limpia la barra antes
   de que el contador cargue, y el contador borra de las direcciones lo que va después del `#` y del `?` (leído en su código,
   versión 2026.10.1; no se interceptó el envío en vivo).
8. Si se corta la conexión justo al canjear el código → queda la pantalla «Ese enlace ya no sirve», con ingresar o pedir otro.
9. Las plantillas → el seguimiento de clics de Resend no está configurado (los enlaces no se reescriben). Falta ver el mail real.
10. El servidor de prueba no demuestra el Supabase real → cierto: falta la prueba real.

Sin prueba automática todavía: los puntos 3, 4 y 5 (hacen falta cortes de red a propósito y dos pestañas).

## Lo que la página le pide al servidor

`servidor.rpc("<función>", { …parámetros })` agrega solo el consultorio (`p_slug`). Las funciones:

- Sin sesión: `portada`.
- Cualquiera con sesión: `foto` (todo lo que esa persona puede ver, con los mismos nombres que usaba la demo:
  `config`, `boxes`, `machines`, `users`, `blocks`, `releases`, `bookings`, `invoices`, más `site`, `me`, `now`, `today`),
  `pedir_acceso`, `reservar`, `simular_pago` (solo mientras no haya Mercado Pago), `cancelar_reserva`.
- Con Mercado Pago, la página no llama a la base para pagar: le pide a la función de Supabase `mp`
  (`servidor.funcion("mp", { accion })`) «pagar», «verificar», «despachar» y, la dueña, «conectar». La función usa por
  adentro `mp_pago_preparar`, `mp_pago_mio`, `mp_consultorio_mio` y `mp_conexion_iniciar`. La dueña llama directo
  `mp_conexion_confirmar`, `mp_desconectar` y `mp_devolucion_a_mano`.
- La dueña: `bloquear`, `publicar_rato`, `liberar_dia`, `quitar_rato`, `quitar_bloqueo`, `cambiar_estado_profesional`,
  `cambiar_categoria_profesional`, `guardar_turnos`, `guardar_pago`, `guardar_politica`, `guardar_reglamento`,
  `guardar_box`, `guardar_foto_box`, `guardar_categoria`, `quitar_categoria`, `guardar_maquina`, `quitar_maquina`,
  `guardar_facturacion`.

Cuando algo no se puede, la función corta con un código corto (`horario_no_disponible`, `maquina_no_disponible`,
`demasiadas_sin_pagar`, `demasiados_saldos`, `saldo_vencido`, `reglamento_cambio`, `pago_vencido`, `solo_admin`…):
la página lo traduce a un mensaje (`MENSAJES` en `web\index.html`).

Cómo trabaja la página:

- `cargar()` pide `foto` (o `portada` sin sesión) y deja todo en `S`, con la forma que tenía la demo. Lo de la pantalla
  (vista, pestañas, día elegido) va en `S.ui` y se guarda en el navegador.
- Cada cosa que cambia datos pasa por `accion(función, parámetros)`: llama a la base, vuelve a pedir la foto y devuelve
  la respuesta (o `null`, con el motivo en `ultimoError`, después de avisar con un cartel).
- Cada 30 segundos (5 minutos si la pestaña está escondida) vuelve a pedir la foto, para ver lo que hicieron las demás.
  No redibuja mientras hay una hoja abierta o alguien está escribiendo.
- Los boxes se nombran por su número (1, 2, 3); todo lo demás lleva un identificador largo.
- Cada reserva trae `deposit` (la seña que se le informó al reservar) y `categoryName`: se usan esos, no se recalcula.
- Las reservas ajenas llegan con `status: "ocupado"` y `userId: null`.
- El consultorio sale de la dirección (`puntoalmagro.entreturno.com.ar` → `puntoalmagro`). Fuera de `*.entreturno.com.ar` (la dirección de prueba de
  Cloudflare, la compu) es el que fija `config.js`.

## Facturas con ARCA (en curso desde el 23/11/2026)

**Cómo factura Entreturno.** Las facturas son de cada consultorio: salen con su CUIT y su punto de venta. Entreturno tiene
un solo certificado para todos, y cada consultorio le delega en ARCA el servicio «Facturación Electrónica»: no pasa su clave
ni saca certificado. Es el caso que ARCA llama «Tercerización del servicio» (`arca.gob.ar/ws/WSAA/ADMINREL.DelegarWS.pdf`).
Los pasos que hace la dueña (punto de venta para web services y delegación) y los de Santiago (aceptar y asignar el
certificado) están en la memoria de Claude: `entreturno-arca-facturacion`.

**Certificados y claves: FUERA del repositorio, en `C:\Users\santi\Desktop\ENTRETURNO - ARCA\`.** Nunca se suben acá.
- Prueba: `certificado-prueba.pem` + `clave-prueba.key`. En el WSASS el nombre quedó `entreturnoprueba`, sin guion, y está
  autorizado a `wsfe` con la CUIT de Santiago.
- Real: `entreturno_1aa114976aa71cea.crt` + `clave-real.key`, con el alias `entreturno`.
- Los dos vencen el 22/11/2028: hay que renovarlos antes.
- Los pedidos se rehacen con `GENERAR PEDIDOS DE CERTIFICADO.cmd`, que nunca pisa archivos.

**El ticket de ARCA dura 12 horas y ARCA no da otro mientras ese valga.** Por eso siempre se guarda y se reusa.
`npm run test:arca` lo guarda en `E:\Entreturno boxes\pruebas\arca\ticket-prueba.json` y anota las facturas de prueba
emitidas en `facturas-de-prueba.json`, al lado. Si otro programa pide un ticket con el mismo certificado, este lo pierde y
hay que esperar a que venza.

**Lo que hace `arca.ts`:**
- Pide el ticket (`obtenerTicket`, con el guardado de afuera) y consulta el estado de ARCA.
- Consulta el último número, las condiciones de IVA y los puntos de venta. Esto último sirve para comprobar una delegación sin
  emitir nada.
- Arma el comprobante en el orden exacto del WSDL y pide el CAE. Un rechazo vuelve como «R» con el motivo.
- Consulta un comprobante ya emitido.
- Valida todo antes de mandar:
  - la CUIT con su dígito verificador y el DNI;
  - que las fechas existan y que el turno y el vencimiento sean coherentes;
  - los importes en centavos, con el IVA del 21 % en A y B;
  - que la nota de crédito diga a qué factura corresponde y que la A vaya a una CUIT.
- `emitirComprobante` no factura dos veces:
  - **`antesDeEnviar(numero)`** es obligatorio: el número se anota en la base antes de mandarlo.
  - **Si ARCA no contesta o contesta algo raro**, busca el número. Si está y coincide en todo (`coincide`: fechas, turno,
    importes, documento, condición y factura asociada), lo toma. Si no, corta con «incierto» y **no reintenta**.
  - **Un pendiente** se concilia en la corrida siguiente, recién después de 3 minutos. Si ARCA lo tiene igual, se recupera.
    Si tiene otra cosa con ese número, o ya numeró más allá sin tenerlo, corta con «pendiente_no_coincide» y hay que
    mirarlo a mano. Si nunca llegó, se emite como nuevo.
  - **Si otro tomó el número** (error 10016), reintenta con el que sigue.
- El ticket se reusa mientras sirve. Si ARCA dice que ya dio uno, espera unos segundos a que la otra corrida lo guarde.
  Si no se puede guardar, reintenta y después lo avisa.

**Revisión de Codex (`revisiones/respuesta-codex-4.md`, 14 puntos):**
- **Corregido en el módulo, cada uno con su prueba:**
  - el reintento a ciegas después de un corte;
  - una comparación «es la nuestra» que se quedaba corta;
  - las respuestas vacías o raras, que pasaban por rechazos;
  - las carreras del ticket;
  - las fechas que no existen;
  - los importes A y B;
  - la nota de crédito sin factura asociada;
  - la CUIT sin dígito verificador;
  - las respuestas gigantes;
  - los mensajes de la librería de firma.
- **Queda para la base y la función de Supabase:**
  - un candado por numeración que respeten todos los que emiten;
  - el pedido congelado y su estado guardados antes y después de cada envío;
  - el ticket pedido de a uno por certificado;
  - el reloj del servidor en hora (Supabase lo tiene);
  - no registrar nunca el SOAP, el ticket ni las claves.
- **Sin probar:** que corra en Supabase (Deno). Se prueba al armar la función.
- **Decidido:** las respuestas se siguen leyendo con expresiones simples, y no con una librería de XML, porque son chicas y
  siempre iguales. A cambio, se valida la estructura y lo que importa.

**Reglas de ARCA que el sistema tiene que cumplir:**
- Desde el 1/12/2026, la condición frente al IVA de quien recibe la factura es obligatoria (manual WSFEv1 v4.8).
- Un alquiler de box es concepto «servicios»: lleva las fechas del turno y el vencimiento del pago.
- Con la RG 5866 (desde el 1/7/2026), la factura de un servicio va el día del cobro, aunque sea parcial, o el día en que
  termina, lo que pase antes. Con el pago por adelantado, eso es una factura por cada cobro, no una por mes. Falta que lo
  confirme el contador de Yani.
- Cada devolución lleva una Nota de Crédito asociada a su factura.

**«Facturar todo el mes» (hecho y probado en la compu el 23/11/2026; decisión de Santiago: una factura por mes):**
- Yani aprieta «Facturar todo el mes» en Facturación. Sale UNA Factura C por profesional con todas sus horas del mes: las
  reservas confirmadas o cumplidas, con sus máquinas. Es lo mismo que ya mostraba la pantalla.
- **Solo meses terminados** (`mes_en_curso`). La base lo exige, no solo la página.
- **Cada profesional tiene que tener CUIT válida y condición frente al IVA.**
  - Se piden en «Pedir acceso»: una lista de cuatro opciones (monotributista, responsable inscripta, exenta y consumidora
    final).
  - La dueña las corrige en Profesionales → «Cambiar».
  - A la que le falta algo no se le factura: queda aparte, sin frenar a las demás.
- **El consultorio tiene `fact_ambiente`:**
  - «apagado» (por defecto): el botón no se prende;
  - «prueba»: ARCA de prueba, con la CUIT del WSASS; no les llega a las profesionales y la página lo avisa;
  - «real».
  - **Se cambia solo desde el SQL Editor**, nunca desde la página.
- **Estados de cada factura:**
  - pendiente → incierta (número anotado, esperando a ARCA) → emitida / rechazada (con el motivo) / revisar (a mano).
  - Lo que va a ARCA queda congelado al preparar.
  - En real, a la profesional le llega un mail con el número y el CAE.
- **Reglas para no facturar dos veces (revisiones 4 y 5 de Codex):**
  - un candado por numeración;
  - el número se anota antes de mandarlo, y solo si el candado sigue siendo de esa corrida y lo congelado no cambió
    (`factura_cambio`, `candado_perdido`);
  - primero se concilian las «inciertas» de cualquier mes, y si alguna sigue en duda no sale ninguna otra;
  - el ticket se pide de a uno por ambiente.
- **Diferencias:** si después de facturar se agregan o cancelan turnos de ese mes, la pantalla lo marca («Cambió después»)
  y no dice «Todo facturado». **Qué hacer con eso (otra factura o una nota de crédito) lo tiene que decidir el contador.**
- **Ojo, RG 5866:** con el cobro por adelantado, la norma pide la factura al cobrar. La factura por mes la eligió Santiago:
  falta que la confirme el contador de Yani.

**Cómo se carga en Supabase (todo hecho el 23/11/2026; la función se subió por el editor del panel):**
1. **Base:** en el SQL Editor, `supabase\migrations\20261123100000_facturas_arca.sql`.
   - Tiene `drop table facturas` y `drop function`: el editor pide confirmar.
   - Si `facturas` no está vacía, la migración corta sola.
   - Después, `supabase\control.sql`, que tiene que dar f_public 33, con_sesion 27 y arca_solo_servicio 5.
   - Está probada sobre una base con datos como los de Yani (`pruebas\sql\migracion-sobre-datos.test.mjs`).
2. **La función:**
   - Correr `node publicar\armar_funcion.mjs`.
   - En el panel: Edge Functions → «Deploy a new function» → «Via Editor», con el nombre `facturar` y pegando
     `publicar\funcion-facturar\index.ts`.
   - Después, **apagar «Enforce JWT verification»**. La base revisa el pase en cada llamada.
3. **Secretos** (Edge Functions → Secrets). **Los pega Santiago** con `Desktop\ENTRETURNO - ARCA\COPIAR PARA SUPABASE.cmd`:
   - `ARCA_PRUEBA_CERT`, `ARCA_PRUEBA_CLAVE` y `ARCA_PRUEBA_CUIT` (la CUIT del WSASS, sin guiones);
   - `ARCA_REAL_CERT` y `ARCA_REAL_CLAVE` (se usan cuando el consultorio pasa a `real`).
   - Se pueden pegar en una sola línea: `normalizarPem` los arregla.
   - **Pegados los 5 el 23/11/2026 a las 12:26.** Para comprobarlos sin ver los valores: el panel muestra la huella
     SHA-256 de cada uno y se compara con la de los archivos de `Desktop\ENTRETURNO - ARCA`. Dieron 5 de 5. El campo pasa
     los saltos de Windows a LF, y la clave de prueba quedó con un renglón en blanco de más al final, que no importa
     (`normalizarPem` lo saca; se comprobó firmando con los valores tal como quedaron).
4. **Página:** publicar como siempre (ver «Publicar»).
5. **Prueba:**
   - `update consultorios set fact_ambiente = 'prueba' where slug = 'yanina'`.
   - Santiago, como Soporte: Configuración → «Probar la conexión con ARCA».
   - **Salió bien el 23/11/2026 a las 12:37:** «Modo prueba · ARCA responde · Acceso con el certificado de Entreturno,
     vigente hasta el 24 nov 00:36 · Punto de venta 0001 · Último número emitido: 4» (los 4 son las Facturas C de prueba
     de `npm run test:arca`).
   - Se esperaba `ticket_perdido` hasta las 22:54, porque el ticket que había pedido `npm run test:arca` a la mañana
     seguía vigente. Pero el ARCA de prueba le dio a la función uno nuevo igual. El manual dice que no da otro mientras
     el anterior vale, así que la función guarda el ticket en la base y lo reusa.
   - Para facturar de verdad, cuando Yani delegue: `fact_ambiente = 'real'` y su CUIT y su punto de venta para web services
     en Configuración.

**Lo que sigue, en orden:**
1. ~~Cargarlo en Supabase y publicar~~: hecho el 23/11/2026, con los secretos comprobados y la conexión probada.
2. La respuesta del contador de Yani:
   - ¿una factura por mes le sirve, o tiene que ser por cobro?
   - ¿qué se hace con los turnos que cambian después de facturar?
3. El comprobante para la profesional: PDF con el QR que pide ARCA, que se manda por mail. Hoy le llega un mail con el
   número y el CAE, y la factura se ve en «Mis Comprobantes» de ARCA.
4. Cuando Yani delegue:
   - Santiago acepta y asigna el certificado;
   - «Probar la conexión» en real tiene que mostrar su punto de venta;
   - recién ahí, la primera factura real.

## Cobro con Mercado Pago (hecho el 24/11/2026; cargado en Supabase y publicado el 25/11/2026, con el consultorio todavía en pagos de prueba)

**Cómo cobra Entreturno.** Cada consultorio cobra en SU cuenta de Mercado Pago. La dueña la conecta autorizándola desde
Mercado Pago (no pasa ninguna clave) y la plata de las reservas entra directo ahí. Entreturno no la toca ni cobra comisión.
La aplicación de Mercado Pago se llama «Entreturno» y está en la cuenta personal de Santiago (creada el 18/11/2026, con
Checkout Pro y «API de Orders»); por esa cuenta no pasa la plata de ningún consultorio.

**Lo que se usa de Mercado Pago** (leído en mercadopago.com.ar/developers el 24/11/2026; el resumen está en la cabecera de `mp.ts`):
- Conectar la cuenta: OAuth con PKCE. La dueña va a `auth.mercadopago.com.ar/authorization` y vuelve a la función con un código
  que se cambia por los pases (`POST /oauth/token`). El pase dura 180 días y se renueva solo.
- Cobrar: Checkout Pro por la API de Orders. `POST /v1/orders` devuelve `checkout_url`, que es a donde va a pagar la profesional.
- Enterarse: Mercado Pago avisa a la función (webhook del evento «Order (Mercado Pago)», firmado con `x-signature`).
- Devolver: `POST /v1/orders/{id}/refund`, entero o una parte. Necesita saldo disponible en la cuenta de la dueña.

**El recorrido de un pago:**
1. La profesional aprieta «Ir a pagar». La página le pide a la función `mp` la acción «pagar».
2. La base revisa todo (`mp_pago_preparar`: de quién es la reserva, cuánto, hasta cuándo) y deja anotado el intento.
3. La función crea la orden en Mercado Pago con el pase del consultorio y devuelve la dirección de pago. La página manda ahí.
4. La profesional paga y vuelve a la página, que le pregunta al servidor cómo quedó («verificar»).
5. Mercado Pago avisa a la función. La función NO le cree al aviso: lee la orden en Mercado Pago y comprueba que sea de ese
   pago (referencia), de esa cuenta, en pesos y por el importe esperado. Recién ahí la base confirma la reserva.
   Si el aviso no llega, lo resuelven «verificar» o el reloj.

**Casos que no pueden quedar mal (cada uno con su prueba):**
- Un aviso repetido no acredita dos veces. Un aviso sin firma válida, o firmado hace más de dos días, no se mira.
- Del aviso viene firmado solo el número de la orden: ni el tipo ni el cuerpo. Por eso un aviso de «esta cuenta le quitó
  el permiso a la aplicación» tampoco se cree: se prueba el pase de esa cuenta.
- La cuenta no se puede sacar ni cambiar por otra mientras tenga cobros abiertos o devoluciones esperando. Reconectar la
  misma sí. Cada pago guarda en qué cuenta se cobró, y nunca se intenta devolver con otra.
- Un pago que llega con el plazo vencido: si el horario sigue libre, la reserva revive; si no, la plata se devuelve entera.
- Un pago repetido, o de una reserva que la persona canceló mientras pagaba: se devuelve entero («sobrante»).
- Si el importe, la moneda, la cuenta o la orden no coinciden: no se acredita nada y queda «para revisar» (aviso a la dueña).
- Si se corta al crear la orden, repetir el pedido no crea otra (misma clave). Si Mercado Pago la rechaza, el próximo va con otra.
- Una devolución se anota antes de pedirla, la toma una sola vuelta por vez (un minuto y medio) y cada parte tiene una
  clave fija: repetirla no devuelve dos veces.
- Si la cuenta de la dueña no tiene saldo, la devolución queda esperando, se reintenta (a los 10 minutos las primeras
  veces, después cada 6 horas, sin fecha de abandono) y la dueña recibe un mail, que se repite una vez por semana.
  Desde Pagos puede apretar «Intentar ahora» o, si ya hubo un intento fallido, «Ya la devolví yo» (le pide que mire antes
  en su Mercado Pago que no haya salido sola).
- Nada queda «pendiente» para siempre: una orden que no se pudo consultar en 3 días pasa a «revisar» y la dueña recibe un mail.
- Si Mercado Pago rechaza el pase, se renueva en el momento; si no se puede (la dueña le quitó el permiso a la
  aplicación), la cuenta queda «caída», no se cobra y la dueña recibe un mail para conectarla de nuevo.

**La cuenta del consultorio:**
- La conecta solo la dueña, desde Configuración → «Mercado Pago». El código que va y vuelve sirve una vez y 15 minutos.
- Queda «por confirmar» hasta que la dueña mira en la página qué cuenta es (nombre, mail y número) y dice «Sí, es mi cuenta».
  Recién ahí se cobra con ella. Así nadie puede hacer que un consultorio cobre en una cuenta que la dueña no eligió.
- Los pases se guardan cifrados en el Vault de Supabase (`mp_acceso_<consultorio>` y `mp_renovar_<consultorio>`),
  no en una tabla. La página nunca los ve.

**Ambientes, por consultorio** (se cambian solo desde el SQL Editor, nunca desde la página):
- `pagos_modo`: «simulado» (el pago de prueba de siempre, sin Mercado Pago) o «mercadopago».
- `mp_ambiente`: «prueba» (órdenes de prueba: tarjetas de prueba, no se mueve plata; se cobra SIEMPRE con el pase de prueba de la
  aplicación, haya o no una cuenta conectada) o «real». Una cuenta conectada en un ambiente no sirve para el otro.
- Se cambia con `select interno.mp_pasar_a('puntoalmagro', 'real');` (o `'prueba'`), **nunca con un update a mano**. No deja si quedan
  cobros abiertos o sin cerrar en Mercado Pago, devoluciones sin salir, pagos para revisar, reservas esperando el pago, o turnos por
  venir pagados en el otro modo. Después, la dueña conecta su cuenta.
- **En modo prueba la cuenta conectada no cobra:** sirve para ensayar la conexión. Y una orden que no es del modo del consultorio
  (las de prueba se numeran ORDTST…) se cierra enseguida, no se le muestra a nadie y la base no la deja anotar ni aprobar. Si quedara
  abierta una del otro modo, su enlace no se entrega más: pasa a «revisar».

**El reloj.** Cada minuto la base mira si hay algo para hacer (`interno.mp_reloj`): órdenes abiertas cuyo aviso no llegó,
órdenes viejas para cerrar, devoluciones que esperan, pases que vencen en menos de 30 días. Si hay, despierta a la función
con una clave que vive en el Vault. Si no hay nada, no llama a nadie.

**Primera prueba contra el Mercado Pago de verdad, en su ambiente de prueba (25/11/2026): salió bien de punta a punta.**
- En la aplicación «Entreturno» (panel de Mercado Pago, cuenta de Santiago, con su OK y su código): URL de redireccionamiento,
  PKCE y webhooks del ambiente Prueba («Order (Mercado Pago)» y «Vinculación de aplicaciones»). Secretos pegados por él:
  `MP_PRUEBA_TOKEN` y `MP_WEBHOOK_SECRETO`. Consultorio en `pagos_modo = 'mercadopago'`, `mp_ambiente = 'prueba'` (con su OK).
- **El orden en el panel importa: primero «Activar credenciales» de Prueba y después guardar los webhooks.** Al revés, la firma
  secreta no se genera: el ojito queda apagado, los 64 puntitos que se ven NO son la firma (se copiaron por error y se detectó
  comparando la huella del secreto), «Simular notificación» falla (`getWebhookSecret` 404) y Mercado Pago no manda ningún aviso.
  Se arregla tocando «Guardar» otra vez.
- «Pedir acceso» con una cuenta nueva: llegó el mail, se confirmó, el pedido apareció solo y se aprobó. (Estaba pendiente.)
- La orden se creó en 2 segundos (`ORDTST…`) y `PT15M` fue aceptado (no quedó marcada sin vencimiento).
- **Para pagar en la prueba: ventana de incógnito, sin sesión de Mercado Pago, y el mail `test@testuser.com`.** Con otro mail
  dice «No podés pagar con un e-mail corporativo de Mercado Libre»; con la sesión de una persona real, «Una de las partes con
  la que intentás hacer el pago es de prueba». (La guía de Checkout Pro dice que sirve cualquier mail: no es así.)
- Pago de $ 50.000 aprobado: al volver, la página preguntó y la reserva quedó confirmada (12:22:09), con su mail.
- Aviso simulado desde el panel, con un importe falso de 100.000: la función lo aceptó por la firma, releyó la orden y no
  acreditó nada de más (un solo pago de 50.000).
- Cancelada como Soporte a las 12:43:07: la devolución entera salió sola a las 12:44:03 (el reloj) y llegaron 4 avisos reales
  («MercadoPago WebHook v1.0 order»), los 4 contestados 200: **la firma de los avisos de verdad se comprueba bien.**

**Segunda prueba (25/11/2026 a la tarde, con el OK de Santiago: «Sí, sigamos»): producción activada y la conexión ensayada.**
- Producción activada por Santiago en la aplicación (rubro «Servicio de informática», `entreturno.com.ar`). Avisos de producción
  guardados en el panel (misma dirección, «Order» y «Vinculación de aplicaciones»); la firma se generó bien.
- Secretos pegados por él y comprobados por huella: `MP_CLIENT_ID`, `MP_CLIENT_SECRET` (32 letras) y `MP_WEBHOOK_SECRETO_REAL`.
- **Firma de producción comprobada:** «Simular notificación» en producción, contestado 200 (14:08:45). `test:real-mp` TODO BIEN.
- **Conectar una cuenta: anduvo** con la cuenta de Santiago, en modo prueba (autorizar, volver, ver la cuenta y confirmarla).
  `auth.mercadopago.com` muestra antes una pantalla para elegir el país: ahora se usa la de Argentina, que va directo.
- El aviso de datos se aceptó con una cuenta de verdad (14:18) y quedó la constancia en «Profesionales».
- **Salió mal y se corrigió: en modo prueba se creó una orden DE VERDAD** (`ORD01…`, $ 50.000, en la cuenta de Santiago). Nadie la
  pagó (Mercado Pago rechazó al comprador de prueba: «una de las partes es de prueba») y se cerró sola a las 14:35. Por qué: el pase
  que da Mercado Pago con `test_token` no sirve para las órdenes; el sistema lo renovó solo y el renovado vino real. La cuenta se
  desconectó a las 14:37. Corrección: `20261125120000_prueba_de_verdad.sql`, la función `mp` y los textos de la página (detalle en
  «Ambientes», arriba).
- **Corrección cargada y publicada el 25/11 a las 15:22** (con el OK de Santiago: «Sí, cargala»; `23b5fdb`): base (control 15 / 0 / 61 /
  `public.portada` / 36 / 5 / 19 / false / 0 / 0, huellas 594 de 594), función `mp` (51.688 caracteres, huella `6ffb485db8ea`, «Verify
  JWT» apagado) y página TODO BIEN. En la base real, con una prueba que se deshizo sola: con una cuenta conectada en prueba el pase no se
  entrega ni se renueva, una orden de verdad no se anota, y no se puede pasar a real con algo abierto. En la compu: `npm test` 219 de
  219, pantallas 127 y 60, y roturas a propósito: las 26 de esta corrección y las 37 de antes, todas detectadas.
- Revisión 8 de Codex (7 puntos): 1, 2, 3, 4 y 5 corregidos (enlaces del otro modo, qué mira el cambio de modo, candado del consultorio
  al preparar un pago); 6 en parte (si la orden equivocada no se deja cerrar, queda anotado su número; nadie tiene la dirección); 7 con
  pruebas, menos las de dos conexiones a la vez, que acá no se pueden hacer.
- No se repitió la compra con una cuenta conectada: sin el pase de la cuenta, es el mismo camino que anduvo a la mañana.

**Lo que todavía NO se comprobó contra el Mercado Pago de verdad:**
- Que un pago se acredite solo con el aviso, sin volver a la página (esta vez la página preguntó antes).
- El cuerpo exacto de la devolución de una parte y el texto del error cuando la cuenta no tiene saldo.
- Conectar una cuenta en modo real, cobrar de verdad con ella, que los avisos de sus órdenes lleguen a la aplicación, y el aviso de
  «le quitó el permiso».
- Si Mercado Pago acepta direcciones de vuelta que no sean https (en la compu son http://localhost).

**Encontrado en esa prueba y corregido el mismo día** (con el OK de Santiago: «cargalo en supabase githbu y donde sea necesario
para que se vea en linea»; base cargada y comprobada, 543 de 543; función `mp` nueva, 49.711 caracteres, huella `9daa1f88c4a6`):
1. El mail «Recordatorio: mañana tenés…» salió para un turno del MISMO día, al minuto de confirmarlo. Ahora
   (`…25100000_recordatorio.sql`) quien reserva con menos de un día de anticipación no recibe recordatorio (le acaba de llegar
   «Reserva confirmada») y el texto dice «hoy» o «mañana» según la fecha.
2. La hoja de pago en modo prueba dice que se paga sin entrar a Mercado Pago y con el mail `test@testuser.com`.
3. La función acepta dos firmas: `MP_WEBHOOK_SECRETO` (ambiente Prueba) y `MP_WEBHOOK_SECRETO_REAL` (Producción); alcanza con
   una. Y un secreto que son solo puntitos cuenta como que falta, para que no vuelva a pasar lo de esa mañana.
Con pruebas: `npm test` 201 de 201, pantallas 103 y 57, y 6 roturas a propósito, las 6 detectadas.

**Cómo se carga en Supabase (hecho el 25/11/2026 con el OK de Santiago, «Sí, cargalo»; lo que falta está marcado):**

Qué se hizo el 25/11 y cómo dio:
- Antes de tocar nada: huellas 456 de 456 (la base real era exactamente la de las migraciones hasta ARCA) y datos casi vacíos:
  1 consultorio (`pagos_modo` simulado), 1 persona, 0 reservas, 0 pagos, 0 facturas.
- Base cargada sin errores (el editor avisa «destructive operations» por `drop constraint`: es la regla de estados de `pagos`,
  que se reemplaza en el mismo archivo). Control: 15 / 0 / 59 / `public.portada` / 34 / 5 / 19 / false / 0 / 0. Huellas 543 de 543.
- El Vault de verdad guarda, cambia, lee y borra los pases (probado con valores inventados en un bloque que se deshace solo).
- Como la dueña, en otro bloque que se deshace: `foto` trae `config.mp` (simulado, prueba, sin cuenta), conectar la cuenta
  desde la página de Yani anda, desde otro sitio da `dato_invalido`, pagar da `pagos_simulados` y las funciones del servidor
  dan «permission denied».
- Función `mp` subida por el editor del panel (48.788 caracteres, huella `de7ab8698ad3`, igual a `publicar\funcion-mp\index.ts`).
  Supabase la crea con «Verify JWT with legacy secret» prendido, que deja afuera a la página, a los avisos y al reloj: **se apagó
  con el OK de Santiago** («Sí, apagalo»). La función revisa por su cuenta a cada uno (sesión, firma o clave del reloj).
- Desde afuera, con la función real: `npm run test:real-mp` 16 de 16 (sin sesión, pase inventado, clave pública, otro sitio, firma
  inventada y reloj inventado: a todos les dice que no). Sin los secretos de Mercado Pago los avisos dan 500 «falta_configurar».
- Reloj cargado: tarea `entreturno-boxes-mp`, cada minuto, corridas «succeeded», 0 pedidos en cola (no hay nada para hacer). Con
  un pedido a mano desde la base (`net.http_post` con la clave del Vault) la función contestó 200 y todo en cero: el camino
  base → función → base anda en el Supabase real.
- Página publicada a las 10:53 (Cloudflare `yanina-entreturno`): TODO BIEN, 6 de 6, y sin errores al abrirla como visitante.

Los pasos, para otra vez:
1. **Base:** en el SQL Editor, `supabase\migrations\20261124100000_mercadopago.sql`. No borra nada: agrega columnas, tablas
   de adentro y funciones, y reemplaza `j_sitio`, `j_config`, `j_reserva` y `cancelar_reserva`. Está probada sobre una base
   con datos como los de Yani (`pruebas\sql\migracion-sobre-datos.test.mjs`). Después, `supabase\control.sql`, que tiene que
   dar f_public 59 (58 + `rls_auto_enable`), con_sesion 34, arca_solo_servicio 5, mp_solo_servicio 19 y mp_tablas_abiertas 0.
   La página que está publicada hoy (la vieja) sigue andando igual con la base nueva: lo que cambia en lo que recibe son
   datos que se agregan. Si hubiera que volver atrás: el consultorio sigue en pagos de prueba, así que alcanza con volver a
   cargar `j_sitio`, `j_config`, `j_reserva` y `cancelar_reserva` de las migraciones anteriores; lo nuevo puede quedar.
2. **La función:** `node publicar\armar_funcion.mjs` y, en el panel, Edge Functions → «Deploy a new function» → «Via Editor»,
   con el nombre `mp`, pegando `publicar\funcion-mp\index.ts`. Después, **apagar «Enforce JWT verification»**.
3. **El reloj:** en el SQL Editor, `supabase\migrations\20261124100100_reloj_mp.sql` (la dirección de la función, la clave
   del reloj y la tarea de cada minuto).
4. **Secretos** (Edge Functions → Secrets). **Los pega Santiago**: `MP_CLIENT_ID`, `MP_CLIENT_SECRET`,
   `MP_WEBHOOK_SECRETO` y `MP_PRUEBA_TOKEN`. Los pasos están en `C:\Users\santi\Desktop\MERCADO PAGO - lo que tenés que hacer vos.txt`.
5. **Página:** publicar como siempre (ver «Publicar»). Con `pagos_modo = 'simulado'` la página nueva se comporta igual que hoy,
   más la tarjeta «Mercado Pago» en Configuración.
6. **Prueba:** `update consultorios set pagos_modo = 'mercadopago', mp_ambiente = 'prueba' where slug = 'yanina'` y una
   reserva con una tarjeta de prueba de Mercado Pago (titular «APRO», DNI 12345678). Después cancelarla y ver la devolución.
   Recién con eso andando, la cuenta real de Yani y `mp_ambiente = 'real'`.

**La revisión de Codex (`revisiones\respuesta-codex-6.md`, 14 puntos), punto por punto:**
1. La firma del aviso no cubre el tipo ni el cuerpo → **corregido**: el aviso de «le quitaron el permiso» ya no tira una
   cuenta (se prueba el pase), y una firma de más de dos días no vale. Con prueba.
2. Dos operaciones sobre el mismo pago se podían trabar entre sí (candados en distinto orden) → **corregido**: siempre
   consultorio → reserva → pago. **Sin prueba automática**: el Postgres de las pruebas tiene una sola conexión.
3. Cambiar o sacar la cuenta dejaba cobros y devoluciones sin poder resolverse → **corregido** (ver arriba). Con pruebas.
4. Una orden creada cuya respuesta se pierde y cuyo intento vence queda sin anotar → **analizado, sin cambio de fondo**:
   sin la dirección de pago nadie puede pagarla (la página nunca la recibió). El intento se cierra solo, y si Mercado Pago
   avisa de esa orden se la reconoce por nuestra referencia. No se agregó buscarla en Mercado Pago (no se pudo comprobar cómo contesta).
5. Dos vueltas del reloj podían tomar la misma devolución, y «ya estaba devuelta» se decidía por el total → **corregido**:
   una vuelta por vez, y se compara contra lo que la base tenía anotado como devuelto de ese pago. Con pruebas.
6. Marcar «a mano» una devolución mientras salía la automática → **corregido**: no se puede mientras está tomada, el botón
   aparece recién después de un intento fallido y pide mirar antes en Mercado Pago. Con pruebas.
7. Había plazos después de los cuales se dejaba de mirar sin avisar → **corregido** (ver arriba). Con pruebas.
8. La vuelta de conectar la cuenta podía mandar a cualquier sitio → **corregido**: solo páginas de Entreturno. Con prueba.
9. Se confirmaba «la cuenta que haya» → **corregido**: se confirma la que la dueña vio en pantalla. Con prueba.
10. En producción se aceptaba una pantalla de pago en localhost → **corregido**. Con prueba.
11. `PT15M` sin comprobar → sigue sin comprobar; una orden creada sin vencimiento queda marcada y la cierra el reloj.
12. y 13. Probar con cuentas reales y sobre el proyecto real → es lo que sigue.
14. Código en el nombre o el mail de la cuenta, o en la dirección de vuelta → hay una prueba de pantalla: se muestran como texto.

Además, las propias pruebas se probaron: se rompieron a propósito 22 reglas, de a una, en una copia del proyecto (12 del
diseño y las 10 que salieron de la revisión 6), y las 22 se detectaron (24/11/2026; la primera vez se escapó una, la de
«el cobro es justo el de ese pago», y se le agregó su prueba). El programa que las rompe no está en el repositorio: es
`E:\Entreturno boxes\pruebas\mutar.mjs`, y trabaja sobre la copia `E:\Entreturno boxes\pruebas\copia-para-romper`.

**El orden al publicar: primero Supabase, después el `push`** (que es la publicación; ver «Publicar»). El 25/11/2026 se hizo así:
base, función `mp`, reloj, página (la última subida a mano, 10:53) y `push`. A las 11:13 la dirección pasó al proyecto que
publica solo.

**Mejora menor pendiente:** el patrón `*-entreturno.pages.dev` que aceptan las funciones sirve para cualquier proyecto de Pages
cuyo nombre termine así, también de otra cuenta de Cloudflare. Con eso solo no se puede hacer nada (hace falta el pase de la
persona), pero es más prolijo poner la lista exacta de direcciones propias. Si se cambia, va en las dos funciones y en el
control de `volver_a` de la tabla `interno.mp_estados`.

**Limitaciones conocidas (para decidir más adelante):**
- No hay ninguna prueba con dos conexiones a la vez (reservar, cancelar y un aviso de pago en el mismo instante): hay que
  hacerla en el Supabase real.
- Si la dueña devuelve plata desde Mercado Pago de una reserva que sigue en pie, o hay un contracargo, el sistema hoy no
  se entera solo: la reserva sigue figurando como pagada. (Sí se entera si después cancela la reserva: ve que ya está devuelta.)
- No se limita la cantidad de cuotas ni se ofrecen cuotas sin interés: vale lo que tenga la cuenta de la dueña.
- Efectivo (Rapipago, Pago Fácil) y cajero están excluidos: tardan días y el turno se guarda unos minutos.
- El mail de la profesional viaja a Mercado Pago al crear el cobro en modo real (para que su pantalla lo traiga cargado).
  El aviso de datos personales lo nombra.
- Prender el cobro de verdad (`pagos_modo`) lo hace Entreturno por SQL, no la dueña. Al sumar consultorios conviene un botón.

## Aviso de datos personales (cargado en Supabase y publicado el 25/11/2026, con el OK de Santiago: «Sí, publicalo»)

- **Versión vigente: la 2** (`20261125140000_aviso_v2.sql`, cargada el 25/11 con la copia de seguridad): nombra a GitHub, la copia cifrada en
  Estados Unidos y los 30 días. Lo demás no cambia. Quien aceptó la 1 tiene que aceptar la 2 al entrar.
- Lo promete el convenio (11.4). Base: `20261125110000_privacidad.sql` (texto con versión, huella, constancia en
  `interno.consentimientos`, `pedir_acceso` con dos datos más, `aceptar_privacidad`, `guardar_privacidad`; `reservar` lo exige).
  Página: dos casilleros al pedir acceso, el aviso para leer sin entrar, la pantalla que lo pide a quien ya tenía cuenta o si hay
  versión nueva, la constancia en «Profesionales» y los datos del responsable en Configuración → «Datos personales».
- Fuentes leídas el 25/11 en argentina.gob.ar: Ley 25.326 (artículos 5, 6, 12, 14 y 16), Decreto 1558/2001 (artículo 12),
  Resolución AAIP 14/2018 (el texto de la Agencia, tal cual) y la lista de países (Disposición 60/2016 y Resolución 34/2019:
  Brasil y Estados Unidos no están). **Falta que lo revise una abogada.**
- **Publicado el 25/11 a las 13:41** (`a4e3d4f`), primero la base y seguido la página. Antes: huellas 543 de 543. Después: control
  15 / 0 / 61 / `public.portada` / 36 / 5 / 19 / false / 0 / 0 y huellas 590 de 590. Con una prueba en la base real que se deshizo
  sola (no quedó ninguna constancia): la visitante lee el aviso y no puede aceptarlo; la profesional de prueba no puede reservar
  sin aceptarlo, se la rechaza sin la huella, sin el segundo casillero o con otra huella, no puede cambiar los datos del aviso, y
  al aceptar queda anotado con el mismo texto. Página TODO BIEN (6 de 6), `test:real` 12 de 12 (4 nuevas, del aviso) y
  `test:real-mp` TODO BIEN; vista como visitante en la compu y en tamaño celular (375 de ancho), sin errores.
  En la compu: `npm test` 211 de 211, pantallas 127 y 57, y 9 roturas a propósito, las 9 detectadas.
- Quien ya tenía cuenta lo acepta la próxima vez que entra. **Falta verlo con una cuenta de verdad** (aceptarlo desde la página).
- Para cambiar el texto: un renglón NUEVO en `interno.privacidad` con la versión que sigue; nunca editar el viejo.
- Falta: los datos de Yani (responsable, domicilio y mail: Configuración lo avisa), un procedimiento de baja (hoy el borrado es a
  mano) y, si corresponde, inscribir la base en el registro (es de la Doctora).
- Revisión 7 de Codex (10 puntos): corregidos 2, 4 (el comentario), 5 y 6 (el texto dice lo que el sistema hace), 7, 8, 9 y 10;
  1 y 3 sin cambio de fondo: la constancia prueba que esa cuenta mandó su aceptación de ese texto, no que lo haya leído.

## Copia de seguridad (cargada y andando desde el 25/11/2026, con el OK de Santiago: «Sí, cargalo así»)

El convenio promete una copia por día y que se borren a los 30 días como mucho. El plan gratis de Supabase no hace ninguna.

**Cómo es.** Todas las noches (03:23, con la demora que tenga GitHub) el flujo `.github/workflows/copia-diaria.yml` le pide la copia a la
función `copia` de Supabase, con la clave `COPIA_CLAVE`. La función le pide los datos a la base (`copia_datos`: todo en una sola foto), los
cifra con las llaves PÚBLICAS de `supabase/functions/_compartido/copia-llaves.ts` y entrega el archivo cerrado. GitHub comprueba que llegó
igual, lo guarda 30 días («Artifacts» de esa corrida) y le confirma a la base que lo guardó (`copia_guardada`).
- **Quién la puede leer:** solo quien tenga una llave privada y su frase. Ni GitHub, ni quien consiga `COPIA_CLAVE`, ni Supabase.
- **Las llaves:** `copia/generar-llave.mjs`, en la compu de cada dueño. La privada queda con él (protegida con una frase de seis palabras);
  la pública va al proyecto. Hoy hay una, la de Santiago (`santiago-aab9c821`; archivos en `Desktop\ENTRETURNO - COPIAS` y en
  `E:\Entreturno boxes\copias`). **Conviene una segunda, de Tomás o Iván:** generan la suya, mandan SOLO la pública, se agrega a
  `copia-llaves.ts`, se vuelve a armar y subir la función. Si se pierden todas las llaves o las frases, las copias no se abren más.
- **Qué no va en la copia:** los pases de Mercado Pago y la clave de los mails (viven en el Vault), el ticket de ARCA, los candados y los
  intentos de conexión, y los códigos de los mails de registro. Una columna nueva hace fallar una prueba hasta que alguien la revise
  (`pruebas/copia-columnas.txt`).
- **El vigía** (`interno.copias_vigilar`, reloj `entreturno-boxes-copia`, minuto 47 de cada hora): si hace más de 30 horas que GitHub no
  confirma una copia guardada, manda un mail por día a la dirección de `interno.ajustes` «mail_soporte». También avisa, una vez por
  semana, si los datos pasan los 15 MB (esta forma de copiar anda bien hasta unos 40: son los límites de la función y 8 segundos de la API;
  después, copias por partes o el plan pago de Supabase). Hoy pesan 33 KB. GitHub además avisa por mail si el flujo falla.

**Probar una copia** (cada tres meses): GitHub → Actions → «Copia diaria» → la corrida → «Artifacts» → bajar el `.ecopia` y arrastrarlo sobre
`Desktop\ENTRETURNO - COPIAS\3 - PROBAR UNA COPIA.cmd` (`node copia/abrir.mjs <archivo>`). Pide la frase, la abre, la carga en una base nueva
en la memoria de la compu (con las migraciones y las tablas de cuentas como las de Supabase), la compara fila por fila y abre cada
consultorio con su dueña. No escribe datos en el disco.

**Si se pierde el proyecto de Supabase (restaurar de cero):**
1. Proyecto nuevo en Supabase (San Pablo). En el SQL Editor, todas las migraciones en orden, menos las tres de reloj.
2. `node copia/abrir.mjs <archivo.ecopia> --sql restaurar.sql` y correr ese SQL en el proyecto nuevo (es todo o nada, y no hace nada si ya
   hay consultorios). Tiene datos de personas: borrarlo después y no subirlo a ningún lado.
3. `supabase/control.sql` y `pruebas/huellas.mjs`. Después las tres migraciones de reloj (cambiando la dirección del proyecto en la de `mp`).
4. Funciones `facturar`, `mp` y `copia`, con «Verify JWT» apagado en `mp` y `copia`. Secretos: los pega Santiago (los de ARCA están en
   `Desktop\ENTRETURNO - ARCA`; los de Mercado Pago, en su panel; la clave de los mails, en Resend, y va al Vault).
5. Ajustes de Auth (mails, «Confirm email», direcciones de vuelta): ver «Los mails de registro». Dirección y clave pública nuevas en
   `web/config.js`, en el flujo de la copia y en la aplicación de Mercado Pago. Publicar.
6. Cada dueña conecta de nuevo su Mercado Pago (los pases no van en la copia: queda «desconectada»). Los mails viejos que esperaban salir
   quedan descartados, para que no salgan dos veces. Las contraseñas de todas siguen siendo las mismas.

**Cómo dio el 25/11/2026:** base cargada (control 15 / 0 / 64 / `public.portada` / 36 / 5 / 19 / 3 / false / 0 / 0; huellas 615 de 615), función
`copia` (9.762 caracteres, huella `fef05ca769c8`, «Verify JWT» apagado con el OK de Santiago), secreto `COPIA_CLAVE` en Supabase y en GitHub
(lo pegó él). Primera copia a mano a las 16:19: 15 segundos, 7.895 bytes, misma huella en GitHub y en la base, confirmada a las 16:19:28. Santiago
la bajó, la abrió con su frase y dio «LA COPIA SIRVE: se abrió, se restauró y quedó igual». El mail del vigía se probó de verdad y llegó a
Recibidos. En la compu: `npm test` 236 de 236, pantallas 127 y 60, y 40 roturas a propósito, las 40 detectadas.

**Revisión 9 de Codex (8 puntos):** 2 (el vigía mira que esté guardada, no que haya salido), 3 (avisa aunque nunca haya salido ninguna, y
reintenta si el mail no sale), 4 (Mercado Pago queda desconectado al restaurar), 7 (cada columna nueva se revisa) y 8 (la frase no se ve al
escribirla) corregidos; 1 era esperable (la llave todavía no estaba); 5 en parte (el ensayo usa las tablas de cuentas como las de Supabase y
`postgres` puede usar `session_replication_role`, comprobado en el real); 6 con aviso temprano.

**Lo que no está probado:** la corrida de la madrugada sola (la primera es la del 26/11 a las 03:23), restaurar en un proyecto de Supabase de
verdad (hace falta crear uno para el ensayo y borrarlo) y entrar ahí con una contraseña restaurada.

## Las reglas de Punto Almagro (cargadas y publicadas el 25/11/2026, con el OK de Santiago: «Sí, todo»)

Yani respondió lo que se le había pedido y Santiago decidió lo que faltaba («Hasta pagar, no reserva otro», «Hasta 3 días antes», «Sí: puntoalmagro»,
«Se lo pregunto a Yani» por el precio de psicólogos y demás). Son opciones de cada consultorio: con los valores de fábrica, todo sigue como estaba.
Base: `20261125150000_reglas_almagro.sql`.

- **Lema** (`consultorios.lema`): la frase que va debajo del nombre y en el título.
- **La seña no se devuelve** (`sena_no_vuelve`): si cancela la profesional, el porcentaje corre sobre lo que pagó de más que la seña (con 100 %
  es «todo menos la seña», sea cual sea el porcentaje de seña). Si cancela la dueña se devuelve todo, como siempre: es la forma de hacer una excepción.
- **Ningún turno señado sin pagar** (`max_saldos` = 0): mientras haya uno señado sin terminar de pagar (o por señar) no reserva ningún otro.
- **Cambiar un turno de día** (`repro_max` veces, hasta `repro_dias` días antes; `reprogramar_reserva`): solo turnos confirmados, si hay lugar, que
  duren lo mismo y, si es otro box, que cueste lo que se cobró por hora. Lo pagado sigue valiendo, las máquinas se mueven con el turno y se
  enteran las dos. La dueña puede mover cualquiera, sin gastarle el cambio a la profesional. Cada cambio queda en `interno.reprogramaciones`.
- **Mover no sirve para esquivar la política:** al cancelar, los días se cuentan desde la fecha más temprana que tuvo el turno por cambios de
  ella (`reservas.politica_desde`); los cambios que hace la dueña no la perjudican.
- **Dirección:** el consultorio sale de la dirección (`consultorioDe`), y `consultorios.slugs_viejos` guarda las que tuvo. Si se entra por una vieja,
  la página sigue en la nueva. `slug` fijo en `config.js` solo vale fuera de `*.entreturno.com.ar` (la dirección de prueba de Cloudflare).
- `guardar_politica` guarda todo en un paso; lo que la página anterior no manda queda como está.
- **Datos de Yani** (nombre, espacios, precios, reglamento, facturación, aviso): se cargan con un SQL que NO está acá porque tiene datos
  personales (`E:\Entreturno boxes\datos-punto-almagro.sql`); el cambio de dirección, con `direccion-punto-almagro.sql`, al lado.

**Para cambiar la dirección de un consultorio:** 1) agregar la nueva en Cloudflare (proyecto `entreturno-boxes` → Custom domains) y esperar que
esté activa; 2) sumarla en Supabase → Authentication → URL Configuration; 3) `update consultorios set slug = …, slugs_viejos = …`; 4) comprobar las dos.
La sesión no pasa de una dirección a la otra: hay que volver a entrar.

En la compu: `npm test` 247 de 247, pantallas 127, 60 y 33, y 48 roturas a propósito, las 48 detectadas.

**Cómo dio en el real (25/11/2026 a la tarde):** huellas 615 de 615 antes y 651 de 651 después; control 15 / 0 / 65 / `public.portada` / 37 / 5 / 19 / 3 /
false / 0 / 0. Página publicada (`140df38`) igual en las tres direcciones (9 de 9). Con una prueba en la base real que se deshizo sola: la profesional
no puede reservar otro turno con uno señado (ni pagándolo entero), no mueve uno sin pagar, lo mueve una vez y la segunda se la rechaza, la dueña lo
mueve igual, la profesional no puede cambiar la política y al cancelar no vuelve la seña. `test:real` 21 de 21 y `test:real-mp` TODO BIEN. Vista como
visitante en la compu y en 375 de ancho: entrando por la dirección vieja sigue en la nueva, y el aviso nombra a la responsable. Supabase Auth: Site
URL `https://puntoalmagro.entreturno.com.ar` y cuatro Redirect URLs (las dos direcciones, solas y con `/**`).

**No mirado:** la página por dentro con una cuenta de verdad, en la dirección nueva (Santiago tiene que volver a entrar), y un mail de registro que
vuelva a la dirección nueva.

**Contestado por Santiago el mismo día:** los precios son por hora, los turnos de 4 horas, la seña del 50 % con 15 minutos, reprogramar una vez hasta 3
días antes y el mail del aviso («sobre el mensaje uno es todo si»). Categorías (OK: «Sí, así»), cargadas con `supabase\datos\puntoalmagro-categorias.sql`:
Médicos, Psicólogos, Nutricionistas y Coaches a $ 25.000 la hora, y Esteticistas a $ 15.000. Lo del seguro y las emergencias se sacó por completo (de la
categoría, del ejemplo de Configuración y de los datos de ejemplo), y al pedir acceso ahora pregunta «¿En qué categoría entrás?».

**A la espera de Yani** (`Desktop\YANI - lo que falta preguntarle (WhatsApp).txt`): el detalle de las máquinas (hoy se cobran por todo el turno, en cualquier
espacio y para cualquier categoría: si ella las quiere de otra forma, hay que armarlo), el borrador de 43 reglas de uso (cuando lo confirme va al
reglamento, con títulos: hoy la página numera cada renglón), fotos, punto de venta, profesionales para la prueba, Mercado Pago y que se registre. El plano
dibujado sigue siendo el de la demo (muestra una camilla en el Consultorio 1, que no nombró) y «Máquinas» se ve aunque todavía no haya ninguna.

**Revisión 10 de Codex (5 puntos, todos corregidos con su prueba):** 1 el precio al mover se comparaba con el de hoy y no con lo que se cobró;
2 con más de un cambio se podía mejorar la devolución; 3 la página ofrecía horarios con la máquina ocupada; 4 la política se guardaba en dos
pasos; 5 el texto no decía desde qué fecha se cuentan los días. Además, revisando: la página publicada trae fijo el consultorio y no habría
seguido a la dirección nueva (corregido y probado con direcciones como las de verdad).

**Revisión 11 de Codex (4 puntos, todos corregidos con su prueba):** 1 si dos consultorios tuvieron la misma dirección, se elegía uno (ahora ninguno); 2 la
página y la base no miraban igual un rato libre con la propia reserva adentro; 3 el selector mostraba hasta 45 días; 4 el texto de cancelar no decía
desde qué fecha se cuenta cuando la seña se devuelve.

## Decisiones tomadas al armar (sin consultar; se pueden cambiar)

- Una profesional puede tener hasta 3 reservas sin pagar la seña a la vez (`max_sin_pagar`), para que nadie acapare turnos.
- La seña queda fija al reservar, aunque después cambie el porcentaje.
- Si no hay nada para cobrar (precio en cero), la reserva queda confirmada sin pasar por el pago.
- «Quitar» una categoría o una máquina la esconde; las reservas viejas conservan su nombre y su precio.
- Al quitar un bloqueo se van los ratos libres que vivían adentro (las reservas ya tomadas siguen).
- Se guarda el texto de cada versión del reglamento, para poder mostrar qué aceptó cada reserva.
- Precio máximo por hora: $ 10.000.000. Máximo de máquinas por reserva: 10.
- El ingreso es con mail y contraseña.
- En la regla de saldos: el tope por defecto es 2, cuentan también los turnos que todavía no llegaron, y estando al día
  se puede seguir reservando si se paga completo.
- El plano dibujado del consultorio solo se muestra si el consultorio tiene 3 boxes (está dibujado así).

## Lo que sigue, en orden

1. Hecho el 20/11: proyecto en Supabase, migraciones cargadas, `web\config.js` armado, consultorio de Yani cargado
   ($ 25.000 médicos y $ 20.000 esteticistas) y página real publicada en `yanina.entreturno.com.ar`.
2. Hecho el 20/11: avisos por mail andando y mails de registro (confirmar cuenta, olvidé mi contraseña) publicados,
   con «Confirm email» prendido. «Olvidé mi contraseña» y «Pedir acceso» ya se probaron de verdad (20/11 y 25/11).
3. Yani: que cree su cuenta desde la página y dejarla como dueña (`interno.alta_admin`).
4. Datos reales de Yani: cargados el 25/11/2026 (horarios, reglamento, espacios, precios, facturación y aviso). Faltan máquinas, fotos (depósito
   de archivos + subir desde Configuración) y lo que conteste.
5. Mercado Pago real: hecho el 24/11, cargado y publicado el 25/11, y **probado de verdad el 25/11 en el ambiente de prueba de
   Mercado Pago** (pago, avisos y devolución; ver «Cobro con Mercado Pago»). Falta:
   (producción y las tres claves ya están desde el 25/11) Yani como dueña, `select interno.mp_pasar_a('puntoalmagro', 'real');`, que conecte
   su cuenta desde Configuración y un primer pago de verdad, chico, con su devolución.
6. Aviso de datos personales: publicado el 25/11. Falta la revisión de una abogada, los datos de Yani y un procedimiento de baja.
7. Copia diaria: andando desde el 25/11. Falta una segunda llave (Tomás o Iván) y ensayar la restauración en un proyecto de Supabase de verdad.
8. «Crear cuenta» desde el panel y prueba en celulares reales.
9. Facturas con ARCA: en curso desde el 23/11 (ver «Facturas con ARCA»; ahí está su propio orden).

## Pendientes de la revisión de la página (revisiones\respuesta-codex-2.md)

- Si la dueña cambia un precio o el porcentaje de seña mientras una profesional tiene la hoja de reserva abierta, la reserva se crea
  con el precio nuevo y recién se ve en la hoja de pago (se puede cancelar sin costo). Mejora: que la página mande el total que
  mostró y la base rechace si cambió.
- Las fechas y horas se calculan con la zona del aparato. Si alguien entra desde otra zona horaria, la página puede mostrar mal
  qué turnos ya pasaron (la base igual decide con la hora del consultorio).
- Cuando se habiliten las fotos: aceptar solo direcciones del depósito propio, no de cualquier servidor.

## Para comprobar en el Supabase real (no se puede en la compu)

- Comprobado el 20/11: carga `btree_gist`, el dueño de las funciones lee `auth.users`, y los permisos dan la misma lista que la prueba
  (ojo: la opción «Enable RLS on new tables automatically» crea `public.rls_auto_enable`, que quedaba abierta; se le quitó el permiso).
  También: sin sesión solo responde `portada`, las tablas no se leen por la API y las funciones internas no están publicadas.
- Llamar las funciones por la API con listas, fechas y objetos (lo que acá hace `conexion.test.mjs`).
- Dos personas reservando el mismo turno en el mismo instante, y reservar mientras la dueña bloquea (dos conexiones a la vez).
- Que el reloj (`pg_cron`) corra cada 5 minutos.
- Mails de registro: crear una cuenta nueva desde «Pedir acceso» (que llegue el mail, que el botón deje adentro y que el pedido
  aparezca solo). «Olvidé mi contraseña» ya se probó el 20/11 hasta la pantalla de contraseña nueva; falta guardar una distinta
  y ver que la vieja deja de servir. Mirar también cómo se ve el mail en el celular.
- Para ver qué pasó con un intento: panel de Supabase → Logs → «API Gateway» (cada pedido con su resultado) y «Auth» (el motivo).
  Si un pedido no aparece ahí, no salió del navegador (ver «Publicar»).
- Que la página, servida desde otro dominio que el de Supabase, pueda llamar a la API (permisos entre dominios).
