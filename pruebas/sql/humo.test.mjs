// Prueba de humo: las migraciones cargan y el consultorio de ejemplo se arma.
import assert from 'node:assert/strict';

import { prueba } from './entorno.mjs';

prueba('las migraciones cargan y el consultorio de ejemplo queda armado', async (e) => {
  const esc = await e.armar();
  const cuenta = await e.uno(
    `select (select count(*) from public.boxes)::int as boxes, (select count(*) from public.categorias)::int as categorias,
            (select count(*) from public.maquinas)::int as maquinas, (select count(*) from public.miembros)::int as miembros`,
  );
  assert.deepEqual(cuenta, { boxes: 3, categorias: 2, maquinas: 3, miembros: 4 });
  const estados = await e.sql(`select nombre, rol, estado from public.miembros where consultorio_id = $1 order by desde, nombre`, [esc.id]);
  assert.deepEqual(estados.map((m) => `${m.nombre}:${m.rol}:${m.estado}`).sort(), [
    'Carolina Méndez:pro:aprobado', 'Laura:admin:aprobado', 'Lucía Ferrari:pro:aprobado', 'Martina Sosa:pro:pendiente',
  ]);
});
