// La migración de facturas sobre una base que YA tiene datos, como la del proyecto real (revisión 5 de Codex, punto 14):
// se arma la base con las migraciones anteriores, se cargan datos como los de Yani (con la página vieja) y recién ahí
// se carga la nueva, como se hace en el SQL Editor.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DUENO, MIGRACIONES, armarBase, comoRol, crearCuenta, leerMigracion } from '../base.mjs';

test('la migración de facturas se carga sobre una base con datos y lo que había sigue andando', async () => {
  const nueva = '20261123100000_facturas_arca.sql';
  const pg = await armarBase(MIGRACIONES.filter((m) => m !== nueva));
  try {
    // Como el proyecto real: el consultorio de Yani, «Soporte Entreturno» como dueña (sin CUIT) y una profesional que
    // pidió acceso con la página vieja, con una CUIT que no da (antes se aceptaba cualquier número)
    const c = (await pg.query(
      `insert into public.consultorios (slug, nombre, duena, letras, reglamento) values ('yanina', 'Consultorio Yani', 'Yani', 'YO', 'Provisorio') returning id`,
    )).rows[0].id;
    const cat = (await pg.query(
      `insert into public.categorias (consultorio_id, nombre, nota, precio_hora, orden) values ($1, 'Médicas y médicos', '', 25000, 1) returning id`, [c],
    )).rows[0].id;
    const soporte = await crearCuenta(pg, 'soporte@entreturno.prueba');
    await pg.query(`select interno.alta_admin('yanina', 'soporte@entreturno.prueba', 'Soporte Entreturno')`);
    const comoPersona = (sub, sql, params) => comoRol(pg, 'authenticated', sub, (tx) => tx.query(sql, params));
    const pedirViejo = (sub, nombre, cuit) => comoPersona(sub,
      `select public.pedir_acceso(p_slug => 'yanina', p_nombre => $2, p_profesion => 'Médica', p_categoria => $1, p_telefono => '', p_cuit => $3)`,
      [cat, nombre, cuit]);
    await pedirViejo(await crearCuenta(pg, 'vieja@prueba.com'), 'Vieja', '27-11111111-1');

    // La migración nueva, como en el SQL Editor
    await pg.exec(`set role ${DUENO}`);
    await pg.exec(leerMigracion(nueva));
    await pg.exec('reset role');

    // Lo que había sigue andando: la foto de la dueña, la profesional vieja con su CUIT (la dueña la ve y la corrige)
    const foto = (await comoPersona(soporte, `select public.foto(p_slug => 'yanina') as f`)).rows[0].f;
    assert.equal(foto.site.name, 'Consultorio Yani');
    const vieja = foto.users.find((u) => u.name === 'Vieja');
    assert.deepEqual([vieja.cuit, vieja.ivaCond], ['27-11111111-1', null]);
    assert.deepEqual([foto.config.billing.env, foto.invoices], ['apagado', []]);
    // Un pedido de acceso mandado por la página vieja (sin condición de IVA, sin CUIT) sigue entrando
    await pedirViejo(await crearCuenta(pg, 'otra@prueba.com'), 'Otra', '');
    // Y la base queda como la nueva: las funciones de ARCA, cerradas para la página
    const cerradas = (await pg.query(`
      select count(*)::int as n from pg_proc p
       where p.pronamespace = 'public'::regnamespace and p.proname like 'arca\\_%'
         and has_function_privilege('service_role', p.oid, 'execute')
         and not has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute')`)).rows[0].n;
    assert.equal(cerradas, 5);
  } finally {
    await pg.close();
  }
});
