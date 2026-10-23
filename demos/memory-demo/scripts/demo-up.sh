#!/bin/bash
# One command before the meeting: both systems up, the base memory set loaded,
# both search paths warmed, the page open.   scripts/demo-up.sh [--reload]
set -euo pipefail
cd "$(dirname "$0")/.."
unset NODE_OPTIONS ANTHROPIC_API_KEY

docker info >/dev/null 2>&1 || { echo "Start Docker Desktop first."; exit 1; }
scripts/substrate-up.sh
scripts/obsidian-up.sh
scripts/hindsight-up.sh

# Make sure Substrate and obsidian-mind hold the base 253-memory set.
want=$(node -e 'console.log(require("./data/memories.json").length)')
have=$(curl -s -X POST localhost:3100/substrate/v1/query -H 'content-type: application/json' \
  -d '{"lumen/Task":{"params":{"limit":2000},"fields":{"id":true}}}' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).data["lumen/Task"].length)}catch{console.log(0)}})')
if [ "${1:-}" = "--reload" ] || [ "$have" != "150" ]; then
  echo "Loading the base set ($want memories) into Substrate and obsidian-mind..."
  node eval/ingest.ts --only obsidian,substrate
fi

# Hindsight is loaded separately: its LLM extracts facts from every memory, which
# takes 15-20 minutes and millions of subscription tokens, so it is never automatic.
hs_docs=$(curl -s localhost:8888/v1/default/banks/lumen/stats | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).total_documents??0)}catch{console.log(0)}})')
if [ "$hs_docs" != "$want" ]; then
  echo "Hindsight holds $hs_docs of $want memories. Load it with: node eval/ingest.ts --only hindsight"
fi

# A live change left made (Shared page) is put back, so the demo starts from the original.
if [ -s .state/change.json ]; then
  echo "Putting back the live change left from last time..."
  node eval/change.ts undo
fi

# Warm both search paths so the first live question isn't paying model load time.
# Ollama drops an idle model after 5 minutes, which would put a ~2 s reload in
# front of the first Substrate recall after every pause in the talk: pin it until
# `ollama stop bge-m3`. The pin must use the options Substrate's embedder sends
# (num_ctx and num_batch at the model's context length); with any others,
# Substrate's first request reloads the model and the reload drops the pin.
echo "Warming up both systems..."
OLLAMA="${OLLAMA_URL:-http://localhost:11434}"
ctx=$(curl -sf "$OLLAMA/api/show" -d '{"model":"bge-m3"}' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const i=JSON.parse(s).model_info??{};const k=Object.keys(i).find(k=>k.endsWith(".context_length"));console.log(k?i[k]:8192)})')
curl -sf "$OLLAMA/api/embed" \
  -d "{\"model\":\"bge-m3\",\"input\":\"warm\",\"truncate\":true,\"keep_alive\":-1,\"options\":{\"num_ctx\":$ctx,\"num_batch\":$ctx}}" >/dev/null \
  || echo "warning: could not pin bge-m3 in Ollama"
# Recall searches one type per call; touch each type's search once.
for t in Person Project Decision Task Incident; do
  curl -sf -X POST localhost:3100/substrate/v1/recall -H 'content-type: application/json' \
    -d "{\"query\":\"warm up\",\"namespace\":\"lumen\",\"type\":\"$t\",\"k\":5}" >/dev/null \
    || echo "warning: Substrate recall warm-up failed for $t"
done
curl -sf -X POST localhost:8888/v1/default/banks/lumen/memories/recall -H 'content-type: application/json' \
  -d '{"query":"warm up","budget":"low","max_tokens":512}' >/dev/null || echo "warning: Hindsight recall warm-up failed"
node agent/ask.ts obsidian "Who owns the Harbor container platform project? Answer with only the person's full name." >/dev/null 2>&1 || true
node agent/ask.ts substrate "Who owns the Harbor container platform project? Answer with only the person's full name." >/dev/null 2>&1 || true
node agent/ask.ts hindsight "Who owns the Harbor container platform project? Answer with only the person's full name." >/dev/null 2>&1 || true

lsof -ti tcp:4600 | xargs kill 2>/dev/null || true
nohup node web/server.ts > run/web.log 2>&1 &
sleep 1
open http://localhost:4600
echo "Ready: http://localhost:4600"
