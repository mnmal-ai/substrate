#!/usr/bin/env bash
# Stop what scripts/substrate-up.sh started: the Substrate server it launched (by its
# pid file) and the memory-demo-substrate-pg container. Nothing else.
#
#   scripts/substrate-down.sh           stop; data stays in the memory-demo-substrate-pgdata volume
#   scripts/substrate-down.sh --purge   also remove that container and volume
set -euo pipefail

DEMO="$(cd "$(dirname "$0")/.." && pwd)"
RUN="$DEMO/run/substrate"
PG_CONTAINER=memory-demo-substrate-pg
PG_VOLUME=memory-demo-substrate-pgdata

log() { printf '[substrate-down] %s\n' "$*"; }

if [ -s "$RUN/server.pid" ]; then
  pid="$(cat "$RUN/server.pid")"
  # Only signal the process if it is still the substrate server we started.
  if kill -0 "$pid" 2>/dev/null && ps -o command= -p "$pid" | grep -q 'substrate.js serve'; then
    kill "$pid"
    for _ in $(seq 1 40); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
    kill -0 "$pid" 2>/dev/null && kill -9 "$pid"
    log "stopped substrate (pid $pid)"
  else
    log "substrate not running"
  fi
  rm -f "$RUN/server.pid"
else
  log "substrate not running (no pid file)"
fi

if docker container inspect "$PG_CONTAINER" >/dev/null 2>&1; then
  if [ "$(docker container inspect -f '{{.State.Running}}' "$PG_CONTAINER")" = true ]; then
    docker stop "$PG_CONTAINER" >/dev/null
    log "stopped $PG_CONTAINER"
  fi
  if [ "${1:-}" = "--purge" ]; then
    docker rm "$PG_CONTAINER" >/dev/null
    docker volume rm "$PG_VOLUME" >/dev/null
    rm -f "$RUN/pg-password"
    log "removed $PG_CONTAINER and volume $PG_VOLUME"
  fi
fi
