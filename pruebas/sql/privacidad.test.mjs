// El aviso de datos personales: qué dice, que no se entra sin aceptarlo, y la constancia de quién aceptó qué y cuándo.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { esperarError, esperarSinPermiso, prueba } from './entorno.mjs';

const huellaDe = (texto) => createHash('sha256').update(texto, 'utf8').digest('hex').slice(0, 32);
const portada = async (e, slug = 'lavanda') => (await e.comoAnon((c) => c.llamar('portada', { p_slug: slug }))).site.privacy;
const constancias = (e, miembro) => e.sql(`select version, huella, aviso, exterior, usuario_id from interno.consentimientos where miembro_id = $1 order by version, en`, [miembro]);

/** Alguien que ya era parte del consultorio antes de que existiera el aviso: está, pero sin constancia. */
async function sinConstancia(e, usuario, esc) {
  await e.sql('delete from interno.consentimientos where miembro_id = $1', [await e.miembro(esc, usuario)]);
}

prueba('el aviso se lee antes de entrar, con los datos del consultorio y todo lo que pide la ley', async (e) => {
  await e.armar();
  const p = await portada(e);
  assert.equal(p.version, 1);
  assert.equal(p.hash, huellaDe(p.text));
  assert.equal(/[{}]/.test(p.text), false, 'quedó un casillero sin completar');
  for (const dice of ['base de datos de Laura, responsable de «Consultorio Lavanda»', 'hablá con Laura', 'Hablá con Laura.',       // responsable y a quién pedirle
    'Para evaluar tu solicitud', 'No se usan para publicidad',                                                                    // para qué
    'Supabase', 'Cloudflare', 'Resend', 'Mercado Pago', 'ARCA',                                                                  // quiénes los reciben
    'El teléfono es optativo', 'sin ellos no se puede pedir acceso',                                                              // obligatorio y consecuencias
    'San Pablo, Brasil', 'Estados Unidos', 'de manera expresa', 'artículo 12 de la Ley 25.326',                                   // fuera del país
    'que los corrijan, los actualicen o los borren', '10 días corridos', '5 días hábiles', 'cada seis meses',                     // derechos
    'LA AGENCIA DE ACCESO A LA INFORMACIÓN PÚBLICA, en su carácter de Órgano de Control de la Ley N° 25.326, tiene la atribución de atender las denuncias y reclamos que interpongan quienes resulten afectados en sus derechos por incumplimiento de las normas vigentes en materia de protección de datos personales']) {
    assert.ok(p.text.includes(dice), `falta: ${dice}`);
  }
});

prueba('sin aceptar las dos cosas no se puede pedir acceso, y no queda nada guardado', async (e) => {
  const esc = await e.armar();
  const ana = await e.crearUsuario('ana@prueba.com');
  const bien = await e.aviso('lavanda');
  const pedir = (cambios) => e.llamarComo(ana, 'pedir_acceso', { p_slug: 'lavanda', p_nombre: 'Ana Paz', p_profesion: 'Kinesióloga', p_categoria: esc.estetica,
    p_telefono: '', p_cuit: '', ...cambios });
  const antes = await e.uno('select (select count(*) from public.miembros)::int as m, (select count(*) from public.avisos)::int as a, (select count(*) from interno.consentimientos)::int as k');
  await esperarError(pedir({}), 'privacidad_falta');                                                // la página vieja
  await esperarError(pedir({ p_privacidad: '', p_exterior: true }), 'privacidad_falta');
  await esperarError(pedir({ p_privacidad: bien.p_privacidad }), 'privacidad_exterior');
  await esperarError(pedir({ p_privacidad: bien.p_privacidad, p_exterior: false }), 'privacidad_exterior');
  await esperarError(pedir({ p_privacidad: huellaDe('otro texto'), p_exterior: true }), 'privacidad_cambio');
  assert.deepEqual(await e.uno('select (select count(*) from public.miembros)::int as m, (select count(*) from public.avisos)::int as a, (select count(*) from interno.consentimientos)::int as k'), antes);

  const r = await pedir(bien);
  assert.deepEqual(await constancias(e, r.id), [{ version: 1, huella: bien.p_privacidad, aviso: true, exterior: true, usuario_id: ana }]);
  // y queda guardado el texto entero que tuvo en pantalla
  assert.equal((await e.uno('select texto from interno.privacidad_textos where huella = $1', [bien.p_privacidad])).texto, (await portada(e)).text);
});

prueba('quien ya tenía cuenta no puede reservar hasta aceptar; lo demás le sigue andando', async (e) => {
  const esc = await e.armar();
  const dia = await e.diaHabil(10);
  const r = await e.reservar(esc, esc.lucia, { fecha: dia });
  await sinConstancia(e, esc.lucia, esc);
  await esperarError(e.reservar(esc, esc.lucia, { fecha: dia, desde: 12, hasta: 16 }), 'privacidad_falta');
  // ve lo suyo, paga y cancela igual
  const yo = (await e.foto(esc, esc.lucia)).users[0];
  assert.equal(yo.privacy, null);
  await e.pagar(esc, esc.lucia, r.id, 'sena');
  await e.llamarComo(esc.lucia, 'cancelar_reserva', { p_slug: 'lavanda', p_reserva: r.id });

  const aceptar = (args) => e.llamarComo(esc.lucia, 'aceptar_privacidad', { p_slug: 'lavanda', ...args });
  const bien = await e.aviso('lavanda');
  await esperarError(aceptar({ p_privacidad: null, p_exterior: true }), 'privacidad_falta');
  await esperarError(aceptar({ ...bien, p_exterior: null }), 'privacidad_exterior');
  await esperarError(aceptar({ ...bien, p_privacidad: 'x' }), 'privacidad_cambio');
  assert.deepEqual(await aceptar(bien), { ok: true });
  assert.deepEqual(await aceptar(bien), { ok: true });                         // dos veces: queda una sola constancia
  assert.equal((await constancias(e, await e.miembro(esc, esc.lucia))).length, 1);
  assert.equal((await e.foto(esc, esc.lucia)).users[0].privacy.version, 1);
  await e.reservar(esc, esc.lucia, { fecha: dia, desde: 12, hasta: 16 });
});

prueba('una versión nueva del aviso se pide de nuevo, y quedan las dos constancias', async (e) => {
  const esc = await e.armar();
  const dia = await e.diaHabil(10);
  const vieja = await e.aviso('lavanda');
  await e.sql(`insert into interno.privacidad (version, texto) select 2, replace(texto, 'versión 1', 'versión 2') || ' Ahora también.' from interno.privacidad where version = 1`);
  const p = await portada(e);
  assert.deepEqual([p.version, p.text.includes('Ahora también.'), p.hash === vieja.p_privacidad], [2, true, false]);
  await esperarError(e.reservar(esc, esc.lucia, { fecha: dia }), 'privacidad_falta');
  await esperarError(e.llamarComo(esc.lucia, 'aceptar_privacidad', { p_slug: 'lavanda', ...vieja }), 'privacidad_cambio');       // tenía la anterior en pantalla
  await e.llamarComo(esc.lucia, 'aceptar_privacidad', { p_slug: 'lavanda', ...(await e.aviso('lavanda')) });
  await e.reservar(esc, esc.lucia, { fecha: dia });
  assert.deepEqual((await constancias(e, await e.miembro(esc, esc.lucia))).map((k) => [k.version, k.huella === vieja.p_privacidad]), [[1, true], [2, false]]);
  assert.equal((await e.foto(esc, esc.lucia)).users[0].privacy.version, 2);
});

prueba('la dueña completa los datos del aviso; quien ya aceptó no tiene que volver a hacerlo', async (e) => {
  const esc = await e.armar();
  const guardar = (cambios) => e.llamarComo(esc.admin, 'guardar_privacidad', { p_slug: 'lavanda', p_responsable: 'Laura Benítez', p_domicilio: 'Av. Siempreviva 742, CABA',
    p_contacto: 'Laura@Consultorio.com', ...cambios });
  const antes = await e.aviso('lavanda');
  assert.deepEqual((await e.foto(esc, esc.admin)).config.privacy, { name: '', address: '', contact: '', complete: false });
  for (const mal of [{ p_contacto: 'sin-arroba' }, { p_contacto: 'a b@c.com' }, { p_contacto: 'a@b' }, { p_responsable: 'x'.repeat(121) }, { p_domicilio: 'x'.repeat(161) }]) {
    await esperarError(guardar(mal), 'dato_invalido');
  }
  await guardar({ p_domicilio: '  Av. Siempreviva 742,\n## CABA ' });                  // en un solo renglón: no puede meter títulos en el aviso
  const p = await portada(e);
  assert.ok(p.text.includes('base de datos de Laura Benítez, con domicilio en Av. Siempreviva 742, ## CABA, responsable de «Consultorio Lavanda»'));
  assert.ok(p.text.includes('Para cualquier pedido sobre tus datos: laura@consultorio.com.') && p.text.includes('Escribí a laura@consultorio.com.'));
  assert.deepEqual((await e.foto(esc, esc.admin)).config.privacy, { name: 'Laura Benítez', address: 'Av. Siempreviva 742, ## CABA', contact: 'laura@consultorio.com', complete: true });
  assert.equal((await e.foto(esc, esc.lucia)).config.privacy, null);
  // Lucía aceptó con los datos anteriores: la versión es la misma, así que reserva; quien entra ahora acepta el texto nuevo
  await e.reservar(esc, esc.lucia, { fecha: await e.diaHabil(10) });
  const nueva = await e.crearUsuario();
  const pedido = { p_slug: 'lavanda', p_nombre: 'Ana Paz', p_profesion: 'Kinesióloga', p_categoria: esc.estetica, p_telefono: '', p_cuit: '' };
  await esperarError(e.llamarComo(nueva, 'pedir_acceso', { ...pedido, ...antes }), 'privacidad_cambio');
  await e.llamarComo(nueva, 'pedir_acceso', { ...pedido, ...(await e.aviso('lavanda')) });
  assert.equal((await e.uno('select count(*)::int as n from interno.privacidad_textos')).n, 2);
  // si no completó nada para esto, se usan los de sus facturas
  await guardar({ p_responsable: '', p_domicilio: '', p_contacto: '' });
  await e.sql(`update public.consultorios set fact_nombre = 'Benítez Laura', fact_domicilio = 'Calle 1' where id = $1`, [esc.id]);
  assert.ok((await portada(e)).text.includes('base de datos de Benítez Laura, con domicilio en Calle 1, responsable de'));
});

prueba('lo que escribe la dueña no completa otros casilleros ni cambia el sentido del aviso', async (e) => {
  const esc = await e.armar();
  for (const marca of ['{contacto}', '{pedidos}', '{domicilio}', '{consultorio}', '{responsable}']) {
    await e.llamarComo(esc.admin, 'guardar_privacidad', { p_slug: 'lavanda', p_responsable: `Laura ${marca}`, p_domicilio: `Calle ${marca} 1`, p_contacto: 'laura@consultorio.com' });
    await e.sql('update public.consultorios set nombre = $1, duena = $2 where id = $3', [`Lavanda ${marca}`, 'Laura', esc.id]);
    const t = (await portada(e)).text, limpia = marca.replace('{', '(').replace('}', ')');
    assert.ok(t.includes(`base de datos de Laura ${limpia}, con domicilio en Calle ${limpia} 1, responsable de «Lavanda ${limpia}». Para cualquier pedido sobre tus datos: laura@consultorio.com.`), marca);
    assert.equal(/[{}]/.test(t), false);
  }
});

prueba('dos consultorios con el mismo texto: cada constancia queda con su consultorio', async (e) => {
  const a = await e.armar('lavanda');
  const b = await e.armar('lavanda-2');                   // el mismo nombre y la misma dueña: el texto sale idéntico
  assert.equal((await portada(e, 'lavanda')).hash, (await portada(e, 'lavanda-2')).hash);
  const textos = await e.sql('select consultorio_id from interno.privacidad_textos order by 1');
  assert.deepEqual(textos.map((t) => t.consultorio_id).sort(), [a.id, b.id].sort());
  const cruzadas = await e.sql('select k.id from interno.consentimientos k join public.miembros m on m.id = k.miembro_id where m.consultorio_id <> k.consultorio_id');
  assert.deepEqual(cruzadas, []);
});

prueba('quién ve la constancia: la dueña la de todas, cada profesional la suya; la dueña no tiene que aceptar', async (e) => {
  const esc = await e.armar();
  const f = await e.foto(esc, esc.admin);
  assert.deepEqual(f.users.map((u) => [u.name, u.privacy ? u.privacy.version : null]).sort(), [['Carolina Méndez', 1], ['Laura', null], ['Lucía Ferrari', 1], ['Martina Sosa', 1]]);
  assert.ok(f.users.every((u) => !u.privacy || Math.abs(u.privacy.at - Date.now()) < 60000));
  assert.deepEqual((await e.foto(esc, esc.lucia)).users.map((u) => u.name), ['Lucía Ferrari']);
  assert.deepEqual(await e.llamarComo(esc.admin, 'aceptar_privacidad', { p_slug: 'lavanda', p_privacidad: null, p_exterior: null }), { ok: true });
  assert.equal((await constancias(e, await e.miembro(esc, esc.admin))).length, 0);
});

prueba('la constancia no se lee ni se toca desde la página, y vale solo para ese consultorio', async (e) => {
  const a = await e.armar('lavanda');
  const b = await e.armar('nacar', { nombre: 'Espacio Nácar', duena: 'Inés' });
  for (const tabla of ['interno.privacidad', 'interno.privacidad_textos', 'interno.consentimientos']) {
    for (const quien of [(fn) => e.comoAnon(fn), (fn) => e.comoUsuario(a.lucia, fn), (fn) => e.comoUsuario(a.admin, fn)]) {
      await esperarSinPermiso(quien((c) => c.sql(`select * from ${tabla}`)));
    }
  }
  await esperarSinPermiso(e.comoAnon((c) => c.llamar('aceptar_privacidad', { p_slug: 'lavanda', p_privacidad: 'x', p_exterior: true })));
  // cada consultorio tiene su texto: el de uno no sirve en el otro
  assert.notEqual((await portada(e, 'lavanda')).hash, (await portada(e, 'nacar')).hash);
  const ana = await e.crearUsuario();
  await esperarError(e.llamarComo(ana, 'aceptar_privacidad', { p_slug: 'nacar', ...(await e.aviso('nacar')) }), 'solo_miembros');
  await esperarError(e.llamarComo(ana, 'pedir_acceso', { p_slug: 'nacar', p_nombre: 'Ana', p_profesion: 'Kine', p_categoria: b.estetica, p_telefono: '', p_cuit: '',
    ...(await e.aviso('lavanda')) }), 'privacidad_cambio');
  // quien aceptó en uno, en el otro todavía no
  await e.llamarComo(a.lucia, 'pedir_acceso', { p_slug: 'nacar', p_nombre: 'Lucía Ferrari', p_profesion: 'Médica', p_categoria: b.medica, p_telefono: '', p_cuit: '', ...(await e.aviso('nacar')) });
  assert.equal((await constancias(e, await e.miembro(b, a.lucia))).length, 1);
  assert.equal((await constancias(e, await e.miembro(a, a.lucia))).length, 1);
});
