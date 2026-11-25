# Entreturno · Boxes, el sistema real

El sistema de alquiler de boxes por turnos. Hoy lo usa un consultorio: https://yanina.entreturno.com.ar

> **Subir es publicar.** Todo lo que se sube a `main` sale solo en la página de Yani en unos 20 segundos.
> Probalo en tu compu antes de subirlo.

## Para trabajar en esto (socios)

**Una sola vez**

1. Instalá [Git](https://git-scm.com/downloads) y [Node](https://nodejs.org) (versión 22 o más nueva).
2. Bajá el proyecto. La primera vez te pide entrar a GitHub: es con la cuenta de la empresa.

   ```
   git clone https://github.com/entreturnooficial-cpu/entreturno-boxes.git
   cd entreturno-boxes
   npm install
   ```

**Cada vez que vas a cambiar algo**

1. `git pull` — trae lo último que subieron los demás. Siempre antes de empezar.
2. `npm run servidor` — abrí http://localhost:8092 y vas a ver la página con un consultorio de ejemplo. Las cuentas para entrar
   están en `pruebas/datos-de-ejemplo.mjs`. No toca internet ni los datos de Yani.
   - Para verla cobrando con un Mercado Pago de mentira (PowerShell): `$env:PAGOS = 'mercadopago'; npm run servidor`
3. Hacé el cambio. Casi todo lo que se ve está en `web/index.html`.
4. Probá antes de subir:

   ```
   npm test
   npm run test:pantallas
   npm run test:pantallas-mp
   ```

   Las dos de pantalla usan Edge o Chrome sin abrir ninguna ventana. Las tres tienen que terminar sin fallas.
5. Subilo. Esto también lo publica:

   ```
   git add -A
   git commit -m "que cambie, en una frase"
   git push
   ```

6. Esperá un minuto y mirá la página: https://yanina.entreturno.com.ar
   - Si tenés Python: `python -X utf8 publicar/comprobar_publicado.py --esperar` compara lo publicado con lo tuyo y tiene que
     terminar en TODO BIEN (antes corré `python -X utf8 publicar/armar_para_publicar.py`).

Para un cambio chico de texto también sirve el navegador: abrís el archivo en GitHub, el lápiz y «Commit changes». Se publica igual.

**Si algo sale mal:** en Cloudflare, proyecto `entreturno-boxes` → Deployments → la versión anterior → «Rollback to this
deployment». Después hay que corregir el archivo acá, porque el próximo cambio que se suba publica lo que haya.

## Lo que GitHub no hace

La base de datos y las funciones (facturar y Mercado Pago) viven en Supabase y **se cargan a mano, siempre antes de subir la
página que las usa**. Lo que está en `supabase/` es la copia de lo cargado:

- un cambio de la base va en un archivo nuevo en `supabase/migrations/`, con su prueba, y después se pega en el SQL Editor;
- las funciones se arman con `node publicar/armar_funcion.mjs` y se pegan en Edge Functions;
- `node pruebas/huellas.mjs` escribe una consulta que dice si la base real es igual a lo que hay acá.

Los pasos completos están en `LEEME.md`. Si no estás seguro, avisá en el grupo antes.

## Qué hay en cada carpeta

- `web/` — la página (`index.html`) y lo que habla con el servidor (`conexion.js`, `config.js`).
- `supabase/` — la base de datos (`migrations/`), las funciones (`functions/`), los datos de cada consultorio y los mails.
- `pruebas/` — las pruebas y el servidor para ver la página en la compu.
- `publicar/` — lo que arma Cloudflare para publicar, y las funciones armadas para pegar en Supabase.
- `revisiones/` — las revisiones del código.
- `LEEME.md` — cómo está hoy cada parte, por qué se hizo así y qué sigue. **Empezar por ahí.**

## Cuidados

- Acá no hay ninguna clave secreta y no tiene que haberla. La de `web/config.js` es pública: va adentro de la página.
- Una sola rama, `main`. Si dos cambian lo mismo, GitHub le pide al segundo que haga `git pull` antes.
- `npm run test:arca` solo anda en la compu de Santiago: usa los certificados, que no se comparten.
- Las cuentas y cómo entrar a cada servicio están en la hoja «ENTRETURNO - CUENTAS Y ACCESOS».
