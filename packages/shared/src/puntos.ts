// PUNTOS DE LA CIUDAD: a dónde va la gente de verdad.
//
// Nadie va "a Bicentenario"; va al barrio Boston. El GTFS solo conoce
// estaciones, así que aquí vive lo que falta para llegar a un LUGAR: los
// barrios con su centroide (dataset oficial del municipio, en
// `~/.sala/barrios.json`), la caminata desde la estación más cercana, y el
// plan completo estación → estación → a pie. Todo puro: sin fs, sin red.
//
// Regla: una coordenada solo entra con su `source`. Sin fuente no hay punto.

import {
  haversineMeters,
  meaningfulToken,
  normalizeName,
  planRoute,
  type MetroNetwork,
  type MetroStation,
  type PlanOptions,
  type RoutePlan,
} from "./gtfs.js";
import { EstacionConfigError } from "./estacion.js";

export type PointKind = "estacion" | "barrio" | "lugar" | "direccion";

/** Un lugar con coordenada. `stationKey` solo cuando el punto ES una estación. */
export interface CityPoint {
  kind: PointKind;
  name: string;
  lat: number;
  lon: number;
  /** De dónde salió la coordenada. null solo para estaciones (salen del GTFS). */
  source: string | null;
  stationKey?: string;
}

export interface Barrio {
  name: string;
  lat: number;
  lon: number;
  source: string | null;
}

function fail(msg: string): never {
  throw new EstacionConfigError(msg);
}

/** Valida `barrios.json` (lista, o { barrios: [...] }). */
export function parseBarrios(raw: unknown): Barrio[] {
  const list = Array.isArray(raw) ? raw : (raw as { barrios?: unknown })?.barrios;
  if (list === undefined) return [];
  if (!Array.isArray(list)) fail('barrios.json: debe ser una lista o { "barrios": [...] }');
  const rootSource = typeof (raw as { source?: unknown })?.source === "string" ? ((raw as { source: string }).source as string) : null;
  return list.map((item, i) => {
    if (!item || typeof item !== "object") fail(`barrios.json[${i}]: no es un objeto`);
    const b = item as Record<string, unknown>;
    const where = `barrios.json[${i}]`;
    const name = b.name ?? b.nombre;
    if (typeof name !== "string" || !name.trim()) fail(`${where}.name: texto vacío`);
    const lat = Number(b.lat ?? b.latitud);
    const lon = Number(b.lon ?? b.lng ?? b.longitud);
    if (!(Number.isFinite(lat) && lat >= -90 && lat <= 90)) fail(`${where}.lat: latitud inválida`);
    if (!(Number.isFinite(lon) && lon >= -180 && lon <= 180)) fail(`${where}.lon: longitud inválida`);
    const source = typeof b.source === "string" && b.source.trim() ? b.source.trim() : rootSource;
    return { name: (name as string).trim(), lat, lon, source };
  });
}

// ── Nombres como los dice la gente ───────────────────────────────────────

const PLACE_PREFIX =
  /^(?:(?:en|a|hacia|hasta|para|al|del|de)\s+)?(?:el|la|los|las)?\s*(?:barrio|sector|zona|unidad|urbanizacion|comuna)\s+(?:de\s+|del\s+|la\s+|el\s+)?/;

/** "al barrio de Boston" → "boston"; "La Candelaria" → "candelaria". */
export function stripPlaceWords(text: string): string {
  let q = normalizeName(text);
  q = q.replace(PLACE_PREFIX, "").trim();
  q = q.replace(/^(?:el|la|los|las)\s+/, "").trim();
  return q;
}

export interface BarrioMatch {
  barrio: Barrio;
  /** 1 = exacto; menos = aproximado. */
  score: number;
}

/** Barrios que encajan con lo dicho, ordenados. Vacío si nada identifica un lugar. */
export function matchBarrios(barrios: Barrio[], text: string, limit = 5): BarrioMatch[] {
  const q = stripPlaceWords(text);
  if (!q) return [];
  const qTokens = q.split(" ").filter(Boolean);
  if (!qTokens.some(meaningfulToken)) return [];
  const out: BarrioMatch[] = [];
  for (const b of barrios) {
    const full = normalizeName(b.name);
    const key = stripPlaceWords(b.name);
    let score = 0;
    if (full === q || key === q) score = 1;
    else if (key.startsWith(q + " ") || key.endsWith(" " + q) || key.includes(" " + q + " ")) {
      score = 0.9 - Math.min(0.2, (key.length - q.length) / 100);
    } else if (q.startsWith(key + " ") || q.endsWith(" " + key) || q.includes(" " + key + " ")) score = 0.85;
    else {
      const kTokens = key.split(" ");
      const shared = qTokens.filter((t) => kTokens.includes(t));
      const meaningful = shared.filter(meaningfulToken).length;
      if (meaningful) score = 0.5 + 0.3 * (shared.length / new Set([...qTokens, ...kTokens]).size);
    }
    if (score >= 0.5) out.push({ barrio: b, score });
  }
  out.sort((a, b) => b.score - a.score || a.barrio.name.localeCompare(b.barrio.name));
  return out.slice(0, limit);
}

const ADDRESS_WORDS = /\b(?:calle|cl|cll|carrera|cra|cr|kr|kra|avenida|av|diagonal|dg|transversal|tv|circular|cq|autopista)\b/;

/**
 * "calle 10 con la 43", "Cra 43A #7-50": tiene número Y palabra de vía (o el
 * numeral). Un "No.1" en el nombre de un barrio no alcanza: sin vía no es
 * dirección.
 */
export function looksLikeAddress(text: string): boolean {
  const q = normalizeName(text);
  if (!/\d/.test(q)) return false;
  return ADDRESS_WORDS.test(q) || /#/.test(text);
}

// ── Caminata y cercanía ──────────────────────────────────────────────────

/** 4,5 km/h a paso de ciudad… */
export const WALK_METERS_PER_MINUTE = 75;
/** …y las calles no van en línea recta: la misma convención que `lugares.json`. */
export const WALK_STREET_FACTOR = 1.35;

export function walkMinutes(meters: number): number {
  return Math.max(1, Math.round((meters * WALK_STREET_FACTOR) / WALK_METERS_PER_MINUTE));
}

export function nearestStations(net: MetroNetwork, lat: number, lon: number, k = 3): { station: MetroStation; meters: number }[] {
  const out: { station: MetroStation; meters: number }[] = [];
  for (const s of net.stations.values()) out.push({ station: s, meters: Math.round(haversineMeters(lat, lon, s.lat, s.lon)) });
  out.sort((a, b) => a.meters - b.meters || a.station.name.localeCompare(b.station.name));
  return out.slice(0, k);
}

export interface Bounds {
  minLat: number;
  minLon: number;
  maxLat: number;
  maxLon: number;
}

/** Caja que encierra todas las estaciones: la zona que el sistema cubre. */
export function networkBounds(net: MetroNetwork): Bounds {
  let minLat = Infinity, minLon = Infinity, maxLat = -Infinity, maxLon = -Infinity;
  for (const s of net.stations.values()) {
    minLat = Math.min(minLat, s.lat); maxLat = Math.max(maxLat, s.lat);
    minLon = Math.min(minLon, s.lon); maxLon = Math.max(maxLon, s.lon);
  }
  return { minLat, minLon, maxLat, maxLon };
}

/**
 * ¿La coordenada cae en la zona del sistema (caja de estaciones más un margen)?
 * Sirve para rechazar un geocodificador que devuelva otra ciudad con el mismo
 * nombre: eso queda fuera y se dice así.
 */
export function insideNetworkArea(net: MetroNetwork, lat: number, lon: number, marginMeters = 4000): boolean {
  const b = networkBounds(net);
  const dLat = marginMeters / 111_320;
  const midLat = ((b.minLat + b.maxLat) / 2) * (Math.PI / 180);
  const dLon = marginMeters / (111_320 * Math.max(0.2, Math.cos(midLat)));
  return lat >= b.minLat - dLat && lat <= b.maxLat + dLat && lon >= b.minLon - dLon && lon <= b.maxLon + dLon;
}

export function stationPoint(station: MetroStation): CityPoint {
  return { kind: "estacion", name: station.name, lat: station.lat, lon: station.lon, source: null, stationKey: station.key };
}

// ── El plan completo: a pie + sistema + a pie ────────────────────────────

export interface WalkLeg {
  from: string;
  to: string;
  meters: number;
  minutes: number;
}

export interface PointPlan {
  origin: CityPoint;
  destination: CityPoint;
  /** Dónde se sube y dónde se baja del sistema. */
  boardAt: MetroStation;
  alightAt: MetroStation;
  walkStart: WalkLeg | null;
  walkEnd: WalkLeg | null;
  /** null = origen y destino anclan en la misma estación: solo se camina. */
  ride: RoutePlan | null;
  transfers: number;
  rideMinutes: number;
  walkMinutes: number;
  /** Total = caminatas + viaje + transbordos. */
  minutes: number;
}

export interface PointPlanOptions extends PlanOptions {
  /**
   * Cuántas estaciones cercanas se prueban por cada punto (default 6). Con 3
   * pasaba que las tres más cercanas a un barrio eran paradas de la misma
   * línea lenta y nunca se consideraba la estación de metro a 1 km: caminar
   * 6 minutos más ahorraba media hora. El planificador es barato; se prueban
   * más y gana la de menos transbordos y menos minutos totales.
   */
  anchors?: number;
  /** Caminata máxima aceptable desde/hasta una estación (default 30 min). */
  maxWalkMinutes?: number;
}

function anchorsFor(net: MetroNetwork, p: CityPoint, k: number, maxWalk: number): { station: MetroStation; meters: number }[] {
  if (p.kind === "estacion" && p.stationKey && net.stations.has(p.stationKey)) {
    return [{ station: net.stations.get(p.stationKey)!, meters: 0 }];
  }
  const near = nearestStations(net, p.lat, p.lon, k);
  const ok = near.filter((n) => walkMinutes(n.meters) <= maxWalk);
  // Si todo queda lejos, se ofrece al menos la más cercana: el viajero decide.
  return ok.length ? ok : near.slice(0, 1);
}

/**
 * Ruta entre dos PUNTOS. Se prueban las estaciones cercanas a cada uno y gana
 * la combinación con menos transbordos y luego menos minutos TOTALES, caminata
 * incluida: bajarse una parada antes y caminar 3 min le gana a un transbordo.
 * null si origen y destino son el mismo punto.
 */
export function planBetweenPoints(net: MetroNetwork, origin: CityPoint, destination: CityPoint, opts: PointPlanOptions = {}): PointPlan | null {
  const k = opts.anchors ?? 6;
  const maxWalk = opts.maxWalkMinutes ?? 30;
  if (origin.stationKey && origin.stationKey === destination.stationKey) return null;
  const starts = anchorsFor(net, origin, k, maxWalk);
  const ends = anchorsFor(net, destination, k, maxWalk);
  let best: PointPlan | null = null;
  const better = (a: PointPlan, b: PointPlan | null) => !b || a.transfers < b.transfers || (a.transfers === b.transfers && a.minutes < b.minutes);

  for (const s of starts) {
    for (const e of ends) {
      const walkStart = s.meters > 0 ? { from: origin.name, to: s.station.name, meters: s.meters, minutes: walkMinutes(s.meters) } : null;
      const walkEnd = e.meters > 0 ? { from: e.station.name, to: destination.name, meters: e.meters, minutes: walkMinutes(e.meters) } : null;
      let ride: RoutePlan | null = null;
      let candidate: PointPlan;
      if (s.station.key === e.station.key) {
        // Misma estación en las dos puntas: no hay viaje, se camina directo.
        const meters = Math.round(haversineMeters(origin.lat, origin.lon, destination.lat, destination.lon));
        const direct = { from: origin.name, to: destination.name, meters, minutes: walkMinutes(meters) };
        candidate = {
          origin, destination, boardAt: s.station, alightAt: e.station,
          walkStart: null, walkEnd: direct, ride: null,
          transfers: 0, rideMinutes: 0, walkMinutes: direct.minutes, minutes: direct.minutes,
        };
      } else {
        ride = planRoute(net, s.station.key, e.station.key, opts);
        if (!ride) continue;
        const walk = (walkStart?.minutes ?? 0) + (walkEnd?.minutes ?? 0);
        candidate = {
          origin, destination, boardAt: s.station, alightAt: e.station,
          walkStart, walkEnd, ride,
          transfers: ride.transfers, rideMinutes: ride.minutes, walkMinutes: walk, minutes: ride.minutes + walk,
        };
      }
      if (better(candidate, best)) best = candidate;
    }
  }
  return best;
}
