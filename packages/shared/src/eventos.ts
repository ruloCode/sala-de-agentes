/**
 * EVENTOS DE CIUDAD — la agenda que sí tiene fecha.
 *
 * `lugares.json` dice qué HAY cerca de una estación y a qué hora abre. Esto dice
 * qué PASA: un conversatorio el jueves, una feria el sábado. Sale de fuentes
 * públicas declaradas por el humano en `eventos.json` — aquí vive solo el
 * CONTRATO: tipos, parseo de cada fuente, husos, distancia y filtro.
 *
 * Tres reglas que este archivo existe para sostener:
 * 1. Sin fuentes configuradas no hay tarjeta. Nada se rellena con ejemplos.
 * 2. Lo que la fuente no publica queda en `null` y la pantalla lo dice. Un
 *    evento sin sede publicada NO recibe una sede plausible.
 * 3. Cuando la fuente ESCONDE la dirección (solo para inscritos), la coordenada
 *    que entrega viene corrida a propósito: se descarta. Unos minutos a pie
 *    calculados con ella se ven perfectos y son mentira.
 */

import { haversineMeters } from "./gtfs.js";
import { EstacionConfigError } from "./estacion.js";

// ── Contrato ─────────────────────────────────────────────────────────────

/** Qué clase de fuente es, y por tanto con qué parser se lee. */
export type EventSourceKind = "luma_place" | "luma_calendar";

export interface EventSource {
  kind: EventSourceKind;
  /** Identificador dentro de la plataforma (una ciudad, un calendario). */
  id: string;
  /** Cómo se cita en pantalla ("Luma · ciudad"). */
  label: string;
}

export interface EventsConfig {
  /** Zona horaria de la ciudad; null = la que ya usa el sistema de transporte. */
  timezone: string | null;
  cacheMinutes: number;
  horizonDays: number;
  walkMaxMinutes: number;
  sources: EventSource[];
}

export interface CityEvent {
  id: string;
  name: string;
  /** ISO local de la ciudad ("2026-09-28T15:30"). */
  startsAt: string;
  endsAt: string | null;
  /** Todo el día: no hay hora que mostrar, y no se inventa una. */
  allDay: boolean;
  /** Sede tal como la publica la fuente; null = no la publicó. */
  venue: string | null;
  /** Barrio o sector; es lo único que queda cuando la dirección está oculta. */
  neighborhood: string | null;
  lat: number | null;
  lon: number | null;
  url: string;
  /** Etiqueta de la fuente, para citarla en pantalla. */
  source: string;
  /** Minutos a pie desde la estación; null = sin coordenada utilizable. */
  walkMinutes: number | null;
}

// ── Validación del archivo del humano ────────────────────────────────────

function fail(msg: string): never {
  throw new EstacionConfigError(msg);
}

function str(v: unknown, where: string, max = 400): string {
  if (typeof v !== "string" || !v.trim()) fail(`${where}: texto vacío`);
  if ((v as string).length > max) fail(`${where}: más de ${max} caracteres`);
  return (v as string).trim();
}

function optStr(v: unknown, max = 400): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s || s.length > max) return null;
  return s;
}

function optNum(v: unknown, where: string, min: number, max: number, fallback: number): number {
  if (v === undefined || v === null) return fallback;
  if (!(typeof v === "number" && Number.isFinite(v) && v >= min && v <= max)) {
    fail(`${where}: número entre ${min} y ${max}`);
  }
  return v as number;
}

const SOURCE_KINDS: EventSourceKind[] = ["luma_place", "luma_calendar"];

/** Valida `eventos.json` (lista de fuentes, o el objeto completo). */
export function parseEventsConfig(raw: unknown): EventsConfig {
  const obj = (Array.isArray(raw) ? { sources: raw } : raw) as Record<string, unknown> | null;
  if (!obj || typeof obj !== "object") fail('eventos.json: debe ser una lista o { "sources": [...] }');
  const list = obj.sources ?? obj.fuentes;
  if (list === undefined) {
    return { timezone: null, cacheMinutes: 60, horizonDays: 14, walkMaxMinutes: 25, sources: [] };
  }
  if (!Array.isArray(list)) fail('eventos.json: "sources" debe ser una lista');
  const sources = list.map((item, i) => {
    const where = `eventos.json.sources[${i}]`;
    if (!item || typeof item !== "object") fail(`${where}: no es un objeto`);
    const s = item as Record<string, unknown>;
    const kind = str(s.kind ?? s.tipo, `${where}.kind`, 40);
    if (!SOURCE_KINDS.includes(kind as EventSourceKind)) {
      fail(`${where}.kind: debe ser ${SOURCE_KINDS.join(" | ")}`);
    }
    return {
      kind: kind as EventSourceKind,
      id: str(s.id, `${where}.id`, 120),
      label: str(s.label ?? s.etiqueta, `${where}.label`, 120),
    };
  });
  return {
    timezone: optStr(obj.timezone ?? obj.zona, 60),
    cacheMinutes: optNum(obj.cache_minutes ?? obj.cacheMinutes, "eventos.json.cache_minutes", 1, 1440, 60),
    horizonDays: optNum(obj.horizon_days ?? obj.horizonDays, "eventos.json.horizon_days", 1, 90, 14),
    walkMaxMinutes: optNum(obj.walk_max_minutes ?? obj.walkMaxMinutes, "eventos.json.walk_max_minutes", 1, 120, 25),
    sources,
  };
}

// ── Husos ────────────────────────────────────────────────────────────────

/**
 * Un instante UTC → ISO LOCAL de la ciudad ("2026-09-28T15:30").
 *
 * El repo compara fechas como strings a propósito (ver `activeNotices`), así que
 * lo que se guarda ya viene movido a la hora de la ciudad. Cortar el ISO con
 * `slice()` sería lo mismo que publicar la hora de Londres.
 */
export function utcToLocalIso(at: Date, timeZone: string): string {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const p = Object.fromEntries(fmt.formatToParts(at).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/** Suma días a la parte de fecha de un ISO local y devuelve el final de ese día. */
export function endOfDayAfter(nowIso: string, days: number): string {
  const day = nowIso.slice(0, 10);
  const moved = new Date(Date.parse(`${day}T00:00:00Z`) + days * 86400000);
  return `${moved.toISOString().slice(0, 10)}T23:59`;
}

// ── Distancia a pie ──────────────────────────────────────────────────────

/** 4,5 km/h a paso de ciudad, y las calles no van en línea recta: la misma
 *  convención que usa `lugares.json` para sus minutos a pie. Si algún día hay
 *  un helper de caminata compartido en el paquete, esto se unifica con él. */
const WALK_METERS_PER_MINUTE = 75;
const WALK_STREET_FACTOR = 1.35;

function walkFrom(meters: number): number {
  return Math.max(1, Math.round((meters * WALK_STREET_FACTOR) / WALK_METERS_PER_MINUTE));
}

/** Le pone minutos a pie a los eventos que tienen coordenada; los demás siguen en null. */
export function withWalkMinutes(events: CityEvent[], lat: number, lon: number): CityEvent[] {
  return events.map((e) =>
    e.lat === null || e.lon === null ? e : { ...e, walkMinutes: walkFrom(haversineMeters(lat, lon, e.lat, e.lon)) },
  );
}

// ── Filtro ───────────────────────────────────────────────────────────────

export interface EventsNearOptions {
  /** ISO local; entra como argumento para poder probarlo sin tocar el reloj. */
  nowIso: string;
  horizonDays: number;
  walkMaxMinutes: number;
}

/**
 * Lo que queda en pie: no terminado, dentro del horizonte, y o bien cerca a pie
 * o bien con barrio publicado (un evento sin ubicación utilizable NI barrio no
 * le sirve a nadie parado en un andén).
 */
export function eventsNear(events: CityEvent[], opts: EventsNearOptions): CityEvent[] {
  const until = endOfDayAfter(opts.nowIso, opts.horizonDays);
  return events
    .filter((e) => (e.endsAt ?? e.startsAt) >= opts.nowIso)
    .filter((e) => e.startsAt <= until)
    .filter((e) => (e.walkMinutes === null ? e.neighborhood !== null : e.walkMinutes <= opts.walkMaxMinutes))
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.name.localeCompare(b.name));
}

/**
 * Cuánto horizonte pide el viajero, en días a sumar a hoy. "Hoy" es CERO días
 * más: sumar uno metía lo de mañana en la respuesta a "¿qué hay hoy?".
 * Solo estrecha — nunca pasa del horizonte configurado.
 */
export function horizonForWhen(when: string | undefined, configured: number): number {
  const w = (when ?? "").trim().toLowerCase();
  if (/^(hoy|today|hoje)$/.test(w)) return 0;
  if (/^(ma[nñ]ana|tomorrow|amanh[aã])$/.test(w)) return Math.min(1, configured);
  if (/^(esta\s+)?(semana|week)$/.test(w)) return Math.min(7, configured);
  return configured;
}

/** Quita repetidos por id, conservando el primero (dos fuentes pueden traer el mismo). */
export function dedupeEvents(events: CityEvent[]): CityEvent[] {
  const seen = new Set<string>();
  return events.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)));
}

// ── Fuente: descubrimiento por ciudad ────────────────────────────────────

/** El dominio público de la plataforma; el resto de la fuente es configuración. */
const LUMA_BASE = "https://luma.com";

/**
 * El listado público de una ciudad. Trae sede y coordenada del sitio, salvo
 * cuando el anfitrión reserva la dirección para los inscritos: ahí el payload
 * marca `mode: "obfuscated"` y la coordenada está corrida a propósito.
 */
export function parseLumaDiscover(raw: unknown, sourceLabel: string, timeZone: string): CityEvent[] {
  const entries = (raw as { entries?: unknown })?.entries;
  if (!Array.isArray(entries)) {
    fail(`${sourceLabel}: la respuesta no trae "entries" (¿cambió la fuente?)`);
  }
  const out: CityEvent[] = [];
  for (const entry of entries) {
    const e = (entry as { event?: unknown })?.event as Record<string, unknown> | undefined;
    if (!e || typeof e !== "object") continue;

    const id = optStr(e.api_id, 120);
    const name = optStr(e.name, 300);
    const startRaw = optStr(e.start_at, 40);
    if (!id || !name || !startRaw) continue;
    // Un evento en línea no tiene "a cuántos minutos a pie", que es la pregunta
    // que se hace parado en un andén.
    if (optStr(e.location_type, 40) === "online") continue;

    const start = new Date(startRaw);
    if (Number.isNaN(start.getTime())) continue;
    const endRaw = optStr(e.end_at, 40);
    const end = endRaw ? new Date(endRaw) : null;

    const geo = (e.geo_address_info ?? {}) as Record<string, unknown>;
    // Dos formas de decir lo mismo; basta una para no confiar en la coordenada.
    const hidden = optStr(geo.mode, 40) === "obfuscated" || optStr(e.geo_address_visibility, 40) === "guests-only";
    const point = (geo.place_coordinate ?? e.coordinate) as Record<string, unknown> | undefined;
    const lat = !hidden && typeof point?.latitude === "number" ? (point.latitude as number) : null;
    const lon = !hidden && typeof point?.longitude === "number" ? (point.longitude as number) : null;

    const slug = optStr(e.url, 200);
    out.push({
      id,
      name,
      startsAt: utcToLocalIso(start, timeZone),
      endsAt: end && !Number.isNaN(end.getTime()) ? utcToLocalIso(end, timeZone) : null,
      allDay: false,
      venue: hidden ? null : optStr(geo.address, 200),
      neighborhood: optStr(geo.sublocality, 120) ?? optStr(geo.city, 120),
      lat,
      lon,
      url: slug ? `${LUMA_BASE}/${slug}` : `${LUMA_BASE}/event/${id}`,
      source: sourceLabel,
      walkMinutes: null,
    });
  }
  return out;
}


// ── Fuente: calendario iCalendar ─────────────────────────────────────────

/** "\n", "\," y "\;" escapados por la norma. */
function unescapeIcs(v: string): string {
  return v.replace(/\\[nN]/g, "\n").replace(/\\([,;\\])/g, "$1");
}

/** Deshace el plegado a 75 octetos: una línea que arranca con espacio continúa la anterior. */
function unfoldIcs(text: string): string[] {
  const out: string[] = [];
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && out.length) out[out.length - 1] += line.slice(1);
    else out.push(line);
  }
  return out;
}

interface IcsProp {
  name: string;
  params: Record<string, string>;
  value: string;
}

function parseIcsLine(line: string): IcsProp | null {
  const colon = line.indexOf(":");
  if (colon < 1) return null;
  const [name, ...rest] = line.slice(0, colon).split(";");
  const params: Record<string, string> = {};
  for (const p of rest) {
    const eq = p.indexOf("=");
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name: name.toUpperCase(), params, value: line.slice(colon + 1) };
}

/**
 * Una fecha de iCalendar → ISO local, o null si no se puede ubicar con certeza.
 *
 * Se aceptan tres formas: instante UTC (la que usan estos feeds), día suelto
 * (`VALUE=DATE`), y hora local CON `TZID` igual al de la ciudad. Un `TZID` de
 * otra zona se devuelve null en vez de adivinar: mover una hora sin base de
 * husos es exactamente la clase de dato inventado que este tótem no muestra.
 */
function icsDate(prop: IcsProp, timeZone: string): { iso: string; allDay: boolean } | null {
  const v = prop.value.trim();
  const utc = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(v);
  if (utc) {
    const at = new Date(`${utc[1]}-${utc[2]}-${utc[3]}T${utc[4]}:${utc[5]}:${utc[6]}Z`);
    return Number.isNaN(at.getTime()) ? null : { iso: utcToLocalIso(at, timeZone), allDay: false };
  }
  const day = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (day && prop.params.VALUE === "DATE") {
    return { iso: `${day[1]}-${day[2]}-${day[3]}T00:00`, allDay: true };
  }
  const local = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(v);
  if (local && prop.params.TZID === timeZone) {
    return { iso: `${local[1]}-${local[2]}-${local[3]}T${local[4]}:${local[5]}`, allDay: false };
  }
  return null;
}

const URL_LIKE = /^(https?:)?\/\//i;

export function parseIcs(text: string, sourceLabel: string, timeZone: string): CityEvent[] {
  if (!/BEGIN:VCALENDAR/i.test(text)) fail(`${sourceLabel}: no es un calendario iCalendar`);
  const out: CityEvent[] = [];
  let cur: IcsProp[] | null = null;

  for (const line of unfoldIcs(text)) {
    if (/^BEGIN:VEVENT\s*$/i.test(line)) {
      cur = [];
      continue;
    }
    if (/^END:VEVENT\s*$/i.test(line)) {
      if (cur) {
        const ev = icsEvent(cur, sourceLabel, timeZone);
        if (ev) out.push(ev);
      }
      cur = null;
      continue;
    }
    if (!cur) continue;
    const prop = parseIcsLine(line);
    if (prop) cur.push(prop);
  }
  return out;
}

function icsEvent(props: IcsProp[], sourceLabel: string, timeZone: string): CityEvent | null {
  const first = (name: string) => props.find((p) => p.name === name);
  // Una serie repetida se expande con reglas (BYDAY, UNTIL, EXDATE) que no
  // implementamos: mejor no listarla que listarla en la fecha equivocada.
  if (first("RRULE")) return null;

  const uid = first("UID")?.value.trim();
  const summary = first("SUMMARY");
  const dtstart = first("DTSTART");
  if (!uid || !summary || !dtstart) return null;

  const start = icsDate(dtstart, timeZone);
  if (!start) return null;
  const dtend = first("DTEND");
  const end = dtend ? icsDate(dtend, timeZone) : null;

  const id = uid.split("@")[0];
  const locationRaw = first("LOCATION")?.value.trim() ?? "";
  const location = unescapeIcs(locationRaw);
  // Estos feeds meten el enlace del evento en LOCATION: un enlace no es una sede.
  const venue = location && !URL_LIKE.test(location) ? location.slice(0, 200) : null;

  let lat: number | null = null;
  let lon: number | null = null;
  const geo = first("GEO")?.value.split(";");
  if (geo?.length === 2) {
    const a = Number(geo[0]);
    const b = Number(geo[1]);
    if (Number.isFinite(a) && Number.isFinite(b)) {
      lat = a;
      lon = b;
    }
  }

  const description = unescapeIcs(first("DESCRIPTION")?.value ?? "");
  const url =
    optStr(first("URL")?.value, 400) ??
    /https?:\/\/\S+/.exec(description)?.[0] ??
    (URL_LIKE.test(location) ? location : "");

  return {
    id,
    name: unescapeIcs(summary.value).trim().slice(0, 300),
    startsAt: start.iso,
    endsAt: end ? end.iso : null,
    allDay: start.allDay,
    venue,
    neighborhood: null,
    lat,
    lon,
    url,
    source: sourceLabel,
    walkMinutes: null,
  };
}
