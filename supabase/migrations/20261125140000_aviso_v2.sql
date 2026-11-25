-- =====================================================================================================
-- Entreturno · Boxes — aviso de datos personales, versión 2: nombra la copia de seguridad
-- =====================================================================================================
-- Lo único que cambia respecto de la versión 1: que hay una copia de seguridad diaria, cifrada, que la guarda GitHub en Estados
-- Unidos, y que ahí los datos quedan hasta 30 días más. La versión 1 no se toca: es la que aceptó quien la aceptó.
-- Quien ya había aceptado la 1 tiene que aceptar esta la próxima vez que entra (y mientras tanto no puede reservar).
-- =====================================================================================================
do $aviso$
declare
  v_texto text;
  v_cambios constant text[][] := array[
    ['Es la versión 1, del 25 de noviembre de 2026.',
     'Es la versión 2, del 25 de noviembre de 2026.'],
    ['Cloudflare (publica la página y cuenta las visitas) y Resend (manda los mails).',
     'Cloudflare (publica la página y cuenta las visitas), Resend (manda los mails) y GitHub (guarda la copia de seguridad de cada día, cifrada: no la puede leer).'],
    ['La base de datos está en servidores de San Pablo, Brasil, y algunos de esos servicios también procesan datos en Estados Unidos.',
     'La base de datos está en servidores de San Pablo, Brasil. La copia de seguridad se guarda, cifrada, en Estados Unidos, donde también procesan datos algunos de esos servicios.'],
    ['También se conserva la constancia de que aceptaste este aviso: qué versión y cuándo.',
     'En las copias de seguridad quedan hasta 30 días más, y después se borran solas. También se conserva la constancia de que aceptaste este aviso: qué versión y cuándo.']];
  i integer;
begin
  select texto into strict v_texto from interno.privacidad where version = 1;
  for i in 1 .. array_length(v_cambios, 1) loop
    -- cada frase tiene que estar, y una sola vez: si no, mejor no cargar un texto a medias
    if (length(v_texto) - length(replace(v_texto, v_cambios[i][1], ''))) <> length(v_cambios[i][1]) then
      raise exception 'no está (o está repetida) esta frase del aviso: %', v_cambios[i][1];
    end if;
    v_texto := replace(v_texto, v_cambios[i][1], v_cambios[i][2]);
  end loop;
  insert into interno.privacidad (version, texto) values (2, v_texto);
end $aviso$;
