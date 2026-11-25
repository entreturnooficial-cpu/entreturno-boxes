# Comprueba que lo publicado es igual a lo armado en publicar\\yanina\\ y con qué reglas de guardado se sirve.
#   python -X utf8 publicar\\comprobar_publicado.py
# Baja la página como la baja un navegador que entra por primera vez: el index, y los archivos que ese index pide
# (con su marca ?v=…). No entra con ninguna cuenta ni cambia nada.
import hashlib
import re
import sys
import time
import urllib.request
from pathlib import Path

LOCAL = Path(__file__).resolve().parent / 'yanina'
SITIOS = ('https://yanina.entreturno.com.ar', 'https://yanina-entreturno.pages.dev')
# Con --github mira, en cambio, la dirección de prueba que publica sola cada «push» a main (proyecto de Pages «entreturno-boxes»).
# Se corre DESPUÉS del push: antes muestra lo anterior. Cuando el dominio se mueva a ese proyecto, pasa a ser el segundo sitio.
if '--github' in sys.argv[1:]:
    SITIOS = ('https://entreturno-boxes.pages.dev',)


def bajar(url):
    pedido = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 comprobacion', 'Cache-Control': 'no-cache'})
    with urllib.request.urlopen(pedido, timeout=30) as r:
        return r.read(), r.headers


fallas = 0
for base in SITIOS:
    cuerpo, cab = bajar(f'{base}/?nocache={int(time.time())}')
    esperado = (LOCAL / 'index.html').read_bytes()
    # En la dirección propia Cloudflare agrega al final el contador de visitas: se compara sin ese agregado
    sin_contador = re.sub(rb'<!-- Cloudflare Pages Analytics -->.*?<!-- Cloudflare Pages Analytics -->', b'', cuerpo, flags=re.S)
    igual = cuerpo == esperado or sin_contador == esperado
    de_mas = len(cuerpo) - len(esperado)
    if not igual and esperado[:-20] in cuerpo:       # mismo contenido, con algo agregado antes de </body>
        igual = True
    fallas += not igual
    print(f"{'IGUAL    ' if igual else 'DISTINTO '} {base}/  ({len(cuerpo):,} bytes{f', {de_mas} de más: el contador de visitas' if de_mas else ''})  guardado: {cab.get('Cache-Control')}  buscadores: {cab.get('X-Robots-Tag')}")
    pedidos = re.findall(rb'<script src="([^"]+)"></script>', cuerpo)
    propios = [p.decode() for p in pedidos if not p.startswith(b'http')]
    for ref in propios:
        nombre, _, marca = ref.partition('?v=')
        datos, c = bajar(f'{base}/{ref}')
        local = (LOCAL / nombre).read_bytes()
        bien = datos == local and marca == hashlib.sha256(local).hexdigest()[:12]
        fallas += not bien
        print(f"{'IGUAL    ' if bien else 'DISTINTO '} {base}/{ref}  ({len(datos):,} bytes)  guardado: {c.get('Cache-Control')}")
    if sorted(p.partition('?v=')[0] for p in propios) != ['conexion.js', 'config.js'] or not all('?v=' in p for p in propios):
        fallas += 1
        print('FALTA     el index publicado no pide config.js y conexion.js con su marca:', propios)
print('TODO BIEN' if not fallas else f'{fallas} DIFERENCIAS')
sys.exit(1 if fallas else 0)
