// Datos de ejemplo para el servidor de prueba (el que corre en la compu, sin internet).
// NADA de esto es real: el consultorio, las personas y las claves existen solo en la memoria de ese servidor
// y se pierden cuando se lo apaga. Las claves de acá no sirven en ningún otro lado.

export const CLAVE_DE_PRUEBA = 'prueba-lavanda-2026';

export const CONSULTORIO = {
  slug: 'lavanda',
  nombre: 'Consultorio Lavanda',
  duena: 'Laura',
  letras: 'CL',
  reglamento: [
    'Dejá el box limpio y ordenado al terminar: camilla con papel nuevo, superficies desinfectadas y residuos en su lugar.',
    'Respetá el horario: entrá y salí dentro de tu turno. Si te pasás, se cobra el turno siguiente.',
    'Las llaves se retiran y se devuelven en recepción. No se hacen copias.',
    'Podés usar el equipamiento del box. No se mueven muebles ni equipos entre boxes.',
    'Los residuos patogénicos van en el recipiente rojo. Cada profesional trae sus insumos descartables.',
    'Cualquier rotura o faltante se avisa el mismo día a la administradora.',
  ].join('\n'),
  facturacion: { nombre: 'Laura Benítez', cuit: '27-30111222-5', condicion: 'Monotributo', puntoVenta: 2 },
};

export const CATEGORIAS = [
  { clave: 'medica', nombre: 'Médicas y médicos', nota: 'Atención médica.', precio: 10000 },
  { clave: 'estetica', nombre: 'Esteticistas', nota: 'Tratamientos estéticos, sin práctica médica.', precio: 6000 },
];

export const BOXES = [
  { numero: 1, nombre: 'Box 1', resumen: 'Camilla · lavatorio', equipamiento: ['Camilla eléctrica', 'Lavatorio con agua caliente', 'Escritorio y 2 sillas', 'Biombo', 'Aire acondicionado'] },
  { numero: 2, nombre: 'Box 2', resumen: 'Camilla · vitrina', equipamiento: ['Camilla fija', 'Vitrina para insumos', 'Escritorio y 2 sillas', 'Balanza y tallímetro', 'Aire acondicionado'] },
  { numero: 3, nombre: 'Box 3', resumen: 'Amplio · aparatología', equipamiento: ['Camilla eléctrica', 'Equipo de electroterapia', 'Lámpara de luz fría', 'Lavatorio', 'Aire acondicionado'],
    precios: { medica: 12000, estetica: 8000 } },
];

export const MAQUINAS = [
  { nombre: 'Láser de depilación', resumen: 'Equipo de diodo, para depilación definitiva.', precio: 16000, activa: true },
  { nombre: 'Criolipólisis', resumen: 'Para tratamientos corporales.', precio: 14000, activa: true },
  { nombre: 'Radiofrecuencia', resumen: 'Facial y corporal.', precio: 12000, activa: true },
  { nombre: 'Ultrasonido focalizado', resumen: 'Para tratamientos faciales.', precio: 18000, activa: false },
];

/** La dueña y las profesionales de prueba. Todas entran con CLAVE_DE_PRUEBA. */
export const DUENA = { email: 'laura@lavanda.prueba', nombre: 'Laura' };
export const PROFESIONALES = [
  { email: 'lucia@lavanda.prueba', nombre: 'Lucía Ferrari', profesion: 'Médica dermatóloga', categoria: 'medica', telefono: '11 5555-0111', cuit: '27-28111222-3', condicion: 6, estado: 'aprobado' },
  { email: 'caro@lavanda.prueba', nombre: 'Carolina Méndez', profesion: 'Cosmetóloga', categoria: 'estetica', telefono: '11 5555-0122', cuit: '27-30222333-0', condicion: 6, estado: 'aprobado' },
  { email: 'martina@lavanda.prueba', nombre: 'Martina Sosa', profesion: 'Cosmiatra', categoria: 'estetica', telefono: '11 5555-0155', cuit: '27-33555666-1', condicion: 5, estado: 'pendiente' },
];
