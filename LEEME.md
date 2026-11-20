# Entreturno · Boxes — el sistema real

La versión de verdad de la página de alquiler de boxes (la demo es `Desktop\Consultorio Yani - Boxes\index.html`;
una copia de la que se partió está en `referencia\`). Primera clienta: la Dra. Yanina Onzari, que aceptó el 20/11/2026.

Un solo sistema para todos los consultorios: cada uno tiene su dirección (`nombre.entreturno.com.ar`), su marca, sus
datos separados y su Mercado Pago. La base de datos vive en Supabase (plan gratis para arrancar; pasar al pago es
cambiar el plan, sin mudar nada) y la página en Cloudflare Pages.

## Cómo está hoy (20/11/2026)

| Parte | Estado |
| --- | --- |
| Base de datos de la etapa 1 (cuentas, agenda, reservas, pagos de prueba, cancelaciones, saldos, ajustes, cola de avisos) | **Hecha y probada en la compu: 65 pruebas** |
| Conexión de la página con el servidor (entrar, crear cuenta, sesión que se renueva sola, enlaces de los mails) | **Hecha y probada contra el servidor de prueba: 13 pruebas** |
| La página (`web\index.html`): las pantallas de la demo, ya conectadas a la base | **Hecha y probada de punta a punta en un navegador sin ventana: 91 comprobaciones** |
| Revisión independiente de la base (Codex, 20/11) | 10 puntos: 9 corregidos con su prueba; el otro es comprobar en el Supabase real |
| Revisión independiente de la página (Codex, 20/11) | 9 puntos: 6 corregidos con su prueba; 3 anotados más abajo. No encontró forma de meter código |
| Revisión independiente de los mails de registro (Codex, 20/11) | 10 puntos: 6 corregidos, 2 comprobados y 2 que dependen de la prueba real (detalle más abajo). No encontró forma de meter código |
| Proyecto real en Supabase | **Creado el 20/11/2026**: organización «Entreturno», proyecto `entreturno` (San Pablo, plan gratis). Base cargada desde el SQL Editor, controlada con `supabase\control.sql` y comprobada desde afuera con `npm run test:real` (8 de 8). El reloj (`pg_cron`) quedó programado. Consultorio `yanina` cargado (`supabase\datos\yanina.sql`) y página publicada en `yanina.entreturno.com.ar` el 20/11 (`publicar\armar_para_publicar.py`; comprobado, 3 de 3 archivos). Santiago entra como «Soporte Entreturno» (admin, `supabase\datos\yanina-soporte.sql`). Falta Yani como dueña: primero crea su cuenta en la página y después `select interno.alta_admin('yanina', '<su mail>', 'Yani')` |
| Cobro real con Mercado Pago | Falta (etapa 2). Hoy el pago es «de prueba»: no mueve plata |
| Avisos por mail del consultorio (solicitud, reserva confirmada, recordatorio…) | **Andando desde el 20/11**: cola `avisos` → Resend, cada minuto (`…_mails.sql`, 5 pruebas). La clave está en el Vault de Supabase (`resend_api_key`). El primer mail real llegó a Recibidos de Gmail |
| Mails de registro (confirmar la cuenta, mandarlo de nuevo, olvidé mi contraseña) | **Hechos el 20/11** y publicados: ver «Los mails de registro» más abajo. «Confirm email» está **prendido** en Supabase. **Falta la prueba real** con una cuenta nueva y con «Olvidé mi contraseña» (la hace una persona: hay que poner una contraseña) |
| Fotos de boxes y máquinas | Falta (necesita el depósito de archivos del proyecto real); los botones de subir foto están escondidos |
| Facturas con ARCA | Falta (etapa 3). La pantalla muestra cuánto hay que facturar; los botones están apagados |
| Copia de seguridad diaria | Falta (el plan gratis no la hace sola) |
| «Crear cuenta» desde el panel de la dueña | Falta. Hoy cada profesional se registra sola y la dueña la aprueba |
| Probarla en un celular real | Falta |

## Probar

```
npm install               (una sola vez)
npm test                  (78 pruebas: base de datos + conexión; medio minuto)
npm run test:pantallas    (91 comprobaciones de la página en un Edge sin ventana; deja capturas en E:\Entreturno boxes\pruebas)
npm run test:real         (8 comprobaciones contra el proyecto real, sin entrar con ninguna cuenta: no cambia nada)
npm run servidor          (la página andando en http://localhost:8092, con el consultorio de ejemplo «lavanda»)
```

Las pruebas usan un Postgres que corre adentro de Node (PGlite), preparado como lo deja Supabase. No tocan internet
ni ningún dato real. Las cuentas y la clave del servidor de prueba están en `pruebas\datos-de-ejemplo.mjs`.
Desde Claude: `preview_start` con el nombre `entreturno-boxes` abre esa misma página en el navegador de la app.

## Carpetas

- `supabase\migrations\` — la base: `…_tablas.sql`, `…_funciones.sql`, `…_mails.sql` y `…_reloj.sql` (este último solo en el proyecto real).
  `supabase\datos\` — el alta del consultorio de Yani. `supabase\control.sql` — control de permisos para el proyecto real.
  `supabase\mails\` — los textos de los mails de registro, que se cargan a mano en el panel de Supabase (tiene su LEEME).
- `publicar\armar_para_publicar.py` — arma `publicar\yanina\` y el zip que se sube a Cloudflare Pages (proyecto `yanina-entreturno`).
- `web\index.html` — la página entera (estilos y lógica). `web\conexion.js` — lo único que habla con el servidor.
  `web\config.js` tiene la dirección y la clave pública del proyecto real (el servidor de prueba arma el suyo y no lo usa).
- `pruebas\sql\` — pruebas de la base. `pruebas\conexion.test.mjs` — de punta a punta por la red.
  `pruebas\pantallas.mjs` — la página en un navegador. `pruebas\servidor-local.mjs` — imita lo que se usa de Supabase.
- `referencia\` — la demo de la que se partió y `como-se-paso-la-demo.py` (qué se le cambió; se corrió una sola vez).
- `revisiones\` — los pedidos a Codex y sus respuestas.

## Seguridad, en corto

- Todas las tablas tienen RLS activado y ninguna política: desde la página no se lee ni se escribe ninguna tabla.
- La página solo puede llamar 24 funciones (lista al final de `…_funciones.sql`); cada una revisa quién llama y a qué
  consultorio pertenece. Sin sesión solo existe `portada`.
- Precios, seña y devoluciones se calculan siempre en la base, nunca con lo que manda la página.
- La base misma impide que dos reservas se pisen en un box o que una máquina esté en dos reservas a la vez.
- Otra profesional ve un horario ajeno como «ocupado»: sin nombre, servicio ni plata.
- Todo lo que cambia la agenda o los ajustes de un consultorio corre de a una operación por vez (`interno.candado`).
- En la página, todo texto que escribe una persona pasa por `esc(...)` antes de mostrarse (hay una prueba con nombres «con trampa»).
- El enlace de los mails trae un código de un solo uso después del `#` (esa parte de la dirección no viaja a ningún servidor):
  la página lo saca de la barra apenas carga y lo canjea por la sesión. La contraseña nunca se guarda en el navegador.

## La regla de los saldos pendientes (pedido de Santiago, 20/11/2026)

Cada profesional puede tener hasta **2 turnos señados sin terminar de pagar** (cuentan los confirmados, los ya usados y los
que está por señar). Al llegar a ese número:

- si alguno de esos saldos es de un turno que **ya pasó**, no puede reservar nada hasta pagarlo;
- si está al día, puede seguir reservando, pero el turno nuevo lo paga **completo** (o salda uno antes).

El número lo elige la dueña en Configuración → «Seña y pago»: uno solo (el modo estricto), 2, 3, 5 o sin tope
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
- URL Configuration: Site URL `https://yanina.entreturno.com.ar`; Redirect URLs: esa misma dirección y con `/**`.
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
- El consultorio sale de la dirección (`yanina.entreturno.com.ar` → `yanina`), salvo que `config.js` lo fije.

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
   con «Confirm email» prendido. **Falta la prueba real** de esos dos caminos.
3. Yani: que cree su cuenta desde la página y dejarla como dueña (`interno.alta_admin`).
4. Datos reales de Yani: horarios, reglamento, descripción de los boxes, máquinas y fotos (depósito de archivos + subir
   desde Configuración).
5. Mercado Pago real (aplicación «Entreturno», con API de Orders: falta probar que se puede cobrar a nombre de ella).
6. Copia diaria, «crear cuenta» desde el panel y prueba en celulares reales.
7. Facturas con ARCA.

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
  aparezca solo), y «Olvidé mi contraseña» (que llegue, que deje elegir la nueva y que la vieja deje de servir). Mirar también
  cómo se ve el mail en el celular y si cae en Recibidos.
- Que la página, servida desde otro dominio que el de Supabase, pueda llamar a la API (permisos entre dominios).
