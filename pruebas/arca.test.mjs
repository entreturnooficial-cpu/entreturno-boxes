// Pruebas de la conexión con ARCA (supabase/functions/_compartido/arca.ts) sin internet: ARCA se imita con
// respuestas armadas a mano, copiadas de la forma que tienen las reales (manual de WSFEv1 v4.8, WSDL y WSAA).
// La prueba contra el ambiente de prueba de ARCA de verdad está en pruebas/arca-real.mjs (npm run test:arca).
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import forge from "node-forge";
import * as arca from "../supabase/functions/_compartido/arca.ts";

// ---------------------------------------------------------------------------------------------------------------
// Ayudas
// ---------------------------------------------------------------------------------------------------------------

function certificadoDePrueba({ vencido = false } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" }, // como los que arma OpenSSL 3
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.publicKeyFromPem(publicKey);
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date(Date.now() - 2 * 86400e3);
  cert.validity.notAfter = new Date(Date.now() + (vencido ? -86400e3 : 86400e3));
  const nombre = [{ name: "commonName", value: "prueba" }, { name: "serialNumber", value: "CUIT 20123456786" }];
  cert.setSubject(nombre);
  cert.setIssuer(nombre);
  cert.sign(forge.pki.privateKeyFromPem(privateKey), forge.md.sha256.create());
  return { certPem: forge.pki.certificateToPem(cert), clavePem: privateKey };
}

function opensslDisponible() {
  for (const p of ["C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe", "openssl"]) {
    const r = spawnSync(p, ["version"], { encoding: "utf8" });
    if (r.status === 0) return p;
  }
  return null;
}

/** Imita fetch: cada pedido recibe la respuesta que le toca, en orden. Guarda lo que se mandó. */
function fetchFalso(respuestas) {
  const pedidos = [];
  const f = async (url, init) => {
    const i = pedidos.length;
    pedidos.push({ url, accion: init.headers.SOAPAction, cuerpo: init.body });
    const r = respuestas[i];
    if (r === undefined) throw new Error(`pedido de más: ${init.headers.SOAPAction}`);
    if (r instanceof Error) throw r;
    return new Response(r.body, { status: r.status ?? 200 });
  };
  f.pedidos = pedidos;
  return f;
}

const metodos = (f) => f.pedidos.map((p) => p.accion.replace(/^"http:\/\/ar\.gov\.afip\.dif\.FEV1\/|"$/g, ""));

const sobre = (cuerpo) =>
  `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">` +
  `<soap:Body>${cuerpo}</soap:Body></soap:Envelope>`;

const ultimo = (n) => ({
  body: sobre(
    `<FECompUltimoAutorizadoResponse xmlns="http://ar.gov.afip.dif.FEV1/"><FECompUltimoAutorizadoResult>` +
      `<PtoVta>1</PtoVta><CbteTipo>11</CbteTipo><CbteNro>${n}</CbteNro>` +
      `</FECompUltimoAutorizadoResult></FECompUltimoAutorizadoResponse>`,
  ),
});

const caeResp = (resultadoCab, detalle, extra = "") => ({
  body: sobre(
    `<FECAESolicitarResponse xmlns="http://ar.gov.afip.dif.FEV1/"><FECAESolicitarResult><FeCabResp>` +
      `<Cuit>20123456786</Cuit><PtoVta>1</PtoVta><CbteTipo>11</CbteTipo><FchProceso>20261123120000</FchProceso>` +
      `<CantReg>1</CantReg><Resultado>${resultadoCab}</Resultado><Reproceso>N</Reproceso></FeCabResp>` +
      (detalle === null ? "" : `<FeDetResp><FECAEDetResponse>${detalle}</FECAEDetResponse></FeDetResp>`) +
      `${extra}</FECAESolicitarResult></FECAESolicitarResponse>`,
  ),
});

const detalleBase = (n) =>
  `<Concepto>2</Concepto><DocTipo>99</DocTipo><DocNro>0</DocNro><CbteDesde>${n}</CbteDesde><CbteHasta>${n}</CbteHasta>` +
  `<CbteFch>20261123</CbteFch>`;

const aprobado = (n, cae = "76470000000001") =>
  caeResp("A", `${detalleBase(n)}<Resultado>A</Resultado><CAE>${cae}</CAE><CAEFchVto>20261203</CAEFchVto>`);

const rechazado = (n, codigo, mensaje) =>
  caeResp(
    "R",
    `${detalleBase(n)}<Resultado>R</Resultado><Observaciones><Obs><Code>${codigo}</Code><Msg>${mensaje}</Msg></Obs>` +
      `</Observaciones><CAE /><CAEFchVto />`,
  );

/** Lo que devuelve FECompConsultar para la facturaC() de abajo (se puede cambiar un campo para que no coincida). */
const consultado = (n, cambios = {}) => {
  const v = {
    Concepto: 2, DocTipo: 99, DocNro: 0, CbteDesde: n, CbteHasta: n, CbteFch: "20261123", ImpTotal: 100000,
    ImpTotConc: 0, ImpNeto: 100000, ImpOpEx: 0, ImpTrib: 0, ImpIVA: 0, FchServDesde: "20261130",
    FchServHasta: "20261130", FchVtoPago: "20261123", MonId: "PES", MonCotiz: 1, CondicionIVAReceptorId: 5,
    Resultado: "A", CodAutorizacion: "76470000000009", EmisionTipo: "CAE", FchVto: "20261203",
    FchProceso: "20261123120000", PtoVta: 1, CbteTipo: 11, ...cambios,
  };
  const campos = Object.entries(v).map(([k, x]) => `<${k}>${x}</${k}>`).join("");
  return {
    body: sobre(
      `<FECompConsultarResponse xmlns="http://ar.gov.afip.dif.FEV1/"><FECompConsultarResult><ResultGet>${campos}` +
        `</ResultGet></FECompConsultarResult></FECompConsultarResponse>`,
    ),
  };
};

const noExiste = {
  body: sobre(
    `<FECompConsultarResponse xmlns="http://ar.gov.afip.dif.FEV1/"><FECompConsultarResult><Errors><Err><Code>602</Code>` +
      `<Msg>No existen datos en nuestros registros para los parametros ingresados.</Msg></Err></Errors>` +
      `</FECompConsultarResult></FECompConsultarResponse>`,
  ),
};

const ticketXml = (vence) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><loginTicketResponse version="1.0"><header>` +
  `<source>CN=wsaahomo, O=AFIP, C=AR</source><destination>SERIALNUMBER=CUIT 20123456786, CN=prueba</destination>` +
  `<uniqueId>1</uniqueId><generationTime>2026-11-23T10:54:17.152-03:00</generationTime>` +
  `<expirationTime>${vence}</expirationTime></header><credentials><token>TOKEN+/=</token>` +
  `<sign>SIGN&amp;==</sign></credentials></loginTicketResponse>`;

const respuestaWsaa = (vence) => ({
  body:
    `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body>` +
    `<loginCmsResponse xmlns="http://wsaa.view.sua.dvadac.desein.afip.gov"><loginCmsReturn>` +
    ticketXml(vence).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") +
    `</loginCmsReturn></loginCmsResponse></soapenv:Body></soapenv:Envelope>`,
});

const yaTieneTicket = {
  status: 500,
  body:
    `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><soapenv:Fault>` +
    `<faultcode xmlns:ns1="http://xml.apache.org/axis/">ns1:coe.alreadyAuthenticated</faultcode>` +
    `<faultstring>El CEE ya posee un TA valido para el acceso al WSN solicitado</faultstring>` +
    `</soapenv:Fault></soapenv:Body></soapenv:Envelope>`,
};

const cred = { token: "T&K", sign: "S<G", cuit: "20-12345678-6" };

const facturaC = (extra = {}) => ({
  puntoVenta: 1,
  tipo: arca.TIPO.factura.C,
  docTipo: arca.DOC.sinIdentificar,
  docNro: 0,
  condicionIva: arca.CONDICION_IVA.consumidorFinal,
  total: 100000,
  fecha: "2026-11-23",
  servicioDesde: "2026-11-30",
  ...extra,
});

const sinPausa = async () => {};
const anotar = (lista) => async (n) => {
  lista.push(n);
};

// ---------------------------------------------------------------------------------------------------------------
// Ticket de acceso
// ---------------------------------------------------------------------------------------------------------------

test("armarTRA: servicio, ventana de 20 minutos y fechas sin milésimas", () => {
  const ahora = new Date("2026-11-23T13:00:00.123Z");
  const tra = arca.armarTRA("wsfe", ahora);
  assert.match(tra, /<service>wsfe<\/service>/);
  assert.match(tra, /<uniqueId>1795438800<\/uniqueId>/);
  assert.match(tra, /<generationTime>2026-11-23T12:50:00Z<\/generationTime>/);
  assert.match(tra, /<expirationTime>2026-11-23T13:10:00Z<\/expirationTime>/);
});

test("firmarTRA: CMS con el TRA adentro, firmado con la clave y con el certificado incluido", (t) => {
  const { certPem, clavePem } = certificadoDePrueba();
  const tra = arca.armarTRA("wsfe");
  const cms = arca.firmarTRA(forge, tra, certPem, clavePem);
  const mensaje = forge.pkcs7.messageFromAsn1(forge.asn1.fromDer(forge.util.decode64(cms)));
  assert.equal(mensaje.certificates.length, 1);
  assert.equal(mensaje.rawCapture.content.value[0].value, tra);

  const openssl = opensslDisponible();
  if (!openssl) return t.skip("no hay OpenSSL para verificar la firma");
  const dir = mkdtempSync(path.join(tmpdir(), "arca-"));
  try {
    writeFileSync(path.join(dir, "tra.cms"), Buffer.from(cms, "base64"));
    const r = spawnSync(openssl, ["cms", "-verify", "-noverify", "-inform", "DER", "-in", path.join(dir, "tra.cms")], {
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, tra);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("firmarTRA: clave que no corresponde, certificado vencido o ilegible", () => {
  const a = certificadoDePrueba();
  const b = certificadoDePrueba();
  assert.throws(() => arca.firmarTRA(forge, "<x/>", a.certPem, b.clavePem), { codigo: "clave_no_corresponde" });
  const v = certificadoDePrueba({ vencido: true });
  assert.throws(() => arca.firmarTRA(forge, "<x/>", v.certPem, v.clavePem), { codigo: "certificado_vencido" });
  assert.throws(() => arca.firmarTRA(forge, "<x/>", "no es un certificado", a.clavePem), (e) => {
    assert.equal(e.codigo, "certificado_invalido");
    assert.doesNotMatch(e.message, /PRIVATE|BEGIN/); // el mensaje no arrastra nada de la clave
    return true;
  });
});

test("pedirTicket: lee token, firma y vencimiento del WSAA de prueba", async () => {
  const f = fetchFalso([respuestaWsaa("2026-11-23T22:54:17.152-03:00")]);
  const t = await arca.pedirTicket("prueba", "Q01T", f);
  assert.deepEqual(t, { token: "TOKEN+/=", sign: "SIGN&==", vence: "2026-11-24T01:54:17.152Z" });
  assert.equal(f.pedidos[0].url, arca.DIRECCIONES.prueba.wsaa);
  assert.equal(f.pedidos[0].accion, '""');
  assert.match(f.pedidos[0].cuerpo, /<wsaa:in0>Q01T<\/wsaa:in0>/);
});

test("pedirTicket: una falla del WSAA vuelve como ErrorArca con su código", async () => {
  await assert.rejects(arca.pedirTicket("prueba", "eA==", fetchFalso([yaTieneTicket])), {
    codigo: "coe.alreadyAuthenticated",
    message: "El CEE ya posee un TA valido para el acceso al WSN solicitado",
    transporte: false,
  });
});

test("ticketVigente: un ticket incompleto no sirve aunque no haya vencido", () => {
  const ahora = new Date("2026-11-23T14:00:00Z");
  assert.equal(arca.ticketVigente({ token: "a", sign: "b", vence: "2026-11-23T20:00:00Z" }, ahora), true);
  assert.equal(arca.ticketVigente({ token: "", sign: "b", vence: "2026-11-23T20:00:00Z" }, ahora), false);
  assert.equal(arca.ticketVigente({ token: "a", vence: "2026-11-23T20:00:00Z" }, ahora), false);
  assert.equal(arca.ticketVigente({ token: "a", sign: "b", vence: "cualquier cosa" }, ahora), false);
});

test("obtenerTicket: reusa el guardado, pide uno nuevo si venció y lo guarda", async () => {
  const ahora = new Date("2026-11-23T14:00:00Z");
  const vigente = { token: "a", sign: "b", vence: "2026-11-23T20:00:00Z" };
  let guardado = vigente;
  const leer = async () => guardado;
  const guardar = async (t) => {
    guardado = t;
  };
  const firmar = () => "CMS";

  const f1 = fetchFalso([]);
  assert.deepEqual(await arca.obtenerTicket({ ambiente: "prueba", leer, guardar, firmar, fetchFn: f1, ahora }), vigente);
  assert.equal(f1.pedidos.length, 0);

  guardado = { token: "a", sign: "b", vence: "2026-11-23T13:00:00Z" }; // vencido
  const f2 = fetchFalso([respuestaWsaa("2026-11-24T02:00:00Z")]);
  const nuevo = await arca.obtenerTicket({ ambiente: "prueba", leer, guardar, firmar, fetchFn: f2, ahora });
  assert.equal(nuevo.token, "TOKEN+/=");
  assert.equal(guardado.token, "TOKEN+/=");
});

test("obtenerTicket: pedido antes de tiempo, ARCA dice que ya dio uno y se sigue usando el viejo", async () => {
  const viejo = { token: "viejo", sign: "s", vence: new Date(Date.now() + 5 * 60_000).toISOString() }; // 5 minutos
  const t = await arca.obtenerTicket({
    ambiente: "prueba",
    leer: async () => viejo,
    guardar: async () => assert.fail("no tiene que guardar nada"),
    firmar: () => "CMS",
    fetchFn: fetchFalso([yaTieneTicket]),
    dormir: sinPausa,
  });
  assert.equal(t.token, "viejo");
});

test("obtenerTicket: dos corridas a la vez; la que pierde espera a que la otra guarde", async () => {
  const otro = { token: "otro", sign: "s", vence: new Date(Date.now() + 12 * 3600e3).toISOString() };
  let lecturas = 0;
  let pausas = 0;
  const t = await arca.obtenerTicket({
    ambiente: "prueba",
    leer: async () => (++lecturas < 3 ? null : otro), // la otra corrida guarda recién en la tercera lectura
    guardar: async () => {},
    firmar: () => "CMS",
    fetchFn: fetchFalso([yaTieneTicket]),
    dormir: async () => {
      pausas++;
    },
  });
  assert.equal(t.token, "otro");
  assert.equal(pausas, 1);

  await assert.rejects(
    arca.obtenerTicket({
      ambiente: "prueba",
      leer: async () => null,
      guardar: async () => {},
      firmar: () => "CMS",
      fetchFn: fetchFalso([yaTieneTicket]),
      dormir: sinPausa,
    }),
    { codigo: "ticket_perdido" },
  );
});

test("obtenerTicket: si no se puede guardar el ticket, reintenta y después lo avisa", async () => {
  let intentos = 0;
  await assert.rejects(
    arca.obtenerTicket({
      ambiente: "prueba",
      leer: async () => null,
      guardar: async () => {
        intentos++;
        throw new Error("base caída");
      },
      firmar: () => "CMS",
      fetchFn: fetchFalso([respuestaWsaa("2026-11-24T02:00:00Z")]),
      dormir: sinPausa,
    }),
    { codigo: "ticket_sin_guardar" },
  );
  assert.equal(intentos, 3);
});

// ---------------------------------------------------------------------------------------------------------------
// Datos, fechas y armado del comprobante
// ---------------------------------------------------------------------------------------------------------------

test("fechas: la fecha es la argentina, no la UTC, y tiene que existir", () => {
  assert.equal(arca.fechaArca(new Date("2026-11-24T02:00:00Z")), "20261123"); // 23 a las 23:00 en la Argentina
  assert.equal(arca.fechaArca(new Date("2026-11-24T03:00:00Z")), "20261124");
  assert.equal(arca.aFechaArca("2026-12-01"), "20261201");
  assert.equal(arca.aFechaArca("20261201"), "20261201");
  assert.equal(arca.desdeFechaArca("20261203"), "2026-12-03");
  assert.equal(arca.desdeFechaArca(null), null);
  assert.throws(() => arca.aFechaArca("1/12/2026"), { codigo: "dato_invalido" });
  assert.throws(() => arca.aFechaArca("2026-02-31"), { codigo: "dato_invalido" });
  assert.throws(() => arca.aFechaArca("2026-13-01"), { codigo: "dato_invalido" });
});

test("cuitValida: formato y dígito verificador", () => {
  assert.equal(arca.cuitValida("20-12345678-6"), "20123456786");
  assert.equal(arca.cuitValida(20123456786), "20123456786");
  assert.throws(() => arca.cuitValida("20-12345678-9"), { codigo: "cuit_invalido" }); // la del ejemplo de ARCA no da
  assert.throws(() => arca.cuitValida("20ABC123456789"), { codigo: "cuit_invalido" });
  assert.throws(() => arca.cuitValida("2012345678"), { codigo: "cuit_invalido" });
});

test("armarDetalle: los campos van en el orden del WSDL, con importes de dos decimales", () => {
  const x = arca.armarDetalle(facturaC({ total: 100000.5 }), 7);
  const orden = [...x.matchAll(/<ar:(\w+)>/g)].map((m) => m[1]);
  assert.deepEqual(orden, [
    "FECAEDetRequest", "Concepto", "DocTipo", "DocNro", "CbteDesde", "CbteHasta", "CbteFch", "ImpTotal", "ImpTotConc",
    "ImpNeto", "ImpOpEx", "ImpTrib", "ImpIVA", "FchServDesde", "FchServHasta", "FchVtoPago", "MonId", "MonCotiz",
    "CondicionIVAReceptorId",
  ]);
  assert.match(x, /<ar:Concepto>2<\/ar:Concepto>/); // servicios
  assert.match(x, /<ar:DocTipo>99<\/ar:DocTipo><ar:DocNro>0<\/ar:DocNro>/);
  assert.match(x, /<ar:CbteDesde>7<\/ar:CbteDesde><ar:CbteHasta>7<\/ar:CbteHasta><ar:CbteFch>20261123<\/ar:CbteFch>/);
  assert.match(x, /<ar:ImpTotal>100000.50<\/ar:ImpTotal>/);
  assert.match(x, /<ar:ImpNeto>100000.50<\/ar:ImpNeto>/);
  assert.match(x, /<ar:ImpIVA>0.00<\/ar:ImpIVA>/);
  // el servicio es el turno (la semana que viene); el pago vence el día de la factura
  assert.match(x, /<ar:FchServDesde>20261130<\/ar:FchServDesde><ar:FchServHasta>20261130<\/ar:FchServHasta>/);
  assert.match(x, /<ar:FchVtoPago>20261123<\/ar:FchVtoPago>/);
  assert.match(x, /<ar:CondicionIVAReceptorId>5<\/ar:CondicionIVAReceptorId>/);
});

test("armarDetalle: DNI con puntos y CUIT con guiones quedan solo con números", () => {
  assert.match(arca.armarDetalle(facturaC({ docTipo: arca.DOC.dni, docNro: "30.123.456" }), 1), /<ar:DocNro>30123456<\/ar:DocNro>/);
  assert.match(
    arca.armarDetalle(facturaC({ docTipo: arca.DOC.cuit, docNro: "20-12345678-6", condicionIva: 6 }), 1),
    /<ar:DocTipo>80<\/ar:DocTipo><ar:DocNro>20123456786<\/ar:DocNro>/,
  );
});

test("armarDetalle: la nota de crédito lleva la factura asociada después de la condición de IVA", () => {
  const x = arca.armarDetalle(
    facturaC({
      tipo: arca.TIPO.notaCredito.C,
      total: 50000,
      asociado: { tipo: 11, puntoVenta: 1, numero: 7, cuit: "20-12345678-6", fecha: "2026-11-23" },
    }),
    3,
  );
  assert.match(
    x,
    /<ar:CondicionIVAReceptorId>5<\/ar:CondicionIVAReceptorId><ar:CbtesAsoc><ar:CbteAsoc><ar:Tipo>11<\/ar:Tipo><ar:PtoVta>1<\/ar:PtoVta><ar:Nro>7<\/ar:Nro><ar:Cuit>20123456786<\/ar:Cuit><ar:CbteFch>20261123<\/ar:CbteFch><\/ar:CbteAsoc><\/ar:CbtesAsoc><\/ar:FECAEDetRequest>$/,
  );
});

test("armarDetalle: en la clase B separa neto e IVA 21 %, en centavos y sin diferencias de redondeo", () => {
  const x = arca.armarDetalle(
    facturaC({ tipo: arca.TIPO.factura.B, total: 100000, neto: 82644.63, iva: 17355.37 }),
    1,
  );
  assert.match(x, /<ar:ImpTotal>100000.00<\/ar:ImpTotal>/);
  assert.match(x, /<ar:ImpNeto>82644.63<\/ar:ImpNeto>/);
  assert.match(x, /<ar:ImpIVA>17355.37<\/ar:ImpIVA>/);
  assert.match(
    x,
    /<ar:Iva><ar:AlicIva><ar:Id>5<\/ar:Id><ar:BaseImp>82644.63<\/ar:BaseImp><ar:Importe>17355.37<\/ar:Importe><\/ar:AlicIva><\/ar:Iva><\/ar:FECAEDetRequest>$/,
  );
});

test("armarDetalle: no deja salir un comprobante incompleto o incoherente", () => {
  const mal = (extra) => () => arca.armarDetalle(facturaC(extra), 1);
  const nc = { tipo: arca.TIPO.notaCredito.C, total: 50000 };
  const asociado = { tipo: 11, puntoVenta: 1, numero: 7, cuit: "20-12345678-6", fecha: "2026-11-23" };
  assert.throws(mal({ condicionIva: undefined }), { codigo: "dato_invalido" }, "sin condición de IVA");
  assert.throws(mal({ fecha: undefined }), { codigo: "dato_invalido" }, "sin fecha");
  assert.throws(mal({ servicioDesde: undefined }), { codigo: "dato_invalido" }, "sin el turno");
  assert.throws(mal({ total: 0 }), { codigo: "dato_invalido" }, "total cero");
  assert.throws(mal({ total: -5 }), { codigo: "dato_invalido" }, "total negativo");
  assert.throws(mal({ total: Number.NaN }), { codigo: "dato_invalido" }, "total que no es número");
  assert.throws(mal({ docTipo: arca.DOC.cuit, docNro: "" }), { codigo: "cuit_invalido" }, "CUIT vacía");
  assert.throws(mal({ docTipo: arca.DOC.cuit, docNro: "20-12345678-9" }), { codigo: "cuit_invalido" }, "CUIT que no da");
  assert.throws(mal({ docTipo: arca.DOC.dni, docNro: "30ABC456" }), { codigo: "dato_invalido" }, "DNI con letras");
  assert.throws(mal({ tipo: arca.TIPO.factura.B, total: 121000, neto: 100000, iva: 20000 }), { codigo: "dato_invalido" });
  assert.throws(mal({ tipo: arca.TIPO.factura.B, total: 101, neto: 100, iva: 1 }), { codigo: "dato_invalido" }, "IVA que no es 21 %");
  assert.throws(mal({ tipo: arca.TIPO.factura.B, total: 121000 }), { codigo: "dato_invalido" }, "B sin neto ni IVA");
  assert.throws(mal({ tipo: arca.TIPO.factura.A, total: 121000, neto: 100000, iva: 21000, docTipo: arca.DOC.dni, docNro: "30123456" }), { codigo: "dato_invalido" }, "A sin CUIT");
  assert.throws(mal({ iva: 21000 }), { codigo: "dato_invalido" }, "C con IVA");
  assert.throws(mal({ servicioDesde: "2026-11-30", servicioHasta: "2026-11-29" }), { codigo: "dato_invalido" });
  assert.throws(mal({ vencePago: "2026-11-22" }), { codigo: "dato_invalido" }, "vence antes de la factura");
  assert.throws(mal({ tipo: 99 }), { codigo: "dato_invalido" });
  assert.throws(mal(nc), { codigo: "dato_invalido" }, "nota de crédito sin factura asociada");
  assert.throws(mal({ ...nc, asociado: { ...asociado, tipo: 6 } }), { codigo: "dato_invalido" }, "asociada de otra clase");
  assert.throws(mal({ ...nc, asociado: { ...asociado, fecha: "2026-11-24" } }), { codigo: "dato_invalido" }, "asociada posterior");
});

// ---------------------------------------------------------------------------------------------------------------
// Pedidos al servicio de facturas
// ---------------------------------------------------------------------------------------------------------------

test("pedirCAE: aprobado; manda la acción y la CUIT limpia y escapa el ticket", async () => {
  const f = fetchFalso([aprobado(5)]);
  const r = await arca.pedirCAE("prueba", cred, facturaC(), 5, f);
  assert.deepEqual(r, {
    resultado: "A",
    numero: 5,
    cae: "76470000000001",
    caeVence: "2026-12-03",
    fecha: "2026-11-23",
    observaciones: [],
    errores: [],
  });
  assert.equal(f.pedidos[0].url, arca.DIRECCIONES.prueba.wsfe);
  assert.equal(f.pedidos[0].accion, '"http://ar.gov.afip.dif.FEV1/FECAESolicitar"');
  assert.match(f.pedidos[0].cuerpo, /<ar:Token>T&amp;K<\/ar:Token><ar:Sign>S&lt;G<\/ar:Sign><ar:Cuit>20123456786<\/ar:Cuit>/);
  assert.match(f.pedidos[0].cuerpo, /<ar:FeCabReq><ar:CantReg>1<\/ar:CantReg><ar:PtoVta>1<\/ar:PtoVta><ar:CbteTipo>11<\/ar:CbteTipo><\/ar:FeCabReq>/);
});

test("pedirCAE: un rechazo del detalle vuelve como R con las observaciones, sin CAE", async () => {
  const r = await arca.pedirCAE("prueba", cred, facturaC(), 5, fetchFalso([rechazado(5, 10015, "Fecha &amp; mal")]));
  assert.equal(r.resultado, "R");
  assert.equal(r.cae, null);
  assert.deepEqual(r.observaciones, [{ codigo: 10015, mensaje: "Fecha & mal" }]);
});

test("pedirCAE: un rechazo general (sin detalle) también vuelve como R, con los errores", async () => {
  const general = caeResp(
    "R",
    null,
    `<Errors><Err><Code>600</Code><Msg>ValidacionDeToken: No aparecio CUIT en lista de relaciones</Msg></Err></Errors>`,
  );
  const r = await arca.pedirCAE("prueba", cred, facturaC(), 5, fetchFalso([general]));
  assert.equal(r.resultado, "R");
  assert.equal(r.errores[0].codigo, 600);
});

test("pedirCAE: una respuesta vacía, rara o sin CAE no se toma como rechazo: queda en duda", async () => {
  const pedir = (resp) => arca.pedirCAE("prueba", cred, facturaC(), 5, fetchFalso([resp]));
  await assert.rejects(pedir({ body: "" }), { codigo: "respuesta_rara", transporte: true });
  await assert.rejects(pedir({ body: sobre("<Otra/>") }), { codigo: "respuesta_rara", transporte: true });
  await assert.rejects(pedir(caeResp("A", `${detalleBase(5)}<Resultado>A</Resultado><CAE /><CAEFchVto />`)), {
    codigo: "respuesta_rara",
  });
  await assert.rejects(pedir(aprobado(6)), { codigo: "respuesta_rara" }, "respuesta por otro número");
  await assert.rejects(pedir({ body: sobre(`<x>${"a".repeat(1_000_001)}</x>`) }), { codigo: "respuesta_rara" });
});

test("ultimoAutorizado y consultarComprobante: errores de ARCA, comprobante que no existe y respuesta incompleta", async () => {
  const conError = {
    body: sobre(
      `<FECompUltimoAutorizadoResponse xmlns="http://ar.gov.afip.dif.FEV1/"><FECompUltimoAutorizadoResult><PtoVta>1</PtoVta>` +
        `<CbteTipo>11</CbteTipo><CbteNro>0</CbteNro><Errors><Err><Code>600</Code><Msg>ValidacionDeToken: No aparecio CUIT en lista de relaciones</Msg></Err></Errors>` +
        `</FECompUltimoAutorizadoResult></FECompUltimoAutorizadoResponse>`,
    ),
  };
  await assert.rejects(arca.ultimoAutorizado("prueba", cred, 1, 11, fetchFalso([conError])), { codigo: "arca_600" });
  assert.equal(await arca.consultarComprobante("prueba", cred, 1, 11, 99, fetchFalso([noExiste])), null);
  const vacia = { body: sobre(`<FECompConsultarResponse xmlns="http://ar.gov.afip.dif.FEV1/"><FECompConsultarResult/></FECompConsultarResponse>`) };
  await assert.rejects(arca.consultarComprobante("prueba", cred, 1, 11, 5, fetchFalso([vacia])), { codigo: "respuesta_rara" });
  const q = await arca.consultarComprobante("prueba", cred, 1, 11, 5, fetchFalso([consultado(5)]));
  assert.equal(q.cae, "76470000000009");
  assert.equal(q.total, 100000);
  assert.equal(q.servicioDesde, "2026-11-30");
  assert.equal(q.condicionIva, 5);
  assert.equal(arca.coincide(q, facturaC()), true);
});

test("coincide: cualquier dato distinto hace que no sea «la nuestra»", async () => {
  const consultar = async (cambios) =>
    arca.consultarComprobante("prueba", cred, 1, 11, 5, fetchFalso([consultado(5, cambios)]));
  for (const cambios of [
    { ImpTotal: 100001 }, { ImpNeto: 99999 }, { DocTipo: 96 }, { DocNro: 30123456 }, { CbteFch: "20261122" },
    { FchServDesde: "20261201", FchServHasta: "20261201" }, { FchVtoPago: "20261124" }, { Concepto: 1 },
    { CondicionIVAReceptorId: 6 }, { Resultado: "R" }, { CodAutorizacion: "" },
  ]) {
    assert.equal(arca.coincide(await consultar(cambios), facturaC()), false, JSON.stringify(cambios));
  }
});

test("puntosVenta: sin puntos de venta devuelve una lista vacía", async () => {
  const sinResultados = {
    body: sobre(
      `<FEParamGetPtosVentaResponse xmlns="http://ar.gov.afip.dif.FEV1/"><FEParamGetPtosVentaResult><Errors><Err>` +
        `<Code>602</Code><Msg>Sin Resultados</Msg></Err></Errors></FEParamGetPtosVentaResult></FEParamGetPtosVentaResponse>`,
    ),
  };
  assert.deepEqual(await arca.puntosVenta("prueba", cred, fetchFalso([sinResultados])), []);
});

// ---------------------------------------------------------------------------------------------------------------
// Emitir sin facturar dos veces
// ---------------------------------------------------------------------------------------------------------------

const emitir = (f, extra = {}) =>
  arca.emitirComprobante({
    ambiente: "prueba",
    cred,
    comprobante: facturaC(),
    antesDeEnviar: async () => {},
    fetchFn: f,
    ...extra,
  });

test("emitirComprobante: anota el número antes de mandarlo y devuelve el CAE", async () => {
  const anotados = [];
  const f = fetchFalso([ultimo(4), aprobado(5)]);
  const r = await emitir(f, { antesDeEnviar: anotar(anotados) });
  assert.equal(r.resultado, "A");
  assert.equal(r.numero, 5);
  assert.equal(r.recuperado, false);
  assert.deepEqual(anotados, [5]);
  assert.deepEqual(metodos(f), ["FECompUltimoAutorizado", "FECAESolicitar"]);
});

test("emitirComprobante: sin antesDeEnviar o con datos mal, no toca ARCA", async () => {
  const f = fetchFalso([]);
  await assert.rejects(emitir(f, { antesDeEnviar: undefined }), { codigo: "dato_invalido" });
  await assert.rejects(emitir(f, { comprobante: facturaC({ fecha: undefined }) }), { codigo: "dato_invalido" });
  assert.equal(f.pedidos.length, 0);
});

test("emitirComprobante: si otro tomó el número (10016), vuelve a pedir el último y reintenta", async () => {
  const anotados = [];
  const f = fetchFalso([ultimo(4), rechazado(5, 10016, "no es el proximo"), ultimo(5), aprobado(6)]);
  const r = await emitir(f, { antesDeEnviar: anotar(anotados) });
  assert.equal(r.resultado, "A");
  assert.equal(r.numero, 6);
  assert.deepEqual(anotados, [5, 6]);
});

test("emitirComprobante: un rechazo de otro tipo vuelve como R, sin reintentar", async () => {
  const f = fetchFalso([ultimo(4), rechazado(5, 10242, "condicion no permitida")]);
  const r = await emitir(f);
  assert.equal(r.resultado, "R");
  assert.equal(f.pedidos.length, 2);
});

test("emitirComprobante: si ARCA no contesta pero la factura quedó hecha, la recupera sin hacer otra", async () => {
  const f = fetchFalso([ultimo(4), new Error("se cortó"), consultado(5)]);
  const r = await emitir(f);
  assert.equal(r.recuperado, true);
  assert.equal(r.numero, 5);
  assert.equal(r.cae, "76470000000009");
  assert.deepEqual(metodos(f), ["FECompUltimoAutorizado", "FECAESolicitar", "FECompConsultar"]);
});

test("emitirComprobante: si ARCA no contesta y la consulta no la encuentra, NO reintenta: queda en duda", async () => {
  for (const consulta of [noExiste, new Error("tampoco contesta"), consultado(5, { ImpTotal: 777 })]) {
    const f = fetchFalso([ultimo(4), new Error("se cortó"), consulta]);
    await assert.rejects(emitir(f), (e) => {
      assert.equal(e.codigo, "incierto");
      assert.equal(e.numero, 5);
      return true;
    });
    assert.equal(f.pedidos.length, 3); // no pidió otro número ni volvió a mandar
  }
});

test("emitirComprobante: una respuesta rara al pedir el CAE también deja la duda (o la recupera)", async () => {
  const vacia = { body: "" };
  await assert.rejects(emitir(fetchFalso([ultimo(4), vacia, noExiste])), { codigo: "incierto" });
  const r = await emitir(fetchFalso([ultimo(4), vacia, consultado(5)]));
  assert.equal(r.recuperado, true);
});

test("emitirComprobante: un pendiente de hace muy poco no se toca (ARCA puede seguir procesándolo)", async () => {
  const f = fetchFalso([]);
  const ahora = new Date("2026-11-23T14:00:00Z");
  await assert.rejects(emitir(f, { pendiente: { numero: 5, desde: "2026-11-23T13:59:00Z" }, ahora }), {
    codigo: "incierto",
  });
  assert.equal(f.pedidos.length, 0);
});

test("emitirComprobante: un pendiente viejo que ARCA tiene igual se recupera sin emitir", async () => {
  const f = fetchFalso([consultado(5)]);
  const r = await emitir(f, { pendiente: { numero: 5, desde: "2026-11-23T10:00:00Z" } });
  assert.equal(r.recuperado, true);
  assert.equal(r.numero, 5);
  assert.deepEqual(metodos(f), ["FECompConsultar"]);
});

test("emitirComprobante: un pendiente con otros datos en ARCA frena para mirarlo a mano", async () => {
  await assert.rejects(emitir(fetchFalso([consultado(5, { ImpTotal: 777 })]), { pendiente: { numero: 5, desde: "2026-11-23T10:00:00Z" } }), {
    codigo: "pendiente_no_coincide",
  });
  // ARCA no lo encuentra pero ya numeró más allá: contradicción, también frena
  await assert.rejects(emitir(fetchFalso([noExiste, ultimo(5)]), { pendiente: { numero: 5, desde: "2026-11-23T10:00:00Z" } }), {
    codigo: "pendiente_no_coincide",
  });
});

test("emitirComprobante: un pendiente que nunca llegó a ARCA se emite como nuevo", async () => {
  const anotados = [];
  const f = fetchFalso([noExiste, ultimo(4), ultimo(4), aprobado(5)]);
  const r = await emitir(f, { pendiente: { numero: 5, desde: "2026-11-23T10:00:00Z" }, antesDeEnviar: anotar(anotados) });
  assert.equal(r.resultado, "A");
  assert.equal(r.numero, 5);
  assert.deepEqual(anotados, [5]);
});
