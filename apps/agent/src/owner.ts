/**
 * A quién representa esta instancia. Solo se usa para hablarle al elenco en
 * el prompt; no hay ningún nombre propio en el código.
 */
import { userInfo } from "node:os";

function systemUserName(): string {
  try {
    const u = userInfo().username || "";
    return u ? u.charAt(0).toUpperCase() + u.slice(1) : "";
  } catch {
    return "";
  }
}

export const OWNER: string = process.env.SALA_OWNER_NAME?.trim() || process.env.HERMES_OWNER_NAME?.trim() || systemUserName() || "Usuario";
