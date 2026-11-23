/* Entreturno · Boxes — conexión con el servidor (Supabase).
   Un solo lugar para: entrar, crear la cuenta, salir, mantener la sesión viva y llamar a las funciones de la base.

   Uso:
     const servidor = crearConexion({ url, key, slug, almacen: localStorage });
     await servidor.entrar(mail, clave);
     const foto = await servidor.rpc("foto");                 // agrega solo el consultorio (p_slug)
     await servidor.rpc("reservar", { p_box: 2, ... });

   Cuando algo no se puede, corta con un ErrorDeServidor cuyo .code es el motivo:
     · los de la base, tal cual («horario_no_disponible», «solo_admin»…),
     · los del ingreso («invalid_credentials», «user_already_exists», «weak_password»…),
     · «sin_conexion» si no hubo respuesta, y «confirmar_mail» si la cuenta se creó pero falta confirmar el mail.

   Los mails de registro (confirmar la cuenta, elegir otra contraseña) traen un enlace a la página misma, con un código
   de un solo uso después del #: entrarPorEnlace() lo canjea por la sesión y deja a la persona adentro. El código se
   canjea desde la página y no al abrir el enlace, así un filtro de correo que «mira» los enlaces no lo gasta. */
(function (g) {
  "use strict";

  class ErrorDeServidor extends Error {
    constructor(code, status) {
      super(code);
      this.name = "ErrorDeServidor";
      this.code = code;
      this.status = status;
    }
  }

  function codigoDe(j, status) {
    if (!j || typeof j !== "object") return "error_" + status;
    if (j.error_code) return String(j.error_code);                          // del ingreso
    if (j.code === "P0001" && j.message) return String(j.message);          // nuestras reglas
    if (typeof j.code === "string" && j.code) return j.code;                // otros de la base o de la API (42501, PGRST301…)
    return String(j.msg || j.error_description || j.error || j.message || "error_" + status);
  }

  // Lo que dice un pase por dentro (quién es y los datos de su cuenta). No comprueba nada: de eso se ocupa el servidor.
  function adentroDelPase(pase) {
    try {
      const medio = String(pase).split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      const crudo = atob(medio + "===".slice((medio.length + 3) % 4));
      return JSON.parse(new TextDecoder().decode(Uint8Array.from(crudo, (c) => c.charCodeAt(0)))) || {};
    } catch (e) {
      return {};
    }
  }
  const conVuelta = (ruta, volverA) => ruta + (volverA ? "?redirect_to=" + encodeURIComponent(volverA) : "");
  // Lo que trae la dirección después del (último) #, como pares nombre=valor
  const despuesDelNumeral = (fragmento) => { const t = String(fragmento || ""); return new URLSearchParams(t.slice(t.lastIndexOf("#") + 1)); };

  g.crearConexion = function ({ url, key, slug, almacen, fetch: pedirWeb, ahora }) {
    const pedirHttp = pedirWeb || g.fetch.bind(g);
    const reloj = ahora || (() => Date.now());
    const CLAVE = "et-sesion";
    const MARGEN = 60;                       // segundos: el pase se renueva un minuto antes de vencer
    const oyentes = new Set();
    let sesion = null;                       // { access_token, refresh_token, expires_at (segundos), user: { id, email } }
    let renovando = null;
    let generacion = 0;                      // cambia cada vez que alguien entra o sale: una renovación que venía de antes ya no vale

    function leer() {
      try { sesion = JSON.parse(almacen.getItem(CLAVE)); } catch (e) { sesion = null; }
      if (!sesion || !sesion.access_token || !sesion.refresh_token) sesion = null;
      return sesion;
    }
    function guardar(nueva) {
      sesion = nueva;
      try { if (nueva) almacen.setItem(CLAVE, JSON.stringify(nueva)); else almacen.removeItem(CLAVE); } catch (e) { /* sin almacén: vale hasta cerrar la página */ }
      oyentes.forEach((fn) => fn(sesion));
    }
    const deRespuesta = (j) => {
      const u = j.user || {}, p = u.id && u.email ? {} : adentroDelPase(j.access_token);     // si no viene quién es, se lee del pase
      return {
        access_token: j.access_token,
        refresh_token: j.refresh_token,
        expires_at: Number(j.expires_at) || Math.floor(reloj() / 1000) + (Number(j.expires_in) || 3600),
        user: { id: u.id || p.sub, email: u.email || p.email },
      };
    };
    const vigente = (s) => s && s.expires_at - MARGEN > reloj() / 1000;

    async function pedir(ruta, cuerpo, pase, metodo) {
      let r;
      try {
        const opciones = { method: metodo || "POST", headers: { apikey: key, Authorization: "Bearer " + (pase || key), "Content-Type": "application/json" } };
        if (opciones.method !== "GET") opciones.body = JSON.stringify(cuerpo === undefined ? {} : cuerpo);
        r = await pedirHttp(url + ruta, opciones);
      } catch (e) {
        throw new ErrorDeServidor("sin_conexion", 0);
      }
      const texto = await r.text();
      let j = null;
      try { j = texto ? JSON.parse(texto) : null; } catch (e) { j = null; }
      if (!r.ok) throw new ErrorDeServidor(codigoDe(j, r.status), r.status);
      return j;
    }

    // Pide un pase nuevo. Si varias llamadas lo necesitan a la vez, se pide una sola vez.
    function renovar() {
      if (!renovando) {
        renovando = (async () => {
          const g = generacion;
          const usado = sesion && sesion.refresh_token;
          try {
            leer();                                                         // otra pestaña pudo haberlo renovado recién
            if (sesion && sesion.refresh_token !== usado && vigente(sesion)) return sesion.access_token;
            if (!sesion) throw new ErrorDeServidor("sin_sesion", 401);
            const j = await pedir("/auth/v1/token?grant_type=refresh_token", { refresh_token: sesion.refresh_token });
            // Mientras se esperaba, la persona salió o entró con otra cuenta: esta respuesta ya no se guarda
            if (g !== generacion) throw new ErrorDeServidor("sin_sesion", 401);
            guardar(deRespuesta(j));
            return sesion.access_token;
          } catch (e) {
            if (g === generacion && e.status >= 400 && e.status < 500) {
              leer();                                                       // ¿otra pestaña lo renovó justo mientras esta fallaba?
              if (sesion && sesion.refresh_token !== usado && vigente(sesion)) return sesion.access_token;
              guardar(null);                                                // la sesión ya no sirve: hay que volver a entrar
            }
            throw e;
          } finally {
            renovando = null;
          }
        })();
      }
      return renovando;
    }

    async function pase() {
      if (!sesion) return null;
      return vigente(sesion) ? sesion.access_token : renovar();
    }

    async function rpc(funcion, args) {
      const cuerpo = Object.assign({ p_slug: slug }, args || {});
      const p = await pase();
      try {
        return await pedir("/rest/v1/rpc/" + funcion, cuerpo, p);
      } catch (e) {
        // El pase venció justo en el camino: se renueva y se repite una sola vez (la base no llegó a hacer nada)
        if (e.status === 401 && sesion) return pedir("/rest/v1/rpc/" + funcion, cuerpo, await renovar());
        throw e;
      }
    }

    // Una función de Supabase (por ahora «facturar», que habla con ARCA): con el pase de quien está adentro y el consultorio.
    async function funcion(nombre, args) {
      const cuerpo = Object.assign({ slug }, args || {});
      const p = await pase();
      if (!p) throw new ErrorDeServidor("sin_sesion", 401);
      try {
        return await pedir("/functions/v1/" + nombre, cuerpo, p);
      } catch (e) {
        // El pase venció justo en el camino: la función corta antes de hacer nada, así que se renueva y se repite
        if (e.status === 401 && sesion) return pedir("/functions/v1/" + nombre, cuerpo, await renovar());
        throw e;
      }
    }

    leer();
    return {
      slug,
      get sesion() { return sesion; },
      /** Avisa cada vez que cambia la sesión (entrar, salir, o cuando deja de servir). Devuelve cómo dejar de escuchar. */
      alCambiar(fn) { oyentes.add(fn); return () => oyentes.delete(fn); },
      /** Vuelve a leer la sesión guardada (por si otra pestaña entró o salió). */
      releer: leer,
      rpc,
      funcion,
      async entrar(email, clave) {
        const j = await pedir("/auth/v1/token?grant_type=password", { email, password: clave });
        generacion++;
        guardar(deRespuesta(j));
        return sesion;
      },
      /** volverA: la dirección de esta página, para que el enlace del mail de confirmación traiga de vuelta acá.
          datos: lo que se quiera dejar anotado en la cuenta (por ejemplo, el pedido de acceso, para mandarlo al confirmar). */
      async crearCuenta(email, clave, volverA, datos) {
        const cuerpo = { email, password: clave };
        if (datos) cuerpo.data = datos;
        const j = await pedir(conVuelta("/auth/v1/signup", volverA), cuerpo);
        if (j && j.access_token) {
          generacion++;
          guardar(deRespuesta(j));
          return sesion;
        }
        // El proyecto pide confirmar el mail antes de entrar. Si ese mail ya tenía una cuenta confirmada, el servidor contesta
        // igual y no manda nada, para no contarle a cualquiera quién tiene cuenta: acá tampoco se distingue.
        throw new ErrorDeServidor("confirmar_mail", 200);
      },
      /** Vuelve a mandar el mail para confirmar la cuenta. */
      async reenviar(email, volverA) {
        await pedir(conVuelta("/auth/v1/resend", volverA), { type: "signup", email });
      },
      /** Manda el mail para elegir una contraseña nueva. No dice si esa cuenta existe o no. */
      async recuperar(email, volverA) {
        await pedir(conVuelta("/auth/v1/recover", volverA), { email });
      },
      /** Cambia la contraseña de quien está adentro (se usa al volver del mail de «olvidé mi contraseña»). */
      async cambiarClave(nueva) {
        await pedir("/auth/v1/user", { password: nueva }, await pase(), "PUT");
      },
      /** Lo que quedó anotado en la cuenta al crearla (sale del pase: no hace falta pedírselo al servidor). */
      datosDeLaCuenta() {
        return (sesion && adentroDelPase(sesion.access_token).user_metadata) || {};
      },
      /** Cambia lo anotado en la cuenta; un dato en null se borra. */
      async guardarDatos(datos) {
        await pedir("/auth/v1/user", { data: datos }, await pase(), "PUT");
      },
      /** ¿La dirección trae, después del #, algo del enlace de un mail? (un código para canjear, la sesión ya armada o un aviso de error) */
      hayEnlace(fragmento) {
        const d = despuesDelNumeral(fragmento);
        return !!(d.get("token_hash") || (d.get("access_token") && d.get("refresh_token")) || d.get("error") || d.get("error_code"));
      },
      /** Entra con lo que trae el enlace de un mail después del #: un código de un solo uso, que se canjea acá por la sesión
          (o, con los mails de fábrica de Supabase, la sesión ya armada). Devuelve qué tipo de enlace era («email» o «signup»:
          confirmar la cuenta; «recovery»: elegir otra contraseña; «invite»…), «error» si el enlace ya no sirve, o null si no
          traía nada. Sin conexión corta con «sin_conexion», y se puede volver a probar con el mismo enlace. */
      async entrarPorEnlace(fragmento) {
        const d = despuesDelNumeral(fragmento);
        if (d.get("error") || d.get("error_code")) return "error";
        const tipo = d.get("type") || "email", codigo = d.get("token_hash");
        if (codigo) {
          let j;
          try { j = await pedir("/auth/v1/verify", { type: tipo, token_hash: codigo }); }
          catch (e) { if (e.code === "sin_conexion") throw e; return "error"; }
          if (!j || !j.access_token || !j.refresh_token) return "error";
          generacion++;
          guardar(deRespuesta(j));
          return tipo;
        }
        const a = d.get("access_token"), r = d.get("refresh_token");
        if (!a || !r) return null;
        // Quién es no se saca del pase que vino en la dirección (cualquiera puede armar uno): se le pregunta al servidor.
        let quien;
        try { quien = await pedir("/auth/v1/user", undefined, a, "GET"); }
        catch (e) { if (e.code === "sin_conexion") throw e; return "error"; }
        if (!quien || !quien.id) return "error";
        generacion++;
        guardar(deRespuesta({ access_token: a, refresh_token: r, expires_at: d.get("expires_at"), expires_in: d.get("expires_in"), user: quien }));
        return tipo;
      },
      async salir() {
        const p = sesion && sesion.access_token;
        generacion++;
        guardar(null);
        if (p) { try { await pedir("/auth/v1/logout", {}, p); } catch (e) { /* ya salió de este navegador: alcanza */ } }
      },
    };
  };

  g.ErrorDeServidor = ErrorDeServidor;
})(typeof window !== "undefined" ? window : globalThis);
