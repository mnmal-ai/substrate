# syntax=docker/dockerfile:1.28
#
# The substrate server with the in-tree plugins, laid out as `substrate init`
# lays out a runtime: binary and plugins in one node_modules, SUBSTRATE_PLUGIN_DIR
# pointing at it. The root docker-compose.yml builds it next to Postgres; on
# its own, from the repository root:
#
#   docker build -t substrate -f apps/substrate-image/Dockerfile .
#
# Both FROM lines track package.json#engines.node, and the pnpm version tracks
# package.json#packageManager: the install runs --frozen-lockfile, so another
# pnpm major would resolve a lockfile it did not write.

FROM node:26 AS build
WORKDIR /repo
RUN npm install -g pnpm@12.14.0

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json tsconfig.bundle.json ./
COPY packages packages
COPY plugins plugins
COPY apps apps

RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store \
    pnpm config set store-dir /pnpm-store && \
    pnpm install --frozen-lockfile --ignore-scripts && \
    pnpm turbo build --filter=@mnmal-ai/substrate-image... && \
    pnpm --filter @mnmal-ai/substrate-image deploy --prod --legacy /deploy

FROM node:26-slim
WORKDIR /app

# curl for the HEALTHCHECK.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build --chown=node:node /deploy /app

USER node

ENV NODE_ENV=production
ENV PORT=3100
# Auth is off in this image, so the server refuses to boot on 0.0.0.0 until the
# caller sets SUBSTRATE_ALLOW_UNAUTHENTICATED_HOST=1. Compose does, and publishes
# the port on the host's loopback only.
ENV HOST=0.0.0.0
ENV SUBSTRATE_PLUGIN_DIR=/app
# Who the server writes as while auth is off; it refuses to boot without one.
# With auth on, callers are attributed individually and this is ignored.
ENV SUBSTRATE_SYSTEM_ACTOR=substrate-container
EXPOSE 3100

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -fsS "http://localhost:${PORT:-3100}/health" || exit 1

CMD ["node", "node_modules/@mnmal-ai/substrate/dist/substrate.js", "serve"]
