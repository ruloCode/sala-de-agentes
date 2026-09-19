"use client";

// LA RUTA, que es el dato por el que existe esta pantalla. Cada tramo lleva el
// color OFICIAL de su línea (route_color del GTFS, no una constante nuestra),
// las estaciones que recorre, cuántas paradas y cuántos minutos. Todo viene
// del agente: aquí no se calcula ni se redondea nada.
//
// El viajero no va "a Bicentenario": va al barrio Boston. Por eso la cabecera
// dice el ORIGEN y el DESTINO reales, la caminata desde la estación de bajada
// es un tramo más de la lista, y al final va la hora estimada de llegada —
// marcada como horario publicado cuando el feed venció.

import { t, type EstLanguage } from "@/lib/estacion/theme";
import type { UiRoutePlan, UiWalkLeg } from "@/lib/sala/ui-bus";

interface Props {
  plan: UiRoutePlan;
  lang: EstLanguage;
  next: { line: string; headsign: string; inMinutes: number[] }[];
  scheduleStale: boolean;
}

/** Un caminante mínimo, en el mismo trazo que los puntos de los anfitriones. */
function WalkIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-[28px] w-[28px]" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="13.5" cy="4" r="1.8" fill="currentColor" stroke="none" />
      <path d="M12.5 7.5 9.8 12l2.4 2.2-1.6 5.8M12.5 7.5l3 2.5 2.5 1.5M12.2 14.2l2.6 2 1.2 4.3M9.8 12l-3 1.7" />
    </svg>
  );
}

function kindLabel(lang: EstLanguage, kind: string): string | null {
  switch (kind) {
    case "barrio":
      return t(lang, "kindBarrio");
    case "direccion":
      return t(lang, "kindDireccion");
    case "lugar":
      return t(lang, "kindLugar");
    default:
      return null;
  }
}

/** Tramo a pie: mismo riel que las líneas, con el caminante en vez del número de línea. */
function WalkRow({ leg, lang, last }: { leg: UiWalkLeg; lang: EstLanguage; last: boolean }) {
  return (
    <li className="flex gap-4">
      <div className="flex w-[64px] shrink-0 flex-col items-center">
        <span className="flex h-[52px] w-[52px] items-center justify-center rounded-full border-[3px] border-[var(--est-ink)]/35 text-[var(--est-ink)]">
          <WalkIcon />
        </span>
        {!last && <span className="mt-2 w-[6px] flex-1 rounded-full bg-[var(--est-ink)]/15" />}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[26px] leading-snug font-semibold">
          {leg.from} → {leg.to}
        </p>
        <p className="mt-0.5 text-[20px] opacity-75">
          {leg.minutes} {t(lang, "minutes")} {t(lang, "walk")}
          {leg.meters > 0 ? ` · ${leg.meters} m` : ""}
        </p>
      </div>
    </li>
  );
}

export function RouteCard({ plan, lang, next, scheduleStale }: Props) {
  const transfers =
    plan.transfers === 0
      ? t(lang, "noTransfers")
      : `${plan.transfers} ${plan.transfers === 1 ? t(lang, "transfer") : t(lang, "transfers")}`;
  const first = next[0];
  const origin = plan.origin?.name ?? plan.from;
  const destination = plan.destination?.name ?? plan.to;
  const destKind = plan.destination ? kindLabel(lang, plan.destination.kind) : null;
  const walkOnly = plan.legs.length === 0;
  // Filas en orden real: caminar hasta la estación, el sistema, caminar al destino.
  const rows: ({ kind: "walk"; leg: UiWalkLeg } | { kind: "ride"; i: number })[] = [
    ...(plan.walkStart ? [{ kind: "walk" as const, leg: plan.walkStart }] : []),
    ...plan.legs.map((_, i) => ({ kind: "ride" as const, i })),
    ...(plan.walkEnd ? [{ kind: "walk" as const, leg: plan.walkEnd }] : []),
  ];
  const source = plan.destination?.source ?? null;

  return (
    <section className="rounded-[28px] bg-[var(--est-butter)] text-[var(--est-ink)] shadow-[0_18px_40px_rgba(0,0,0,0.25)]">
      {/* A dónde va y cuánto tarda queda CLAVADO arriba: una ruta con varios
          transbordos no cabe de una, y quien baja la lista de tramos no puede
          perder de vista su destino ni los minutos. El fondo es opaco porque
          los tramos pasan por detrás. */}
      <header className="sticky top-0 z-10 rounded-t-[28px] bg-[var(--est-butter)] px-7 pt-7 pb-4">
        <p className="font-[family-name:var(--font-baloo)] text-[34px] leading-tight font-semibold">
          {origin} → {destination}
        </p>
        {/* Cuando el destino no es una estación, se dice dónde bajarse. */}
        {plan.alightAt && !walkOnly && destination !== plan.alightAt && (
          <p className="mt-1 text-[20px] opacity-70">
            {destKind ? `${destKind} · ` : ""}
            {t(lang, "getOffAt")} {plan.alightAt}
            {plan.walkEnd ? ` · ${plan.walkEnd.minutes} ${t(lang, "minutes")} ${t(lang, "walk")}` : ""}
          </p>
        )}
        <p className="mt-1 text-[22px] opacity-80">
          {plan.minutes} {t(lang, "minutes")} · {walkOnly ? t(lang, "walkOnly") : transfers}
          {plan.arrival ? ` · ${t(lang, "arrive")} ${plan.arrival.at}` : ""}
        </p>
      </header>

      <div className="px-7 pb-7">
        <ol className="flex flex-col gap-5">
          {rows.map((row, idx) => {
            const last = idx === rows.length - 1;
            if (row.kind === "walk") return <WalkRow key={`walk-${idx}`} leg={row.leg} lang={lang} last={last} />;
            const leg = plan.legs[row.i];
            return (
              <li key={`${leg.line}-${row.i}`} className="flex gap-4">
                {/* Riel de la línea con su color oficial: se lee a distancia. */}
                <div className="flex w-[64px] shrink-0 flex-col items-center">
                  <span
                    className="flex h-[52px] w-[52px] items-center justify-center rounded-full text-[26px] font-bold text-white"
                    style={{ backgroundColor: leg.color }}
                  >
                    {leg.line}
                  </span>
                  {!last && <span className="mt-2 w-[6px] flex-1 rounded-full bg-[var(--est-ink)]/15" />}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-[26px] leading-snug font-semibold">
                    {leg.from} → {leg.to}
                  </p>
                  <p className="mt-0.5 text-[20px] opacity-75">
                    {leg.headsign ? `${leg.headsign} · ` : ""}
                    {leg.stops} {leg.stops === 1 ? t(lang, "stop") : t(lang, "stops")} · {leg.minutes} {t(lang, "minutes")}
                  </p>
                  {/* Las estaciones intermedias, chiquitas: quien las quiere, las lee. */}
                  {leg.stations.length > 2 && (
                    <p className="mt-1 truncate text-[16px] opacity-55">{leg.stations.slice(1, -1).join(" · ")}</p>
                  )}
                </div>
              </li>
            );
          })}
        </ol>

        {(first || plan.arrival || source) && (
          <footer className="mt-6 flex flex-col gap-1 border-t border-[var(--est-ink)]/12 pt-4 text-[20px]">
            {first && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="font-semibold">
                  {t(lang, "next")} {first.line}
                </span>
                <span className="opacity-75">
                  {first.headsign} · {first.inMinutes[0]} {t(lang, "minutes")}
                </span>
                {/* La nota de horario publicado NO se recorta: es la diferencia entre horario y promesa. */}
                {(scheduleStale || plan.arrival?.stale) && (
                  <span className="ml-auto shrink-0 text-[15px] opacity-55">{t(lang, "scheduleNote")}</span>
                )}
              </div>
            )}
            {/* De dónde salió la coordenada del destino: el dato lleva su fuente. */}
            {source && (
              <p className="truncate text-[14px] opacity-50">
                {t(lang, "source")}: {source}
              </p>
            )}
          </footer>
        )}
      </div>
    </section>
  );
}
