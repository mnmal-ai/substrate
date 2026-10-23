#!/usr/bin/env bash
# Start Substrate for the memory demo, in the background, and wait until it is healthy.
#
#   1. Postgres 17 + pgvector in Docker: container memory-demo-substrate-pg,
#      volume memory-demo-substrate-pgdata, 127.0.0.1:5441.
#   2. A plugin install root under run/substrate/runtime: @mnmal-ai/substrate
#      (which carries recall) symlinked from the source checkout, the lumen plugin
#      from adapters/substrate-plugin, and the recall config (Ollama bge-m3).
#   3. `substrate serve` from the source checkout's build, on 127.0.0.1:3100,
#      with auth off and a system actor.
#
# The source checkout is SUBSTRATE_SRC: a clone of mnmal-ai/substrate, built
# (mise install && pnpm install && pnpm build). Inside the substrate repo, use the
# repo itself: SUBSTRATE_SRC=$(git rev-parse --show-toplevel).
#
# Touches nothing else: no other container, no other port. Idempotent: running
# it again while everything is up just re-checks health.
# Stop with scripts/substrate-down.sh.
set -euo pipefail

DEMO="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${SUBSTRATE_SRC:-$HOME/Developer/mnmal-ai/memory-demo-src/substrate}"
RUN="$DEMO/run/substrate"
RUNTIME="$RUN/runtime"
PLUGIN="$DEMO/adapters/substrate-plugin"
BIN="$SRC/apps/substrate/dist/substrate.js"

PG_CONTAINER=memory-demo-substrate-pg
PG_VOLUME=memory-demo-substrate-pgdata
PG_IMAGE=pgvector/pgvector:pg17
PG_PORT=5441
PG_DB=substrate_demo
SUBSTRATE_PORT="${SUBSTRATE_PORT:-3100}"
SUBSTRATE_URL="http://127.0.0.1:$SUBSTRATE_PORT"
OLLAMA_URL=http://127.0.0.1:11434
# bge-m3 (1024-d) is the Ollama embedder Substrate's docs use. SUBSTRATE_DEMO_EMBED_MODEL=
# nomic-embed-text (768-d) is faster; changing it needs --purge first, because
# stored vectors must all come from one model.
EMBED_MODEL="${SUBSTRATE_DEMO_EMBED_MODEL:-bge-m3}"
case "$EMBED_MODEL" in
  bge-m3) EMBED_DIM=1024 ;;
  nomic-embed-text) EMBED_DIM=768 ;;
  *) EMBED_DIM="${SUBSTRATE_DEMO_EMBED_DIM:?set SUBSTRATE_DEMO_EMBED_DIM for $EMBED_MODEL}" ;;
esac

log() { printf '[substrate-up] %s\n' "$*"; }
die() { printf '[substrate-up] ERROR: %s\n' "$*" >&2; exit 1; }

[ -f "$BIN" ] || die "no build at $SRC (run: mise install && pnpm install && pnpm build there)"
NODE="$(cd "$SRC" && mise which node)"
[ -x "$NODE" ] || die "mise could not resolve node for $SRC"

mkdir -p "$RUN" "$RUNTIME/node_modules/@mnmal-ai" "$PLUGIN/node_modules/@mnmal-ai"

# --- Ollama embedder -------------------------------------------------------
curl -sf "$OLLAMA_URL/api/tags" | grep -q "\"$EMBED_MODEL" \
  || die "Ollama at $OLLAMA_URL is not serving $EMBED_MODEL (ollama pull $EMBED_MODEL)"

# --- Postgres --------------------------------------------------------------
if [ ! -s "$RUN/pg-password" ]; then
  (umask 077 && openssl rand -hex 24 > "$RUN/pg-password")
fi
PG_PASSWORD="$(cat "$RUN/pg-password")"

if docker container inspect "$PG_CONTAINER" >/dev/null 2>&1; then
  if [ "$(docker container inspect -f '{{.State.Running}}' "$PG_CONTAINER")" != true ]; then
    log "starting existing container $PG_CONTAINER"
    docker start "$PG_CONTAINER" >/dev/null
  fi
else
  log "creating container $PG_CONTAINER ($PG_IMAGE) on 127.0.0.1:$PG_PORT"
  docker run -d --name "$PG_CONTAINER" \
    --label memory-demo=substrate \
    -e POSTGRES_USER=substrate -e POSTGRES_PASSWORD="$PG_PASSWORD" -e POSTGRES_DB="$PG_DB" \
    -p "127.0.0.1:$PG_PORT:5432" \
    -v "$PG_VOLUME:/var/lib/postgresql/data" \
    --health-cmd "pg_isready -U substrate -d $PG_DB" \
    --health-interval 1s --health-timeout 3s --health-retries 60 \
    "$PG_IMAGE" >/dev/null
fi

for _ in $(seq 1 90); do
  [ "$(docker container inspect -f '{{.State.Health.Status}}' "$PG_CONTAINER")" = healthy ] && break
  sleep 1
done
[ "$(docker container inspect -f '{{.State.Health.Status}}' "$PG_CONTAINER")" = healthy ] \
  || die "postgres did not become healthy (docker logs $PG_CONTAINER)"
log "postgres healthy"

# --- Plugin install root ---------------------------------------------------
# The binary loads the packages listed under `dependencies` in
# <SUBSTRATE_PLUGIN_DIR>/package.json from its node_modules. @mnmal-ai/substrate
# itself declares recall. Symlinks keep one copy of the code, as the dev compose does.
ln -sfn "$SRC/apps/substrate" "$RUNTIME/node_modules/@mnmal-ai/substrate"
ln -sfn "$PLUGIN" "$RUNTIME/node_modules/lumen-substrate-plugin"
# The lumen plugin imports the SDK; point it at the same copy the binary uses.
ln -sfn "$SRC/apps/substrate" "$PLUGIN/node_modules/@mnmal-ai/substrate"
cat > "$RUNTIME/package.json" <<JSON
{
  "private": true,
  "dependencies": { "@mnmal-ai/substrate": "*", "lumen-substrate-plugin": "*" }
}
JSON

# A write embeds its row before it returns. The default 30 s budget would let a
# slow embedding commit the row with no vector and no error, so allow longer.
cat > "$RUNTIME/substrate-recall.config.json" <<JSON
{
  "embedder": {
    "kind": "ollama",
    "baseUrl": "$OLLAMA_URL",
    "model": "$EMBED_MODEL",
    "dimension": $EMBED_DIM
  },
  "writeEmbedTimeoutMs": 120000
}
JSON

# Read by adapters/substrate.ts to build the MCP config.
cat > "$RUN/runtime.json" <<JSON
{
  "substrateUrl": "$SUBSTRATE_URL",
  "src": "$SRC",
  "embedModel": "$EMBED_MODEL",
  "node": "$NODE",
  "substrateBin": "$BIN"
}
JSON

# --- Substrate server ------------------------------------------------------
healthy() { curl -sf "$SUBSTRATE_URL/health" >/dev/null 2>&1; }

if [ -s "$RUN/server.pid" ] && kill -0 "$(cat "$RUN/server.pid")" 2>/dev/null && healthy; then
  log "substrate already running (pid $(cat "$RUN/server.pid")) at $SUBSTRATE_URL"
else
  if lsof -nP -iTCP:"$SUBSTRATE_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    die "port $SUBSTRATE_PORT is taken by something this script did not start"
  fi
  log "starting substrate serve on $SUBSTRATE_URL (log: run/substrate/server.log)"
  (
    cd "$RUN"
    SUBSTRATE_DATABASE_URL="postgres://substrate:$PG_PASSWORD@127.0.0.1:$PG_PORT/$PG_DB" \
    SUBSTRATE_PLUGIN_DIR="$RUNTIME" \
    SUBSTRATE_SYSTEM_ACTOR=memory-demo \
    HOST=127.0.0.1 \
    PORT="$SUBSTRATE_PORT" \
      nohup "$NODE" "$BIN" serve >> "$RUN/server.log" 2>&1 &
    echo $! > "$RUN/server.pid"
  )
  for _ in $(seq 1 120); do
    healthy && break
    kill -0 "$(cat "$RUN/server.pid")" 2>/dev/null || die "substrate exited during boot; see $RUN/server.log"
    sleep 0.5
  done
  healthy || die "substrate did not answer /health; see $RUN/server.log"
fi

curl -sf "$SUBSTRATE_URL/substrate/v1/schema/lumen" >/dev/null \
  || die "substrate is up but the lumen namespace is missing; see $RUN/server.log"
log "substrate healthy at $SUBSTRATE_URL with namespace lumen"
