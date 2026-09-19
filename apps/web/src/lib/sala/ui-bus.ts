// Lo que una client tool descubrió, para que la PANTALLA lo pinte.
//
// El modelo de voz decide qué decir; la tarjeta de la ruta no puede depender
// de que su texto venga bien formado. Así que cada tool emite aquí el payload
// ESTRUCTURADO que le devolvió el agente local, y la vista se suscribe. Bus
// mínimo en memoria (sin dependencias, sin React): las tools son un mapa plano
// que vive fuera del árbol de componentes.

/** Un tramo a pie: desde/hasta un lugar o una estación, con metros y minutos. */
export interface UiWalkLeg {
  from: string;
  to: string;
  meters: number;
  minutes: number;
}

/** De dónde sale y a dónde llega DE VERDAD el viajero (barrio, dirección, lugar o estación). */
export interface UiRoutePoint {
  name: string;
  kind: "estacion" | "barrio" | "lugar" | "direccion" | string;
  /** De dónde salió la coordenada; null para estaciones (GTFS). */
  source: string | null;
}

export interface UiRoutePlan {
  from: string;
  to: string;
  /** Total: caminatas + viaje + transbordos. */
  minutes: number;
  rideMinutes: number;
  transferMinutes: number;
  transfers: number;
  transferEstimated: boolean;
  origin?: UiRoutePoint;
  destination?: UiRoutePoint;
  /** Estación donde se sube y donde se baja. */
  boardAt?: string;
  alightAt?: string;
  walkStart?: UiWalkLeg | null;
  walkEnd?: UiWalkLeg | null;
  walkMinutes?: number;
  /** Hora estimada de llegada (HH:MM local); `stale` = calculada sobre horario publicado. */
  arrival?: { at: string; waitMinutes: number | null; stale: boolean } | null;
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
}

export interface UiNotice {
  line: string;
  text: string;
  severity: string;
  delayMin: number | null;
}

export interface UiPlace {
  name: string;
  station: string;
  walkMinutes: number;
  hours: string | null;
  note: string | null;
  source: string | null;
  url: string | null;
  category: string | null;
}

/** Un evento de la agenda. Lo que la fuente no publica viaja en null y se dice. */
export interface UiCityEvent {
  id: string;
  name: string;
  /** ISO local de la ciudad ("2026-09-28T15:30"). */
  startsAt: string;
  endsAt: string | null;
  allDay: boolean;
  venue: string | null;
  neighborhood: string | null;
  url: string;
  source: string;
  walkMinutes: number | null;
}

export type UiEvent =
  | { kind: "route"; plan: UiRoutePlan; notices: UiNotice[]; next: { line: string; headsign: string; inMinutes: number[] }[]; scheduleStale: boolean }
  | { kind: "route_failed"; query: string; error: string; suggestions: string[] }
  | { kind: "places"; station: string; places: UiPlace[] }
  | { kind: "events"; station: string; events: UiCityEvent[]; stale: boolean }
  | { kind: "status"; notices: UiNotice[] }
  | { kind: "language"; language: string }
  | { kind: "clear" };

type Listener = (ev: UiEvent) => void;

const listeners = new Set<Listener>();

export function onUiEvent(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emitUiEvent(ev: UiEvent): void {
  for (const fn of [...listeners]) {
    try {
      fn(ev);
    } catch {
      /* un suscriptor roto no tumba a los demás */
    }
  }
}
