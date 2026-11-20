# Entreturno · Boxes, el sistema real

El sistema de alquiler de boxes por turnos. Hoy lo usa un consultorio: https://yanina.entreturno.com.ar

- `web/` — la página (`index.html`) y lo que habla con el servidor (`conexion.js`, `config.js`).
- `supabase/` — la base de datos: tablas, funciones y los datos de cada consultorio.
- `pruebas/` — las pruebas. Se corren con `npm test` y `npm run test:pantallas`.
- `publicar/` — lo que se sube a Cloudflare Pages (proyecto `yanina-entreturno`).
- `LEEME.md` — cómo está hoy, cómo se prueba y qué sigue. **Empezar por ahí.**

Para trabajar hace falta Node: `npm install` una sola vez.

Acá no hay ninguna clave secreta. La que está en `web/config.js` es la clave pública del proyecto, que va adentro de la página.

Las cuentas y cómo entrar a cada servicio están en la hoja «ENTRETURNO - CUENTAS Y ACCESOS».
