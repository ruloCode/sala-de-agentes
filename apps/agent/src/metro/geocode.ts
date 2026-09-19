import { insideNetworkArea, type CityPoint, type MetroNetwork } from "@sala/shared";
import { env } from "../env.js";

/**
 * DIRECCIONES → coordenada, con la API de Geocoding de Google Maps.
 *
 * Es la única pieza del tótem que sale de esta máquina: se manda el texto de
 * la dirección (nada más: ni quién pregunta ni desde dónde) y vuelve un
 * punto. Tres reglas:
 *  - sin key no se llama a nadie: `{ ok: false, reason: "sin-key" }` y el
 *    tótem dice que no puede resolver direcciones;
 *  - el resultado tiene que caer en la ZONA del sistema (caja de estaciones
 *    más margen); "Boston" resuelto a Massachusetts se rechaza, no se sirve;
 *  - el punto lleva `source` = Google Maps: la pantalla dice de dónde salió.
 *
 * La zona se pasa como `bounds` para sesgar la búsqueda; sale de las
 * coordenadas del GTFS, así que no hay ninguna ciudad escrita en el código.
 */

export type GeocodeResult =
  | { ok: true; point: CityPoint }
  | { ok: false; reason: "sin-key" | "sin-resultado" | "fuera-de-zona" | "error"; detail?: string };

interface GoogleGeocodeResponse {
  status: string;
  error_message?: string;
  results?: {
    formatted_address: string;
    geometry: { location: { lat: number; lng: number } };
    types?: string[];
  }[];
}

const ENDPOINT = "https://maps.googleapis.com/maps/api/geocode/json";

function boundsParam(net: MetroNetwork): string {
  let minLat = Infinity, minLon = Infinity, maxLat = -Infinity, maxLon = -Infinity;
  for (const s of net.stations.values()) {
    minLat = Math.min(minLat, s.lat); maxLat = Math.max(maxLat, s.lat);
    minLon = Math.min(minLon, s.lon); maxLon = Math.max(maxLon, s.lon);
  }
  return `${minLat},${minLon}|${maxLat},${maxLon}`;
}

/** Recorta "Cra. 43A #7-50, Medellín, Antioquia, Colombia" a lo que la gente lee: la vía y la ciudad. */
function shortAddress(formatted: string): string {
  const parts = formatted.split(",").map((p) => p.trim()).filter(Boolean);
  return parts.slice(0, 2).join(", ") || formatted;
}

export async function geocodeAddress(
  net: MetroNetwork,
  text: string,
  opts: { language?: string; fetchImpl?: typeof fetch } = {},
): Promise<GeocodeResult> {
  if (!env.GOOGLE_MAPS_API_KEY) return { ok: false, reason: "sin-key" };
  const q = text.trim();
  if (!q) return { ok: false, reason: "sin-resultado" };
  const url = new URL(ENDPOINT);
  url.searchParams.set("address", q);
  url.searchParams.set("bounds", boundsParam(net));
  url.searchParams.set("language", opts.language ?? "es");
  url.searchParams.set("key", env.GOOGLE_MAPS_API_KEY);
  const doFetch = opts.fetchImpl ?? fetch;
  let data: GoogleGeocodeResponse;
  try {
    const res = await doFetch(url, { signal: AbortSignal.timeout(6000) });
    data = (await res.json()) as GoogleGeocodeResponse;
  } catch (err) {
    return { ok: false, reason: "error", detail: err instanceof Error ? err.message : String(err) };
  }
  if (data.status === "ZERO_RESULTS") return { ok: false, reason: "sin-resultado" };
  if (data.status !== "OK" || !data.results?.length) {
    return { ok: false, reason: "error", detail: data.error_message ?? data.status };
  }
  // El primer resultado que caiga en la zona del sistema; si ninguno, fuera.
  for (const r of data.results) {
    const { lat, lng } = r.geometry.location;
    if (!insideNetworkArea(net, lat, lng)) continue;
    return {
      ok: true,
      point: { kind: "direccion", name: shortAddress(r.formatted_address), lat, lon: lng, source: "Google Maps" },
    };
  }
  return { ok: false, reason: "fuera-de-zona", detail: data.results[0].formatted_address };
}
