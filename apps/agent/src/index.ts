import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { readFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { SalaValidationError } from "@sala/shared";
import { env } from "./env.js";
import { listSalaAgents, portraitPath, resolveSalaAgentId, salaCast, salaStation, salaTopic, SALA_PATH } from "./sala/store.js";
import { createHandoff, readHandoff, HANDOFF_TTL_MS } from "./sala/handoff.js";
import { departuresAt, placesAt, readStatus, routeBetween, stationList, METRO_STATUS_PATH, PLACES_PATH } from "./metro/store.js";
import { eventsAt, EVENTS_PATH } from "./metro/events.js";

/**
 * Agente de la Sala de Agentes y del Tótem de estación.
 *
 * Es deliberadamente chico: sirve los personajes (`sala.json`), planifica
 * rutas sobre el GTFS del sistema de transporte, lee los archivos que el
 * humano escribe (lugares, novedades) y emite el pase efímero para seguir la
 * conversación en el celular. La voz NO pasa por aquí: las client tools corren
 * en el browser y llaman a estas rutas, que es lo que permite que la web hable
 * con el agente sin túnel.
 *
 * Contrato de todas: `{ ok, … | error }` con 200 cuando la petición es válida.
 * Un dato que no existe se relata; nunca se inventa.
 */

const app = new Hono();

// CORS: el tótem puede abrirse desde otro equipo de la red local (una pantalla
// vertical no siempre es la misma máquina que sirve la web).
app.use(
  "*",
  cors({
    origin: (origin) => {
      if (!origin) return origin;
      const host = (() => {
        try {
          return new URL(origin).hostname;
        } catch {
          return "";
        }
      })();
      const privada =
        /^(localhost|127\.0\.0\.1|\[::1\])$/.test(host) ||
        /^10\./.test(host) ||
        /^192\.168\./.test(host) ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
        /\.local$/.test(host) ||
        /\.ts\.net$/.test(host);
      return privada ? origin : null;
    },
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["GET", "POST", "OPTIONS"],
  }),
);

// Auth: sin clave configurada el agente es local y abierto; con clave, Bearer
// en todo salvo /health (para que un monitor pueda preguntar si está vivo).
app.use("*", async (c, next) => {
  if (!env.API_KEY || c.req.path === "/health" || c.req.method === "OPTIONS") return next();
  const auth = c.req.header("Authorization") || "";
  const key = c.req.query("key") || (auth.startsWith("Bearer ") ? auth.slice(7) : "");
  if (key !== env.API_KEY) return c.json({ error: "no autorizado" }, 401);
  return next();
});

// Log de una línea por request: en un demo lo que importa es ver si la tool
// llegó y cuánto tardó.
app.use("*", async (c, next) => {
  const t0 = Date.now();
  await next();
  if (c.req.method !== "OPTIONS") {
    console.log(`[http] ${new Date().toISOString()} ${c.req.method} ${c.req.path} → ${c.res.status} ${Date.now() - t0}ms`);
  }
});

app.get("/health", (c) => c.json({ ok: true, machine: env.MACHINE_NAME, sala: env.SALA_ENABLED, estacion: env.ESTACION_ENABLED }));

/** IP de esta máquina en la red local: con ella el tótem arma la URL del QR. */
function lanIp(): string | null {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) return a.address;
    }
  }
  return null;
}

// Mismo contrato que espera la web para resolver el host del QR.
app.get("/machines", (c) =>
  c.json({ machines: [{ machine: env.MACHINE_NAME, self: true, online: true, lanIp: lanIp(), baseUrl: `http://${lanIp() ?? "localhost"}:${env.PORT}` }] }),
);

// ── Sala de agentes ────────────────────────────────────────────────────
// Los personajes viven en `sala.json` (ningún nombre propio en el código).
app.get("/sala/agents", async (c) => {
  if (!env.SALA_ENABLED) return c.json({ error: "sala desactivada (SALA_ENABLED=off)" }, 404);
  try {
    return c.json({
      agents: await listSalaAgents(),
      topic: await salaTopic(),
      cast: await salaCast(),
      station: await salaStation(),
      path: SALA_PATH,
    });
  } catch (err) {
    if (err instanceof SalaValidationError) return c.json({ error: err.message, path: SALA_PATH }, 500);
    throw err;
  }
});

// Retrato del personaje (PNG). Un <img> no manda el Bearer: se acepta ?key=.
app.get("/sala/portrait/:key", async (c) => {
  if (!env.SALA_ENABLED) return c.json({ error: "sala desactivada" }, 404);
  const key = c.req.param("key");
  if (!/^[a-z0-9][a-z0-9-]{0,23}$/.test(key)) return c.json({ error: "key inválida" }, 400);
  try {
    const png = await readFile(portraitPath(key));
    return c.body(new Uint8Array(png), 200, { "Content-Type": "image/png", "Cache-Control": "private, max-age=300" });
  } catch {
    return c.json({ error: "sin retrato" }, 404);
  }
});

// Credenciales efímeras de voz por clave de personaje (`?agent=cast`). La API
// key de ElevenLabs no sale nunca del servidor.
app.get("/sala/token", async (c) => {
  if (!env.SALA_ENABLED) return c.json({ error: "sala desactivada" }, 404);
  const which = c.req.query("agent") || "";
  if (!env.ELEVENLABS_API_KEY) return c.json({ notConfigured: true, error: "Falta ELEVENLABS_API_KEY en .env" }, 503);
  const { agentId, hint } = await resolveSalaAgentId(which);
  if (!agentId) return c.json({ notConfigured: true, error: hint }, 503);
  const headers = { "xi-api-key": env.ELEVENLABS_API_KEY };
  const tokenRes = await fetch(`https://api.elevenlabs.io/v1/convai/conversation/token?agent_id=${agentId}`, { headers });
  if (tokenRes.ok) {
    const { token } = (await tokenRes.json()) as { token: string };
    return c.json({ conversationToken: token });
  }
  const signedRes = await fetch(`https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${agentId}`, { headers });
  if (signedRes.ok) {
    const { signed_url } = (await signedRes.json()) as { signed_url: string };
    return c.json({ signedUrl: signed_url });
  }
  return c.json({ error: `ElevenLabs rechazó ambos métodos (${tokenRes.status}/${signedRes.status})` }, 502);
});

// "Sigue en tu celular": pase de 15 minutos en memoria, sin identidad del
// viajero (ver sala/handoff.ts).
app.post("/sala/handoff", async (c) => {
  if (!env.SALA_ENABLED) return c.json({ ok: false, error: "sala desactivada" }, 404);
  type HandoffBody = { summary?: string; language?: string; route?: unknown; station?: string };
  const body = await c.req.json<HandoffBody>().catch(() => ({}) as HandoffBody);
  const entry = createHandoff({
    summary: (body.summary ?? "").trim(),
    language: body.language ?? "es",
    route: body.route,
    station: body.station,
  });
  return c.json({ ok: true, token: entry.token, expiresAt: entry.expiresAt, ttlMs: HANDOFF_TTL_MS });
});

app.get("/sala/handoff/:token", (c) => {
  if (!env.SALA_ENABLED) return c.json({ ok: false, error: "sala desactivada" }, 404);
  const entry = readHandoff(c.req.param("token"));
  // Vencido ≠ error del sistema: el celular lo cuenta y ofrece volver al tótem.
  if (!entry) return c.json({ ok: false, expired: true, error: "ese pase ya venció o no existe" }, 404);
  return c.json({ ok: true, ...entry });
});

// ── Tótem de estación ──────────────────────────────────────────────────
// La ruta sale del GTFS; las novedades y los lugares, de los archivos que
// escribe el humano. Sin archivo no hay dato, y sin dato no se muestra nada.
const estacionOff = () => ({ ok: false, error: "el tótem está apagado (ESTACION_ENABLED=off)" }) as const;

app.post("/metro/route", async (c) => {
  if (!env.ESTACION_ENABLED) return c.json(estacionOff(), 404);
  const body = await c.req.json<{ from?: string; to?: string }>().catch(() => ({}) as { from?: string; to?: string });
  const from = (body.from ?? "").trim();
  const to = (body.to ?? "").trim();
  // `from` es opcional a propósito: en el andén el viajero solo dice a dónde
  // va, y el origen es la estación donde está la pantalla (sala.json.station).
  if (!to) return c.json({ ok: false, error: "falta to (destino)" }, 400);
  try {
    return c.json(await routeBetween(from, to));
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/metro/stations", async (c) => {
  if (!env.ESTACION_ENABLED) return c.json(estacionOff(), 404);
  try {
    return c.json(await stationList());
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

// Próximas salidas por línea y sentido. `stale` = el feed venció: es horario
// publicado, no predicción, y la UI debe decirlo.
app.get("/metro/next", async (c) => {
  if (!env.ESTACION_ENABLED) return c.json(estacionOff(), 404);
  const station = (c.req.query("station") ?? "").trim();
  if (!station) return c.json({ ok: false, error: "falta station" }, 400);
  try {
    return c.json(await departuresAt(station));
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/metro/status", async (c) => {
  if (!env.ESTACION_ENABLED) return c.json(estacionOff(), 404);
  try {
    const { notices, all, exists } = await readStatus();
    return c.json({ ok: true, notices, total: all.length, configured: exists, path: METRO_STATUS_PATH });
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : String(err), path: METRO_STATUS_PATH });
  }
});

app.get("/metro/places", async (c) => {
  if (!env.ESTACION_ENABLED) return c.json(estacionOff(), 404);
  const station = (c.req.query("station") ?? "").trim();
  if (!station) return c.json({ ok: false, error: "falta station" }, 400);
  try {
    return c.json(await placesAt(station));
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : String(err), path: PLACES_PATH });
  }
});

// Qué PASA cerca (agenda con fecha), no qué HAY (lugares con horario). Es la
// única ruta del tótem que sale a la red; si ninguna fuente responde y no hay
// nada cacheado, lo dice en vez de devolver una lista vacía que parecería
// "no hay nada esta semana".
app.get("/metro/events", async (c) => {
  if (!env.ESTACION_ENABLED) return c.json(estacionOff(), 404);
  const station = (c.req.query("station") ?? "").trim();
  if (!station) return c.json({ ok: false, error: "falta station" }, 400);
  try {
    return c.json(await eventsAt(station, c.req.query("when")));
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : String(err), path: EVENTS_PATH });
  }
});

// Con API key escucha en toda la red (una pantalla en otro equipo); sin ella,
// solo localhost: nada abierto por accidente.
const hostname = env.API_KEY ? "0.0.0.0" : "127.0.0.1";
serve({ fetch: app.fetch, port: env.PORT, hostname }, () => {
  console.log(`\n🗣  Agente de la sala → http://localhost:${env.PORT}`);
  console.log(`   modo: ${env.API_KEY ? `RED (${hostname}) con API key` : "LOCAL (solo esta máquina)"}`);
  console.log(`   config: ${SALA_PATH}`);
  console.log(`   sala: ${env.SALA_ENABLED ? "on" : "off"} · tótem: ${env.ESTACION_ENABLED ? "on" : "off"}\n`);
});
