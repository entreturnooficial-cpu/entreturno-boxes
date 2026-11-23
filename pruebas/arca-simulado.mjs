// ARCA de mentira, para las pruebas y para el servidor local: contesta los pedidos que arma
// supabase/functions/_compartido/arca.ts (WSAA y WSFEv1) con la misma forma que el ARCA de verdad, y guarda los
// comprobantes en memoria. Se le pueden pedir fallas para el próximo pedido de un método:
//   arca.fallar('FECAESolicitar', 'cortar')            — no contesta (el pedido no llegó)
//   arca.fallar('FECAESolicitar', 'procesar-y-cortar') — lo procesa, pero la respuesta se pierde
//   arca.fallar('FECAESolicitar', 'rechazar', { codigo: 10015, mensaje: '...' })
import { etiqueta } from '../supabase/functions/_compartido/arca.ts';

const sobre = (cuerpo) =>
  `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">` +
  `<soap:Body>${cuerpo}</soap:Body></soap:Envelope>`;
const escapar = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const err = (codigo, mensaje) => `<Errors><Err><Code>${codigo}</Code><Msg>${escapar(mensaje)}</Msg></Err></Errors>`;
const CONDICIONES = [1, 4, 5, 6, 7, 8, 9, 10, 13, 15, 16];

export function crearArcaSimulado({ puntosDeVenta = [] } = {}) {
  const comprobantes = new Map(); // «cuit:pv:tipo:número» → lo que se mandó + CAE
  const ultimos = new Map();      // «cuit:pv:tipo» → último número
  const pedidos = [];             // los métodos que se llamaron, en orden
  const fallas = [];
  let ticket = null;
  let cae = 86471000000000;

  const leer = (xml, nombre) => {
    const v = etiqueta(xml, nombre);
    return v === null ? null : v.trim();
  };

  function loginCms() {
    if (ticket && Date.parse(ticket.vence) > Date.now()) {
      return new Response(
        `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><soapenv:Fault>` +
          `<faultcode xmlns:ns1="http://xml.apache.org/axis/">ns1:coe.alreadyAuthenticated</faultcode>` +
          `<faultstring>El CEE ya posee un TA valido para el acceso al WSN solicitado</faultstring></soapenv:Fault></soapenv:Body></soapenv:Envelope>`,
        { status: 500 },
      );
    }
    ticket = { token: `TOKEN-${pedidos.length}`, sign: 'SIGN-SIM', vence: new Date(Date.now() + 12 * 3600e3).toISOString() };
    const ta =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><loginTicketResponse version="1.0"><header>` +
      `<expirationTime>${ticket.vence}</expirationTime></header><credentials><token>${ticket.token}</token>` +
      `<sign>${ticket.sign}</sign></credentials></loginTicketResponse>`;
    return new Response(
      `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><loginCmsResponse>` +
        `<loginCmsReturn>${escapar(ta)}</loginCmsReturn></loginCmsResponse></soapenv:Body></soapenv:Envelope>`,
    );
  }

  function autenticado(xml) {
    return ticket && leer(xml, 'Token') === ticket.token && leer(xml, 'Sign') === ticket.sign;
  }

  function wsfe(metodo, xml, falla) {
    const resp = (cuerpo) => new Response(sobre(`<${metodo}Response xmlns="http://ar.gov.afip.dif.FEV1/"><${metodo}Result>${cuerpo}</${metodo}Result></${metodo}Response>`));
    if (metodo === 'FEDummy') return resp('<AppServer>OK</AppServer><DbServer>OK</DbServer><AuthServer>OK</AuthServer>');
    if (!autenticado(xml)) return resp(err(600, 'ValidacionDeToken: No validaron las credenciales'));
    const cuit = leer(xml, 'Cuit');
    if (metodo === 'FEParamGetPtosVenta') {
      if (!puntosDeVenta.length) return resp(err(602, 'Sin Resultados'));
      return resp(`<ResultGet>${puntosDeVenta.map((n) => `<PtoVenta><Nro>${n}</Nro><EmisionTipo>CAE - Monotributo</EmisionTipo><Bloqueado>N</Bloqueado><FchBaja>NULL</FchBaja></PtoVenta>`).join('')}</ResultGet>`);
    }
    if (metodo === 'FECompUltimoAutorizado') {
      const pv = leer(xml, 'PtoVta');
      const tipo = leer(xml, 'CbteTipo');
      return resp(`<PtoVta>${pv}</PtoVta><CbteTipo>${tipo}</CbteTipo><CbteNro>${ultimos.get(`${cuit}:${pv}:${tipo}`) ?? 0}</CbteNro>`);
    }
    if (metodo === 'FECompConsultar') {
      const pedido = etiqueta(xml, 'FeCompConsReq');
      const c = comprobantes.get(`${cuit}:${leer(pedido, 'PtoVta')}:${leer(pedido, 'CbteTipo')}:${leer(pedido, 'CbteNro')}`);
      if (!c) return resp(err(602, 'No existen datos en nuestros registros para los parametros ingresados.'));
      const campos = ['Concepto', 'DocTipo', 'DocNro', 'CbteDesde', 'CbteHasta', 'CbteFch', 'ImpTotal', 'ImpTotConc', 'ImpNeto',
        'ImpOpEx', 'ImpTrib', 'ImpIVA', 'FchServDesde', 'FchServHasta', 'FchVtoPago', 'MonId', 'MonCotiz', 'CondicionIVAReceptorId']
        .filter((k) => c.datos[k] !== null).map((k) => `<${k}>${c.datos[k]}</${k}>`).join('');
      return resp(`<ResultGet>${campos}${c.asociados}<Resultado>A</Resultado><CodAutorizacion>${c.cae}</CodAutorizacion>` +
        `<EmisionTipo>CAE</EmisionTipo><FchVto>${c.caeVence}</FchVto><FchProceso>20261123120000</FchProceso>` +
        `<PtoVta>${c.pv}</PtoVta><CbteTipo>${c.tipo}</CbteTipo></ResultGet>`);
    }
    if (metodo === 'FECAESolicitar') {
      const cab = etiqueta(xml, 'FeCabReq');
      const det = etiqueta(xml, 'FECAEDetRequest');
      const pv = leer(cab, 'PtoVta');
      const tipo = leer(cab, 'CbteTipo');
      const numero = Number(leer(det, 'CbteDesde'));
      const datos = Object.fromEntries(['Concepto', 'DocTipo', 'DocNro', 'CbteDesde', 'CbteHasta', 'CbteFch', 'ImpTotal', 'ImpTotConc',
        'ImpNeto', 'ImpOpEx', 'ImpTrib', 'ImpIVA', 'FchServDesde', 'FchServHasta', 'FchVtoPago', 'MonId', 'MonCotiz',
        'CondicionIVAReceptorId'].map((k) => [k, leer(det, k)]));
      const detalle = (resultado, extra) =>
        resp(`<FeCabResp><Cuit>${cuit}</Cuit><PtoVta>${pv}</PtoVta><CbteTipo>${tipo}</CbteTipo><CantReg>1</CantReg>` +
          `<Resultado>${resultado}</Resultado><Reproceso>N</Reproceso></FeCabResp><FeDetResp><FECAEDetResponse>` +
          `<Concepto>${datos.Concepto}</Concepto><DocTipo>${datos.DocTipo}</DocTipo><DocNro>${datos.DocNro}</DocNro>` +
          `<CbteDesde>${numero}</CbteDesde><CbteHasta>${numero}</CbteHasta><CbteFch>${datos.CbteFch}</CbteFch>` +
          `<Resultado>${resultado}</Resultado>${extra}</FECAEDetResponse></FeDetResp>`);
      const rechazo = (codigo, mensaje) =>
        detalle('R', `<Observaciones><Obs><Code>${codigo}</Code><Msg>${escapar(mensaje)}</Msg></Obs></Observaciones><CAE /><CAEFchVto />`);
      if (falla?.tipo === 'rechazar') return rechazo(falla.codigo ?? 10015, falla.mensaje ?? 'Rechazo de prueba');
      const clave = `${cuit}:${pv}:${tipo}`;
      if (numero !== (ultimos.get(clave) ?? 0) + 1) {
        return rechazo(10016, 'El numero o fecha del comprobante no se corresponde con el proximo a autorizar.');
      }
      if (!CONDICIONES.includes(Number(datos.CondicionIVAReceptorId))) {
        return rechazo(10242, 'El campo Condicion IVA receptor no es un valor permitido.');
      }
      cae += 13;
      const f = datos.CbteFch;
      const vence = new Date(Date.UTC(+f.slice(0, 4), +f.slice(4, 6) - 1, +f.slice(6, 8) + 10)).toISOString().slice(0, 10).replace(/-/g, '');
      const asoc = etiqueta(det, 'CbtesAsoc');
      comprobantes.set(`${clave}:${numero}`, {
        pv, tipo, datos, cae: String(cae), caeVence: vence, asociados: asoc ? `<CbtesAsoc>${asoc.replace(/ar:/g, '')}</CbtesAsoc>` : '',
      });
      ultimos.set(clave, numero);
      return detalle('A', `<CAE>${cae}</CAE><CAEFchVto>${vence}</CAEFchVto>`);
    }
    return new Response('no previsto', { status: 500 });
  }

  const fetchFn = async (url, init) => {
    const metodo = String(url).includes('LoginCms') ? 'loginCms'
      : String(init.headers.SOAPAction).replace(/^"http:\/\/ar\.gov\.afip\.dif\.FEV1\/|"$/g, '');
    pedidos.push(metodo);
    const i = fallas.findIndex((f) => f.metodo === metodo);
    const falla = i >= 0 ? fallas.splice(i, 1)[0] : null;
    if (falla?.tipo === 'cortar') throw new TypeError('fetch failed');
    const r = metodo === 'loginCms' ? loginCms() : wsfe(metodo, String(init.body), falla);
    if (falla?.tipo === 'procesar-y-cortar') throw new TypeError('fetch failed');
    return r;
  };

  return {
    fetchFn,
    pedidos,
    comprobantes,
    fallar(metodo, tipo, extra = {}) {
      fallas.push({ metodo, tipo, ...extra });
    },
    cuantos: (metodo) => pedidos.filter((p) => p === metodo).length,
  };
}
