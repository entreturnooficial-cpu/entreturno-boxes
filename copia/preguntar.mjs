// Pedir algo por teclado sin que se vea en la pantalla (la frase de la llave): muestra un asterisco por letra.
export function preguntarOculto(pregunta) {
  const { stdin, stdout } = process;
  if (!stdin.isTTY) throw new Error('Esto hay que correrlo en una ventana, para poder escribir la frase.');
  return new Promise((ok, no) => {
    let texto = '';
    stdout.write(pregunta);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const terminar = (fn, v) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', tecla);
      stdout.write('\n');
      fn(v);
    };
    const tecla = (t) => {
      for (const c of t) {
        if (c === '\r' || c === '\n') return terminar(ok, texto);
        if (c === '\u0003') return terminar(no, new Error('Cancelado.'));
        if (c === '\u007f' || c === '\b') {
          if (texto) { texto = [...texto].slice(0, -1).join(''); stdout.write('\b \b'); }
        } else if (c >= ' ') { texto += c; stdout.write('*'); }
      }
      return undefined;
    };
    stdin.on('data', tecla);
  });
}
