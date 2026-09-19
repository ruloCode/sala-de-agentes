# Desplegar

Dos procesos, dos hosts, y no es un capricho: la web es estática + funciones,
pero el agente es un proceso **largo** (construye la red del GTFS una vez y
guarda los pases del QR en memoria con TTL de 15 min). Una función serverless
lo rompería en las dos puntas.

```
celular / tótem ──https──> Vercel (@sala/web)
                              │  route handler /api/agent/*  ← SALA_API_KEY vive aquí
                              ↓ https
                           agente (@sala/agent, VM con volumen)
                              ↓
                           GTFS · sala.json · lugares.json   ← montado en /data
```

El browser **nunca** habla directo con el agente en producción. Antes lo hacía
con `NEXT_PUBLIC_SALA_API_KEY`, y una variable `NEXT_PUBLIC` viaja dentro del
bundle: cualquiera la leía y acuñaba sesiones de voz contra la cuenta ajena de
ElevenLabs. El salto por `/api/agent/*` mata eso, y de paso el CORS (el agente
solo acepta red privada) y el mixed content (https no puede llamar a http).

## 1. El agente

```bash
docker build -f apps/agent/Dockerfile -t sala-agente .
docker run -d --restart unless-stopped \
  -p 127.0.0.1:8650:8650 \
  -v /srv/sala:/data:ro \
  -e ELEVENLABS_API_KEY=sk_… \
  -e SALA_API_KEY=<clave compartida con Vercel> \
  -e MACHINE_NAME=prod \
  -e SALA_METRO_TZ=America/Bogota \
  -e GOOGLE_MAPS_API_KEY=<opcional: direcciones con Google Maps> \
  sala-agente
```

`/srv/sala` es lo que hoy vive en `~/.sala`: `sala.json`, `gtfs/metro/*.txt`,
`metro.json`, `lugares.json`, `metro-status.json`, `barrios.json` (sin él,
"¿cómo llego al barrio X?" no reconoce barrios y el tótem lo dice). Va **fuera de la imagen** a
propósito — una imagen con los nombres de una ciudad adentro es justo lo que la
regla 2 del repo evita.

Delante, un reverse proxy con TLS (Caddy resuelve el certificado solo):

```
agente.tudominio.com {
    reverse_proxy 127.0.0.1:8650
}
```

`GET /health` está exento de auth para que el monitor pregunte sin clave.

`GOOGLE_MAPS_API_KEY` es opcional y solo sirve para **direcciones** ("calle 10
con la 43"): el agente manda el texto de la dirección a Google y descarta el
resultado si cae fuera de la zona del sistema. Barrios y estaciones nunca
pasan por ahí. Sin la key, el tótem dice que no resuelve direcciones.

## 2. La web (Vercel)

Root Directory del proyecto = `apps/web`. El `vercel.json` de ahí solo fija el
install filtrado; el resto lo detecta Vercel.

Variables, todas de **servidor** (sin `NEXT_PUBLIC`, no entran al bundle):

| Variable | Valor |
| --- | --- |
| `SALA_AGENT_URL` | `https://agente.tudominio.com` |
| `SALA_API_KEY` | la misma clave que corre en el agente |

Y las que **no** se ponen en Vercel:

- `ELEVENLABS_API_KEY` — solo el agente acuña los tokens de voz. El secreto más
  sensible del proyecto nunca toca Vercel.
- `NEXT_PUBLIC_SALA_AGENT_URL` y `NEXT_PUBLIC_SALA_API_KEY` — si las pones,
  la web vuelve al modo DIRECTO y la clave se publica en el JS.
- `NEXT_PUBLIC_ESTACION_PUBLIC_URL` — solo si el QR debe apuntar a un dominio
  distinto de aquel donde se abre el tótem. Sin ella el QR usa el origen
  actual, que en Vercel ya es https y es lo correcto.

Sin `SALA_AGENT_URL` el proxy responde `503 { notConfigured: true }` diciendo
qué falta, en vez de un "fetch failed" que no señala a nada.

> **`.vercelignore` manda sobre `.gitignore`.** Si existe, Vercel ignora el
> `.gitignore` por completo. Por eso el `.env` está listado ahí: sin esa línea
> el archivo sube al build, `next.config` lo carga y la URL local del agente
> queda horneada en el JS del cliente — con el secreto de paso.

## 3. ElevenLabs

Hace falta el **Agents Platform**, no TTS a secas: el repo crea agentes,
client tools de workspace y usa `tts.supported_voices` (multi-voz).

- El plan Free **no tiene licencia comercial**. Desde Starter sí.
- La concurrencia es por plan (Creator 10, Pro 20, Scale 30 llamadas). Un tótem
  = una sesión, pero `max_duration_seconds` es 1800: una sesión colgada quema
  30 min. Pasarse de concurrencia cuesta el doble por minuto.
- Usa una **service account key** con scopes `convai_read`, `convai_write`,
  `voices_read`, `user_read`, y ponle tope mensual de créditos.
- En cada agente, **allowlist de hostnames** (máx. 10, match exacto, los
  subdominios van aparte). Es lo que impide que alguien con tu `agent_id` te
  gaste los minutos.

`pnpm setup:voz` corre desde una máquina de trabajo, no desde el servidor:
escribe los `agent_id` de vuelta en `sala.json`.

## Interino: el agente desde tu propia máquina

Mientras no haya VM, el agente puede ser el de tu equipo detrás de un túnel.
Es **provisional**: prod depende de que tu máquina esté encendida, con el
agente y el túnel corriendo, y la URL del túnel rápido cambia en cada arranque.

```bash
# 1. La misma clave que tiene Vercel, en el .env de la raíz (el agente la exige
#    como Bearer y sin ella el túnel dejaría el agente abierto a internet).
vercel env pull /tmp/prod.env --environment=production   # copia SALA_API_KEY a .env
pnpm --filter @sala/agent dev                             # reinicia para que la tome

# 2. El túnel (sin cuenta; la URL sale en el log).
cloudflared tunnel --url http://127.0.0.1:8651 --no-autoupdate

# 3. Vercel apunta al túnel y se redespliega (las variables se leen al desplegar).
vercel env rm SALA_AGENT_URL production --yes
printf '%s' "https://<lo-que-dio-el-tunel>.trycloudflare.com" | vercel env add SALA_AGENT_URL production
vercel --prod --yes
```

Comprobación: `curl https://<tu-web>/api/agent/health` → 200, y
`POST /api/agent/metro/route {"to":"barrio Boston"}` devuelve el plan.

**Deployment Protection.** Un tótem y el QR del celular son públicos: el
proyecto va en *Standard Protection* (previews con login de Vercel, producción
abierta). Con *All Deployments* el alias de producción también pide login y la
pantalla no carga para nadie que no sea tú.

## 4. Después de desplegar

```bash
python apps/web/scripts/estacion-qa.py --runs 3   # el guion del demo
```

Y un cron mensual que rebaje el GTFS: cuando el calendario del feed vence las
salidas pasan a decir "horario publicado", que es honesto pero peor.
