import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  dedupeEvents,
  endOfDayAfter,
  EstacionConfigError,
  eventsNear,
  haversineMeters,
  horizonForWhen,
  parseEventsConfig,
  parseIcs,
  parseLumaDiscover,
  utcToLocalIso,
  withWalkMinutes,
  type CityEvent,
} from "@sala/shared";

/**
 * La agenda de ciudad que lee el tótem. Lo que se prueba es lo que evita
 * prometer un plan que no existe: una fuente que cambió de forma se rechaza con
 * el motivo, un evento que esconde su dirección NO recibe minutos a pie
 * calculados con la coordenada corrida que entrega, una serie repetida se omite
 * en vez de listarse en la fecha equivocada, y la hora que se muestra es la de
 * la ciudad y no la del instante UTC.
 */

const TZ = "America/Bogota";

// Recorte fiel del listado público de una ciudad: el primero reserva la
// dirección para los inscritos, el segundo la publica, el tercero es en línea.
const DISCOVER = {
  entries: [
    {
      event: {
        api_id: "evt-oculto",
        name: "Taller con cupo",
        start_at: "2026-09-19T13:00:00.000Z",
        end_at: "2026-09-19T17:00:00.000Z",
        location_type: "offline",
        url: "taller-cupo",
        geo_address_visibility: "guests-only",
        geo_address_info: { mode: "obfuscated", city: "Medellín", sublocality: "La Aguacatala" },
        coordinate: { latitude: 6.198211332388345, longitude: -75.57855971625807 },
      },
    },
    {
      event: {
        api_id: "evt-abierto",
        name: "Conversatorio de aves",
        start_at: "2026-09-28T20:30:00.000Z",
        end_at: null,
        location_type: "offline",
        url: "aves-clima",
        geo_address_info: {
          mode: "shown",
          address: "Jardín Botánico",
          sublocality: "Sevilla",
          city: "Medellín",
          place_coordinate: { latitude: 6.2707, longitude: -75.5647 },
        },
        coordinate: { latitude: 6.2701, longitude: -75.5641 },
      },
    },
    {
      event: {
        api_id: "evt-en-linea",
        name: "Charla remota",
        start_at: "2026-09-25T15:00:00.000Z",
        location_type: "online",
        url: "charla-remota",
        geo_address_info: {},
      },
    },
  ],
};

describe("parseLumaDiscover", () => {
  const events = parseLumaDiscover(DISCOVER, "Fuente de ciudad", TZ);

  it("un evento que esconde la dirección pierde sede Y coordenada, pero conserva el barrio", () => {
    const oculto = events.find((e) => e.id === "evt-oculto")!;
    assert.equal(oculto.venue, null, "sin dirección publicada no se inventa una sede");
    // La coordenada que entrega la fuente en este modo viene corrida a
    // propósito: unos minutos a pie sacados de ahí se ven bien y son mentira.
    assert.equal(oculto.lat, null);
    assert.equal(oculto.lon, null);
    assert.equal(oculto.neighborhood, "La Aguacatala", "el barrio sí es dato publicado");
  });

  it("un evento con dirección publicada usa la coordenada de la SEDE, no la del evento", () => {
    const abierto = events.find((e) => e.id === "evt-abierto")!;
    assert.equal(abierto.venue, "Jardín Botánico");
    assert.equal(abierto.lat, 6.2707, "place_coordinate manda sobre coordinate");
    assert.equal(abierto.lon, -75.5647);
    assert.equal(abierto.url, "https://luma.com/aves-clima");
    assert.equal(abierto.endsAt, null, "sin hora de cierre publicada, null");
  });

  it("muestra la hora de la ciudad, no la del instante UTC", () => {
    assert.equal(events.find((e) => e.id === "evt-oculto")!.startsAt, "2026-09-19T08:00");
    assert.equal(events.find((e) => e.id === "evt-abierto")!.startsAt, "2026-09-28T15:30");
  });

  it("deja fuera lo que es en línea (en un andén, 'a cuántos minutos' es la pregunta)", () => {
    assert.deepEqual(events.map((e) => e.id), ["evt-oculto", "evt-abierto"]);
  });

  it("si la fuente cambia de forma se dice, en vez de devolver una lista vacía", () => {
    assert.throws(() => parseLumaDiscover({}, "Fuente de ciudad", TZ), EstacionConfigError);
    assert.throws(() => parseLumaDiscover({ entries: {} }, "Fuente de ciudad", TZ), /Fuente de ciudad/);
    assert.deepEqual(parseLumaDiscover({ entries: [] }, "x", TZ), [], "vacío sí es una respuesta válida");
  });
});

describe("utcToLocalIso", () => {
  it("cruza el día hacia atrás cuando toca (el error que un slice() no delata)", () => {
    assert.equal(utcToLocalIso(new Date("2026-01-01T02:00:00Z"), TZ), "2025-12-31T21:00");
    assert.equal(utcToLocalIso(new Date("2026-01-01T02:00:00Z"), "UTC"), "2026-01-01T02:00");
  });

  it("la medianoche local se escribe 00:00 y no 24:00", () => {
    assert.equal(utcToLocalIso(new Date("2026-06-15T05:00:00Z"), TZ), "2026-06-15T00:00");
  });
});

describe("parseIcs", () => {
  // Plegado a la mitad de una palabra, LOCATION con un enlace en vez de una
  // sede, una serie repetida, un día suelto y una fecha en otra zona.
  const ICS = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "BEGIN:VEVENT",
    "UID:evt-uno@events.example",
    "SUMMARY:Encuentro de barrio",
    "DESCRIPTION:Más información en: https://luma.com/abc123\\n\\nDirección:\\nRevisa",
    " la página del evento.",
    "DTSTART:20260920T053000Z",
    "DTEND:20260920T090000Z",
    "LOCATION:https://luma.com/event/evt-uno",
    "GEO:6.2518;-75.5636",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:evt-dos@events.example",
    "SUMMARY:Feria\\, con coma escapada",
    "DTSTART;VALUE=DATE:20260922",
    "LOCATION:Plaza principal",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:evt-serie@events.example",
    "SUMMARY:Club de lectura semanal",
    "DTSTART:20260921T230000Z",
    "RRULE:FREQ=WEEKLY;BYDAY=MO",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:evt-otra-zona@events.example",
    "SUMMARY:Reunión en otra ciudad",
    "DTSTART;TZID=Europe/Madrid:20260923T190000",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  const events = parseIcs(ICS, "Calendario", TZ);

  it("desdobla las líneas plegadas y saca el enlace de la descripción", () => {
    const uno = events.find((e) => e.id === "evt-uno")!;
    assert.equal(uno.url, "https://luma.com/abc123");
    assert.equal(uno.startsAt, "2026-09-20T00:30", "05:30 UTC son las 00:30 en la ciudad");
    assert.equal(uno.endsAt, "2026-09-20T04:00");
  });

  it("un enlace en LOCATION no es una sede", () => {
    assert.equal(events.find((e) => e.id === "evt-uno")!.venue, null);
    assert.equal(events.find((e) => e.id === "evt-dos")!.venue, "Plaza principal");
  });

  it("lee las coordenadas de GEO cuando vienen", () => {
    const uno = events.find((e) => e.id === "evt-uno")!;
    assert.equal(uno.lat, 6.2518);
    assert.equal(uno.lon, -75.5636);
  });

  it("un día suelto queda marcado como todo el día, sin inventarle hora", () => {
    const dos = events.find((e) => e.id === "evt-dos")!;
    assert.equal(dos.allDay, true);
    assert.equal(dos.startsAt, "2026-09-22T00:00");
    assert.equal(dos.name, "Feria, con coma escapada", "la coma escapada se deshace");
  });

  it("omite lo que no puede ubicar en el tiempo con certeza", () => {
    const ids = events.map((e) => e.id);
    assert.equal(ids.includes("evt-serie"), false, "una serie repetida se expande con reglas que no implementamos");
    assert.equal(ids.includes("evt-otra-zona"), false, "mover una hora entre zonas sin base de husos sería adivinar");
    assert.deepEqual(ids, ["evt-uno", "evt-dos"]);
  });

  it("un cuerpo que no es un calendario se rechaza con el motivo", () => {
    assert.throws(() => parseIcs("<html>404</html>", "Calendario", TZ), /Calendario/);
  });
});

describe("withWalkMinutes", () => {
  it("un kilómetro en línea recta son ~18 minutos caminando, no ~13", () => {
    // El factor de calle (1,35) y el paso (4,5 km/h) son la misma convención
    // que usa `lugares.json`: esquinas, semáforos y puentes, no línea recta.
    const metros = haversineMeters(6.2, -75.57, 6.209, -75.57);
    assert.ok(Math.abs(metros - 1000) < 5, `el caso mide ~1 km (${Math.round(metros)} m)`);
    const [medido] = withWalkMinutes(
      [{ id: "a", name: "A", startsAt: "2026-09-20T10:00", endsAt: null, allDay: false, venue: null,
         neighborhood: null, lat: 6.209, lon: -75.57, url: "", source: "s", walkMinutes: null }],
      6.2,
      -75.57,
    );
    assert.equal(medido.walkMinutes, 18);
  });

  it("solo se lo pone a quien tiene coordenada; el resto sigue sin minutos", () => {
    const base: CityEvent = {
      id: "a", name: "A", startsAt: "2026-09-20T10:00", endsAt: null, allDay: false,
      venue: null, neighborhood: "Centro", lat: null, lon: null, url: "", source: "s", walkMinutes: null,
    };
    const conCoord = { ...base, id: "b", name: "B", lat: 6.209, lon: -75.57 };
    const [sin, con] = withWalkMinutes([base, conCoord], 6.2, -75.57);
    assert.equal(sin.walkMinutes, null, "sin coordenada no se estima nada");
    assert.equal(con.walkMinutes, 18);
  });
});

describe("eventsNear", () => {
  const ev = (over: Partial<CityEvent>): CityEvent => ({
    id: over.id ?? "x", name: over.name ?? "Evento", startsAt: "2026-09-20T10:00", endsAt: null, allDay: false,
    venue: null, neighborhood: null, lat: null, lon: null, url: "", source: "s", walkMinutes: 5, ...over,
  });

  const lista = [
    ev({ id: "tarde", name: "Tarde", startsAt: "2026-09-21T18:00" }),
    ev({ id: "ahora", name: "Ahora", startsAt: "2026-09-20T09:00", endsAt: "2026-09-20T23:00" }),
    ev({ id: "pasado", name: "Pasado", startsAt: "2026-09-19T10:00", endsAt: "2026-09-19T12:00" }),
    ev({ id: "lejos", name: "Lejos", startsAt: "2026-09-21T10:00", walkMinutes: 90 }),
    ev({ id: "sin-sitio", name: "Sin sitio", startsAt: "2026-09-21T11:00", walkMinutes: null }),
    ev({ id: "con-barrio", name: "Con barrio", startsAt: "2026-09-21T12:00", walkMinutes: null, neighborhood: "Centro" }),
    ev({ id: "muy-lejano", name: "Muy lejano", startsAt: "2026-10-30T10:00" }),
  ];

  const cerca = eventsNear(lista, { nowIso: "2026-09-20T10:00", horizonDays: 7, walkMaxMinutes: 25 });

  it("lo que ya terminó no aparece, pero lo que está en curso sí", () => {
    const ids = cerca.map((e) => e.id);
    assert.equal(ids.includes("pasado"), false);
    assert.equal(ids.includes("ahora"), true, "empezó hace una hora y termina en la noche");
  });

  it("descarta lo que queda lejos a pie y lo que no se puede ubicar ni por barrio", () => {
    const ids = cerca.map((e) => e.id);
    assert.equal(ids.includes("lejos"), false);
    assert.equal(ids.includes("sin-sitio"), false, "sin minutos ni barrio no le sirve a nadie en un andén");
    assert.equal(ids.includes("con-barrio"), true, "sin minutos pero con barrio, sí");
  });

  it("respeta el horizonte y ordena por fecha", () => {
    assert.deepEqual(cerca.map((e) => e.id), ["ahora", "con-barrio", "tarde"]);
    assert.equal(cerca.map((e) => e.id).includes("muy-lejano"), false);
    const ancho = eventsNear(lista, { nowIso: "2026-09-20T10:00", horizonDays: 60, walkMaxMinutes: 25 });
    assert.equal(ancho.map((e) => e.id).includes("muy-lejano"), true, "con más horizonte, sí entra");
  });

  it("el horizonte llega hasta el FINAL del último día, no hasta su medianoche", () => {
    assert.equal(endOfDayAfter("2026-09-20T10:00", 1), "2026-09-21T23:59");
    assert.equal(endOfDayAfter("2026-12-31T08:00", 1), "2027-01-01T23:59", "cruza el año");
  });
});

describe("horizonForWhen", () => {
  it('"hoy" es HOY: cero días más, no uno', () => {
    // Sumar un día metía el plan de mañana en la respuesta a "¿qué hay hoy?".
    assert.equal(horizonForWhen("hoy", 14), 0);
    assert.equal(horizonForWhen("today", 14), 0);
    assert.equal(horizonForWhen("mañana", 14), 1);
    assert.equal(horizonForWhen("manana", 14), 1);
    assert.equal(horizonForWhen("esta semana", 14), 7);
  });

  it("solo estrecha: nunca pasa del horizonte configurado", () => {
    assert.equal(horizonForWhen("semana", 3), 3, "con 3 días configurados, 'semana' no estira a 7");
    assert.equal(horizonForWhen(undefined, 14), 14);
    assert.equal(horizonForWhen("cuando sea", 14), 14, "lo que no se entiende no estrecha nada");
  });
});

describe("parseEventsConfig", () => {
  it("lee las fuentes y completa los valores que el humano no puso", () => {
    const c = parseEventsConfig({
      sources: [{ kind: "luma_place", id: "discplace-abc", label: "Ciudad" }],
      horizon_days: 3,
    });
    assert.equal(c.sources.length, 1);
    assert.equal(c.horizonDays, 3);
    assert.equal(c.cacheMinutes, 60, "default");
    assert.equal(c.walkMaxMinutes, 25, "default");
    assert.equal(c.timezone, null, "sin zona declarada, la decide el sistema de transporte");
  });

  it("acepta una lista suelta y los nombres de campo en español", () => {
    const c = parseEventsConfig([{ tipo: "luma_calendar", id: "cal-abc", etiqueta: "Calendario" }]);
    assert.equal(c.sources[0].kind, "luma_calendar");
    assert.equal(c.sources[0].label, "Calendario");
    assert.deepEqual(parseEventsConfig({}).sources, [], "sin la clave sources, no hay fuentes");
  });

  it("rechaza un archivo roto con el motivo y el índice", () => {
    assert.throws(() => parseEventsConfig({ sources: [{ kind: "rss", id: "x", label: "y" }] }), /sources\[0\].kind/);
    assert.throws(() => parseEventsConfig({ sources: [{ kind: "luma_place", label: "y" }] }), /sources\[0\].id: texto vacío/);
    assert.throws(() => parseEventsConfig({ sources: {} }), EstacionConfigError);
    assert.throws(() => parseEventsConfig({ sources: [], horizon_days: 0 }), /horizon_days: número entre 1 y 90/);
  });
});

describe("dedupeEvents", () => {
  it("dos fuentes que traen el mismo evento lo muestran una vez", () => {
    const uno: CityEvent = {
      id: "evt-1", name: "A", startsAt: "2026-09-20T10:00", endsAt: null, allDay: false,
      venue: null, neighborhood: null, lat: null, lon: null, url: "", source: "ciudad", walkMinutes: null,
    };
    const otro = { ...uno, source: "calendario" };
    assert.deepEqual(dedupeEvents([uno, otro]).map((e) => e.source), ["ciudad"]);
  });
});
