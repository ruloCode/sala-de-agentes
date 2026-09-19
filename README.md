# Sala de agentes

Agentes con voz propia que conversan entre ellos y contigo, y responden con
datos que existen. Dos pantallas sobre el mismo motor:

| Pantalla | Qué es |
| --- | --- |
| `/sala` | Varios agentes de pie en una escena 3D. Tu cuerpo entra por la webcam y levantar la mano elige con quién hablas. |
| `/estacion` | Un tótem vertical para un andén: preguntas cómo llegar y responde con la ruta real del sistema de transporte, con sus líneas, tiempos y transbordos. |
| `/m/:token` | La misma conversación en el celular, con la ruta que armaste en la pantalla. |

Dos reglas atraviesan todo el repo:

- **Todo dato visible es real.** Las rutas salen del GTFS oficial del sistema
  de transporte; los lugares y las novedades, de archivos que edita una
  persona. Si la fuente no existe, la pantalla lo dice en vez de inventar.
- **Ningún nombre propio en el código.** Los personajes, la ciudad, la
  estación y los lugares viven en archivos de configuración fuera del repo. El
  mismo código corre en otra ciudad con otros agentes.

## Cómo funciona

Una sola sesión de voz con un agente **multi-voz** interpreta a todos los
personajes: un solo cerebro, así que tienen contexto completo, nunca hablan
encima del otro y nombrar a uno enruta solo. El cliente reconstruye quién está
sonando en cada instante (etiquetas de voz + alineación del audio) para
encender su figura y su subtítulo.

Las *client tools* de la voz corren en el **navegador** y llaman al agente
local: por eso la pantalla usa datos de tu máquina sin exponerlos al proveedor
de voz y sin necesitar un túnel. Lo que la tool descubre no se pinta con el
texto del modelo, sino con el payload estructurado que devuelve el agente.

```
navegador ──WebRTC──> proveedor de voz (habla y escucha)
    │
    └── client tools ──HTTP──> agente local ──> GTFS · sala.json · lugares.json
```

## Arrancar

Requiere Node 22+, pnpm y una cuenta de ElevenLabs.

```bash
pnpm install
cp .env.example .env         # pon tu ELEVENLABS_API_KEY
pnpm setup:config            # prepara ~/.sala con las plantillas
pnpm setup:voz               # crea o parchea los agentes de voz (idempotente)
pnpm dev                     # agente :8650 + web :31999
```

Luego abre `http://localhost:31999`. La sala pide cámara; el tótem se conecta
solo cuando te ve, y trae un botón de respaldo si prefieres no dar cámara.

## Configuración (fuera del repo)

Todo vive en `~/.sala` (override con `SALA_HOME`). Si ya tenías una
instalación en `~/.hermes-os`, se usa esa carpeta y `pnpm setup:config` trae lo
que encuentre.

| Archivo | Qué decide | Plantilla |
| --- | --- | --- |
| `sala.json` | Los personajes: nombre, voz, prompt, color y forma. El bloque `cast` arma el elenco multi-voz, y `station` convierte al elenco en anfitrión de una estación. | `docs/sala.example.json` |
| `gtfs/metro/*.txt` | El feed del sistema de transporte. Sin él no hay rutas. | — |
| `metro.json` | Alias como los dice la gente, nombres con tilde, minutos de transbordo. | `docs/metro.example.json` |
| `lugares.json` | Qué hay cerca de cada estación, con minutos a pie, horario y **fuente**. | `docs/lugares.example.json` |
| `metro-status.json` | Novedades del servicio de hoy. Sin archivo, no hay banner. | `docs/metro-status.example.json` |

Un lugar sin horario publicado se muestra como "sin horario publicado". El
campo `hours` solo se escribe cuando `source` dice de dónde salió.

## Datos del transporte

El feed es un GTFS estándar. Para el Metro de Medellín está en su portal de
datos abiertos:

```bash
mkdir -p ~/.sala/gtfs/metro && cd ~/.sala/gtfs/metro
curl -L -o gtfs.zip "https://www.arcgis.com/sharing/rest/content/items/929fbd2dbfbf493ab44935577e8fbff6/data"
unzip -o gtfs.zip && mv GTFS-*/* . 2>/dev/null || true
```

Tres cosas que el parser resuelve y conviene saber de cualquier feed: los
nombres de parada suelen traer la dirección pegada, cada línea tiene su propio
andén con sufijo (se fusionan por nombre y distancia, y por `transfers.txt`), y
cuando el calendario del feed ya venció las salidas se marcan como **horario
publicado**, nunca como predicción en vivo.

Comprobar la red desde la terminal:

```bash
pnpm ruta "Parque Berrío" "Parque Arví"   # la ruta con tramos y minutos
pnpm ruta --next "Parque Berrío"          # próximas salidas
pnpm ruta --stations                      # toda la red
```

## Rutas del agente

Todas responden `{ ok, … | error }` con 200 cuando la petición es válida, para
que la voz pueda relatar el problema en vez de tropezar con un 500.

| Ruta | Devuelve |
| --- | --- |
| `GET /sala/agents` | Personajes, elenco y estación. Sin ids ni prompts. |
| `GET /sala/token?agent=` | Credenciales efímeras de voz. La API key no sale del servidor. |
| `GET /sala/portrait/:key` | Retrato del personaje, si existe. |
| `POST /sala/handoff` · `GET /sala/handoff/:token` | El pase de 15 minutos para seguir en el celular. |
| `POST /metro/route {from?, to}` | La ruta con tramos, colores del feed, paradas y minutos. Sin `from`, sale de la estación del tótem. Si no reconoce un nombre, devuelve candidatas en vez de adivinar. |
| `GET /metro/stations` · `GET /metro/next?station=` | La red y las próximas salidas. |
| `GET /metro/status` · `GET /metro/places?station=` | Novedades y lugares (vacío si no hay archivo). |

`SALA_ENABLED=off` y `ESTACION_ENABLED=off` apagan cada mitad.

## Probar sin micrófono ni cámara

Las dos pantallas traen costuras de QA para hablarles por texto:

```js
window.__hermesSalaSay("¿Cómo llego a Parque Arví?")   // en /sala
window.__hermesEstacionSay("Tengo una hora, ¿qué hago cerca?")   // en /estacion
window.__hermesEstacionDebug()   // estado: conexión, vista, tools, subtítulos
```

Y el guion completo del demo corre solo:

```bash
pip install playwright && playwright install chromium
python apps/web/scripts/estacion-qa.py --runs 3
```

Verifica que cada pregunta dispara su tool, que la pantalla pinta la tarjeta
correcta, que nunca suena más de una voz a la vez, que no se cuela texto entre
corchetes en los subtítulos y que Esc deja la pantalla lista para el siguiente.

```bash
pnpm typecheck && pnpm test    # 66 tests de lógica pura, sin cámara ni red
```

## El celular

El tótem muestra un QR cuando hay una ruta en pantalla. El código lo genera
este repo (`packages/shared/src/qr.ts`, sin dependencias) y apunta a la IP de
tu red local, o a `NEXT_PUBLIC_ESTACION_PUBLIC_URL` si la configuras.

**Para que el celular pueda hablar hace falta https**: el navegador solo
entrega el micrófono en contexto seguro. Por `http://<ip-local>` el teléfono ve
su ruta y la página explica por qué no puede hablar.

## Diseño

`docs/ui/estacion-ui.md` tiene la especificación de la pantalla del tótem, y
`docs/ui/estacion-mockups.html` los mockups a 1080×1920 exactos: al construir
se copian las cifras de ahí. Las imágenes de referencia están en `docs/img/`.

## Origen

Salió de [hermes-os](https://github.com/ruloCode/hermes-os), donde la sala
nació como una de sus pantallas. Aquí vive sola: su propio agente, sus propios
datos y ninguna dependencia de aquel proyecto.
