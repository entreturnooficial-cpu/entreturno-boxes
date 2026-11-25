# Pedido de revisión 8 — El modo prueba de Mercado Pago, de verdad de prueba (25/11/2026)

Contestá en castellano rioplatense, simple. Solo lectura: no cambies archivos. Máximo 8 puntos, del más grave al menos grave, con
archivo y renglón, qué pasa, cómo se reproduce y cómo lo arreglarías. Si algo está bien, no lo cuentes.

Qué pasó: con el consultorio en modo prueba se conectó una cuenta real (OAuth con `test_token: true`). Al cobrar, Mercado Pago rechazó
ese pase en `/v1/orders`, la función lo renovó con `refresh_token`, el pase renovado vino real y la orden salió de verdad (`ORD01…`),
aunque la página decía «modo prueba». Nadie la pagó.

Qué se cambió (mirá `git diff HEAD` y los archivos nuevos):
- `supabase/migrations/20261125120000_prueba_de_verdad.sql`: `mp_credencial` no entrega pases en prueba; un disparador en `pagos` no
  deja anotar una orden de otro modo (`ORDTST…` es de prueba); `mp_pendientes` no renueva pases de prueba; `interno.mp_pasar_a` para
  cambiar de modo sin dejar nada colgado.
- `supabase/functions/_compartido/cobros.ts` y `mp.ts`: en prueba se cobra siempre con el pase de prueba de la aplicación; una orden
  de otro modo se cancela y no se muestra; al conectar o renovar, el pase tiene que ser del modo que corresponde.
- `pruebas/mp-simulado.mjs` (ahora se comporta como el de verdad), pruebas nuevas y textos en `web/index.html`.

Mirá con atención:
1. ¿Queda algún camino por el que, en modo prueba, se cobre de verdad, o por el que, en modo real, un pago de prueba confirme una reserva?
   (órdenes abiertas antes de cambiar de modo, reusar una orden ya creada, avisos, el reloj, devoluciones, sobrantes).
2. ¿El disparador puede trabar algo legítimo? (pagos viejos, devoluciones, sobrantes, cambio de modo, pagos simulados).
3. `interno.mp_pasar_a`: ¿algo que falte mirar antes de cambiar de modo? ¿Carreras con una reserva o un pago que entra justo?
4. ¿La página vieja y la función vieja siguen andando con la base nueva (unos minutos)? ¿Y la función nueva con la base vieja?
5. Pruebas que falten o que no prueben lo que dicen.
