# Getting started with Substrate

This guide takes you from nothing to a running Substrate with its plugins loaded, and explains what each piece is for. It assumes you know what Postgres and npm-style installs are, and nothing about Substrate.

## 1. What Substrate is

Substrate is a **typed data engine for agents**. You declare types (a `Task`, an `Event`, an `Observation`) and Substrate gives you query, mutate and subscribe operations for them without writing handlers. Types come from **plugins**: packages that claim a namespace and register their schema at boot. Every operation names its target with a qualified frame key, `<namespace>/<Type>` for queries and `<namespace>/<mutation>` for mutations.

The binary itself is a thin shell: it loads plugins from a shared `node_modules`, opens a store, and serves requests over HTTP, WebSocket, SSE and MCP. Binary + plugins + store, three pieces that compose at runtime.

## 2. The pieces

**`@mnmal-ai/substrate`: the binary.** A Node.js process holding the resolver engine, autoCRUD, the query/mutate/subscribe protocol and the transports. It knows no application types; those come from plugins. It keeps no state of its own: restart it and it picks up from the store.

**`SUBSTRATE_DATABASE_URL`: the store.** Two modes:

- `memory`: data lives in the process. Zero setup, gone on restart. Good for exploration and tests.
- `postgres://...`: durable. Postgres needs the [pgvector](https://github.com/pgvector/pgvector) extension, because the recall plugin stores embedding vectors next to rows. The `pgvector/pgvector:pg17` image has it.

**`SUBSTRATE_PLUGIN_DIR`: the plugin root.** A plugin is a package with a `"substrate"` field in its `package.json` naming its tier and entry point. The loader scans `node_modules` under `SUBSTRATE_PLUGIN_DIR` for such packages and composes them in tier order: kernel plugins (engine extensions such as `substrate-recall`) first, then coordinators (plugins that own namespaces). A plugin contributes namespaces, resolvers and routes under `/substrate/v1/plugins/<name>/`. Two plugins are built into `@mnmal-ai/substrate` and load whenever it sits in `SUBSTRATE_PLUGIN_DIR`: `substrate-recall` (kernel) and `substrate-proposals` (coordinator).

`SUBSTRATE_PLUGIN_DIR=.` means "the runtime directory's own `node_modules`". The binary **and** its plugins share one `node_modules` tree, so there is one copy of every shared library and no cross-copy `instanceof` surprises.

## 3. Run it with Docker

The repository's `docker-compose.yml` is the whole stack in one command: a pgvector Postgres, and a server image holding the binary (with its built-in plugins) and the `substrate-nl` and `substrate-sentinel` plugins. You need Docker with Compose.

```bash
git clone https://github.com/mnmal-ai/substrate.git && cd substrate
docker compose up -d
docker compose logs substrate
```

The first `up` builds the image, which takes a few minutes. The log ends with the boot banner:

```
@mnmal-ai/substrate listening at http://0.0.0.0:3100
store: postgres://substrate:<redacted>@postgres:5432/substrate
coordinators: substrate-sentinel, substrate-proposals
kernel: substrate-nl, substrate-recall
plugin-dir: /app
```

The `coordinators:` and `kernel:` lines list the plugins that loaded. Data lives in the `postgres_data` volume and survives `docker compose down`; `down -v` deletes it.

The stack starts with keyword recall only. For dense recall, add `docker-compose.embed.yml`, which runs [Ollama](https://ollama.com) beside the server, pulls `bge-base-en-v1.5` (768-d, about 220 MB, once, into the `ollama_models` volume) and mounts a recall config pointing at it:

```bash
docker compose -f docker-compose.yml -f docker-compose.embed.yml up -d
curl http://localhost:3100/substrate/v1/embed-stats   # "enabled": true
```

Rows are embedded only for types whose namespace declares an `embed.source`, so `embeddedTypes` stays empty until you load such a plugin. Use the same `-f` pair for every later `docker compose` command, or the server restarts without the embedder.

### Verify

**The engine is up:**

```bash
curl http://localhost:3100/health
# {"status":"ok","version":"<version>","uptimeSeconds":3}
```

**A plugin loaded.** `/health` only says the binary started. The plugin's onboard route describes its namespace:

```bash
curl http://localhost:3100/substrate/v1/plugins/substrate-proposals/onboard
```

A `404` means the plugin did not load; check the `coordinators:` line. Then query it (an empty list is correct, nothing has been written yet):

```bash
curl -s -X POST http://localhost:3100/substrate/v1/query \
  -H 'content-type: application/json' \
  -d '{"_system_proposals/NamespaceProposal":{"params":{"limit":3},"fields":{"id":true,"ns":true}}}'
```

Adding types through the plugin needs auth on and a key granted `substrate.propose` ([`plugins/substrate-proposals`](../plugins/substrate-proposals/README.md)).

The response is an envelope with `data` keyed by the frame key. Check `errors` before reading `data`: a rejected frame comes back with its key missing from `data` and the reason in `errors`, under HTTP 200.

**Everything the server offers** is described by one request, which a fresh agent can read to learn the frame grammar and every loaded plugin's surface:

```bash
curl http://localhost:3100/substrate/v1/onboard
```

## 4. Run it from npm: `substrate init`

To run Substrate as a Node process you manage, with your own choice of plugins, scaffold a runtime directory instead.

### Prerequisites

- **Node `>=26.2.0`** and **pnpm**. [mise](https://mise.jdx.dev/) is one way to manage both; your system package manager is another.
- **For a persistent store, Docker** (or your own Postgres with pgvector). The scaffold writes a `docker-compose.yml` for it. For a first run you can skip this and use the memory store.

### Scaffold

`substrate init` writes a runtime directory: a self-contained folder that is your Substrate installation.

```bash
npx @mnmal-ai/substrate@next init ~/my-substrate
```

It asks for the plugin set, store (`postgres` or `memory`), ports, embedder, TLS, and the public URL clients will use. For a non-interactive first run with the memory store and only the built-in plugins:

```bash
npx @mnmal-ai/substrate@next init ~/my-substrate --yes --store=memory --plugins= --port=3100
```

Flags: `--store=memory|postgres` (default `postgres`), `--port` (default 3100), `--pg-port` (default 5433), `--plugins=<csv>` (any of `cortext`, `substrate-nl`, `substrate-sentinel`; none by default), `--embedder=minilm|bge-base|ollama|none` (default `minilm`), `--tls --tls-cert-path=… --tls-key-path=…`, `--substrate-url`, `--yes`, `--force` (scaffold into an existing directory).

Recall and proposals are built into the binary, so they are never in the plugin list.

#### What was created

```
~/my-substrate/
├── package.json                  # @mnmal-ai/substrate (recall + proposals built in) + the chosen plugins
├── pnpm-workspace.yaml           # this dir is the workspace root; approves two prebuilt deps
├── .env                          # SUBSTRATE_DATABASE_URL, SUBSTRATE_PLUGIN_DIR=., PORT, SUBSTRATE_SYSTEM_ACTOR
├── substrate-recall.config.json  # embedder config (absent with --embedder=none)
├── README.md                     # quickstart for this exact config
│
│   (postgres mode only)
├── .env.docker                   # postgres password, user, database name
├── docker-compose.yml            # pgvector/pgvector:pg17 on 127.0.0.1:<pg-port>
├── postgres-init/
│   └── 01-create-database.sql
└── data/pg/                      # postgres data volume
```

**`package.json`** lists `@mnmal-ai/substrate` and each chosen plugin as dependencies, pinned to the binary's major, plus `fastembed` when the embedder runs in-process (`minilm`, `bge-base`). One `pnpm install` puts them all in a single shared `node_modules`.

**`.env`** holds what the binary reads at boot:

```
SUBSTRATE_DATABASE_URL=memory
SUBSTRATE_PLUGIN_DIR=.
PORT=3100
SUBSTRATE_SYSTEM_ACTOR=local-dev
```

`SUBSTRATE_SYSTEM_ACTOR` is who the deployment writes as while auth is off; every row it writes carries it as `createdBy`. The server refuses to boot without auth and without an actor, rather than write rows attributed to nobody.

### Install and run

```bash
cd ~/my-substrate
pnpm install
```

This installs the binary and every plugin into one deduplicated tree, so `@mnmal-ai/substrate` exists exactly once and the binary and plugins share the same in-process objects.

**Postgres mode only**, start the store first:

```bash
docker compose --env-file .env.docker up -d
docker compose ps        # wait until postgres reports healthy
```

The compose file publishes postgres on `127.0.0.1:5433` (or your `--pg-port`) and creates the database named in `.env.docker`. The scaffold ships the backup sidecar commented out: no backups run until you enable it.

**Start Substrate:**

```bash
set -a && source .env && set +a
./node_modules/.bin/substrate serve
```

`set -a && source .env && set +a` exports every line of `.env`; Substrate reads its configuration from the environment, not from a config file. The binary scans `SUBSTRATE_PLUGIN_DIR`, composes the plugins it finds, and starts serving. You should see something like:

```
@mnmal-ai/substrate listening at http://0.0.0.0:3100
store: memory

┌─ memory mode ─────────────────────────────────────────────────────┐
│ SUBSTRATE_DATABASE_URL=memory — running with in-memory store.     │
│ Data is NOT persisted; all writes vanish on restart.              │
│ …                                                                 │
└───────────────────────────────────────────────────────────────────┘
_system: memory-backed (keys ephemeral)
coordinators: substrate-proposals
kernel: substrate-recall
plugin-dir: /home/you/my-substrate
```

The `coordinators:` and `kernel:` lines list the plugins that loaded; here, only the two built-ins.

Then run the checks in [Verify](#verify) above.

## 5. Next steps

### Add a plugin

The Docker image already carries every plugin in this repository. In an npm runtime, install an optional plugin next to the binary:

```bash
pnpm add @mnmal-ai/substrate-sentinel@next
```

then restart `substrate serve`; the binary rescans `node_modules` at boot. Plugin config overrides go in `<plugin-basename>.config.json` next to `package.json`, for example `substrate-sentinel.config.json`.

Plugins in this repository (recall and proposals are built into `@mnmal-ai/substrate`; the others install separately):

| Plugin | Tier | Purpose |
|---|---|---|
| `substrate-recall` (built in) | kernel | Semantic recall: dense vectors and keyword ranking, fused |
| `@mnmal-ai/substrate-nl` | kernel | Natural-language questions answered as frames (`POST /substrate/v1/nl`) |
| `substrate-proposals` (built in) | coordinator | Add namespaces, types and fields at runtime |
| `@mnmal-ai/substrate-sentinel` | coordinator | Registry for dynamic federation bridge discovery |

### Connect an agent over MCP

`substrate mcp` is a stdio MCP server that talks to a running instance at `SUBSTRATE_URL`. Register it with your MCP client, for example:

```json
{
  "mcpServers": {
    "substrate": {
      "command": "/abs/path/to/my-substrate/node_modules/.bin/substrate",
      "args": ["mcp"],
      "env": { "SUBSTRATE_URL": "http://localhost:3100" }
    }
  }
}
```

It serves `schema`, `query`, `mutate`, `recall`, `ask`, `whoami`, `propose_type`, `propose_field`, and the admin-gated `drop_namespace` / `drop_type`. [`surface-parity.md`](surface-parity.md) maps what each surface (HTTP, MCP, WS, SSE) can do.

### Semantic recall and the embedder

Recall retrieves rows by semantic similarity (`recall` MCP tool, `POST /substrate/v1/recall`, the `embeddingSimilar` filter operator) and also ranks by keyword, fusing the two, so a small model loses little. It needs an embedder for the built-in `substrate-recall` plugin, configured in `substrate-recall.config.json` at the runtime root, not in `.env`. The Docker image ships no embedder; `docker-compose.embed.yml` adds one ([§3](#3-run-it-with-docker)). In an npm runtime, `--embedder` picks the model:

| `--embedder` | Model | Runs | Notes |
|---|---|---|---|
| `minilm` (default) | all-MiniLM-L6-v2, 384-d | in-process | Fast on CPU. Adds `fastembed` (about 540 MB, mostly ONNX Runtime). |
| `bge-base` | bge-base-en-v1.5, 768-d | in-process | Better on paraphrase, much slower to embed on CPU. Same install. |
| `ollama` | bge-m3, 1024-d | local [Ollama](https://ollama.com) | Needs `ollama pull bge-m3`. |
| `none` | | | No dense recall; keyword ranking still works. |

The in-process models download into `models/` under the runtime on first use. The default config:

```json
{
  "embedder": {
    "kind": "onnx",
    "model": "all-MiniLM-L6-v2",
    "dimension": 384,
    "cacheDir": "/abs/path/to/runtime/models"
  }
}
```

On Postgres the vectors live in the `embeddings` table; in memory mode they vanish on restart with everything else. Pick the model before you have data: changing it later means re-embedding every row.

### Running it for real

This guide stops at "Substrate is up locally". A production install also wants:

- **Auth.** Set `SUBSTRATE_AUTH_MODE=required` (or `attribute`, which lets anonymous callers through on non-admin routes), set `SUBSTRATE_STREAM_TICKET_SECRET`, set `SUBSTRATE_PUBLIC_ORIGIN` to the origins callers reach the server by (e.g. `https://substrate.example.com:3100`; required with auth on a non-loopback `HOST`, which includes the default `0.0.0.0`), and register keys with `substrate-admin bootstrap` / `substrate-admin register`. Every token must carry `aud`, naming one of those origins, or it is refused. A token signed by an RS256/ES256 key must also carry `exp` and `ns` (the namespaces it may touch); one without `ns` is refused rather than read as `*`, so a third-party issuer must emit both. `substrate-admin doctor` checks the result.
- **TLS.** `SUBSTRATE_TLS_CERT_PATH` and `SUBSTRATE_TLS_KEY_PATH`, or a reverse proxy in front.
- **Supervision.** systemd or a container orchestrator, restarting on failure. The Docker image (`apps/substrate-image/Dockerfile`) has a `/health` healthcheck.
- **Backups.** Scheduled `pg_dump`. The scaffold's compose file includes a commented-out backup sidecar to start from.
- **Secrets out of your shell history.** An environment file readable only by the service user.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `connection refused` on `/health` | Substrate did not start | Check `docker compose logs substrate`, or the terminal running `substrate serve` |
| Boot refuses with no system actor | Auth is off and `SUBSTRATE_SYSTEM_ACTOR` is unset | Load `.env` (it sets one), or enable auth |
| A plugin is missing from the `coordinators:` / `kernel:` lines | Not installed, or `SUBSTRATE_PLUGIN_DIR` wrong | Confirm `pnpm install` ran and `.env` has `SUBSTRATE_PLUGIN_DIR=.` |
| Data gone after restart | Memory store | Expected; scaffold with `--store=postgres` |
| Postgres healthcheck failing | Image still pulling or initialising | Wait, then `docker compose ps` |
