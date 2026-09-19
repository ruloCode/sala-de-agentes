/**
 * Cliente del agente de la sala. Deliberadamente mínimo: la web solo necesita
 * hablarle a `/sala/*` y `/metro/*`, y esas llamadas salen del BROWSER (las
 * client tools de la voz corren ahí), que es lo que permite que la pantalla
 * use datos locales sin exponer nada al proveedor de voz.
 *
 * DOS MODOS, y la diferencia es de dónde sale la credencial:
 *
 *  - PROXY (default, y el único sano en internet): se llama al propio origen,
 *    `/api/agent/*`, y el route handler reenvía con la clave del servidor. La
 *    clave no viaja en el bundle, no hay CORS que negociar y no hay mixed
 *    content porque todo es el mismo https.
 *  - DIRECTO: con `NEXT_PUBLIC_SALA_AGENT_URL` la pantalla vuelve a llamar al
 *    agente de frente. Es para la LAN — una pantalla vertical no siempre es la
 *    máquina que corre el agente — y ahí la clave compartida sí va al browser
 *    a sabiendas, porque la red es privada.
 *
 * La URL también se puede apuntar a mano desde localStorage (QA en la red).
 */
const PROXY_BASE = "/api/agent";
const DIRECT_URL = (process.env.NEXT_PUBLIC_SALA_AGENT_URL || "").replace(/\/$/, "");
const DEFAULT_URL = DIRECT_URL || PROXY_BASE;
const URL_KEY = "sala_agent_url";

export function getAgentUrl(): string {
  try {
    const override = localStorage.getItem(URL_KEY);
    if (override) return override.replace(/\/$/, "");
  } catch {
    /* SSR o almacenamiento bloqueado */
  }
  return DEFAULT_URL;
}

/** Apunta la web a otro agente (null = volver al de la env). Recarga después. */
export function setAgentUrl(url: string | null): void {
  try {
    if (url && url.replace(/\/$/, "") !== DEFAULT_URL) localStorage.setItem(URL_KEY, url.replace(/\/$/, ""));
    else localStorage.removeItem(URL_KEY);
  } catch {
    /* noop */
  }
}

/** True cuando las llamadas van por el propio origen y la clave la pone el servidor. */
function viaProxy(): boolean {
  return getAgentUrl() === PROXY_BASE;
}

/**
 * Clave compartida para el modo DIRECTO. Por el proxy devuelve vacío: mandarla
 * desde el browser sería volver a publicarla, que es justo lo que se evita.
 */
export function getAgentKey(): string {
  if (viaProxy()) return "";
  return process.env.NEXT_PUBLIC_SALA_API_KEY || "";
}

function authHeaders(): Record<string, string> {
  const key = getAgentKey();
  return key ? { Authorization: `Bearer ${key}` } : {};
}

export function hermesFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${getAgentUrl()}${path}`, {
    ...init,
    headers: { ...authHeaders(), ...(init?.headers as Record<string, string> | undefined) },
  });
}

export async function hermesGet<T>(path: string): Promise<T> {
  const res = await hermesFetch(path);
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return (await res.json()) as T;
}

export async function hermesPost<T>(path: string, body: unknown): Promise<T> {
  const res = await hermesFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} → ${res.status}`);
  return (await res.json()) as T;
}

/** Imágenes servidas por el agente: un <img> no manda el Bearer, va como ?key=. */
export function agentAssetUrl(path: string): string {
  const key = getAgentKey();
  if (!key) return `${getAgentUrl()}${path}`;
  const sep = path.includes("?") ? "&" : "?";
  return `${getAgentUrl()}${path}${sep}key=${encodeURIComponent(key)}`;
}
