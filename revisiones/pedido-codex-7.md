# Pedido de revisión 7 — El aviso de datos personales (25/11/2026)

Contestá en castellano rioplatense, simple. Solo lectura: no cambies archivos. Máximo 12 puntos, del más grave al menos grave,
con archivo y renglón, qué pasa, cómo se reproduce y cómo lo arreglarías. Si algo está bien, no lo cuentes.

Qué se sumó (mirá `git diff HEAD` y los archivos nuevos):
- `supabase/migrations/20261125110000_privacidad.sql`: el texto del aviso con versión, la huella, la constancia de quién aceptó
  (`interno.consentimientos`), `pedir_acceso` con dos parámetros más, `aceptar_privacidad`, `guardar_privacidad`, y el control en
  `interno.aprobada` (que usa solo `reservar`).
- `web/index.html`: dos casilleros al pedir acceso, el aviso para leer sin entrar, la pantalla que lo pide a quien ya tenía cuenta
  o cuando hay versión nueva, la constancia en «Profesionales» y los datos del responsable en Configuración.
- Pruebas: `pruebas/sql/privacidad.test.mjs`, lo nuevo en `pruebas/pantallas.mjs` y en `pruebas/sql/migracion-sobre-datos.test.mjs`.

Contexto: un solo sistema para varios consultorios. La página solo llama funciones `security definer`. La base real ya tiene un
consultorio, una dueña y una profesional de prueba. El orden al publicar es: primero la base, después la página (unos minutos con
la página vieja y la base nueva). Los datos se guardan en Supabase (San Pablo, Brasil).

Mirá con atención:
1. ¿Se puede quedar registrada o reservar sin una constancia válida? (pedidos guardados en el navegador o en los datos de la cuenta,
   mail de confirmación abierto en otro aparato, versión que cambia en el medio, dos pestañas, cuentas de otro consultorio).
2. ¿La constancia prueba de verdad qué texto vio la persona? ¿Puede quedar anotado un texto distinto del que tuvo en pantalla?
   (la huella que manda el casillero, el texto que abre la hoja, el refresco de la página mientras lee).
3. ¿Hay algo que la página muestre y que el aviso diga que no, o al revés? Comparalo con lo que hace el código (qué se guarda, quién
   lo ve, qué queda en el navegador, qué se manda a Mercado Pago, qué ven otras profesionales, qué hace «cerrar sesión»).
4. Permisos de las tablas y funciones nuevas, y que no se lea nada de otro consultorio.
5. Que la migración se pueda cargar sobre la base real sin romper nada, y qué pasa en los minutos con la página vieja.
6. Textos de la dueña que entran en el aviso (código, títulos, casilleros `{…}`): ¿se puede cambiar el sentido del aviso?
7. Accesibilidad y uso en celular de los casilleros y de la pantalla que pide el aviso.
8. Pruebas que falten o que no prueben lo que dicen.

No hace falta opinar si la redacción cumple la ley: eso lo ve una abogada. Sí decí si el texto afirma algo que el sistema no hace.
