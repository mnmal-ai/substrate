# substrate

An agent-first typed data substrate. Plugins declare namespaces and types; Substrate gives every type query, mutate and subscribe operations without handler code, and serves them over HTTP, MCP, WebSocket and SSE.

Every operation names its target with a qualified frame key, `<namespace>/<Type>` for queries and `<namespace>/<mutation>` for mutations:

```bash
curl -s -X POST http://localhost:3100/substrate/v1/query \
  -H 'content-type: application/json' \
  -d '{"notes/Note":{"params":{"where":{"title":{"eq":"hello"}},"limit":5},"fields":{"id":true,"body":true}}}'
```

- **Typed, declared once.** A plugin defines its types with `defineNamespace` and a field DSL; autoCRUD derives `create`/`update`/`delete` mutations and list queries, with declarative policies deciding who may do what.
- **One grammar on four surfaces.** The same frames work over HTTP (`/substrate/v1/query`, `/substrate/v1/mutate`), the `substrate mcp` stdio server, WebSocket (`/substrate/v1/ws`, JSON or MessagePack) and SSE. Live subscriptions are WS and SSE.
- **Self-describing.** `GET /substrate/v1/onboard` returns the frame grammar, per-operation instructions and every loaded plugin's surface, so a fresh agent can compose valid frames from one request.
- **Semantic recall.** The built-in `substrate-recall` plugin embeds declared types into pgvector and fuses dense and keyword ranking.
- **Schema at runtime.** With the built-in `substrate-proposals` plugin, an authorised agent can add namespaces, types and fields to a running server, additively and with an audit trail.

## Install and run

Substrate needs Node `>=26.2.0`. A durable deployment needs Postgres with the [pgvector](https://github.com/pgvector/pgvector) extension; an in-memory store is available for trying it out.

### Docker

The quickest way to a running server. `docker compose up` builds the server with the in-tree plugins and starts it next to a pgvector Postgres:

```bash
docker compose up -d
curl http://localhost:3100/health
curl http://localhost:3100/substrate/v1/onboard
```

[`docs/getting-started.md`](docs/getting-started.md) goes on from there.

### npm runtime

`substrate init` scaffolds a runtime directory: the binary (with recall and proposals built in) and any optional plugins in one `node_modules`, a `.env`, and (for Postgres) a compose file.

```bash
npx @mnmal-ai/substrate@next init ~/my-substrate --yes --store=memory --plugins=
cd ~/my-substrate
pnpm install
set -a && source .env && set +a
./node_modules/.bin/substrate serve
```

[`docs/getting-started.md`](docs/getting-started.md) walks through this, including Postgres, the embedder and connecting an MCP client.

### From source

```bash
pnpm install
pnpm build
docker compose up -d postgres   # pgvector/pgvector:pg17 on localhost:5432 (user/password: substrate)
SUBSTRATE_DATABASE_URL=postgres://substrate:substrate@localhost:5432/substrate \
SUBSTRATE_SYSTEM_ACTOR=local-dev \
  pnpm --filter @mnmal-ai/substrate dev
```

With `SUBSTRATE_PLUGIN_DIR` unset the server loads no plugins and serves only `/health` and the `_system` admin namespace.

## Documentation

- [Getting started](docs/getting-started.md): from nothing to a running server with a plugin loaded
- [Plugin author guide](docs/plugin-author-guide.md): `defineNamespace`, the field DSL, autoCRUD, custom resolvers, onboarding, testing
- [Plugin tiers](docs/plugin-tier-decision.md): kernel vs coordinator plugins
- [Surface parity](docs/surface-parity.md): what HTTP, MCP, WS and SSE each offer, and where their shapes differ
- [WebSocket subscription teardown](docs/ws-subscription-contract.md): how subscriptions end and what a client should do
- [Design spec](docs/substrate-from-first-principles.md): the design source of truth
- Each package and plugin has its own README; [`apps/substrate`](apps/substrate/README.md) covers the binary, its subcommands and environment variables.

## Layout

Four packages publish to npm: `@mnmal-ai/substrate` (the binary and the libraries, behind the subpaths `/sdk`, `/client`, `/pack`, `/testing`, `/recall` and `/proposals`), `@mnmal-ai/substrate-nl`, `@mnmal-ai/substrate-sentinel` and `@mnmal-ai/substrate-tui`. Everything else under `packages/`, plus the recall and proposals plugins, is workspace-internal and bundled into `@mnmal-ai/substrate`.

```
apps/
  substrate/                  @mnmal-ai/substrate: the binary (serve, mcp, init, ask, …; substrate-admin) and the public subpaths
  substrate-image/            the Docker image: the binary, substrate-nl and substrate-sentinel as one runtime
  substrate-tui/              @mnmal-ai/substrate-tui: terminal UI: natural-language ask, schema browser, status
packages/                     internal, bundled into @mnmal-ai/substrate
  substrate-types/            foundational types + zero-dependency runtime primitives
  substrate-sdk/              defineNamespace, field DSL, autoCRUD
  substrate-core/             engine, registry, resolver dispatch, sweep
  substrate-filter/           where-clause language
  substrate-policy/           policy combinators, grants, agent tokens
  substrate-pack/             MessagePack + positional wire format
  substrate-bootstrap/        defineBootstrap for plugin entry points
  substrate-compose/          composition root: plugins + dataset + server + auth
  substrate-dataset-memory/   in-memory dataset
  substrate-dataset-pg/       Postgres dataset, edges, migrations
  substrate-server-fastify/   Fastify HTTP/WS server
  substrate-server-memory/    in-process server for tests and embedding
  substrate-client/           typed HTTP/WS client
  substrate-embedder/         embedders for recall (ONNX in-process, Ollama)
  substrate-bridge-http/      HTTP federation bridge client
  substrate-sentinel-client/  dynamic bridge discovery from a Sentinel
  substrate-config/           shared TS/Biome/tsdown config
plugins/
  substrate-recall/           kernel, built in: semantic + keyword recall over pgvector
  substrate-nl/               @mnmal-ai/substrate-nl, kernel: natural-language questions (POST /substrate/v1/nl)
  substrate-proposals/        coordinator, built in: runtime namespace, type and field hot-add
  substrate-sentinel/         @mnmal-ai/substrate-sentinel, coordinator: federation peer registry
```

## Development

TypeScript (strict, `exactOptionalPropertyTypes`), pnpm workspaces with Turborepo, Biome for lint and format, Vitest for tests.

```bash
pnpm check-types && pnpm lint && pnpm test
```

Postgres-backed suites skip unless `POSTGRES_URL` is set; [`packages/substrate-dataset-pg`](packages/substrate-dataset-pg/README.md#running-tests) explains the guards they run and how to set up a test database.

## License

[Apache-2.0](LICENSE)
