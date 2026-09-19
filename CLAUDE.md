# Sala de agentes — contexto para Claude Code

Monorepo pnpm, dos procesos. `apps/agent` (Hono, :8650) sirve los personajes y
los datos del transporte; `apps/web` (Next 15, :31999) sirve las tres pantallas
(`/sala`, `/estacion`, `/m/:token`). La lógica pura vive en `packages/shared` y
se prueba sin cámara, sin micrófono y sin red.

## Las dos reglas que mandan sobre el resto

1. **Todo dato visible es real o no se muestra.** Ninguna ruta, hora ni lugar
   se inventa: salen del GTFS o de los archivos de `~/.sala`. Si la fuente no
   existe, la pantalla lo dice. Esto vale también para los prompts de voz: si
   una tool falla, el personaje lo dice en vez de completar de memoria.
2. **Ningún nombre propio en el código.** Personajes, ciudad, estación y
   lugares son configuración. El mismo repo corre en otra ciudad con otro
   elenco cambiando `~/.sala`.

## Cómo está armado

- **Voz**: UNA sesión de ElevenLabs con un agente multi-voz (`tts.supported_voices`)
  que interpreta a todos los personajes. Un solo cerebro = contexto total y
  cero solapes; nombrar a uno enruta solo. El cliente (`lib/sala/cast.ts`)
  reconstruye quién suena con las etiquetas `<Nombre>…</Nombre>` del texto en
  streaming (`agent_chat_response_part`) más la alineación por carácter del
  audio. Sin ese evento el texto llega al final y la pantalla no sabe quién
  habla hasta entonces.
- **Client tools en el BROWSER** (`lib/sala/client-tools.ts`): llaman al agente
  local. Cada una devuelve texto para la voz **y** emite el payload
  estructurado al bus de UI (`lib/sala/ui-bus.ts`), que es lo que pinta la
  tarjeta. La tarjeta nunca se arma con el texto del modelo.
- **GTFS** (`packages/shared/src/gtfs.ts`, puro): fusiona andenes en estaciones
  por nombre normalizado + distancia y por `transfers.txt`, saca los segundos
  por tramo como MEDIANA entre viajes, y `planRoute` hace Dijkstra sobre
  (estación, línea) con costo lexicográfico: **primero menos transbordos,
  luego menos minutos**. Cuando el calendario del feed venció, las salidas se
  marcan `stale` y la UI dice "horario publicado".
- **Eventos** (`packages/shared/src/eventos.ts` puro + `apps/agent/src/metro/events.ts`):
  la agenda de ciudad sale de fuentes públicas declaradas en `~/.sala/eventos.json`
  (listado por ciudad en JSON y calendarios por su feed iCalendar, ambos anónimos).
  Es lo ÚNICO del tótem que sale a la red: se cachea en `~/.sala/cache/eventos.json`
  y, si la fuente se cae, se sirve lo último leído **marcado como tal**. Sin caché
  y sin red, `ok:false` y la pantalla no pinta.

- **Handoff** (`apps/agent/src/sala/handoff.ts`): pase de 15 min EN MEMORIA,
  sin identidad del viajero. El QR lo genera `packages/shared/src/qr.ts` (sin
  dependencias) y la URL sale del `lanIp` que publica `/machines`.
- **Config del humano**: `~/.sala` (override `SALA_HOME`; si no existe pero sí
  `~/.hermes-os`, se usa esa). `pnpm setup:config` la prepara.

## Convenciones

- Español en UI, comentarios y mensajes. Código y nombres en inglés.
- El `.env` vive en la RAÍZ del monorepo, no en `apps/`.
- `pnpm typecheck` y `pnpm test` antes de commitear.
- Tests = contratos de comportamiento, **nunca snapshots** de un valor actual.
  El del QR, por ejemplo, decodifica de vuelta con un decodificador escrito
  aparte en vez de comparar la matriz.
- Sin prettier en el repo; el estilo de facto es `--print-width 100`.
- No agregar dependencias pesadas. La escena 3D usa three.js y la visión
  MediaPipe; el QR, el GTFS y el planificador son propios a propósito.

## Trampas ya pagadas

- **Una columna de grid sin `min-w-0`** toma el ancho intrínseco de su
  contenido y empuja el resto fuera de pantalla. Se percibe como "el texto se
  sale". Pasó tres veces en el tótem.
- **La información de formato del QR va en (columna, fila)**; transpuesta, el
  código se ve perfecto y ningún lector lo acepta.
- **El micrófono del navegador solo existe en contexto seguro.** Por
  `http://<ip>` no hay `navigator.mediaDevices` y la llamada muere con un error
  críptico: por eso `/m/:token` lo detecta antes de conectar y lo explica.
- **`sendUserMessage` no emite `onMessage(user)`**: hay que procesarlo a mano.
  Y los mensajes «...» son el turn-timeout del servidor de voz, no el micrófono.
- **El modo parpadea speaking/listening entre voces** (cada personaje es un
  chunk de TTS aparte): el reloj de reproducción se reinicia solo en turno
  nuevo, nunca por el cambio de modo.
- **`cache: "no-store"` no existe** en el `RequestInit` de Node.
- **La coordenada de un evento con dirección oculta viene CORRIDA a propósito.**
  Cuando la fuente marca `mode: "obfuscated"` (la dirección se la dan al que se
  inscribe), igual entrega un punto — pero desplazado. Unos minutos a pie
  calculados con él se ven perfectos y son mentira. Se descarta la coordenada y
  se muestra el barrio. Es el mismo error de familia que el QR transpuesto.
- **"Hoy" son CERO días más, no uno.** Un horizonte de un día sumado a hoy
  incluye mañana: "¿qué hay hoy?" contestaba con el plan del día siguiente.

## QA sin hardware

```js
window.__hermesSalaSay("…")        // hablarle a /sala por texto
window.__hermesEstacionSay("…")    // hablarle al tótem
window.__hermesEstacionDebug()     // conexión, vista, tools, subtítulos
window.__hermesSalaSim(world)      // cuerpo sintético, sin cámara
```

```bash
python apps/web/scripts/estacion-qa.py --runs 3   # el guion del demo, solo
```
