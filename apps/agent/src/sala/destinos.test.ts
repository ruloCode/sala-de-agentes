import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * LA CASCADA DE DESTINOS, de punta a punta, contra los archivos reales de
 * `~/.sala` (feed, barrios.json, lugares.json, sala.json). Son los casos que
 * fallaron mientras se construía, cada uno con su lección:
 *  - lo EXACTO gana a lo aproximado, sea estación, barrio o lugar;
 *  - una palabra genérica ("barrio") no identifica una estación;
 *  - un lugar parcial solo gana al barrio si lo dicho trae una palabra que el
 *    barrio no tiene ("basílica").
 * Se saltan si falta algún archivo: aquí no hay datos de ejemplo escondidos.
 */

const HOME = process.env.SALA_HOME || join(homedir(), ".sala");
const listo = ["gtfs/metro/stop_times.txt", "barrios.json", "lugares.json", "sala.json"].every((f) => existsSync(join(HOME, f)));

describe("destinos reales desde el andén", { skip: !listo && `faltan archivos en ${HOME}` }, () => {
  const kindOf = async (to: string) => {
    const { routeBetween } = await import("../metro/store.js");
    const r = await routeBetween("", to);
    assert.ok(r.ok && r.plan, `${to}: ${r.error ?? "sin plan"}${r.suggestions?.length ? ` (${r.suggestions.join(", ")})` : ""}`);
    return r.plan!;
  };

  it("un barrio se resuelve como barrio, con su fuente, y se camina desde la estación de bajada", async () => {
    const p = await kindOf("barrio Boston");
    assert.equal(p.destination.kind, "barrio");
    assert.equal(p.destination.name, "Boston");
    assert.ok(p.destination.source && /Alcald/i.test(p.destination.source), "trae la fuente del dataset");
    assert.ok(p.legs.length >= 1, "hay tramos en el sistema");
    assert.ok(p.walkEnd && p.walkEnd.minutes <= 10, "caminata final corta");
    assert.equal(p.minutes, p.rideMinutes + p.transferMinutes + p.walkMinutes, "el total suma todo");
    assert.ok(p.arrival === null || /^\d\d:\d\d$/.test(p.arrival.at), "la llegada es HH:MM o no se promete");
  });

  it("un barrio exacto gana a una parada parecida: Manrique Oriental no es la parada Manrique", async () => {
    const p = await kindOf("Manrique Oriental");
    assert.equal(p.destination.kind, "barrio");
    assert.equal(p.destination.name, "Manrique Oriental");
  });

  it("una estación exacta sigue siendo estación aunque haya barrio homónimo", async () => {
    const p = await kindOf("Poblado");
    assert.equal(p.destination.kind, "estacion");
    assert.equal(p.walkEnd, null);
  });

  it("el barrio exacto gana al lugar que lleva su nombre; el lugar gana si lo nombran", async () => {
    const barrio = await kindOf("La Candelaria");
    assert.equal(barrio.destination.kind, "barrio");
    assert.equal(barrio.legs.length, 0, "queda a pie de Parque Berrío");
    const lugar = await kindOf("la basílica de la candelaria");
    assert.equal(lugar.destination.kind, "lugar");
    assert.match(lugar.destination.name, /Bas[ií]lica/);
  });

  it("un lugar cargado se resuelve por sus palabras y camina lo que dice el archivo", async () => {
    const p = await kindOf("museo de antioquia");
    assert.equal(p.destination.kind, "lugar");
    assert.ok(p.walkEnd && p.walkEnd.minutes > 0, "la caminata sale de lugares.json");
    assert.equal(p.legs.length, 0);
  });

  it("una dirección sin servicio configurado se explica, no se adivina", async () => {
    const { routeBetween } = await import("../metro/store.js");
    const r = await routeBetween("", "calle 10 con la 43");
    if (process.env.GOOGLE_MAPS_API_KEY) {
      assert.ok(r.ok, "con key, la dirección se geocodifica");
    } else {
      assert.equal(r.ok, false);
      assert.match(r.error ?? "", /direcciones/);
    }
  });
});
