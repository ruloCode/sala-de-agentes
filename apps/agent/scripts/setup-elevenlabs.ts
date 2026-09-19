/**
 * Crea o parchea en ElevenLabs los agentes de voz de la sala.
 *
 * Idempotente y por NOMBRE: correrlo dos veces no duplica nada, parchea lo que
 * ya existe. Lee los personajes de `sala.json`, agrega a la cuenta las voces
 * que vengan de la biblioteca pública y escribe los `agent_id` de vuelta en el
 * JSON, que es la única fuente de verdad de quién vive en la sala.
 *
 * Dos clases de agente:
 *  - uno por personaje (voz propia, sus client tools),
 *  - el ELENCO: UN agente multi-voz que los interpreta a todos. Un solo
 *    cerebro = contexto total, cero solapamiento y "Iván, ¿…?" rutea solo.
 *    Es el que usa el tótem de estación.
 *
 * Uso:  pnpm setup:voz
 */

import { config } from "dotenv";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, writeFile } from "node:fs/promises";
import { castLabel, type SalaAgentConfig, type SalaConfig, type SalaVoiceOwn } from "@sala/shared";

const root = resolve(fileURLToPath(import.meta.url), "../../../..");
config({ path: resolve(root, ".env") });
// Import dinámico: así estos módulos ven el .env ya cargado.
const { OWNER } = await import("../src/owner.js");
const { SALA_PATH, readSalaConfig } = await import("../src/sala/store.js");

const API = "https://api.elevenlabs.io/v1/convai";
const KEY = process.env.ELEVENLABS_API_KEY;
// LLM que rutea la voz de cada personaje (Haiku: el balance velocidad/precisión
// que pide una conversación hablada). Override por env si cambia el enum.
const AGENT_LLM = process.env.ELEVENLABS_AGENT_LLM || "claude-haiku-4-5";

if (!KEY) {
  console.error("Falta ELEVENLABS_API_KEY en .env");
  process.exit(1);
}

const headers = { "xi-api-key": KEY, "Content-Type": "application/json" };

async function api<T>(path: string, init?: RequestInit, base = API): Promise<T> {
  const res = await fetch(`${base}${path}`, { ...init, headers });
  if (!res.ok) {
    throw new Error(`${init?.method ?? "GET"} ${path} → ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}
// Endpoints fuera de /convai (voces de la cuenta, biblioteca pública).
const XI = "https://api.elevenlabs.io/v1";


/** Una client tool: corre en el BROWSER y llama al agente local. */
interface ToolDef {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
  expects_response: boolean;
  response_timeout_secs?: number;
}

// ── Tools del TÓTEM DE ESTACIÓN (solo los personajes de la estación) ───
// Corren en el browser del tótem y llaman al agente local (/metro/*): la
// respuesta de la ruta sale del GTFS, no de la memoria del modelo. Además de
// devolver texto, pintan la tarjeta en pantalla.

const ESTACION_TOOLS: ToolDef[] = [
  {
    name: "metro_route",
    description:
      "Calcula la ruta REAL a un LUGAR de la ciudad —una estación, un barrio, un sitio cargado o una dirección— usando todo el sistema de transporte (metro, tranvía, metrocable y buses del feed): dice dónde subirse, los tramos con sus líneas y transbordos, dónde bajarse, cuántos minutos a pie quedan hasta el destino, el total y la hora estimada de llegada, y lo pinta en la pantalla. Llámala SIEMPRE antes de decir cómo llegar a algún lado: nunca respondas una ruta de memoria. Pasa el destino TAL CUAL lo dijo el viajero (\"barrio Boston\", \"calle 10 con la 43\", \"el Museo de Antioquia\"): la tool lo resuelve; no lo cambies tú por una estación. Si el viajero no dice de dónde sale, usa la estación donde está el tótem. Si la respuesta trae candidatas, repregunta con ellas.",
    parameters: {
      type: "object",
      properties: {
        from: { type: "string", description: "Origen tal como lo dijo el viajero (estación, barrio o dirección); si no lo dice, la estación del tótem" },
        to: { type: "string", description: "Destino TAL COMO lo dijo el viajero: estación, barrio, lugar o dirección. No lo traduzcas a una estación" },
      },
      required: ["to"],
    },
    expects_response: true,
    response_timeout_secs: 12,
  },
  {
    name: "metro_status",
    description:
      "Novedades del servicio reportadas hoy (demoras, cierres). Llámala antes de dar una ruta si el viajero pregunta cómo está el servicio o si algo va demorado. Si no hay novedades, dilo: no inventes retrasos.",
    parameters: { type: "object", properties: {}, required: [] },
    expects_response: true,
    response_timeout_secs: 10,
  },
  {
    name: "places_near",
    description:
      "Qué hay cerca de una estación (nombre, minutos a pie, horario publicado). Úsala SIEMPRE que pregunten qué hacer, qué visitar, dónde comer o qué queda cerca: los horarios salen de aquí y nunca de tu memoria. Si devuelve vacío, dilo con gracia y ofrece otra estación.",
    parameters: {
      type: "object",
      properties: { station: { type: "string", description: "Estación de referencia (la del tótem si no dicen otra)" } },
      required: ["station"],
    },
    expects_response: true,
    response_timeout_secs: 10,
  },
  {
    name: "events_near",
    description:
      "Qué está PASANDO en la ciudad estos días cerca de una estación (nombre, fecha, hora, sede y minutos a pie). Úsala SIEMPRE que pregunten qué hay hoy, qué plan hay, qué hacer esta semana o si hay algún evento: las fechas salen de aquí y nunca de tu memoria. Distinta de places_near, que es qué HAY (museos, comida) con su horario de apertura. Si la respuesta viene marcada como lo último leído, dilo así. Si devuelve vacío, dilo y ofrece lo que sí hay cerca con places_near.",
    parameters: {
      type: "object",
      properties: {
        station: { type: "string", description: "Estación de referencia (la del tótem si no dicen otra)" },
        when: { type: "string", description: "hoy | manana | semana; omítelo para los próximos días" },
      },
      required: ["station"],
    },
    expects_response: true,
    response_timeout_secs: 12,
  },
  {
    name: "metro_next",
    description:
      "Próximas salidas en una estación por línea y sentido, según el horario publicado. Úsala si preguntan a qué hora pasa el próximo tren. Si la respuesta dice que es horario publicado, dilo así: es horario, no predicción en vivo.",
    parameters: {
      type: "object",
      properties: { station: { type: "string", description: "Estación (la del tótem si no dicen otra)" } },
      required: ["station"],
    },
    expects_response: true,
    response_timeout_secs: 10,
  },
  {
    name: "set_language",
    description:
      "Cambia el idioma de la PANTALLA cuando el viajero pide hablar en otro idioma (español, inglés, portugués). Llámala y sigue hablando en ese idioma.",
    parameters: {
      type: "object",
      properties: { language: { type: "string", description: "Código del idioma: es, en o pt" } },
      required: ["language"],
    },
    expects_response: true,
    response_timeout_secs: 8,
  },
];


// ── Upserts genéricos (mismo flujo para ambos agentes) ──────────────────

async function upsertTools(defs: ToolDef[]): Promise<string[]> {
  const existing = await api<{ tools: { id: string; tool_config: { name: string } }[] }>("/tools");
  const byName = new Map(existing.tools.map((t) => [t.tool_config.name, t.id]));
  const ids: string[] = [];

  for (const def of defs) {
    const body = JSON.stringify({ tool_config: { type: "client", ...def } });
    const found = byName.get(def.name);
    if (found) {
      await api(`/tools/${found}`, { method: "PATCH", body });
      console.log(`  ↻ tool ${def.name} actualizado (${found})`);
      ids.push(found);
    } else {
      const created = await api<{ id: string }>("/tools", { method: "POST", body });
      console.log(`  + tool ${def.name} creado (${created.id})`);
      ids.push(created.id);
    }
  }
  return ids;
}

async function upsertAgent(name: string, conversationConfig: unknown): Promise<string> {
  const list = await api<{ agents: { agent_id: string; name: string }[] }>(
    "/agents?page_size=100",
  );
  const found = list.agents.find((a) => a.name === name);

  if (found) {
    await api(`/agents/${found.agent_id}`, {
      method: "PATCH",
      body: JSON.stringify({ name, conversation_config: conversationConfig }),
    });
    console.log(`  ↻ agente ${name} actualizado`);
    return found.agent_id;
  }
  const created = await api<{ agent_id: string }>("/agents/create", {
    method: "POST",
    body: JSON.stringify({ name, conversation_config: conversationConfig }),
  });
  console.log(`  + agente ${name} creado`);
  return created.agent_id;
}


// ── Sala de Agentes 3D ───────────────────────────────────────────────────

type SalaOwn = SalaAgentConfig & { voice: SalaVoiceOwn };

/**
 * Una voz de la biblioteca pública no se puede usar en un agente hasta que
 * está en "mis voces": si falta, se busca por nombre en /shared-voices y se
 * agrega (gratis para las que lo permiten). Con la voz ya en la cuenta no hace
 * nada, así que correr el setup dos veces no duplica.
 */
async function ensureVoice(voiceId: string, voiceName: string | undefined): Promise<void> {
  const mine = await api<{ voices: { voice_id: string; name: string }[] }>("/voices", undefined, XI);
  const have = mine.voices.find((v) => v.voice_id === voiceId);
  if (have) {
    console.log(`  · voz ${have.name} ya está en la cuenta`);
    return;
  }
  if (!voiceName) {
    throw new Error(`la voz ${voiceId} no está en la cuenta y no hay voice_name para buscarla en la biblioteca`);
  }
  const found = await api<{
    voices: { voice_id: string; public_owner_id: string; name: string; free_users_allowed: boolean }[];
  }>(`/shared-voices?search=${encodeURIComponent(voiceName)}&page_size=30`, undefined, XI);
  const v = found.voices.find((x) => x.voice_id === voiceId);
  if (!v) throw new Error(`la voz "${voiceName}" (${voiceId}) no aparece en la biblioteca`);
  await api(`/voices/add/${v.public_owner_id}/${voiceId}`, {
    method: "POST",
    body: JSON.stringify({ new_name: v.name }),
  }, XI);
  console.log(`  + voz ${v.name} agregada a la cuenta${v.free_users_allowed ? "" : " (requiere plan de pago)"}`);
}

/** Bloque común de TODOS los personajes: quién los señala, cómo hablar y la regla de no inventar. */
function salaPrompt(a: SalaOwn): string {
  const persona = a.voice.prompt.trim();
  if (a.voice.language === "en") {
    return `You are ${a.name}, one of the agents in ${OWNER}'s 3D Agent Room. Each agent owns ONE project; you own "${a.project}". ${OWNER} is pointing at you and talking to you by voice.

${persona}

Rules:
- Before commenting on the project's status, call get_project_status("${a.project}") and answer with what it returns. Never invent progress.
- Spoken answers, 1 to 3 sentences, no lists or markdown. This is a live conversation.
- If asked about something outside your project, say so in one sentence and suggest pointing at the right agent.
- If a tool takes a while, say "one moment" and continue.
- Today is {{today}}. Session context: {{session_scope}}`;
  }
  return `Eres ${a.name}, uno de los agentes de la Sala de Agentes 3D de ${OWNER}. Cada agente es dueño de UN proyecto y tú eres dueño de "${a.project}". ${OWNER} te está señalando con el brazo y te habla por voz.

${persona}

Reglas:
- Antes de opinar sobre el estado del proyecto, llama get_project_status("${a.project}") y responde con lo que devuelve. Nunca inventes avances.
- Respuestas habladas, de 1 a 3 frases, sin listas ni markdown. Es una conversación en vivo.
- Habla SOLO por ti: nunca digas lo que respondería otro agente ni pongas palabras en su boca; cada uno tiene su propia voz. Si preguntan a varios, di solo tu parte.
- Si hay una pausa larga, espera en silencio: no preguntes si siguen ahí.
- Si te piden algo que no es de tu proyecto, dilo en una frase y sugiere señalar al agente que corresponde.
- Si una tool tarda, avisa con "un momento" y sigue.
- Hoy es {{today}}. Contexto de la sesión: {{session_scope}}`;
}

function salaConfig(a: SalaOwn, toolIds: string[]): unknown {
  return {
    agent: {
      first_message: a.voice.first_message,
      language: a.voice.language,
      dynamic_variables: {
        dynamic_variable_placeholders: {
          session_scope: `${OWNER} está en la Sala de Agentes 3D.`,
          today: "Fecha no disponible.",
        },
      },
      prompt: {
        prompt: salaPrompt(a),
        llm: AGENT_LLM,
        tool_ids: toolIds,
        temperature: 0.4,
      },
    },
    tts: {
      voice_id: a.voice.voice_id,
      // Los agentes en inglés exigen flash/turbo v2 (validación del API).
      model_id: a.voice.language === "en" ? "eleven_flash_v2" : "eleven_flash_v2_5",
    },
    // Demo/conversación corta: 30 min de tope (control de costo Convai).
    conversation: { max_duration_seconds: 1800 },
    // turn_timeout LARGO a propósito: en la tertulia hay tres voces y pausas;
    // con 12 s el agente se "re-engancha" solo ("¿sigues ahí?") y pisa al que
    // está hablando. 30 es el tope que acepta el API.
    turn: { turn_timeout: 30, mode: "turn" },
  };
}

// Prefijo para reconocerlos en el panel de ElevenLabs (upsert por nombre).
const AGENT_PREFIX = process.env.SALA_AGENT_PREFIX || "Sala";
const salaAgentName = (a: SalaAgentConfig) => `${AGENT_PREFIX} · ${a.name}`;
const CAST_AGENT_NAME = `${AGENT_PREFIX} · Elenco`;
// El director interpreta a varios personajes con disciplina de etiquetas: más
// músculo que el router de voz normal (override: ELEVENLABS_CAST_LLM).
const CAST_LLM = process.env.ELEVENLABS_CAST_LLM || "claude-sonnet-4-5";

/**
 * ELENCO: UN agente multi-voz (tts.supported_voices) que interpreta a todos
 * los miembros. Un solo cerebro = contexto total y cero solapamiento; el
 * humano nombra a uno y responde ese. El prompt es el "director": reglas de
 * turno + la persona de cada miembro bajo su etiqueta <Nombre>…</Nombre>.
 */
/**
 * Reglas del TÓTEM DE ESTACIÓN. La pantalla está plantada en una estación
 * real: el viajero no dice de dónde sale, y el dato de la ruta NO puede salir
 * de la memoria del modelo. De ahí las dos reglas duras: llamar la tool antes
 * de responder una ruta, y no inventar horarios nunca.
 */
function stationRules(station: NonNullable<SalaConfig["station"]>): string {
  return `
DÓNDE ESTÁS: esta pantalla está en la estación {{station_name}} (línea {{station_line}}) y le habla a quien pasa por el andén. Si el viajero no dice de dónde sale, el origen es {{station_name}}.

REGLAS DE DATO (por encima de cualquier otra):
- Antes de decir CÓMO LLEGAR a cualquier lado, llama metro_route con el destino TAL CUAL lo dijo el viajero (un barrio, una dirección, un sitio: la tool sabe resolverlo; tú no lo cambies por una estación). Di la ruta tal como vuelve: dónde subirse, líneas, transbordos, dónde bajarse y cuántos minutos a pie quedan, sin redondear a tu gusto y sin agregar estaciones que no estén en la respuesta. Si vuelve una hora de llegada, dila; si viene marcada como horario publicado, dilo así.
- Nunca inventes horarios, tarifas ni tiempos. Los horarios de lugares salen de places_near; las horas de los trenes, de metro_next; si la respuesta dice que es horario publicado, dilo así.
- Nunca inventes eventos, fechas ni sedes. La agenda de la ciudad sale de events_near; si un evento no trae sede publicada, di el barrio y que la dirección la dan al inscribirse, en vez de nombrar un sitio. Si la respuesta viene marcada como lo último leído, dilo antes de contarla.
- Si hay una novedad del servicio (metro_status) que toca la ruta, dila ANTES de la ruta, en una frase.
- Si una tool no reconoce el lugar, repregunta con las opciones que devolvió. No adivines la estación.
- Si una tool falla o no responde, dilo en una frase ("ahora mismo no puedo consultar la ruta") y NO completes con lo que creas recordar: una ruta de memoria es exactamente el error que esta pantalla existe para no cometer.
- Si no tienes el dato, dilo con gracia y ofrece lo que sí tienes. Es mejor "no lo tengo" que un horario inventado.

CÓMO SUENAN USTEDES AQUÍ: frases de 1 a 3 oraciones, como se habla en un andén con ruido. Nada de listas ni de leer el JSON: el viajero ve la tarjeta en pantalla, ustedes cuentan lo importante. Si el viajero habla en otro idioma, llama set_language y sigue en ese idioma.
`;
}

function castPrompt(config: SalaConfig, members: SalaOwn[]): string {
  const names = members.map((m) => `${m.name} (etiqueta <${castLabel(m.name)}>)`).join(", ");
  const personas = members
    .map((m) => `### ${m.name} — voz <${castLabel(m.name)}>…</${castLabel(m.name)}>\nProyecto: ${m.project}.\n${m.voice.prompt.trim()}`)
    .join("\n\n");
  return `Eres el DIRECTOR de la Sala de Agentes 3D de ${OWNER}: interpretas a ${members.length} personajes que conversan con ${OWNER} en una tertulia a varias voces: ${names}. Cada personaje tiene su propia voz y SOLO se oye lo que va dentro de su etiqueta.

REGLAS DE TURNO (obligatorias):
- TODO lo que digas va dentro de etiquetas de personaje: <Etiqueta>texto</Etiqueta>. Nunca texto fuera de etiquetas, nunca etiquetas anidadas, nunca corchetes ni acotaciones escénicas.
- Si ${OWNER} nombra a un personaje (${members.map((m) => `"${m.name}, …"`).join(", ")}), responde SOLO ese personaje.
- Si pregunta a los dos o a nadie en particular, responde primero el más pertinente (2 frases) y el otro añade una réplica corta (1 frase) que aporte algo distinto: coincidir con matiz, discrepar con gracia, o rematar con un dato. Pueden interpelarse por su nombre.
- Máximo 3 frases por personaje por turno. Habla natural, como en una charla entre amigos, sin listas.
- Nunca un personaje habla por el otro ni resume lo que el otro "diría". Cada uno mantiene su tono, su acento y su ángulo.
- Si ${OWNER} interrumpe, cede el turno: no repitas lo que ya se dijo.
- Si hay una pausa larga, espera en silencio; no preguntes si siguen ahí.
${config.station ? stationRules(config.station) : config.topic ? `\nTEMA DE HOY: ${config.topic}.\n` : ""}
Hoy es {{today}}. Contexto de la sesión: {{session_scope}}

PERSONAJES:

${personas}`;
}

function castConfig(config: SalaConfig, members: SalaOwn[], defaultMember: SalaOwn, toolIds: string[]): unknown {
  const greeting = members
    .map((m) => `<${castLabel(m.name)}>${m.voice.first_message.trim()}</${castLabel(m.name)}>`)
    .join(" ");
  return {
    agent: {
      first_message: greeting,
      language: defaultMember.voice.language,
      dynamic_variables: {
        dynamic_variable_placeholders: {
          session_scope: config.station
            ? `Alguien se acercó al tótem de la estación ${config.station.name}.`
            : `${OWNER} está en la Sala de Agentes 3D.`,
          today: "Fecha no disponible.",
          // El nombre de la estación viaja como variable, no en el prompt: el
          // mismo agente sirve para otra estación cambiando sala.json.
          station_name: config.station?.name ?? "",
          station_line: config.station?.line ?? "",
        },
      },
      prompt: { prompt: castPrompt(config, members), llm: CAST_LLM, tool_ids: toolIds, temperature: 0.6 },
    },
    tts: {
      voice_id: defaultMember.voice.voice_id,
      model_id: defaultMember.voice.language === "en" ? "eleven_flash_v2" : "eleven_flash_v2_5",
      supported_voices: members.map((m) => ({
        label: castLabel(m.name),
        voice_id: m.voice.voice_id,
        description: `${m.name}: úsala para TODO lo que diga ${m.name}.`,
        ...(m.voice.language !== defaultMember.voice.language ? { language: m.voice.language } : {}),
      })),
    },
    conversation: {
      max_duration_seconds: 1800,
      // agent_chat_response_part: el texto de la respuesta EN STREAMING (con las
      // etiquetas de voz) mientras suena — sin él, el texto completo llega al
      // final y la sala no sabe qué personaje está hablando hasta entonces.
      client_events: [
        "audio",
        "interruption",
        "agent_response",
        "user_transcript",
        "agent_response_correction",
        "agent_tool_response",
        "agent_chat_response_part",
      ],
    },
    turn: { turn_timeout: 30, mode: "turn" },
  };
}

async function setupCast(toolIdByName: Map<string, string>): Promise<string | null> {
  const config = await readSalaConfig();
  if (!config?.cast) return null;
  const members = config.cast.members.map((k) => config.agents.find((a) => a.key === k)).filter((a): a is SalaOwn => Boolean(a && !a.voice.reuse));
  const defaultMember = members.find((m) => m.key === (config.cast!.default ?? members[0].key)) ?? members[0];
  console.log(`⚙️  Sala · Elenco (${members.map((m) => m.name).join(" + ")})…`);
  for (const m of members) await ensureVoice(m.voice.voice_id, m.voice.voice_name);
  // Con `station`, el elenco es el anfitrión de una estación: sus tools son
  // las del tótem (datos reales) además de las que pida cada personaje.
  const names = [...new Set([...members.flatMap((m) => m.voice.tools), ...(config.station ? ESTACION_TOOLS.map((t) => t.name) : [])])];
  const ids = names.map((n) => toolIdByName.get(n)).filter((x): x is string => Boolean(x));
  const agentId = await upsertAgent(CAST_AGENT_NAME, castConfig(config, members, defaultMember, ids));
  const raw = JSON.parse(await readFile(SALA_PATH, "utf8")) as { cast: Record<string, unknown> };
  raw.cast.agent_id = agentId;
  await writeFile(SALA_PATH, JSON.stringify(raw, null, 2) + "\n");
  console.log(`  ✎ cast.agent_id escrito en ${SALA_PATH}`);
  return agentId;
}

async function setupSala(toolIdByName: Map<string, string>): Promise<{ key: string; agentId: string }[]> {
  const config = await readSalaConfig();
  if (!config) {
    console.log(`\n(sin ${SALA_PATH}: no hay personajes de sala que crear)`);
    return [];
  }
  const own = config.agents.filter((a): a is SalaOwn => !a.voice.reuse && a.enabled !== false);
  const out: { key: string; agentId: string }[] = [];
  for (const a of own) {
    console.log(`⚙️  Sala · ${a.name} (${a.project})…`);
    await ensureVoice(a.voice.voice_id, a.voice.voice_name);
    const ids: string[] = [];
    for (const name of a.voice.tools) {
      const id = toolIdByName.get(name);
      if (id) ids.push(id);
      else console.warn(`  ⚠ tool desconocida "${name}" (no está en TOOLS) — se omite`);
    }
    const agentId = await upsertAgent(salaAgentName(a), salaConfig(a, ids));
    out.push({ key: a.key, agentId });
  }
  if (out.length) {
    // Escribe los agent_id DE VUELTA en el JSON (sobre el texto original, sin
    // reordenar ni perder campos que el validador no conoce).
    const raw = JSON.parse(await readFile(SALA_PATH, "utf8")) as { agents: { key: string; voice: Record<string, unknown> }[] };
    for (const { key, agentId } of out) {
      const target = raw.agents.find((x) => x.key === key);
      if (target) target.voice.agent_id = agentId;
    }
    await writeFile(SALA_PATH, JSON.stringify(raw, null, 2) + "\n");
    console.log(`  ✎ agent_id escritos en ${SALA_PATH}`);
  }
  return out;
}



// ── Main ─────────────────────────────────────────────────────────────────

console.log("⚙️  Registrando las client tools de la sala…");
const toolIdByName = new Map<string, string>();
const estacionIds = await upsertTools(ESTACION_TOOLS);
ESTACION_TOOLS.forEach((t, i) => toolIdByName.set(t.name, estacionIds[i]));

const sala = await setupSala(toolIdByName);
const castId = await setupCast(toolIdByName);

if (sala.length) {
  console.log("\nPersonajes (agent_id ya escritos en sala.json):");
  for (const { key, agentId: id } of sala) console.log(`  ${key} → ${id}`);
}
if (castId) console.log(`  cast (elenco multi-voz) → ${castId}`);
if (!sala.length && !castId) console.log("\n(sin personajes con voz propia en sala.json: nada que crear)");
