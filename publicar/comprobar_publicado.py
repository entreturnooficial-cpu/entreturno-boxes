# Comprueba que lo publicado es igual a lo armado en publicar\\yanina\\ y con qué reglas de guardado se sirve.
#   python -X utf8 publicar\\comprobar_publicado.py              (mira una vez)
#   python -X utf8 publicar\\comprobar_publicado.py --esperar    (después de un push: prueba cada 10 segundos hasta 3 minutos)
# Baja la página como la baja un navegador que entra por primera vez: el index, y los archivos que ese index pide
# (con su marca ?v=…). No entra con ninguna cuenta ni cambia nada.
import hashlib
import re
import sys
import time
import urllib.request
from pathlib import Path

LOCAL = Path(__file__).resolve().parent / 'yanina'
# Los dos salen del mismo proyecto de Pages, «entreturno-boxes», que publica solo cada «push» a main (desde el 25/11/2026).
# El proyecto anterior, «yanina-entreturno» (subida a mano), quedó sin dominio, de respaldo: no se mira.
SITIOS = ('https://yanina.entreturno.com.ar', 'https://entreturno-boxes.pages.dev')


def bajar(url):
    pedido = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 comprobacion', 'Cache-Control': 'no-cache'})
    with urllib.request.urlopen(pedido, timeout=30) as r:
        return r.read(), r.headers


def comprobar():
    fallas, renglones = 0, []
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
        renglones.append(f"{'IGUAL    ' if igual else 'DISTINTO '} {base}/  ({len(cuerpo):,} bytes{f', {de_mas} de más: el contador de visitas' if de_mas else ''})  guardado: {cab.get('Cache-Control')}  buscadores: {cab.get('X-Robots-Tag')}")
        pedidos = re.findall(rb'<script src="([^"]+)"></script>', cuerpo)
        propios = [p.decode() for p in pedidos if not p.startswith(b'http')]
        for ref in propios:
            nombre, _, marca = ref.partition('?v=')
            datos, c = bajar(f'{base}/{ref}')
            local = (LOCAL / nombre).read_bytes()
            bien = datos == local and marca == hashlib.sha256(local).hexdigest()[:12]
            fallas += not bien
            renglones.append(f"{'IGUAL    ' if bien else 'DISTINTO '} {base}/{ref}  ({len(datos):,} bytes)  guardado: {c.get('Cache-Control')}")
        if sorted(p.partition('?v=')[0] for p in propios) != ['conexion.js', 'config.js'] or not all('?v=' in p for p in propios):
            fallas += 1
            renglones.append(f'FALTA     el index publicado no pide config.js y conexion.js con su marca: {propios}')
    return fallas, renglones


intentos = 18 if '--esperar' in sys.argv[1:] else 1
for n in range(intentos):
    try:
        fallas, renglones = comprobar()
    except OSError as e:                       # sin respuesta (por ejemplo, justo mientras Cloudflare cambia una versión por otra)
        fallas, renglones = 1, [f'SIN RESPUESTA  {e}']
    if not fallas or n == intentos - 1:
        break
    time.sleep(10)
print(*renglones, sep='\n')
if intentos > 1:
    print(f'(intento {n + 1} de {intentos})')
print('TODO BIEN' if not fallas else f'{fallas} DIFERENCIAS')
sys.exit(1 if fallas else 0)
