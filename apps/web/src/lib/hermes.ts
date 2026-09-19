/**
 * Cliente del agente de la sala. Deliberadamente mínimo: la web solo necesita
 * hablarle a `/sala/*` y `/metro/*`, y esas llamadas salen del BROWSER (las
 * client tools de la voz corren ahí), que es lo que permite que la pantalla
 * use datos locales sin exponer nada al proveedor de voz.
 *
 * La URL del agente puede apuntarse a otra máquina de la red (una pantalla
 * vertical no siempre es la que corre el agente): override en localStorage.
 */
const DEFAULT_URL = (process.env.NEXT_PUBLIC_SALA_AGENT_URL || "http://localhost:8650").replace(/\/$/, "");
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

/** Clave compartida cuando el agente escucha en la red. Vacía = local. */
export function getAgentKey(): string {
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
