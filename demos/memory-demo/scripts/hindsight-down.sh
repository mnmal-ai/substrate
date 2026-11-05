#!/usr/bin/env bash
# Stop what scripts/hindsight-up.sh started (by its pid file). Its data stays in pg0.
set -euo pipefail
RUN="$(cd "$(dirname "$0")/.." && pwd)/run/hindsight"
log() { printf '[hindsight-down] %s\n' "$*"; }
if [ -s "$RUN/server.pid" ]; then
  pid="$(cat "$RUN/server.pid")"
  if kill -0 "$pid" 2>/dev/null && ps -o command= -p "$pid" | grep -q 'hindsight-api'; then
    kill "$pid"
    for _ in $(seq 1 40); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
    kill -0 "$pid" 2>/dev/null && kill -9 "$pid"
    log "stopped hindsight (pid $pid)"
  else
    log "hindsight not running"
  fi
  rm -f "$RUN/server.pid"
else
  log "hindsight not running (no pid file)"
fi
