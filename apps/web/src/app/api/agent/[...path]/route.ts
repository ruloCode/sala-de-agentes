/**
 * BFF del agente: en producción el browser NUNCA habla directo con el agente.
 *
 * Por qué existe. La pantalla llamaba al agente desde el browser con
 * `NEXT_PUBLIC_SALA_API_KEY`, y una variable NEXT_PUBLIC viaja DENTRO del
 * bundle: cualquiera la lee del JS y acuña sesiones de voz contra la cuenta de
 * ElevenLabs ajena. Encima el CORS del agente solo acepta origins de red
 * privada, y una web https no puede llamar a un agente http (mixed content).
 * Los tres problemas mueren con un salto server-side: el browser le pide a su
 * propio origen y este handler reenvía con un Bearer que no sale de aquí.
 *
 * En la LAN esto no se usa: con `NEXT_PUBLIC_SALA_AGENT_URL` la pantalla
 * vuelve a llamar al agente directo (ver lib/hermes.ts), que es lo que permite
 * abrir el tótem desde otra máquina sin pasar por internet.
 */

import { NextResponse } from "next/server";

// El agente construye la red del GTFS en el primer request (~450 ms) y guarda
// estado en memoria: nada de esto se puede prerenderizar ni cachear.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** Sin barra final: se concatena con el path tal cual. */
const AGENT_URL = (process.env.SALA_AGENT_URL || process.env.NEXT_PUBLIC_SALA_AGENT_URL || "").replace(/\/$/, "");
const AGENT_KEY = process.env.SALA_API_KEY || "";
/** En local el agente está al lado; en un despliegue hay que decir dónde. */
const FALLBACK_URL = "http://localhost:8650";

/**
 * Qué se deja pasar. Un proxy abierto convertiría a la web en un relay a
 * cualquier puerto del host del agente, así que la lista es explícita y por
 * prefijo. `/tools/*` y `/tasks` quedan fuera a propósito: son rutas heredadas
 * que este agente no implementa (responderían 404 igual) y aceptar POST con un
 * prompt arbitrario desde internet no es algo que deba existir por descuido.
 */
const ALLOWED = [/^sala\//, /^metro\//, /^machines$/, /^health$/];

/** El agente responde `{ ok, … | error }` con 200; un fallo de red es 502. */
function upstreamDown(err: unknown): NextResponse {
  const reason = err instanceof Error ? err.message : String(err);
  return NextResponse.json({ ok: false, error: `el agente no responde (${reason})` }, { status: 502 });
}

async function forward(req: Request, path: string[], body?: BodyInit): Promise<Response> {
  const joined = path.join("/");
  if (!ALLOWED.some((re) => re.test(joined))) {
    return NextResponse.json({ ok: false, error: `ruta no permitida: /${joined}` }, { status: 404 });
  }

  // Desplegado y sin agente al que apuntar: se dice CUÁL falta. Caer a
  // localhost aquí produciría un "fetch failed" que no señala a nada, y la
  // pantalla prometería una fuente que no existe.
  if (!AGENT_URL && process.env.NODE_ENV === "production") {
    return NextResponse.json(
      { ok: false, notConfigured: true, error: "Falta SALA_AGENT_URL: esta web no sabe dónde vive el agente" },
      { status: 503 },
    );
  }
  const base = AGENT_URL || FALLBACK_URL;

  // La query del cliente se conserva (?station=, ?agent=), pero `key` se
  // descarta: la credencial la pone el servidor, no quien llama.
  const incoming = new URL(req.url).searchParams;
  incoming.delete("key");
  const qs = incoming.toString();

  const headers: Record<string, string> = {};
  if (AGENT_KEY) headers.Authorization = `Bearer ${AGENT_KEY}`;
  const contentType = req.headers.get("content-type");
  if (contentType) headers["Content-Type"] = contentType;

  let res: Response;
  try {
    res = await fetch(`${base}/${joined}${qs ? `?${qs}` : ""}`, {
      method: req.method,
      headers,
      body,
      signal: AbortSignal.timeout(25_000),
    });
  } catch (err) {
    return upstreamDown(err);
  }

  // Solo se copian las cabeceras seguras: `content-encoding` o `content-length`
  // del upstream describirían un cuerpo que fetch ya descomprimió.
  const out = new Headers();
  const ct = res.headers.get("content-type");
  if (ct) out.set("Content-Type", ct);
  out.set("Cache-Control", res.headers.get("cache-control") ?? "no-store");
  return new Response(res.body, { status: res.status, headers: out });
}

export async function GET(req: Request, ctx: { params: Promise<{ path: string[] }> }): Promise<Response> {
  return forward(req, (await ctx.params).path);
}

export async function POST(req: Request, ctx: { params: Promise<{ path: string[] }> }): Promise<Response> {
  // El cuerpo se lee entero (son JSON de pocos KB) para no depender de
  // `duplex: "half"` al reenviar un stream.
  return forward(req, (await ctx.params).path, await req.arrayBuffer());
}
