# Plugin author guide

This guide is for developers (and agents) writing a substrate plugin outside
this repository. It covers the plugin tiers, packaging and loading, the field
DSL, autoCRUD, custom resolvers, onboarding, multi-instance concerns, testing,
and ends with a complete worked example.

The design reference is
[`docs/substrate-from-first-principles.md`](substrate-from-first-principles.md).
This guide links to it where useful but stands on its own.

## Mental model

Substrate is a typed dispatcher. Plugins claim namespaces; each namespace
contributes types and mutations. At runtime the engine receives frames keyed
by `<namespace>/<TypeName>` (queries) or `<namespace>/<mutationName>`
(mutations) and routes each entry to the registered resolver.

Two timelines matter:

- **Compose time.** The binary loads plugins, calls each namespace's
  `install(ctx)`, builds the dataset registry, and constructs the engine.
  Types, resolvers and policies are registered here.
- **Runtime.** The engine dispatches frames against the registry, threads a
  `RequestContext` through each resolver, and returns the envelope to the
  transport.

Plugins do their structural work at compose time. `onStart` fires once the
engine is fully constructed; that is where you capture the engine handle for
later use (see [Calling sibling resolvers](#calling-sibling-resolvers)).

## Two plugin tiers

Both tiers are declared in `@mnmal-ai/substrate/sdk`.

- **`CoordinatorPlugin`** is agent-facing. It owns one or more data
  namespaces, can mount HTTP/WS routes under
  `/substrate/v1/plugins/<name>/`, can contribute onboard instructions and
  scheduled tasks, and has `onStart` / `onStop` lifecycle hooks.
  `substrate-sentinel` and the built-in `substrate-proposals` are
  coordinators.
- **`KernelPlugin`** extends the kernel. It does not own data namespaces. It
  can contribute:
  - `migrations`: schema migrations, applied idempotently at every boot and
    tracked by id.
  - `filterOperators`: where-clause extensions such as `embeddingSimilar`.
  - `kernelRoutes`: top-level routes under `/substrate/v1/<path>`. The first
    claim wins; a collision refuses boot. Each route must declare a
    `capability` (`'read' | 'mutate' | 'admin' | 'public'`).
  - `mcpTools`: flat MCP tool registrations.
  - `kernelNamespace`: a virtual, storage-free frame surface (see
    [Contributing a frame surface from a kernel plugin](#contributing-a-frame-surface-from-a-kernel-plugin)).
  - `contributePostWrites`: postWrite hooks for coordinator types, chosen by
    inspecting each coordinator namespace's type definitions.
  - `onKernelReady`: a hook that fires after every kernel plugin has
    registered and before any coordinator composes.

  The built-in `substrate-recall` and `substrate-nl` are kernel plugins.

Compose order is **kernel first, coordinators second**. Coordinators can rely
on kernel registrations being live; kernel plugins must not depend on
coordinator namespaces existing (they can read the declared names from
`KernelLifecycleContext.coordinatorNamespaces` in `onKernelReady`).

### Choosing a tier

If your plugin owns a namespace and exposes types to agents, it is a
coordinator. If it extends what the kernel can do (storage shapes, query
operators, top-level routes or MCP tools, migrations, computed frame
surfaces), it is a kernel plugin. A plugin cannot be both; ship two plugins
(one package can carry both, see below).

[`plugin-tier-decision.md`](plugin-tier-decision.md) has the full decision
tree with worked examples.

### `contractVersion`

Both tiers must declare `contractVersion`: a semver range over the binary's
version (the binary and its `/sdk` subpath ship in one package,
`@mnmal-ai/substrate`). At boot, a plugin whose range does not admit the running binary,
or whose range is not valid semver, is refused with an `EnvConfigError`
naming the plugin. The field is required by the type, so omitting it is a
compile error.

```ts
import type { CoordinatorPlugin } from '@mnmal-ai/substrate/sdk';

const plugin: CoordinatorPlugin = {
  name: 'my-plugin',
  contractVersion: '>=1.0.0-alpha.0 <2.0.0',
  namespaces: [/* … */]
};
```

Set the ceiling to the first version you know is incompatible, not
automatically to the next major. A ceiling that admits a release which broke
the plugin interface lets the plugin load and misbehave silently. The in-tree
plugins use `'>=1.0.0-alpha.0 <2.0.0'`.

## Packaging and loading

### The bootstrap entry

The binary does not import your plugin object directly. It imports a
**bootstrap module** whose default export is a function taking the merged
config (and, for kernel plugins, a bag of host-built dependencies) and
returning the plugin. `defineBootstrap` from `@mnmal-ai/substrate/sdk` builds that function
for you from a config schema and a factory:

```ts
// src/bootstrap.ts
import { defineBootstrap } from '@mnmal-ai/substrate/sdk';
import { z } from 'zod';
import { createClosetPlugin } from './index.js';

const ConfigSchema = z.object({ namespace: z.string().min(1).default('closet') }).strict();

export const bootstrap = defineBootstrap.coordinator({
  schema: ConfigSchema,
  build: (config) => createClosetPlugin(config)
});

export default bootstrap;
```

Kernel plugins use `defineBootstrap.kernel<TConfig, THostDeps>({ schema, build: (config, hostDeps) => … })`.
The schema only needs a zod-style `safeParse`. A failed parse surfaces at boot
as a `PluginLoadError` naming your package and the invalid keys.

### The manifest

A package becomes a plugin by declaring a top-level `substrate` block in its
`package.json`. Declare `@mnmal-ai/substrate` as a peer dependency, so the
plugin shares the binary's copy at runtime, and as a dev dependency for
building and testing (`pnpm add -D @mnmal-ai/substrate@next`):

```json
{
  "name": "@your-org/closet",
  "peerDependencies": { "@mnmal-ai/substrate": ">=1.0.0-alpha.0 <2.0.0" },
  "devDependencies": { "@mnmal-ai/substrate": "^1.0.0-alpha.0" },
  "substrate": {
    "tier": "coordinator",
    "entry": "./dist/bootstrap.js",
    "defaultConfig": "./default-config.json",
    "configSchema": "./config.schema.json"
  }
}
```

- `tier` (required): `"kernel"` or `"coordinator"`.
- `entry` (required): path to the bootstrap module, relative to the package.
- `defaultConfig` (optional): JSON defaults merged under the operator's
  override.
- `configSchema` (optional): a JSON Schema file. Informational only; the
  loader validates through your bootstrap schema, not this file.
- `configBasename` (optional): the name of the operator override file,
  without `.config.json`.

A malformed manifest refuses boot with a `PluginManifestError` naming the
package.

### On-disk layout

Point `SUBSTRATE_PLUGIN_DIR` at a directory with a `node_modules/` tree. The
loader scans `<dir>/node_modules/{*,@*/*}/package.json` (symlinked packages
are followed) for the packages `<dir>/package.json` lists under
`dependencies`, picks up every one with a `substrate` block, and orders
them kernel first, then coordinators, alphabetically within each tier.

```
${SUBSTRATE_PLUGIN_DIR}/
  node_modules/
    @mnmal-ai/
      substrate/
        package.json     # { "substrate": { "plugins": [ recall (kernel), proposals (coordinator) ] } }
        dist/recall-bootstrap.js
        dist/proposals-bootstrap.js
    @your-org/
      closet/
        package.json     # { "substrate": { "tier": "coordinator", ... } }
        dist/bootstrap.js
  substrate-recall.config.json   # operator override for the built-in recall plugin
  closet.config.json             # operator override for @your-org/closet
```

```sh
npm install --prefix /opt/substrate-plugins @your-org/closet
SUBSTRATE_PLUGIN_DIR=/opt/substrate-plugins substrate serve
```

Each plugin's config is its `defaultConfig` file, shallow-merged with the
optional override at `<plugin-dir>/<basename>.config.json`. The basename is
the package name with its npm scope removed (`@your-org/closet` reads
`closet.config.json`) unless `configBasename` says otherwise. If neither file
exists, the bootstrap receives `{}` and your schema's defaults apply.

**One package, several plugins.** A package can ship a kernel plugin and a
coordinator together by declaring `substrate.plugins` instead of the single
form:

```json
{ "substrate": { "plugins": [
  { "name": "kernel",      "tier": "kernel",      "entry": "./dist/kernel/bootstrap.js" },
  { "name": "coordinator", "tier": "coordinator", "entry": "./dist/bootstrap.js", "configBasename": "closet" }
] } }
```

Each entry takes the single-form keys plus a `name` (lowercase letters,
digits and hyphens, unique within the package). Its plugin id, used for
ordering and error messages, is `<package>/<name>`. Its override file
defaults to `<basename>-<name>.config.json`; `configBasename` pins a
different one. Mixing `substrate.plugins` with single-form keys is refused.

`@mnmal-ai/substrate` itself uses this form: it ships recall and proposals as
`@mnmal-ai/substrate/recall` and `@mnmal-ai/substrate/proposals`, which read
`substrate-recall.config.json` and `substrate-proposals.config.json`.

## Opting into recall from a coordinator

The built-in recall plugin lets a coordinator opt a type into
semantic recall declaratively: add an `embed: { source }` slot to the type.
Recall's `contributePostWrites` walks every coordinator namespace at compose
time and chains an embedding postWrite onto each type that declares one. No
manual wiring is needed.

```ts
import { defineNamespace, field } from '@mnmal-ai/substrate/sdk';

export const docsNamespace = defineNamespace('docs', {
  Document: {
    fields: {
      title: field.string(),
      description: field.string({ indexed: false }),
      synopsis: field.string({ nullable: true, indexed: false })
    },
    embed: {
      source: (r) => {
        if (typeof r.synopsis === 'string' && r.synopsis.length > 0) return r.synopsis;
        return [r.title, r.description].filter(Boolean).join('\n');
      }
    }
  }
});
```

`source` returns the text fed to the embedder. Its signature is
`(row: Row, ctx?: EmbedSourceContext) => string | null | undefined | Promise<string | null | undefined>`.

A sibling `lexical: { source: (row) => … }` slot feeds the keyword index. It
has the same null semantics but no `ctx`. Use it when the long-form text a
keyword search needs differs from the short handle you embed.

### Declaring a row un-indexable

Returning `null` or `undefined` means **this row must never enter the recall
candidate set**. Recall skips the embed and deletes any embedding the row
already has, so the row stays readable and referenceable but drops out of
recall:

```ts
embed: {
  source: (r) => (r.recallVisible === false ? null : (r.synopsis as string))
}
```

The delete matters on a live corpus: rows often become un-indexable after
they were written, and any write to the row re-runs the hook and removes the
stale vector. Rows that were already un-indexable before you added the check
keep their vectors until they are written again or re-embedded (recall's
admin route `POST /substrate/v1/embed/reindex` does this server-side).

`''` is **not** the sentinel. An empty string embeds normally. Returning `''`
to mean "skip" is worse than indexing the real text, because every such row
lands on the same point in vector space and matches whatever the empty-string
embedding happens to be close to.

Skipped writes are counted as `skips` in `GET /substrate/v1/embed-stats`, so
a source that starts rejecting every row shows up there instead of looking
like an idle embedder.

If you are about to delete rows to fix a retrieval problem, use this sentinel
instead. Retrieval policy and row lifecycle are separate concerns. Deleting a
row to keep it out of recall also removes everything else that row supports,
such as crossRefs pointing at it.

The query side is handled by recall itself: `POST /substrate/v1/recall`, the
`recall` MCP tool, and the `recall/*` frame surface. Coordinators only declare
`embed.source`.

### Enriching the embed source through crossRefs

When the host supplies a dataset resolver (the `substrate` binary does),
source functions receive an `EmbedSourceContext` whose
`read(ns, type, { id })` returns the linked row. Use it to fold related
context into the embedded text, so recall surfaces a row for a concept that
its own text never mentions.

```ts
import { defineNamespace, field } from '@mnmal-ai/substrate/sdk';

defineNamespace('notes', {
  Decision: {
    fields: {
      topic: field.string(),
      choice: field.string(),
      rationale: field.string({ indexed: false }),
      concept: field.crossRef('notes', 'Concept', { nullable: true })
    },
    embed: {
      source: async (r, ctx) => {
        const base = `${r.topic}\n\n${r.choice}\n\n${r.rationale}`;
        // ctx is undefined when the host has no dataset resolver (e.g. unit tests).
        if (ctx === undefined || typeof r.concept !== 'string') return base;
        const concept = await ctx.read('notes', 'Concept', { id: r.concept });
        return typeof concept?.name === 'string' ? `${base}\n\n[concept] ${concept.name}` : base;
      }
    }
  },
  Concept: { fields: { name: field.string() } }
});
```

The contract, from `@mnmal-ai/substrate/sdk`:

```ts
export interface EmbedSourceContext {
  read: (namespace: string, type: string, params: { id: string }) => Promise<Row | null>;
}
```

`read` is a single-row lookup. It returns `null` when the namespace is not
registered or the row does not exist. Keep source functions defensive: handle
`ctx === undefined`, an unset crossRef, and a linked row missing the field you
expect.

### Low-level: `embedAndStore`

For embedding outside the `embed.source` slot (custom postWrite chains,
backfill scripts), `@mnmal-ai/substrate/recall` exports the primitive:

```ts
import { embedAndStore } from '@mnmal-ai/substrate/recall';

await embedAndStore(row, {
  namespace: 'docs',
  type: 'Document',
  fields: ['title', 'description'], // or serializeRow: (r) => string | null | undefined | Promise<…>
  embedder,
  store
});
```

Embedding failures are logged and counted, not thrown, because the write has
already committed. Most plugins never need this; prefer `embed.source`.

## Contributing a frame surface from a kernel plugin

A kernel plugin can claim a **virtual namespace** through the
`kernelNamespace` slot: query types and mutations backed by resolvers, with
no storage. A coordinator namespace owns data; a virtual namespace owns
computation. Every frame is answered by running a resolver, never by reading
a row. Dispatch, policy, idempotency, schema publication, NL and MCP work the
same way they do for coordinator frames.

The built-in recall plugin is the in-tree example: it claims `recall`, with
the type `Hit` and the mutations `boost` and `fetchEmbeddings`.

### Claiming the namespace

```ts
import type {
  KernelNamespaceContribution,
  KernelPlugin,
  RequestContext,
  ResolverArgs,
  Row
} from '@mnmal-ai/substrate/sdk';
import { field, ResolverFrameError } from '@mnmal-ai/substrate/sdk';

const kernelNamespace: KernelNamespaceContribution = {
  namespace: 'clock',
  types: {
    // VirtualTypeDef: fields use the normal FieldDef DSL, so schema
    // publication and client typing work unchanged.
    Now: {
      fields: { id: field.string(), iso: field.string() },
      resolver: async (ctx: RequestContext): Promise<Row[]> => [
        { id: 'now', iso: ctx.now.toISOString() }
      ]
    }
  },
  mutations: {
    // VirtualMutationDef: a resolver plus an optional params schema.
    echo: {
      params: { text: field.string() },
      resolver: async (_ctx: RequestContext, args: ResolverArgs): Promise<Row> => {
        const text = args.params?.text;
        if (typeof text !== 'string') {
          throw new ResolverFrameError('bad_request', 'echo requires params.text');
        }
        // Mutations must return a Row with an id. With no persisted row,
        // use a fixed sentinel id that can never collide with a real one.
        return { id: 'ack', text };
      }
    }
  }
};

const plugin: KernelPlugin = {
  name: 'clock',
  contractVersion: '>=1.0.0-alpha.0 <2.0.0',
  kernelNamespace
};
```

The engine enforces these rules:

- **No dataset.** The namespace is registered as `{ registry, virtual: true }`
  with no dataset, and resolvers receive `args.dataset === undefined`.
  Compute from `args.params` and `args.fields`.
- **No autoCRUD, no storage.** If you need to persist, write a coordinator, or
  write through the host's datasets from a `kernelRoute`.
- **A name can be claimed once.** Compose throws
  `virtual_namespace_collision` when two kernel plugins claim the same
  namespace, when a claim collides with a coordinator namespace or with the
  reserved `_system` namespace, or when a type and a mutation in one claim
  share a name.

### Patterns worth copying

`plugins/substrate-recall/src/frame-surface.ts` is a full implementation.
Its resolvers are thin adapters over the same transport-agnostic functions
its HTTP `kernelRoutes` call, so both surfaces stay in step. Three patterns:

- **Throw `ResolverFrameError` for coded errors.** The engine reports the
  `code` verbatim in the per-key error, so frame and HTTP callers see the
  same error vocabulary (`policy_denied`, `bad_request`,
  `embedder_unavailable`, …).
- **Bind the caller into read-policy checks.** Resolvers receive the caller
  on `ctx`. Pass it as `engine.evaluateReadPolicy(ns, type, ctx.identity, ctx)`
  (or your own check) before returning row data from other namespaces, so the
  policies that gate a normal `query` also gate your surface, including ones
  that read headers, `clientIp`, `meta` or `authEnabled`. If the decision
  carries `row-filter` obligations, apply them to each row with
  `applyObligations` before returning it. Plugin and kernel routes receive the
  post-trust `clientIp` and `authEnabled` on the request.
- **Use sentinel ids on mutation acks**, as in the example above.

### The filter-operator contract

A `FilterOperatorDef` has `validate(value)`, `execute(value, context)` and an
optional `computedFields`. `execute` runs in a pre-resolve pass and must
resolve to an ordered, scored envelope:

```ts
{ hits: [{ id: string; score: number; vector?: number[] }, /* … */] }
```

Any other shape throws `ExtensionOperatorResultError` naming the operator. The
engine rewrites the operator into an `id IN (…)` that preserves relevance
order, and passes scores and vectors to the dataset on a side channel.

Declare the projection fields your operator produces in `computedFields`
(for example `['_score', '_vector']`). Both the pg and memory datasets then:

- re-impose relevance order on each page, **only when the caller gave no
  explicit `orderBy`** (an explicit `orderBy` always wins);
- stitch `_score` / `_vector` onto returned rows when those fields are
  projected.

Relevance order is applied within a page, not across pages. `nextCursor` is
derived from dataset order, so cursor pagination keeps dataset order between
pages.

Projecting a computed field without its operator in the `where` clause is
rejected with `computed_field_unavailable`, including when there is no
`where` at all.

### One-shot only

Virtual namespaces and extension operators do not support live updates.
Subscribing to a virtual namespace, or with an extension operator in the
`where` clause, is refused with `subscription_unsupported_frame`. Streaming
refuses virtual namespaces the same way. Design for `query` / `mutate`;
consumers who need change tracking subscribe to the underlying coordinator
rows.

Batched (array) frames addressed to a virtual namespace are refused with
`batched_virtual_unsupported`: virtual mutations are not transactional, so a
batch could not be atomic.

### Namespace-scoped identities

The per-frame namespace gate checks the namespace named in the frame. An
identity whose grant is limited to specific namespaces must therefore include
the virtual namespace (for example `recall`) to use its frame surface. Kernel
routes such as `POST /substrate/v1/recall` check only the target scope, so a
grant that works over HTTP can be denied on the frame surface until the
virtual namespace is added.

### Error codes

| Code | Meaning |
|---|---|
| `virtual_namespace_collision` | Boot refusal: the namespace is claimed twice, or collides with a coordinator namespace or `_system`. |
| `subscription_unsupported_frame` | Subscribe or stream against a virtual namespace or an extension-operator `where`. |
| `computed_field_unavailable` | A computed field (`_score`, `_vector`) was projected without its operator in `where`. |
| `batched_virtual_unsupported` | A batched frame array was addressed to a virtual namespace. |
| your own codes | Thrown by resolvers via `ResolverFrameError`. |

### Discovery

- A virtual namespace's published schema has `virtual: true`, so clients know
  it has no autoCRUD, no storage and no subscriptions.
- `GET /substrate/v1/onboard` lists claimed virtual namespaces under
  `virtualNamespaces`.

## The coordinator plugin shape

```ts
import type { CoordinatorPlugin } from '@mnmal-ai/substrate/sdk';

export function createMyPlugin(): CoordinatorPlugin {
  return {
    name: 'my-plugin',
    contractVersion: '>=1.0.0-alpha.0 <2.0.0',
    namespaces: [/* NamespaceDefinition[] */],
    // Optional:
    policies: [/* Policy[] applied to every resolver in every namespace */],
    onStart: async (ctx) => { /* ctx.engine is live here */ },
    onStop: async (ctx) => { /* release timers, children, connections */ },
    schedule: [/* ScheduledTask[] */],
    routes: (router, ctx) => { /* mounted under /substrate/v1/plugins/<name>/ */ },
    onboardInstructions: { /* free-form record served at /substrate/v1/onboard */ }
  };
}
```

Required: `name` (unique across loaded plugins; it also becomes the route
prefix), `contractVersion` and `namespaces`.

A `NamespaceDefinition` is `{ namespace, install(ctx) }`. `install` receives a
`NamespaceInstallContext` with the namespace's `registry`, its `dataset`, the
shared `edges` store, the composed `pluginPolicy`, and any postWrite hooks
kernel plugins contributed. You almost always build it with `defineNamespace`
from `@mnmal-ai/substrate/sdk` rather than by hand.

With auth on, every HTTP route the plugin mounts requires `read` for `GET`
and `mutate` for any other method, and the caller must hold that capability
in one of the plugin's declared `namespaces` (explicitly or by `*`). A plugin
that declares no namespaces accepts the capability held in any namespace.
Tokenless `GET`s are still admitted in `attribute` mode. WS routes resolve
identity only; the handler decides what an anonymous or under-granted caller
may do.

`onStop` hooks run in reverse registration order during shutdown. The engine
and database are still live, so final writes are possible. A failing
`onStop` is logged and does not stop other plugins from tearing down.

## Defining a namespace

`defineNamespace(name, types, opts?)` returns a `NamespaceDefinition` whose
`install` sets up autoCRUD for every type. Namespace names must match
`[A-Za-z0-9_-]+`.

```ts
import { defineNamespace, field } from '@mnmal-ai/substrate/sdk';

export const closetNamespace = defineNamespace('closet', {
  Dress: {
    fields: {
      name: field.string(),
      size: field.string({ nullable: true }),
      color: field.string({ nullable: true }),
      acquiredAt: field.date()
    }
  },
  Outfit: {
    fields: {
      label: field.string(),
      featured: field.crossRef('closet', 'Dress', { onDelete: 'restrict' }),
      notes: field.json({ nullable: true })
    }
  }
});
```

Every type gets a full autoCRUD surface (`createDress`, `getDress`,
`updateDress`, `deleteDress`, and the `Dress` list query; the same for
`Outfit`). Per-type options live on `TypeInput`:

| `TypeInput` field | Meaning |
|---|---|
| `fields` | Required. Field DSL map. |
| `policy` | Per-type policy, composed with `and()` with the namespace (`opts.policy`) and plugin layers. |
| `autoCrud: false` | Skip autoCRUD for this type. Register your own resolvers on `ctx.registry`. |
| `purgeable: true` | Also install the admin-only `purge<Type>` mutation. |
| `adminCapability` | Capability required for admin verbs (default `'admin'`). |
| `postWrite` | Hook run after every committed create or update; it cannot veto the write. |
| `indexes` | Composite and unique indexes the engine builds and maintains (see [Indexes](#indexes)). |
| `embed` / `lexical` | Recall source slots (see [Opting into recall](#opting-into-recall-from-a-coordinator)). |

`defineNamespace` also accepts `opts.annotations`, opaque JSON passed through
to the namespace schema for consumers such as `substrate-nl`, and
`opts.promotedColumns`, which names body keys the pg dataset mirrors into
dedicated `rows` columns so filters and sorts on them hit an index
(`{ status: { column: 'status', kind: 'text' } }`). Your plugin's own
migration creates the columns. Reads return the body as stored, and filters
use the column.

Index a promoted field through `indexes` (see [Indexes](#indexes)): the
engine builds declared indexes over a promoted field on its column, in the
form its filters compare. An index you write by hand must match that form
or it serves nothing, and nothing reports it. Key a text column as
`(col COLLATE "C")`, because filters compare promoted text under `"C"`, `eq`
included. A raw expression index over a body field must use the filter
compiler's expressions, such as `((body ->> 'f') COLLATE "C")`. Better, move
the index into `indexes` with its existing `name`, and the engine adopts it,
swapping it to the right definition.

### Indexes

Start with no indexes and no ordering choices. The model case: someone tells
an agent "track my sneaker collection: brand, model, year bought, colour, a
rating, and let me search on any of them."

```ts
Sneaker: {
  fields: {
    brand: field.string(),
    model: field.string(),
    yearBought: field.number(),
    colour: field.string(),
    rating: field.number()
  }
}
```

That is the whole definition. Filtering and sorting work on every one of
those fields, and nothing refuses a query because a field has no index: a
filter or sort on a field nothing serves scans, and gets slower as the type
grows, but it never fails. (`unindexed_field` is no longer raised, and the
`_allowTableScan` param is accepted and ignored.) Indexes arrive when the data
and the reads call for them, and substrate tells you which.

**What is automatic.**

- A natural order for every type (below).
- An index on every `crossRef`, keyed `(ref, natural order, id)`, built from
  the first boot whatever the table's size, so "the children of this parent"
  and edge walks stay fast as a child type balloons. `indexed: false` on the
  crossRef opts out.
- On the partitioned layout, indexes on `created_at`, `updated_at` and
  tombstones.

Nothing else is indexed until you ask. A scalar left unset gets no index;
`indexed: true` builds `(field, natural order, id)`; `indexed: false` also
builds none, and marks the field as not a search handle, so NL leaves it out.
Long-form fields (`body`, `summary`, `notes`) are best left unset.

#### Natural order

Every type has a natural order: what a read returns when it gives no
`orderBy`. Declare it with `orderedBy`, exactly one key, ascending or
descending:

```ts
Sneaker: { fields: { /* … */ }, orderedBy: { yearBought: 'desc' } }
```

- The key is a declared date or number field, or a metadata column
  (`createdAt`, `updatedAt`, and `seq` on a visible-order type).
- Undeclared, it is `{ createdAt: 'desc' }`: newest first. `id` is always the
  final tie-breaker. **This is the default read order.** Before this release
  it was `id` ascending, which over random ids meant nothing; pass `orderBy`
  to get any other order. An explicit `orderBy` is unaffected.
- `updatedAt` is mutable, so with `orderedBy: { updatedAt: … }` a row that is
  updated moves, and can move between pages while you page. `createdAt` and a
  field you never change do not move.
- A cursor carries the order it was issued under. One issued before the
  upgrade, or under a different order, is refused with `invalid_cursor`; start
  the read again.
- Changing `orderedBy` swaps the type's derived indexes in the background at
  the next boot.

A type proposed at runtime takes the same options on `propose_type`:
`orderedBy`, `indexes` and `expectedSize`. Creating a type, with its order and
indexes, needs only `substrate.propose`.

#### Declared indexes

Add `indexes` on a type for what a single field cannot serve: composites and
unique constraints. A declared composite with no `where` of its own, led by a
field, already serves filters on that field alone, so the field needs no
`indexed: true`. A composite with its own `where` serves the field only for
queries that imply that predicate.

```ts
Sneaker: {
  fields: { /* … */ },
  indexes: [
    { fields: ['brand', { field: 'yearBought', dir: 'desc' }] },
    { fields: ['sku'], unique: true, where: 'live', name: 'sneaker_sku_uniq' }
  ]
}
```

- `fields`: key fields in order. Each is a name (ascending) or
  `{ field, dir }`. Scalar and crossRef fields only; `field.json` is refused.
  Both directions sort NULLs last, as `orderBy` does.
- `unique`: refused at boot, with `unique_index_duplicates`, while live rows
  already hold duplicate values.
- `where`: every index covers live (not deleted) rows only. `'live'` adds
  nothing to that; a record such as `{ archived: false, owner: null }` also
  requires each field to match: `true` or `false` on a boolean field, and
  `null` (IS NULL) on any scalar field.
- `name`: the Postgres index name (`[a-z_][a-z0-9_]*`, at most 63 bytes, not
  ending `__swap`). Omit it and one is generated. An existing index of that
  name with the same key fields and uniqueness is adopted, and swapped to the
  declared definition if the expression or predicate differs. One that differs
  in key fields or uniqueness is refused with `index_definition_conflict`.
  Two declarations resolving to one name with different definitions fail the
  same way.
- `expectedSize: 'small' | 'large'` on the type: `large` lets the advisor
  recommend for it from a lower row count (below).

The engine reconciles at boot, building concurrently. Unique indexes are
built before the server starts, and the boot fails if one cannot be built.
Non-unique indexes build in the background once the server is serving, one
type at a time. Until one is valid, filters it would serve scan, and doctor
reports it `pending`, `building` or `failed`; a failed or pending build is
retried every `SUBSTRATE_INDEX_RETRY_INTERVAL_MS` (default 600000; `0` leaves
it to the next boot). A removed declaration leaves its index in place.

**What serves a query.**

- Every non-unique btree ends in `id` ascending, so a filter plus the default
  page order is one index range. Unique indexes do not get the `id`.
- A field's own index is `(field, natural order, id)`, so a filter on it reads
  in the type's natural order with no sort. On the natural-order field itself
  it is `(field, id)` in that direction.
- Filtering on one field and sorting by another needs a composite, e.g.
  `(brand, yearBought desc)`.
- Keyset paging (the `cursor`) is index-served for `id` and for a sort key
  that may be null: a range bound first, then the null tail. Page cost stays
  flat with depth.

**The range-plus-sort trade-off.** A range on one field sorted by another
(`yearBought > 2015`, newest `rating` first) has no single btree that serves
both. An equality on A then a sort by B is one composite `(A, B)`. A range on
A is served by A's index, and then the rows must be sorted; or the planner
walks an index in B order and discards rows that miss the range. Which it
chooses depends on how much of the type the range keeps: a narrow range
scans A's index and sorts the few rows, a wide one walks B's order and
stops early once the page is full. Neither is wrong, and substrate does not
try to out-plan Postgres. If the slow one is your hot read, index for it
(`(B)` for a wide range with a small page, `(A)` for a narrow one) or
turn the range into an equality.

**What it costs.**

- Each index adds write cost. Set `indexed: true` only on the fields your
  hot reads filter on; the rest scan until the advisor says otherwise.
- The reconciler also owns one `CREATE STATISTICS` per indexed body
  expression, and runs `ANALYZE` once when it creates one, because the planner
  needs it for row estimates on body-field filters.

On the legacy layout field and declared indexes are built as partial indexes
on `rows` scoped to the type; the per-type timestamp and tombstone indexes are
partitioned-only.

#### Recommendations and `propose_index`

The engine records the shape of every read (type, filter fields, order) with
its duration, and samples each type's size, write rate and index scan counts
from Postgres. In the served binary an advisor reads them every ten minutes
(`SUBSTRATE_ADVISOR_INTERVAL_MS`; `0` turns it off) and writes
`_system/IndexRecommendation` rows. It builds and drops nothing.

- `add`: a filter-and-order shape read often enough to count (a few dozen
  reads in a window), with a p95 at or over the profile's slow threshold, on
  a type with enough live rows, and no index the type has serves it. The row's
  `declarationJson` is the exact `indexes` entry.
- `remove`: an index the engine owns and no longer wants (a former default, a
  retracted declaration) with no scans over the profile's window, on a type
  with real write volume. Unique indexes and indexes the engine does not own
  are never recommended.
- Each row carries its `evidenceJson` (read count, p95, live rows, write
  rate, window) and an `estimatedWriteCost`. There is one row per action and
  shape (or index), refreshed while `open`. Its `state` is `open`,
  `accepted`, `dismissed` or `superseded`. Doctor shows the open count as an
  info line; it never fails the check.

A signed `propose_index` (`_system_proposals/propose_index`, with
`params.namespace` naming the type's namespace) is the approval. It needs the
`substrate.index` grant in that namespace, which is separate from
`substrate.propose`, and it takes effect on the call: there is no pending
state. `action` is one of:

| `action` | Effect |
|---|---|
| `add` | Appends `declaration` (default: the recommendation's) to a proposed type and builds it in the background. |
| `orderedBy` | Sets a proposed type's natural order; its derived indexes swap. |
| `remove` | Drops an engine-owned, non-unique index (`indexName`, default the recommendation's), on any type. |
| `dismiss` | Closes the recommendation (`recommendationId`) without acting. |

`add` and `orderedBy` apply to proposed types only; on a type defined in code
they are refused `index_on_code_defined_type`, and the recommendation stays
advice for the plugin author to apply in `defineNamespace`. `remove` drops
only what the engine owns: another index is `not_engine_owned`, a unique one
`unique_index`, one still declared or derived `still_desired`, and a name that
is not there `unknown_index` (on the memory dataset, which builds no indexes,
always). A `remove` with no recommendation of an index only a proposed type
declares retracts that declaration, then drops the index.

A recommendation is checked again when it is applied: an `add` whose shape an
index now serves, or a `remove` whose index is wanted again, is refused
`recommendation_stale` and the row is marked `superseded`; one no longer
`open` is `recommendation_closed`. Every applied call writes a
`_system/AuditEvent` of kind `index_proposed` carrying the reason, the
recommendation and the change; that is the only record of a drop.

#### Profiles

Thresholds come from a sizing profile, held in the single
`_system/StoreProfile` row (id `5703e000-0000-4000-8000-000000000001`),
which an admin or a holder of `substrate.index` on `_system` can change live.

| | `personal` | `growth` | `scale` |
|---|---|---|---|
| Slow p95 | 250 ms | 100 ms | 50 ms |
| Live rows before `add` | 100,000 | 50,000 | 20,000 |
| Same, `expectedSize: 'large'` | 10,000 | 5,000 | 1,000 |
| Unused for | 7 days | 3 days | 1 day |
| Writes/min before `remove` | 100 | 50 | 20 |

`SUBSTRATE_STORE_PROFILE` seeds the row once, when the store is first
composed; changing the env var later does not change an existing store, edit
the row. `SUBSTRATE_STORE_WRITE_HEAVY=1` is read on every boot and halves the
writes-per-minute threshold, so a write-heavy store sheds unused indexes
sooner. `substrate init` asks four sizing questions (rows per day, days kept,
read latency target, whether write throughput is a priority) and writes both
variables to `.env`; `--rows-per-day`, `--retention-days`, `--read-target-ms`,
`--write-heavy` and `--profile` answer them non-interactively. Profiles only
tune when a recommendation is written. No profile builds an index.

#### Visible-order types

`ordering: 'visible'` on a type (code-defined only) gives each inserted row a
`_metadata.seq`, strictly increasing in commit order, so a reader paging by
`seq` never sees a later row before an earlier one. `seq` is filterable,
sortable, and valid in `orderedBy`. The cost is concurrency:

- Writes to the type are serialised. Each insert holds a per-type transaction
  lock from assigning `seq` to commit, so one writer's open transaction blocks
  every other writer of that type. Other types pay nothing.
- A transaction that writes two visible types in opposite order from another
  can deadlock; Postgres aborts one with `40P01`. Write them in a consistent
  order.
- Making an existing type visible gives its old rows no `seq`: they stay null
  and sort after every new row.
- The counter never decreases, so a dropped and re-created type continues it.

#### Ids

New row ids are assigned by the dataset (Postgres `uuidv7()`; the memory
dataset does the same), so inserts land at the end of the `id` index and ids
roughly follow creation time. That is all they do:

- An id is never a happened-before signal. Ids sort in creation order only
  within one connection; across connections within a millisecond, and for ids
  you supply, order is arbitrary.
- Never decide who won (last writer, `conditionalUpdate`) by id. Use
  transaction time or a per-row version.
- An id reveals its creation time.
- A write that repeats an id in one batch is refused (under `insertOnly` the
  first occurrence lands and the rest are skipped).
- Key ids (kids) stay random.

`shortId` is the small human handle a row gets on create. It is per store and
not identity: the same row has a different `shortId` in another store, so
carry `id` across export and import, never `shortId`.

#### Upgrading an existing store

The first boot after the release swaps every derived index (each crossRef's
and each `indexed: true` field's) to its new `(field, natural order, id)`
shape, one at a time, in the background. The old index serves until its
replacement is valid. Each swap needs about twice that index's disk for a
while, so before each build the dataset compares free space on the database
volume against an estimate (the size of the index it replaces, a leftover `__swap` index included, else 30% of the
table; sort temp space is not included) plus a margin, and waits, reporting
`pending` with `insufficient_disk`, when there is not room. Configure it with:

- `SUBSTRATE_INDEX_DISK_PATH`: the database volume's mount, when the
  database is on this host. `off` turns the check off for a database with no
  local volume (`substrate init` writes `off`). Unset, the check is also off,
  and doctor says so.
- `SUBSTRATE_INDEX_DISK_MARGIN_MB`: free space a build must leave. Default
  2048; `0` requires only the estimate.

Indexes that were `indexed: true` only by the old SDK default stay in place
until the advisor recommends their removal and a `propose_index remove`
drops them. Also new in this release: PostgreSQL 18 is the minimum (boot
refuses older servers; see the dataset-pg README's upgrading section) and
Node `26.12.1`.

The engine injects `id`, `shortId` and the `_metadata` fields (`createdAt`,
`updatedAt`, `createdBy`, `updatedBy`). Declaring `shortId` yourself is
rejected at definition time. Clients that send server-managed fields on
create or update are rejected with `client_supplied_server_field`.

## Field DSL reference

Every `field.*` builder in `@mnmal-ai/substrate/sdk` returns a plain
`FieldDef`.

| Builder | Shape | Default `indexed` | Use for |
|---|---|---|---|
| `field.string(opts?)` | `{kind:'scalar',type:'string'}` | unset | Names, identifiers, short text. |
| `field.number(opts?)` | `{kind:'scalar',type:'number'}` | unset | Counts, scores, money in minor units. |
| `field.boolean(opts?)` | `{kind:'scalar',type:'boolean'}` | unset | Flags. |
| `field.date(opts?)` | `{kind:'scalar',type:'date'}` | unset | Timestamps. `serverSet: 'create' \| 'update' \| 'both'` marks one your server code sets; autoCRUD rejects client values for it. A date with no offset is read as UTC, so writers should send an offset or `Z`. |
| `field.enum(values, opts?)` | string scalar with `enum` | unset | A closed set of values. |
| `field.vocab(values, opts?)` | string scalar with `enum` + `aliases` | unset | A governed vocabulary: aliases are normalised to canonical values on write and in filters. `strict: false` admits unknown values. |
| `field.json(opts?)` | `{kind:'scalar',type:'json'}` | `false` | Opaque bodies. See below. |
| `field.struct(fields, opts?)` | `{kind:'struct',fields}` | n/a | A known nested shape you want to filter on per leaf. |
| `field.list(of, opts?)` | `{kind:'list',of}` | `false` | Homogeneous lists. `indexed: true` backs `has` with a GIN. |
| `field.crossRef(ns, type, opts?)` | `{kind:'crossRef',ns,type,onDelete}` | `true` | An edge to a row of another type, in any namespace. |

Common options:

- `nullable: true`: the value may be `null`.
- `default` (scalars): the value autoCRUD fills on create when the caller
  omits the field. **A non-nullable scalar without a `default` is required on
  create**; omitting it fails with `missing_required_field`.
- `readonly: true`: for engine-populated fields. Plugin authors rarely need
  it.

### `field.json` vs `field.struct`

- Use **`field.struct`** when the inner shape is known. Leaves are declared,
  indexed and orderable: `where: { profile: { age: { gt: 18 } } }`.
- Use **`field.json`** for opaque bodies (webhook payloads, metadata bags).
  You can still filter inside one with a path predicate,
  `where: { payload: { path: ['year'], gt: 1990 } }`. Matching is type-strict
  (`1995` does not match `"1995"`). Equality-style predicates are
  index-served only with `field.json({ indexed: true })`; anything else scans
  the type's rows. JSON fields cannot be ordered by.

### crossRef behaviour

`onDelete` decides what happens to referrers when the target is deleted:

- `'set_null'` (default): referrers survive, the reference becomes null.
- `'cascade'`: deleting the target deletes the referrer.
- `'restrict'`: deleting the target is refused while referrers exist
  (`RestrictViolation`).
- `'orphan'`: the reference is left dangling; consumers must tolerate it.

`onMissing` decides whether a create or update may point at a target that
does not exist (or is tombstoned):

- unset (default): refused with `missing_referent` whenever the target
  namespace is hosted in the same process. References to namespaces that are
  not resolvable locally (for example bridged ones) are not checked.
- `'reject'`: as the default, and compose additionally refuses to start if
  the target namespace is not locally resolvable.
- `'allow'`: never checked. Use it for genuinely soft references.

`onDelete` is copied onto each edge when the edge is created, and an edge's
policy cannot be changed afterwards. Changing a field's `onDelete` therefore
only affects edges created after the change; existing edges keep the old
policy. Decide it before you ship.

## AutoCRUD: what you get for free

For every type that does not opt out:

- `create<Type>(params)`: writes one row, allocates `id` and `shortId`, fills
  `_metadata`, applies field defaults. Returns the row.
- `update<Type>({ id, ...patch })`: merges the patch and bumps `updatedAt` /
  `updatedBy`. Undeclared keys are rejected. A missing id fails with
  `not_found`.
- `delete<Type>({ id })`: tombstones the row after edge enforcement; a
  restrict edge refuses the delete.
- `purge<Type>({ id })`: admin-only hard delete, installed only with
  `purgeable: true`.
- `get<Type>({ id })`: one row by id (or short id), or `null`.
- `<Type>({ where?, orderBy?, limit?, cursor?, id?, ids?, includeDeleted?, _allowTableScan? })`:
  the list query, addressed by the bare `<ns>/<Type>` key. Unknown params are
  rejected with `unknown_param`. `_allowTableScan` is deprecated and ignored.

The autoCRUD resolvers write through the dataset, run `postWrite` for create
and update (not delete), and emit write events to subscribers after the
transaction commits.

`postWrite` is the most common extension point. It receives the persisted row
and the `RequestContext`. Inside an engine mutate it runs after the transaction
commits, on the row as committed, so it cannot veto the write: a rolled-back
write never calls it, and anything it does is not part of the transaction.
Errors in it are reported as the `engine_after_tx_failed` metric and do not
change the envelope; when an autoCRUD resolver is called directly, with no
transaction, it runs at once and its errors propagate to the caller.

```ts
Dress: {
  fields: { name: field.string(), color: field.string({ nullable: true }) },
  postWrite: async (row, ctx) => {
    if (typeof row.color === 'string') {
      await indexDressByColor(row.id as string, row.color);
    }
  }
}
```

## Custom mutation resolvers

When autoCRUD does not cover a workflow (multi-step logic, aggregation,
composing other operations), register a resolver on `ctx.registry` inside the
install body. The loader rejects two `NamespaceDefinition`s for the same
namespace, so wrap the `defineNamespace` install and register after it:

```ts
import type {
  NamespaceDefinition,
  RequestContext,
  ResolverArgs,
  Row
} from '@mnmal-ai/substrate/sdk';
import { defineNamespace, field, requireCapability } from '@mnmal-ai/substrate/sdk';

const closetTypes = defineNamespace('closet', {
  Outfit: {
    fields: {
      label: field.string(),
      lastWornAt: field.date({ nullable: true }),
      archived: field.boolean({ default: false })
    }
  }
});

export const closetNamespace: NamespaceDefinition = {
  namespace: 'closet',
  types: closetTypes.types,
  install(ctx) {
    // 1. AutoCRUD for every type above.
    closetTypes.install(ctx);

    // 2. A custom mutation on the same registry.
    ctx.registry.register('archiveOldOutfits', {
      kind: 'mutation',
      policy: requireCapability('closet.admin'),
      resolver: async (rctx: RequestContext, args: ResolverArgs): Promise<Row> => {
        const dataset = args.dataset;
        if (dataset === undefined) throw new Error('archiveOldOutfits needs a dataset');
        const cutoff = new Date(rctx.now.getTime() - 30 * 24 * 60 * 60 * 1000);
        const result = await dataset.read('Outfit', {
          where: { lastWornAt: { lt: cutoff }, archived: { eq: false } },
          limit: 1000
        });
        if (result.rows.length > 0) {
          await dataset.write('Outfit', result.rows.map((o) => ({ ...o, archived: true })));
        }
        return { id: 'ack', archived: result.rows.length };
      }
    });
  }
};
```

Keep `types: closetTypes.types` on the wrapper. Kernel plugins (recall's
`embed.source` handling, for example) read type definitions from it.

Resolvers are **pure data in, pure data out**:

- A resolver receives a `RequestContext` (identity, namespace, operation,
  now, headers, meta) and `ResolverArgs` (params, fields, dataset, edges, and
  engine-supplied extras such as `onWrite`, `signal` and `afterTx`).
- It returns a `Row`, `Row[]`, `ReadResult`, `null`, or an
  `AsyncIterable<Row>` for streaming. Mutations must return a row with an
  `id`.
- Reads and writes go through `args.dataset` and `args.edges`. On mutate,
  `args.dataset` is the transaction-scoped view; a dataset captured at
  install time bypasses the transaction.
- A resolver that throws, or throws a `ResolverFrameError` to refuse, rolls
  back the whole transaction. Work that must survive that, such as recording
  the refusal, goes in `args.afterTx(fn)`, which runs once the transaction has
  settled either way; `fn` receives `{ committed }` so work that only makes
  sense after a commit can skip a rollback.
- No module-level mutable state. Two resolvers running in parallel must only
  see each other through the dataset and edges they share.

This keeps each resolver testable in isolation and makes the transaction
boundary the only thing you reason about for atomicity.

Writing directly to the dataset, as above, skips autoCRUD's side effects
(`_metadata` stamping, field validation, `postWrite`, subscriber events). If
you want those, go through the engine instead.

## Calling sibling resolvers

To get autoCRUD side effects for a write from inside your own resolver, call
`engine.mutate` with the autoCRUD frame. The engine is not constructed at
install time, so capture the handle in `onStart` and read it at call time:

```ts
import type {
  CoordinatorPlugin,
  EngineHandle,
  RequestContext,
  ResolverArgs,
  Row
} from '@mnmal-ai/substrate/sdk';

const holder: { engine?: EngineHandle } = {};

const plugin: CoordinatorPlugin = {
  name: 'closet',
  contractVersion: '>=1.0.0-alpha.0 <2.0.0',
  namespaces: [/* … */],
  async onStart(ctx) {
    holder.engine = ctx.engine; // late-bind
  }
};

async function markWorn(rctx: RequestContext, args: ResolverArgs): Promise<Row> {
  const engine = holder.engine;
  if (engine === undefined) throw new Error('engine not started');
  const key = 'closet/updateDress';
  const env = await engine.mutate({
    frame: { [key]: { params: { id: args.params?.id, lastWornAt: rctx.now }, fields: { id: true } } },
    ctx: rctx
  });
  if (env.errors !== undefined && env.errors.length > 0) {
    throw new Error(`${key} failed: ${env.errors[0]?.message ?? 'unknown error'}`);
  }
  return env.data[key] as Row;
}
```

**Check `errors` before reading `data`.** A refused frame comes back with its
key absent from `data` and the reason in `errors`; treating the missing key as
an empty result hides the failure. For queries, `queryAll` / `queryOne` in
`@mnmal-ai/substrate/sdk` do this check for you and throw `EngineQueryError`.

**Pass the caller's identity.** Forward `rctx` (or at least
`rctx.identity`). A context with `identity: null` is the system actor and
bypasses the per-frame namespace gate, which is right for scheduled
maintenance and wrong for work a caller asked for. `makeCtx(namespace, operation, identity)`
from the SDK builds a minimal context.

`plugins/substrate-proposals/src` uses this pattern throughout (see
`engine-write.ts` and `registry-store.ts`).

## Onboard contributions

A coordinator can provide a free-form JSON record that
`GET /substrate/v1/onboard` aggregates under
`instructions.plugins[<plugin-name>]`. Agents read it once at cold start to
learn the plugin's grammar without reading source.

```ts
const plugin: CoordinatorPlugin = {
  name: 'closet',
  contractVersion: '>=1.0.0-alpha.0 <2.0.0',
  namespaces: [/* … */],
  onboardInstructions: {
    summary: 'Track dresses and when they were last worn.',
    types: { Dress: 'A dress in the closet.' },
    workflows: {
      addDress: {
        frameKey: 'closet/createDress',
        params: 'name, size?, color?, acquiredAt',
        notes: ['Returns the persisted row including the server-allocated id and shortId.']
      }
    }
  }
};
```

The aggregated onboard also lists each plugin's conventional
`/substrate/v1/plugins/<name>/onboard` route under `instructions.pluginRoutes`.
Mount that route yourself so the advertisement is true:

```ts
import type { SubstrateResponse } from '@mnmal-ai/substrate/sdk';

const onboardBody = JSON.stringify(plugin.onboardInstructions);
const headers = { 'content-type': 'application/json' };
plugin.routes = (router) => {
  router.get('/onboard', (): SubstrateResponse => ({ status: 200, headers, body: onboardBody }));
};
```

What makes a good onboard body (see `plugins/substrate-proposals/src/onboard.ts`):

- a one-paragraph `summary`;
- when to use the plugin, and when not to;
- the mutations or workflows, keyed by frame key, with params and returns in
  plain prose;
- every error code the plugin can raise, with what to do about it;
- at least one complete frame an agent can copy.

Keep it short. Every agent fetches it at session start.

## Multi-instance considerations

You may run several replicas of the binary against one database. Things to
plan for:

### Cross-instance notification

Live updates (WS/SSE subscriptions) and schema proposals reach only the
process that made the change; subscribers on another replica do not see it.
Substrate does not notify one replica of another's out-of-band changes (for
example a registry change made at runtime). If your plugin needs that, accept
a notification transport in your plugin's factory and keep a no-op default
for single-instance use. `substrate-proposals` defines a minimal one:

```ts
interface PubSub {
  listen(channel: string, handler: (payload: string) => void | Promise<void>): Promise<void>;
  notify(channel: string, payload: string): Promise<void>;
}
```

Its bootstrap wires a no-op, and it treats reconcile-on-boot (replaying
persisted state in `onStart`) as the correctness floor, with notifications
only shortening the window. Make handlers idempotent; transports may
redeliver. Prefix channel names with your plugin name (proposals uses
`_substrate_proposals_<ns>`).

### Schema caches

If your plugin changes a registry after construction (`ctx.registry.replace(...)`
from a resolver), the engine notices through the registry's `epoch`, which the
core `Registry` advances on every `register` / `replace`. If you supply your
own `Registry` implementation, extend `RegistryBase` from
`@mnmal-ai/substrate/sdk` or expose `epoch` yourself; otherwise call
`engine.invalidateSchemaCaches(ns)` after each change.

### Idempotency

A caller can put `idempotencyKey` on a mutate frame entry (beside `params`,
not inside it). The engine dedups repeats within
`SUBSTRATE_IDEMPOTENCY_TTL_MS` and replays the cached envelope. Resolvers do
nothing special. Say in your onboard body whether callers should send one.

## Testing patterns

Three layers, increasing in fidelity and cost.

### Resolver-direct

Call the resolver with a hand-built `RequestContext` and `ResolverArgs`. No
engine, no loader.

```ts
import { MemoryDataset, MemoryEdgesStore } from '@mnmal-ai/substrate/testing';
import { describe, expect, it } from 'vitest';

describe('archiveOldOutfits', () => {
  it('archives outfits not worn for 30 days', async () => {
    const now = new Date('2026-04-26');
    const dataset = new MemoryDataset({ namespace: 'closet' });
    const edges = new MemoryEdgesStore({ now: () => now });
    await dataset.write('Outfit', [
      { id: '1', label: 'old', lastWornAt: '2026-03-01', archived: false },
      { id: '2', label: 'recent', lastWornAt: '2026-04-20', archived: false }
    ]);

    const result = await archiveOldOutfits(
      { identity: null, namespace: 'closet', operation: 'mutate', now, headers: {}, meta: {} },
      { dataset, edges, params: {} }
    );

    expect(result.archived).toBe(1);
  });
});
```

This exercises pure resolver logic only. AutoCRUD side effects (`_metadata`,
`shortId`, `postWrite`) do not run, because there is no engine.

### Engine-direct

Compose the plugin over memory datasets with `compose` from
`@mnmal-ai/substrate/testing`, and issue real frames with `engine.query` /
`engine.mutate` on the returned `engine`. This covers
everything except the transport: the full install, `_metadata` and `shortId`,
`postWrite`, filter validation, subscriptions and idempotency.

To run the same frames over Postgres, compose with `PgDataset` and
`PgEdgesStore` instead, after `runMigrations` (and `runDerivedMigrations` for
indexed list fields). All of these come from `@mnmal-ai/substrate/testing`. Call the
test-database guards from the same subpath first: they refuse a database that
isn't `_test`/`_dev` and a superuser role.

### HTTP / WebSocket

Run the composed server on `MemorySubstrateServer` from
`@mnmal-ai/substrate/testing` (in-process, no socket; drive it with
`server.inject(req)`). This adds the transport, serialisation and auth.
`plugins/substrate-sentinel/test/namespace.test.ts` boots a plugin this way
and is a good harness to copy.

## Worked example

A complete minimal coordinator: one type, one custom mutation, onboard
instructions and a scheduled task. Pair it with the bootstrap and manifest
from [Packaging and loading](#packaging-and-loading).

```ts
// src/index.ts
import type {
  CoordinatorPlugin,
  EngineHandle,
  NamespaceDefinition,
  RequestContext,
  ResolverArgs,
  Row
} from '@mnmal-ai/substrate/sdk';
import { defineNamespace, field, queryAll, ResolverFrameError } from '@mnmal-ai/substrate/sdk';

export interface ClosetConfig {
  namespace: string;
}

export function createClosetPlugin(config: ClosetConfig): CoordinatorPlugin {
  const ns = config.namespace;
  const holder: { engine?: EngineHandle } = {};

  const closetTypes = defineNamespace(ns, {
    Dress: {
      fields: {
        name: field.string(),
        color: field.string({ nullable: true }),
        acquiredAt: field.date(),
        lastWornAt: field.date({ nullable: true })
      }
    }
  });

  const namespaceDef: NamespaceDefinition = {
    namespace: ns,
    types: closetTypes.types,
    install(ctx) {
      closetTypes.install(ctx);
      ctx.registry.register('markWorn', {
        kind: 'mutation',
        resolver: async (rctx: RequestContext, args: ResolverArgs): Promise<Row> => {
          const id = args.params?.id;
          if (typeof id !== 'string' || id === '') {
            throw new ResolverFrameError('bad_request', 'markWorn requires params.id');
          }
          const engine = holder.engine;
          if (engine === undefined) throw new Error('closet: engine not started');
          // Go through autoCRUD so validation, _metadata and postWrite apply.
          const key = `${ns}/updateDress`;
          const env = await engine.mutate({
            frame: { [key]: { params: { id, lastWornAt: rctx.now }, fields: { id: true, lastWornAt: true } } },
            ctx: rctx
          });
          const err = env.errors?.[0];
          if (err !== undefined) throw new ResolverFrameError(err.code ?? 'update_failed', err.message ?? key);
          return env.data[key] as Row;
        }
      });
    }
  };

  return {
    name: 'closet',
    contractVersion: '>=1.0.0-alpha.0 <2.0.0',
    namespaces: [namespaceDef],
    async onStart(ctx) {
      holder.engine = ctx.engine;
    },
    onboardInstructions: {
      summary: 'Track dresses and when they were last worn.',
      mutations: {
        markWorn: {
          frameKey: `${ns}/markWorn`,
          params: { id: 'Dress id' },
          notes: ['Sets lastWornAt to the request time via autoCRUD update.']
        }
      }
    },
    schedule: [
      {
        name: 'closet-stale-count',
        intervalMs: 24 * 60 * 60 * 1000,
        async handler(taskCtx) {
          const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
          // System work: no caller identity to forward.
          const rows = await queryAll(taskCtx.engine, ns, 'Dress', { where: { lastWornAt: { lt: cutoff } } }, ['id']);
          taskCtx.metric('closet_stale_dresses', { count: rows.length });
        }
      }
    ]
  };
}
```

Top to bottom:

1. `holder` is the late-binding seam: empty at `install`, filled in
   `onStart`.
2. `closetTypes` installs autoCRUD for `Dress`.
3. `namespaceDef` runs that install, then registers `markWorn` on the same
   registry, and re-exposes `types` for kernel plugins.
4. `markWorn` updates through the engine and turns a refused frame into a
   coded error instead of returning `undefined`.
5. `onboardInstructions` appear under `instructions.plugins.closet` at
   `GET /substrate/v1/onboard`.
6. The scheduled task runs daily (`runOnStart` defaults to `false`; the
   minimum interval is 100 ms) and reports a metric. `taskCtx.engine` is the
   same `EngineHandle` the resolver uses.

## Further reading

- **Design reference**: [`substrate-from-first-principles.md`](substrate-from-first-principles.md),
  especially §4.6 (edges), §5.1 (autoCRUD), §5.4 (subscriptions), §5.11
  (coordinator plugins), §5.13 (async and cancellation), §5.14 (agent
  onboarding) and §6 (delete and edge semantics).
- **In-tree plugins**, smallest first:
  - `plugins/substrate-sentinel/src/index.ts`: namespace, schedule and routes.
  - `plugins/substrate-proposals/src/index.ts`: late-bound engine handle, runtime registry changes, cross-instance notification.
  - `plugins/substrate-recall/src/plugin.ts`: a kernel plugin with migrations, filter operators, kernel routes, an MCP tool, a virtual namespace and `contributePostWrites`.
- **Tier choice**: [`plugin-tier-decision.md`](plugin-tier-decision.md).

If this guide disagrees with the code, the code is right. Please open an
issue so the guide can be fixed.
