# Arma lo que se sube a Cloudflare Pages para un consultorio (por ahora, el de Yani: proyecto «yanina-entreturno»).
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

# El config de este sitio fija el consultorio, así también anda en la dirección de prueba *.pages.dev
config = (WEB / 'config.js').read_text(encoding='utf-8')
assert 'slug:' not in config.split('window.ENTRETURNO')[1], 'web\\config.js ya trae un consultorio fijo'
config, n = re.subn(r'(\n\s*key: "[^"]+",)', lambda m: m.group(1) + f'\n  slug: "{SLUG}",', config, count=1)
assert n == 1
(DESTINO / 'config.js').write_text(config, encoding='utf-8', newline='\n')

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
