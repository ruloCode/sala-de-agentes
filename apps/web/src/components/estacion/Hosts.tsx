"use client";

// LOS DOS ANFITRIONES. No son avatares humanos: dos figuras de color con su
// nombre y su rol. El que está hablando se enciende (anillo + escala) con el
// mismo dato que usa la sala 3D: quién suena en este instante.

import { hostColor, type EstLanguage } from "@/lib/estacion/theme";

export interface HostView {
  key: string;
  name: string;
  /** "tu ruta" · "tu ciudad": el rol se lee antes que el nombre. */
  role: string;
}

/**
 * Cómo se reparten los dos anfitriones:
 *  - "fila": hombro con hombro, como en el andén. La pantalla es alta y
 *    angosta, y los dos caben mirando al viajero.
 *  - "columna": uno debajo del otro, con el nombre al lado del círculo. Es lo
 *    que cabe en el riel lateral de una pantalla apaisada, donde sobra alto
 *    pero no ancho.
 */
type Reparto = "fila" | "columna";

interface Props {
  hosts: HostView[];
  speakingKey: string | null;
  /** 0..1 del volumen de salida, para que el aro respire con la voz. */
  level: number;
  lang: EstLanguage;
  reparto?: Reparto;
}

export function Hosts({ hosts, speakingKey, level, reparto = "fila" }: Props) {
  const columna = reparto === "columna";
  const diametro = columna ? 108 : 150;

  return (
    <div className={columna ? "flex flex-col gap-6" : "flex items-end justify-center gap-10"}>
      {hosts.map((h, i) => {
        const on = speakingKey === h.key;
        const color = hostColor(i);
        const scale = on ? 1 + Math.min(0.12, level * 0.18) : 1;
        return (
          <div
            key={h.key}
            className={columna ? "flex min-w-0 items-center gap-5" : "flex w-[240px] flex-col items-center gap-3"}
          >
            <div
              className="relative grid shrink-0 place-items-center rounded-full transition-[transform,box-shadow] duration-150"
              style={{
                width: diametro,
                height: diametro,
                transform: `scale(${scale})`,
                backgroundColor: color,
                boxShadow: on ? `0 0 0 10px ${color}40, 0 18px 40px rgba(0,0,0,0.3)` : "0 12px 28px rgba(0,0,0,0.25)",
              }}
            >
              {/* Cara mínima: dos puntos. Un robot amable, no una persona falsa. */}
              <span className={columna ? "flex gap-4" : "flex gap-6"}>
                <span className={`block rounded-full bg-white/90 ${columna ? "h-3 w-3" : "h-4 w-4"}`} />
                <span className={`block rounded-full bg-white/90 ${columna ? "h-3 w-3" : "h-4 w-4"}`} />
              </span>
              {on && (
                <span
                  aria-hidden
                  className="absolute -bottom-2 h-[10px] rounded-full bg-white/80"
                  style={{ width: (columna ? 30 : 40) + level * 70 }}
                />
              )}
            </div>
            <div className={columna ? "flex min-w-0 flex-col gap-1" : "contents"}>
              <p
                className="font-[family-name:var(--font-baloo)] text-[30px] leading-none font-semibold"
                style={{ color: on ? "#fff" : "var(--est-butter)" }}
              >
                {h.name}
              </p>
              <p className="text-[19px] text-[var(--est-butter)]/70">{h.role}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}
