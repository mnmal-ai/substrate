# @mnmal-ai/substrate

The `substrate` binary: the server, the stdio MCP server, and the runtime scaffolder, plus `substrate-admin` for key management. The same package carries the libraries for plugin authors and clients, and two built-in plugins: `substrate-recall` (kernel) and `substrate-proposals` (coordinator).

It runs as a real install: the binary and its plugins resolve from one shared `node_modules`, so every plugin sees the same copy of every shared package. `substrate init` scaffolds such a runtime directory. Node `>=26.2.0` is required; a durable deployment also needs Postgres with the `pgvector` extension. Walkthrough: [`docs/getting-started.md`](https://github.com/mnmal-ai/substrate/blob/main/docs/getting-started.md).

## Library subpaths

| Import | Contents |
|---|---|
| `@mnmal-ai/substrate/sdk` | Plugin authoring: `defineNamespace`, the field DSL, autoCRUD, engine helpers, `defineBootstrap`, policy combinators, route helpers, and all shared types |
| `@mnmal-ai/substrate/client` | `SubstrateClient`, `watchRows`, client errors, the admin API, and the token and grant helpers |
| `@mnmal-ai/substrate/pack` | The MessagePack wire codec |
| `@mnmal-ai/substrate/testing` | `compose`, `MemorySubstrateServer`, `MemoryDataset`, `MemoryEdgesStore`, `loadPlugins`, `FakeEmbedder`, `PgDataset`, `PgEdgesStore`, the pg migration runners, and the Postgres test-database guards |
| `@mnmal-ai/substrate/recall` | The recall plugin's primitives (`EmbeddingsStore`, `LexicalStore`, `embedAndStore`, …) |
| `@mnmal-ai/substrate/proposals` | The proposals plugin's exports |

A plugin package declares `@mnmal-ai/substrate` as a peer dependency and as a dev dependency (`pnpm add -D @mnmal-ai/substrate@next`).

## Subcommands

| Subcommand | Purpose |
|---|---|
| `substrate serve` | Boot the HTTP/WS server (default port 3100) |
| `substrate mcp` | stdio MCP server; reads `SUBSTRATE_URL`, and `SUBSTRATE_MCP_TOOLS` (csv) to register only some tools |
| `substrate init [dir] [flags]` | Scaffold a runtime directory (interactive; `--yes` for scripted use) |
| `substrate ask <question…>` | Ask a natural-language question (needs `substrate-nl`) |
| `substrate run <script.mts>` | Run a script against a signed, guarded client and print one JSON report |
| `substrate federate <verb>` | Federation onboarding: `enroll` / `join` / `check` |
| `substrate check-enums [--json]` | Report stored values outside a field's declared enum; exits 1 on drift, so it works as a CI gate |
| `substrate normalise-vocab <ns> <Type> <field> [--apply]` | Rewrite stored vocabulary aliases to canonical values (admin) |
| `substrate backfill-field <ns> <Type> <field> --values <file.json> [--apply]` | Write per-row values of one field, metadata preserved (admin) |

`substrate --help` prints the full list; `substrate --version` prints the version.

### MCP tools

`substrate mcp` serves `schema`, `query`, `mutate`, `recall`, `ask`, `whoami`, `propose_type`, `propose_field`, and the admin-gated `drop_namespace` / `drop_type`. It talks to a running server at `SUBSTRATE_URL` and signs requests when `SUBSTRATE_AGENT_KEY_ID` and `SUBSTRATE_AGENT_KEY_PATH` are set. [`docs/surface-parity.md`](https://github.com/mnmal-ai/substrate/blob/main/docs/surface-parity.md) maps what each surface (HTTP, MCP, WS, SSE) offers.

### `substrate ask`

```bash
substrate ask [--ns <namespace>] [--project <name>] [--json] <question…>
```

Posts the question to `POST /substrate/v1/nl` on `SUBSTRATE_URL` and prints the answer. `--ns` defaults to `SUBSTRATE_NAMESPACE`, and one of the two is required; `--project` defaults to the current directory's name. Human output leads with the frame line (`▸ <ns>/<Type> · parser · 3 rows`); a frame the engine rejected prints `· rejected` and the errors. `--json` prints the raw `{ outcome, trail }`. Exit codes: `0` answered, `1` refused / engine errors / request failed, `2` usage or configuration error.

### `substrate run`

```bash
substrate run <script.mts> [--dry-run | --write] [--max-writes <n>] [--out <file>]
```

Imports the script and calls its default export with a `ScriptContext` (`query`, `queryAll`, `mutate`, `log`), so one call can chain many reads and writes and return one result. The client is signed from `SUBSTRATE_URL`, `SUBSTRATE_AGENT_KEY_ID` and `SUBSTRATE_AGENT_KEY_PATH`; an unsigned run is refused.

```ts
import type { ScriptContext } from '@mnmal-ai/substrate/client';

export default async function (s: ScriptContext) {
  const open = await s.queryAll('cortext/Todo', {
    params: { where: { status: { eq: 'open' } }, limit: 100 },
    fields: { id: true, project: true }
  });
  return { open: open.length };
}
```

Guardrails:

- **Read-only by default.** `mutate` throws unless `--dry-run` (records each payload, sends nothing, returns `null`) or `--write` (sends up to `--max-writes` frames, default 50).
- **A rejected frame throws.** A query whose key is missing from `data`, or a mutate the server refused, fails the run with the server's error rather than reading as empty.
- **Truncation is reported.** `query` adds a warning when a result has `hasMore`; `queryAll` pages to the end.

Stdout carries one JSON report, `{ ok, kid, mode, result, error?, mutations, warnings, stats }`. `mutations` lists every payload with `applied`, including those sent before a failure. `--out` writes the report to a file and prints a one-line summary. `.mts` scripts run as-is: the Node this package requires strips types natively. Exit codes: `0` ok, `1` the script failed, `2` usage or configuration error.

The pieces are exported for use outside the CLI: `createClientFromEnv()` builds the same signed client, and `runScript()` runs a function against the guarded context.

### `substrate-admin`

A separate binary for key management: `bootstrap` (seed the genesis admin key), `doctor` (check a deployment end to end), `onboard`, `list`, `register`, `update`, `rotate`, `revoke`. `substrate-admin --help` documents each.

## Install

```bash
# 1. Scaffold a runtime directory (package.json, .env, and for postgres a compose file).
npx @mnmal-ai/substrate@next init ./my-runtime

# 2. Install one shared node_modules: the binary and every chosen plugin.
cd my-runtime
pnpm install

# 3. Run.
set -a && source .env && set +a
./node_modules/.bin/substrate serve
```

`substrate init` writes a `package.json` pinning `@mnmal-ai/substrate` and the chosen optional plugins, a `.npmrc` for the `@mnmal-ai` registry, a `.env` with `SUBSTRATE_PLUGIN_DIR=.`, a `substrate-recall.config.json` for the embedder, and, unless `--store=memory`, a `docker-compose.yml` running `pgvector/pgvector:pg17`. Flags: `--store=memory|postgres`, `--port`, `--pg-port`, `--plugins=<csv>` (from `cortext`, `substrate-nl`, `substrate-sentinel`; none by default), `--embedder=minilm|bge-base|ollama|none`, `--tls --tls-cert-path --tls-key-path`, `--substrate-url`, `--yes`, `--force`.

`SUBSTRATE_PLUGIN_DIR` is the directory whose `node_modules/` holds the plugins; in a scaffolded runtime that is the runtime directory itself. Recall and proposals load from `@mnmal-ai/substrate` itself, so they are present whenever the binary is installed there. Kernel plugins (`substrate-recall`, `substrate-nl`) compose first, then coordinators (`substrate-proposals`, `substrate-sentinel`, …), alphabetical within each tier. Per-plugin overrides live at `<SUBSTRATE_PLUGIN_DIR>/<pkg-basename>.config.json`. With `SUBSTRATE_PLUGIN_DIR` unset the binary boots with only the `_system` admin namespace and `/health`.

### Adding a plugin

```bash
pnpm add @mnmal-ai/substrate-sentinel@next
# then restart `substrate serve`
```

An optional config override sits next to `package.json`:

```bash
cat > substrate-recall.config.json <<'EOF'
{ "embedder": { "kind": "onnx", "model": "all-MiniLM-L6-v2", "dimension": 384, "cacheDir": "/abs/path/models" } }
EOF
```

`kind: "onnx"` runs the model in-process and needs `fastembed` installed in the runtime (the embedder code itself ships in `@mnmal-ai/substrate`); `substrate init` adds it for `--embedder=minilm` (the default) and `--embedder=bge-base`. `kind: "ollama"` takes a `baseUrl` instead.

## Docker

The repository's `docker-compose.yml` runs this binary with `substrate-nl` and `substrate-sentinel` next to a pgvector Postgres. The image, built from [`apps/substrate-image/Dockerfile`](https://github.com/mnmal-ai/substrate/blob/main/apps/substrate-image/Dockerfile), lays out the binary and plugins as one runtime with `SUBSTRATE_PLUGIN_DIR=/app`, serves on port 3100 with a `/health` healthcheck, and sets `SUBSTRATE_SYSTEM_ACTOR=substrate-container`.

## Environment variables

The main ones; `substrate --help` and the header of `apps/substrate/src/main.ts` list the rest.

| Var | Purpose |
|---|---|
| `SUBSTRATE_DATABASE_URL` | `memory` (default, ephemeral) or `postgres://...` |
| `SUBSTRATE_PLUGIN_DIR` | Plugin install root. The loader scans `<dir>/node_modules/{*,@*/*}/package.json` for packages with a `substrate` manifest and merges each plugin's `default-config.json` with `<dir>/<basename>.config.json`. |
| `PORT` / `HOST` | Listen address (default `3100` / `0.0.0.0`) |
| `SUBSTRATE_SYSTEM_ACTOR` | Who the deployment writes as while auth is off. Required in that case: the server refuses to boot rather than write unattributed rows. |
| `SUBSTRATE_AUTH_MODE` | `required` or `attribute` (anonymous callers allowed on non-admin routes). Setting it, or `SUBSTRATE_AUTH_KEY_REGISTRY`, enables auth. |
| `SUBSTRATE_AUTH_KEY_REGISTRY` | Path to a JSON key registry file. Without it, auth reads keys registered in Postgres with `substrate-admin`. |
| `SUBSTRATE_PUBLIC_ORIGIN` | The origins callers reach this server by, comma-separated (`https://host:3100,https://alias`). A token whose `aud` names none of them is refused. **Required when auth is enabled and `HOST` is not loopback**; on loopback it defaults to the loopback origins. |
| `SUBSTRATE_STREAM_TICKET_SECRET` | HMAC key signing SSE stream tickets. **Required when auth is enabled**; at least 16 characters. The ticket signature is the only authentication on `GET /substrate/v1/stream` and `GET /substrate/v1/subscribe`, because `EventSource` can send no header or body. Rotating it invalidates every outstanding ticket. |
| `SUBSTRATE_TLS_KEY_PATH` / `SUBSTRATE_TLS_CERT_PATH` / `SUBSTRATE_TLS_CA_PATH` | Serve HTTPS. Key and cert are required together. |
| `SUBSTRATE_NAMESPACE` | Default namespace for recall requests that omit one. |
| `SUBSTRATE_SWEEP_INTERVAL_MS` | Edge-sweep cadence (default 300000) |
| `SUBSTRATE_CORS_ORIGINS` | Comma-separated allowed origins, or `*`. Unset registers no CORS handling. |

Natural-language query and the recall embedder are not configured by environment: they read `substrate-nl.config.json` and `substrate-recall.config.json` in the plugin directory.

## Documentation

- [Getting started](https://github.com/mnmal-ai/substrate/blob/main/docs/getting-started.md)
- [Design spec](https://github.com/mnmal-ai/substrate/blob/main/docs/substrate-from-first-principles.md)
- [Plugin author guide](https://github.com/mnmal-ai/substrate/blob/main/docs/plugin-author-guide.md)

## License

Apache-2.0. See [LICENSE](https://github.com/mnmal-ai/substrate/blob/main/LICENSE).
