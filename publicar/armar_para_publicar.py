# Arma lo que publica Cloudflare Pages para un consultorio (por ahora, el de Yani: proyecto «entreturno-boxes»). Desde el
# 25/11/2026 lo corre Cloudflare solo en cada «push» a main; acá se corre para probar y para comparar después de publicar.
#   python -X utf8 publicar\armar_para_publicar.py
# Deja la carpeta publicar\yanina\ y el zip «publicar\yanina - sitio para subir.zip» con la página real:
# index.html, conexion.js, config.js (apuntando al proyecto real de Supabase y con el consultorio fijo), _headers y 404.html.
import hashlib
import re
import shutil
import zipfile
from pathlib import Path

AQUI = Path(__file__).resolve().parent
WEB = AQUI.parent / 'web'
SLUG = 'yanina'
DESTINO = AQUI / SLUG
ZIP = AQUI / f'{SLUG} - sitio para subir.zip'

DESTINO.mkdir(parents=True, exist_ok=True)
for nombre in ('index.html', 'conexion.js'):
    shutil.copyfile(WEB / nombre, DESTINO / nombre)

# El config de este sitio dice qué consultorio es, para que ande también en la dirección de prueba *.pages.dev (en *.entreturno.com.ar manda
# la dirección). «yanina» es la dirección vieja de Punto Almagro: la base la sigue aceptando.
config = (WEB / 'config.js').read_text(encoding='utf-8')
assert 'slug:' not in config.split('window.ENTRETURNO')[1], 'web\\config.js ya trae un consultorio fijo'
config, n = re.subn(r'(\n\s*key: "[^"]+",)', lambda m: m.group(1) + f'\n  slug: "{SLUG}",', config, count=1)
assert n == 1
(DESTINO / 'config.js').write_text(config, encoding='utf-8', newline='\n')

# En la dirección propia, Cloudflare le dice al navegador que guarde 4 horas los .js aunque acá se pida lo contrario
# (comprobado el 20/11/2026: «max-age=14400»). Si la página cambia, alguien que ya la había abierto quedaba hasta 4 horas con
# la página nueva y un conexion.js viejo. Por eso el index publicado pide cada archivo con una marca de su contenido
# (conexion.js?v=…): cuando el archivo cambia, cambia la dirección y el navegador lo baja de nuevo. El index no se guarda nunca.
pagina = (DESTINO / 'index.html').read_text(encoding='utf-8')
for nombre in ('config.js', 'conexion.js'):
    marca = hashlib.sha256((DESTINO / nombre).read_bytes()).hexdigest()[:12]
    referencia = f'<script src="{nombre}"></script>'
    assert pagina.count(referencia) == 1, f'el index tiene que cargar {nombre} una sola vez, así: {referencia}'
    pagina = pagina.replace(referencia, f'<script src="{nombre}?v={marca}"></script>')
(DESTINO / 'index.html').write_text(pagina, encoding='utf-8', newline='\n')

# Que los buscadores no la muestren, y que el navegador no se quede con una versión vieja de la página
(DESTINO / '_headers').write_text('/*\n  X-Robots-Tag: noindex, nofollow\n  Cache-Control: no-cache\n', encoding='utf-8', newline='\n')
(DESTINO / '404.html').write_text(
    '<!doctype html><html lang="es-AR"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
    '<meta name="robots" content="noindex"><title>Página no encontrada</title>'
    '<body style="font-family:system-ui;margin:15vh auto;max-width:28rem;padding:0 20px;text-align:center;color:#1C1917;background:#F7F3EE">'
    '<h1 style="font-size:1.4rem">Esa página no existe</h1><p><a href="/" style="color:inherit">Volver al inicio</a></p></body></html>\n',
    encoding='utf-8', newline='\n')

with zipfile.ZipFile(ZIP, 'w', zipfile.ZIP_DEFLATED) as z:
    for f in sorted(DESTINO.iterdir()):
        z.write(f, f.name)
for f in sorted(DESTINO.iterdir()):
    print(f'{f.stat().st_size:>9,}  {hashlib.sha256(f.read_bytes()).hexdigest()[:12]}  {f.name}')
print(f'{ZIP.name}: {ZIP.stat().st_size:,} bytes')
