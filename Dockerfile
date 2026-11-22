# syntax=docker/dockerfile:1.7

# Stage 1: dependencias de produccion. Las herramientas de compilacion solo
# existen en esta etapa si better-sqlite3 no dispone de un binario precompilado.
FROM node:22-slim AS dependencies
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci --omit=dev \
    && npm cache clean --force

# Stage 2: imagen final ligera, sin shell de compilacion ni dependencias dev.
FROM node:22-slim AS runtime
ARG APP_VERSION=unknown
ENV NODE_ENV=production \
    PORT=80 \
    APP_VERSION=${APP_VERSION} \
    NODE_OPTIONS=--enable-source-maps
WORKDIR /app

COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package*.json ./
COPY --chown=node:node app.js auth.js db.js responses.js server.js telemetry.js tracing.js seed.sql ./
COPY --chown=node:node public ./public
RUN mkdir -p /app/data \
    && chown -R node:node /app/data \
    && npm cache clean --force \
    && npm uninstall -g npm

USER node
EXPOSE 80 6061

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "--require", "./tracing.js", "server.js"]
