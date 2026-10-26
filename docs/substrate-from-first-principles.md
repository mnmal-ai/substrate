# Substrate — Design from First Principles

> **Audience:** developers and AI agents evaluating Substrate or building on it.
>
> **Stance:** this document is opinionated. It records *what* Substrate is and *why* each piece exists, including what trading it away would cost. The invariants in §2 are fixed; everything below them is an implementation choice that could change.
>
> **Companion docs:** [`getting-started.md`](getting-started.md) (install and first query), [`plugin-author-guide.md`](plugin-author-guide.md) (writing plugins), [`surface-parity.md`](surface-parity.md) (how HTTP, MCP, WS and SSE differ), [`ws-subscription-contract.md`](ws-subscription-contract.md) (live-update protocol).

---

## 1. The Problem

Substrate is a typed data substrate built for agents. An agent should be able to:

- Add new types at runtime, with exact, machine-readable shapes.
- Query those types at any depth, composing across namespaces and stores.
- Create, update, relate and delete data without anyone writing handlers.
- Evolve the schema as its understanding changes, without a deploy.
- Discover all of this from the server itself, with no source code to read.

Existing tools each cover part of this:

- **GraphQL** assumes a human-curated schema fixed at deploy time. It has no story for an agent proposing a type.
- **Document stores** (MongoDB, Firestore) allow flexible shapes but offer no typed contract, no composable resolution across types, and weak cross-collection relationships.
- **Relational databases** give typed rows and foreign keys but no resolver model, no wire-efficient query protocol, and no notion of the schema as a live, changeable artefact.
- **Vector and key-value stores** solve retrieval but do not model the type system an agent needs to reason about its data.

Substrate puts these into one system: a runtime type registry, a resolution engine, first-class cross-namespace edges, and agent-facing surfaces (MCP, onboarding, natural-language query) that are generated from the schema rather than written by hand.

---

## 2. Design Invariants

These are fixed. If an implementation trades one away, it is a different system.

### 2.1 Agent-first typed data

Types are runtime values. An agent can:

- Get a type declared in code with `defineNamespace(...)` (§4.1), or propose one over the wire with `<ns>/propose_type` through the built-in `substrate-proposals` plugin (§5.15).
- Use the type immediately: autoCRUD mutations and query resolvers exist as soon as it is registered, with no restart, deploy or handler code.
- Read the type's exact shape from the published schema and reason about results from it.

**Why fixed:** this is the reason the project exists. Without it Substrate is a generic data-access layer.

### 2.2 The schema is the contract

Everything downstream derives from the schema: wire encoding, client decoding, policies, edge propagation, the onboarding document, the MCP tool payloads. Schema evolution is a runtime event, not a migration script.

**Why fixed:** deriving everything from one schema is what keeps autoCRUD, schema-driven clients and agent-proposed types consistent with each other. Without it, every concern has to be reimplemented per type.

**Cost:** clients can hold a stale schema. The mitigation is at the wire layer — every response carries a `schemaVersion`, and a mismatch is loud (§7.1).

### 2.3 Namespaces are isolation

A namespace owns a schema, a dataset and a policy context. Types in namespace A cannot collide with types in namespace B. Cross-namespace composition is **explicit** — through cross-reference fields — never implicit.

**Why fixed:** one instance serving several independent applications only works if namespaces are real walls, not labels.

**Consequence:** every operation names its namespace at the call site. Clients hold no bound namespace (§4.7).

### 2.4 Zero-boilerplate autoCRUD is the starting point

Registering a type yields a list query and `get<T>`, `create<T>`, `update<T>`, `delete<T>` mutations (plus `purge<T>` when declared purgeable). Custom resolvers are additive, never required.

**Why fixed:** "an agent proposes a type and uses it immediately" falls apart if someone has to author resolvers first.

### 2.5 Protocol choice is a caller concern

HTTP, WebSocket, SSE, JSON, substrate-pack: one resolution pipeline underneath, one set of semantics. A bug fix in the engine fixes every transport; a cross-namespace edge resolves identically over each.

**Why fixed:** every place two transports implement the same thing separately is a bug waiting to be found. Transports that re-implement parts of the pipeline drift quietly.

**Differences are documented, not silent.** Some features are transport-specific (live updates are WS/SSE only, for example). [`surface-parity.md`](surface-parity.md) lists them.

### 2.6 The agent surface is complete

Every operation an agent needs is reachable from the primary agent surface. Today that is the MCP server (`substrate mcp`, §5.7), with HTTP and natural-language query as alternate surfaces. The invariant is **coverage**, not a fixed tool count.

An agent with a shell has a second way in: code mode. `substrate run` imports a TypeScript script and calls it with a signed client that has `query`, `queryAll`, `recall` and `mutate`. A count over many rows, a join across types, or a batch of writes chosen by what a read found then costs one call and returns one small result. Through MCP, the same work is a chain of tool calls passing ids from one to the next, and every intermediate result lands in the agent's context. Code mode adds composition, not capability: each operation inside a script is the same HTTP surface with the same grants and policy, so the coverage invariant holds for both. A run is guarded by default. It refuses to run unsigned and is read-only unless given `--dry-run` or `--write`, with a cap on frames written. A rejected frame fails the run rather than reading as empty, and truncated reads are reported. The [`substrate run` reference](../apps/substrate/README.md#substrate-run) has the details.

**Why fixed:** agents are the primary users. A gap in their surface is a gap in the product.

---

## 3. Layered Architecture

Six layers, each with one contract to the layer below. Implementations swap at layer boundaries; invariants do not cross them.

```
┌──────────────────────────────────────────────────┐
│  L5  Agent surface  (MCP, NL, CLI, TUI)          │  ← what agents call
├──────────────────────────────────────────────────┤
│  L4  Client         (@mnmal-ai/substrate/client) │  ← framework-agnostic
├──────────────────────────────────────────────────┤
│  L3  Transport      (HTTP, WS, SSE, pack)        │  ← wire protocols
├──────────────────────────────────────────────────┤
│  L2  Engine         (resolution, policy, edges)  │  ← the resolution machine
├──────────────────────────────────────────────────┤
│  L1  Resolvers      (per-type dispatch)          │  ← autoCRUD + custom
├──────────────────────────────────────────────────┤
│  L0  Types & store  (registry, dataset)          │  ← runtime schema + data
└──────────────────────────────────────────────────┘
```

**Contracts between layers:**

- **L0 → L1:** the registry exposes `register`, `replace`, `get`, `has`, `all`. The dataset exposes `read`, `write`, `tombstone`, `purge`, `updateField`, `withTransaction` and a few more (§4.5).
- **L1 → L2:** a resolver is `(ctx, args) => Promise<Row | Row[] | ReadResult | null>` (or an async iterable, for streams). The engine does not care how rows were produced.
- **L2 → L3:** the engine takes a frame `{ "<ns>/<name>": { params, fields } }` and returns an envelope (§7.0). Transports convert bytes to and from this shape.
- **L3 → L4:** the client holds a connection, fetches the federated schema, and exposes `query`, `mutate`, `subscribe`, `stream`. Transport details are invisible.
- **L4 → L5:** MCP, NL and the CLI call through HTTP. They do not know what is underneath.

**Consequence:** a unit test at any layer exercises that layer's contract against a stub below it. An integration test runs the full stack on `MemoryDataset`.

---

## 4. Core Primitives

Eight primitives. Everything in Substrate is one of these or composed from them.

### 4.1 Type

A declared shape with named fields. Types are declared as data, with no decorators or build transforms:

```ts
import { defineNamespace, field } from '@mnmal-ai/substrate/sdk';

export const prices = defineNamespace('prices', {
  Price: {
    fields: {
      value: field.number(),
      currency: field.string(),
      validFrom: field.date({ nullable: true })
    }
  }
});

export const products = defineNamespace('products', {
  Product: {
    fields: {
      name: field.string(),
      priceId: field.crossRef('prices', 'Price', { onDelete: 'set_null' }),
      tags: field.list(field.string())
    }
  }
});
```

Or proposed at runtime through the proposals plugin (§5.15):

```jsonc
{ "catalog/propose_type": { "params": {
    "typeName": "Price",
    "fields": { "value": { "kind": "scalar", "type": "number" },
                "currency": { "kind": "scalar", "type": "string" } },
    "proposedReason": "need prices" } } }
```

The field DSL (`field.*`) covers scalars (`string`, `number`, `boolean`, `date`, `json`, plus `enum` and `vocab` string variants), `crossRef`, `struct` and `list`. Every `FieldDef` may carry `nullable` — metadata only: the engine does not enforce it, but schema consumers use it to document shapes that legitimately produce `null`. Scalars may carry `indexed` (`true` builds an index; unset, the SDK default, builds none; `false` builds none and marks the field as not a search handle; the field filters either way, §5.2), `readonly`, and `serverSet` (a server-managed timestamp the caller cannot supply).

A type input to `defineNamespace` carries its fields plus optional `policy` (§4.4), `autoCrud: false` (opt out), `purgeable`, `adminCapability`, a `postWrite` hook and `embed` metadata (consumed by the recall plugin, §5.10).

Every autoCRUD type also gets a reserved, readonly, indexed `shortId: number` — a small human-friendly id allocated on create, alongside the primary `id`.

Server-managed metadata (`createdAt`, `updatedAt`, `createdBy`, `updatedBy`) is stamped by the server and read through the `_metadata` projection. A create or update that supplies one of them is rejected with `client_supplied_server_field`.

### 4.2 Registry

Keyed by name. Holds one entry per registered type or mutation. One registry per namespace. Schema publication walks the registry to produce the published `Schema` (§7.0).

```ts
interface RegistryEntry {
  resolver: Resolver;                    // engine dispatch target (§4.3)
  policy:   Policy;                      // allowAll when omitted
  fields:   Record<string, FieldDef>;    // type entries; {} otherwise
  kind:     'type' | 'mutation';         // routes publication to types vs mutations
  params:   Record<string, FieldDef>;    // mutation entries; {} for types
  returns?: FieldDef;                    // mutation return shape
  verb?:    AutoCrudVerb;                // set on autoCRUD entries; visible to policies as ctx.verb
}
```

`kind` is explicit. Name case is not a discriminator, and `kind` defaults to `'type'`. autoCRUD registers the list resolver as `kind: 'type'` under the type's own name, and every `get<T>` / `create<T>` / `update<T>` / `delete<T>` as `kind: 'mutation'`.

`params` / `returns` are the mutation's input and output contract. Schema publication emits them under `Schema.mutations[name]`, and the substrate-pack encoder uses `returns` to positionally encode mutation results. A mutation registered without `returns` gets a fallback descriptor (`{ kind: 'scalar', type: 'string', nullable: true }`); consumers should treat it as "unknown shape" and pass the value through as JSON.

The engine reads only `resolver` and `policy`. `fields` / `params` / `returns` exist for schema publication and validation.

### 4.3 Resolver

`(ctx: RequestContext, args: ResolverArgs) => Promise<Row | Row[] | ReadResult | null>`. The engine decides single vs list from the runtime value, not from `nullable`:

- `Row[]` (or a `ReadResult` page) surfaces as `shapes[key]: 'list'` (§7.0).
- `Row` surfaces as `shapes[key]: 'single'`.
- `null` surfaces as `shapes[key]: 'single'` with `data[key]: null` — the legitimate "no such row" answer for `get<T>`. Making null a first-class single value keeps the envelope truthful without sentinel values.

A streaming resolver returns an `AsyncIterable<Row>` instead (§5.5).

`ResolverArgs` carries `params`, `fields`, `rows` (for post-resolve policies), the transaction-scoped `dataset` and `edges`, an `AbortSignal`, and `onWrite` (§5.4). Resolvers that do I/O MUST use `args.dataset`, not a dataset captured at registration, so their writes join the engine's transaction.

A resolver can refuse a frame with a specific error code by throwing `ResolverFrameError(code, message, details?)`. The engine turns it into an envelope error `{ message, code, path: [key] }` instead of the generic `resolver_error`. Use it when the refusal depends on runtime state a policy cannot express, or when the client needs a distinct code to branch on.

### 4.4 Policy

An authorization function attached to a resolver at registration.

```ts
type Policy = (ctx: RequestContext, args: ResolverArgs) => PolicyDecision;

interface RequestContext {
  identity: Identity | null;          // verified principal; null for anonymous
  namespace: string;                  // the addressed namespace
  operation: 'query' | 'mutate' | 'subscribe' | 'stream';
  now: Date;
  headers: Record<string, string>;    // raw request headers (read-only)
  meta: Record<string, unknown>;      // per-connection (WS) or per-request
  verb?: AutoCrudVerb;                // which autoCRUD verb, when applicable
  // plus clientIp, authEnabled, entry
}

interface Identity {
  id: string;                         // stable principal id (user, service, agent)
  grants: Record<string, string[]>;   // per-namespace capabilities; '*' is a legal key
  [k: string]: unknown;
}

interface PolicyDecision {
  allow: boolean;
  reason?: string;                    // surfaces to the caller on deny
  obligations?: Obligation[];         // e.g. row filters
}

interface Obligation {
  kind: string;                       // e.g. 'row-filter'
  [k: string]: unknown;
}
```

Obligations are an extension channel. Composition MUST preserve them (`and`/`or` merge the obligation lists of allow decisions). The engine currently acts on one kind, `row-filter`.

**Built-in policies** (`@mnmal-ai/substrate/sdk`, also re-exported from `@mnmal-ai/substrate/client`): `allowAll`, `denyAll`, `requireIdentity`, `requireCapability(name)`, `requireNamespace(ns)`, `row<T>(predicate)`, and the combinators `and`, `or`, `not`.

```ts
import { and, requireCapability, requireIdentity, row } from '@mnmal-ai/substrate/sdk';

const canMutate   = requireCapability('mutate');
const ownRowsOnly = row<Price>((ctx, price) => price.ownerId === ctx.identity?.id);

defineNamespace('prices', {
  Price: {
    fields: { /* … */ },
    policy: and(requireIdentity(), canMutate, ownRowsOnly)
  }
});
```

`defineNamespace` composes three layers with `and(...)`: plugin-global policies (§5.11), a namespace-global `opts.policy`, and the per-type `policy`. All must allow.

**Collection-scoped policies** (`requireIdentity`, `requireCapability`, `requireNamespace`) run before the resolver and short-circuit. Their reasons surface to the caller on deny.

**Row-scoped policies** run after the resolver. `row<T>(predicate)` is an ordinary `Policy` that always allows and attaches a `row-filter` obligation:

```ts
function row<T>(predicate: (ctx: RequestContext, row: T) => boolean): Policy {
  return () => ({ allow: true, obligations: [{ kind: 'row-filter', predicate }] });
}
```

So row policies compose with `and`/`or` like any other, and the engine needs no separate code path. After the resolver returns, the engine applies every `row-filter` obligation as a filter. Denied rows are **silently removed**, not reported. Row filters run as fetch-then-filter today; pushing expressible predicates into the dataset query is an optimisation, not a change to the security property.

**Composition rules:**

- `and(p1, p2, …)` — all must allow; stops at the first deny and returns its reason. `and()` with no arguments allows.
- `or(p1, p2, …)` — any may allow; stops at the first allow. If all deny, the **last** deny's reason is returned. `or()` with no arguments denies with `'or(): no policies'`.
- `not(p)` — inverts allow/deny.
- **Combinators catch errors thrown by inner policies** and treat them as a deny with `reason: 'policy error'`, so composition is safe even outside the engine (tests, middleware). Policies MUST NOT throw; doing so is a bug.
- **Caught errors are never inverted or masked.** `not(boom)` stays denied with `'policy error'`; `or(boom, denyAll('X'))` returns `'policy error'`, not `'X'`. Turning a policy bug into a silent grant, or hiding it behind a sibling's reason, would make real bugs invisible.
- **Obligations accumulate:** `and(allowA, allowB)` carries both lists; `or` carries only the winning policy's.

**Why this shape:** authorization decisions are data transformations. Composable functions express capability checks, namespace gates and row-level rules in one model, where a fixed enum (`requireAuth` / `denyAll`) runs out quickly.

Rate limiting is a route-layer concern, not a policy. Policies decide authorization, not throughput.

### 4.5 Dataset

A storage implementation. The engine is storage-blind.

```ts
type Id = string | number;

interface Row {
  id: Id;
  _deletedAt?: Date | null;          // tombstone marker; null/absent = live
  [field: string]: unknown;
}

interface ReadParams {
  id?: Id;
  ids?: Id[];                         // ANDed with any other predicate
  includeDeleted?: boolean;           // default false
  where?: WhereClause;                // §5.2
  orderBy?: OrderByClause[];          // §5.2; id appended as final tie-breaker
  limit?: number;                     // MUST be pushed down to storage
  cursor?: string;                    // from a prior ReadResult.nextCursor
  _allowTableScan?: boolean;          // deprecated, ignored
}

interface ReadResult { rows: Row[]; nextCursor?: string; hasMore: boolean; }

interface Dataset {
  readonly namespace: string;         // bound at construction
  readonly txScopeId: string;         // equal ids = can share one transaction
  readonly capabilities: FilterCapabilities;   // §5.2
  read(type: string, params: ReadParams): Promise<ReadResult>;
  write(type: string, rows: Row[], options?: WriteOptions): Promise<WriteResult>;
  tombstone(type: string, ids: Id[]): Promise<DeleteResult>;   // soft delete
  purge(type: string, ids: Id[]): Promise<DeleteResult>;       // hard delete
  updateField(ref: UpdateFieldRef, fieldName: string, value: unknown): Promise<void>;
  conditionalUpdate(type: string, id: Id, match: Record<string, unknown>,
                    updates: Record<string, unknown>, actor?: ActorIdentity): Promise<ConditionalUpdateResult>;
  dropType(type: string): Promise<DropResult>;
  dropNamespace(): Promise<DropResult>;
  withTransaction<T>(fn: (tx: Dataset) => Promise<T>): Promise<T>;
  // plus optional lock and scoped-transaction helpers
}
```

**Reads hide tombstones** by default; pass `includeDeleted: true` to see them.

**`limit` is a contract, not a hint.** Every implementation MUST push it into the storage scan (memory: early break; pg: `LIMIT n`). A resolver MUST NOT trim results itself, so the limit stays observable all the way to the wire. `hasMore` and `nextCursor` drive the envelope's `_pagination` block.

**One dataset, one namespace.** The engine keeps a `DatasetRegistry` (namespace → dataset) and routes each frame entry by its key prefix (§4.7). The optional `ns` on `updateField`'s ref is diagnostic; if present it MUST match the bound namespace or the call fails with `NamespaceMismatch`. One dataset serves many types within its namespace.

**Missing rows.** `tombstone` and `updateField` are silent no-ops on a missing row: the sweep can race a purge, and failing a sweep cycle over a benign race would break idempotency. `write` on an existing id is an upsert (merge). `purge` on a missing row returns `{ deleted: 0 }`.

**`_deletedAt` is reserved.** Only `tombstone` sets it. `updateField` rejects writes to it with `ReservedField`; `write` ignores a caller-supplied `_deletedAt`, including `null`. No write shape can revive a tombstone — reviving is an application-level operation (write a fresh row). `purge` removes live and tombstoned rows alike.

**Tombstone vs purge, for edges.** A tombstoned target reads as `DELETED` to the sweep and goes through the normal policy path. A purged target reads as `MISSING`, which for a local target is treated as deleted (§6.3), so purge also cascades through edge policies. Prefer `tombstone` for routine deletes; reserve `purge` for erasure workflows. Tombstoned rows are hard-deleted by the sweep after a retention window (`SUBSTRATE_TOMBSTONE_RETENTION_DAYS`, default 30).

**`conditionalUpdate`** is an atomic compare-and-set by primary key: if the row exists and every field in `match` equals the stored value, apply `updates`; otherwise write nothing. It exists for one-shot transitions such as consuming an invite exactly once under concurrent registrations.

**Transactions.** `withTransaction(fn)` gives a callback-scoped atomic section. Operations on `tx` commit together on resolve or roll back together on throw. Operations on the outer dataset inside `fn` bypass the transaction — a caller bug. The engine wraps each `mutate` call's single-frame entries in one transaction (array-valued entries get their own, §5.13) and passes the `tx` view to resolvers as `args.dataset`.

**`txScopeId`** identifies the underlying store. Two datasets with equal `txScopeId` (for example, two pg namespaces on the same connection pool) can join one transaction; datasets with different ids cannot (§5.3).

**Reference implementations:** `MemoryDataset` (`@mnmal-ai/substrate/testing`; tests and ephemeral use) and `PgDataset` (production, inside the binary). A native production install requires Postgres with the pgvector extension. Other stores can implement the same interface.

**Invariant:** a query composed across memory and pg datasets returns the same results as the same query run entirely on either.

### 4.6 Edge

Cross-namespace references are a first-class primitive, stored in their own table rather than smuggled into a hidden namespace.

```ts
interface EdgeRef {
  ns: string;
  type: string;
  id: Id;
  bridged?: boolean;                  // true when the ref addresses a bridged namespace
}

type OnDelete = 'set_null' | 'cascade' | 'restrict' | 'orphan';

interface Edge {
  id: string;                         // ULID; primary key
  from: EdgeRef;
  to: EdgeRef;
  fieldName: string;                  // the crossRef field on `from` that produced this edge
  policy: OnDelete;                   // snapshotted at write time
  createdAt: Date;
  deletedAt?: Date;                   // tombstone; terminal
  lastSweptAt?: Date;                 // last sweep observation
  blocked?: boolean;                  // cascade blocked by an unreachable bridge (§6.5)
}
```

**Policy is snapshotted when the edge is written.** If a field's `onDelete` changes later, existing edges keep the old value. Silently changing policy on live edges would break the audit trail the sweep relies on.

**`bridged` is snapshotted too**, so the sweep's routing decision for an edge is deterministic even if a namespace is later re-plumbed.

**Storage:** one edges table per instance, indexed on `to` (for the sweep) and on `from` (for reads). An edge can reference rows in any dataset, including bridged remotes.

```ts
interface EdgesStore {
  write(input: EdgeWriteInput): Promise<Edge>;
  tombstone(id: string, at?: Date): Promise<void>;
  update(patch: EdgePatch): Promise<void>;          // only lastSweptAt / blocked
  readNextBatch(cursorId: string | null, size: number): Promise<{ edges: Edge[]; lastId: string | null }>;
  findEdgesTo(ref: EdgeRef): Promise<Edge[]>;
  findEdgesToMany(refs: readonly EdgeRef[]): Promise<Edge[]>;
  findEdgesFrom(ref: EdgeRef): Promise<Edge[]>;
  canDelete(ref: EdgeRef): Promise<{ ok: true } | { ok: false; blockedBy: Edge[] }>;
  findBlocked(): Promise<Edge[]>;                   // admin tooling
  findEdgesTouchingNamespace(ns: string, limit: number): Promise<Edge[]>;
  findEdgesTouchingType(ns: string, type: string, limit: number): Promise<Edge[]>;
  namespacesLinkedTo(ns: string, type?: string): Promise<string[]>;
  dropEdgesByNamespace(ns: string, within?: readonly string[]): Promise<number>;
  withTransaction<T>(fn: (tx: EdgesStore) => Promise<T>): Promise<T>;
}
```

`update` takes a narrow patch: `id` plus `lastSweptAt` and/or `blocked`. `from`, `to`, `policy`, `fieldName` and `createdAt` are immutable. `deletedAt` is set only by `tombstone` and is terminal; `update` MUST preserve it, so a stale in-memory copy cannot resurrect a tombstoned edge.

`canDelete` is what the mutation path checks before tombstoning a target: if any live edge with policy `restrict` points at it, the delete is refused (§6.2). Other policies always return `ok: true`; they are resolved by propagation.

**Tombstoned edges are terminal.** The sweep skips them. So an edge retired because the `from` row changed its reference (`update Product { priceId: 99 }` tombstones the old edge and writes a new one) never fires its policy — correct, because the target was never touched.

**Transactions.** The engine nests the edges transaction inside the dataset transaction, so a throwing resolver rolls back both row and edge writes.

**Lifecycle:**

```
create Product { priceId: 42 }
  → dataset.write('Product', row)
  → edges.write({ from: products/Product/<new>, to: prices/Price/42,
                  fieldName: 'priceId', policy: 'set_null' })

update Product { priceId: 99 }
  → edges.tombstone(old edge) + edges.write(new edge)

delete Product
  → edges.tombstone(every edge from this product)

delete Price 42
  → dataset.tombstone('Price', [42])
  → apply each incoming edge's policy (§6.2), locally or via the sweep
```

A crossRef field may also declare `onMissing: 'reject'`, which refuses a create or update whose reference points at a missing or tombstoned target. The default is `'allow'`. It applies only to locally resolvable targets.

**Why this shape:** edges are operational data (policies, timestamps, sweep state), not application data. A dedicated table keeps the type system clean and makes the sweep a scan of one table.

### 4.7 Namespace

A namespace is `{ schema, registry, dataset, policies }`, the isolation primitive. It is either:

- **Local** — hosted by this instance, or
- **Bridged** — hosted by a remote Substrate instance and federated in under a local alias (§5.8).

**Every operation names its namespace.** Frames are maps keyed by qualified names:

```
QualifiedKey := <ns>/<name>        (name is a type for queries, a mutation for mutate)
```

The parser splits on the first `/`. Namespace names may not contain `/` or `:` — `/` would truncate every frame key, and `:` would be ambiguous with per-namespace grant syntax (`plane:read`). A bridged namespace is addressed by its local alias exactly like a local one.

```jsonc
// POST /substrate/v1/query
{
  "products/Product": { "params": { "limit": 20 }, "fields": { "id": true, "name": true,
                        "priceId": { "value": true, "currency": true } } },
  "prices/Price":     { "params": { "where": { "currency": { "eq": "USD" } } },
                        "fields": { "id": true, "value": true } }
}
```

The response mirrors the request: `envelope.data['products/Product']`, `envelope.shapes['products/Product']`. The engine parses each key, resolves `<ns>` to its registry and dataset, and sets `ctx.namespace` per entry. There is no out-of-band namespace header.

**Why one qualified string:** it is easy to log, paste, pass through an MCP tool argument and show in an error, and it removes the "did you pass the namespace?" class of mistakes. Internally it decomposes to `{ ns, name }` on ingress, so nothing is lost.

**Why no bound namespace on the client:** a client bound to one namespace needs proxy objects or sibling clients to reach a second. With qualified keys, one client reaches every namespace and every call is self-describing.

Selecting sub-fields of a crossRef field (`priceId: { value: true }`) makes the engine join through the edges table to the target namespace, apply that namespace's read policy, and assemble the result.

### 4.8 Server

The HTTP/WebSocket transport, abstracted the way `Dataset` abstracts storage. The engine, the binary and every plugin are blind to the underlying framework.

```ts
interface SubstrateRequest {
  method: HttpMethod;
  path: string;
  headers: Record<string, string>;
  query: Record<string, string>;
  params: Record<string, string>;     // path params from the router
  body: Buffer | null;                // raw bytes; caller decodes per Content-Type
  identity?: Identity;                // set by auth middleware
}

interface SubstrateResponse {
  status: number;
  headers?: Record<string, string>;
  body?: Buffer | Uint8Array | string | ReadableStream;
}

type HttpHandler = (req: SubstrateRequest) => SubstrateResponse | Promise<SubstrateResponse>;

interface WsConnection {
  readonly id: string;
  send(frame: Buffer | Uint8Array | string): void;
  onMessage(cb: (frame: Buffer) => void): void;
  onClose(cb: (code?: number) => void): void;
  close(code?: number, reason?: string): void;
}

type WsHandler = (req: SubstrateRequest, conn: WsConnection) => void | Promise<void>;

interface SubstrateServer {
  start(opts?: StartOpts): Promise<{ address: string; port: number }>;
  stop(opts?: { grace?: number; abortInFlight?: boolean }): Promise<void>;
  route(method: HttpMethod, path: string, handler: HttpHandler): void;
  websocket(path: string, handler: WsHandler): void;
  createPluginRouter(plugin: { name: string }): PluginRouter;
  onError?(hook: (err: Error, req?: SubstrateRequest) => void): void;
  inject?(req: Partial<SubstrateRequest>): Promise<SubstrateResponse>;  // in-process test hook
  // plus abortAllRequests, onShutdown and request observers
}

interface PluginRouter {
  get(path: string, handler: HttpHandler): void;
  post(path: string, handler: HttpHandler): void;
  put(path: string, handler: HttpHandler): void;
  delete(path: string, handler: HttpHandler): void;
  patch(path: string, handler: HttpHandler): void;
  websocket(path: string, handler: WsHandler): void;
}
```

**One request type for both transports.** A WebSocket upgrade is an HTTP GET, so WS handlers receive the same `SubstrateRequest` (`method: 'GET'`, `body: null`). Upgrade concerns live on `req`, live-socket operations on `conn`. Auth middleware that sets `req.identity` therefore runs identically for HTTP and WS.

**Plugins get a scoped router**, prefixed `/substrate/v1/plugins/<name>`. They never touch the raw server.

**Implementations:** `FastifySubstrateServer` (production, inside the binary) and `MemorySubstrateServer` (`@mnmal-ai/substrate/testing`, in-process with no socket; tests call `inject(req)`). Other runtimes can be added behind the same interface without touching the engine.

**Scope boundary.** `SubstrateServer` abstracts the HTTP runtime, not the engine's language: everything below it runs in the same Node process. Moving the engine out of process would need a second, engine-level protocol; substrate-pack (§7) is already language-neutral, but that protocol is not specified.

---

## 5. Feature Modules

Opt-in layers built on the primitives. Each should be removable without breaking an invariant.

### 5.1 autoCRUD

Default resolvers for every type registered through `defineNamespace` (opt out per type with `autoCrud: false`). For a type `Todo`:

| Entry | Kind | Behaviour | Declared `returns` |
|---|---|---|---|
| `Todo` | type | list: `{ where?, orderBy?, limit?, cursor?, _allowTableScan? }`; filter validation (§5.2) runs first | — |
| `getTodo` | mutation | `{ id }` → row or `null` | struct of the fields, nullable |
| `createTodo` | mutation | insert; generates an id if absent; writes edges for crossRef fields | struct of the fields |
| `updateTodo` | mutation | `{ id, ...fields }` — id-based multi-field update, one `write()` inside the engine transaction; an id miss returns `null` | struct of the fields, nullable |
| `deleteTodo` | mutation | `{ id }` — two-phase delete (§6.2) | `{ id, deleted }` |
| `purgeTodo` | mutation | `{ id }` — hard delete; installed only when `purgeable: true`, gated on the admin capability | — |

A `restrict` edge pointing at the row makes `delete` return a `restrict_violation` error without tombstoning. Other entries in the same `mutate` call keep their writes: restrict is a clean refusal, not a storage failure, and does not roll the transaction back.

Filter-based update (`update` with a `where`) is not implemented.

Hard-destructive operations (purge, the admin drop routes) can be switched off per instance with `SUBSTRATE_HARD_DELETE=refuse`, which makes them fail with `destructive_ops_disabled` regardless of caller capability.

### 5.2 Filter, orderBy, pagination

**Shape:**

```jsonc
{ "prices/Price": {
    "params": {
      "where": {
        "AND": [
          { "value": { "gte": 20, "lt": 100 } },
          { "currency": { "in": ["USD", "EUR"] } },
          { "OR": [ { "label": { "contains": "premium" } }, { "tier": { "eq": "pro" } } ] }
        ]
      },
      "orderBy": [{ "createdAt": "desc" }, { "value": "asc" }],
      "limit": 50,
      "cursor": "…"
    },
    "fields": { "id": true, "value": true, "currency": true } } }
```

**Operators by field kind.** The canonical lists live in `packages/substrate-filter/src/builtin-operators.ts`; when a filter is rejected, the error names the operator, the field and its kind, which is the reliable way to learn what a field accepts.

| Field kind | Operators |
|---|---|
| number, date | `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `between`, `in`, `nin` |
| string | the number set plus `contains`, `startsWith`, `endsWith` |
| boolean | `eq` |
| crossRef | `eq`, `neq`, `in`, `nin` on the target id (`neq: null` finds rows that point at something) |
| list | `has` (element membership) |
| json | through a path predicate only: `{ values: { path: ['year'], gt: 1990 } }`. Supports the string set plus `has`. Type-strict: `1995` does not match `"1995"`. Equality-style predicates are index-served when the field is declared `field.json({ indexed: true })`; anything else scans the type's rows. |

`eq: null` is the is-null test and works on every kind.

Plugins can contribute extra operators (the recall plugin adds `embeddingSimilar`, §5.10).

**Logical combinators:** `AND` / `OR` (arrays) and `NOT` (single). Multiple fields at one level are implicitly ANDed.

**Engine responsibilities:**

- **Validate against the schema before dispatch.** Unknown fields (`unknown_field`), unknown operators and type-mismatched values are rejected with a `FilterValidationError` and never reach the dataset. An unknown name in a filter is rejected because a filter the server cannot evaluate would silently widen the result.
- **Negotiate with the dataset.** Each dataset declares `capabilities.operators` per field kind; the engine rejects anything the dataset cannot evaluate, rather than returning silently empty results.
- **Never refuse for want of an index.** A filter on an unindexed field, or a sort on an unindexed non-json scalar, is accepted and scans. Sorting on a crossRef, list, struct or json field is still refused (`orderby_nonscalar`). `_allowTableScan` is accepted and ignored, and `unindexed_field` is no longer produced.

**Pagination is cursor-based.** The cursor is opaque: base64url(JSON) of the last row's `orderBy` values plus its id. The next page re-runs the query with `(orderBy tuple) > (last seen tuple)` — exclusive, so it starts after the cursor row. With `id` as the final tie-breaker this survives data changes between pages without duplicates or gaps. If `orderBy` omits `id`, the engine appends `{ id: 'asc' }`. The `where` clause re-applies on every page. The envelope carries `_pagination[key] = { nextCursor?, hasMore }`. Under a row-filter policy the cursor is sealed (encrypted with a key derived from `SUBSTRATE_STREAM_TICKET_SECRET`, or held only by the process when that is unset), because the row it names may be one the caller cannot see; without the secret a sealed cursor stops opening when the server restarts or on another replica. An unsealed cursor is refused there.

**Remote list reads are bounded.** A query over HTTP (and MCP, which goes through it) that names no `limit` gets the default page, `SUBSTRATE_PAGE_LIMIT_DEFAULT` (100); a `limit` above `SUBSTRATE_PAGE_LIMIT_MAX` (1000) is refused with `limit_exceeds_max`, and one that is not a non-negative integer with `invalid_limit`. Page with the cursor to read further. In-process engine callers are not bounded. A subscription's first snapshot is bounded the same way by `SUBSTRATE_SNAPSHOT_LIMIT`, counting only the rows the subscriber may see; under a row policy the snapshot reads up to 100 pages to find them, and a larger subscription is refused with `snapshot_too_large` (narrow it with `where`).

**Semantics worth knowing:**

- `orderBy` accepts scalar fields only (`orderby_nonscalar` otherwise).
- `contains` / `startsWith` / `endsWith` are **case-insensitive** on every reference dataset (memory evaluator and pg `ILIKE`).
- String range operators are **lexicographic**: memory compares UTF-16 code units, pg uses column collation. They agree for ASCII-shaped keys (ISO-8601 timestamps, ULIDs, zero-padded sequences), which is what they are for; arbitrary Unicode may differ.
- **NULLs sort last** regardless of direction.

**Not included:**

- **Full-text or semantic search** as a filter operator over prose. Search has its own index and ranking concerns; it lives in the recall plugin (§5.10).
- **Predicates through an edge** (`{ priceId: { value: { gte: 20 } } }`). Only the target id is filterable.
- **Aggregations** (`count`, `sum`, `avg`).

### 5.3 Transactions and batched mutations

A `mutate` call runs its single-frame entries in one transaction on the addressed store, via `withTransaction` (§4.5). They commit together or not at all. If any entry is refused (outside the caller's grant, denied by policy, invalid, or a resolver's `ResolverFrameError`) or its resolver throws, every single-frame entry in the call rolls back, and each of the others comes back with `frame_rolled_back`. So a retry repeats nothing. Virtual mutations run outside the transaction, so their results stand.

Work that must outlive a rollback, such as an audit row recording a refusal, goes through `args.afterTx(fn)`: `fn` runs once the transaction has settled, committed or rolled back, and receives `{ committed }` saying which; autoCRUD's `postWrite` uses it to run only after a commit. A failure there is reported as the `engine_after_tx_failed` metric and does not change the envelope.

**One store per transaction.** Before dispatch the engine groups single-frame entries by their dataset's `txScopeId`. More than one group → the call is refused with `cross_tx_scope_refused`; no resolver runs and no transaction starts. Entries in different namespaces that share a store (for example two pg namespaces on one pool) proceed in one transaction. The engine does not attempt two-phase commit; cross-store propagation (edges to other stores, bridge writes) is eventually consistent via the sweep (§6.3). Queries are not subject to this check.

**Array-valued entries** (`{ "ns/createTodo": [frame1, frame2] }`) are batched mutations with their own transaction; see §5.13.

A `mutate` resolves when its transaction has committed and same-store edge propagation is complete.

### 5.4 Subscriptions

A subscribe frame has the same shape as a query frame and returns an initial snapshot followed by pushed updates. Live updates are available over WebSocket (`/substrate/v1/ws`) and SSE (`/substrate/v1/subscribe`); there is no MCP subscription tool.

**Filter semantics:**

- **The snapshot** honours `where`, `orderBy` and `limit` exactly like a query, and row-filter obligations apply.
- **Pushes are filtered server-side** against the subscription's `where` and the row-filter obligations captured at subscribe time. A row that stops matching yields `remove`; a row that starts matching yields `add`; a row that still matches yields `update`.
- **`orderBy` is advisory for pushes.** The client places updates in its own ordered view.
- **Subscribe params are a subset of query params:** `where`, `orderBy`, and the ignored `_allowTableScan`. `limit` is refused (`unknown_param`) because a capped live view would need server-side state to stay meaningful.
- **`remove` carries only the id** (`removedId`). The client already has the row.
- **Write events.** Write-path resolvers announce committed writes via `args.onWrite({ ns, type, id, operation, row? })`. The engine collects them inside the transaction and fans out only after commit, so a rolled-back mutation pushes nothing.

**Back-pressure.** Subscriptions assume the client keeps up. Updates queue per subscription (default limit 256); on overflow the server ends the subscription with an `error` frame (`code: 'subscription_overloaded'`) followed by `end { reason: 'subscription_overloaded', final: true }`. Resubscribe to recover — the snapshot is the recovery path. Full contract: [`ws-subscription-contract.md`](ws-subscription-contract.md).

**Reconnection.** The client reconnects with backoff and resubscribes; the server sends a fresh snapshot. Callers should treat snapshots as idempotent replacements.

**WS frames** (exported from `@mnmal-ai/substrate/sdk`): one request shape and one response shape for both subscriptions and streams.

```ts
interface WsRequestFrame {
  id: string;                                  // client-generated; correlates responses
  op: 'subscribe' | 'stream' | 'cancel' | 'whoami';
  frame?: Record<string, { params?: Record<string, unknown>; fields?: FieldInput }>;
}

type WsResponseKind = 'snapshot' | 'add' | 'update' | 'remove' | 'chunk' | 'end' | 'error';

interface WsResponseFrame {
  id: string;
  kind: WsResponseKind;
  schemaVersion?: string;
  data?: unknown;                              // named objects (JSON) or positional (substrate-pack)
  shapes?: Record<string, 'single' | 'list'>;
  removedId?: Id;                              // kind === 'remove'
  errors?: Array<{ message: string; code?: string; path?: string[] }>;
  final?: boolean;
  sequence?: number;                           // streams
}
```

**Encoding.** A client that sends `Sec-WebSocket-Protocol: substrate-pack` (`WS_SUBPROTOCOL_SUBSTRATE_PACK` in `@mnmal-ai/substrate/pack`) gets msgpack with positional rows; otherwise frames are JSON with named objects. The engine always produces named-object frames; the route serialises per connection.

**On SSE, refusals arrive in-band.** Once the stream has opened, the HTTP status is already `200`; a failure arrives as an `event: error` frame. Read the stream, not the status. Browsers cannot send headers with `EventSource`, so SSE authentication uses a short-lived signed ticket from `POST /substrate/v1/stream/ticket` (signed with `SUBSTRATE_STREAM_TICKET_SECRET`, required when auth is on).

### 5.5 Streaming

A stream frame emits rows one at a time as the resolver yields them, over WS (`op: 'stream'`) or SSE (`/substrate/v1/stream`). Use it for large result sets and progressive processing.

- **Opt-in per resolver.** A stream needs a resolver that returns an `AsyncIterable<Row>`. autoCRUD resolvers do not, and reaching one through `stream` yields `not_streamable`.
- **One key per stream** (`stream_multi_key` otherwise), so per-row ordering is never interleaved.
- **Filters validate exactly as for queries**, and row-filter obligations apply per chunk.
- **Frames:** `chunk` frames with a monotonic `sequence` from 0, then a terminal `end` or `error`.
- **Cancellation.** The engine passes an `AbortSignal` as `args.signal`; well-behaved resolvers release cursors and locks in a `finally` block. Cancellation is cooperative: it guarantees no further chunks, not that the in-flight one is suppressed. A cancelled stream ends with `{ kind: 'end', final: true, _meta: { cancelled: true } }`. On SSE, cancelling is disconnecting.
- **Back-pressure.** The engine awaits delivery of each chunk, so a slow consumer pauses the producer. The SSE route paces data frames to the consumer's demand. Servers must not accumulate unbounded buffers.

A stream and a query for the same params go through the same pipeline and produce the same rows; only delivery differs.

### 5.6 Natural-language query

Provided by the `@mnmal-ai/substrate-nl` plugin. NL is **parser first, judge second**: a model never writes the query.

`POST /substrate/v1/nl { namespace, question, project?, type? }` reads the question against a per-namespace **pack** — types, fields, enum values and rulings, built from the live schema under the caller's row policy. A deterministic parser resolves what it can; an optional, constrained LLM judge (Ollama) chooses only among options the parser enumerated. The result is `{ outcome, trail }` as JSON, or the same as SSE when the request sends `accept: text/event-stream`.

**Outcomes** (`outcome.kind`): `rows` (the frame ran; engine `errors` ride along and are never reported as "0 rows"), `recall` (semantic fallback), `clarify` (a question back to the caller) or `refuse`. NL is read-only: a mutation-shaped question is refused, never executed. **SSE events** arrive in order: `parsed`, optionally `judging` / `judged`, then the outcome kind, then `done`. A slow or unavailable judge hands off within `judge.timeoutMs`, labelled, so the stream never hangs.

`GET /substrate/v1/nl/pack/<ns>` serves the pack with an `etag` (`304` on a matching `if-none-match`). Packs are cached per caller grant, so a restricted caller never sees another principal's values. Both routes require `read`. Engine failures reach the client as a fixed `{ error: 'NL query failed', code: 'nl_engine_error' }`; the real error is logged server-side.

**Config** (`<SUBSTRATE_PLUGIN_DIR>/substrate-nl.config.json`): `{ judge?: { baseUrl, model, timeoutMs }, rulings?, packTtlMs }`. No `judge` means parser-only. There is no env surface, and an unknown config key fails at boot.

### 5.7 MCP tool surface

`substrate mcp` runs a stdio MCP server that talks HTTP to `SUBSTRATE_URL` (default `http://localhost:3100`). Tools are thin wrappers over the HTTP routes; the server does the work.

| Tool | Purpose |
|---|---|
| `schema` | Fetch the schema (optionally scoped to a namespace / type). Call first. |
| `query` | Run a query frame. |
| `mutate` | Run a mutate frame, including autoCRUD `delete<T>` / `purge<T>` and batched arrays. |
| `ask` | Natural-language question; proxies `POST /substrate/v1/nl` (needs the NL plugin). |
| `recall` | Semantic recall over embedded records (needs the recall plugin). Takes `namespace` explicitly. |
| `whoami` | Who this session is authenticated as: `{ authEnabled, identity }`. |
| `propose_type`, `propose_field` | Runtime schema proposals (needs the proposals plugin, §5.15). |
| `drop_namespace`, `drop_type` | Admin-gated data drops (§5.12); require a confirmation phrase and an explicit `cascade`. |

`SUBSTRATE_MCP_TOOLS` (comma-separated) narrows the registered set. Every tool definition rides along on every model call, so an agent that only queries should not carry all ten. An unknown name refuses to start and lists the valid ones.

Payloads use qualified frame keys, so there is no separate namespace argument and one call can span namespaces:

```jsonc
{ "payload": {
    "prices/Price":     { "params": { "limit": 20 }, "fields": { "id": true, "value": true } },
    "products/Product": { "params": { "limit": 20 }, "fields": { "id": true, "name": true } } } }
```

Subscribe and stream are not exposed: stdio cannot host long-lived pushes.

**Check identity before trusting a credential.** On a deployment that admits anonymous reads, an authenticated read and an anonymous one return identical results, so a successful query is not evidence of identity. `whoami` answers directly: `authEnabled: false` means the deployment verifies nothing; `authEnabled: true` with `identity: null` means the session's own credential never arrived. The MCP server signs with `SUBSTRATE_AGENT_KEY_ID` + `SUBSTRATE_AGENT_KEY_PATH`.

**Check `errors` before reading `data`.** The envelope is partial-success: a rejected frame's key is **absent** from `data` and its reason is in `errors`, while sibling frames succeed and the status is still `200`. `data[key] ?? []` turns a rejection into "nothing found". Assert that every key you asked for came back.

### 5.8 Bridges (federation)

A Substrate instance can federate remote instances. Each bridge maps a local namespace alias to a remote instance:

- The remote's schema is fetched and merged into the local federated schema under the alias.
- Queries and mutations addressed to the alias are proxied to the remote, in parallel with local work.
- Reachability is tracked by a periodic health probe (`GET /substrate/v1/federated-schema`, every 10 s by default).
- Bridged schemas are fetched at boot and refreshed via `engine.refreshBridgeSchemas()`.

The binary configures bridges with `SUBSTRATE_BRIDGES` (a JSON array of `{ ns, name, url }`) and `SUBSTRATE_BRIDGE_CREDENTIALS` (a JSON object mapping bridge name to `{ keyPath, kid, origin }`). The credentials map is an allowlist: a bridge with no credential is refused at boot, and a credential only applies when the bridge URL's origin matches its `origin`. One bridge, one credential; callers never juggle tokens. `substrate federate` (enroll / join / check) walks the setup.

```bash
SUBSTRATE_BRIDGES='[{"ns":"cal","name":"calendar","url":"https://calendar.example.com"}]'
```

```jsonc
// one request: a remote calendar event and a local plan row
{ "cal/createEvent":  { "params": { /* … */ }, "fields": { "id": true } },
  "plans/createPlan": { "params": { /* … */ }, "fields": { "id": true } } }
```

**Behaviour:**

- **Reads never fail.** An unreachable bridge yields `{ __orphan: true, reason: 'bridge_unreachable' }` for its keys, and `_completeness[key] = { complete: false, unreachable: [...] }` marks the result set partial (§7.0), while local keys succeed in the same envelope.
- **Mutations against an unreachable bridge** fail per key with `bridge_unreachable`, without rolling back local writes. Transactions are per instance; cross-bridge mutation is best-effort.
- **Array-valued (batched) entries are not forwarded** (`bridge_array_not_supported`).
- **Cascades across an unreachable bridge are blocked**, not silently retried (§6.5).
- **Bridge only to peers you trust.** The token a bridge presents names no audience, so a peer that receives it could present it to any other server that accepts the same key. Give each bridge its own key, granted only what that peer needs.

**Dynamic topology.** The `@mnmal-ai/substrate-sentinel` plugin hosts a topology registry; the binary's built-in sentinel client (not a plugin) runs when `SUBSTRATE_SENTINEL_URL` is set. It watches the sentinel's WS topology stream and registers or unregisters bridges as peers come and go, refreshing bridged schemas. Discovery is not authoritative: a peer still needs an entry in `SUBSTRATE_BRIDGE_CREDENTIALS`.

**Wiring rule for embedders:** pass the live `BridgeRegistry` to `compose` whenever anything will mutate it. Passing the no-bridges stub while a client mutates a separate registry leaves the engine bound to the stub, and bridged queries fail schema lookup.

### 5.9 Client

`@mnmal-ai/substrate/client` is the framework-agnostic TypeScript client:

```ts
import { SubstrateClient } from '@mnmal-ai/substrate/client';

const client = new SubstrateClient({ endpoint: 'http://localhost:3100', token });

const env = await client.query({
  'products/Product': { params: { limit: 20 }, fields: { id: true, name: true } }
});

for await (const rows of client.watch<Product>({
  'products/Product': { params: { where: { name: { startsWith: 'W' } } }, fields: { name: true } }
})) {
  render(rows);                 // the maintained row set after each change
}
```

- `query` / `mutate` return the envelope (§7.0), decoded from JSON or substrate-pack (`wire: 'pack'`). Both accept an `AbortSignal`.
- `subscribe` / `stream` return async iterables of raw events; breaking the loop cancels. `watch` folds a single-key subscription into a live `T[]`.
- The client fetches the federated schema, checks `schemaVersion` on every response, and refetches once on mismatch before throwing `SchemaDriftError` (§7.1).
- WS reconnects with backoff and can resubscribe automatically after `subscription_overloaded`.
- `client.nl` and `client.admin` wrap the NL and admin routes.

There are no framework bindings (React hooks or similar) in this repository.

### 5.10 Recall (semantic memory)

The built-in `substrate-recall` kernel plugin (§5.11) gives agents semantic retrieval over their own records. A type opts in by declaring `embed` metadata (a `source(row)` that produces the text to embed); the plugin attaches a post-write hook that embeds each create/update into a pgvector table.

It contributes:

- `POST /substrate/v1/recall` and the `recall` MCP tool — top-K records by similarity in one namespace and one `type`, with an optional `where`. `type` is required; `namespace` falls back to the server's `SUBSTRATE_NAMESPACE` and is refused as `missing_namespace` when neither is set.
- A `recall/*` virtual namespace, so recall is also reachable as an ordinary query frame. (Its search text is `query` on the route and tool, and `to` on the frame, inside `params`.)
- An `embeddingSimilar` filter operator.
- `GET /substrate/v1/embed-stats` (which types are embedded, from configuration) and an admin-gated `POST /substrate/v1/embed/reindex` for backfill.

The embedder is configured in `<SUBSTRATE_PLUGIN_DIR>/substrate-recall.config.json` (`off` by default; `fake`, `ollama` or `onnx`), not by env. With no embedder, the operator, tool and routes that need it are omitted.

### 5.11 Plugins

Plugins are the deployment unit. There are two tiers:

- **Kernel plugins** augment the engine itself: schema migrations, filter operators, top-level routes under `/substrate/v1/`, MCP tools, a virtual namespace of resolver-backed types (no dataset, no autoCRUD), and post-write hooks for other plugins' types. They compose first, and their `onKernelReady` hook fires before any coordinator composes. `substrate-recall` and `substrate-nl` are kernel plugins.
- **Coordinator plugins** contribute application namespaces. `substrate-proposals` and `substrate-sentinel` are coordinators.

```ts
interface CoordinatorPlugin {
  name: string;
  namespaces: NamespaceDefinition[];        // types, resolvers, policies
  contractVersion: string;                  // semver range over the binary version
  policies?: Policy[];                      // plugin-global policies
  onStart?(ctx: PluginLifecycleContext): void | Promise<void>;
  onStop?(ctx: PluginLifecycleContext): void | Promise<void>;
  schedule?: ScheduledTask[];               // ticked on unref'd intervals
  routes?(router: PluginRouter, ctx: PluginRouteContext): void | Promise<void>;
  onboardInstructions?: Record<string, unknown>;   // §5.14
}
```

**Loading.** The binary loads plugins from `SUBSTRATE_PLUGIN_DIR`: it scans `<dir>/node_modules/{*,@*/*}/package.json`, for the packages `<dir>/package.json` lists under `dependencies`, for those with a `substrate` manifest block (`{ tier, entry, … }`, or `{ plugins: [...] }` for several), and merges each package's defaults with an operator override at `<dir>/<basename>.config.json`. Kernel plugins load before coordinators. A malformed manifest fails boot with the package named. `@mnmal-ai/substrate` declares two plugins this way, recall (kernel) and proposals (coordinator), so they load whenever the binary is installed in the plugin directory. `substrate init` scaffolds such a directory.

**`contractVersion`** is a semver range over the binary version (e.g. `>=4.1.0 <6.0.0`). A plugin whose range excludes the running binary is refused at boot. The ceiling should track actual compatibility: widen it only when you know the last major did not break the plugin interface.

**Invariants:**

- **One binary, many plugins.**
- **Plugin boundary ≠ namespace boundary.** A plugin can contribute one namespace or many; they share its lifecycle hooks and plugin-global policies.
- **Collisions fail fast.** Two plugins defining the same namespace is a boot error (`PluginNamespaceCollision`).
- **A new application is a new plugin**, not a new server.

**Plugin-global policies** apply to every resolver in every namespace the plugin contributes. The loader folds them with `and(...)` and passes the result as `NamespaceInstallContext.pluginPolicy`; `defineNamespace` composes it with the namespace and per-type layers (§4.4). A custom `install()` should compose `ctx.pluginPolicy` itself — the contract is conventional, not enforced.

**`onStop`** hooks run in reverse registration order inside the shutdown grace window, while the engine and database are still live. One plugin's failing teardown does not stop the others.

See [`plugin-author-guide.md`](plugin-author-guide.md) and [`plugin-tier-decision.md`](plugin-tier-decision.md).

### 5.12 The `substrate` binary

One binary, configured by env, hosting plugins. Subcommands: `serve`, `mcp`, `init`, `ask`, `federate`, `check-enums`, `normalise-vocab`, `backfill-field`. `substrate --help` prints the full env reference.

```bash
npm install --prefix /srv/substrate @mnmal-ai/substrate@next
SUBSTRATE_DATABASE_URL=postgres://… SUBSTRATE_PLUGIN_DIR=/srv/substrate /srv/substrate/node_modules/.bin/substrate serve
```

**Load-bearing configuration:**

| Var | Purpose |
|---|---|
| `SUBSTRATE_DATABASE_URL` | `postgres://…`, or `memory` (the default when unset, announced with a loud boot banner; writes do not survive a restart) |
| `SUBSTRATE_PLUGIN_DIR` | Plugin install root (§5.11). Without it only `_system` and `/health` exist |
| `SUBSTRATE_AUTH_MODE` | `required` (default once auth is on) or `attribute` (anonymous reads admitted, anonymous writes refused). Setting this or `SUBSTRATE_AUTH_KEY_REGISTRY` enables auth |
| `SUBSTRATE_AUTH_KEY_REGISTRY` | Path to a JSON file of JWT verification keys. Optional with a postgres store, which holds `Key` rows. **Breaking:** a token signed by any RS256/ES256 key, from this file or a `Key` row, must carry both `exp` and `ns`; a missing `ns` is refused (`malformed_claim:ns`), never read as `*`, so a third-party issuer must emit it. Only HS256 tokens against a file-registry secret keep both optional |
| `SUBSTRATE_ADMIN_CAPABILITY` | Capability that confers admin (default `admin`) |
| `SUBSTRATE_STREAM_TICKET_SECRET` | HMAC key for SSE stream tickets; required when auth is on |
| `SUBSTRATE_JWT_LEEWAY_SECONDS` | Clock-skew tolerance on `exp` / `nbf` |
| `SUBSTRATE_JWT_MAX_TTL_SECONDS` | Longest a token may still have to run; a later `exp` is refused (default 7200, `0` disables) |
| `SUBSTRATE_PUBLIC_ORIGIN` | The origins callers reach this server by, comma-separated (e.g. `https://host:3100,https://alias`); list every URL operators point the admin CLI or MCP at, since those mint `aud` from it. A token carrying `aud` (a string or an array) must name one of them or is refused with `wrong_audience`, and a token with no `aud` is refused with `missing_audience`. **Required when auth is on and `HOST` is not loopback**: the server refuses to boot without it, since otherwise a token minted for any other origin would replay here. On a loopback `HOST` it defaults to `http(s)://127.0.0.1:<port>`, `localhost` and `[::1]` (https when TLS is on) |
| `SUBSTRATE_BRIDGES`, `SUBSTRATE_BRIDGE_CREDENTIALS` | Static bridges and their credentials (§5.8) |
| `SUBSTRATE_SENTINEL_URL` | Enable dynamic bridge discovery (§5.8) |
| `SUBSTRATE_TLS_KEY_PATH`, `SUBSTRATE_TLS_CERT_PATH`, `SUBSTRATE_TLS_CA_PATH` | TLS (key and cert together; CA optional) |
| `SUBSTRATE_SWEEP_INTERVAL_MS` | Edge sweep cadence (default 5 min) |
| `SUBSTRATE_TOMBSTONE_RETENTION_DAYS` | Days before tombstoned rows and edges are hard-deleted (default 30) |
| `SUBSTRATE_IDEMPOTENCY_DISABLED`, `SUBSTRATE_IDEMPOTENCY_TTL_MS` | Disable mutate dedup; override its 24 h window |
| `SUBSTRATE_PAGE_LIMIT_DEFAULT`, `SUBSTRATE_PAGE_LIMIT_MAX` | Page size for a remote query that names no `limit` (default 100); the largest `limit` accepted (default 1000) (§5.2) |
| `SUBSTRATE_SNAPSHOT_LIMIT` | Most rows a subscription's first snapshot may return, counting only rows the subscriber may see; more is refused with `snapshot_too_large` (default `SUBSTRATE_PAGE_LIMIT_MAX`) (§5.2) |
| `SUBSTRATE_HARD_DELETE` | `refuse` disables hard-destructive operations |
| `SUBSTRATE_CORS_ORIGINS`, `SUBSTRATE_TRUSTED_PROXIES`, `SUBSTRATE_BODY_LIMIT_BYTES` | Browser origins, proxy IPs trusted for client IP, request size cap. The client IP also keys the cap of 64 open WS sockets plus SSE streams per anonymous or auth-off client (authenticated clients are capped per identity), so behind a proxy missing from `SUBSTRATE_TRUSTED_PROXIES` every such client shares one bucket. The same holds for anonymous callers behind one NAT: they share one address, so they share its caps (IPv6 clients are keyed by /64) |
| `SUBSTRATE_SHUTDOWN_GRACE_MS` | Graceful drain deadline (default 5 s) |
| `PORT`, `HOST` | Listen address (default `0.0.0.0:3100`, or `127.0.0.1:3100` when auth is off) |
| `SUBSTRATE_ALLOW_UNAUTHENTICATED_HOST` | `1` / `true` permits a non-loopback `HOST` with auth off; without it that combination fails boot, because every caller would act as the system actor. In a container the server binds a non-loopback interface even when the port is published only on the host's `127.0.0.1`, so that setup needs the opt-in too |

Natural-language query and the recall embedder are configured by their plugins' config files, not by env (§5.6, §5.10). A malformed value fails boot with the variable named.

**Multi-tenancy is operational.** The type system has no tenancy concept. Run separate instances with separate stores, or separate namespaces with grants. Fewer shared-state failure modes.

**Routes.** Core routes live under `/substrate/v1/`: `query`, `mutate`, `schema` (`/schema/<ns>`, `/schema/<ns>/<Type>`), `federated-schema`, `onboard`, `whoami`, `ws`, `stream`, `subscribe`, `stream/ticket`, `metrics`, `errors`, `config`, plus `_system/*` admin routes and plugin routes under `/substrate/v1/plugins/<name>/`. `/health` is at the root. When auth is on, schema, onboarding and query need `read`; `mutate` needs `mutate`; `_system` management, `errors` and `config` need `admin`. `/health`, `/substrate/v1/whoami` and `/substrate/v1/_system/register` need no credential.

**The `_system` namespace** is always mounted. It holds admin-gated `Key` (a verification key; its `id` is the JWT `kid`), `Invite`, and `AuditEvent`.

- **Keys.** Supported algorithms are `EdDSA`, `RS256` and `ES256` for stored keys (`HS256` is accepted only in the file registry; writing it to the dataset fails with `hmac_not_allowed`, so symmetric secrets never land in storage). A token verified against a stored key cannot claim more namespaces or capabilities than its row grants. Grants are per namespace (`{ plane: ['read'], notes: ['read','mutate'] }`, `'*'` allowed).
- **Invites and registration.** `POST /substrate/v1/_system/invites` (admin) mints a one-shot code (default TTL 24 h, max 30 days). `POST /substrate/v1/_system/register` (no credential; rate-limited to 10 requests per minute per IP) consumes it atomically via `conditionalUpdate`, checks the public key against its algorithm, and inserts the `Key` in the same transaction. `POST /substrate/v1/_system/keys` (admin) registers a key directly, optionally writing an agent-directory row in the same transaction.
- **Audit trail.** `AuditEvent { id, ts, actorKid, kind, targetKid?, clientIp?, details }` records every admin and auth operation. `kind` is a convention-typed string (canonical values include `bootstrap`, `key_created`, `key_revoked`, `key_rotated`, `key_registered`, `key_authority_updated`, `invite_created`, `invite_consumed`, `namespace_dropped`, `type_dropped`, `vocab_normalised`, `field_backfilled`, `destructive_op_refused`). `details` is a `field.json()` value. Audit writes land in the same transaction as the operation they record, so a failed audit write rolls the operation back. The exception is `destructive_op_refused`: the refusal rolls its transaction back, so its row is written after it settles (§5.3). There is no built-in retention.

**Admin drops.** `POST /substrate/v1/_system/drop-namespace` and `POST /substrate/v1/_system/drop-type` physically delete every row and short id in a namespace, or in one type. Both are admin-gated. The body is `{ namespace, [type,] confirm, dryRun?, cascade?: 'refuse' | 'delete' }`; `confirm` must equal `namespace` (or `"<namespace>/<type>"`). `cascade` defaults to `refuse`, which answers `409 dangling_edges` (with `edgeCount` and `sampleEdges`) if edges touch the target; `delete` hard-deletes those edges too. `dryRun: true` reports the counts without changing anything. Other responses: `400` (bad body or confirm mismatch), `403 forbidden_namespace` (`_system` cannot be dropped), `404 unknown_namespace`. Drops are data-only: a type still declared in code or by an applied proposal is back on the next boot.

**`substrate-admin`** is the operator CLI for keys: `bootstrap [--encrypt]` (seed the first admin key; refuses if one exists or if the store is memory), `list`, `register <kid> --pubkey <path> --ns <csv>`, `update <kid>`, `revoke <kid>` (refuses to revoke the last admin key), `rotate <kid> --out <path>` (new key and revocation in one transaction, one `key_rotated` audit event), `doctor` (checks a running deployment's auth end to end) and `onboard` (walks a deployment to ready). Commands that change credentials go through a running server (`--url` / `SUBSTRATE_URL`) or directly to the database (`--direct`); if both are configured and neither is named, the command refuses rather than guess. `--encrypt` writes a PKCS#8 + PBES2 (aes-256-cbc) encrypted private key, with the passphrase from `SUBSTRATE_ADMIN_KEY_PASSPHRASE`; the server never reads private keys.

### 5.13 Async and cancellation semantics

Every async operation follows the same contract.

**Resolution timing:**

| Operation | Resolves when |
|---|---|
| `query` | Envelope received and decoded. Rejects if the transport fails mid-response. |
| `mutate`, single frames | Transaction committed and same-store edges propagated. Cross-store and cross-bridge edges converge via the sweep. |
| `mutate`, array-valued entry | All frames under that key committed in one transaction (below). |
| `subscribe` | Iterates snapshot, then pushes, until cancelled or ended. |
| `stream` | Iterates chunks until the server ends the stream or the caller breaks. |

**Cancellation.** One-shot calls take an `AbortSignal`; iterables cancel when the consumer breaks out of the loop. Cancellation is cooperative: one in-flight chunk may still arrive, and the client discards post-cancel frames.

**Errors.** Engine and policy failures arrive as envelope `errors` entries with a `code`, `message` and `path` (for example `policy_denied`, `unauthorized_namespace`, `unknown_field`, `restrict_violation`). Policy denials always surface; they are never silent. On WS and SSE they arrive as `error` frames. The client throws `AuthError`, `NetworkError`, `SchemaDriftError` and `SubscribeError` for transport-level failures. An unexpected error (a driver failure, a bug) reaches the caller only as `internal error`, and its detail goes to the server's `engine_internal_error` metric, so connection strings and relation names never leave the server. A policy that throws denies with `policy error` (§4.4).

**Idempotency.** Queries are naturally idempotent. A mutation is safe to retry only with an idempotency key: a frame entry carrying `idempotencyKey` is deduplicated within a window (default 24 h). All entries in a frame that carry a key must carry the same one (`idempotency_key_conflict` otherwise). Without a key, a retry may write twice. Only an envelope with no errors is cached, and the cache is scoped to the caller's identity. Two concurrent calls with the same key join one run within a process; across processes sharing a store, both may run. Expired keys are reaped on the sweep interval.

**Batched mutate (array-valued entries).** A `mutate` entry may carry an array of frames instead of one. The engine runs them in order inside one transaction scoped to that key.

```jsonc
{ "notes/createNote": [
    { "params": { "title": "a" }, "fields": { "id": true } },
    { "params": { "title": "b" }, "fields": { "id": true } } ] }
```

- **Within-key atomicity.** If frame *i* throws, every frame under that key rolls back, the remaining frames do not run, and the error carries `code: 'batched_frame_rolled_back'`.
- **No cross-key atomicity.** Each array-valued key commits independently of every other key, including the single-frame entries in the same call, which share their own transaction (§5.3). A single frame beside a failing array still commits.
- **Envelope shape.** `data[key]` is an array with one element per frame; `shapes[key]` is `Array<'single' | 'list'>`; per-frame errors have `path = [key, String(index), …]`.
- **Per-frame idempotency.** Each element may carry its own `idempotencyKey`, keyed on `(key, index, idempotencyKey)`.
- **Mutate only.** Arrays on query, subscribe or stream fail with `batched_not_supported`; an empty array fails with `empty_frame_array`.
- **Do not put the array inside `params`.** That spreads the array into one row and writes garbage.

### 5.14 Agent onboarding

`GET /substrate/v1/onboard` is the cold-start document. An agent with no schema fetches it first and receives enough structured instruction to use every other route. With auth on, it requires `read` like the schema routes. `/substrate/v1/whoami` answers every caller, credential or not, so an agent can always find out where it stands.

**Body:**

- `substrate: 'agent-onboard'` — fixed marker.
- `version` — binary version.
- `binary` — topology: loaded plugins and their namespaces, registered bridges, whether auth is enabled.
- `frameGrammar` — the qualified-key contract and batched-mutate semantics.
- `instructions` — per-operation guidance (`query`, `mutate`, `schema`, `federatedSchema`, `subscribe`, `stream`), `auth` when auth is enabled (registration routes and the `Authorization: Bearer <jwt>` contract), and per-plugin contributions.

**Per-plugin contributions.** A plugin's `onboardInstructions` is copied verbatim into `instructions.plugins.<name>`, and its conventional `/substrate/v1/plugins/<name>/onboard` route is listed in `instructions.pluginRoutes`. Plugins without one are omitted — absence means the plugin has nothing agent-facing to teach.

**Static per boot.** The body is a pure function of composition inputs; runtime schema changes do not alter it. Agents should re-fetch it after a server restart.

**Obligations it states.** The onboarding document tells non-MCP agents to surface the envelope's `_diagnostics` (§7.0) rather than drop it.

### 5.15 Dynamic type proposal (substrate-proposals)

The built-in `substrate-proposals` coordinator plugin lets authorised callers add types and fields at runtime. A proposed type is queryable and mutatable through autoCRUD immediately — no restart, no deploy, and no agent-supplied code. Agents extend the schema through a narrow, data-only surface.

```
agent → "<ns>/propose_type" → TypeProposal row → Registry.register + autoCRUD
                                     ↓
                         ordinary Substrate data → replayed on every boot
```

**Mutations per owned namespace:**

- `<ns>/propose_type` — `{ typeName, fields, proposedReason }`. Registers the type and records a `<ns>/TypeProposal` row.
- `<ns>/propose_field` — `{ targetType, fieldName, fieldSpec, proposedReason }`. Adds a field to an existing type (declared in code or proposed). Idempotent on an exact match; refuses `destructive_change_required` if the field exists with a different spec.

There is no separate edge proposal: a cross-namespace edge is a `propose_field` whose spec has `kind: 'crossRef'`. Both namespaces must be owned by the plugin.

**Runtime namespaces.** A reserved control-plane namespace, `_system_proposals`, carries `propose_namespace`, which hot-adds a new namespace (with its own propose mutations) to the running engine. The host must already have provisioned a dataset for it (`dataset_not_provisioned` otherwise).

**`FieldSpecJson`** is the wire format: a narrow JSON mirror of `FieldDef` covering only what autoCRUD can serve — `scalar` (string / number / boolean / date), `crossRef`, `struct`, `list`. Anything richer (custom validators, computed fields, custom resolvers) is unrepresentable by construction and must ship as code. One parser is the single enforcement point.

**Proposals are ordinary data.** `TypeProposal` and `FieldProposal` live in each owned namespace beside the types they describe:

1. No parallel proposal namespace and no sidecar tables.
2. Provenance is a standard query: `<ns>/TypeProposal where applied = true`, with `proposedBy` (the signed caller, never taken from params) and `proposedReason` on the row.
3. **Restart survival.** On start the plugin replays every applied proposal, rebuilding the registry from storage.

**Capability gate.** Every propose mutation requires the `substrate.propose` capability (configurable via `proposeCapability`). This is the auditable line between agents that can extend the schema and agents that can only read and write data.

**Collisions are first-past-the-post.** Concurrent proposals of the same name, or a proposal that collides with a code-declared type, return `type_already_proposed` / `type_already_exists`. If code is later deployed declaring a name an applied proposal already owns, the proposal is marked `supersededByCode` and skipped; incompatible collisions refuse startup.

**Multi-instance.** The plugin takes a `PubSub` (`listen` / `notify`); wired to pg LISTEN/NOTIFY, peers apply each other's proposals live. The bootstrap the binary loads uses a no-op PubSub, so out of the box each instance picks up peers' proposals on its next boot.

Proposed types get the reserved `shortId` field like code-declared types, so they are at full autoCRUD parity.

**Out of scope by design:**

- Destructive evolution (removing or narrowing fields or types). Refused with `destructive_change_required`, carrying both specs.
- Per-type policies for proposed types; they inherit the plugin's default.
- Un-proposing. Archive the `TypeProposal` row to hide it from audit queries; the type stays live until code replaces it or an operator purges it.

Config (`<SUBSTRATE_PLUGIN_DIR>/substrate-proposals.config.json`): `{ ownedNamespaces, proposeCapability }`. The plugin's onboard contribution carries the full `FieldSpecJson` grammar, the error codes and examples. Error codes: `type_already_proposed`, `type_already_exists`, `destructive_change_required`, `unknown_type`, `unowned_namespace`, `invalid_field_spec`, plus the engine's `policy_denied` when the capability is missing.

---

## 6. Cross-Store Integrity (Delete and Edge Semantics)

Referential integrity across namespaces cannot be enforced by a database: the namespaces may live in different stores or on different servers. So it is **declared on the field and enforced by the engine**.

### 6.1 Edge policy is declared on the field

```ts
priceId: field.crossRef('prices', 'Price', { onDelete: 'set_null' })
// onDelete: 'set_null' | 'cascade' | 'restrict' | 'orphan'; default 'set_null'
```

- `set_null` — target deleted → the field becomes null. **Default.** Never fails a mutation, never silently deletes.
- `cascade` — target deleted → this row is deleted too, transitively.
- `restrict` — deleting the target is refused while any live incoming edge with this policy exists (§6.2, Phase 0).
- `orphan` — target deleted → the field keeps the dangling id; reads surface `{ __orphan: true, id }`.

The policy is snapshotted onto the edge when it is written (§4.6).

### 6.2 Delete is two-phase

**Phase 0 — mutation-time gate.** The delete handler calls `edges.canDelete(target)`. A live `restrict` edge → `restrict_violation`, nothing written. `restrict` is the only policy that blocks at mutation time.

**Phase 1 — tombstone** the target row (`dataset.tombstone`), atomic within its namespace.

**Phase 2 — propagate.** Two entry points share one `applyPolicy(edge, cascadeQueue)`:

- **Local path** (same instance, same store): inside the delete's transaction, read `edges.findEdgesTo(target)` and apply each live edge's policy, draining cascade fan-out before the mutation returns.
- **Sweep path** (other stores, bridges, recovery after a crash): §6.3, same `applyPolicy`.

Both paths MUST use the same `applyPolicy`, and the sweep is idempotent against work the local path already did.

| Policy | Edge after `applyPolicy` | Why |
|---|---|---|
| `set_null` | tombstoned | done; later sweeps skip it |
| `cascade` (unblocked) | tombstoned | done; fan-out queued for the driver |
| `cascade` (bridge unreachable) | `blocked = true`, stays live | retried next cycle |
| `restrict` | `lastSweptAt` stamped, stays live | the constraint is still violated; tombstoning would hide it from operators |
| `orphan` | `lastSweptAt` stamped, stays live | reads must keep surfacing `__orphan` |

**Phase 0 runs once, at the caller's delete — not for cascades.** A cascade is the engine executing a policy the schema author already agreed to. If it reaches a downstream `restrict` edge, that surfaces through the `restrict_violation` metric, not a late rejection: stopping a cascade halfway would leave data worse off than finishing it and alerting an operator.

**Concurrency.** Stores are expected to serialise writes to the same rows during Phase 0–2 with their usual transaction discipline; `MemoryDataset` is single-threaded. No extra locking protocol is mandated.

**Atomicity across the two stores.** The engine nests the edges transaction inside the dataset transaction, so a throwing resolver rolls both back. With pg, the two transactions use separate pooled connections, so a connection lost between the inner commit and the outer commit can leave a brief ordering gap. Because `applyPolicy` is idempotent and the sweep re-evaluates every edge, the gap is bounded to one sweep interval. Sharing one connection for both is an open item (§10).

### 6.3 The sweep is the authoritative reconciler

The sweep is how cross-store edges converge, not a janitor for corrupt state. It walks the edges table, checks each target, and applies the declared policy.

**Target resolution** reduces each edge's target to one of three states:

- `EXISTS` — row present, not tombstoned.
- `DELETED` — row present with `_deletedAt` set.
- `MISSING` — no row and no tombstone (purged, namespace gone, or bridge read failed). An unknown namespace is `MISSING`. A non-bridged `MISSING` is treated as deleted; a bridged `MISSING` is retried next cycle.

**Algorithm (one cycle):**

```
batch = edges.readNextBatch(cursor, batchSize)
worklist = batch.edges; processed = {}
while worklist not empty:
  edge = worklist.shift()
  if edge.id in processed or edge.deletedAt: continue
  processed.add(edge.id)
  case resolveTarget(edge.to):
    EXISTS:  edges.update({ id, lastSweptAt: now })
    DELETED: applyPolicy(edge, cascadeQueue)
    MISSING:
      if edge.to.bridged and bridgeUnreachable(edge.to.ns):
        metric('bridge_unreachable'); continue     # leave the edge untouched
      applyPolicy(edge, cascadeQueue)              # treat as deleted
  append cascadeQueue to worklist, skipping ids already seen
cursor = batch non-empty ? batch.lastId : null     # null wraps to the head
metric('swept', processed.size)
```

**Policy application:**

```
set_null: dataset.updateField(edge.from, edge.fieldName, null); edges.tombstone(edge.id)
cascade:  if edge.to.bridged and bridgeUnreachable(edge.to.ns):
            edges.update({ id, blocked: true }); metric('cascade_blocked_bridge')
          else:
            dataset.tombstone(edge.from); edges.tombstone(edge.id)
            enqueue every live edge pointing at edge.from
restrict: edges.update({ id, lastSweptAt: now }); metric('restrict_violation', {...})
orphan:   edges.update({ id, lastSweptAt: now })
```

**Details that matter:**

- **Cascade fan-out is drained within the cycle**, deduplicated by edge id, so diamonds in the cascade graph are processed once and the `swept` count stays truthful.
- **The cursor advances by the base batch only.** Cascade edges may have ids anywhere in the table; advancing by the base batch guarantees progress, and idempotency makes revisits safe.
- **Cursor state is caller-owned.** Restarting from `null` is always valid.
- **Wraparound.** An empty batch resets the cursor, so the next cycle re-validates `EXISTS` edges from the head and catches drift (a target tombstoned by a missed local path, a bridge back online). Set the interval high enough that a full pass is affordable for your edge count.
- **Unreachable bridges appear twice, on purpose.** On `MISSING`, the target cannot be read at all: the sweep bails and leaves the edge untouched — stamping `lastSweptAt` would claim an observation that did not happen. In `applyPolicy('cascade')`, the target is known deleted but the bridge is down, so the cascade cannot safely cross it: the edge is marked `blocked` and retried. The two conditions have different invariants and different blast radii.
- **Unknown `from` namespace.** If the edge's source namespace no longer exists, there is nowhere to write; the edge is tombstoned and `from_ns_unknown` is emitted. Blocking forever would accumulate zombie edges.
- **Blocked edges** are listed by `edges.findBlocked()` for manual resolution.

**Operational:**

- **Interval:** `SUBSTRATE_SWEEP_INTERVAL_MS`, default 5 minutes, on an `unref`'d timer cleared on shutdown.
- **Batch size:** default 100 edges per cycle, excluding cascade fan-out.
- **Retention:** tombstoned rows and edges older than `SUBSTRATE_TOMBSTONE_RETENTION_DAYS` (default 30) are hard-deleted on the same loop.
- **Observability:** `swept`, `policy_applied` (by policy), `bridge_unreachable`, `cascade_blocked_bridge`, `restrict_violation` (`{ edgeId, from, to, fieldName }`), `from_ns_unknown`.

### 6.4 Lost namespaces

When a namespace's dataset goes away (for example, a memory-backed namespace disposed or lost on restart), the dataset registry emits a namespace-lost event. The engine walks every edge pointing into that namespace and applies its policy, emitting `namespace_lost_applied` (or `namespace_lost_error`). Pretending restarts do not happen is not an option.

### 6.5 Bridge-targeted edges

Reads through an unreachable bridge surface `{ __orphan: true, reason: 'bridge_unreachable' }`. **Reads never fail.**

Cascades across an unreachable bridge are **blocked**, logged, and visible to admin tooling. **Deletes never proceed silently across a network.**

### 6.6 Invariants

- **Reads are non-fatal.** Null plus a flag, never a throw.
- **Deletes are loud when they cannot complete.** Blocked and logged, never deleted-eventually-and-silently.
- **Edge propagation is observable.** Sweep metrics, edge state and orphan markers are all inspectable.

---

## 7. Wire Format (substrate-pack)

substrate-pack is MessagePack with positional encoding. JSON is always available as the alternative; the semantics are identical. [surface-parity §7](surface-parity.md#7-substrate-pack-where-to-opt-in) lists which surfaces carry it and how a client opts in.

### 7.0 Envelope

Every response, on every transport:

```ts
interface PackEnvelope {
  schemaVersion: string;                       // 12-char SHA-256 prefix of the schema
  data: Record<string, unknown>;               // positional (pack) or named (JSON)
  shapes: Record<string, EnvelopeShape>;       // per top-level key (§7.2)
  _meta?: Record<string, unknown>;             // reserved extension channel (§7.3)
  _pagination?: Record<string, { nextCursor?: string; hasMore: boolean }>;
  _completeness?: Record<string, { complete: boolean; unreachable?: string[] }>;
  _diagnostics?: Record<string, { unknownProjectionFields?: string[] }>;
  errors?: Array<{ message: string; path?: string[]; code?: string; details?: Record<string, unknown> }>;
}

type EnvelopeShape = 'single' | 'list' | Array<'single' | 'list'>;
```

Query results are positionally encoded from the client's field selection and the type's fields. Mutation results are encoded from the mutation's declared `returns` (§4.2); mutations have no field selection.

**Non-fatal sidecars.** `_completeness` and `_diagnostics` report things that went wrong without the read failing. Both are keyed by frame key, and for both **absence means nothing to report**, so older clients stay correct. They are deliberately NOT `errors`: a client doing `if (env.errors) throw` would start failing successful reads.

- **`_completeness`** — a bridged key could not be fully resolved. Per-row `__orphan` markers say a *row* is missing; this says the *result set* is partial. Without it a truncated result looks like an empty one.
- **`_diagnostics.<key>.unknownProjectionFields`** — projected field names the type does not declare. The read still returns every row, with each unknown field `null` — indistinguishable from a real field that happens to be null. Unlike `where` (where an unknown name is rejected, because an unevaluable filter would widen the result), an unknown projection cannot corrupt the rows returned, so it is reported rather than rejected; a rolling deploy can legitimately project a field a not-yet-restarted server lacks. The names are listed so the reader need not diff the projection by hand. The server also counts these in `engine_unknown_projection_field`.

**Clients must surface `_diagnostics`.** A client that maps rows into typed objects turns the unknown field's `null` into a plausible value, every downstream null-check takes the "absent" branch, and nothing looks wrong. Log it, attach it to the result, or throw in development.

**Published schema** (`GET /substrate/v1/schema`, and what `schemaVersion` hashes):

```ts
interface Schema {
  schemaVersion: string;                          // over canonicalised { types, mutations }
  types:     Record<string, TypeSchema>;          // kind: 'type' entries
  mutations: Record<string, MutationSchema>;      // kind: 'mutation' entries
  virtual?:  true;                                // plugin-contributed virtual namespace
  annotations?: Readonly<Record<string, unknown>>; // per-consumer metadata; not hashed
}

interface TypeSchema     { fields: Record<string, FieldDef>; }
interface MutationSchema { params: Record<string, FieldDef>; returns: FieldDef; }
```

The schema routes also publish the metadata fields (`metadataFields`, `metadataAuthorFields`) that can be filtered and ordered on.

`schemaVersion` is deterministic: keys are sorted recursively before hashing, so identical registries in any registration order produce the same version, and adding a field or type changes it. The same string travels on every envelope, so drift detection is a string compare.

### 7.1 Schema drift is loud

Every envelope carries `schemaVersion`. The client compares it with the version it decoded against; on mismatch it refetches the federated schema **once**, and if the versions still differ it throws `SchemaDriftError`. It does not loop. Decoding positional data against the wrong schema would silently assign values to the wrong fields; a loud error is the alternative.

### 7.2 Shape is explicit

Every envelope declares each key's shape:

```ts
// list
{ schemaVersion: "a1b2c3d4e5f6", shapes: { "products/Product": 'list' },
  data: { "products/Product": [[1, 'Widget', [29.99, 'USD']], [2, 'Gadget', null]] } }

// single
{ schemaVersion: "a1b2c3d4e5f6", shapes: { "products/Product": 'single' },
  data: { "products/Product": [1, 'Widget', [29.99, 'USD']] } }
```

The decoder dispatches on `shapes[key]`, never on the tuple's form: inferring list-vs-single from data misreads a single entity whose first field is an array. A batched mutate key (§5.13) carries a third form, an array of per-frame shapes; a string means one frame, an array means a batch.

### 7.3 `_meta` is reserved

For metadata that should not require changing every decoder: warnings, deprecation flags, cancellation markers, policy hints. Clients MUST ignore `_meta` keys they do not understand.

### 7.4 Stream chunks

`@mnmal-ai/substrate/pack` defines a self-contained stream chunk with a round-trip codec (`encodeStreamChunk` / `decodeStreamChunk`):

```ts
interface PackStreamChunk {
  schemaVersion: string;
  streamId: string;
  sequence: number;              // monotonic per stream
  shape: 'single';
  data: unknown;
  final?: boolean;
  _meta?: Record<string, unknown>;
}
```

The WS `stream` operation uses the unified `WsResponseFrame` (`kind: 'chunk'`, §5.4) rather than this envelope; the chunk codec exists for transports and clients that decode chunks independently.

### 7.5 Why positional encoding

The point is **parse speed**, not bytes on the wire. msgpack is already fast with named objects; positional arrays skip key lookup entirely, which matters for multi-thousand-row responses. Shape and schema version travel on the envelope precisely so this optimisation can never silently corrupt data.

---

## 8. Rejected Designs

Patterns Substrate deliberately does not use, and why.

### 8.1 Sandboxed agent-authored code

Letting agents submit resolver code to run in a sandbox is the obvious way to make a schema agent-extensible. Substrate does not do it. Sandboxing arbitrary code is hard to get right, and the risk outweighs the value: autoCRUD plus data-only proposals (§5.15) cover the cases that motivate it. The only thing an agent can propose is something autoCRUD already knows how to serve, which makes runtime schema evolution safe by construction.

If custom logic is needed, write it as a plugin: register a resolver in `install()`. It runs in-process like the rest of the server. Plugin authors are trusted; agent-authored code is not. If a workflow needs review before a proposal goes live, build it at the application level (for example, an "awaiting review" namespace an admin promotes).

### 8.2 A separate data plane for ephemeral data

High-churn or short-lived data does not get its own storage system. Every tier is a `Dataset`, and §4.5's invariant (cross-dataset queries match single-dataset ones) forces any ephemeral tier to be query-equivalent rather than a parallel plane. Retention, where needed, is a policy a plugin implements, not a property of the backend.

### 8.3 Auth enums

A per-type enum like `requireAuth` / `denyAll` hits its ceiling immediately. Policies are composable functions attached to resolvers (§4.4) and express capability checks, namespace gates and row rules in one model.

### 8.4 A hidden namespace for edges

Storing cross-namespace edges as rows in a special namespace creates an asymmetry between "normal" namespaces and the hidden one, and turns the sweep into archaeology across namespaces. Edges are a first-class primitive in their own table (§4.6).

### 8.5 Multiple WebSocket frame families

Separate frame shapes for snapshots, updates and streams drift apart and make multiplexing fragile. There is one request frame and one response frame, keyed by a client-chosen id (§5.4).

### 8.6 A client bound to one namespace

A bound client needs proxies or sibling clients to reach a second namespace. Every call carries a qualified key instead (§4.7).

### 8.7 Silent best-effort catches

Swallowing failures in cross-reference resolution, on any transport, hides real faults. Caught errors are logged with structure or surfaced in the envelope.

### 8.8 Shape inference

Inferring list-vs-single from the data has a false positive (a single row whose first field is an array). The envelope declares shape explicitly (§7.2).

### 8.9 Raw framework access for plugins

Handing plugins the underlying HTTP framework instance couples every plugin that uses it to that framework. Everything such an escape hatch would be used for has a first-class home: WebSockets via `PluginRouter.websocket`, streaming via `SubstrateResponse.body: ReadableStream`, body parsing in the transport adapter. A plugin that needs more should get a new `SubstrateServer` capability, not a hole through it.

---

## 9. Testing Model

### 9.1 Memory by default

`MemoryDataset` backs unit and integration tests: fast, deterministic, no database. Postgres-backed suites run separately, gated on `POSTGRES_URL`, against a dedicated test database (the shared guards in `@mnmal-ai/substrate/testing` refuse non-test databases and superuser credentials).

### 9.2 Contract tests per layer

Each layer boundary has a suite that runs against every implementation:

- L0 dataset: read / write / delete / pagination / cursor, against memory *and* pg.
- L1 resolvers: autoCRUD and custom dispatch against a stub dataset.
- L2 engine: resolution, cross-references and policy evaluation.
- L3 transport: the same operations over HTTP, WS-JSON and WS-substrate-pack must produce identical results.
- L4 client: query, subscribe and error propagation against a stub transport.

### 9.3 Wire-format matrix

`packages/substrate-pack/test/wire-format-matrix.test.ts` pins golden bytes for every canonical envelope shape, JSON↔pack parity, the loud-drift contract (§7.1) and explicit shape dispatch (§7.2), including the single-row-with-array-first-field case.

### 9.4 Cross-server parity

`apps/substrate/test/cross-server-parity.test.ts` runs shared scenarios — query, mutate, edge-aware delete and sweep, WS subscribe, WS streaming — byte-identically against `MemorySubstrateServer` and `FastifySubstrateServer`. Protocol neutrality (§2.5) is enforced by tests, not by review.

### 9.5 Multi-instance federation

`apps/substrate/test/hive-integration.test.ts` runs three Fastify instances in one process on ephemeral ports and covers bridge routing, sentinel topology broadcasts on register and disconnect, and runtime bridge registration. It is gated behind `SUBSTRATE_HIVE_TEST=1`. Heartbeat-based eviction is covered by unit tests in `plugins/substrate-sentinel/test/liveness.test.ts`. Not yet covered: true multi-process tests (boot-path regressions, env leakage, a peer killed mid-stream).

---

## 10. Open Questions

Deliberately undecided:

- **Destructive schema evolution.** Additive evolution works (§5.15). Removing or narrowing fields and types is refused; how to do it safely on durable stores is open.
- **Predicates through edges.** Filtering on a referenced row's fields (§5.2).
- **Server-side row-policy injection.** Pushing expressible `row<T>` predicates into the dataset query instead of filtering after the read (§4.4).
- **Same-connection atomicity for rows and edges on pg** (§6.2).
- **Bridged batched mutations** (§5.8) and **schema-version signalling for bridges**, so a local instance learns of remote schema changes without an explicit refresh.
- **An observer API** for external systems that want mutation notifications without acting as a client.
- **Additional server runtimes** behind `SubstrateServer` (§4.8).

---

## 11. Reading Order

1. This document, §§1–3 (problem, invariants, layers).
2. [`getting-started.md`](getting-started.md) — run an instance and make a first query.
3. This document, §§4–6 (primitives, features, integrity).
4. The code: `packages/substrate-types/src` (contracts), `packages/substrate-sdk/src` (`defineNamespace`, `field`, autoCRUD), `packages/substrate-core/src` (engine, sweep), `packages/substrate-compose/src` (routes, auth, wiring), `packages/substrate-client/src` (client).
5. This document, §§7–10 (wire format, rejected designs, testing, open questions).
6. [`plugin-author-guide.md`](plugin-author-guide.md) before writing a plugin.

An agent connecting to a running instance does not need any of this: `GET /substrate/v1/onboard` (or the MCP `schema` tool) is designed to be enough.

If a change would break an invariant (§2), stop and write down why. If the reason survives scrutiny, propose a change to this document; if it does not, the change is the bug.
