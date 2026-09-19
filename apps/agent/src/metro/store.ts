import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  activeNotices,
  EstacionConfigError,
  localClock,
  looksLikeAddress,
  matchBarrios,
  matchStations,
  meaningfulToken,
  nextDepartures,
  networkSummary,
  noticesForLines,
  normalizeName,
  parseBarrios,
  parseMetroStatus,
  parsePlaces,
  placesNear,
  planBetweenPoints,
  resolveStation,
  stationPoint,
  stationsWithPlaces,
  stripPlaceWords,
  WALK_METERS_PER_MINUTE,
  WALK_STREET_FACTOR,
  type Barrio,
  type CityPoint,
  type MetroNetwork,
  type MetroNotice,
  type PointKind,
  type PointPlan,
  type StationPlace,
  type WalkLeg,
} from "@sala/shared";
import { geocodeAddress } from "./geocode.js";
import { SALA_HOME } from "../home.js";
import { salaStation } from "../sala/store.js";
import { loadMetro, GTFS_DIR } from "./gtfs.js";

/**
 * Lo que el tótem responde, sobre datos REALES:
 *  - la ruta sale del GTFS (metro/gtfs.ts),
 *  - las novedades del servicio de `~/.hermes-os/metro-status.json` (no hay
 *    API pública de estado: lo escribe el humano),
 *  - los lugares cerca de una estación de `~/.hermes-os/lugares.json`.
 *
 * Sin archivo → lista vacía y la UI no pinta nada. Un JSON roto NO se traga en
 * silencio: se devuelve el motivo con la ruta del archivo, como sala.json.
 */

export const METRO_STATUS_PATH: string = process.env.SALA_METRO_STATUS_PATH || join(SALA_HOME, "metro-status.json");
export const PLACES_PATH: string = process.env.SALA_PLACES_PATH || join(SALA_HOME, "lugares.json");
/** Zona del sistema de transporte: la del feed (agency_timezone) o la del .env. */
export const METRO_TZ: string = process.env.SALA_METRO_TZ || process.env.TZ || "America/Bogota";

async function readJson(path: string): Promise<unknown | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new EstacionConfigError(`${path}: JSON inválido (${(err as Error).message})`);
  }
}

/** Novedades del servicio VIGENTES ahora. Sin archivo → []. */
export async function readStatus(): Promise<{ notices: MetroNotice[]; all: MetroNotice[]; path: string; exists: boolean }> {
  const raw = await readJson(METRO_STATUS_PATH);
  if (raw === null) return { notices: [], all: [], path: METRO_STATUS_PATH, exists: false };
  const all = parseMetroStatus(raw);
  const clock = localClock(new Date(), METRO_TZ);
  const nowIso = `${clock.date.slice(0, 4)}-${clock.date.slice(4, 6)}-${clock.date.slice(6, 8)}T${String(Math.floor(clock.seconds / 3600)).padStart(2, "0")}:${String(Math.floor((clock.seconds % 3600) / 60)).padStart(2, "0")}`;
  return { notices: activeNotices(all, nowIso), all, path: METRO_STATUS_PATH, exists: true };
}

/** Lugares cargados. Sin archivo → []. */
export async function readPlaces(): Promise<{ places: StationPlace[]; path: string; exists: boolean }> {
  const raw = await readJson(PLACES_PATH);
  if (raw === null) return { places: [], path: PLACES_PATH, exists: false };
  return { places: parsePlaces(raw), path: PLACES_PATH, exists: true };
}

export const BARRIOS_PATH: string = process.env.SALA_BARRIOS_PATH || join(SALA_HOME, "barrios.json");

/** Barrios con su centroide (dataset oficial del municipio). Sin archivo → []. */
export async function readBarrios(): Promise<{ barrios: Barrio[]; path: string; exists: boolean }> {
  const raw = await readJson(BARRIOS_PATH);
  if (raw === null) return { barrios: [], path: BARRIOS_PATH, exists: false };
  return { barrios: parseBarrios(raw), path: BARRIOS_PATH, exists: true };
}

export interface RoutePointPublic {
  name: string;
  kind: PointKind;
  /** De dónde salió la coordenada; null para estaciones (GTFS). */
  source: string | null;
}

export interface RouteAnswer {
  ok: boolean;
  error?: string;
  /** Candidatas cuando un nombre no se reconoce o es ambiguo (para que el agente repregunte). */
  suggestions?: string[];
  plan?: {
    /** Nombres de origen y destino REALES (lo que dijo el viajero), para la cabecera. */
    from: string;
    to: string;
    origin: RoutePointPublic;
    destination: RoutePointPublic;
    /** Estación donde se sube y donde se baja del sistema. */
    boardAt: string;
    alightAt: string;
    walkStart: WalkLeg | null;
    walkEnd: WalkLeg | null;
    /** Total = caminatas + viaje + transbordos. */
    minutes: number;
    rideMinutes: number;
    transferMinutes: number;
    walkMinutes: number;
    transfers: number;
    transferEstimated: boolean;
    /** Tramos en el sistema; vacío cuando el destino queda a pie. */
    legs: {
      line: string;
      lineName: string;
      color: string;
      kind: string;
      from: string;
      to: string;
      headsign: string | null;
      stations: string[];
      stops: number;
      minutes: number;
    }[];
    /**
     * Hora estimada de llegada (HH:MM local) = ahora + caminata + espera del
     * próximo tren + viaje + caminata. `stale` = la espera sale del horario
     * publicado de un feed vencido, no de tiempo real. null si no hay una
     * salida contra la que calcular.
     */
    arrival: { at: string; waitMinutes: number | null; stale: boolean } | null;
  };
  /** Novedades vigentes que tocan alguna línea del plan. */
  notices?: { line: string; text: string; severity: string; delayMin: number | null }[];
  /** Próximas salidas en la estación donde se sube (horario del feed). */
  next?: { line: string; headsign: string; inMinutes: number[] }[];
  /** true = el feed venció y las salidas son horario de referencia. */
  scheduleStale?: boolean;
  /** Texto de una línea para la voz. */
  say?: string;
}

function publicPoint(p: CityPoint): RoutePointPublic {
  return { name: p.name, kind: p.kind, source: p.source };
}

function publicPlan(pp: PointPlan, arrival: NonNullable<RouteAnswer["plan"]>["arrival"]): NonNullable<RouteAnswer["plan"]> {
  const ride = pp.ride;
  return {
    from: pp.origin.name,
    to: pp.destination.name,
    origin: publicPoint(pp.origin),
    destination: publicPoint(pp.destination),
    boardAt: pp.boardAt.name,
    alightAt: pp.alightAt.name,
    walkStart: pp.walkStart,
    walkEnd: pp.walkEnd,
    minutes: pp.minutes,
    rideMinutes: ride?.rideMinutes ?? 0,
    transferMinutes: ride?.transferMinutes ?? 0,
    walkMinutes: pp.walkMinutes,
    transfers: pp.transfers,
    transferEstimated: ride?.transferEstimated ?? false,
    legs: (ride?.legs ?? []).map((l) => ({
      line: l.lineShort,
      lineName: l.lineName,
      color: l.color,
      kind: l.kind,
      from: l.fromName,
      to: l.toName,
      headsign: l.headsign,
      stations: l.stations,
      stops: l.stopsCount,
      minutes: l.minutes,
    })),
    arrival,
  };
}

/** Frase corta para la voz: la ruta como la diría alguien en el andén, caminata incluida. */
export function sayPlan(pp: PointPlan): string {
  const dest = pp.destination.name;
  if (!pp.ride) {
    const desde = pp.origin.kind === "estacion" ? "aquí" : pp.origin.name;
    return `${dest} te queda a ${pp.walkEnd?.minutes ?? pp.minutes} minutos a pie desde ${desde}: no hace falta tomar nada.`;
  }
  const legs = pp.ride.legs.map((l) => `la ${l.lineName}${l.headsign ? ` sentido ${l.headsign}` : ""} hasta ${l.toName}`);
  const chain = legs.length === 1 ? `Toma ${legs[0]}` : `Toma ${legs[0]}, ahí cambias a ${legs.slice(1).join(", y luego a ")}`;
  const start = pp.walkStart ? `Camina ${pp.walkStart.minutes} minutos hasta ${pp.walkStart.to}. ` : "";
  const end = pp.walkEnd ? `, y ${dest} te queda a ${pp.walkEnd.minutes} minutos a pie desde ${pp.alightAt.name}` : "";
  const tr = pp.transfers === 0 ? "sin transbordos" : pp.transfers === 1 ? "un transbordo" : `${pp.transfers} transbordos`;
  return `${start}${chain}${end}. Son ${pp.minutes} minutos en total y ${tr}.`;
}

// ── Resolver a dónde va la gente ─────────────────────────────────────────

interface ResolveContext {
  barrios: Barrio[];
  places: StationPlace[];
  language: string;
}

type Resolved =
  | { ok: true; point: CityPoint; lugar?: StationPlace }
  | { ok: false; error: string; suggestions: string[] };

/**
 * Un lugar de lugares.json por nombre ("Museo de Antioquia"). `exact` = el
 * nombre completo, o el lugar entero dentro de lo dicho ("al museo de
 * antioquia por favor"); `loose` = lo dicho dentro del nombre del lugar
 * ("candelaria" en "Basílica de … la Candelaria"), que solo vale cuando
 * ningún barrio se llama así de verdad.
 */
function findPlace(places: StationPlace[], text: string, mode: "exact" | "loose"): StationPlace | null {
  const q = stripPlaceWords(text);
  if (q.length < 4) return null;
  const qMeaningful = q.split(" ").filter(meaningfulToken);
  const hits = places.filter((p) => {
    const k = normalizeName(p.name);
    if (k === q || (q.length >= 5 && q.includes(k))) return true;
    if (mode !== "loose" || !qMeaningful.length) return false;
    // "basílica de la candelaria" ⊂ "Basílica de Nuestra Señora de la Candelaria":
    // todas las palabras que identifican, sin exigir que vayan seguidas.
    const kTokens = new Set(k.split(" "));
    return qMeaningful.every((tk) => kTokens.has(tk));
  });
  hits.sort((a, b) => a.name.length - b.name.length);
  return hits[0] ?? null;
}

async function geocodeOrExplain(net: MetroNetwork, q: string, language: string): Promise<Resolved> {
  const geo = await geocodeAddress(net, q, { language });
  if (geo.ok) return { ok: true, point: geo.point };
  const why =
    geo.reason === "sin-key"
      ? "esta pantalla no tiene configurado el servicio de direcciones"
      : geo.reason === "fuera-de-zona"
        ? `queda fuera de la zona que cubre el sistema${geo.detail ? ` (${geo.detail})` : ""}`
        : geo.reason === "sin-resultado"
          ? "no encuentro esa dirección"
          : "el servicio de direcciones no respondió";
  return { ok: false, error: `No puedo ubicar "${q}": ${why}`, suggestions: [] };
}

/**
 * De lo que dijo el viajero a un PUNTO con coordenada, en cascada y sin
 * adivinar: dirección → geocodificador; si no, estación → lugar cargado →
 * barrio; si hay varios parecidos se repregunta; y como último recurso el
 * geocodificador, que solo vale si cae en la zona del sistema.
 */
async function resolvePoint(net: MetroNetwork, ctx: ResolveContext, text: string): Promise<Resolved> {
  const q = text.trim();
  if (!q) return { ok: false, error: "falta el lugar", suggestions: [] };
  if (looksLikeAddress(q)) return geocodeOrExplain(net, q, ctx.language);

  const st = matchStations(net, q, 4);
  const bm = matchBarrios(ctx.barrios, q, 4);
  const asPlace = (lugar: StationPlace): Resolved | null => {
    const s = resolveStation(net, lugar.station);
    // Anclado a su estación: la caminata la dice el archivo, no la geometría.
    return s ? { ok: true, point: { kind: "lugar", name: lugar.name, lat: s.station.lat, lon: s.station.lon, source: lugar.source }, lugar } : null;
  };

  // 1. Lo EXACTO, del tipo que sea: estación, barrio, lugar. "Manrique
  //    Oriental" es un barrio aunque exista la parada "Manrique".
  if (st.length && st[0].score === 1) return { ok: true, point: stationPoint(st[0].station) };
  if (bm.length && bm[0].score === 1) return { ok: true, point: { kind: "barrio", ...bm[0].barrio } };
  const exactPlace = findPlace(ctx.places, q, "exact");
  if (exactPlace) {
    const r = asPlace(exactPlace);
    if (r) return r;
  }

  // 2. Lo aproximado, con reglas. Estación muy parecida primero.
  if (st.length && st[0].score >= 0.85) return { ok: true, point: stationPoint(st[0].station) };

  // Un lugar cuyo nombre contiene todo lo dicho ("basílica de la candelaria" →
  // la basílica) gana al barrio aproximado SOLO si lo dicho trae una palabra
  // que el barrio no tiene: "basílica" decide, "candelaria" no.
  const loosePlace = findPlace(ctx.places, q, "loose");
  if (loosePlace) {
    const barrioTokens = new Set(bm.length ? normalizeName(bm[0].barrio.name).split(" ") : []);
    const decide = q.split(" ").some((tk) => meaningfulToken(tk) && !barrioTokens.has(tk));
    if (!bm.length || decide) {
      const r = asPlace(loosePlace);
      if (r) return r;
    }
  }
  const unambiguous = bm.length > 0 && bm[0].score >= 0.85 && (bm.length === 1 || bm[0].score - bm[1].score >= 0.05);
  if (unambiguous) return { ok: true, point: { kind: "barrio", ...bm[0].barrio } };

  const suggestions = [...new Set([...bm.map((m) => m.barrio.name), ...st.map((m) => m.station.name)])].slice(0, 5);
  if (bm.length > 1 || (bm.length === 1 && bm[0].score >= 0.5)) {
    return { ok: false, error: `Hay varios lugares parecidos a "${q}"`, suggestions };
  }

  const geo = await geocodeAddress(net, q, { language: ctx.language });
  if (geo.ok) return { ok: true, point: geo.point };
  return {
    ok: false,
    error: `No reconozco "${q}"`,
    suggestions: suggestions.length ? suggestions : networkSummary(net).stations.slice(0, 6).map((s) => s.name),
  };
}

function hhmm(secondsOfDay: number): string {
  const s = ((Math.round(secondsOfDay) % 86400) + 86400) % 86400;
  return `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}`;
}

/**
 * Ruta entre dos LUGARES dichos en lenguaje natural: estación, barrio, lugar
 * cargado o dirección. Nunca inventa: si no reconoce un nombre, devuelve
 * candidatas. Sin origen (el caso normal en el tótem: el viajero solo dice a
 * dónde va) el origen es la estación donde está plantada la pantalla.
 */
export async function routeBetween(fromText: string, toText: string): Promise<RouteAnswer> {
  const loaded = await loadMetro();
  if (!loaded) return { ok: false, error: `No hay datos del sistema en ${GTFS_DIR}` };
  const { net } = loaded;
  const station = await salaStation().catch(() => null);
  const [{ barrios }, { places }] = await Promise.all([readBarrios(), readPlaces()]);
  const ctx: ResolveContext = { barrios, places, language: (station?.default_language ?? "es").slice(0, 2) };

  let origin: CityPoint;
  if (!fromText.trim()) {
    if (!station) return { ok: false, error: "falta el origen y esta pantalla no tiene estación configurada" };
    const s = resolveStation(net, station.name);
    if (!s) return { ok: false, error: `la estación configurada "${station.name}" no está en el feed` };
    origin = stationPoint(s.station);
  } else {
    const r = await resolvePoint(net, ctx, fromText);
    if (!r.ok) return { ok: false, error: r.error, suggestions: r.suggestions };
    origin = r.point;
  }
  const d = await resolvePoint(net, ctx, toText);
  if (!d.ok) return { ok: false, error: d.error, suggestions: d.suggestions };
  const destination = d.point;

  if (destination.kind === "estacion" && origin.stationKey && origin.stationKey === destination.stationKey) {
    return { ok: false, error: `${origin.name} es el mismo punto de origen y destino` };
  }
  const pp = planBetweenPoints(net, origin, destination);
  if (!pp) return { ok: false, error: `No hay ruta entre ${origin.name} y ${destination.name}` };

  // Un lugar cargado trae sus propios minutos a pie desde la estación (medidos
  // por el humano); mandan sobre la geometría de la línea recta.
  if (d.lugar && d.lugar.walkMinutes > 0) {
    pp.walkEnd = {
      from: pp.alightAt.name,
      to: d.lugar.name,
      meters: Math.round((d.lugar.walkMinutes * WALK_METERS_PER_MINUTE) / WALK_STREET_FACTOR),
      minutes: d.lugar.walkMinutes,
    };
    pp.walkMinutes = (pp.walkStart?.minutes ?? 0) + pp.walkEnd.minutes;
    pp.minutes = (pp.ride?.minutes ?? 0) + pp.walkMinutes;
  }

  const status = await readStatus().catch(() => ({ notices: [] as MetroNotice[] }));
  const notices = noticesForLines(status.notices, pp.ride?.legs.map((l) => l.lineShort) ?? []);
  const clock = localClock(new Date(), METRO_TZ);

  let next: NonNullable<RouteAnswer["next"]> = [];
  let stale = false;
  let wait: number | null = null;
  if (pp.ride) {
    const dep = nextDepartures(net, pp.boardAt.key, clock, { limit: 3 });
    stale = dep?.stale ?? false;
    const firstLine = pp.ride.legs[0].line;
    next = (dep?.departures ?? []).filter((x) => x.line === firstLine).map((x) => ({ line: x.lineShort, headsign: x.headsign, inMinutes: x.inMinutes }));
    // La espera se cuenta desde que se LLEGA al andén: si hay que caminar
    // antes, la primera salida que sirve es la que sale después de esa caminata.
    const lead = pp.walkStart?.minutes ?? 0;
    const usable = next.flatMap((x) => x.inMinutes).filter((m) => m >= lead).sort((a, b) => a - b);
    wait = usable.length ? usable[0] - lead : null;
  }
  // Sin una salida contra la que calcular no se promete una hora.
  const arrival =
    pp.ride && wait === null
      ? null
      : {
          at: hhmm(clock.seconds + ((pp.walkStart?.minutes ?? 0) + (wait ?? 0) + (pp.ride?.minutes ?? 0) + (pp.walkEnd?.minutes ?? 0)) * 60),
          waitMinutes: wait,
          stale,
        };

  return {
    ok: true,
    plan: publicPlan(pp, arrival),
    notices: notices.map((n) => ({ line: n.line, text: n.text, severity: n.severity, delayMin: n.delayMin })),
    next,
    scheduleStale: stale,
    say: sayPlan(pp),
  };
}

/** Lista de estaciones y líneas (para la UI y para que el agente sepa qué existe). */
export async function stationList(): Promise<{
  ok: boolean;
  error?: string;
  stations?: { key: string; name: string; lines: string[] }[];
  lines?: { id: string; short: string; name: string; color: string; kind: string; stations: string[] }[];
  feed?: { start: string | null; end: string | null };
  aliases?: string[];
}> {
  const loaded = await loadMetro();
  if (!loaded) return { ok: false, error: `No hay datos del sistema en ${GTFS_DIR}` };
  const s = networkSummary(loaded.net);
  return { ok: true, ...s, aliases: [...loaded.net.aliases.keys()].sort() };
}

/** Próximas salidas en una estación (horario del feed; `stale` si el feed venció). */
export async function departuresAt(stationText: string): Promise<{
  ok: boolean;
  error?: string;
  suggestions?: string[];
  station?: string;
  stale?: boolean;
  feedEnd?: string | null;
  departures?: { line: string; lineName: string; color: string; headsign: string; inMinutes: number[] }[];
}> {
  const loaded = await loadMetro();
  if (!loaded) return { ok: false, error: `No hay datos del sistema en ${GTFS_DIR}` };
  const m = resolveStation(loaded.net, stationText);
  if (!m) {
    return { ok: false, error: `No reconozco la estación "${stationText}"`, suggestions: matchStations(loaded.net, stationText, 4).map((x) => x.station.name) };
  }
  const clock = localClock(new Date(), METRO_TZ);
  const r = nextDepartures(loaded.net, m.station.key, clock, { limit: 2 });
  return {
    ok: true,
    station: m.station.name,
    stale: r?.stale ?? false,
    feedEnd: r?.feedEnd ?? null,
    departures: (r?.departures ?? []).map((d) => ({ line: d.lineShort, lineName: d.lineName, color: d.color, headsign: d.headsign, inMinutes: d.inMinutes })),
  };
}

/** Lugares cerca de una estación. Sin archivo o sin coincidencias → lista vacía. */
export async function placesAt(stationText: string): Promise<{
  ok: boolean;
  error?: string;
  station?: string;
  places: StationPlace[];
  /** Estaciones que sí tienen lugares cargados (para que el agente lo diga). */
  available: string[];
  configured: boolean;
  path: string;
}> {
  const { places, path, exists } = await readPlaces();
  const available = stationsWithPlaces(places);
  if (!exists) return { ok: true, places: [], available, configured: false, path };
  let name = stationText.trim();
  const loaded = await loadMetro().catch(() => null);
  if (loaded) {
    const m = resolveStation(loaded.net, name);
    if (m) name = m.station.name;
  }
  // El nombre del archivo puede diferir del nombre del feed: se prueban los dos.
  const found = placesNear(places, name);
  const byRaw = found.length ? found : placesNear(places, stationText);
  return { ok: true, station: name, places: byRaw, available, configured: true, path };
}
