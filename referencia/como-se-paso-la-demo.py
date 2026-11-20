# Cómo se pasó la demo a la página real (se corrió una sola vez, el 20/11/2026).
#
# Toma referencia\demo-de-la-que-se-partio.html y arma web\index.html: las mismas pantallas, pero los datos ya no
# viven en el navegador sino en el servidor (web\conexion.js). Cada cambio busca un texto exacto de la demo y frena
# si no lo encuentra, así nada queda a medio cambiar. De acá en más web\index.html se edita a mano: este archivo
# queda como registro de qué se cambió.
#
#   python -X utf8 referencia\como-se-paso-la-demo.py            → escribe web\index.html (frena si ya existe)
#   python -X utf8 referencia\como-se-paso-la-demo.py pisar      → lo vuelve a armar desde la demo
import re
import sys
from pathlib import Path

AQUI = Path(__file__).resolve().parent
t = (AQUI / 'demo-de-la-que-se-partio.html').read_text(encoding='utf-8')
SALIDA = AQUI.parent / 'web' / 'index.html'
if SALIDA.exists() and 'pisar' not in sys.argv[1:]:
    sys.exit(f'Ya existe {SALIDA}. Para rearmarlo desde la demo: agregar «pisar».')


def cambiar(viejo, nuevo, veces=1):
    global t
    n = t.count(viejo)
    assert n == veces, f'esperaba {veces} y hay {n}: {viejo[:90]!r}'
    t = t.replace(viejo, nuevo)


def entre(inicio, fin, nuevo):
    """Reemplaza desde `inicio` (incluido) hasta `fin` (sin incluirlo)."""
    global t
    assert t.count(inicio) == 1, f'el inicio aparece {t.count(inicio)} veces: {inicio[:90]!r}'
    a = t.index(inicio)
    b = t.index(fin, a + len(inicio))
    t = t[:a] + nuevo + t[b:]


def seccion(nombre):
    return f'/* =========================================================\n   {nombre}\n   ========================================================= */'


# =====================================================================================================
# Cabecera, estilos y cuerpo
# =====================================================================================================
cambiar('<title>Consultorio Yani · Boxes</title>', '<title>Alquiler de boxes</title>')
entre('<link rel="icon" href="data:image/svg+xml', '<meta name="description"',
      '<link rel="icon" id="favicon" href="data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 32 32\'%3E%3Ccircle cx=\'16\' cy=\'16\' r=\'16\' fill=\'%231C1917\'/%3E%3C/svg%3E">\n')
cambiar('<meta name="description" content="Demo de la app de alquiler de boxes del consultorio: reservas, pagos y panel de administración.">',
        '<meta name="description" content="Alquiler de boxes por turnos: mirá qué box está libre, reservá y pagá desde el celular.">\n<meta name="robots" content="noindex">')
cambiar('localStorage.getItem("boxes-demo-theme")', 'localStorage.getItem("et-tema")')
# La barra «Demo» de arriba ya no existe: solo queda el margen de la zona segura del celular
cambiar('--demobar:calc(44px + env(safe-area-inset-top,0px));', '--demobar:env(safe-area-inset-top,0px);')
cambiar('</style>\n</head>', r'''
/* ---------- Lo que suma la versión real ---------- */
.boot{min-height:100vh;min-height:100dvh;display:grid;place-items:center;text-align:center;padding:24px;color:var(--muted)}
.boot h2{color:var(--text)}
.auth{position:relative}
.auth-theme{position:absolute;top:calc(14px + env(safe-area-inset-top,0px));right:16px;z-index:5}
body.is-busy{cursor:progress}
body.is-busy .btn{pointer-events:none;opacity:.62}
</style>
</head>''')
entre('<div class="demobar" role="region"', '<div id="app" class="app"></div>', '')
cambiar('<div id="toast" class="toast" role="status" aria-live="polite"></div>\n\n<script>',
        '<div id="toast" class="toast" role="status" aria-live="polite"></div>\n\n<script src="config.js"></script>\n<script src="conexion.js"></script>\n<script>')

# =====================================================================================================
# Marca: las letras y el nombre salen de los datos del consultorio
# =====================================================================================================
entre('/* Monograma Y|O: el mismo del logo de la doctora */', '/* Plano del consultorio con los 3 boxes', r'''/* Monograma del consultorio: sus dos letras (o una), como en su logo */
const mono = (cls = "") => {
  const L = String((S && S.site && S.site.letters) || "").slice(0, 2);
  const dentro = L.length === 2
    ? `<text x="12.4" y="24.8" text-anchor="middle">${esc(L[0])}</text><path d="M20 12.2v15.6"/><text x="27.8" y="24.8" text-anchor="middle">${esc(L[1])}</text>`
    : `<text x="20" y="24.8" text-anchor="middle">${esc(L || "·")}</text>`;
  return `<svg class="mono ${cls}" viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="20"/>${dentro}</svg>`;
};

''')

# =====================================================================================================
# Conexión con el servidor y estado (reemplaza los datos de ejemplo guardados en el navegador)
# =====================================================================================================
entre(seccion('Estado (localStorage) y datos de ejemplo'), seccion('Dominio'), seccion('Conexión con el servidor y estado') + r'''
const CFG = window.ENTRETURNO || {};
/* Qué consultorio es: sale de la dirección (yanina.entreturno.com.ar → «yanina»), salvo que config.js lo fije */
const SLUG = String(CFG.slug || location.hostname.split(".")[0] || "").toLowerCase();
const almacen = (() => {
  try { localStorage.getItem("et-sesion"); return localStorage; }
  catch (e) { const m = {}; return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: (k) => { delete m[k]; } }; }
})();
const servidor = crearConexion({ url: CFG.url, key: CFG.key, slug: SLUG, almacen });
const FOTOS = !!CFG.fotos; // subir fotos necesita el depósito de archivos del servidor real

let S = null;              // lo que manda el servidor, con los nombres de siempre, más S.ui (lo de esta pantalla)
let fase = "cargando";     // cargando · error · lista
let errorDeArranque = "";
let desfase = 0;           // cuánto difiere el reloj de este aparato del reloj del servidor (milisegundos)
let ultimaCarga = 0;
let pendienteDeDibujar = false;
const ahora = () => Date.now() + desfase;
const UI_KEY = "et-ui-" + SLUG;
const uiGuardada = () => { try { return JSON.parse(localStorage.getItem(UI_KEY)) || {}; } catch (e) { return {}; } };
const guardarUi = () => { try { localStorage.setItem(UI_KEY, JSON.stringify(S.ui)); } catch (e) { /* sin almacén: vale hasta cerrar la página */ } };
const OW = () => esc(S.site.owner);     // cómo se nombra a la dueña en los textos
const SITE = () => esc(S.site.name);    // el nombre del consultorio

function armar(f) {
  const ui = S ? S.ui : Object.assign({ view: null, calDate: todayIso(), tab: {} }, uiGuardada());
  if (!ui.tab) ui.tab = {};
  if (!ui.calDate) ui.calDate = todayIso();
  S = Object.assign({ boxCount: 0 }, f, {
    config: Object.assign({ categories: [], turnHours: 4, depositPct: 50, days: [], policy: {}, terms: { version: 1, text: "" } }, f.config),
    boxes: f.boxes || [], machines: f.machines || [], users: f.users || [], blocks: f.blocks || [], releases: f.releases || [],
    bookings: f.bookings || [], invoices: f.invoices || [], session: { userId: f.me || null }, ui,
  });
  if (f.now) desfase = f.now - Date.now();
  document.title = S.site.name + " · Alquiler de boxes";
  const letra = esc(String(S.site.letters || S.site.name || "").slice(0, 1));
  const icono = document.getElementById("favicon");
  if (icono) icono.href = "data:image/svg+xml," + encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><circle cx='16' cy='16' r='16' fill='#1C1917'/><text x='16' y='22.5' text-anchor='middle' font-family='Georgia,serif' font-size='19' fill='white'>${letra}</text></svg>`);
}

/* Trae los datos de nuevo. Sin sesión, solo lo que se ve antes de entrar. */
async function cargar() {
  armar(await servidor.rpc(servidor.sesion ? "foto" : "portada"));
  fase = "lista";
  ultimaCarga = Date.now();
}

const MENSAJES = {
  sin_conexion: "No pudimos conectar. Revisá tu conexión y probá de nuevo.",
  horario_no_disponible: "Ese horario ya no está disponible. Elegí otro.",
  maquina_no_disponible: "Esa máquina se reservó recién en ese horario. La sacamos de tu reserva: revisá el total.",
  demasiadas_sin_pagar: "Tenés reservas sin pagar. Pagalas o cancelalas antes de tomar otro turno.",
  demasiados_saldos: "Ya llegaste al tope de turnos con saldo pendiente. Pagá un saldo o pagá este turno completo.",
  saldo_vencido: "Tenés el saldo de un turno que ya pasó sin pagar. Pagalo en Mis reservas para volver a reservar.",
  reglamento_cambio: "El reglamento cambió recién. Leelo de nuevo antes de reservar.",
  fuera_de_rango: "Todavía no se puede reservar tan adelante.",
  no_aprobada: "Solo las profesionales aprobadas pueden reservar.",
  solo_admin: "Eso solo lo puede hacer la administradora.",
  no_se_puede_cancelar: "Esa reserva ya no se puede cancelar.",
  reserva_inexistente: "No encontramos esa reserva.",
  pago_invalido: "Ese pago ya no corresponde. Actualizamos tus reservas.",
  pago_vencido: "Se terminó el plazo para pagar y el turno se liberó. Si sigue libre, reservalo de nuevo.",
  nada_que_pagar: "Esa reserva ya está paga.",
  pagos_no_simulados: "El pago de prueba ya no está disponible.",
  horario_invalido: "Ese horario no es válido. Revisá las horas.",
  fuera_de_bloqueo: "El rato libre tiene que estar dentro del horario bloqueado.",
  rato_superpuesto: "Ya hay un rato libre publicado en ese horario.",
  categoria_en_uso: "Hay profesionales con esa categoría. Pasalas antes a otra.",
  ultima_categoria: "Tiene que quedar al menos una categoría.",
  categoria_inexistente: "Esa categoría ya no existe. Elegí otra.",
  dato_invalido: "Revisá los datos: hay algo vacío, demasiado largo o fuera de rango.",
  cuit_invalido: "El CUIT lleva solo números y guiones.",
  cambio_invalido: "Ese cambio no se puede hacer.",
  ya_sos_miembro: "Ya pediste acceso a este consultorio.",
  invalid_credentials: "El mail o la contraseña no coinciden.",
  user_already_exists: "Ya hay una cuenta con ese mail. Entrá con tu contraseña desde «Ingresar».",
  weak_password: "La contraseña es muy corta: usá al menos 6 caracteres.",
  validation_failed: "Revisá el mail: no parece una dirección válida.",
  email_address_invalid: "Revisá el mail: no parece una dirección válida.",
  over_request_rate_limit: "Demasiados intentos. Esperá un minuto y probá de nuevo.",
  confirmar_mail: "Te mandamos un mail para confirmar tu cuenta. Abrilo y después entrá con tu mail y tu contraseña.",
  email_not_confirmed: "Falta confirmar tu mail: abrí el mail que te mandamos.",
  refresh_token_not_found: "Tu sesión se cerró. Entrá de nuevo.",
};
const mensajeDe = (e) => MENSAJES[e && e.code] || "No se pudo hacer. Probá de nuevo en un momento.";

/* Le pide algo al servidor y después vuelve a traer los datos.
   Devuelve lo que contestó el servidor; si no se pudo, avisa por qué y devuelve null (el motivo queda en ultimoError). */
let ocupada = false;
let ultimoError = "";
async function accion(funcion, args) {
  if (ocupada) return null;
  ocupada = true; ultimoError = "";
  document.body.classList.add("is-busy");
  try {
    const r = await servidor.rpc(funcion, args);
    await cargar();
    return r == null ? true : r;
  } catch (e) {
    ultimoError = (e && e.code) || "error";
    toast(mensajeDe(e));
    if (ultimoError !== "sin_conexion") { try { await cargar(); } catch (e2) { /* se reintenta sola en el próximo refresco */ } }
    if (!servidor.sesion) closeSheet(true);       // la sesión dejó de servir: vuelve la pantalla de ingreso
    return null;
  } finally {
    ocupada = false;
    document.body.classList.remove("is-busy");
  }
}

/* Entrar o crear la cuenta, y traer los datos */
async function entrarCon(hacer) {
  if (ocupada) return false;
  ocupada = true;
  document.body.classList.add("is-busy");
  try { await hacer(); await cargar(); return true; }
  catch (e) { toast(mensajeDe(e)); return false; }
  finally { ocupada = false; document.body.classList.remove("is-busy"); }
}

/* Mientras hay una hoja abierta o alguien está escribiendo, no se redibuja la pantalla por detrás */
const puedeDibujar = () => !overlayEl && !(document.activeElement && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName));
async function refrescar() {
  if (ocupada || fase !== "lista") return;
  try { await cargar(); } catch (e) { ultimaCarga = Date.now(); if (servidor.sesion) return; try { await cargar(); } catch (e2) { return; } }
  if (puedeDibujar()) render(); else pendienteDeDibujar = true;
}

''')

# ---------- Dominio: lo que ahora hace el servidor se va de la página
entre('function issueInvoice(row, ym, ts = Date.now(), silent = false) {', 'const senaOf = (total)', '')
cambiar('const senaOf = (total) => Math.round(total * S.config.depositPct / 100);',
        'const senaOf = (total) => Math.round(total * S.config.depositPct / 100);\n'
        '/* La seña de una reserva ya hecha es la que se le informó al reservar, aunque después cambie el porcentaje */\n'
        'const depositOf = (b) => b.deposit == null ? senaOf(b.total) : b.deposit;')
cambiar('  const now = Date.now();\n  return raw.map(s => {', '  const now = ahora();\n  return raw.map(s => {')
cambiar('if (!ignorePast && at(date, start).getTime() < Date.now()) return false;', 'if (!ignorePast && at(date, start).getTime() < ahora()) return false;')
entre('function mail(userId, subject, body, ts = Date.now(), read = false) {', 'function refundFor(b, by = "pro") {', '')
cambiar('const days = (bookingStart(b).getTime() - Date.now()) / 864e5;', 'const days = (bookingStart(b).getTime() - ahora()) / 864e5;')
entre('function cancelBooking(b, by = "pro") {', seccion('Render: shell'), r'''/* Saldos pendientes: los turnos que una profesional señó y todavía no terminó de pagar.
   El tope lo aplica el servidor; acá se usa para avisar antes y para mostrarle a la dueña quién debe. */
function saldos(u = me()) {
  const tope = S.config.maxOpenBalances, ya = ahora();
  const suyas = S.bookings.filter(b => b.userId === u.id);
  const conSaldo = suyas.filter(b => ["confirmada", "cumplida"].includes(b.status) && balanceOf(b) > 0);
  const porSenar = suyas.filter(b => b.status === "pago" && b.plan === "sena");
  const vencidos = conSaldo.filter(b => bookingStart(b).getTime() <= ya);
  const n = conSaldo.length + porSenar.length, enTope = tope != null && n >= tope;
  return { tope, n, conSaldo, vencidos, deuda: conSaldo.reduce((a, b) => a + balanceOf(b), 0),
    bloqueado: enTope && vencidos.length > 0, soloTotal: enTope && vencidos.length === 0 && S.config.depositPct < 100 };
}

/* Lo que cambia solo con el paso del tiempo (un plazo de pago que vence, un turno que termina) lo decide el servidor.
   Acá solo se mira si ya pasó alguno de esos momentos, para volver a pedir los datos. */
function algoVencio() {
  const ya = ahora();
  return S.bookings.some(b => b.userId && ((b.status === "pago" && b.expiresAt && ya > b.expiresAt) || (b.status === "confirmada" && bookingEnd(b).getTime() < ya)));
}

/* Cómo se paga: Mercado Pago o, mientras no esté conectado, un pago de prueba */
const payLine = () => S.site.payments === "simulado"
  ? `<div class="mp-head is-line"><div class="mp-logo">MP</div><div><b>Modo de prueba</b><div class="muted small">El pago es simulado: no se cobra plata de verdad.</div></div></div>`
  : `<div class="mp-head is-line"><div class="mp-logo">MP</div><div><b>Mercado Pago: tarjeta o dinero en cuenta</b><div class="muted small">Se confirma al instante.</div></div></div>`;

''' + seccion('Render: shell'))

# ---------- Shell: tema, navegación y el dibujado general
cambiar('const THEME_KEY = "boxes-demo-theme";', 'const THEME_KEY = "et-tema";')
entre('function paintTheme() {', 'function toggleTheme() {', r'''function paintTheme() {
  const dark = themeNow() === "dark";
  // la barra del navegador del celular acompaña al modo elegido
  $$('meta[name="theme-color"]').forEach(m => m.setAttribute("content", dark ? "#0E0C0B" : "#1C1917"));
  const label = dark ? "Pasar a modo claro" : "Pasar a modo oscuro";
  $$('[data-action="toggle-theme"]').forEach(btn => { btn.setAttribute("aria-label", label); btn.title = label; btn.innerHTML = ic(dark ? "sun" : "moon"); });
}
''')
cambiar('badge: S.bookings.filter(b => b.userId === u.id && b.status === "pago").length }',
        'badge: S.bookings.filter(b => b.userId === u.id && b.status === "pago").length + saldos(u).vencidos.length }')
entre('function renderDemoBar() {', 'function renderView(v) {', r'''function renderBoot() {
  if (fase === "error") return `<div class="boot"><div><h2>No pudimos abrir la página</h2><p style="margin:8px 0 18px">${esc(errorDeArranque)}</p><button class="btn btn-primary" data-action="reintentar">Probar de nuevo</button></div></div>`;
  return `<div class="boot" role="status"><div>Cargando…</div></div>`;
}

function render() {
  if (fase !== "lista") { app.innerHTML = renderBoot(); return; }
  guardarUi();
  pendienteDeDibujar = false;
  const u = me();
  if (!servidor.sesion || !u) { app.innerHTML = servidor.sesion ? renderPedido() : renderAuth(); fx = ""; paintTheme(); return; }
  const nav = navFor(u);
  if (!S.ui.view || !nav.some(n => n.id === S.ui.view)) S.ui.view = nav[0].id;
  const view = S.ui.view;
  const current = nav.find(n => n.id === view);
  const navLinks = nav.map(n => `<a href="#${n.id}" data-nav="${n.id}" ${n.id === view ? 'aria-current="page"' : ""}>${ic(n.icon)}<span>${n.label}</span>${n.badge ? `<span class="badge num">${n.badge}</span>` : ""}</a>`).join("");
  // En el celular la administradora tiene varias secciones: 4 en la barra y "Más"
  let bottom = nav;
  if (nav.length > 5) bottom = [...nav.slice(0, 4), { id: "__more", label: "Más", icon: "more", badge: nav.slice(4).reduce((a, n) => a + (n.badge || 0), 0) }];
  const moreActive = nav.slice(4).some(n => n.id === view) && nav.length > 5;
  const bottomLinks = bottom.map(n => `<a href="#${n.id}" data-nav="${n.id}" ${(n.id === view || (n.id === "__more" && moreActive)) ? 'aria-current="page"' : ""}>${ic(n.icon)}<span>${n.label}</span>${n.badge ? `<span class="dot num">${n.badge}</span>` : ""}</a>`).join("");

  app.innerHTML = `
  <div class="shell">
    <aside class="sidebar" aria-label="Navegación">
      <div class="brand">${mono()}<div><div class="brand-name">${SITE()}</div><div class="brand-sub">${u.role === "admin" ? "Panel de administración" : "Alquiler de boxes"}</div></div></div>
      <nav class="nav">${navLinks}</nav>
      <div class="side-foot"><div class="avatar">${initials(u.name)}</div><div class="who"><b>${esc(u.name)}</b><span>${esc(u.profession)}</span></div>
        <button class="iconbtn" style="margin-left:auto;width:32px;height:32px" data-action="toggle-theme"></button>
        <button class="iconbtn" style="width:32px;height:32px" data-action="logout" title="Cerrar sesión" aria-label="Cerrar sesión">${ic("logout")}</button></div>
    </aside>
    <header class="topbar">${mono("mono-sm")}<div class="brand-name">${esc(current?.label || "")}</div><span class="sp"></span>
      <button class="iconbtn" data-action="toggle-theme"></button>
      <button class="iconbtn" data-action="logout" aria-label="Cerrar sesión" title="Cerrar sesión">${ic("logout")}</button></header>
    <main id="main">${renderView(view)}</main>
    <nav class="bottomnav" aria-label="Navegación">${bottomLinks}</nav>
  </div>`;
  fx = "";
  paintTheme();
}

''')

# ---------- Ingreso y pedido de acceso
entre(seccion('Ingreso / registro'), seccion('Calendario (agenda de los 3 boxes)'), seccion('Ingreso y pedido de acceso') + r'''
let heroDrawn = false; // el plano se dibuja solo la primera vez que aparece el ingreso
const lateralDeIngreso = () => {
  const n = S.boxCount || S.boxes.length, draw = heroDrawn ? "" : "is-drawing";
  heroDrawn = true;
  return `<section class="auth-side">
      <div>
        <div class="brand">${mono()}<div><div class="brand-name">${SITE()}</div><div class="brand-sub">Alquiler de boxes</div></div></div>
        <h1>Tu box equipado, por turnos</h1>
        <p>Mirá qué box está libre, reservá y pagá desde el celular. Sin mensajes de ida y vuelta.</p>
      </div>
      ${n === 3 ? planSvg(0, draw) : ""}
      <ul>
        <li>${ic("check")} ${n} ${n === 1 ? "box equipado" : "boxes equipados"}, turnos de ${S.config.turnHours} h</li>
        <li>${ic("check")} Equipos para sumar a tu turno, por hora</li>
        <li>${ic("check")} Pagás seña del ${S.config.depositPct} % o el total</li>
        <li>${ic("check")} Solo profesionales aprobados por ${OW()}</li>
      </ul>
    </section>`;
};
/* Los datos que se piden para dar acceso (los mismos al crear la cuenta que al pedir acceso con una cuenta que ya existe) */
const camposDelPedido = () => `
            <div class="field"><label for="rn">Nombre y apellido</label><input class="input" id="rn" name="name" required maxlength="80" autocomplete="name"></div>
            <div class="field"><label for="rp">Profesión</label><input class="input" id="rp" name="profession" required maxlength="80" placeholder="Ej.: Médica dermatóloga"></div>
            <div class="field"><span class="lab">¿Qué vas a hacer en el consultorio?</span>
              ${S.config.categories.map(k => `<label class="choice"><input type="radio" name="category" value="${k.id}" required><div><div class="ct">${esc(k.name)}</div>${k.note ? `<div class="cs">${esc(k.note)}</div>` : ""}</div><span class="camt num">${money(k.pricePerHour)}<small> la hora</small></span></label>`).join("")}
              <span class="hint">De esto depende el precio, que también puede cambiar según el box. ${OW()} lo confirma en la entrevista.</span></div>`;

function renderAuth() {
  const tab = S.ui.authTab || "login";
  return `<div class="auth">
    <button class="iconbtn auth-theme" data-action="toggle-theme"></button>
    ${lateralDeIngreso()}
    <section class="auth-main">
      <div class="auth-card">
        <div class="tabs" role="tablist">
          <button role="tab" aria-selected="${tab === "login"}" data-action="auth-tab" data-tab="login">Ingresar</button>
          <button role="tab" aria-selected="${tab === "register"}" data-action="auth-tab" data-tab="register">Pedir acceso</button>
        </div>
        ${tab === "login" ? `
          <h2>Ingresá a tu cuenta</h2>
          <p class="muted" style="margin-bottom:18px">Con tu mail y tu contraseña.</p>
          <form data-form="login">
            <div class="field"><label for="le">Mail</label><input class="input" id="le" name="email" type="email" autocomplete="username" required placeholder="nombre@mail.com"></div>
            <div class="field"><label for="lp">Contraseña</label><input class="input" id="lp" name="password" type="password" autocomplete="current-password" required></div>
            <button class="btn btn-primary btn-block" type="submit">Ingresar</button>
          </form>
          <p class="muted small" style="margin-top:16px">¿Todavía no tenés cuenta? Pedí acceso y ${OW()} te contacta.</p>
        ` : `
          <h2>Pedí acceso</h2>
          <p class="muted" style="margin-bottom:18px">Completá tus datos. ${OW()} te contacta para una entrevista y, si te aprueba, ya podés reservar.</p>
          <form data-form="register">
            ${camposDelPedido()}
            <div class="row2">
              <div class="field"><label for="rm">Mail</label><input class="input" id="rm" name="email" type="email" required autocomplete="email"></div>
              <div class="field"><label for="rt">Teléfono</label><input class="input" id="rt" name="phone" type="tel" maxlength="40" autocomplete="tel"></div>
            </div>
            <div class="row2">
              <div class="field"><label for="rc">CUIT, para tu factura</label><input class="input" id="rc" name="cuit" inputmode="numeric" maxlength="13" placeholder="27-12345678-9"></div>
              <div class="field"><label for="rw">Contraseña</label><input class="input" id="rw" name="password" type="password" autocomplete="new-password" minlength="6" required></div>
            </div>
            <button class="btn btn-primary btn-block" type="submit">Enviar solicitud</button>
          </form>
        `}
      </div>
    </section>
  </div>`;
}

/* Alguien que ya tiene cuenta (por ejemplo, de otro consultorio) pero todavía no pidió acceso a este */
function renderPedido() {
  return `<div class="auth">
    <button class="iconbtn auth-theme" data-action="toggle-theme"></button>
    ${lateralDeIngreso()}
    <section class="auth-main">
      <div class="auth-card">
        <h2>Pedí acceso</h2>
        <p class="muted" style="margin-bottom:18px">Entraste como ${esc(servidor.sesion.user.email || "")}. Completá tus datos: ${OW()} te contacta para una entrevista y, si te aprueba, ya podés reservar.</p>
        <form data-form="pedido">
          ${camposDelPedido()}
          <div class="row2">
            <div class="field"><label for="rt">Teléfono</label><input class="input" id="rt" name="phone" type="tel" maxlength="40" autocomplete="tel"></div>
            <div class="field"><label for="rc">CUIT, para tu factura</label><input class="input" id="rc" name="cuit" inputmode="numeric" maxlength="13" placeholder="27-12345678-9"></div>
          </div>
          <button class="btn btn-primary btn-block" type="submit">Enviar solicitud</button>
        </form>
        <button class="btn btn-text btn-block" style="margin-top:10px" data-action="logout">Salir de esta cuenta</button>
      </div>
    </section>
  </div>`;
}

''' + seccion('Calendario (agenda de los 3 boxes)'))
cambiar('const maxWeek = addDays(minWeek, 7 * 8);', 'const maxWeek = addDays(minWeek, 7 * (S.config.weeksAhead || 8));')

# ---------- Vistas de la profesional
entre('function viewMis() {', 'function viewBoxes() {', r'''function viewMis() {
  const tab = S.ui.tab.mis || "proximas";
  const all = myBookings(), sd = saldos();
  // Los turnos que ya pasaron y todavía se deben van arriba de todo, con las próximas
  const debe = all.filter(b => b.status === "cumplida" && balanceOf(b)).sort((a, b) => bookingStart(a) - bookingStart(b));
  const prox = [...debe, ...all.filter(b => ["pago", "confirmada"].includes(b.status)).sort((a, b) => bookingStart(a) - bookingStart(b))];
  const hist = all.filter(b => (b.status === "cumplida" && !balanceOf(b)) || b.status === "cancelada").sort((a, b) => bookingStart(b) - bookingStart(a));
  const list = tab === "proximas" ? prox : hist;
  const toPay = prox.filter(b => b.status === "pago").length;
  const proxima = prox.find(b => b.status !== "cumplida");
  const finding = debe.length ? `Tenés <b>el saldo de ${debe.length === 1 ? "un turno que ya pasó" : debe.length + " turnos que ya pasaron"} sin pagar</b>: ${money(debe.reduce((a, b) => a + balanceOf(b), 0))}.${sd.bloqueado ? " Pagalo para volver a reservar." : ""}`
    : toPay ? `Tenés <b>${toPay} ${toPay === 1 ? "reserva" : "reservas"} sin pagar</b>: pagala antes de que se libere el horario.`
    : proxima ? `Tu próximo turno es el <b>${fmtDay(proxima.date)}</b>, ${boxById(proxima.boxId).name}, de ${fmtRange(proxima.start, proxima.end)}.` : "No tenés turnos próximos.";
  return `
  <div class="title-row"><div>
    <h1>Mis reservas</h1>
    <p class="finding">${finding}</p>
  </div><button class="btn btn-primary" data-nav="reservar">Reservar otro turno</button></div>
  <div class="tabs" role="tablist">
    <button role="tab" aria-selected="${tab === "proximas"}" data-action="tab" data-k="mis" data-v="proximas">Próximas<span class="n num">${prox.length}</span></button>
    <button role="tab" aria-selected="${tab === "historial"}" data-action="tab" data-k="mis" data-v="historial">Historial<span class="n num">${hist.length}</span></button>
  </div>
  <div class="panel">${list.length ? list.map(bookingCard).join("") : `<div class="empty"><b>${tab === "proximas" ? "No tenés reservas próximas" : "Todavía no hay historial"}</b>${tab === "proximas" ? "Elegí un horario libre en Reservar." : "Acá vas a ver tus turnos cumplidos y cancelados."}</div>`}</div>`;
}

function bookingCard(b) {
  const box = boxById(b.boxId), d = fromIso(b.date), paid = paidOf(b), bal = balanceOf(b);
  let pay = "";
  if (b.status === "pago") pay = `<span class="timer" data-countdown="${b.expiresAt}"></span> para pagar`;
  else if (b.status === "confirmada") pay = bal ? `Pagaste ${money(paid)} de seña · saldo <b class="num">${money(bal)}</b> antes del turno` : b.total ? `Pagaste el total: <b class="num">${money(paid)}</b>` : "Sin cargo";
  else if (b.status === "cumplida") pay = bal ? `Pagaste ${money(paid)} · <b class="num">te falta el saldo: ${money(bal)}</b>` : `Pagado ${money(paid)}`;
  else if (b.status === "cancelada") pay = b.cancelledBy === "vencida" ? "Se liberó porque no se registró el pago a tiempo." : b.refund?.amount ? `Devolución ${money(b.refund.amount)} (${b.refund.pct} %)${b.refund.done ? "" : " · en camino"}` : "Sin devolución";
  const acts = [];
  if (b.status === "pago") {
    acts.push(`<button class="btn btn-primary btn-sm" data-action="pay-now" data-id="${b.id}">Pagar ${money(b.plan === "sena" ? depositOf(b) : b.total)}</button>`);
    acts.push(`<button class="btn btn-sm" data-action="cancel" data-id="${b.id}">Cancelar</button>`);
  }
  if (["confirmada", "cumplida"].includes(b.status) && bal) acts.push(`<button class="btn btn-sm ${b.status === "cumplida" ? "btn-primary" : ""}" data-action="pay-balance" data-id="${b.id}">Pagar saldo</button>`);
  if (b.status === "confirmada") acts.push(`<button class="btn btn-sm btn-danger" data-action="cancel" data-id="${b.id}">Cancelar</button>`);
  return `<article class="bk">
    <div class="bk-date"><div class="m">${MESES_C[d.getMonth()]}</div><div class="d num">${d.getDate()}</div><div class="w">${DIAS_C[d.getDay()]}</div></div>
    <div>
      <div class="t">${esc(box.name)} <span class="hr num">${fmtRange(b.start, b.end)}</span></div>
      <div class="s">${cap(fmtDay(b.date))} · ${esc(b.service || "")}${machinesOf(b).length ? ` · con ${machinesOf(b).map(m => esc(m.name)).join(", ")}` : ""}</div>
      <div style="margin-top:8px">${statusPill(b)}</div>
      <div class="pay">${pay}</div>
    </div>
    <div class="acts">${acts.join("")}</div>
  </article>`;
}

''')
entre('function viewBoxes() {', '/* Dibujo de un equipo, para cuando la máquina todavía no tiene foto */', r'''/* La foto del box o, si todavía no tiene, el plano (que está dibujado para un consultorio de tres boxes) */
const boxArt = (b) => b.photo ? `<img class="foto" src="${esc(b.photo)}" alt="Foto de ${esc(b.name)}">` : planSvg(S.boxes.length === 3 && b.id >= 1 && b.id <= 3 ? b.id : 0);

function viewBoxes() {
  return `
  <div class="title-row"><div>
    <h1>Los boxes</h1>
    <p class="sub">Los espacios equipados del consultorio. Elegí el que mejor se adapte a lo que atendés.</p>
  </div></div>
  <div class="boxes">${S.boxes.map(b => `
    <article class="boxcard">
      ${boxArt(b)}
      <div class="bd">
        <h3>${esc(b.name)}</h3>
        ${b.short ? `<p class="sh">${esc(b.short)}</p>` : ""}
        ${me().role === "pro" ? `<p class="rate"><b class="num">${money(rateOf(me(), b))}</b> la hora · ${esc(catOf(me()).name.toLowerCase())}</p>` : ""}
        <ul class="eq">${b.equipment.map(e => `<li>${esc(e)}</li>`).join("")}</ul>
        ${me().status === "aprobado" && me().role === "pro" ? `<button class="btn" style="margin-top:auto" data-nav="reservar">Ver horarios libres</button>` : ""}
      </div>
    </article>`).join("")}</div>`;
}

''')
cambiar('const machineThumb = (m) => m.photo ? `<img class="thumb" src="${m.photo}" alt="">`', 'const machineThumb = (m) => m.photo ? `<img class="thumb" src="${esc(m.photo)}" alt="">`')
cambiar('${m.photo ? `<img class="foto" src="${m.photo}" alt="${esc(m.name)}">` : machineArt()}', '${m.photo ? `<img class="foto" src="${esc(m.photo)}" alt="${esc(m.name)}">` : machineArt()}')
cambiar('        ${m.photo ? "" : `<p class="photo-note">Ilustración: acá va la foto real del equipo.</p>`}\n', '')
cambiar('Cuando Yani sume un equipo, aparece acá.', 'Cuando ${OW()} sume un equipo, aparece acá.')
entre('function viewEstado() {', seccion('Vistas: administradora'), r'''function viewEstado() {
  const u = me();
  const msg = {
    pendiente: { h: "Tu solicitud está en revisión", p: `${OW()} te va a contactar para coordinar una entrevista. Cuando te apruebe, ya podés reservar.` },
    rechazado: { h: "Tu solicitud no fue aprobada", p: `Por ahora no podés reservar boxes. Si creés que es un error, escribile a ${OW()}.` },
    bloqueado: { h: "Tu cuenta está pausada", p: `La administradora pausó tu acceso a las reservas. Escribile a ${OW()} para más información.` },
  }[u.status] || { h: "", p: "" };
  return `
  <div class="title-row"><div><h1>Mi solicitud</h1><p class="sub">Hola, ${esc(u.name.split(" ")[0])}.</p></div></div>
  <div class="panel pending-card"><div class="panel-b" style="padding:24px">
    <h2>${msg.h}</h2>
    <p class="muted" style="margin-top:6px">${msg.p}</p>
    ${u.status === "pendiente" ? `<ul class="track">
      <li class="done"><i></i>Enviaste tu solicitud · ${fmtWhen(u.since)}</li>
      <li class="now"><i></i>Entrevista con ${OW()}</li>
      <li><i></i>Aprobación y acceso a las reservas</li>
    </ul>` : ""}
    <div class="note acc" style="margin-top:18px">Mientras tanto podés conocer los boxes y su equipamiento.</div>
    <button class="btn" data-nav="boxes">Ver los boxes</button>
  </div></div>`;
}

''' + seccion('Vistas: administradora'))

# ---------- Vistas de la dueña
cambiar('/* Lo único que espera a Yani son los pedidos de acceso: los pagos y las devoluciones los resuelve Mercado Pago */',
        '/* Lo único que espera a la dueña son los pedidos de acceso: los pagos y las devoluciones se registran solos */')
cambiar('const porCobrar = S.bookings.filter(b => b.status === "confirmada").reduce((a, b) => a + balanceOf(b), 0);',
        'const porCobrar = S.bookings.filter(b => ["confirmada", "cumplida"].includes(b.status)).reduce((a, b) => a + balanceOf(b), 0);')
cambiar('<div class="sub">De reservas confirmadas con seña</div>', '<div class="sub">De turnos señados que falta terminar de pagar</div>')
cambiar('Lo elegido queda guardado con el resto de la demo. */', 'Lo elegido queda guardado en este navegador. */')
entre('function viewPagos() {', 'function viewFacturacion() {', r'''function viewPagos() {
  const hist = [];
  S.bookings.forEach(b => b.payments.forEach(p => { if (p.status === "aprobado") hist.push({ b, p }); }));
  hist.sort((x, y) => y.p.at - x.p.at);
  const amt = (p) => `${p.kind === "devolucion" ? "− " : ""}${money(p.amount)}`;
  return `
  <div class="title-row"><div><h1>Pagos</h1><p class="sub">${S.site.payments === "simulado" ? "Modo de prueba: los pagos son simulados, todavía no se cobra plata de verdad." : "Los cobros y las devoluciones pasan por Mercado Pago y se registran solos."}</p></div></div>
  <div class="panel"><div class="panel-b" style="padding-top:8px">${hist.length ? `
    <div class="table-wrap"><table class="table"><thead><tr><th>Fecha</th><th>Profesional</th><th>Concepto</th><th class="num">Monto</th></tr></thead><tbody>
    ${hist.map(({ b, p }) => `<tr><td class="num">${fmtWhen(p.at)}</td><td>${esc(userById(b.userId).name)}</td><td>${KIND[p.kind]}<div class="s">${esc(boxById(b.boxId).name)}, ${fmtDayShort(b.date)}</div></td><td class="num">${amt(p)}</td></tr>`).join("")}</tbody></table></div>
    <div class="mrows">${hist.map(({ b, p }) => `<div class="mrow" style="cursor:default"><div class="main"><div class="l1"><span>${esc(userById(b.userId).name)}</span><span class="num">${amt(p)}</span></div><div class="l2">${KIND[p.kind]} · ${esc(boxById(b.boxId).name)}, ${fmtDayShort(b.date)} · ${fmtWhen(p.at)}</div></div></div>`).join("")}</div>`
    : `<div class="empty"><b>Todavía no hay pagos</b>Cuando alguien reserve y pague, aparece acá.</div>`}</div></div>`;
}

''')
cambiar('`<button class="btn btn-sm" data-action="inv-one" data-id="${r.u.id}">Facturar</button>`;', '`<span class="muted small">Falta conectar ARCA</span>`;')
cambiar('<button class="btn btn-primary" data-action="inv-all" ${pend.length ? "" : "disabled"}>Facturar todo el mes</button>',
        '<button class="btn btn-primary" disabled title="Se activa cuando se conecte ARCA">Facturar todo el mes</button>')
cambiar('Demostración: las facturas de esta pantalla son de muestra. En la versión real, cada una se autoriza en ARCA con los datos de ${esc(bl.name)} (CUIT ${esc(bl.cuit)}, ${esc(bl.cond)}) y queda guardada con su número de autorización.',
        'Las facturas todavía no se emiten desde acá: falta conectar ARCA con los datos de ${esc(bl.name || "quien factura")}${bl.cuit ? ` (CUIT ${esc(bl.cuit)}, ${esc(bl.cond)})` : ""}. Mientras tanto, esta pantalla te muestra cuánto hay que facturarle a cada profesional.')
cambiar('`${nb} ${nb === 1 ? "reserva activa" : "reservas activas"}` : ""}</div></div>',
        '`${nb} ${nb === 1 ? "reserva activa" : "reservas activas"}` : ""}${debeTxt(u)}</div></div>')
cambiar('function viewProfesionales() {', r'''/* Cuánto debe una profesional: los saldos de los turnos que señó y todavía no terminó de pagar */
const debeTxt = (u) => {
  const sd = saldos(u);
  return sd.deuda ? ` · <b>debe ${money(sd.deuda)}</b> de ${sd.conSaldo.length} ${sd.conSaldo.length === 1 ? "turno" : "turnos"}${sd.vencidos.length ? ` (${sd.vencidos.length} ya ${sd.vencidos.length === 1 ? "pasó" : "pasaron"})` : ""}` : "";
};

function viewProfesionales() {''')
cambiar('<p class="sub">Solo reservan las que aprobás después de la entrevista.</p></div><button class="btn btn-dark" data-action="add-pro">Crear cuenta</button></div>',
        '<p class="sub">Solo reservan las que aprobás después de la entrevista. Pasales la dirección de esta página: piden acceso desde ahí y te aparecen acá.</p></div></div>')
cambiar('const tag = `<span class="tag-example">Ejemplo, a definir con vos</span>`;', 'const tag = "";')
cambiar('<p class="sub">Los valores son de ejemplo. Cambialos y mirá cómo se actualiza la agenda.</p>', '<p class="sub">Lo que cambiás acá vale para las reservas nuevas.</p>')
cambiar('const opt = (arr, v, f = (x) => x) => arr.map(x => `<option value="${x}" ${x === v ? "selected" : ""}>${f(x)}</option>`).join("");',
        'const opt = (arr, v, f = (x) => x) => arr.map(x => `<option value="${x}" ${x === v ? "selected" : ""}>${f(x)}</option>`).join("");\n'
        '  // igual que opt, pero si el valor guardado no está entre las opciones lo suma (así guardar no lo cambia sin querer)\n'
        '  const optv = (arr, v, f) => opt(arr.includes(v) ? arr : [...arr, v].sort((a, b) => a - b), v, f);')
n_opt = t.count('${opt([')
t = t.replace('${opt([', '${optv([')
assert n_opt == 9, n_opt        # duración del turno, seña, plazo, anticipación y los cuatro porcentajes de la política (uno tiene cinco valores)
cambiar('<label for="mpm">Plazo para pagar con Mercado Pago</label>', '<label for="mpm">Plazo para pagar al reservar</label>')
t, n = re.subn(r'(x => x \+ " minutos"\)\}</select></div>\s*</div>)(\s*<div class="acts">)',
               lambda m: m.group(1) + r'''
        <div class="field"><label for="ms">Turnos con saldo pendiente que puede tener cada profesional</label>
          <select class="input" id="ms" name="maxSaldos" style="max-width:340px">${[1, 2, 3, 5].concat(c.maxOpenBalances == null || [1, 2, 3, 5].includes(c.maxOpenBalances) ? [] : [c.maxOpenBalances]).sort((a, b) => a - b).map(x => `<option value="${x}" ${x === c.maxOpenBalances ? "selected" : ""}>${x === 1 ? "Uno solo" : "Hasta " + x}</option>`).join("")}<option value="" ${c.maxOpenBalances == null ? "selected" : ""}>Sin tope</option></select>
          <span class="hint">Son los turnos que señó y todavía no terminó de pagar. Al llegar a ese número, el turno siguiente lo paga completo; y si debe el saldo de un turno que ya pasó, no reserva hasta pagarlo.</span></div>''' + m.group(2), t, count=1)
assert n == 1, n
cambiar('<div class="photo-acts"><label class="btn btn-sm">${b.photo ? "Cambiar foto" : "Subir foto"}<input type="file" accept="image/*" data-upload="box" data-id="${b.id}" hidden></label>',
        '${FOTOS ? `<div class="photo-acts"><label class="btn btn-sm">${b.photo ? "Cambiar foto" : "Subir foto"}<input type="file" accept="image/*" data-upload="box" data-id="${b.id}" hidden></label>')
cambiar('data-action="box-photo-del" data-id="${b.id}">Quitar</button>` : ""}</div></div>',
        'data-action="box-photo-del" data-id="${b.id}">Quitar</button>` : ""}</div>` : ""}</div>')
cambiar('`<img class="thumb thumb-lg" src="${b.photo}" alt="Foto de ${esc(b.name)}">`', '`<img class="thumb thumb-lg" src="${esc(b.photo)}" alt="Foto de ${esc(b.name)}">`')
cambiar('Los datos con los que se emiten las facturas del mes. En la versión real, la conexión con ARCA se hace una sola vez.',
        'Los datos con los que se emiten las facturas del mes. La conexión con ARCA se hace una sola vez, con tu certificado.')
cambiar('<div class="note">ARCA: sin conectar. En esta demostración las facturas son de muestra.</div>',
        '<div class="note">ARCA: sin conectar todavía. Estos datos quedan guardados para cuando se conecte.</div>')

# ---------- Hojas: reservar, pagar, cancelar
cambiar('  draft = { boxId, date, start, end, step: 1, service: "", plan: "sena", accepted: false, machines: [] };', r'''  const sd = saldos(u);
  if (sd.bloqueado) { toast(MENSAJES.saldo_vencido); go("mis"); return; }
  draft = { boxId, date, start, end, step: 1, service: "", plan: sd.soloTotal ? "total" : "sena", accepted: false, machines: [] };''')
cambiar('Solo lo ve Yani. Las demás profesionales ven este horario como “Ocupado”.', 'Solo lo ve ${OW()}. Las demás profesionales ven este horario como “Ocupado”.')
entre('  } else if (d.step === 2) {', '      <div class="group-l">Reglamento de uso del consultorio', r'''  } else if (d.step === 2) {
    const sena = senaOf(total), sd = saldos();
    if (sd.soloTotal) d.plan = "total";
    body = `
      <div class="group-l">¿Cuánto pagás ahora?</div>
      <label class="choice ${sd.soloTotal ? "is-off" : ""}"><input type="radio" name="plan" value="sena" data-draft="plan" ${d.plan === "sena" ? "checked" : ""} ${sd.soloTotal ? "disabled" : ""}><div><div class="ct">Seña del ${c.depositPct} %</div><div class="cs">${sd.soloTotal ? `Ya tenés ${sd.n} ${sd.n === 1 ? "turno" : "turnos"} con saldo pendiente: este va completo, o pagá antes un saldo` : `El resto (${money(total - sena)}) lo pagás antes del turno`}</div></div><span class="camt num">${money(sena)}</span></label>
      <label class="choice"><input type="radio" name="plan" value="total" data-draft="plan" ${d.plan === "total" ? "checked" : ""}><div><div class="ct">Total</div><div class="cs">Y te olvidás del saldo</div></div><span class="camt num">${money(total)}</span></label>
      <div class="group-l">Cómo se paga</div>
      ${payLine()}
      <div class="note">Si cancelás con ${p.days} días o más, te devolvemos el ${d.plan === "sena" ? p.senaBefore : p.totalBefore} %. Con menos, ${d.plan === "sena" ? (p.senaAfter ? `el ${p.senaAfter} %` : "la seña no se devuelve") : `el ${p.totalAfter} %`}.</div>`;
    foot = `<button class="btn" data-action="draft-back">Atrás</button><button class="btn btn-primary" data-action="draft-next">Continuar</button>`;
  } else {
    body = `
''')
cambiar('${d.plan === "sena" ? "de seña" : ""} con Mercado Pago. Tenés ${c.mpMinutes} minutos para completar el pago.',
        '${d.plan === "sena" ? "de seña" : ""}. Tenés ${c.mpMinutes} minutos para completar el pago.')
entre('function confirmDraft() {', '/* ---------- Cancelación con devolución calculada (RF16, RF17) ---------- */', r'''async function confirmDraft() {
  const d = draft;
  if (!d.accepted) { toast("Tenés que aceptar el reglamento para reservar."); return; } // RN05
  const r = await accion("reservar", { p_box: d.boxId, p_fecha: d.date, p_desde: d.start, p_hasta: d.end, p_servicio: d.service.trim(), p_plan: d.plan,
    p_maquinas: d.machines, p_reglamento_version: S.config.terms.version });
  if (!r) {
    if (ultimoError === "maquina_no_disponible") {            // alguien se llevó la máquina mientras se completaba la reserva
      d.machines = d.machines.filter(id => machineById(id) && machineById(id).active && !machineBusy(id, d.date, d.start, d.end));
      d.step = 1; renderBookingSheet(); return;
    }
    if (ultimoError === "reglamento_cambio") { d.accepted = false; d.step = 3; renderBookingSheet(); return; }
    if (ultimoError === "demasiados_saldos") { d.plan = "total"; d.step = 2; renderBookingSheet(); return; }
    if (ultimoError === "sin_conexion") return;                // la hoja queda abierta para reintentar
    draft = null; closeSheet(); render(); return;
  }
  draft = null;
  render();
  const b = findB(r.id);
  if (!b) { closeSheet(); return; }
  if (b.status === "pago") openMp(b, b.plan);
  else showSuccess(b, "¡Reserva confirmada!", "No había nada para pagar.");
}

/* ---------- El pago (RF13, RN08): Mercado Pago o, mientras no esté conectado, un pago de prueba ---------- */
const amountOf = (b, kind) => kind === "saldo" ? balanceOf(b) : kind === "sena" ? depositOf(b) : b.total;
function openMp(b, kind) {
  const amount = amountOf(b, kind);
  const resumen = `<div class="mp-head"><div class="mp-logo">MP</div><div><b>${SITE()}</b><div class="muted small">${KIND[kind]} · ${esc(boxById(b.boxId).name)}, ${fmtDayShort(b.date)} ${fmtRange(b.start, b.end)}</div></div></div>
    <div class="amount num">${money(amount)}</div>
    ${b.status === "pago" ? `<p class="muted" style="margin-top:6px">Tu turno queda guardado <span class="timer" data-countdown="${b.expiresAt}"></span>. Si no se paga, se libera solo.</p>` : ""}`;
  if (S.site.payments !== "simulado") {
    openSheet(`${sheetHead("Pagar con Mercado Pago")}
    <div class="sheet-b">${resumen}<div class="note warn">El pago con Mercado Pago todavía se está conectando. Avisale a ${OW()} para coordinar el pago.</div></div>
    <div class="sheet-f"><button class="btn" data-action="close-sheet">Cerrar</button></div>`);
  } else {
    openSheet(`${sheetHead("Pagar", "Modo de prueba: el pago es simulado, no se cobra plata de verdad")}
    <div class="sheet-b">${resumen}</div>
    <div class="sheet-f"><button class="btn" data-action="close-sheet">Ahora no</button><button class="btn btn-primary" data-action="mp-approve" data-id="${b.id}" data-kind="${kind}">Pagar ${money(amount)}</button></div>`);
  }
  tick();
}
async function mpApprove(id, kind) {
  const r = await accion("simular_pago", { p_reserva: id, p_tipo: kind });
  render();
  const b = findB(id);
  if (!r || !b) { if (ultimoError !== "sin_conexion") closeSheet(); return; }
  showSuccess(b, kind === "saldo" ? "¡Listo! Pagaste el saldo" : "¡Reserva confirmada!", kind === "saldo" ? "Tu turno está pago completo." : "Te vamos a recordar el turno el día anterior.");
}

function showSuccess(b, title, text) {
  openSheet(`${sheetHead("")}
  <div class="sheet-b"><div class="success"><div class="ok-ic">${ic("check")}</div><h3>${title}</h3><p>${text}</p></div>
    <div class="summary" style="margin-top:18px"><b>${esc(boxById(b.boxId).name)}</b><span class="r">${statusPill(b)}</span><span class="muted">${cap(fmtDay(b.date))}</span><span class="muted r num">${fmtRange(b.start, b.end)}</span></div>
    <ul class="track">
      <li class="done"><i></i>Reservaste el horario</li>
      <li class="done"><i></i>${paidOf(b) ? "Pago aprobado" : "Sin cargo"}</li>
      <li class="done"><i></i>Reserva confirmada</li>
    </ul></div>
  <div class="sheet-f"><button class="btn" data-action="close-sheet">Seguir mirando</button><button class="btn btn-primary" data-action="go-mis">Ver mis reservas</button></div>`);
}

''')
cambiar('"La devolución vuelve sola a la cuenta de Mercado Pago."', '"La devolución vuelve por el mismo medio con el que se pagó. Puede tardar unos días."')
cambiar('${esc(catById(b.category || u.category).name)} · ${money(b.rate || rateOf(u, box))} la hora', '${esc(b.categoryName || catById(b.category || u.category).name)} · ${money(b.rate || rateOf(u, box))} la hora')
cambiar('` · devolución ${money(b.refund.amount)} por Mercado Pago`', '` · devolución ${money(b.refund.amount)}${b.refund.done ? "" : " (en camino)"}`')
cambiar('<div class="group-l" style="margin-top:16px">Pagos por Mercado Pago</div>', '<div class="group-l" style="margin-top:16px">Pagos</div>')

# ---------- Lo que era solo de la demo (mails de muestra, crear cuenta sin servidor, fotos guardadas en el navegador)
entre('function openMails() {', '/* ---------- Categorías, máquinas y fotos (ajustes de la administradora) ---------- */', '')
entre('let machinePhoto = null;', 'function openMachineSheet(m) {', r'''let machinePhoto = null; // la foto elegida en la hoja de la máquina, hasta que se guarda
const machinePhotoHtml = () => `${machinePhoto ? `<img class="thumb thumb-lg" src="${esc(machinePhoto)}" alt="">` : `<div class="thumb thumb-lg">${ic("image")}</div>`}
  ${FOTOS ? `<div class="photo-acts"><label class="btn btn-sm">${machinePhoto ? "Cambiar foto" : "Subir foto"}<input type="file" accept="image/*" data-upload="machine" hidden></label>${machinePhoto ? `<button class="btn btn-sm btn-text" type="button" data-action="machine-photo-del">Quitar</button>` : ""}<span class="hint">La foto se achica sola para que cargue rápido.</span></div>` : ""}`;
''')
entre('const FULL = "La foto se ve', 'function openInvoice(inv) {', '/* ---------- Factura del mes ---------- */\n')
cambiar('<div class="note">Número de autorización de muestra: ${inv.cae}. En la versión real lo entrega ARCA al emitir.</div>', '<div class="note">Número de autorización (CAE): ${esc(inv.cae)}</div>')

# =====================================================================================================
# Eventos: cada cosa que antes cambiaba los datos en el navegador ahora se la pide al servidor
# =====================================================================================================
entre(seccion('Eventos'), '</script>\n</body>', seccion('Eventos') + r'''
function go(view) { closeSheet(true); S.ui.view = view; render(); window.scrollTo(0, 0); }
/* Al pasar de paso en la reserva, el contenido entra desde el lado hacia donde se avanza */
function stepFx(dir) {
  const el = overlayEl?.querySelector(".sheet-b");
  if (!el || !el.animate) return;
  const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.animate([{ opacity: 0, transform: calm ? "none" : `translateX(${dir * 10}px)` }, { opacity: 1, transform: "none" }], { duration: 220, easing: "cubic-bezier(0.23, 1, 0.32, 1)" });
}
const findB = (id) => S.bookings.find(b => b.id === id);

document.addEventListener("click", async (e) => {
  const navEl = e.target.closest("[data-nav]");
  if (navEl) {
    e.preventDefault();
    const v = navEl.dataset.nav;
    if (v === "__more") {
      openSheet(`${sheetHead("Más opciones")}<div class="sheet-b"><nav class="nav">${navFor(me()).slice(4).map(n => `<a href="#${n.id}" data-nav="${n.id}" style="height:48px">${ic(n.icon)}<span>${n.label}</span>${n.badge ? `<span class="badge num">${n.badge}</span>` : ""}</a>`).join("")}</nav></div>`);
      return;
    }
    go(v); return;
  }
  const el = e.target.closest("[data-action]");
  if (!el) return;
  const a = el.dataset.action, ds = el.dataset;
  switch (a) {
    case "close-sheet": closeSheet(); if (pendienteDeDibujar && fase === "lista") render(); break;
    case "toggle-theme": toggleTheme(); break;
    case "reintentar": iniciar(); break;
    case "logout":
      closeSheet(true);
      await servidor.salir();
      S.ui.view = null; S.ui.calPicked = false;
      try { await cargar(); } catch (err) { fase = "error"; errorDeArranque = mensajeDe(err); }
      render(); window.scrollTo(0, 0); break;
    case "auth-tab": S.ui.authTab = ds.tab; render(); break;
    case "tab": S.ui.tab[ds.k] = ds.v; render(); break;
    case "cal-day": S.ui.calDate = ds.date; S.ui.calPicked = true; fx = "cal"; render(); break;
    case "cal-today": S.ui.calDate = todayIso(); fx = "cal"; render(); break;
    case "cal-week": S.ui.calDate = addDays(mondayOf(S.ui.calDate), 7 * Number(ds.dir)); fx = "cal"; render(); break;
    case "go-agenda-today": S.ui.calDate = todayIso(); go("agenda"); break;
    case "ag-view": S.ui.agView = ds.v; fx = "cal"; render(); break;
    case "ag-day": S.ui.calDate = ds.date; S.ui.agView = "dia"; S.ui.calPicked = true; fx = "cal"; render(); window.scrollTo(0, 0); break;
    case "ag-move": {
      const v = agView(), dir = +ds.dir;
      if (v === "mes") S.ui.calDate = ymAdd(ymOf(S.ui.calDate), dir) + "-01";
      else S.ui.calDate = addDays(v === "semana" ? mondayOf(S.ui.calDate) : S.ui.calDate, dir * (v === "semana" ? 7 : agDays()));
      fx = "cal"; render(); break;
    }
    case "go-mis": S.ui.tab.mis = "proximas"; go("mis"); break;
    case "book": startBooking(+ds.box, ds.date, +ds.start, +ds.end); break;
    case "draft-next":
      if (draft.step === 1) draft.service = ($("#svc")?.value || "").trim();
      draft.step++; renderBookingSheet(); stepFx(1); break;
    case "draft-back": draft.step--; renderBookingSheet(); stepFx(-1); break;
    case "draft-confirm": await confirmDraft(); break;
    case "my-booking": { const b = findB(ds.id); S.ui.tab.mis = (b.status === "cumplida" && !balanceOf(b)) || b.status === "cancelada" ? "historial" : "proximas"; go("mis"); break; }
    case "pay-now": { const b = findB(ds.id); if (b) openMp(b, b.plan); break; }
    case "pay-balance": { const b = findB(ds.id); if (b) openMp(b, "saldo"); break; }
    case "mp-approve": await mpApprove(ds.id, ds.kind); break;
    case "cancel": openCancel(findB(ds.id), "pro"); break;
    case "admin-cancel": openCancel(findB(ds.id), "admin"); break;
    case "confirm-cancel": {
      const r = await accion("cancelar_reserva", { p_reserva: ds.id });
      if (!r && ultimoError === "sin_conexion") break;
      closeSheet(); render();
      if (r) toast(r.amount ? `Reserva cancelada. Devolución: ${money(r.amount)}.` : "Reserva cancelada. El horario quedó libre.");
      break;
    }
    // Administradora
    case "adm-free": openBlockSheet(+ds.box, ds.date, +ds.start, +ds.end); break;
    case "adm-new-block": openBlockSheet(null, S.ui.calDate < todayIso() ? todayIso() : S.ui.calDate); break;
    case "adm-block": { const bl = S.blocks.find(x => x.id === ds.id); if (bl) openBlockedSheet(bl, +ds.box, ds.date); break; }
    case "adm-release": {
      const rl = S.releases.find(x => x.id === ds.id);
      if (!rl) break;
      openSheet(`${sheetHead("Rato libre publicado", `${esc(boxById(rl.boxId).name)} · ${cap(fmtDay(rl.date))} · ${fmtRange(rl.start, rl.end)}`)}
        <div class="sheet-b"><p>Las profesionales aprobadas lo ven como “Rato libre” y lo pueden reservar, cada una al precio por hora que le corresponde.</p></div>
        <div class="sheet-f"><button class="btn" data-action="close-sheet">Cerrar</button><button class="btn btn-dark" data-action="delete-release" data-id="${rl.id}">Volver a bloquearlo</button></div>`);
      break;
    }
    case "delete-release": { const r = await accion("quitar_rato", { p_rato: ds.id }); closeSheet(); render(); if (r) toast("El horario volvió a quedar bloqueado."); break; }
    case "unblock-day": { const r = await accion("liberar_dia", { p_bloqueo: ds.block, p_box: +ds.box, p_fecha: ds.date }); closeSheet(); render(); if (r) toast("Liberaste ese día completo para alquilar."); break; }
    case "delete-block": { const r = await accion("quitar_bloqueo", { p_bloqueo: ds.block }); closeSheet(); render(); if (r) toast("Bloqueo quitado."); break; }
    case "adm-booking": { const b = findB(ds.id); if (b) openAdminBooking(b); break; }
    case "user-status": {
      const nombre = userById(ds.id).name;
      const r = await accion("cambiar_estado_profesional", { p_miembro: ds.id, p_estado: ds.s });
      render();
      if (r) toast({ aprobado: `${nombre} ya puede reservar.`, rechazado: "Solicitud rechazada.", bloqueado: `Pausaste el acceso de ${nombre}.` }[ds.s]);
      break;
    }
    // Ajustes: categorías y máquinas
    case "cat-add": openCatSheet(null); break;
    case "cat-edit": openCatSheet(S.config.categories.find(k => k.id === ds.id)); break;
    case "cat-del": { const r = await accion("quitar_categoria", { p_id: ds.id }); closeSheet(); render(); if (r) toast("Categoría quitada."); break; }
    case "machine-add": openMachineSheet(null); break;
    case "machine-edit": openMachineSheet(machineById(ds.id)); break;
    case "machine-del": { const r = await accion("quitar_maquina", { p_id: ds.id }); closeSheet(); render(); if (r) toast("Máquina quitada. Las reservas que ya la tenían no cambian."); break; }
    case "machine-photo-del": { machinePhoto = null; const ph = $("#mPhoto"); if (ph) ph.innerHTML = machinePhotoHtml(); break; }
    // Facturación del mes
    case "inv-month": {
      const now = ymOf(todayIso()), cur = S.ui.invYm || now;
      S.ui.invYm = ds.go === "now" ? now : ymAdd(cur, +ds.go);
      if (S.ui.invYm > now) S.ui.invYm = now;
      render(); break;
    }
    case "inv-open": { const inv = S.invoices.find(i => i.id === ds.id); if (inv) openInvoice(inv); break; }
  }
});

document.addEventListener("change", async (e) => {
  const t = e.target;
  if (t.dataset.input === "agDays") { S.ui.agDays = Math.min(31, Math.max(1, Math.round(+t.value) || 1)); fx = "cal"; render(); return; }
  if (t.dataset.input === "userCat") {
    const id = t.dataset.id, nombre = userById(id).name;
    const r = await accion("cambiar_categoria_profesional", { p_miembro: id, p_categoria: t.value });
    render();
    if (r) { const u = userById(id); toast(`${nombre} pasó a ${catOf(u).name}: ${money(rateOf(u))} la hora en sus reservas nuevas.`); }
    return;
  }
  if (t.dataset.draftMachine && draft) {
    const id = t.dataset.draftMachine;
    draft.machines = t.checked ? [...draft.machines.filter(x => x !== id), id] : draft.machines.filter(x => x !== id);
    const sh = overlayEl?.querySelector(".sheet"), st = sh ? sh.scrollTop : 0;
    renderBookingSheet(); if (overlayEl) overlayEl.querySelector(".sheet").scrollTop = st;
    return;
  }
  if (t.dataset.draft && draft) {
    const k = t.dataset.draft;
    if (k === "accepted") { draft.accepted = t.checked; const btn = $("#confirmBtn"); if (btn) btn.disabled = !t.checked; return; }
    draft[k] = t.value;
    if (k === "plan") { const sh = overlayEl?.querySelector(".sheet"); const st = sh ? sh.scrollTop : 0; renderBookingSheet(); if (overlayEl) overlayEl.querySelector(".sheet").scrollTop = st; }
    return;
  }
  if (t.dataset.input === "resBox") { S.ui.resBox = t.value; render(); }
});
document.addEventListener("input", (e) => {
  const t = e.target;
  if (t.dataset.input === "resQ") { S.ui.resQ = t.value; const pos = t.selectionStart; render(); const n = $('[data-input="resQ"]'); if (n) { n.focus(); n.setSelectionRange(pos, pos); } }
  if (t.dataset.draft === "service" && draft) draft.service = t.value;
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && overlayEl) { closeSheet(); if (pendienteDeDibujar && fase === "lista") render(); }
  if (e.key === "Enter" && e.target.matches("tr.click, .slot.click")) e.target.click();
});

document.addEventListener("submit", async (e) => {
  const f = e.target, kind = f.dataset.form;
  if (!kind) return;
  e.preventDefault();
  if (ocupada) return;
  const fd = new FormData(f), c = S.config;
  const txt = (k) => String(fd.get(k) ?? "").trim();
  const pedido = () => ({ p_nombre: txt("name"), p_profesion: txt("profession"), p_categoria: txt("category") || (c.categories[0] && c.categories[0].id) || null, p_telefono: txt("phone"), p_cuit: txt("cuit") });
  switch (kind) {
    case "login": {
      if (await entrarCon(() => servidor.entrar(txt("email"), String(fd.get("password") ?? "")))) { S.ui.view = null; S.ui.calPicked = false; render(); window.scrollTo(0, 0); }
      break;
    }
    case "register": {
      const datos = pedido();
      if (!(await entrarCon(() => servidor.crearCuenta(txt("email"), String(fd.get("password") ?? ""))))) break;
      const r = await accion("pedir_acceso", datos);       // si esto falla, queda adentro y puede completar el pedido desde ahí
      S.ui.view = null; S.ui.authTab = "login"; render(); window.scrollTo(0, 0);
      if (r) toast("Solicitud enviada.");
      break;
    }
    case "pedido": {
      const r = await accion("pedir_acceso", pedido());
      S.ui.view = null; render(); window.scrollTo(0, 0);
      if (r) toast("Solicitud enviada.");
      break;
    }
    case "new-block": {
      const boxes = fd.getAll("boxes").map(Number);
      const date = txt("date"), start = +fd.get("start"), end = +fd.get("end");
      if (!boxes.length) { toast("Elegí al menos un box."); return; }
      if (end <= start) { toast("La hora de fin tiene que ser posterior al inicio."); return; }
      const weekly = fd.get("rep") === "weekly";
      const r = await accion("bloquear", { p_boxes: boxes, p_fecha: date, p_desde: start, p_hasta: end, p_semanal: weekly, p_nota: txt("note") });
      if (!r) { if (ultimoError !== "sin_conexion") { closeSheet(); render(); } return; }
      closeSheet(); S.ui.calDate = date; render();
      toast(r.clashes ? `Bloqueado. Ojo: ${r.clashes} ${r.clashes === 1 ? "reserva ya tomada sigue" : "reservas ya tomadas siguen"} en pie en ese horario.` : weekly ? `Bloqueado todos los ${DIAS[weekday(date)]}.` : "Horario bloqueado.");
      break;
    }
    case "release": {
      const start = +fd.get("start"), end = +fd.get("end");
      if (end <= start) { toast("La hora de fin tiene que ser posterior al inicio."); return; }
      const r = await accion("publicar_rato", { p_box: +f.dataset.box, p_fecha: f.dataset.date, p_desde: start, p_hasta: end });
      if (!r && ultimoError === "sin_conexion") return;
      closeSheet(); render();
      if (r) toast(`Publicaste un rato libre de ${end - start} h.`);
      break;
    }
    case "cfg-turnos": {
      const open = +fd.get("open"), close = +fd.get("close"), th = +fd.get("turnHours");
      if (close <= open) { toast("El cierre tiene que ser después de la apertura."); return; }
      if ((close - open) % th !== 0) { toast(`Con turnos de ${th} h, el horario de ${open} a ${close} no cierra justo. Probá otro.`); return; }
      const r = await accion("guardar_turnos", { p_turno_horas: th, p_abre: open, p_cierra: close, p_dias: fd.getAll("days").map(Number) });
      render(); if (r) toast("Guardado. La agenda ya usa los nuevos turnos."); break;
    }
    case "cfg-precio": {
      const tope = txt("maxSaldos");
      const r = await accion("guardar_pago", { p_sena_pct: +fd.get("depositPct"), p_minutos_pago: +fd.get("mpMinutes"), p_max_saldos: tope === "" ? null : +tope });
      render(); if (r) toast("Seña y pago guardados."); break;
    }
    case "cfg-politica": {
      const r = await accion("guardar_politica", { p_dias: +fd.get("days"), p_sena_antes: +fd.get("senaBefore"), p_sena_despues: +fd.get("senaAfter"), p_total_antes: +fd.get("totalBefore"), p_total_despues: +fd.get("totalAfter") });
      render(); if (r) toast("Política de cancelación guardada."); break;
    }
    case "cfg-terms": {
      const r = await accion("guardar_reglamento", { p_texto: txt("text") });
      render(); if (r) toast(`Reglamento guardado (versión ${r.version}).`); break;
    }
    case "cfg-boxes": {
      // un pedido por box, con lo que había en el formulario al tocar Guardar
      const cambios = S.boxes.filter(b => fd.get("name" + b.id) != null).map(b => ({ p_numero: b.id, p_nombre: txt("name" + b.id), p_resumen: txt("short" + b.id),
        p_equipamiento: txt("eq" + b.id).split(",").map(s => s.trim()).filter(Boolean),
        p_precios: Object.fromEntries(c.categories.map(k => [k.id, txt(`price_${b.id}_${k.id}`)])) }));
      let bien = true;
      for (const cambio of cambios) { if (!(await accion("guardar_box", cambio))) { bien = false; break; } }
      render(); if (bien) toast("Boxes guardados."); break;
    }
    case "cat-save": {
      const name = txt("name"), price = Math.max(0, Math.round(+fd.get("pricePerHour") || 0));
      if (!name) { toast("Poné un nombre para la categoría."); return; }
      const r = await accion("guardar_categoria", { p_id: f.dataset.id || null, p_nombre: name, p_nota: txt("note"), p_precio_hora: price });
      if (!r) { if (ultimoError !== "sin_conexion") { closeSheet(); render(); } return; }
      closeSheet(); render(); toast(`Guardado: ${name}, ${money(price)} la hora.`); break;
    }
    case "machine-save": {
      const name = txt("name"), price = Math.max(0, Math.round(+fd.get("pricePerHour") || 0));
      if (!name) { toast("Poné el nombre de la máquina."); return; }
      const r = await accion("guardar_maquina", { p_id: f.dataset.id || null, p_nombre: name, p_resumen: txt("short"), p_precio_hora: price, p_activa: fd.get("active") === "on", p_foto: machinePhoto });
      if (!r) { if (ultimoError !== "sin_conexion") { closeSheet(); render(); } return; }
      closeSheet(); render(); toast(`Guardado: ${name}, ${money(price)} la hora.`); break;
    }
    case "cfg-billing": {
      const r = await accion("guardar_facturacion", { p_nombre: txt("name"), p_cuit: txt("cuit"), p_condicion: txt("cond"), p_punto_venta: Math.min(9998, Math.max(1, +fd.get("pos") || 1)) });
      render(); if (r) toast("Datos de facturación guardados."); break;
    }
  }
});

/* Contadores de pago (RN10) y la línea de la hora actual */
function tick() {
  const now = ahora();
  const nl = $(".nowline"); // la línea de la hora actual acompaña al reloj
  if (nl) { const d = new Date(now), h = d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600; nl.style.top = `calc(var(--ph) * ${(h - +nl.dataset.open).toFixed(3)})`; nl.hidden = h >= +nl.dataset.close; }
  $$("[data-countdown]").forEach(el => {
    const left = Math.max(0, +el.dataset.countdown - now);
    const m = Math.floor(left / 6e4), s = Math.floor(left % 6e4 / 1e3);
    el.textContent = left > 36e5 ? `Quedan ${Math.floor(left / 36e5)} h ${pad(m % 60)} min` : `Quedan ${m}:${pad(s)}`;
  });
}

/* Cada segundo: los contadores. Y cada tanto se vuelven a pedir los datos, para ver lo que hicieron las demás:
   cada 30 segundos con la página a la vista (cada 5 minutos si está en otra pestaña), y enseguida si venció un plazo. */
setInterval(() => {
  if (fase !== "lista") return;
  tick();
  if (!servidor.sesion || ocupada) return;
  if (pendienteDeDibujar && puedeDibujar()) { render(); return; }
  const hace = Date.now() - ultimaCarga;
  if ((algoVencio() && hace > 4000) || hace > (document.hidden ? 300000 : 30000)) refrescar();
}, 1000);
document.addEventListener("visibilitychange", () => { if (!document.hidden && fase === "lista" && servidor.sesion && Date.now() - ultimaCarga > 5000) refrescar(); });
/* Si en otra pestaña se entra o se sale, esta se pone al día */
window.addEventListener("storage", (e) => { if (e.key === "et-sesion") { servidor.releer(); iniciar(); } });

async function iniciar() {
  closeSheet(true);
  fase = "cargando"; render();
  if (!CFG.url || !CFG.key || !SLUG || typeof crearConexion !== "function") { fase = "error"; errorDeArranque = "Falta configurar la página (config.js)."; render(); return; }
  try {
    try { await cargar(); }
    catch (e) { if (servidor.sesion || e.code === "sin_conexion" || e.code === "consultorio_inexistente") throw e; await cargar(); }   // la sesión guardada ya no servía: se abre como visitante
  } catch (e) {
    fase = "error";
    errorDeArranque = e.code === "consultorio_inexistente" ? "No encontramos este consultorio. Revisá la dirección." : mensajeDe(e);
  }
  render();
  if (fase === "lista") tick();
}

paintTheme();
iniciar();
''')

# =====================================================================================================
# Controles: no tiene que quedar nada de la demo
# =====================================================================================================
guion = t[t.index('<script>\n"use strict";'):]
for resto in ('Yani', 'localStorage.getItem(KEY', 'save()', 'seed(', 'renderDemoBar', 'S.session.userId =', 'mail(', 'issueInvoice', 'applyBoxesForm',
              'approvePayment', 'cancelBooking', 'autoUpdate', 'openMails', 'openAddPro', 'reset-demo', 'login-as', 'findP', 'FULL', 'Demo', 'versión real',
              'de muestra', 'Simula', 'photo-note', 'add-pro', 'inv-one', 'inv-all'):
    assert resto not in guion, f'quedó «{resto}» en el código'
assert 'demobar' not in t[t.index('<body>'):], 'quedó la barra de la demo en el cuerpo'

SALIDA.write_text(t, encoding='utf-8', newline='\n')
print(f'{SALIDA}: {len(t.encode("utf-8")):,} bytes, {len(t.splitlines())} renglones')
