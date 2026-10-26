/**
 * Policy primitive. Spec: §4.4.
 *
 * Combinator implementations live in @mnmal-ai/substrate-sdk. This file declares only
 * the type surface the engine consumes.
 */

import type { Row } from './core.js';
import type { Dataset, ReadResult } from './dataset.js';
import type { EdgesStore } from './edge.js';

export interface Identity {
  id: string;
  roles?: string[];
  scopes?: string[];
  /**
   * Per-namespace capabilities — the only grant surface. `{ notes: ['read'],
   * tasks: ['read','mutate'] }`; `'*'` is a legal key. Read it through the
   * `identity-grant.ts` helpers.
   *
   * A plain object rather than a Map: `Identity` is JSON-serialised into the
   * SSE stream ticket, and a Map would arrive as `{}` on the far side.
   *
   * A bare `{ id }` with no grant (direct-call tests, system actors) is the
   * no-claim case: `grantOf` resolves it to `null`, and the engine's grant
   * gate then admits every namespace. An authenticator for remote callers
   * must therefore always set `grants`, `{}` for none.
   */
  grants: Record<string, string[]>;
  [k: string]: unknown;
}

/**
 * Semantic verb stamped on autoCRUD-registered mutation entries.
 * Absent on type entries and custom mutations — policies needing those use
 * `RequestContext.entry` / `operation` instead.
 */
export type AutoCrudVerb = 'get' | 'create' | 'update' | 'delete';

export interface RequestContext {
  identity: Identity | null;
  namespace: string;
  operation: 'query' | 'mutate' | 'subscribe' | 'stream';
  now: Date;
  headers: Record<string, string>;
  meta: Record<string, unknown>;
  /**
   * Trust-gated client IP computed by the HTTP route handler from the request's
   * `peerIp` + the operator-configured trusted-proxy allowlist. When the peer
   * is in the allowlist, this is the leftmost `x-forwarded-for` entry; when
   * untrusted, this is the peer IP itself. Undefined when the transport doesn't
   * expose peerIp (direct engine unit tests, pre-upgrade WS paths).
   */
  clientIp?: string;
  /**
   * Whether the deployment verifies credentials at all, as the transport knows
   * it, so a refusal for want of an identity can say whether auth is off
   * rather than implying the caller's key is wrong.
   *
   * `undefined` means the transport did not say (direct engine unit tests,
   * routes with no auth config in scope). Treat it as unknown, never as `false`.
   */
  authEnabled?: boolean;
  /**
   * The registry entry name this dispatch targets — the `<name>` half of the
   * qualified frame key (e.g. `deleteTodo`, `Todo`). Threaded by the engine
   * at every dispatch site (query/mutate/stream/subscribe) so type- and
   * plugin-level policies can discriminate between resolvers that otherwise
   * present identically (`get<T>` and `delete<T>` both arrive as
   * operation:'mutate' with id-only params). Undefined only in direct-call
   * unit tests that construct a bare ctx.
   */
  entry?: string;
  /**
   * Semantic verb of the targeted entry when autoCRUD registered it.
   * Prefer this over `entry`-name matching for intent-level policies
   * ("deny deletes") — it survives entry renames. Absent for type entries
   * and custom mutations.
   */
  verb?: AutoCrudVerb;
}

/** The caller's request context for a policy check made outside dispatch. */
export type PolicyProbeContext = Partial<
  Pick<RequestContext, 'now' | 'headers' | 'meta' | 'clientIp' | 'authEnabled'>
>;

export interface ResolverArgs {
  params?: Record<string, unknown>;
  fields?: Record<string, unknown>;
  rows?: Row[];
  /**
   * Engine-injected per-call dataset handle. On `engine.mutate`, this is the
   * transaction-scoped `tx` view (spec §5.3, G1); on `engine.query` it's the
   * plain namespace dataset. Resolvers that perform I/O MUST use this handle
   * — using a dataset captured at registration time bypasses the active
   * transaction and breaks atomicity. Optional purely to keep direct-resolver
   * unit tests concise; the engine always supplies it.
   */
  dataset?: Dataset;
  /**
   * Engine-injected per-call edges store (§4.6). Resolvers that touch edges
   * MUST use this handle; the closed-over store from registration is a
   * fallback for direct-call tests. Unlike `dataset`, this is not namespace-
   * scoped — edges are inherently cross-namespace, and a single engine-scoped
   * `EdgesStore` is threaded through every call.
   */
  edges?: EdgesStore;
  /**
   * Engine-injected post-commit write hook (§5.4). Write-path resolvers
   * (autoCRUD create/update/delete, or custom mutation resolvers) call this
   * AFTER their substrate write lands to announce the change. The engine
   * collects calls into a per-transaction batch and fans them out to the
   * subscription bus only after the enclosing `withTransaction` commits — a
   * rolled-back tx emits nothing. Direct-call unit tests may pass `onWrite` to
   * observe resolver output without spinning up an engine.
   */
  onWrite?: (event: WriteEvent) => void;
  /**
   * Queue work to run once the surrounding transaction has settled, whether it
   * committed or rolled back: a record that must outlive a rollback, such as
   * an audit row for the refusal that caused it. The work is told which
   * (`committed`), so post-commit work can skip a rollback. Absent outside a
   * transaction, where the caller can simply do the work.
   */
  afterTx?: (fn: AfterTxWork) => void;
  /**
   * Engine-injected cancellation signal (§5.5). Supplied on `stream` dispatch
   * so generator resolvers can abort mid-iteration when the client cancels or
   * the socket closes. Streaming resolvers SHOULD observe this signal — either
   * by calling `signal.throwIfAborted()` at yield points, or by listening for
   * `abort` to release cursors / close descriptors in their `finally` block.
   * The engine cannot force-stop a generator; cooperation is the contract.
   * Absent on query/mutate dispatch — non-streaming resolvers should not see a
   * signal they have no way to honour.
   */
  signal?: AbortSignal;
  /**
   * Engine-injected cross-namespace dataset resolver (committed, non-tx view).
   * Write-path resolvers use it to verify crossRef referents that live in a
   * DIFFERENT namespace (onMissing:'reject'). Same-namespace targets should use
   * the tx-scoped `dataset` handle instead. Absent on the query/subscribe path.
   */
  resolveDataset?: (ns: string) => Dataset | undefined;
  /**
   * Engine-injected on mutate: how many frame entries share this call's
   * transaction, itself included. A resolver whose effect waits on other
   * transactions (a concurrent index drop) refuses to share one.
   */
  txEntries?: number;
}

/**
 * Post-commit write announcement consumed by the engine's subscription bus
 * (§5.4). Emitted by write-path resolvers after the substrate operation
 * commits inside the current transaction. `row` is the post-commit canonical
 * row for creates and updates; for deletes it's the pre-tombstone snapshot
 * (absent if the resolver couldn't read the row before deleting). The engine
 * filters matching subscriptions by `(ns, type)`, tests the `row` against each
 * subscription's `where` predicate, and emits `add` / `update` / `remove`.
 */
export interface WriteEvent {
  ns: string;
  type: string;
  id: Row['id'];
  operation: 'create' | 'update' | 'delete';
  row?: Row;
}

export interface Obligation {
  kind: string;
  [k: string]: unknown;
}

/**
 * Row-filter obligation: emitted by `row<T>(predicate)` policies. The engine
 * scans accumulated obligations after resolver execution and applies each
 * predicate as a silent filter.
 */
export interface RowFilterObligation<T = unknown> extends Obligation {
  kind: 'row-filter';
  predicate: (ctx: RequestContext, row: T) => boolean;
}

export interface PolicyDecision {
  allow: boolean;
  reason?: string;
  obligations?: Obligation[];
}

export type Policy = (ctx: RequestContext, args: ResolverArgs) => PolicyDecision;

/**
 * Engine-facing resolver shape. Spec: §4.3, §5.2, §5.5.
 *
 * The engine treats any resolver's return as opaque rows. A `ReadResult` return
 * signals a paged list; the engine unpacks `rows` into the envelope and copies
 * `nextCursor`/`hasMore` into `_pagination[key]`. An `AsyncIterable<Row>`
 * return is the §5.5 stream-dispatch shape (duck-typed via
 * `Symbol.asyncIterator` so it can't collide with `Row[]`).
 *
 * This is what the registry stores and what the engine dispatches to. Plugin
 * authors declaring custom resolvers use the typed-authoring form
 * `TypedResolver<T>` below; the engine erases to `Resolver` at registration
 * time.
 */
export type Resolver = (
  ctx: RequestContext,
  args: ResolverArgs
) => Promise<Row | Row[] | ReadResult | AsyncIterable<Row> | null> | AsyncIterable<Row>;

/**
 * Typed-authoring resolver shape. Used by autoCRUD and hand-authored resolvers
 * that want to preserve the concrete return type before erasing to `Resolver`
 * at registration. `T` is unconstrained at the type level — the engine
 * discriminates on the runtime value shape regardless of static type.
 */
export type TypedResolver<T> = (ctx: RequestContext, args: ResolverArgs) => Promise<T>;

/**
 * Engine-visible return shape for a resolver. `ReadResult` means "paged list";
 * `Row[]` means "full list, no pagination"; `Row` means "single"; `null` means
 * "single, not found". The engine discriminates at runtime.
 */
export type ResolverReturn = Row | Row[] | ReadResult | null;

/** Work queued through `ResolverArgs.afterTx`, told whether the transaction committed. */
export type AfterTxWork = (outcome: { committed: boolean }) => Promise<void>;
