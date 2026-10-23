# Hindsight setup for the memory demo

What it took to run [Hindsight](https://github.com/vectorize-io/hindsight) (vectorize-io, MIT) on this Mac and put a Claude agent in front of it. Hindsight 1.1.0 (`hindsight-api` from PyPI), 2026-10-22.

## Commands

```bash
scripts/hindsight-up.sh                 # installs on first run, starts the server on 127.0.0.1:8888, waits for health
node eval/ingest.ts --only hindsight    # loads the base set into the "lumen" bank (15-20 minutes, see below)
node agent/ask.ts hindsight "Which queue is the Atlas project moving to?"
scripts/hindsight-down.sh               # stops it; data stays in its embedded Postgres
```

## Setup steps, timed

| # | Step | Time | Downloaded or installed |
|---|------|------|-------------------------|
| 0 | Prerequisites already on the machine: uv, Claude Code signed in to a Claude subscription | none | none |
| 1 | `uv venv --python 3.12` and `uv pip install hindsight-api==1.1.0` into `run/hindsight/.venv` | 339 s | 1.8 GB: the server, its local embedding and reranking stack, the Claude Agent SDK |
| 2 | First start (`hindsight-api`), which sets up the embedded Postgres (pg0) and loads the local models | 78 s | embedding model `BAAI/bge-small-en-v1.5` |
| 3 | Later starts | about 20 s | none |

No plugin, schema or types to write: memories are retained as text, and Hindsight's LLM decides what the facts are. That is the shortest path to a working memory of the three systems.

## The LLM, and what it costs

Hindsight runs an LLM on every retain (fact, entity and relationship extraction), during background consolidation of observations, and for its `reflect` tool. Here it uses the `claude-code` provider with `claude-sonnet-5-5`, so it runs on the Claude subscription through the Claude Agent SDK, with no API key and no metered cost. Hindsight's docs scope this provider to local, personal development, and recommend the `anthropic` provider with an API key for anything shared; that is why it runs natively here, not in Docker.

- **Tokens:** the 10-memory sample used about 189,000 input and 5,000 output tokens of Hindsight's own LLM, about 19,000 per memory including consolidation. The base set's figure is in `results/ingest.json` (`notes`).
- **Time:** retain runs 4 LLM requests at a time (`HINDSIGHT_API_LLM_MAX_CONCURRENT=4`, set in `scripts/hindsight-up.sh`; the default is 32), so loading 253 memories takes minutes, not seconds.
- **Agent answers:** when the agent calls `reflect`, Hindsight's LLM writes the answer. Those tokens are not in the agent's own count, so the runner records them separately (`memoryLlmTokens`).

## What the agent gets

The bank's MCP endpoint (`http://127.0.0.1:8888/mcp/lumen/`) serves 27 tools. The agent gets the six that read memories: `recall`, `reflect`, `list_memories`, `get_memory`, `list_documents`, `get_document`. The rest are denied: the writes (`retain`, `delete_bank`, `clear_memories` and others), as the other systems' agents get no write tools either, and the operation, bank, mental-model and knowledge-page tools. So are Read, Glob and Grep. Its session-start context is one sentence naming the bank and what it holds.

## How the data maps

Each memory is retained as the text a person would store: its kind, title and date, its body, its fields with references resolved to names ("owner: Ana Reyes"), and its related memories by name. `document_id` is the memory's id, `context` its kind, `timestamp` its date and `tags` its kind. `adapters/hindsight.ts` has the rendering.

## What broke, and what I did

1. **The server binds to every interface by default** (`0.0.0.0`). `scripts/hindsight-up.sh` sets `HINDSIGHT_API_HOST=127.0.0.1`.
2. **The worker id defaults to the machine's hostname,** which can carry a person's name. The script sets `HINDSIGHT_API_WORKER_ID=memory-demo`.
3. **An `ANTHROPIC_API_KEY` in the environment would be billed** instead of the subscription. The script starts the server with it removed.
4. **The operations list caps `limit` at 100** (a 422 above it). The adapter counts pending and processing operations through the `status` filter instead.
5. **The bank's `stats` lag behind** while retains are running (it showed 87 documents while 180 were stored). The adapter waits on the retain operations themselves, and on the document list.
6. **Deleting a document leaves the observations built from it.** Background consolidation folds new facts into observations, and those survive the document's deletion: after a temporary decision was deleted, an observation still said the Atlas decision "was later superseded by a decision to use Apache Kafka". Putting a change back therefore ends with clearing and rebuilding the bank's observations (`rebuildObservations` in `adapters/hindsight.ts`): 4 to 6 minutes and 0.9 to 1.1M input tokens of its LLM for this bank. It first waits for consolidation already under way: a job started by the change and still running would otherwise write its observation after the clear. Both restores then check that nothing mentions the temporary decision.
