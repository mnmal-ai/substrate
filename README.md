# substrate

Your data, your agents' memory, and the work between them, in one typed server on your own Postgres. You declare namespaces and types; substrate gives every type query and mutate operations over HTTP and MCP, and subscriptions over frame streams, with no handler code. Agents write and query, propose new types, ask in plain English, search by meaning and hand each other work, all in the same frames. Anything can subscribe to what changes.

**Site: [mnmal-ai.github.io/substrate](https://mnmal-ai.github.io/substrate/).** Every example there runs in CI, and the output shown is what that run produced.

## What it replaces

The usual stack is a database, an API in front of it, a vector store beside it, a memory service for your agents, and the glue that lets them hand each other work. Substrate does each job from one process, in one frame grammar.

| Job | Usually | On substrate |
|---|---|---|
| Database | Postgres | Your own PostgreSQL 18 with pgvector. Substrate keeps a table per declared type. |
| API layer | PostgREST, Hasura | Every declared type can be queried and mutated over HTTP and MCP, and subscribed to over frame streams, with no handler code. Policies decide who may do what. |
| Vector store | a separate vector database | Rows of a type that declares it are embedded on write into pgvector, in the same Postgres. Recall fuses dense and keyword ranking. |
| Agent memory | Mem0, Zep | Memory is more types: rows your agents write, query and recall by meaning, in the same store as the data they're about. |
| Coordination | queues and glue code | Each agent signs with its own key, subscribes to the rows it cares about, and every row records which key wrote it. |

It is not a drop-in for any of them. Substrate serves the types you declare, not an existing schema, and recall ranks what your agents wrote rather than having a model extract memories from their conversations.

## What's different

- **One grammar on three surfaces.** A frame names its target as `<namespace>/<Type>` or `<namespace>/<mutation>`, and the same frames work over HTTP (`/substrate/v1/query`, `/substrate/v1/mutate`), the `substrate mcp` stdio server, and frame streams (`POST /substrate/v1/subscribe` and `/substrate/v1/stream`, JSON or MessagePack). A fresh agent learns the grammar and every loaded plugin's surface from `GET /substrate/v1/onboard`. [Surface parity](docs/surface-parity.md) lists where the surfaces differ.
- **Schema your agent can change at runtime.** With the built-in [proposals plugin](plugins/substrate-proposals/README.md), an agent holding the `substrate.propose` capability adds namespaces, types and fields to the running server, with no code deploy, and uses them straight away. Each change is stored as a proposal record, so it is audited and replayed on boot.
- **Questions in English, and the model never writes a query.** In the [`@mnmal-ai/substrate-nl`](plugins/substrate-nl/README.md) plugin, a deterministic parser reads the question against the live schema, and an optional, constrained judge handles only the ambiguous remainder.

## Quick start

Two ways to a running server. Until 1.0.0, releases publish on npm's `next` tag; `latest` holds a 0.0.0 placeholder.

### Docker

`docker compose up` builds the server from source with the in-tree plugins, which takes a few minutes the first time, and starts it beside a pgvector Postgres. No image is published.

```bash
git clone https://github.com/mnmal-ai/substrate.git && cd substrate
docker compose up -d
curl --http2-prior-knowledge http://localhost:3100/health
curl --http2-prior-knowledge http://localhost:3100/substrate/v1/onboard
```

Add `-f docker-compose.yml -f docker-compose.embed.yml` for dense recall through a local Ollama.

### npm

Needs Node `>=26.13.1` and pnpm. `substrate init` scaffolds a runtime directory: the binary (with recall and proposals built in) and any optional plugins in one `node_modules`, and a `.env`. This one uses the memory store, which needs no database and keeps nothing across a restart:

```bash
npx @mnmal-ai/substrate@next init ~/my-substrate --yes --store=memory --plugins= --port=3100
cd ~/my-substrate
pnpm install
set -a && source .env && set +a
./node_modules/.bin/substrate serve
```

A durable store needs PostgreSQL 18 or newer with [pgvector](https://github.com/pgvector/pgvector); leave out `--store=memory` and `init` writes a compose file for one. [Getting started](docs/getting-started.md) covers Postgres, the embedder and connecting an MCP client, and [Operator decisions](docs/operator-decisions.md) lists every choice a deployment makes and what each costs. An existing store on the old `legacy` or `partitioned` layout must be copied with `substrate-admin migrate-store` before this release boots it; see [Upgrading to per-type tables](docs/upgrading-to-type-tables.md).

## Example: an invoicing app

Two types, declared once. This is the site's onboard example, and substrate's CI runs it against the engine and checks its output:

```ts
import { defineNamespace, field } from '@mnmal-ai/substrate/sdk';

export const app = defineNamespace('app', {
  Customer: {
    fields: {
      name: field.string(),
      email: field.string(),
      region: field.string()
    }
  },
  Invoice: {
    fields: {
      number: field.string(),
      amount: field.int64(),
      currency: field.string(),
      issuedAt: field.date(),
      dueAt: field.date(),
      status: field.enum(['draft', 'sent', 'paid', 'void']),
      customer: field.crossRef('app', 'Customer')
    }
  }
});
```

Composed into a server, both types can be written, read and subscribed to with no handler code: `app/createInvoice`, `app/updateInvoice` and the rest are generated. This frame, from that run, reads the sent invoices by due date. The run sent it to `POST /substrate/v1/query`; the MCP `query` tool takes the same object as its `payload`, and `POST /substrate/v1/subscribe` takes it unchanged for a snapshot followed by every change.

```json
{
  "app/Invoice": {
    "params": {
      "where": { "status": { "eq": "sent" } },
      "orderBy": [{ "dueAt": "asc" }]
    },
    "fields": { "number": true, "dueAt": true }
  }
}
```

The run answered with six invoices, each with only its `number` and `dueAt`.

The other worked examples, from agents handing each other work to warehouse queries, recall, the index advisor, a type an agent proposes at run time and plain-English questions answered by `ask`, are on the site, each with the code and the output its CI run produced: **[mnmal-ai.github.io/substrate](https://mnmal-ai.github.io/substrate/)**.

## Stability

Substrate is in beta (`1.0.0-beta.N`, published to npm's `next` tag). From 1.0.0-beta.1:

- **Frozen, except for additions:** the frame grammar (keys, `params`, `where` operators, walks, aggregates), the wire format of the envelope and of frame streams, the error codes, and the HTTP routes and MCP tools with their arguments. New params, operators, fields and routes may appear. Existing ones keep their meaning.
- **A breaking change takes a deprecation:** the old form keeps working, with a warning, for at least one beta, and the [CHANGELOG](CHANGELOG.md) names it.
- **Not covered:** internal packages (everything bundled into `@mnmal-ai/substrate` but not exported from its public subpaths), the plugin runtime's internals, `substrate-tui`, diagnostic output such as `_diagnostics` plans and the storage report's wording, and performance.

Upgrading from an alpha: [Upgrading to 1.0.0-beta.1](docs/upgrading-to-beta.md).

## Documentation

- [Getting started](docs/getting-started.md): from nothing to a running server with a plugin loaded
- [Plugin author guide](docs/plugin-author-guide.md): `defineNamespace`, the field DSL, autoCRUD, custom resolvers, onboarding, testing
- [Plugin tiers](docs/plugin-tier-decision.md): kernel vs coordinator plugins
- [Operator decisions](docs/operator-decisions.md): every choice you make when you deploy or upgrade, its default, and what it costs
- [Upgrading to 1.0.0-beta.1](docs/upgrading-to-beta.md): the breaking changes in the first beta, how to tell if you are affected, and what to do
- [Upgrading to per-type tables](docs/upgrading-to-type-tables.md): what changes, and the upgrade procedure for an existing store
- [Upgrading to the warehouse grammar](docs/upgrading-to-warehouse-grammar.md): `bucket` and `derive` become `groupBy` and `select`, plus the new expression params
- [Edge walks](docs/walks.md): the walk grammar: `_walk`, `pick` and `among`, `as` and `$ref`, `_agg`, nested selections, frame aggregates, limits and refusal codes
- [Act](docs/act.md): declared actions and sketches, so an agent sends a terse sketch and gets a one-line ack; the `lean` MCP preset, the HTTP route, CLI and client
- [Surface parity](docs/surface-parity.md): what HTTP, MCP and frame streams each offer, and where their shapes differ (edge walks are query-only; subscriptions refuse them)
- [Frame stream contract](docs/stream-contract.md): the stream wire format, how subscriptions end and what a client should do
- [Design spec](docs/substrate-from-first-principles.md): the design source of truth
- Each package and plugin has its own README; [`apps/substrate`](apps/substrate/README.md) covers the binary, its subcommands and environment variables.

## Layout

Four packages publish to npm: `@mnmal-ai/substrate` (the binary and the libraries, behind the subpaths `/sdk`, `/client`, `/pack`, `/testing`, `/recall` and `/proposals`), `@mnmal-ai/substrate-nl`, `@mnmal-ai/substrate-sentinel` and `@mnmal-ai/substrate-tui`. Everything else under `packages/`, plus the recall and proposals plugins, is workspace-internal and bundled into `@mnmal-ai/substrate`.

```
apps/
  substrate/                  @mnmal-ai/substrate: the binary (serve, mcp, init, ask, …; substrate-admin) and the public subpaths
  site/                       the landing page and its worked examples, which run in CI (private, not published)
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
  substrate-server-fastify/   Fastify HTTP server
  substrate-server-memory/    in-process server for tests and embedding
  substrate-client/           typed HTTP client
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
pnpm install
pnpm check-types && pnpm lint && pnpm test
```

To run the server from source:

```bash
pnpm build
docker compose up -d postgres   # pgvector/pgvector:pg18 on localhost:5432 (user/password: substrate)
SUBSTRATE_DATABASE_URL=postgres://substrate:substrate@localhost:5432/substrate \
SUBSTRATE_SYSTEM_ACTOR=local-dev \
  pnpm --filter @mnmal-ai/substrate dev
```

With `SUBSTRATE_PLUGIN_DIR` unset the server loads no plugins and serves only `/health` and the `_system` admin namespace.

Postgres-backed suites skip unless `POSTGRES_URL` is set; [`packages/substrate-dataset-pg`](packages/substrate-dataset-pg/README.md#running-tests) explains the guards they run and how to set up a test database.

See [CONTRIBUTING.md](CONTRIBUTING.md) to report a bug or suggest an idea, and [SECURITY.md](SECURITY.md) to report a vulnerability.

## License

[Apache-2.0](LICENSE)
