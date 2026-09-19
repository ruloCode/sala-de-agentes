/**
 * A quién saluda la sala. Vacío = la interfaz omite el nombre. El agente tiene
 * su propia copia (apps/agent/src/owner.ts): ningún nombre propio en el código.
 */
export const OWNER: string = (process.env.NEXT_PUBLIC_SALA_OWNER_NAME || "").trim();
