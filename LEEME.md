# Entreturno · Boxes — el sistema real

La versión de verdad de la página de alquiler de boxes (la demo es `Desktop\Consultorio Yani - Boxes\index.html`;
una copia de la que se partió está en `referencia\`). Primera clienta: la Dra. Yanina Onzari, que aceptó el 20/11/2026.

Un solo sistema para todos los consultorios: cada uno tiene su dirección (`nombre.entreturno.com.ar`), su marca, sus
datos separados y su Mercado Pago. La base de datos vive en Supabase (plan gratis para arrancar; pasar al pago es
cambiar el plan, sin mudar nada) y la página en Cloudflare Pages.

## Cómo está hoy (20/11/2026)

| Parte | Estado |
| --- | --- |
| Base de datos de la etapa 1 (cuentas, agenda, reservas, pagos de prueba, cancelaciones, saldos, ajustes) | **Hecha y probada en la compu: 60 pruebas** |
| Conexión de la página con el servidor (entrar, crear cuenta, sesión que se renueva sola) | **Hecha y probada contra el servidor de prueba: 11 pruebas** |
| La página (`web\index.html`): las pantallas de la demo, ya conectadas a la base | **Hecha y probada de punta a punta en un navegador sin ventana: 68 comprobaciones** |
| Revisión independiente de la base (Codex, 20/11) | 10 puntos: 9 corregidos con su prueba; el otro es comprobar en el Supabase real |
| Revisión independiente de la página (Codex, 20/11) | 9 puntos: 6 corregidos con su prueba; 3 anotados más abajo. No encontró forma de meter código |
| Proyecto real en Supabase | **Creado el 20/11/2026**: organización «Entreturno», proyecto `entreturno` (San Pablo, plan gratis). Base cargada desde el SQL Editor, controlada con `supabase\control.sql` y comprobada desde afuera con `npm run test:real` (8 de 8). El reloj (`pg_cron`) quedó programado. Consultorio `yanina` cargado (`supabase\datos\yanina.sql`) y página publicada en `yanina.entreturno.com.ar` el 20/11 (`publicar\armar_para_publicar.py`; comprobado, 3 de 3 archivos). Falta dejar a alguien como dueña: primero crea su cuenta en la página y después `interno.alta_admin` |
| Cobro real con Mercado Pago | Falta (etapa 2). Hoy el pago es «de prueba»: no mueve plata |
| Mails (confirmación, recordatorio…) | Envío armado con Resend el 20/11 (`…_mails.sql`, 5 pruebas) y cargado en el proyecto real; el dominio `entreturno.com.ar` tiene sus registros. **Falta la clave**: se carga a mano en el Vault de Supabase con el nombre `resend_api_key`. Después: prueba real, mails de registro (SMTP) y «olvidé mi contraseña» |
| Fotos de boxes y máquinas | Falta (necesita el depósito de archivos del proyecto real); los botones de subir foto están escondidos |
| Facturas con ARCA | Falta (etapa 3). La pantalla muestra cuánto hay que facturar; los botones están apagados |
| Copia de seguridad diaria | Falta (el plan gratis no la hace sola) |
| «Olvidé mi contraseña» y «Crear cuenta» desde el panel de la dueña | Falta: dependen de poder mandar mails. Hoy cada profesional se registra sola y la dueña la aprueba |
| Probarla en un celular real | Falta |

## Probar

```
npm install               (una sola vez)
npm test                  (71 pruebas: base de datos + conexión; medio minuto)
npm run test:pantallas    (68 comprobaciones de la página en un Edge sin ventana; deja capturas en E:\Entreturno boxes\pruebas)
npm run test:real         (8 comprobaciones contra el proyecto real, sin entrar con ninguna cuenta: no cambia nada)
npm run servidor          (la página andando en http://localhost:8092, con el consultorio de ejemplo «lavanda»)
```

Las pruebas usan un Postgres que corre adentro de Node (PGlite), preparado como lo deja Supabase. No tocan internet
ni ningún dato real. Las cuentas y la clave del servidor de prueba están en `pruebas\datos-de-ejemplo.mjs`.
Desde Claude: `preview_start` con el nombre `entreturno-boxes` abre esa misma página en el navegador de la app.

## Carpetas

- `supabase\migrations\` — la base: `…_tablas.sql`, `…_funciones.sql` y `…_reloj.sql` (este último solo en el proyecto real).
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

## La regla de los saldos pendientes (pedido de Santiago, 20/11/2026)

Cada profesional puede tener hasta **2 turnos señados sin terminar de pagar** (cuentan los confirmados, los ya usados y los
que está por señar). Al llegar a ese número:

- si alguno de esos saldos es de un turno que **ya pasó**, no puede reservar nada hasta pagarlo;
- si está al día, puede seguir reservando, pero el turno nuevo lo paga **completo** (o salda uno antes).

El número lo elige la dueña en Configuración → «Seña y pago»: uno solo (el modo estricto), 2, 3, 5 o sin tope
(`consultorios.max_saldos`). El saldo de un turno ya usado se puede pagar desde «Mis reservas», donde aparece arriba de todo.
La dueña ve en «Profesionales» quién debe y cuánto, y en el Inicio el total de saldos por cobrar.

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

1. Hecho el 20/11: proyecto en Supabase, las tres migraciones cargadas y `web\config.js` armado.
2. Hecho el 20/11: «Confirm email» apagado en el ingreso (con el OK de Santiago), porque hoy no sale ningún mail. Volver a prenderlo
   cuando se conecte el envío de mails. Falta comprobar con cuentas reales lo de la lista de abajo.
3. Alta del consultorio de Yani con sus datos reales, y fotos (depósito de archivos + subir desde Configuración).
4. Publicar la página nueva en `yanina.entreturno.com.ar` (hoy ahí está la demo) y probarla en celulares reales.
5. Mercado Pago real (aplicación «Entreturno», con API de Orders: falta probar que se puede cobrar a nombre de ella).
6. Envío de mails, copia diaria, «olvidé mi contraseña» y «crear cuenta» desde el panel.
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
- En el ingreso: desactivar «confirmar mail» hasta tener el envío de mails propio (el de Supabase solo manda al equipo).
- Que la página, servida desde otro dominio que el de Supabase, pueda llamar a la API (permisos entre dominios).
