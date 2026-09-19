import { config } from "dotenv";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// El .env vive en la RAÍZ del monorepo, no dentro de apps/.
config({ path: resolve(fileURLToPath(import.meta.url), "../../../../.env") });

/**
 * Configuración del agente. Todo lo que cambia entre máquinas o entre
 * ciudades sale de aquí o de los archivos de `~/.sala/`; en el código no hay
 * ningún nombre propio.
 */
export const env = {
  PORT: Number(process.env.PORT || process.env.SALA_PORT || 8650),
  /** Vacío = el agente solo acepta localhost. Con clave, escucha en la LAN. */
  API_KEY: process.env.SALA_API_KEY || "",
  /** "off" apaga /sala/* y el token por clave. */
  SALA_ENABLED: (process.env.SALA_ENABLED || "").toLowerCase() !== "off",
  /** "off" apaga /metro/* (el tótem de estación). */
  ESTACION_ENABLED: (process.env.ESTACION_ENABLED || "").toLowerCase() !== "off",
  /** Nombre de esta máquina: lo usa /machines para armar la URL del QR. */
  MACHINE_NAME: process.env.MACHINE_NAME || "local",
  /**
   * Origins públicos que además de la red privada pueden llamar al agente,
   * separados por coma (`https://totem.ejemplo.com`). En producción la web va
   * por su propio proxy y esto queda vacío; sirve cuando una pantalla se abre
   * desde un dominio y llama al agente de frente.
   */
  ALLOWED_ORIGINS: (process.env.SALA_ALLOWED_ORIGINS || "")
    .split(",")
    .map((o) => o.trim().replace(/\/$/, ""))
    .filter(Boolean),
  ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY || "",
  /**
   * Geocodificación de DIRECCIONES ("calle 10 con la 43") con la API de Google
   * Maps. Solo el texto de la dirección sale de esta máquina, desde el agente;
   * la key nunca llega al navegador. Vacía = las direcciones no se resuelven y
   * el tótem lo dice. Barrios y estaciones nunca pasan por aquí.
   */
  GOOGLE_MAPS_API_KEY: process.env.GOOGLE_MAPS_API_KEY || "",
  /**
   * Agentes de ElevenLabs que ya existen fuera de este repo: un personaje
   * puede reusarlos con `voice.reuse` en vez de tener el suyo.
   */
  ELEVENLABS_AGENT_ID: process.env.NEXT_PUBLIC_ELEVENLABS_AGENT_ID || "",
  ELEVENLABS_TUTOR_AGENT_ID: process.env.NEXT_PUBLIC_ELEVENLABS_TUTOR_AGENT_ID || "",
} as const;
