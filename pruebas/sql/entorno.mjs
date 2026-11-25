// Arnés de pruebas de la base de datos: un Postgres que corre adentro de Node (PGlite) y que imita lo que
// da Supabase (roles anon / authenticated / service_role, auth.users, auth.uid()). Carga las migraciones tal cual.
//
// Cada prueba recibe una base propia (copia de una plantilla ya migrada) y, al terminar, se revisan las
// reglas que tienen que cumplirse siempre (verificarInvariantes).

import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { DUENO, MIGRACIONES, ZONA, armarBase, comoRol, crearCuenta } from '../base.mjs';

export { DUENO, MIGRACIONES, ZONA };

/** Las funciones que la página puede llamar: sin sesión y con sesión. */
export const FUNCIONES_SIN_SESION = ['portada'];
export const FUNCIONES_CON_SESION = [
  'portada', 'foto', 'pedir_acceso', 'reservar', 'simular_pago', 'cancelar_reserva',
  'bloquear', 'publicar_rato', 'liberar_dia', 'quitar_rato', 'quitar_bloqueo',
  'cambiar_estado_profesional', 'cambiar_categoria_profesional', 'cambiar_datos_fiscales_profesional',
  'guardar_turnos', 'guardar_pago', 'guardar_politica', 'guardar_reglamento', 'guardar_box', 'guardar_foto_box',
  'guardar_categoria', 'quitar_categoria', 'guardar_maquina', 'quitar_maquina', 'guardar_facturacion',
  'facturacion_preparar', 'facturacion_estado',
  'mp_conexion_iniciar', 'mp_conexion_confirmar', 'mp_desconectar', 'mp_pago_preparar', 'mp_pago_mio', 'mp_consultorio_mio',
  'mp_devolucion_a_mano', 'aceptar_privacidad', 'guardar_privacidad',
];

/** Las que solo pueden llamar las funciones de Supabase (ARCA, Mercado Pago y la copia de seguridad), con service_role. */
export const FUNCIONES_DE_SERVICIO = ['arca_ticket', 'arca_guardar_ticket', 'arca_candado', 'arca_anotar', 'arca_resultado',
  'mp_conexion_tomar', 'mp_cuenta_guardar', 'mp_credencial', 'mp_cuenta_renovada', 'mp_cuenta_reintento', 'mp_cuenta_caida',
  'mp_cuentas_de', 'mp_pago_orden', 'mp_pago_fallo', 'mp_pago_ubicar', 'mp_pago_resultado', 'mp_pago_cerrado',
  'mp_pago_sin_comprobar', 'mp_devolucion_tomar', 'mp_devolucion_parte', 'mp_sobrante_tomar', 'mp_sobrante_resultado',
  'mp_pendientes', 'mp_reloj_clave', 'copia_datos', 'copia_anotar', 'copia_guardada'];

let plantilla = null;
after(async () => {
  if (plantilla) await (await plantilla).close();
});

/** Base nueva, ya migrada. */
export async function crearEntorno() {
  if (!plantilla) plantilla = armarBase();
  const pg = await (await plantilla).clone();
  return new Entorno(pg);
}

/** Prueba con base propia; al final revisa las reglas que valen siempre. */
export function prueba(nombre, fn) {
  return test(nombre, async (t) => {
    const e = await crearEntorno();
    try {
      await fn(e, t);
      await e.verificarInvariantes();
    } finally {
      await e.cerrar();
    }
  });
}

/** Espera que la promesa falle con exactamente ese código de negocio. */
export async function esperarError(promesa, codigo) {
  await assert.rejects(promesa, (e) => {
    assert.equal(e.message, codigo, `se esperaba ${codigo} y vino: ${e.message}`);
    return true;
  });
}

/** Espera "permission denied" de Postgres (42501). */
export async function esperarSinPermiso(promesa) {
  await assert.rejects(promesa, (e) => {
    assert.equal(e.code, '42501', `se esperaba permiso denegado y vino: ${e.code} ${e.message}`);
    return true;
  });
}

const IDENT = /^[a-z_][a-z0-9_]*$/;

async function llamarCon(cliente, nombre, args = {}, esquema = 'public') {
  assert.match(nombre, IDENT);
  const claves = Object.keys(args);
  claves.forEach((k) => assert.match(k, IDENT));
  const lista = claves.map((k, i) => `${k} => $${i + 1}`).join(', ');
  const r = await cliente.query(`select ${esquema}.${nombre}(${lista}) as r`, claves.map((k) => args[k]));
  return r.rows[0].r;
}

/** Lo que tiene a mano una prueba dentro de comoUsuario / comoAnon. */
class Cliente {
  constructor(tx) {
    this.tx = tx;
  }
  llamar(nombre, args, esquema) {
    return llamarCon(this.tx, nombre, args, esquema);
  }
  async sql(texto, params) {
    return (await this.tx.query(texto, params)).rows;
  }
}

const pad = (n) => String(n).padStart(2, '0');

class Entorno {
  constructor(pg) {
    this.pg = pg;
    this.cuentaUsuarios = 0;
  }

  cerrar() {
    return this.pg.close();
  }

  /** Consulta como superusuario (para preparar datos y mirar tablas). */
  async sql(texto, params) {
    return (await this.pg.query(texto, params)).rows;
  }

  async uno(texto, params) {
    return (await this.sql(texto, params))[0];
  }

  /** Corre fn con un rol y los datos de sesión, dentro de una transacción (como hace la API de Supabase). */
  comoRol(rol, sub, fn) {
    return comoRol(this.pg, rol, sub, (tx) => fn(new Cliente(tx)));
  }

  comoUsuario(id, fn) {
    return this.comoRol('authenticated', id, fn);
  }

  comoAnon(fn) {
    return this.comoRol('anon', null, fn);
  }

  /** Atajo: una sola llamada como esa persona. */
  llamarComo(id, nombre, args) {
    return this.comoUsuario(id, (c) => c.llamar(nombre, args));
  }

  /** Crea la cuenta como lo hace Supabase Auth. Devuelve el id de la cuenta. */
  crearUsuario(email) {
    this.cuentaUsuarios += 1;
    return crearCuenta(this.pg, email ?? `persona${this.cuentaUsuarios}@prueba.com`);
  }

  /** 'YYYY-MM-DD' de hoy (+ días) en el consultorio. */
  async fecha(dias = 0) {
    const r = await this.uno(`select ((now() at time zone '${ZONA}')::date + $1::int)::text as d`, [dias]);
    return r.d;
  }

  /** El primer día de lunes a sábado que cae a `dias` días de hoy o después. */
  async diaHabil(dias) {
    let f = await this.fecha(dias);
    const [a, m, d] = f.split('-').map(Number);
    if (new Date(Date.UTC(a, m - 1, d)).getUTCDay() === 0) f = await this.fecha(dias + 1);
    return f;
  }

  /**
   * Consultorio de ejemplo con todo lo necesario para probar:
   * dos categorías (médica $ 10.000 y estética $ 6.000 la hora), tres boxes (el 3 con precio propio: $ 12.000 y $ 8.000),
   * tres máquinas (la tercera pausada), la dueña y tres profesionales (Lucía médica y Caro esteticista, aprobadas; Martina pendiente).
   */
  async armar(slug = 'lavanda', cambios = {}) {
    const c = await this.uno(
      `insert into public.consultorios (slug, nombre, duena, letras, reglamento) values ($1, $2, $3, $4, $5) returning id`,
      [slug, cambios.nombre ?? 'Consultorio Lavanda', cambios.duena ?? 'Laura', 'CL', 'Dejá el box limpio.\nRespetá el horario.'],
    );
    const cat = async (nombre, precio, orden) =>
      (await this.uno(
        `insert into public.categorias (consultorio_id, nombre, nota, precio_hora, orden) values ($1, $2, '', $3, $4) returning id`,
        [c.id, nombre, precio, orden],
      )).id;
    const medica = await cat('Médicas y médicos', 10000, 1);
    const estetica = await cat('Esteticistas', 6000, 2);
    const box = async (numero) =>
      (await this.uno(
        `insert into public.boxes (consultorio_id, numero, nombre, resumen, equipamiento) values ($1, $2, $3, '', '{Camilla,Lavatorio}') returning id`,
        [c.id, numero, `Box ${numero}`],
      )).id;
    const boxes = { 1: await box(1), 2: await box(2), 3: await box(3) };
    await this.sql(
      `insert into public.box_precios (box_id, categoria_id, consultorio_id, precio_hora) values ($1, $2, $4, 12000), ($1, $3, $4, 8000)`,
      [boxes[3], medica, estetica, c.id],
    );
    const maq = async (nombre, precio, activa) =>
      (await this.uno(
        `insert into public.maquinas (consultorio_id, nombre, precio_hora, activa) values ($1, $2, $3, $4) returning id`,
        [c.id, nombre, precio, activa],
      )).id;
    const maquinas = { laser: await maq('Láser', 16000, true), crio: await maq('Criolipólisis', 14000, true), pausada: await maq('Ultrasonido', 18000, false) };

    const correoAdmin = `duena-${slug}@prueba.com`;
    const admin = await this.crearUsuario(correoAdmin);
    await this.pg.query(`select interno.alta_admin($1, $2, $3)`, [slug, correoAdmin, cambios.duena ?? 'Laura']);

    const esc = { slug, id: c.id, medica, estetica, boxes, maquinas, admin };
    esc.lucia = await this.crearPro(esc, { nombre: 'Lucía Ferrari', profesion: 'Médica dermatóloga', categoria: medica });
    esc.caro = await this.crearPro(esc, { nombre: 'Carolina Méndez', profesion: 'Cosmetóloga', categoria: estetica });
    esc.martina = await this.crearPro(esc, { nombre: 'Martina Sosa', profesion: 'Cosmiatra', categoria: estetica, aprobar: false });
    return esc;
  }

  /** Lo que manda la página cuando la persona aceptó el aviso de datos que tiene en pantalla. */
  async aviso(slug) {
    const p = await this.comoAnon((c) => c.llamar('portada', { p_slug: slug }));
    return { p_privacidad: p.site.privacy.hash, p_exterior: true };
  }

  /** Cuenta nueva que pide acceso; por defecto la dueña la aprueba. Devuelve el id de la cuenta. */
  async crearPro(esc, { nombre, profesion = 'Profesional', categoria, aprobar = true, email }) {
    const id = await this.crearUsuario(email);
    const r = await this.llamarComo(id, 'pedir_acceso', {
      p_slug: esc.slug, p_nombre: nombre, p_profesion: profesion, p_categoria: categoria, p_telefono: '11 5555-0000', p_cuit: '27-11111111-7', p_condicion_iva: 6,
      ...(await this.aviso(esc.slug)),
    });
    if (aprobar) {
      await this.llamarComo(esc.admin, 'cambiar_estado_profesional', { p_slug: esc.slug, p_miembro: r.id, p_estado: 'aprobado' });
    }
    return id;
  }

  /** El id de miembro de una cuenta en un consultorio. */
  async miembro(esc, usuario) {
    return (await this.uno('select id from public.miembros where consultorio_id = $1 and usuario_id = $2', [esc.id, usuario])).id;
  }

  /** Reserva como esa profesional. Devuelve lo que devuelve la función. */
  reservar(esc, usuario, { box = 2, fecha, desde = 8, hasta = 12, plan = 'sena', maquinas = [], servicio = 'Consulta', version = 1 }) {
    return this.llamarComo(usuario, 'reservar', {
      p_slug: esc.slug, p_box: box, p_fecha: fecha, p_desde: desde, p_hasta: hasta, p_servicio: servicio, p_plan: plan,
      p_maquinas: `{${maquinas.join(',')}}`, p_reglamento_version: version,
    });
  }

  pagar(esc, usuario, reserva, tipo) {
    return this.llamarComo(usuario, 'simular_pago', { p_slug: esc.slug, p_reserva: reserva, p_tipo: tipo });
  }

  foto(esc, usuario) {
    return this.llamarComo(usuario, 'foto', { p_slug: esc.slug });
  }

  /** Reglas que tienen que valer siempre, pase lo que pase en la prueba. */
  async verificarInvariantes() {
    // 1) El total de cada reserva es el box más sus máquinas
    const mal = await this.sql(`
      select r.id from public.reservas r
       where r.total <> r.monto_box + coalesce((select sum(monto) from public.reserva_maquinas rm where rm.reserva_id = r.id), 0)
          or r.monto_box <> r.precio_hora * (r.hasta - r.desde)`);
    assert.deepEqual(mal, [], 'hay reservas con el total mal calculado');
    // 2) Nunca se devuelve más de lo cobrado
    const demas = await this.sql(`
      select r.id from public.reservas r
       where coalesce((select sum(monto) from public.pagos p where p.reserva_id = r.id and p.tipo = 'devolucion' and p.estado <> 'vencido'), 0)
           > coalesce((select sum(monto) from public.pagos p where p.reserva_id = r.id and p.tipo <> 'devolucion' and p.estado = 'aprobado'), 0)`);
    assert.deepEqual(demas, [], 'hay reservas con más plata devuelta que cobrada');
    // 3) Nunca se cobra más que el total
    const sobra = await this.sql(`
      select r.id from public.reservas r
       where coalesce((select sum(monto) from public.pagos p where p.reserva_id = r.id and p.tipo <> 'devolucion' and p.estado = 'aprobado'), 0) > r.total`);
    assert.deepEqual(sobra, [], 'hay reservas cobradas de más');
    // 4) Una reserva confirmada o cumplida tiene algún pago aprobado (salvo que no hubiera nada para cobrar al reservar);
    //    una cancelada no deja máquinas tomadas
    const sinPago = await this.sql(`
      select r.id from public.reservas r
       where r.estado in ('confirmada', 'cumplida')
         and not (r.total = 0 or (r.plan = 'sena' and r.monto_sena = 0))
         and not exists (select 1 from public.pagos p where p.reserva_id = r.id and p.tipo <> 'devolucion' and p.estado = 'aprobado')`);
    assert.deepEqual(sinPago, [], 'hay reservas confirmadas sin ningún pago');
    const maquinasTomadas = await this.sql(`
      select r.id from public.reservas r join public.reserva_maquinas rm on rm.reserva_id = r.id
       where (r.estado = 'cancelada') = rm.activa`);
    assert.deepEqual(maquinasTomadas, [], 'hay máquinas tomadas por reservas canceladas (o libres en reservas vivas)');
    // 5) Nada cruza de un consultorio a otro
    const cruces = await this.sql(`
      select 'reserva' as que, r.id::text from public.reservas r join public.boxes b on b.id = r.box_id where b.consultorio_id <> r.consultorio_id
      union all
      select 'pago', p.id::text from public.pagos p join public.reservas r on r.id = p.reserva_id where r.consultorio_id <> p.consultorio_id`);
    assert.deepEqual(cruces, [], 'hay datos cruzados entre consultorios');
  }
}

export { pad };
