import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Carpeta de estado FUERA del repo: los personajes (`sala.json`), el feed del
 * sistema de transporte (`gtfs/metro/`), los lugares y las novedades. Nada de
 * eso es código y nada de eso se versiona — así el mismo repo corre en otra
 * máquina, con otros personajes y en otra ciudad.
 *
 * Override con SALA_HOME. Si no existe `~/.sala` pero sí `~/.hermes-os` (la
 * casa del proyecto del que salió este repo), se usa esa: el demo sigue
 * funcionando sin mover archivos el día de la presentación.
 */
function resolveHome(): string {
  const override = process.env.SALA_HOME;
  if (override) return override;
  const own = join(homedir(), ".sala");
  if (existsSync(own)) return own;
  const legacy = join(homedir(), ".hermes-os");
  if (existsSync(legacy)) return legacy;
  return own;
}

export const SALA_HOME: string = resolveHome();
