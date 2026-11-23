// Prueba de punta a punta contra el ambiente de PRUEBA de ARCA (homologación), con facturas de mentira:
// ticket, estado de los servidores, condiciones de IVA, una Factura C a consumidor final y otra a una persona con DNI,
// la consulta de lo emitido, una nota de crédito asociada, un rechazo a propósito y un número que no existe.
//
// Usa internet y el certificado de PRUEBA de la carpeta «ENTRETURNO - ARCA» del escritorio (nunca el real).
// No corre con `npm test`. Uso: npm run test:arca
// El ticket de ARCA dura 12 horas y no se puede pedir otro mientras vale: queda guardado en ARCA_TICKET y se reusa.
import forge from "node-forge";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import * as arca from "../supabase/functions/_compartido/arca.ts";

const carpeta = process.env.ARCA_CARPETA ?? "C:\\Users\\santi\\Desktop\\ENTRETURNO - ARCA";
const archivoTicket = process.env.ARCA_TICKET ?? "E:\\Entreturno boxes\\pruebas\\arca\\ticket-prueba.json";
const archivoEmitidas = path.join(path.dirname(archivoTicket), "facturas-de-prueba.json");

const certPem = await readFile(path.join(carpeta, "certificado-prueba.pem"), "utf8");
const clavePem = await readFile(path.join(carpeta, "clave-prueba.key"), "utf8");
const serie = forge.pki.certificateFromPem(certPem).subject.attributes.find((a) => a.name === "serialNumber")?.value;
const cuit = /^CUIT (\d{11})$/.exec(serie ?? "")?.[1];
if (!cuit) throw new Error("El certificado de prueba no trae la CUIT");

let bien = 0;
let total = 0;
function comprobar(nombre, ok, detalle = "") {
  total++;
  if (ok) bien++;
  console.log(`${ok ? "BIEN " : "FALLA"}  ${nombre}${detalle ? `: ${detalle}` : ""}`);
}
const avisos = (r) =>
  [...(r.errores ?? []), ...(r.observaciones ?? [])].map((a) => `${a.codigo} ${a.mensaje}`).join(" | ");
const enArgentina = (iso) =>
  new Date(iso).toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires", hourCycle: "h23" });

async function paso(nombre, fn) {
  try {
    return await fn();
  } catch (e) {
    comprobar(nombre, false, e instanceof arca.ErrorArca ? `${e.codigo}: ${e.message}` : String(e));
    return null;
  }
}

const emitidas = [];
const ambiente = "prueba";

// 1. Ticket de acceso
const ticket = await paso("ticket de acceso (WSAA)", () =>
  arca.obtenerTicket({
    ambiente,
    leer: async () => {
      try {
        return JSON.parse(await readFile(archivoTicket, "utf8"));
      } catch {
        return null;
      }
    },
    guardar: async (t) => {
      await mkdir(path.dirname(archivoTicket), { recursive: true });
      await writeFile(archivoTicket, JSON.stringify(t, null, 2));
    },
    firmar: (tra) => arca.firmarTRA(forge, tra, certPem, clavePem),
  }),
);
if (!ticket) process.exit(1);
comprobar("ticket de acceso (WSAA)", !!ticket.token && !!ticket.sign, `vence ${enArgentina(ticket.vence)}`);
const cred = { token: ticket.token, sign: ticket.sign, cuit };

// 2. Servidores
await paso("servidores de facturación", async () => {
  const e = await arca.estadoServidores(ambiente);
  comprobar("servidores de facturación", e.app === "OK" && e.base === "OK" && e.autenticacion === "OK", JSON.stringify(e));
});

// 3. Condiciones de IVA que acepta la clase C
await paso("condiciones de IVA de la clase C", async () => {
  const lista = await arca.condicionesIva(ambiente, cred, "C");
  const ids = lista.map((c) => c.id);
  const faltan = Object.entries(arca.CONDICION_IVA).filter(([, id]) => !ids.includes(id));
  comprobar(
    "condiciones de IVA de la clase C (las que usa el sistema existen)",
    faltan.length === 0,
    lista.map((c) => `${c.id} ${c.descripcion}`).join("; ") + (faltan.length ? ` | NO ESTÁN: ${JSON.stringify(faltan)}` : ""),
  );
});

// 4. Factura C a consumidor final, por un turno de la semana que viene
const hoy = arca.fechaArca();
const enUnaSemana = arca.fechaArca(new Date(Date.now() + 7 * 864e5));
const f1 = {
  puntoVenta: 1,
  tipo: arca.TIPO.factura.C,
  docTipo: arca.DOC.sinIdentificar,
  docNro: 0,
  condicionIva: arca.CONDICION_IVA.consumidorFinal,
  total: 100000,
  fecha: hoy,
  servicioDesde: enUnaSemana,
};
const anotados = []; // lo que en el sistema real se guarda en la base antes de mandar
const emitir = (comprobante, extra = {}) =>
  arca.emitirComprobante({
    ambiente,
    cred,
    comprobante,
    antesDeEnviar: async (n) => {
      anotados.push(n);
    },
    ...extra,
  });
const r1 = await paso("Factura C a consumidor final", () => emitir(f1));
if (r1) {
  comprobar(
    "Factura C a consumidor final ($ 100.000, turno de la semana que viene)",
    r1.resultado === "A" && /^\d{14}$/.test(r1.cae ?? ""),
    `número ${r1.numero}, CAE ${r1.cae}, vence ${r1.caeVence} ${avisos(r1)}`,
  );
  emitidas.push({ ...f1, ...r1 });

  // 5. Consultar lo emitido: tiene que reconocerla como «la nuestra» con todos los datos que devuelve ARCA
  await paso("consulta de esa factura", async () => {
    const q = await arca.consultarComprobante(ambiente, cred, 1, f1.tipo, r1.numero);
    comprobar(
      "consulta de esa factura: ARCA devuelve todos los datos y coinciden con lo mandado",
      q?.cae === r1.cae && arca.coincide(q, f1),
      JSON.stringify(q),
    );
  });

  // 5 bis. Conciliar un número que quedó «pendiente»: se recupera sin emitir otra
  await paso("conciliación de un pendiente", async () => {
    const antes = anotados.length;
    const r = await emitir(f1, { pendiente: { numero: r1.numero, desde: new Date(Date.now() - 10 * 60_000) } });
    comprobar(
      "un número pendiente que ARCA tiene igual se recupera sin emitir otra factura",
      r.recuperado === true && r.cae === r1.cae && anotados.length === antes,
      `número ${r.numero}`,
    );
  });
}

// 6. Factura C a una persona con DNI
const f2 = { ...f1, docTipo: arca.DOC.dni, docNro: "30123456", total: 60000 };
const r2 = await paso("Factura C con DNI", () => emitir(f2));
if (r2) {
  comprobar(
    "Factura C a una persona con DNI ($ 60.000)",
    r2.resultado === "A" && /^\d{14}$/.test(r2.cae ?? ""),
    `número ${r2.numero}, CAE ${r2.cae} ${avisos(r2)}`,
  );
  emitidas.push({ ...f2, ...r2 });
}

// 7. Nota de crédito por la mitad de la primera (una devolución por cancelación)
if (r1?.resultado === "A") {
  const nc = {
    ...f1,
    tipo: arca.TIPO.notaCredito.C,
    total: 50000,
    asociado: { tipo: f1.tipo, puntoVenta: 1, numero: r1.numero, cuit, fecha: r1.fecha ?? hoy },
  };
  const r3 = await paso("nota de crédito", () => emitir(nc));
  if (r3) {
    comprobar(
      "Nota de crédito C por $ 50.000, asociada a la primera factura",
      r3.resultado === "A" && /^\d{14}$/.test(r3.cae ?? ""),
      `número ${r3.numero}, CAE ${r3.cae} ${avisos(r3)}`,
    );
    emitidas.push({ ...nc, ...r3 });
  }
}

// 8. Un rechazo a propósito: una condición de IVA que no existe
const r4 = await paso("rechazo a propósito", () => emitir({ ...f1, condicionIva: 99 }));
if (r4) {
  comprobar(
    "rechazo a propósito (condición de IVA que no existe): vuelve como R, sin CAE y con el motivo",
    r4.resultado === "R" && r4.cae === null && avisos(r4) !== "",
    avisos(r4),
  );
}

// 9. Un número que no existe
await paso("número que no existe", async () => {
  const u = await arca.ultimoAutorizado(ambiente, cred, 1, f1.tipo);
  const q = await arca.consultarComprobante(ambiente, cred, 1, f1.tipo, u + 50);
  comprobar("un número que no existe vuelve como «no está»", q === null, `último autorizado: ${u}`);
});

if (emitidas.length) {
  let anteriores = [];
  try {
    anteriores = JSON.parse(await readFile(archivoEmitidas, "utf8"));
  } catch {
    // primera vez
  }
  await writeFile(archivoEmitidas, JSON.stringify([...anteriores, ...emitidas.map((e) => ({ ...e, en: new Date().toISOString() }))], null, 2));
}

console.log(`\n${bien} de ${total} bien`);
process.exitCode = bien === total ? 0 : 1;
