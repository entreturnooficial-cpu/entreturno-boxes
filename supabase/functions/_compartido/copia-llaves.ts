// Las llaves PÚBLICAS con las que se cierran las copias de seguridad. Son públicas: con esto se puede cerrar una copia, no abrirla.
// Cada una la genera su dueño en su compu con copia/generar-llave.mjs; la privada queda con él (nunca en GitHub ni en Supabase).
// Con cualquiera de las privadas se abre la copia: conviene que haya dos, de dos personas.
// Agregar o sacar una vale desde la copia siguiente (las anteriores se abren con las llaves que había ese día).
import type { LlavePublica } from "./copia.ts";

export const LLAVES_DE_COPIA: LlavePublica[] = [
  // la de Santiago, generada el 25/11/2026
  {
    id: "santiago-aab9c821",
    spki: "MIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAy6iLVdo5Bw8Vx2g/+U3i1wKyKUlbC87RPuzSbZRB9PTGajNwR/E5LKm/iwVaFEY/PfzOiJKSAnTCu4yUp31LLJgcxe/k3e821CeNYJbNhyhjcWsRRTPL/3rPulTr+ybISneVrZdBzLbDy72NYRozhwBHSNkVJmbfrco2cI4JMLd0OlErSLWdTNqO2g4rz+5gLg5wDj4FAYSlPMiYCotEmONSluXiTHdhsUdyQhocXe7tRsR0g+kOSXzART8uULm4GJ4EvtksWCeKaKTvjWsh8+wlB2qFlkIepDxtQcOP/5dDRWALCN8UZNZB1N9kJzJj4Q10IXE0IHEMQq2EDD6x20MLOlGRgMeyLGyNLu+JjB9q0gf4kCnu6yMmQt7p7Dvmm9sHEL3QXXztdAnvmct69SEVPM9dUGQJJlCvg7/JfM70TYYLKgwpJpJ5c/Ovr4G5G1I8uT6Ghs22g522381E3ajzZUPEniXKyG4s/F0arJRoXnbGVEFYO3eQ3rjbwq8f5EmWSiBOQOeA0uSck1+mw9CQyd2131xK36a2Cn3wBpla9TJfMguTUEwBuKdtDg3qhi6FJWN+k+cns0TitipqQvX/03ROiV7sT5P+dLRxeUgj2OG4aZtGRcTD9eCN5GBX6MvuacMBBnjA72ssJpQSRLjzvZu6BH+qZ6suD5DpnNMCAwEAAQ==",
  },
];
