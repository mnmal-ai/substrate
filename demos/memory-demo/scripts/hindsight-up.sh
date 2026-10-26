#!/usr/bin/env bash
# Start Hindsight for the memory demo, in the background, and wait until it is healthy.
#
#   scripts/hindsight-up.sh        install on first run (run/hindsight/.venv), then start
#   scripts/hindsight-down.sh      stop it
#
# Hindsight runs natively, not in Docker: its claude-code provider uses this Mac's
# Claude subscription through the Claude Agent SDK, which its docs scope to local,
# personal use. ANTHROPIC_API_KEY is removed so nothing is billed to an API key.
# Data lives in Hindsight's embedded Postgres (pg0). Idempotent: a healthy server
# is left alone.
set -euo pipefail

DEMO="$(cd "$(dirname "$0")/.." && pwd)"
RUN="$DEMO/run/hindsight"
VENV="$RUN/.venv"
PORT="${HINDSIGHT_PORT:-8888}"
URL="http://127.0.0.1:$PORT"
MODEL="${HINDSIGHT_MODEL:-claude-sonnet-5-5}"

log() { printf '[hindsight-up] %s\n' "$*"; }
die() { printf '[hindsight-up] ERROR: %s\n' "$*" >&2; exit 1; }
healthy() { curl -sf "$URL/health" >/dev/null 2>&1; }

if healthy; then log "already healthy at $URL"; exit 0; fi

command -v uv >/dev/null || die "uv is not installed (https://docs.astral.sh/uv/)"
command -v claude >/dev/null || die "Claude Code is not installed; the claude-code provider needs it signed in"
mkdir -p "$RUN"
if [ ! -x "$VENV/bin/hindsight-api" ]; then
  log "installing hindsight-api 1.1.0 into run/hindsight/.venv (about 2 GB, a few minutes)"
  uv venv -q --python 3.12 "$VENV"
  VIRTUAL_ENV="$VENV" uv pip install -q "hindsight-api==1.1.0"
fi

log "starting hindsight-api on $URL (LLM: claude-code / $MODEL; log: run/hindsight/server.log)"
(
  cd "$RUN"
  env -u ANTHROPIC_API_KEY -u NODE_OPTIONS \
    HINDSIGHT_API_HOST=127.0.0.1 \
    HINDSIGHT_API_PORT="$PORT" \
    HINDSIGHT_API_LLM_PROVIDER=claude-code \
    HINDSIGHT_API_LLM_MODEL="$MODEL" \
    HINDSIGHT_API_LLM_MAX_CONCURRENT="${HINDSIGHT_MAX_CONCURRENT:-4}" \
    HINDSIGHT_API_WORKER_ID=memory-demo \
    nohup "$VENV/bin/hindsight-api" > "$RUN/server.log" 2>&1 &
  echo $! > "$RUN/server.pid"
)
for _ in $(seq 1 240); do healthy && break; sleep 0.5; done
healthy || die "hindsight did not become healthy in 120 s (tail run/hindsight/server.log)"
log "hindsight healthy at $URL"
