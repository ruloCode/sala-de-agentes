import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  dedupeEvents,
  EstacionConfigError,
  eventsNear,
  horizonForWhen,
  localClock,
  parseEventsConfig,
  parseIcs,
  parseLumaDiscover,
  resolveStation,
  withWalkMinutes,
  type CityEvent,
  type EventSource,
  type EventsConfig,
} from "@sala/shared";
import { SALA_HOME } from "../home.js";
import { loadMetro } from "./gtfs.js";
import { METRO_TZ } from "./store.js";

/**
 * AGENDA DE CIUDAD — lo único del tótem que sale de la red y no de un archivo
 * del humano. Lo que el humano escribe es de DÓNDE sacarla (`eventos.json`).
 *
 * La caché en disco no es una optimización: una sesión de voz hace varias
 * preguntas seguidas y golpear la fuente en cada turno sería maltratarla. De
 * ahí las cuatro salidas posibles, y que la tercera exista:
 *   caché fresca            → se sirve.
 *   caché vencida + red ok  → se refresca.
 *   caché vencida + red mal → se sirve la vieja marcada `stale`, y la voz dice
 *                             que es lo último que alcanzó a leer.
 *   sin caché    + red mal  → ok:false con el motivo. La pantalla no pinta nada.
 */

export const EVENTS_PATH: string = process.env.SALA_EVENTS_PATH || join(SALA_HOME, "eventos.json");
export const EVENTS_CACHE_PATH: string = process.env.SALA_EVENTS_CACHE || join(SALA_HOME, "cache", "eventos.json");

/** Cuánto esperamos a una fuente antes de seguir sin ella. */
const FETCH_TIMEOUT_MS = 8000;

interface CacheFile {
  fetchedAt: number;
  events: CityEvent[];
}

async function readConfig(): Promise<{ config: EventsConfig | null; path: string }> {
  let raw: string;
  try {
    raw = await readFile(EVENTS_PATH, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { config: null, path: EVENTS_PATH };
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new EstacionConfigError(`${EVENTS_PATH}: JSON inválido (${(err as Error).message})`);
  }
  return { config: parseEventsConfig(parsed), path: EVENTS_PATH };
}

async function fetchText(url: string): Promise<string> {
  // Sin `cache: "no-store"`: ese campo no existe en el RequestInit de Node.
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${res.status}`);
  return await res.text();
}

const LUMA_API = "https://api.lu.ma";

/** Una fuente → sus eventos. El parseo (y por tanto el contrato) vive en shared. */
async function fetchSource(source: EventSource, timeZone: string): Promise<CityEvent[]> {
  if (source.kind === "luma_place") {
    const url = `${LUMA_API}/discover/get-paginated-events?discover_place_api_id=${encodeURIComponent(source.id)}&pagination_limit=50`;
    return parseLumaDiscover(JSON.parse(await fetchText(url)), source.label, timeZone);
  }
  const url = `${LUMA_API}/ics/get?entity=calendar&id=${encodeURIComponent(source.id)}`;
  return parseIcs(await fetchText(url), source.label, timeZone);
}

/**
 * Todas las fuentes en paralelo. Una que falle NO tumba a las demás: se
 * devuelve lo que sí llegó junto con el motivo de lo que no, para poder
 * decirlo en vez de disimularlo.
 */
async function fetchAll(config: EventsConfig, timeZone: string): Promise<{ events: CityEvent[]; failures: string[] }> {
  const results = await Promise.allSettled(config.sources.map((s) => fetchSource(s, timeZone)));
  const events: CityEvent[] = [];
  const failures: string[] = [];
  results.forEach((r, i) => {
    const label = config.sources[i].label;
    if (r.status === "fulfilled") events.push(...r.value);
    else failures.push(`${label}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
  });
  return { events: dedupeEvents(events), failures };
}

async function readCache(): Promise<CacheFile | null> {
  try {
    const raw = JSON.parse(await readFile(EVENTS_CACHE_PATH, "utf8")) as CacheFile;
    return Array.isArray(raw?.events) && typeof raw.fetchedAt === "number" ? raw : null;
  } catch {
    // Una caché ilegible es como no tenerla: se vuelve a la fuente.
    return null;
  }
}

async function writeCache(file: CacheFile): Promise<void> {
  try {
    await mkdir(dirname(EVENTS_CACHE_PATH), { recursive: true });
    await writeFile(EVENTS_CACHE_PATH, JSON.stringify(file, null, 2) + "\n");
  } catch {
    // Sin poder escribir la caché el tótem sigue sirviendo; solo irá a la red más seguido.
  }
}

export interface EventsLoad {
  events: CityEvent[];
  /** Los datos son los últimos que se alcanzaron a leer, no los de ahora. */
  stale: boolean;
  failures: string[];
}

/** Eventos de todas las fuentes, con caché. `now` entra como argumento para poder probarlo. */
export async function loadEvents(config: EventsConfig, timeZone: string, now = Date.now()): Promise<EventsLoad> {
  const cached = await readCache();
  const ttl = config.cacheMinutes * 60000;
  if (cached && now - cached.fetchedAt < ttl) return { events: cached.events, stale: false, failures: [] };

  const { events, failures } = await fetchAll(config, timeZone);
  if (events.length || failures.length < config.sources.length) {
    await writeCache({ fetchedAt: now, events });
    return { events, stale: false, failures };
  }
  // Ninguna fuente respondió. Si hay algo viejo, se sirve DICIENDO que es viejo.
  if (cached) return { events: cached.events, stale: true, failures };
  throw new EstacionConfigError(`no pude leer ninguna fuente de eventos (${failures.join("; ")})`);
}

export interface EventsAnswer {
  ok: boolean;
  error?: string;
  station?: string;
  /** La estación se reconoció contra el GTFS. Sin eso no hay "cerca" que valga. */
  resolved: boolean;
  events: CityEvent[];
  stale: boolean;
  configured: boolean;
  horizonDays: number;
  failures: string[];
  path: string;
}

/**
 * Qué está pasando cerca de una estación. Los minutos a pie se calculan contra
 * las coordenadas de la estación en el GTFS; un evento sin coordenada utilizable
 * se queda sin minutos en vez de recibir una estimación.
 */
export async function eventsAt(stationText: string, when?: string): Promise<EventsAnswer> {
  const { config, path } = await readConfig();
  const horizonDays = horizonForWhen(when, config?.horizonDays ?? 14);
  const base = { resolved: false, events: [] as CityEvent[], stale: false, configured: false, horizonDays, failures: [], path };
  if (!config || !config.sources.length) return { ok: true, ...base };

  // Primero la estación: sin un punto de referencia REAL no hay "cerca", y una
  // lista de toda la ciudad contestada a "¿qué hay cerca?" se lee como si todo
  // quedara al lado. Antes de salir a la red, entonces.
  const loaded = await loadMetro().catch(() => null);
  if (!loaded) {
    return { ok: false, error: "no tengo el mapa del sistema para ubicar la estación", ...base, configured: true };
  }
  const match = resolveStation(loaded.net, stationText.trim());
  if (!match) {
    return { ok: true, station: stationText.trim(), ...base, configured: true };
  }
  const station = match.station;

  const timeZone = config.timezone ?? METRO_TZ;
  const { events, stale, failures } = await loadEvents(config, timeZone);
  const located = withWalkMinutes(events, station.lat, station.lon);
  const name = station.name;

  const clock = localClock(new Date(), timeZone);
  const nowIso = `${clock.date.slice(0, 4)}-${clock.date.slice(4, 6)}-${clock.date.slice(6, 8)}T${String(Math.floor(clock.seconds / 3600)).padStart(2, "0")}:${String(Math.floor((clock.seconds % 3600) / 60)).padStart(2, "0")}`;
  const near = eventsNear(located, { nowIso, horizonDays, walkMaxMinutes: config.walkMaxMinutes });

  return { ok: true, station: name, resolved: true, events: near, stale, configured: true, horizonDays, failures, path };
}
