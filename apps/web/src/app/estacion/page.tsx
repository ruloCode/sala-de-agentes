"use client";

// TÓTEM DE ESTACIÓN — pantalla vertical (9:16) para el andén, página suelta
// fuera del shell, hermana de /sala.
//
// Es la misma conversación del elenco (UNA sesión de ElevenLabs, dos voces)
// puesta a trabajar en una estación concreta: el viajero pregunta cómo llegar
// o qué hacer cerca, y la PANTALLA pinta la ruta real del sistema con sus
// líneas, tiempos y transbordos. La tarjeta no se arma con el texto del
// modelo: cada client tool emite su payload estructurado al bus de UI
// (lib/sala/ui-bus) y de ahí sale lo que se ve. Si un dato no existe, el
// bloque no aparece.
//
// La cámara NO se dibuja ni se graba: usePose sirve solo de detector de
// presencia para encender la conversación, y el aviso lo dice en pantalla.
// QA sin micrófono ni cámara: window.__hermesEstacionSay(texto) y
// window.__hermesEstacionDebug().

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SalaAgentPublic, SalaCastPublic, SalaStation } from "@sala/shared";
import { hermesFetch } from "@/lib/hermes";
import { CastCall, type CastEvent } from "@/lib/sala/cast";
import { salaClientTools } from "@/lib/sala/client-tools";
import { emitUiEvent, onUiEvent, type UiCityEvent, type UiEvent, type UiNotice, type UiPlace, type UiRoutePlan } from "@/lib/sala/ui-bus";
import type { SalaCallStatus } from "@/lib/sala/calls";
import { usePose, type PoseSample } from "@/hooks/usePose";
import { clockText, contourPaths, EST, estVars, LANGUAGES, t, todayIso, type EstLanguage } from "@/lib/estacion/theme";
import { StationBar } from "@/components/estacion/StationBar";
import { Hosts, type HostView } from "@/components/estacion/Hosts";
import { RouteCard } from "@/components/estacion/RouteCard";
import { PlacesGrid } from "@/components/estacion/PlacesGrid";
import { EventsList } from "@/components/estacion/EventsList";
import { Subtitles, type SubtitleLine } from "@/components/estacion/Subtitles";
import { HandoffQr } from "@/components/estacion/HandoffQr";

declare global {
  interface Window {
    /** QA: habla como el viajero, sin micrófono. */
    __hermesEstacionSay?: (text: string) => boolean;
    /** QA: estado de la pantalla (conexión, vista, últimas tools). */
    __hermesEstacionDebug?: () => unknown;
    /**
     * QA: pinta una vista con el MISMO payload que emitiría una client tool,
     * sin conectar la voz. Sirve para revisar la ruta, los lugares o un fallo
     * en cualquier tamaño de pantalla sin gastar cuota (y sin cámara).
     */
    __hermesEstacionPaint?: (ev: UiEvent) => boolean;
  }
}

/**
 * EL LIENZO DEL ANDÉN. El tótem es una pantalla vertical 9:16 y el diseño está
 * hecho en píxeles para ESE tamaño: tipografía que se lee de lejos, anfitriones
 * grandes, una tarjeta por vez. En una ventana de escritorio esas medidas no
 * encogen solas — el pie se queda con el 70% y la ruta queda en una astilla.
 *
 * Así que la pantalla no se re-maqueta: se ESCALA entera. Lo que se ve en un
 * portátil es exactamente lo del andén, más pequeño. En la pantalla real la
 * escala es 1 y no cambia un píxel; en una de 2160×3840 crece sin despeinarse.
 */
const STAGE = { width: 1080, height: 1920 };

/** Rol de cada anfitrión bajo su nombre: el primero es la ruta, el segundo la ciudad. */
const ROLES: Record<EstLanguage, string[]> = {
  es: ["tu ruta", "tu ciudad"],
  en: ["your route", "your city"],
  pt: ["sua rota", "sua cidade"],
};

type Load =
  | { kind: "loading" }
  | { kind: "error"; error: string }
  | { kind: "ready"; agents: SalaAgentPublic[]; cast: SalaCastPublic; station: SalaStation | null };

type View =
  | { kind: "idle" }
  | { kind: "route"; plan: UiRoutePlan; next: { line: string; headsign: string; inMinutes: number[] }[]; scheduleStale: boolean }
  | { kind: "places"; station: string; places: UiPlace[] }
  | { kind: "events"; station: string; events: UiCityEvent[]; stale: boolean }
  | { kind: "failed"; query: string; error: string; suggestions: string[] };

const TZ = "America/Bogota";

/**
 * Lo que el celular necesita para retomar sin hacer repetir al viajero: la
 * ruta en una línea y las últimas frases de la charla. Nada de identidad —
 * ni quién es, ni de dónde viene: solo a dónde iba.
 */
function handoffSummary(plan: UiRoutePlan, lines: SubtitleLine[]): string {
  const tramos = [
    plan.walkStart ? `${plan.walkStart.minutes} min a pie hasta ${plan.walkStart.to}` : null,
    ...plan.legs.map((l) => `${l.lineName} hasta ${l.to}`),
    plan.walkEnd ? `${plan.walkEnd.minutes} min a pie hasta ${plan.walkEnd.to}` : null,
  ].filter(Boolean);
  const llegada = plan.arrival ? ` Llega ≈ ${plan.arrival.at}${plan.arrival.stale ? " (horario publicado)" : ""}.` : "";
  const ruta = `Iba de ${plan.origin?.name ?? plan.from} a ${plan.destination?.name ?? plan.to}: ${tramos.join(", luego ")}. ${plan.minutes} minutos, ${plan.transfers} transbordos.${llegada}`;
  const charla = lines
    .slice(-4)
    .map((l) => `${l.name}: ${l.text}`)
    .join(" | ");
  return `${ruta}${charla ? ` Lo último que se habló en la pantalla — ${charla}` : ""}`;
}

export default function EstacionPage() {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [status, setStatus] = useState<SalaCallStatus>("idle");
  const [view, setView] = useState<View>({ kind: "idle" });
  const [lines, setLines] = useState<SubtitleLine[]>([]);
  const [notices, setNotices] = useState<UiNotice[]>([]);
  const [lang, setLang] = useState<EstLanguage>("es");
  const [clock, setClock] = useState(() => clockText(new Date(), TZ));
  const [today, setToday] = useState(() => todayIso(new Date(), TZ));
  const [nextTrains, setNextTrains] = useState<{ line: string; headsign: string; inMinutes: number[] }[]>([]);
  const [nextStale, setNextStale] = useState(false);
  const [lineColor, setLineColor] = useState<string | null>(null);
  const [present, setPresent] = useState(false);
  const [speaking, setSpeaking] = useState<string | null>(null);
  const [level, setLevel] = useState(0);

  const castRef = useRef<CastCall | null>(null);
  const toolLog = useRef<{ t: number; kind: string }[]>([]);

  // ── Config de la sala/estación ────────────────────────────────────────
  useEffect(() => {
    let alive = true;
    hermesFetch("/sala/agents")
      .then(async (res) => {
        const r = (await res.json()) as {
          agents?: SalaAgentPublic[];
          cast?: SalaCastPublic | null;
          station?: SalaStation | null;
          error?: string;
        };
        if (!alive) return;
        if (!res.ok || r.error) return setLoad({ kind: "error", error: r.error ?? `HTTP ${res.status}` });
        if (!r.cast?.ready) {
          return setLoad({ kind: "error", error: "El elenco todavía no existe en ElevenLabs (pnpm setup:elevenlabs --sala)" });
        }
        setLoad({ kind: "ready", agents: r.agents ?? [], cast: r.cast, station: r.station ?? null });
        if (r.station?.default_language) setLang(r.station.default_language as EstLanguage);
      })
      .catch((err: unknown) => alive && setLoad({ kind: "error", error: err instanceof Error ? err.message : String(err) }));
    return () => {
      alive = false;
    };
  }, []);

  const station = load.kind === "ready" ? load.station : null;
  const cast = load.kind === "ready" ? load.cast : null;
  const agents = useMemo(() => (load.kind === "ready" ? load.agents : []), [load]);

  const hosts: HostView[] = useMemo(() => {
    if (!cast) return [];
    return cast.members.map((key, i) => ({
      key,
      name: agents.find((a) => a.key === key)?.name ?? key,
      role: ROLES[lang][i] ?? "",
    }));
  }, [cast, agents, lang]);
  const hostIndex = useCallback((key: string) => hosts.findIndex((h) => h.key === key), [hosts]);
  const nameOf = useCallback(
    (key: string | null) => (key ? (hosts.find((h) => h.key === key)?.name ?? key) : lang === "es" ? "Tú" : lang === "en" ? "You" : "Você"),
    [hosts, lang],
  );

  // ── Reloj + próximas salidas + novedades (datos de la barra) ──────────
  useEffect(() => {
    const id = setInterval(() => {
      const now = new Date();
      setClock(clockText(now, TZ));
      // El tótem puede llevar días prendido: si "hoy" no se refresca, una
      // tarjeta de mañana seguiría diciendo "Hoy" al día siguiente.
      setToday(todayIso(now, TZ));
    }, 15_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!station) return;
    let alive = true;
    const pull = async () => {
      try {
        const res = await hermesFetch(`/metro/next?station=${encodeURIComponent(station.name)}`);
        const r = (await res.json()) as {
          ok: boolean;
          stale?: boolean;
          departures?: { line: string; lineName: string; color: string; headsign: string; inMinutes: number[] }[];
        };
        if (!alive || !r.ok) return;
        const deps = r.departures ?? [];
        setNextTrains(deps.map((d) => ({ line: d.line, headsign: d.headsign, inMinutes: d.inMinutes })));
        setNextStale(Boolean(r.stale));
        // El color del badge sale del feed: la línea de la estación, si pasa por aquí.
        const own = deps.find((d) => d.line === station.line);
        if (own) setLineColor(own.color);
      } catch {
        /* sin horarios: la barra simplemente no los muestra */
      }
      try {
        const res = await hermesFetch("/metro/status");
        const r = (await res.json()) as { ok: boolean; notices?: UiNotice[] };
        if (alive && r.ok) setNotices(r.notices ?? []);
      } catch {
        /* sin novedades: no hay banner */
      }
    };
    void pull();
    const id = setInterval(pull, 60_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [station]);

  // ── Bus de UI: lo que descubren las tools se pinta aquí ───────────────
  useEffect(() => {
    return onUiEvent((ev: UiEvent) => {
      toolLog.current.push({ t: Math.round(performance.now()), kind: ev.kind });
      if (toolLog.current.length > 40) toolLog.current.shift();
      if (ev.kind === "route") {
        setView({ kind: "route", plan: ev.plan, next: ev.next, scheduleStale: ev.scheduleStale });
        if (ev.notices.length) setNotices(ev.notices);
      } else if (ev.kind === "places") {
        setView({ kind: "places", station: ev.station, places: ev.places });
      } else if (ev.kind === "events") {
        setView({ kind: "events", station: ev.station, events: ev.events, stale: ev.stale });
      } else if (ev.kind === "route_failed") {
        setView({ kind: "failed", query: ev.query, error: ev.error, suggestions: ev.suggestions });
      } else if (ev.kind === "status") {
        setNotices(ev.notices);
      } else if (ev.kind === "language") {
        const l = ev.language.slice(0, 2) as EstLanguage;
        if (l === "es" || l === "en" || l === "pt") setLang(l);
      } else if (ev.kind === "clear") {
        setView({ kind: "idle" });
      }
    });
  }, []);

  // ── La conversación (mismo elenco que /sala) ──────────────────────────
  useEffect(() => {
    if (!cast) return;
    const call = new CastCall({
      fetchToken: async () => {
        const res = await hermesFetch("/sala/token?agent=cast");
        return (await res.json()) as { conversationToken?: string; signedUrl?: string; error?: string };
      },
      clientTools: salaClientTools(),
      labels: cast.labels,
      defaultKey: cast.default,
      owner: "",
      onEvent: (ev: CastEvent) => {
        if (ev.kind === "status") setStatus(ev.status ?? "idle");
        else if (ev.kind === "line") {
          setLines((prev) => [...prev.slice(-5), { key: ev.key ?? null, name: nameOf(ev.key ?? null), text: ev.text ?? "" }]);
        }
      },
    });
    castRef.current = call;
    window.__hermesEstacionSay = (text: string) => call.say(text);
    return () => {
      delete window.__hermesEstacionSay;
      void call.hangup();
      castRef.current = null;
    };
  }, [cast, nameOf]);

  const framing = useCallback(() => {
    const names = hosts.map((h) => h.name).join(" y ");
    const where = station ? `la estación ${station.name} (línea ${station.line})` : "una estación";
    const idioma = lang === "es" ? "español" : lang === "en" ? "inglés" : "portugués";
    return `Alguien se acercó al tótem de ${where}. Están ${names}. Salúdenlo en UNA frase corta entre los dos y pregunten a dónde va. Hablen en ${idioma} hasta que pida otro idioma.`;
  }, [hosts, station, lang]);

  const connect = useCallback(() => {
    const call = castRef.current;
    if (!call || call.isConnected() || call.getStatus() === "connecting") return;
    void call.connect(framing());
  }, [framing]);

  // Presencia: la cámara solo dice "hay alguien" y enciende la conversación.
  // No se dibuja el video ni se guarda nada (el aviso en pantalla lo promete).
  const seenRef = useRef(false);
  const onSample = useCallback((s: PoseSample) => {
    const here = s.world !== null;
    if (here !== seenRef.current) {
      seenRef.current = here;
      setPresent(here);
    }
  }, []);
  const pose = usePose(onSample);
  const startedRef = useRef(false);
  useEffect(() => {
    if (load.kind !== "ready" || startedRef.current) return;
    startedRef.current = true;
    void pose.start();
  }, [load.kind, pose]);
  const autoRef = useRef(false);
  useEffect(() => {
    if (!present || autoRef.current || !cast) return;
    autoRef.current = true;
    connect();
  }, [present, cast, connect]);

  // Quién habla y con cuánta fuerza: por rAF, sin re-render por frame del audio.
  useEffect(() => {
    let raf = 0;
    let lastKey: string | null = null;
    let lastLevel = 0;
    const step = () => {
      raf = requestAnimationFrame(step);
      const c = castRef.current;
      const key = c?.speakingKey() ?? null;
      const v = c?.volume() ?? 0;
      if (key !== lastKey) {
        lastKey = key;
        setSpeaking(key);
      }
      // Solo se re-renderiza cuando el nivel cambia de verdad (paso de 0,08).
      if (Math.abs(v - lastLevel) > 0.08) {
        lastLevel = v;
        setLevel(v);
      }
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Idioma por chip: la pantalla cambia y la sala se entera sin cortar la llamada.
  const pickLanguage = useCallback(
    (code: EstLanguage) => {
      setLang(code);
      const idioma = code === "es" ? "español" : code === "en" ? "inglés" : "portugués";
      castRef.current?.context(`El viajero eligió ${idioma} en la pantalla: sigan la conversación en ${idioma}.`);
    },
    [],
  );

  // Esc: cuelga y deja la pantalla como estaba para el siguiente viajero.
  // Es lo que se presiona al terminar el ensayo, y lo que hará quien atienda
  // el stand entre una persona y la siguiente.
  const reset = useCallback(() => {
    void castRef.current?.hangup();
    setLines([]);
    setView({ kind: "idle" });
    autoRef.current = false;
    setStatus("idle");
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") reset();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [reset]);

  useEffect(() => {
    window.__hermesEstacionDebug = () => ({
      load: load.kind,
      status,
      view: view.kind,
      plan: view.kind === "route" ? view.plan : null,
      places: view.kind === "places" ? view.places.map((p) => p.name) : null,
      events: view.kind === "events" ? { stale: view.stale, names: view.events.map((e) => e.name) } : null,
      lang,
      present,
      speaking,
      notices: notices.length,
      nextTrains: nextTrains.length,
      tools: toolLog.current.slice(-12),
      lines: lines.slice(-6),
    });
    return () => {
      delete window.__hermesEstacionDebug;
    };
  }, [load.kind, status, view, lang, present, speaking, notices.length, nextTrains.length, lines]);

  // La forma de la ventana decide el reparto. Se mide una vez y en cada
  // resize; hasta que el navegador conteste se asume el andén, que es el
  // destino real de esta pantalla.
  const [ventana, setVentana] = useState<{ ancho: number; alto: number } | null>(null);
  useEffect(() => {
    const medir = () => setVentana({ ancho: window.innerWidth, alto: window.innerHeight });
    medir();
    window.addEventListener("resize", medir);
    return () => window.removeEventListener("resize", medir);
  }, []);

  // Apaisado = más ancho que alto. Ahí el lienzo 9:16 escalado desperdicia dos
  // tercios de la pantalla, así que se reparte en columnas.
  const apaisado = ventana ? ventana.ancho > ventana.alto : false;
  // El lienzo se escala para caber entero, sin recortar ni deformar: el factor
  // es el menor de los dos lados (9:16 se respeta siempre).
  const stageScale = ventana
    ? Math.min(ventana.ancho / STAGE.width, ventana.alto / STAGE.height)
    : 1;

  // La costura de pintado va por el MISMO bus que las client tools: lo que se
  // revisa aquí es exactamente lo que ve el viajero, no una maqueta aparte.
  useEffect(() => {
    window.__hermesEstacionPaint = (ev: UiEvent) => {
      emitUiEvent(ev);
      return true;
    };
    return () => {
      delete window.__hermesEstacionPaint;
    };
  }, []);

  const contours = useMemo(() => contourPaths(), []);
  const connected = status === "connected";
  const connecting = status === "connecting";
  const lastHuman = [...lines].reverse().find((l) => l.key === null);
  const banner = notices[0];

  if (load.kind !== "ready") {
    return (
      <main style={estVars} className="grid min-h-screen place-items-center bg-[var(--est-mountain)] p-10 text-center">
        <p className="max-w-[700px] text-[26px] text-[var(--est-butter)]">
          {load.kind === "loading" ? "…" : load.error}
        </p>
      </main>
    );
  }

  // Las piezas se declaran una vez y se reparten distinto según la pantalla.
  // Son las MISMAS: el andén y el escritorio no son dos diseños, son dos
  // repartos del mismo contenido.
  const fondo = (
    <svg
      aria-hidden
      viewBox="0 0 1080 1920"
      preserveAspectRatio="xMidYMid slice"
      className="pointer-events-none absolute inset-0 h-full w-full"
    >
      <rect width="1080" height="1920" fill={EST.mountainDeep} opacity="0.55" />
      {contours.map((d, i) => (
        <path key={i} d={d} fill="none" stroke={EST.butter} strokeOpacity={0.07} strokeWidth={2} />
      ))}
    </svg>
  );

  const cabecera = (
    <div className="relative z-10 flex min-w-0 flex-col gap-6">
      <StationBar
        station={station?.name ?? ""}
        line={station?.line ?? ""}
        lineColor={lineColor}
        clock={clock}
        lang={lang}
        next={nextTrains}
        scheduleStale={nextStale}
      />
      {banner && (
        <div
          className="rounded-2xl px-6 py-4 text-[22px] font-medium text-white"
          style={{ backgroundColor: EST.alert }}
          role="status"
        >
          {banner.line ? `${t(lang, "line")} ${banner.line}: ` : ""}
          {banner.text}
          {banner.delayMin ? ` · ${banner.delayMin} ${t(lang, "minutes")}` : ""}
        </div>
      )}
    </div>
  );

  // Centro: una cosa a la vez. Reposo, la ruta, o lo que hay cerca.
  // El scroll vive aquí, pero el centrado NO: `justify-center` en un contenedor
  // que desborda recorta por ARRIBA y deja ese borde inalcanzable (el scroll
  // empieza ya pasado el título). Se centra con `my-auto` en el envoltorio:
  // mismo resultado cuando cabe, y cuando no cabe arranca pegado arriba y se
  // puede bajar hasta el final.
  const centro = (
    <div className="relative z-10 flex min-h-0 min-w-0 flex-col overflow-x-hidden overflow-y-auto">
      <div className="my-auto flex min-w-0 flex-col gap-8 py-6">
        {view.kind === "idle" && (
          <div className="text-center">
            <p className="font-[family-name:var(--font-baloo)] text-[72px] leading-tight font-bold text-[var(--est-butter)]">
              {connecting ? t(lang, "connecting") : connected && lastHuman ? t(lang, "listening") : t(lang, "idle")}
            </p>
            <p className="mt-3 text-[24px] text-[var(--est-butter)]/70">{t(lang, "idleHint")}</p>
            {lastHuman && (
              <p className="mt-8 font-[family-name:var(--font-baloo)] text-[34px] text-white/90">“{lastHuman.text}”</p>
            )}
          </div>
        )}
        {view.kind === "route" && (
          // El QR solo aparece cuando hay algo que llevarse. En el andén va
          // DEBAJO de la ruta (sobra alto); en apaisado va al LADO, que es
          // donde sobra sitio: así la ruta larga no empuja nada fuera.
          <div className={apaisado ? "flex min-w-0 items-start gap-8" : "flex min-w-0 flex-col gap-8"}>
            <div className="min-w-0 flex-1">
              <RouteCard plan={view.plan} lang={lang} next={view.next} scheduleStale={view.scheduleStale} />
            </div>
            <div className={apaisado ? "w-[290px] shrink-0" : "min-w-0"}>
              <HandoffQr
                plan={view.plan}
                summary={handoffSummary(view.plan, lines)}
                station={station?.name ?? ""}
                lang={lang}
                reparto={apaisado ? "columna" : "fila"}
              />
            </div>
          </div>
        )}
        {view.kind === "places" && <PlacesGrid station={view.station} places={view.places} lang={lang} />}
        {view.kind === "events" && (
          <EventsList station={view.station} events={view.events} stale={view.stale} lang={lang} todayIso={today} />
        )}
        {view.kind === "failed" && (
          <div className="rounded-[24px] bg-[var(--est-butter)]/10 p-7 text-center">
            <p className="font-[family-name:var(--font-baloo)] text-[36px] font-semibold text-[var(--est-butter)]">
              {view.error}
            </p>
            {view.suggestions.length > 0 && (
              <p className="mt-3 text-[24px] text-[var(--est-butter)]/80">{view.suggestions.slice(0, 4).join(" · ")}</p>
            )}
          </div>
        )}
      </div>
    </div>
  );

  const controles = (
    <div className={`flex items-center gap-6 ${apaisado ? "flex-wrap" : "justify-between"}`}>
      <div className="flex gap-3">
        {LANGUAGES.map((l) => (
          <button
            key={l.code}
            type="button"
            onClick={() => pickLanguage(l.code)}
            className="cursor-pointer rounded-full px-5 py-2 text-[20px] transition-colors"
            style={
              l.code === lang
                ? { backgroundColor: EST.butter, color: EST.ink }
                : { border: `1px solid ${EST.butter}55`, color: EST.butter }
            }
          >
            {l.label}
          </button>
        ))}
      </div>
      {!connected && (
        <button
          type="button"
          onClick={connect}
          className="cursor-pointer rounded-full px-7 py-3 text-[22px] font-semibold text-white"
          style={{ backgroundColor: EST.guava }}
        >
          {t(lang, "enter")}
        </button>
      )}
    </div>
  );

  const privacidad = (
    <p className="text-[16px] leading-snug text-[var(--est-butter)]/55">{t(lang, "privacy")}</p>
  );

  // ── REPARTO APAISADO (escritorio a pantalla completa) ──────────────────
  // Una pantalla 16:9 no es un andén: sobra ancho y falta alto. El lienzo 9:16
  // escalado dejaría el 68% de la pantalla en negro, así que aquí el contenido
  // ocupa el ancho y los anfitriones se van a un riel lateral, que es donde la
  // conversación puede vivir sin robarle alto a la ruta.
  if (apaisado) {
    return (
      <main
        style={estVars}
        className="relative grid h-screen w-screen grid-cols-[minmax(0,1fr)_clamp(340px,26vw,520px)] gap-10 overflow-hidden bg-[var(--est-mountain)] px-10 py-8 font-[family-name:var(--font-inter)]"
      >
        {fondo}
        <div className="relative z-10 grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] gap-2">
          {cabecera}
          {centro}
        </div>
        {/* El riel: quién te habla, qué se dijo y con qué se controla. */}
        <aside className="relative z-10 flex min-h-0 min-w-0 flex-col gap-6 border-l border-[var(--est-butter)]/12 pl-8">
          <Hosts hosts={hosts} speakingKey={speaking} level={level} lang={lang} reparto="columna" />
          <div className="min-h-0 flex-1 overflow-y-auto">
            <Subtitles lines={lines} hostIndex={hostIndex} />
          </div>
          {controles}
          {privacidad}
        </aside>
      </main>
    );
  }

  // ── REPARTO DEL ANDÉN (la pantalla vertical) ───────────────────────────
  return (
    <main
      style={estVars}
      className="relative h-screen w-screen overflow-hidden bg-[var(--est-mountain-deep)]"
    >
      {/* El lienzo va posicionado, no alineado: un hijo más grande que su
          contenedor NO se centra con `place-items-center` —el grid lo pega al
          inicio para no esconder contenido— y entonces el `scale`, que gira
          sobre el centro, lo deja fuera de cuadro. Con top/left al 50% y el
          margen negativo, el centro del lienzo cae siempre en el centro de la
          ventana y la escala no lo mueve. */}
      <div
        className="absolute top-1/2 left-1/2 grid grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)_auto] gap-2 overflow-hidden bg-[var(--est-mountain)] px-10 pt-8 pb-6 font-[family-name:var(--font-inter)]"
        style={{
          width: STAGE.width,
          height: STAGE.height,
          marginLeft: -STAGE.width / 2,
          marginTop: -STAGE.height / 2,
          transform: `scale(${stageScale})`,
        }}
      >
        {fondo}
        {cabecera}
        {centro}
        {/* Pie: los anfitriones, los subtítulos, los idiomas y la privacidad. */}
        <div className="relative z-10 flex min-w-0 flex-col gap-4 pb-1">
          <Hosts hosts={hosts} speakingKey={speaking} level={level} lang={lang} />
          <Subtitles lines={lines} hostIndex={hostIndex} />
          {controles}
          {privacidad}
        </div>
      </div>
    </main>
  );
}
