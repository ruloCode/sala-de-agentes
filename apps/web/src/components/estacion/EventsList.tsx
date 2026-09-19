"use client";

// QUÉ ESTÁ PASANDO: la agenda de la ciudad, con fecha. Distinta de "qué hay
// cerca", que son lugares con horario de apertura.
//
// Tres cosas que esta tarjeta NO hace, porque son las tres formas de mentir
// que tiene una agenda:
//  - no le pone hora a un evento de todo el día,
//  - no le inventa sede a quien reserva la dirección para los inscritos: dice
//    el barrio y que la dirección la dan al registrarse,
//  - no le pone minutos a pie a quien no publicó una coordenada utilizable.
// Y cuando el dato es el último que se alcanzó a leer, lo dice ARRIBA, en su
// propio renglón: ese aviso no se recorta nunca.

import { EST, eventWhen, t, type EstLanguage } from "@/lib/estacion/theme";
import type { UiCityEvent } from "@/lib/sala/ui-bus";

// Los mismos tres tonos que los lugares: mismo sitio en la pantalla, misma familia.
const TONES = [EST.guava, "#D98E2B", "#2E7DA6"];

export function EventsList({
  station,
  events,
  stale,
  lang,
  todayIso,
}: {
  station: string;
  events: UiCityEvent[];
  stale: boolean;
  lang: EstLanguage;
  todayIso: string;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-4">
      <div className="flex min-w-0 items-baseline gap-3">
        <h2 className="min-w-0 truncate font-[family-name:var(--font-baloo)] text-[30px] font-semibold text-[var(--est-butter)]">
          {t(lang, "events")} · {station}
        </h2>
        {/* Fuera del truncate: lo que cede al recortar son los datos repetibles,
            nunca la advertencia sobre la frescura de la fuente. */}
        {stale && <span className="shrink-0 text-[15px] text-[var(--est-butter)] opacity-60">{t(lang, "lastRead")}</span>}
      </div>

      {events.length === 0 ? (
        <p className="text-[21px] text-[var(--est-butter)] opacity-75">{t(lang, "eventsNone")}</p>
      ) : (
        <div className="flex flex-col gap-4">
          {events.slice(0, 3).map((e, i) => (
            <article
              key={e.id}
              className="min-w-0 rounded-[24px] p-6 text-white shadow-[0_14px_32px_rgba(0,0,0,0.22)] wrap-break-word"
              style={{ backgroundColor: TONES[i % TONES.length] }}
            >
              <p className="font-[family-name:var(--font-baloo)] text-[30px] leading-tight font-semibold">{e.name}</p>
              <p className="mt-1 text-[21px] font-semibold opacity-95">{eventWhen(e.startsAt, e.allDay, lang, todayIso)}</p>
              <p className="mt-1 text-[19px] leading-snug opacity-90">
                {e.venue ?? (e.neighborhood ? `${e.neighborhood} — ${t(lang, "venueUnknown")}` : t(lang, "venueUnknown"))}
                {e.walkMinutes !== null && ` · ${e.walkMinutes} ${t(lang, "minutes")} ${t(lang, "walk")}`}
              </p>
              <p className="mt-2 text-[14px] opacity-70">{e.source}</p>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
