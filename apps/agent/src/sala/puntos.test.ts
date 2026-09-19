import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  buildNetwork,
  EstacionConfigError,
  insideNetworkArea,
  looksLikeAddress,
  matchBarrios,
  nearestStations,
  parseBarrios,
  planBetweenPoints,
  resolveStation,
  stationPoint,
  stripPlaceWords,
  walkMinutes,
  type Barrio,
  type CityPoint,
  type GtfsFiles,
} from "@sala/shared";

/**
 * PUNTOS DE LA CIUDAD: llegar a un lugar, no a una estación. Contratos sobre
 * una red sintética de dos líneas y, si el feed y los barrios reales están en
 * ~/.sala, la prueba que motivó todo esto: del andén de Parque Berrío al
 * barrio Boston se va en A + tranvía hasta Bicentenario y se camina el resto.
 */

// Red sintética:  Línea A: Norte — Centro — Sur     Línea B: Centro — Este — Fin
function synthetic(): GtfsFiles {
  const stops = [
    "stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station",
    "N,Norte,6.3000,-75.5600,,",
    "C,Centro,6.2500,-75.5600,,",
    "S,Sur,6.2000,-75.5600,,",
    "E,Este,6.2500,-75.5000,,",
    "F,Fin,6.2500,-75.4500,,",
  ].join("\n");
  const routes = ["route_id,route_short_name,route_long_name,route_type,route_color", "LA,A,Línea A,2,0960A7", "LB,T-B,Tranvía B,0,00933E"].join("\n");
  const trips = ["route_id,service_id,trip_id,trip_headsign,direction_id", "LA,D,A1,Sur,0", "LA,D,A2,Norte,1", "LB,D,B1,Fin,0", "LB,D,B2,Centro,1"].join("\n");
  const st = (trip: string, seq: number, stop: string, t: string) => `${trip},${t},${t},${stop},${seq}`;
  const stop_times = [
    "trip_id,arrival_time,departure_time,stop_id,stop_sequence",
    st("A1", 1, "N", "05:00:00"), st("A1", 2, "C", "05:03:00"), st("A1", 3, "S", "05:06:00"),
    st("A2", 1, "S", "05:00:00"), st("A2", 2, "C", "05:03:00"), st("A2", 3, "N", "05:06:00"),
    st("B1", 1, "C", "05:00:00"), st("B1", 2, "E", "05:04:00"), st("B1", 3, "F", "05:08:00"),
    st("B2", 1, "F", "05:00:00"), st("B2", 2, "E", "05:04:00"), st("B2", 3, "C", "05:08:00"),
  ].join("\n");
  const calendar = ["service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date", "D,1,1,1,1,1,1,1,20250101,20991231"].join("\n");
  return { stops, routes, trips, stop_times, calendar };
}

const BARRIOS: Barrio[] = [
  { name: "Boston", lat: 6.2477, lon: -75.5588, source: "municipio" },
  { name: "La Candelaria", lat: 6.2495, lon: -75.5665, source: "municipio" },
  { name: "Barrio Colombia", lat: 6.2205, lon: -75.5745, source: "municipio" },
  { name: "Manrique Central No.1", lat: 6.266, lon: -75.5572, source: "municipio" },
  { name: "Manrique Oriental", lat: 6.2685, lon: -75.5535, source: "municipio" },
];

describe("barrios.json", () => {
  it("valida nombre y coordenadas, acepta lista o { barrios }, hereda la fuente de la raíz", () => {
    const b = parseBarrios({ source: "dataset oficial", barrios: [{ nombre: "Boston", lat: 6.24, lon: -75.55 }] });
    assert.deepEqual(b, [{ name: "Boston", lat: 6.24, lon: -75.55, source: "dataset oficial" }]);
    assert.equal(parseBarrios([{ name: "X", lat: 1, lon: 2, source: "s" }])[0].source, "s");
    assert.deepEqual(parseBarrios({}), []);
    assert.throws(() => parseBarrios([{ name: "Sin coordenada", lat: 6.2 }]), EstacionConfigError);
    assert.throws(() => parseBarrios([{ name: "", lat: 6.2, lon: -75.5 }]), EstacionConfigError);
    assert.throws(() => parseBarrios([{ name: "Marte", lat: 120, lon: -75.5 }]), EstacionConfigError);
  });
});

describe("nombres de barrios como los dice la gente", () => {
  it("quita 'barrio', artículos y preposiciones", () => {
    assert.equal(stripPlaceWords("al barrio de Boston"), "boston");
    assert.equal(stripPlaceWords("La Candelaria"), "candelaria");
    assert.equal(stripPlaceWords("el sector de la Candelaria"), "candelaria");
    assert.equal(stripPlaceWords("Bostón"), "boston");
  });

  it("encuentra el barrio exacto aunque se diga con 'barrio', con tilde o sin artículo", () => {
    assert.equal(matchBarrios(BARRIOS, "barrio Boston")[0].barrio.name, "Boston");
    assert.equal(matchBarrios(BARRIOS, "Bostón")[0].score, 1);
    assert.equal(matchBarrios(BARRIOS, "la candelaria")[0].barrio.name, "La Candelaria");
    assert.equal(matchBarrios(BARRIOS, "Candelaria")[0].score, 1);
    assert.equal(matchBarrios(BARRIOS, "Colombia")[0].barrio.name, "Barrio Colombia");
  });

  it("varias candidatas cuando el nombre es de varios barrios; ninguna con solo palabras genéricas", () => {
    const m = matchBarrios(BARRIOS, "Manrique");
    assert.deepEqual(m.map((x) => x.barrio.name).sort(), ["Manrique Central No.1", "Manrique Oriental"]);
    assert.ok(m.every((x) => x.score < 1), "ninguna es exacta");
    assert.deepEqual(matchBarrios(BARRIOS, "el barrio"), []);
    assert.deepEqual(matchBarrios(BARRIOS, "el aeropuerto"), []);
  });

  it("reconoce una dirección: número más palabra de vía", () => {
    assert.equal(looksLikeAddress("calle 10 con la 43"), true);
    assert.equal(looksLikeAddress("Cra 43A #7-50"), true);
    assert.equal(looksLikeAddress("carrera 70"), true);
    assert.equal(looksLikeAddress("Boston"), false);
    assert.equal(looksLikeAddress("Parque Berrío"), false);
    assert.equal(looksLikeAddress("Manrique Central No.1"), false, "el 'No.1' de un barrio no es una dirección");
  });
});

describe("caminata y cercanía", () => {
  const net = buildNetwork(synthetic());

  it("minutos a pie: 4,5 km/h con factor de calle 1,35; mínimo 1", () => {
    assert.equal(walkMinutes(350), 6);
    assert.equal(walkMinutes(1000), 18);
    assert.equal(walkMinutes(10), 1);
  });

  it("estaciones más cercanas a una coordenada, ordenadas", () => {
    const near = nearestStations(net, 6.253, -75.501, 2);
    assert.deepEqual(near.map((n) => n.station.name), ["Este", "Fin"]);
    assert.ok(near[0].meters > 300 && near[0].meters < 400, `Este a ~350 m: ${near[0].meters}`);
  });

  it("zona del sistema: dentro con margen, fuera si es otra ciudad", () => {
    assert.equal(insideNetworkArea(net, 6.253, -75.501), true);
    assert.equal(insideNetworkArea(net, 6.31, -75.56), true, "1 km fuera de la caja, dentro del margen");
    assert.equal(insideNetworkArea(net, 42.36, -71.05), false, "un Boston en otro continente");
  });
});

describe("planBetweenPoints", () => {
  const net = buildNetwork(synthetic());
  const norte = stationPoint(net.stations.get("norte")!);

  it("de una estación a un barrio: viaje hasta la estación más cercana y el resto a pie", () => {
    const barrio: CityPoint = { kind: "barrio", name: "Boston", lat: 6.253, lon: -75.501, source: "municipio" };
    const plan = planBetweenPoints(net, norte, barrio);
    assert.ok(plan, "hay plan");
    assert.equal(plan.boardAt.name, "Norte");
    assert.equal(plan.alightAt.name, "Este");
    assert.equal(plan.walkStart, null, "se sale desde el andén: no hay caminata inicial");
    assert.equal(plan.walkEnd?.to, "Boston");
    assert.equal(plan.walkEnd?.minutes, 6);
    assert.deepEqual(plan.ride!.legs.map((l) => l.lineShort), ["A", "T-B"]);
    assert.equal(plan.transfers, 1);
    assert.equal(plan.minutes, plan.rideMinutes + 6, "el total incluye la caminata");
    assert.equal(plan.destination.name, "Boston");
    assert.equal(plan.origin.kind, "estacion");
  });

  it("si el barrio queda al lado de la estación de origen, no hay viaje: solo se camina", () => {
    const alLado: CityPoint = { kind: "barrio", name: "Vecino", lat: 6.301, lon: -75.56, source: "municipio" };
    const plan = planBetweenPoints(net, norte, alLado);
    assert.ok(plan);
    assert.equal(plan.ride, null);
    assert.equal(plan.transfers, 0);
    assert.equal(plan.walkEnd?.minutes, 2);
    assert.equal(plan.minutes, 2);
  });

  it("de un punto a otro punto: caminata en las dos puntas; a una estación, ninguna al final", () => {
    const cercaNorte: CityPoint = { kind: "direccion", name: "Calle 1 # 2-3", lat: 6.301, lon: -75.56, source: "geocodificador" };
    const sur = stationPoint(net.stations.get("sur")!);
    const plan = planBetweenPoints(net, cercaNorte, sur)!;
    assert.equal(plan.walkStart?.to, "Norte");
    assert.equal(plan.walkEnd, null);
    assert.deepEqual(plan.ride!.legs.map((l) => l.lineShort), ["A"]);
  });

  it("mismo punto en las dos puntas → null", () => {
    assert.equal(planBetweenPoints(net, norte, norte), null);
  });
});

const HOME = process.env.SALA_HOME || join(homedir(), ".sala");
const REAL_DIR = join(HOME, "gtfs", "metro");
const BARRIOS_PATH = join(HOME, "barrios.json");
const hasReal = existsSync(join(REAL_DIR, "stop_times.txt")) && existsSync(BARRIOS_PATH);

describe("feed y barrios reales", { skip: !hasReal && `faltan ${REAL_DIR} o ${BARRIOS_PATH}` }, () => {
  const read = (n: string) => readFileSync(join(REAL_DIR, `${n}.txt`), "utf8");
  const optional = (n: string) => (existsSync(join(REAL_DIR, `${n}.txt`)) ? read(n) : undefined);
  const net = buildNetwork({
    stops: read("stops"), routes: read("routes"), trips: read("trips"), stop_times: read("stop_times"),
    transfers: optional("transfers"), calendar: optional("calendar"), calendar_dates: optional("calendar_dates"),
  });
  const barrios = parseBarrios(JSON.parse(readFileSync(BARRIOS_PATH, "utf8")));

  it("del andén de Parque Berrío al barrio Boston: A + tranvía, bajarse en Ayacucho y menos de 10 min a pie", () => {
    const boston = matchBarrios(barrios, "barrio Boston")[0];
    assert.ok(boston && boston.score === 1, "Boston está en el dataset");
    const origen = stationPoint(resolveStation(net, "Parque Berrío")!.station);
    const plan = planBetweenPoints(net, origen, { kind: "barrio", ...boston.barrio })!;
    assert.deepEqual(plan.ride!.legs.map((l) => l.lineShort), ["A", "T-A"]);
    // Bicentenario (419 m) y Pabellón de las Aguas (428 m) quedan a la misma
    // caminata; gana la que llega antes. El contrato es "una parada del
    // tranvía a menos de 10 min a pie", no un nombre fijo.
    assert.ok(["Bicentenario", "Pabellón de las Aguas"].includes(plan.alightAt.name), `se baja en Ayacucho: ${plan.alightAt.name}`);
    assert.ok(plan.walkEnd!.minutes <= 10, `caminata corta: ${plan.walkEnd!.minutes} min`);
    assert.equal(plan.transfers, 1);
    assert.equal(plan.minutes, plan.ride!.minutes + plan.walkEnd!.minutes, "el total suma la caminata");
  });

  it("La Candelaria queda a pie de Parque Berrío: sin viaje", () => {
    const cand = matchBarrios(barrios, "La Candelaria")[0];
    const origen = stationPoint(resolveStation(net, "Parque Berrío")!.station);
    const plan = planBetweenPoints(net, origen, { kind: "barrio", ...cand.barrio })!;
    assert.equal(plan.ride, null);
    assert.ok(plan.walkEnd!.minutes <= 6);
  });
});
