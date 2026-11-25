# Pedido de revisión 9 — La copia de seguridad diaria (25/11/2026)

Contestá en castellano rioplatense, simple. Solo lectura: no cambies archivos. Máximo 10 puntos, del más grave al menos grave, con
archivo y renglón, qué pasa, cómo se reproduce y cómo lo arreglarías. Si algo está bien, no lo cuentes.

Qué se sumó (mirá `git diff HEAD` y los archivos nuevos):
- `supabase/migrations/20261125130000_copia.sql` (`copia_datos`, `copia_anotar`, `interno.copias`, `interno.copias_vigilar`),
  `…130100_reloj_copia.sql` y `…140000_aviso_v2.sql` (el aviso de datos nombra la copia).
- `supabase/functions/copia/index.ts` y `_compartido/copia.ts`, `copia-llaves.ts`: la función entrega los datos ya cifrados (AES-256-GCM con
  clave nueva, cifrada con RSA-OAEP para cada llave pública). La clave para pedirla está en los secretos de Supabase y de GitHub.
- `.github/workflows/copia-diaria.yml`: la pide todas las noches y la guarda 30 días como «artifact» (repositorio privado).
- `copia/` (generar-llave, abrir, descifrar, ensayar, restaurar): corre en la compu del dueño de la llave. La llave privada está
  protegida con una frase (scrypt) y no está en ningún servidor.
- `pruebas/copia.test.mjs`.

Contexto: plan gratis de Supabase (sin copias automáticas). Los datos son de profesionales (nombre, CUIT, mail, reservas, pagos) y las
cuentas (con la contraseña como la guarda Supabase). El convenio promete una copia por día y que se borren a los 30 días.

Mirá con atención:
1. ¿Puede salir un dato sin cifrar, o un secreto adentro de la copia? ¿Quién puede pedirla? ¿Errores que digan de más?
2. ¿El cifrado está bien usado? (claves, vectores, autenticación, llaves, comparación de la clave, la frase).
3. ¿La restauración de verdad deja todo bien en un proyecto NUEVO de Supabase? (columnas calculadas, cuentas de auth, orden, disparadores,
   `session_replication_role`, tablas con datos puestos por las migraciones, tamaño del SQL, permisos del dueño `postgres`).
4. ¿La copia es una sola foto consistente? ¿Qué pasa si crece mucho (tiempo, memoria, límites de la función y de la API)?
5. El flujo de GitHub: ¿puede quedar «verde» sin copia, o filtrar la clave? ¿La guarda de 30 días?
6. El vigía: ¿puede no avisar cuando hace falta, o avisar de más?
7. Pruebas que falten o que no prueben lo que dicen.
