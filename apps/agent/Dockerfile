# Imagen del agente. Es un proceso LARGO a propósito: construye la red del
# GTFS una vez (~450 ms, ~220 MB) y la reusa, y guarda los pases del QR en
# memoria con TTL de 15 min. Por eso no va a una función serverless.
#
# Se construye desde la RAÍZ del monorepo:
#   docker build -f apps/agent/Dockerfile -t sala-agente .

FROM node:22-alpine
RUN corepack enable
WORKDIR /app

# Manifests primero: la capa de dependencias se reusa mientras no cambien.
# Va el de apps/web aunque no se use, porque sin él el lockfile del workspace
# no valida contra --frozen-lockfile.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/agent/package.json apps/agent/
COPY apps/web/package.json apps/web/

# OJO: sin NODE_ENV=production todavía. El agente arranca con `tsx`, que es
# devDependency: podar dev aquí deja la imagen sin intérprete.
RUN pnpm install --frozen-lockfile --prod=false --filter @sala/agent...

COPY packages/shared packages/shared
COPY apps/agent apps/agent

# La config del humano (sala.json, gtfs/, lugares.json…) NO va en la imagen:
# se monta en /data. Una imagen con los nombres de una ciudad adentro sería
# justo lo que la regla 2 del repo evita.
ENV NODE_ENV=production
ENV SALA_HOME=/data
ENV PORT=8650
VOLUME /data
EXPOSE 8650

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8650/health || exit 1

CMD ["pnpm", "--filter", "@sala/agent", "start"]
