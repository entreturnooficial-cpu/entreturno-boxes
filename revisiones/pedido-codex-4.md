# Revisión 4 — la conexión con ARCA (factura electrónica)

Sos un revisor experto en factura electrónica de Argentina (WSAA y WSFEv1 de ARCA, ex AFIP), en seguridad y en Deno/Supabase
Edge Functions. Revisá SOLO LECTURA: no cambies ningún archivo. Respondé en castellano, corto y concreto.

## Qué es esto

Sistema de alquiler de boxes de consultorios (Supabase + una página). Cada consultorio factura con SU CUIT; Entreturno tiene
UN solo certificado y cada consultorio le delega en ARCA el servicio «Facturación Electrónica» (wsfe). Las facturas son por
alquiler de boxes: concepto 2 (servicios), casi siempre Factura C (la dueña es monotributista) a profesionales que pagan
por adelantado con Mercado Pago; las devoluciones por cancelación van con Nota de Crédito C asociada.
Desde el 1/12/2026 ARCA rechaza comprobantes sin `CondicionIVAReceptorId` (RG 5616, manual WSFEv1 v4.8).

## Qué se agregó (lo que hay que revisar)

1. `supabase/functions/_compartido/arca.ts`: módulo sin dependencias que corre en Deno (Supabase Edge) y en Node 24 (pruebas,
   con «type stripping»). La firma recibe `node-forge` de afuera (en Supabase será `npm:node-forge@1.4.3`).
   - WSAA: `armarTRA`, `firmarTRA` (CMS con el contenido adentro, SHA-256, atributos firmados), `pedirTicket`,
     `ticketVigente`, `obtenerTicket` (reusa el ticket guardado; ARCA no da otro mientras el anterior vale hasta 12 h;
     maneja `coe.alreadyAuthenticated`).
   - WSFEv1: `estadoServidores` (FEDummy), `ultimoAutorizado`, `condicionesIva`, `puntosVenta`, `armarDetalle` (orden de
     campos del WSDL), `pedirCAE` (un rechazo vuelve como resultado «R», no como excepción), `consultarComprobante`
     (602 = no existe) y `emitirComprobante`, que intenta no facturar dos veces: `antesDeEnviar(numero)` para anotar el
     número en la base, `pendiente` para buscar primero un número que quedó sin respuesta, búsqueda del número si ARCA no
     contesta, y reintento si el número quedó desfasado (10016).
   - El XML se arma con texto y se lee con expresiones regulares (`etiqueta`, `etiquetas`).
2. `pruebas/arca.test.mjs`: 20 pruebas sin internet (fetch falso con respuestas armadas a mano; la firma se verifica con OpenSSL).
3. `pruebas/arca-real.mjs`: prueba contra el ambiente de PRUEBA real de ARCA. Se corrió el 23/11/2026 y salió 9 de 9: ticket,
   servidores, condiciones de IVA de la clase C, Factura C a consumidor final (turno de la semana siguiente) y otra con DNI,
   consulta de la primera, Nota de Crédito C asociada por la mitad, rechazo a propósito (10242) y número inexistente (602).

Todavía NO existe la parte de la base (tablas, cola, candado por consultorio) ni la función de Supabase que lo use: esto es
solo el módulo. Igual decí qué le tiene que exigir esa parte al que lo llame.

## Qué quiero que busques

A. **Errores contra ARCA**: campos, formatos (importes, fechas, CUIT, DocNro con DocTipo 99), reglas del concepto 2 (fechas de
   servicio y vencimiento de pago, también para la nota de crédito), cosas que ARCA rechaza o observa y el módulo no prevé,
   clase A/B (neto, IVA 21 %), y si leer Obs/Err así alcanza (¿hay errores del detalle que vengan en `Errors`?).
B. **No facturar dos veces / no perder facturas**: recorré `emitirComprobante` con cortes en cada punto (antes de mandar,
   después de mandar sin respuesta, al consultar, dos corridas a la vez para el mismo consultorio). ¿`coincide` alcanza para
   decir «esta es la nuestra»? ¿Qué tiene que guardar y bloquear la base para que sea seguro?
C. **Ticket**: carreras entre dos corridas, reloj de la máquina corrido, el margen de 10 minutos, qué pasa si se guarda mal.
D. **Seguridad**: inyección en el XML, expresiones regulares que puedan colgarse con respuestas raras, mensajes de error que
   filtren el token, la firma o la clave, tiempos de espera.
E. **Deno / Supabase Edge**: ¿corre tal cual? (`Intl` con zona horaria, `AbortSignal.timeout`, `npm:node-forge`, tipos).
F. **Pruebas que faltan** para lo anterior.

## Cómo responder

Una lista numerada. Cada punto: archivo y función, qué pasa (con un ejemplo concreto), qué tan grave (alta, media, baja) y
cómo arreglarlo en una o dos líneas. Separá lo que es un error de verdad de lo que es una sugerencia. Si algo está bien
hecho y creés que alguien podría «arreglarlo» para peor, decilo también. No más de 15 puntos.
