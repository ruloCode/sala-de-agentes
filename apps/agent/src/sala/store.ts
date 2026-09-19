import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  castLabel,
  parseSalaConfig,
  salaAgentLanguage,
  SalaValidationError,
  type SalaAgentConfig,
  type SalaAgentPublic,
  type SalaCastPublic,
  type SalaConfig,
  type SalaStation,
} from "@sala/shared";
import { SALA_HOME } from "../home.js";
import { env } from "../env.js";

/**
 * Personajes de la Sala de Agentes 3D (~/.hermes-os/sala.json). El JSON lo
 * escribe el humano (y `pnpm setup:elevenlabs` le rellena los agent_id); el
 * agente lo lee en cada request — es un archivo chico y así editarlo se ve
 * sin reiniciar. Sin archivo → la sala está vacía y la UI lo dice con la ruta
 * exacta; JSON inválido → 500 con el motivo del validador, no una sala a medias.
 */

export const SALA_PATH: string = process.env.SALA_CONFIG_PATH || join(SALA_HOME, "sala.json");
export const SALA_PORTRAIT_DIR: string = join(SALA_HOME, "avatars", "sala");

export function portraitPath(key: string): string {
  return join(SALA_PORTRAIT_DIR, `${key}.png`);
}

/** null = no hay archivo. Lanza SalaValidationError si el JSON no cumple el contrato. */
export async function readSalaConfig(): Promise<SalaConfig | null> {
  let raw: string;
  try {
    raw = await readFile(SALA_PATH, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new SalaValidationError(`sala.json: JSON inválido (${(err as Error).message})`);
  }
  return parseSalaConfig(json);
}

/** agent_id de ElevenLabs de un personaje: del .env si reusa, del JSON si es propio. */
export function salaAgentId(agent: SalaAgentConfig): string | null {
  const v = agent.voice;
  if (v.reuse !== undefined) {
    return (v.reuse === "hermes" ? env.ELEVENLABS_AGENT_ID : env.ELEVENLABS_TUTOR_AGENT_ID) || null;
  }
  return v.agent_id ?? null;
}

/**
 * Resuelve `?agent=<key>` del token. `hint` es el mensaje para el 503: dice
 * QUÉ falta (archivo, clave o agente sin crear), porque desde el browser un
 * 503 sin motivo se confunde con "la voz está caída".
 */
export async function resolveSalaAgentId(key: string): Promise<{ agentId: string | null; hint: string }> {
  const config = await readSalaConfig();
  if (!config) return { agentId: null, hint: `No existe ${SALA_PATH} (plantilla en docs/sala.example.json)` };
  if (key === "cast") {
    if (!config.cast) return { agentId: null, hint: "sala.json no define un elenco (cast)" };
    return {
      agentId: config.cast.agent_id ?? null,
      hint: config.cast.agent_id ? "" : "El elenco aún no existe en ElevenLabs — corre pnpm setup:elevenlabs --sala",
    };
  }
  const agent = config.agents.find((a) => a.key === key);
  if (!agent) return { agentId: null, hint: `sala.json no tiene un agente con key "${key}"` };
  const agentId = salaAgentId(agent);
  if (!agentId) {
    return {
      agentId: null,
      hint: agent.voice.reuse
        ? `Falta el agente "${agent.voice.reuse}" en .env (pnpm setup:elevenlabs lo crea)`
        : `El agente "${agent.name}" aún no existe en ElevenLabs — corre pnpm setup:elevenlabs --sala`,
    };
  }
  return { agentId, hint: "" };
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

/** Elenco público (o null si sala.json no lo define). */
export async function salaCast(): Promise<SalaCastPublic | null> {
  const config = await readSalaConfig();
  if (!config?.cast) return null;
  const labels: Record<string, string> = {};
  for (const m of config.cast.members) {
    const a = config.agents.find((x) => x.key === m);
    if (a) labels[m] = castLabel(a.name);
  }
  return {
    ready: Boolean(config.cast.agent_id),
    members: config.cast.members,
    default: config.cast.default ?? config.cast.members[0],
    labels,
  };
}

/** Tema de la tertulia (sala.json.topic), o null. */
export async function salaTopic(): Promise<string | null> {
  return (await readSalaConfig())?.topic ?? null;
}

/** Estación donde está plantado el tótem (sala.json.station), o null = sala normal. */
export async function salaStation(): Promise<SalaStation | null> {
  return (await readSalaConfig())?.station ?? null;
}

/**
 * Lista pública para la escena: sin prompts ni ids de ElevenLabs. El campo
 * `project` sigue en el contrato porque cada personaje declara de qué habla,
 * pero aquí no hay vault del que sacar su estado: eso lo pone quien integre.
 */
export async function listSalaAgents(): Promise<SalaAgentPublic[]> {
  const config = await readSalaConfig();
  if (!config) return [];
  return Promise.all(
    config.agents.filter((a) => a.enabled !== false).map(async (a) => {
      return {
        key: a.key,
        name: a.name,
        project: a.project,
        project_name: null,
        project_estado: null,
        color: a.color,
        head: a.head,
        height: a.height,
        build: a.build,
        language: salaAgentLanguage(a),
        ready: salaAgentId(a) !== null,
        portrait: await exists(portraitPath(a.key)),
        reuse: a.voice.reuse ?? null,
      };
    }),
  );
}
