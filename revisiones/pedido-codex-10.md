# Pedido de revisión 10 — Las reglas de «Punto Almagro» (25/11/2026)

Contestá en castellano rioplatense, simple. Solo lectura. Máximo 7 puntos, del más grave al menos grave, con archivo y renglón, qué pasa,
cómo se reproduce y cómo lo arreglarías. Si algo está bien, no lo cuentes.

Qué se sumó (mirá `git diff HEAD` y los archivos nuevos): `supabase/migrations/20261125150000_reglas_almagro.sql` (la seña no se devuelve;
`max_saldos = 0` es «hasta pagar no reserva otro»; `reprogramar_reserva`: mover un turno confirmado, una vez, hasta 3 días antes, mismo
largo y mismo precio; `guardar_reglas`), los cambios en `web/index.html` y las pruebas `pruebas/sql/almagro.test.mjs` y
`pruebas/pantallas-almagro.mjs`. `reservar` y `cancelar_reserva` se volvieron a escribir a partir de las versiones anteriores.

Mirá con atención: 1) ¿se puede mover un turno a un horario que no corresponde, pagar menos, o esquivar la política de cancelación moviéndolo?
2) ¿`reservar` y `cancelar_reserva` cambiaron algo que no tenían que cambiar? 3) pagos abiertos, saldos, devoluciones de Mercado Pago,
facturas del mes, recordatorios, ratos libres y máquinas cuando un turno se mueve. 4) lo que la página muestra contra lo que hace la base.
5) candados y permisos. 6) pruebas que falten.
