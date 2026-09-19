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
  API_KEY: process.env.SALA_API_KEY || process.env.HERMES_API_KEY || "",
  /** "off" apaga /sala/* y el token por clave. */
  SALA_ENABLED: (process.env.SALA_ENABLED || "").toLowerCase() !== "off",
  /** "off" apaga /metro/* (el tótem de estación). */
  ESTACION_ENABLED: (process.env.ESTACION_ENABLED || "").toLowerCase() !== "off",
  /** Nombre de esta máquina: lo usa /machines para armar la URL del QR. */
  MACHINE_NAME: process.env.MACHINE_NAME || "local",
  ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY || "",
  /** Agentes reusables por clave (`?agent=hermes` / `?agent=tutor`). */
  ELEVENLABS_AGENT_ID: process.env.NEXT_PUBLIC_ELEVENLABS_AGENT_ID || "",
  ELEVENLABS_TUTOR_AGENT_ID: process.env.NEXT_PUBLIC_ELEVENLABS_TUTOR_AGENT_ID || "",
} as const;
