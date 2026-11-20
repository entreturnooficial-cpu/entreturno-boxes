Sos un revisor adversario. NO modifiques ningún archivo: solo leé y contestá.

Proyecto: `entreturno-boxes` (leé primero `LEEME.md`). Ya revisaste la base de datos (tu respuesta anterior está en
`revisiones/respuesta-codex-1.md`; esos puntos ya se corrigieron). Ahora toca LA PÁGINA y lo que cambió después:

- `web/index.html`: la página entera (estilos y lógica en un solo archivo). Sale de la demo
  `referencia/demo-de-la-que-se-partio.html`; qué se cambió está en `referencia/como-se-paso-la-demo.py`.
  Los datos ya no viven en el navegador: `cargar()` pide `foto` (o `portada` sin sesión) y cada cosa que cambia datos pasa
  por `accion(...)`, que llama una función de la base y vuelve a pedir la foto.
- `web/conexion.js`: ingreso, sesión que se renueva sola y llamadas a las funciones.
- La regla nueva de saldos pendientes: `max_saldos` en `supabase/migrations/20261120100000_tablas.sql`, y en
  `…_funciones.sql` el bloque «Saldos pendientes» de `reservar`, `guardar_pago` y el pago de saldo de un turno `cumplida`
  en `simular_pago`. Pruebas en `pruebas/sql/saldos.test.mjs`.
- `pruebas/pantallas.mjs` (66 comprobaciones en un Edge sin ventana) y `pruebas/conexion.test.mjs`.

Buscá problemas REALES, con el escenario concreto que los dispara. Prioridades:

1. Seguridad en la página: textos que escribe una persona (nombre, profesión, teléfono, servicio, nota de un bloqueo, nombre de
   box, de máquina o de categoría, reglamento, dirección de una foto) que lleguen al HTML sin pasar por `esc(...)`, en contenido
   o dentro de un atributo; direcciones `javascript:`; cualquier forma de que una profesional o una dueña le ejecute código a otra.
   Manejo de la sesión en `conexion.js`: pérdida o fuga del pase, renovaciones repetidas, quedar adentro después de salir.
2. Diferencias entre lo que la página ofrece y lo que la base acepta: turnos o ratos que la página muestre como reservables y la
   base rechace (o al revés), montos que la página muestre distintos de los que cobra la base (seña fija `deposit`, saldos,
   devoluciones), y la regla de saldos (`saldos()` en la página contra el bloque de `reservar`).
3. Errores de uso: acciones que dejen la pantalla en un estado raro si la llamada falla o tarda, doble envío, hojas que queden
   abiertas con datos viejos, formularios que pierdan lo escrito por el refresco automático, cosas de la demo que quedaron
   y ya no tienen sentido (texto, botones o código muerto).
4. La regla de saldos en la base: formas de saltearla o de quedar trabada sin salida (por ejemplo, alguien que no pueda pagar
   lo que debe para destrabarse), carreras, y casos que las pruebas no cubren.
5. Lo que funcionaría contra el servidor de prueba (`pruebas/servidor-local.mjs`) pero no contra un Supabase real.

Formato de la respuesta, en castellano: lista numerada de lo más grave a lo menos grave; para cada hallazgo, gravedad
(alta / media / baja), archivo y línea, escenario paso a paso, por qué pasa y el arreglo que proponés. Al final, lo que
revisaste y te pareció bien. No inventes: si dudás, decilo como duda y cómo comprobarlo.
