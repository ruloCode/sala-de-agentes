/**
 * Prepara la carpeta de configuración (`~/.sala`) para arrancar.
 *
 * Copia las plantillas de `docs/` si no existen y, cuando encuentra una
 * instalación previa en `~/.hermes-os` (el proyecto del que salió este repo),
 * trae de ahí lo que ya esté configurado: personajes, feed del transporte,
 * lugares y novedades. Nunca pisa un archivo existente: solo rellena huecos.
 *
 * Uso:  pnpm setup:config
 */
import { cp, mkdir, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "../../../..");
const HOME = process.env.SALA_HOME || join(homedir(), ".sala");
const LEGACY = join(homedir(), ".hermes-os");

const ARCHIVOS: { destino: string; plantilla?: string; que: string }[] = [
  { destino: "sala.json", plantilla: "docs/sala.example.json", que: "los personajes y el elenco" },
  { destino: "metro.json", plantilla: "docs/metro.example.json", que: "alias y nombres de estaciones" },
  { destino: "lugares.json", plantilla: "docs/lugares.example.json", que: "qué hay cerca de cada estación" },
  { destino: "metro-status.json", plantilla: "docs/metro-status.example.json", que: "novedades del servicio" },
  { destino: "barrios.json", plantilla: "docs/barrios.example.json", que: "barrios con su centroide, para llegar a un barrio y no solo a una estación" },
  { destino: "eventos.json", plantilla: "docs/eventos.example.json", que: "de dónde sale la agenda de la ciudad" },
];

async function existe(p: string): Promise<boolean> {
  return stat(p).then(
    () => true,
    () => false,
  );
}

await mkdir(HOME, { recursive: true });
console.log(`Carpeta de configuración: ${HOME}\n`);

for (const a of ARCHIVOS) {
  const destino = join(HOME, a.destino);
  if (await existe(destino)) {
    console.log(`  = ${a.destino} ya existe (${a.que})`);
    continue;
  }
  const previo = join(LEGACY, a.destino);
  if (await existe(previo)) {
    await cp(previo, destino);
    console.log(`  ← ${a.destino} traído de ~/.hermes-os (${a.que})`);
    continue;
  }
  if (a.plantilla) {
    await cp(join(root, a.plantilla), destino);
    console.log(`  + ${a.destino} desde la plantilla — EDÍTALO (${a.que})`);
  }
}

// El feed del transporte: son varios MB, así que se enlaza por copia una vez.
const gtfs = join(HOME, "gtfs", "metro");
if (existsSync(join(gtfs, "stop_times.txt"))) {
  console.log(`  = gtfs/metro ya está (${(await readdir(gtfs)).length} archivos)`);
} else if (existsSync(join(LEGACY, "gtfs", "metro", "stop_times.txt"))) {
  await cp(join(LEGACY, "gtfs", "metro"), gtfs, { recursive: true });
  console.log("  ← gtfs/metro traído de ~/.hermes-os");
} else {
  console.log(`  ! falta el GTFS en ${gtfs} — sin él, el tótem no puede dar rutas (ver README)`);
}

console.log("\nListo. Revisa sala.json antes de correr `pnpm setup:voz`.");
