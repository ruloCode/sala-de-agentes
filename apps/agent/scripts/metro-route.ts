/**
 * Imprime la ruta entre dos estaciones con los datos REALES del GTFS
 * (`~/.hermes-os/gtfs/metro/`): tramos, línea, color, paradas y minutos.
 *
 *   pnpm ruta "Parque Berrío" "Parque Arví"
 *   pnpm ruta --next "Parque Berrío"   (próximas salidas)
 *   pnpm ruta --stations               (toda la red)
 */
import { config } from "dotenv";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { localClock, nextDepartures, resolveStation, networkSummary } from "@sala/shared";

const root = resolve(fileURLToPath(import.meta.url), "../../../..");
config({ path: resolve(root, ".env") });
const { loadMetro, GTFS_DIR } = await import("../src/metro/gtfs.js");

const args = process.argv.slice(2);
const loaded = await loadMetro();
if (!loaded) {
  console.error(`No hay GTFS en ${GTFS_DIR} (ver README.md → Datos del transporte)`);
  process.exit(1);
}
const { net, buildMs } = loaded;
console.log(`GTFS: ${loaded.dir} · ${net.stations.size} estaciones · ${net.lines.size} líneas · vigencia ${net.feed.start ?? "?"}–${net.feed.end ?? "?"} · red en ${buildMs} ms\n`);

if (args[0] === "--stations") {
  for (const s of networkSummary(net).stations) console.log(`${s.name.padEnd(34)} ${s.lines.join(" ")}`);
  process.exit(0);
}

if (args[0] === "--next") {
  const m = resolveStation(net, args.slice(1).join(" "));
  if (!m) {
    console.error("Estación no encontrada");
    process.exit(1);
  }
  const tz = process.env.SALA_METRO_TZ || process.env.TZ || "America/Bogota";
  const clock = localClock(new Date(), tz);
  const r = nextDepartures(net, m.station.key, clock, { limit: 3 });
  console.log(`${m.station.name} · ${clock.date} ${Math.floor(clock.seconds / 3600)}:${String(Math.floor((clock.seconds % 3600) / 60)).padStart(2, "0")} (${tz}) · servicios ${r?.services.join(",")}${r?.stale ? ` · HORARIO DE REFERENCIA (feed vence ${r.feedEnd})` : ""}`);
  for (const d of r?.departures ?? []) console.log(`  ${d.lineName} → ${d.headsign}: ${d.inMinutes.map((x) => `${x} min`).join(", ")}`);
  process.exit(0);
}

const [fromText, toText] = args;
if (!fromText || !toText) {
  console.error('Uso: metro-route.ts "<origen>" "<destino>"   (estación, barrio, lugar o dirección)');
  process.exit(1);
}
// La MISMA cascada que usa el tótem (estación → lugar → barrio → dirección),
// para que lo que se ve en la terminal sea lo que oye el viajero.
const { routeBetween } = await import("../src/metro/store.js");
const r = await routeBetween(fromText, toText);
if (!r.ok || !r.plan) {
  console.error(r.error ?? "sin ruta");
  if (r.suggestions?.length) console.error(`¿Quizás? ${r.suggestions.join(" · ")}`);
  process.exit(1);
}
const p = r.plan;
const desc = (x: { name: string; kind: string; source: string | null }) => `${x.name}${x.kind === "estacion" ? "" : ` (${x.kind}${x.source ? `, fuente: ${x.source.slice(0, 60)}${x.source.length > 60 ? "…" : ""}` : ""})`}`;
console.log(`${desc(p.origin)} → ${desc(p.destination)}`);
console.log(
  `${p.minutes} min en total (${p.rideMinutes} en el sistema + ${p.transferMinutes} de transbordo${p.transferEstimated ? ", estimado" : ""} + ${p.walkMinutes} a pie) · ${p.transfers} transbordos` +
    (p.arrival ? ` · llegas ≈ ${p.arrival.at}${p.arrival.waitMinutes !== null ? ` (espera ${p.arrival.waitMinutes} min)` : ""}${p.arrival.stale ? " · HORARIO PUBLICADO, no tiempo real" : ""}` : "") +
    "\n",
);
if (p.walkStart) console.log(`  ${"a pie".padEnd(18)}          ${p.walkStart.from} → ${p.walkStart.to} · ${p.walkStart.minutes} min (${p.walkStart.meters} m)`);
for (const leg of p.legs) {
  console.log(`  ${leg.lineName.padEnd(18)} ${leg.color}  ${leg.from} → ${leg.to}${leg.headsign ? `  (sentido ${leg.headsign})` : ""}`);
  console.log(`  ${"".padEnd(18)} ${leg.stops} ${leg.stops === 1 ? "parada" : "paradas"} · ${leg.minutes} min · ${leg.stations.join(" · ")}`);
}
if (p.walkEnd) console.log(`  ${"a pie".padEnd(18)}          ${p.walkEnd.from} → ${p.walkEnd.to} · ${p.walkEnd.minutes} min (${p.walkEnd.meters} m)`);
if (r.notices?.length) console.log(`\nAvisos: ${r.notices.map((n) => `${n.line ? `${n.line}: ` : ""}${n.text}`).join(" · ")}`);
console.log(`\nHablado: ${r.say}`);
