# Revisión 11 — las reglas de Punto Almagro, después de corregir la revisión 10

Sos revisor independiente. Solo lectura: no cambies nada. Respondé en castellano, corto, con puntos numerados y, en cada uno, un caso concreto
(qué hace quién, qué tendría que pasar y qué pasa). Si algo está bien, no lo cuentes. No repitas lo de `revisiones/respuesta-codex-10.md` si ya está
corregido: decí solo si alguna corrección quedó mal o a medias.

Qué mirar (todo está sin publicar; `git diff HEAD` muestra los cambios):

1. `supabase/migrations/20261125150000_reglas_almagro.sql` completa. En especial:
   - `reprogramar_reserva`: precio contra lo que se cobró (`r.precio_hora`), `politica_desde`, máquinas, ratos libres (`horario_reservable` con
     `p_salvo`), topes, que la dueña pueda mover cualquiera y que nadie más pueda.
   - `cancelar_reserva`: seña que no vuelve, con la fecha más temprana.
   - `guardar_politica` con tres datos opcionales (la página anterior, que sigue publicada unos minutos, llama con seis).
   - `interno.consultorio` con direcciones anteriores: ¿se puede usar para entrar a otro consultorio o para confundir a alguien?
   - permisos de todo lo nuevo.
2. `web/index.html`: `consultorioDe`, `SLUG`, `direccionNueva` (¿se puede mandar a alguien a un sitio ajeno?, ¿puede quedar dando vueltas?), `lugaresPara`,
   `machineBusy` con `salvo`, `openMover`/`renderMover`, `refundFor`, textos de la política, `saldos()` con «ninguno».
3. Que la página y la base digan lo mismo (si la página ofrece algo que la base rechaza, o al revés).
4. Que las migraciones anteriores, la copia de seguridad (`copia/`, `pruebas/copia-columnas.txt`) y `supabase/control.sql` sigan siendo coherentes.

Contexto: un solo sistema para muchos consultorios; la página solo llama funciones `security definer`; RLS sin políticas. Hay reservas pagadas con
Mercado Pago, así que lo que importa es la plata, que nadie vea o toque lo ajeno y que no se pisen turnos.
