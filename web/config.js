/* Entreturno · Boxes — a qué servidor se conecta la página (el proyecto «entreturno» de Supabase, región San Pablo).
   Estos dos datos son públicos por diseño: la clave «publishable» solo deja llamar a las funciones que la base le abre
   a la página, y cada función revisa quién llama. La clave secreta del proyecto NO va acá ni en ningún archivo.
   El consultorio sale de la dirección (puntoalmagro.entreturno.com.ar → «puntoalmagro»); en las direcciones que no son de Entreturno
   (la de prueba de Cloudflare) es el que se agregue acá con  slug: "…"  */
window.ENTRETURNO = {
  url: "https://mgnzmjeyhzxzlyrgxotp.supabase.co",
  key: "sb_publishable_PNwQdSP14ko56JU5xjv38Q_DEfyp4x7",
};
