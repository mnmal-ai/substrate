/**
 * Engine internals — pure helpers, types, and constants used by the
 * engine and its subsystems. Nothing in here touches engine state.
 */

import { createHash } from 'node:crypto';
import {
  type AfterTxWork,
  type BridgeFrame,
  type BridgeRegistry,
  coversNamespace,
  type Dataset,
  type DatasetRegistry,
  type EdgesStore,
  type FieldDef,
  type FieldInput,
  type FrameEntry,
  grantedIn,
  grantOf,
  type IdempotencyStore,
  isResolverFrameError,
  type NamespaceConfig,
  normaliseMetadataOrderBy,
  normaliseMetadataWhere,
  type OrderByClause,
  type PackEnvelope,
  type ParsedKey,
  parseQualifiedKey,
  type QualifiedFrame,
  type ReadResult,
  type RequestContext,
  type ResolveObservation,
  type ResolverArgs,
  type Row,
  type RowFilterObligation,
  type WhereClause,
  type WriteEvent,
  type WsResponseFrame
} from '@mnmal-ai/substrate-types';
import type { ShapeRecorder } from '../advisor/shape-recorder.js';

// Re-exported from substrate-types for this package's internal import sites.
export type { NamespaceConfig };
export { type ParsedKey, parseQualifiedKey };

/** Duck-type guard: is this a ReadResult rather than a bare Row[]? */
export function isReadResult(v: unknown): v is ReadResult {
  return (
    v !== null &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    'rows' in v &&
    Array.isArray((v as { rows: unknown }).rows) &&
    'hasMore' in v
  );
}

/**
 * Duck-type guard for async iterables (§5.5). Plain arrays expose
 * `Symbol.iterator` but NOT `Symbol.asyncIterator`, so this cleanly separates
 * stream-shaped returns from the `Row[]` list shape without touching the
 * existing one-shot discriminators.
 */
export function isAsyncIterable<T>(v: unknown): v is AsyncIterable<T> {
  return (
    v !== null &&
    typeof v === 'object' &&
    Symbol.asyncIterator in (v as Record<PropertyKey, unknown>)
  );
}

export type MetricFn = (name: string, payload?: unknown) => void;

/**
 * Deliver a frame the engine does not await. A rejection is counted on
 * `metric` and handed to `onReject`, so a failing transport never becomes an
 * unhandled rejection. A synchronous throw still reaches the caller.
 */
export function deliverFrame(
  onFrame: (frame: WsResponseFrame) => void | Promise<void>,
  frame: WsResponseFrame,
  metric: MetricFn,
  onReject?: () => void
): void {
  Promise.resolve(onFrame(frame)).catch((err: unknown) => {
    metric('engine_frame_delivery_rejected', {
      id: frame.id,
      kind: frame.kind,
      error: err instanceof Error ? err.message : String(err)
    });
    onReject?.();
  });
}

/**
 * Client-facing text for a thrown error. A `ResolverFrameError` is written for
 * callers; anything else (a driver error naming a relation or a connection
 * string) goes to the metric only.
 */
export function clientErrorMessage(err: unknown, metric: MetricFn, key: string): string {
  if (isResolverFrameError(err)) return err.message;
  metric('engine_internal_error', { key, error: err instanceof Error ? err.message : String(err) });
  return 'internal error';
}

export interface EngineOptions {
  namespaces: Map<string, NamespaceConfig>;
  datasets: DatasetRegistry;
  /**
   * Engine-scoped edges store (§4.6). Threaded into every resolver as
   * `args.edges`. Required — every engine has one, even if the only consumer
   * is autoCRUD's edge-aware delete. Edges are inherently cross-namespace
   * (`EdgeRef.ns`), so the store is singular at engine scope, not per-ns.
   */
  edges: EdgesStore;
  metric?: MetricFn;
  /**
   * One observation per key resolved locally: duration and outcome. Called once
   * per query key, once per single-frame mutate key and once per element of a
   * batched array (under its op key). Deliberately NOT observed: bridged keys,
   * the `aborted` / `batched_not_supported` pre-dispatch returns in `query()`,
   * and empty arrays, since keys that never reach a resolver are not resolver
   * latency. Elements of a batched array that succeeded before a
   * `BatchedFrameRefusal` rollback stay observed as `ok`; the rollback itself is
   * visible as the `batched_frame_rolled_back` error. Errors thrown by the hook,
   * and rejections of a returned thenable, are swallowed. When absent, the engine
   * does no timing at all.
   */
  onResolve?: (o: ResolveObservation) => void;
  /**
   * Observes each successful local read of a type: its shape (filtered fields
   * and operators, the effective order including the natural one) and how long
   * the resolver took. For the index advisor; absent means no recording.
   */
  shapeRecorder?: Pick<ShapeRecorder, 'observe'>;
  /**
   * Idempotency dedup (§5.13). Absent → no dedup; `FrameEntry.idempotencyKey`
   * is ignored on mutate (queries ignore it unconditionally). Present → the
   * engine consults `store.get` before dispatch and `store.put` after a
   * successful mutate frame. `defaultTtlMs` defaults to 24h per spec.
   */
  idempotency?: {
    store: IdempotencyStore;
    defaultTtlMs?: number;
  };
  /**
   * Subscription back-pressure (§5.13). Per-subscription pending-frame
   * threshold; when exceeded the engine emits a final `subscription_overloaded`
   * error frame, an `end` frame, and drops the entry from the bus. Default 256.
   */
  subscriptions?: {
    queueLimit?: number;
    /**
     * Most rows a type subscription's snapshot may hold. A snapshot with more
     * is refused with `snapshot_too_large`. Unset reads the snapshot unbounded.
     */
    snapshotLimit?: number;
  };
  /**
   * Sweep-adjacent hooks used by the §6.4 lifecycle subscription, which
   * builds `applyLostNamespace`'s `SweepDeps` from them. `bridges` defaults to
   * a no-op registry (every namespace local and reachable); a non-local
   * namespace present in it is proxied through the bridge (§5.8).
   */
  sweepHooks?: {
    bridges?: BridgeRegistry;
  };
}

/**
 * No-op `BridgeRegistry` — used when no bridges are wired. Every namespace
 * routes locally and is reachable.
 */
export const NO_BRIDGES: BridgeRegistry = {
  has: (): boolean => false,
  get: (): undefined => undefined,
  isUnreachable: (): boolean => false,
  entries: (): Array<[string, never]> => []
};

/**
 * Default back-pressure threshold per spec §5.13. Exceeding this pending-frame
 * count on a single subscription triggers a server-side tear-down.
 */
export const DEFAULT_SUBSCRIPTION_QUEUE_LIMIT = 256;

/**
 * Default idempotency dedup window (24h) per spec §5.13.
 */
export const DEFAULT_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * `__brand` is a phantom literal — purely a type-level marker, no runtime
 * presence (constructors don't set it). Distinguishes `SubscriptionHandle`
 * from the structurally-identical `StreamHandle` so a stream handle returned
 * by `engine.stream(...)` isn't silently accepted where a subscription handle
 * is expected (and vice versa). The literal types `'SubscriptionHandle'`
 * vs `'StreamHandle'` are incompatible even when both fields are optional,
 * so TS rejects cross-assignment at every call seam.
 */
/**
 * Reason for a subscription teardown. Threaded through `SubscriptionHandle.cancel()`
 * so the engine can emit a per-reason metric (`engine_subscription_closed_<reason>`)
 * without the call site knowing which metric string to use.
 *
 *  - `'cancel'`      — explicit client-driven cancel (op: 'cancel') or direct handle use
 *  - `'socket_close'` — underlying WS socket closed (conn.onClose)
 *  - `'shutdown'`     — server-initiated graceful shutdown (conn.onShutdown)
 */
export type SubscriptionCancelReason = 'cancel' | 'socket_close' | 'shutdown';

export interface SubscriptionHandle {
  readonly __brand?: 'SubscriptionHandle';
  readonly id: string;
  cancel(reason?: SubscriptionCancelReason): void;
}

export interface SubscribeInput {
  /**
   * Phantom brand, never set at runtime. Without it this is structurally
   * interchangeable with `StreamInput`, so subscribe/stream inputs could be
   * swapped with no type error.
   */
  readonly __brand?: 'SubscribeInput';
  id: string;
  frame: QualifiedFrame;
  ctx: Partial<RequestContext>;
  /**
   * Frame sink. Sync-returning callbacks are still valid; the engine awaits
   * whatever `onFrame` returns so back-pressure-aware transports (e.g. WS
   * send-buffer drain) can resolve asynchronously. The fanout loop tracks
   * pending (unsettled) calls per subscription and tears the entry down when
   * the count exceeds `EngineOptions.subscriptions.queueLimit` (§5.13).
   */
  onFrame: (frame: WsResponseFrame) => void | Promise<void>;
}

/**
 * Phantom `__brand` literal — same intent as `SubscriptionHandle.__brand`.
 */
export interface StreamHandle {
  readonly __brand?: 'StreamHandle';
  readonly id: string;
  cancel(): void;
}

/**
 * §5.5 stream dispatch input. One qualified key per call — multi-key streams
 * conflate emission orderings, so the engine rejects them with
 * `stream_multi_key`.
 *
 * `onFrame` is async so the transport layer can await send-buffer drains
 * between chunks. The engine awaits it between every chunk emission, which is
 * how back-pressure lives at the route layer without leaking transport
 * details into the engine.
 *
 * `signal` is an optional external abort source (socket close, shutdown).
 * Internally the engine always creates its own `AbortController` so
 * `handle.cancel()` works; the external signal is folded in as a second
 * trigger.
 */
export interface StreamInput {
  /** Phantom brand, never set at runtime. See `SubscribeInput.__brand`. */
  readonly __brand?: 'StreamInput';
  id: string;
  frame: QualifiedFrame;
  ctx: Partial<RequestContext>;
  onFrame: (frame: WsResponseFrame) => void | Promise<void>;
  signal?: AbortSignal;
}

/**
 * One live subscription entry keyed by `(ns, type)`. A multi-key subscribe
 * request produces one entry per qualified key; they share the same client-
 * supplied `id` and all tear down together when `SubscriptionHandle.cancel`
 * runs.
 *
 * `currentRowIds` tracks which ids matched the where clause at snapshot time;
 * the fanout path consults it to decide whether a post-commit row that still
 * matches is an `add` (id not previously seen) vs an `update` (id already
 * known).
 */
export interface SubscriptionEntryStat {
  readonly id: string;
  readonly ns: string;
  readonly type: string;
  readonly queueLength: number;
}

export interface SubscriptionStatsSnapshot {
  /** Total registered entries (same basis as activeSubscriptionCount). */
  readonly count: number;
  /** Largest per-entry queue length at snapshot time; 0 when idle/empty. */
  readonly maxQueueDepth: number;
  readonly entries: readonly SubscriptionEntryStat[];
}

export interface SubscriptionEntry {
  readonly id: string;
  /**
   * Shared by every entry of one `subscribe()` call. `id` is client-chosen and
   * collides across callers, so teardown groups siblings by this instead.
   */
  readonly group: object;
  readonly ns: string;
  readonly type: string;
  readonly fields: FieldInput;
  readonly where: WhereClause | undefined;
  readonly orderBy: OrderByClause[] | undefined;
  readonly onFrame: (frame: WsResponseFrame) => void | Promise<void>;
  /**
   * Policy obligations captured at subscribe time — specifically
   * `row-filter` obligations. Applied to snapshot rows AND to every live push
   * so subscriptions honour the same row-level visibility rules as queries.
   */
  readonly obligations: RowFilterObligation[];
  readonly ctx: RequestContext;
  readonly schemaVersion: string;
  readonly currentRowIds: Set<Row['id']>;
  /**
   * §5.13 per-entry frame queue. The fanout enqueues; a long-running drain
   * task (spawned lazily) serialises `onFrame` calls. `queue.length` is the
   * back-pressure metric — when enqueue sees it already at the engine's
   * queueLimit, the entry is torn down. The drain task exits when the queue
   * is empty, and is re-spawned by the next enqueue.
   */
  readonly queue: WsResponseFrame[];
  draining: boolean;
  /** Marks the entry as torn down so the fanout skips it in-flight. */
  closed: boolean;
  /**
   * False until the initial snapshot has been emitted. The
   * entry is registered on the bus BEFORE the snapshot resolver runs (so no
   * write committed during the resolver is lost to the gap between resolver and
   * registration). While false, the fanout buffers raw events into
   * `pendingEvents` instead of delivering them; once the snapshot is emitted the
   * buffer is replayed so pushes never precede the snapshot.
   */
  snapshotReady: boolean;
  readonly pendingEvents: WriteEvent[];
}

/**
 * Per-frame authorisation gate (§5.12): checks that `identity`'s grant covers
 * `ns` AND allows `operation` there (`mutate` needs `mutate`; everything else
 * needs `read`). Returns which dimension failed.
 *
 * An absent identity, or one with no grant (a bare `{ id }`), passes: those
 * are direct-call tests and system actors. So an authenticator must give every
 * remote caller a `grants` object (`{}` for none), or that caller reaches
 * every namespace on transports that rely on this gate.
 */
export function checkIdentityGrant(
  identity: RequestContext['identity'] | null | undefined,
  ns: string,
  operation: 'query' | 'mutate' | 'subscribe' | 'stream'
): { ok: true } | { ok: false; reason: 'namespace' | 'capability'; required?: string } {
  if (identity === null || identity === undefined) return { ok: true };

  // `null` is the no-claim population and PASSES; fabricating an empty grant
  // instead would refuse every direct-call test and system actor.
  const resolved = grantOf(identity);
  if (resolved === null) return { ok: true };

  // An explicit entry beats the wildcard — the resolution `grantedIn` shares
  // with the grant module, so the two cannot disagree about what a grant means.
  if (!coversNamespace(resolved, ns)) return { ok: false, reason: 'namespace' };

  // `mutate` is the only writing operation; subscribe and stream are reads, the
  // same mapping the route layer applies by method.
  const required = operation === 'mutate' ? 'mutate' : 'read';
  return grantedIn(resolved, ns).includes(required)
    ? { ok: true }
    : { ok: false, reason: 'capability', required };
}

export function toResolverArgs(
  entry: FrameEntry,
  dataset: Dataset | undefined,
  edges: EdgesStore,
  onWrite?: (event: WriteEvent) => void,
  signal?: AbortSignal,
  resolveDataset?: (ns: string) => Dataset | undefined,
  afterTx?: (fn: AfterTxWork) => void,
  txEntries?: number
): ResolverArgs {
  // Virtual namespaces own no dataset — omit the key (NOT
  // `dataset: undefined`, which exactOptionalPropertyTypes rejects).
  const args: ResolverArgs = { edges };
  if (dataset !== undefined) args.dataset = dataset;
  if (entry.params !== undefined) args.params = entry.params;
  if (entry.fields !== undefined) args.fields = entry.fields;
  if (onWrite !== undefined) args.onWrite = onWrite;
  if (signal !== undefined) args.signal = signal;
  if (resolveDataset !== undefined) args.resolveDataset = resolveDataset;
  if (afterTx !== undefined) args.afterTx = afterTx;
  if (txEntries !== undefined) args.txEntries = txEntries;
  return args;
}

/**
 * The frame with its `where` / `orderBy` metadata spellings rewritten onto the
 * canonical columns (`createdBy` -> `createdById`, …). Returns the same frame
 * when it carries neither.
 */
export function withCanonicalMetadataFilters(
  entry: FrameEntry,
  fields: Record<string, FieldDef>
): FrameEntry {
  const params = entry.params;
  if (params === undefined || (params.where === undefined && params.orderBy === undefined)) {
    return entry;
  }
  return {
    ...entry,
    params: {
      ...params,
      ...(params.where !== undefined
        ? { where: normaliseMetadataWhere(params.where, fields) }
        : {}),
      ...(params.orderBy !== undefined
        ? { orderBy: normaliseMetadataOrderBy(params.orderBy, fields) }
        : {})
    }
  };
}

export function addError(
  envelope: PackEnvelope,
  path: string[],
  message: string,
  code?: string,
  details?: Record<string, unknown>
): void {
  const list = envelope.errors ?? [];
  const err: {
    message: string;
    path?: string[];
    code?: string;
    details?: Record<string, unknown>;
  } = { message, path };
  if (code !== undefined) err.code = code;
  if (details !== undefined) err.details = details;
  list.push(err);
  envelope.errors = list;
}

export function addTopLevelError(envelope: PackEnvelope, message: string, code: string): void {
  const list = envelope.errors ?? [];
  list.push({ message, code });
  envelope.errors = list;
}

/**
 * Stable per-caller component folded into the idempotency dedup key. A cache
 * hit short-circuits dispatch before gates and policy run, so two callers may
 * share a cached envelope ONLY when their authorization surface is identical.
 *
 * Captures the authz-relevant identity fields, sorted for order-independence;
 * a `null` identity collapses to one bucket. Volatile JWT claims (exp/iat/jti)
 * are deliberately excluded so retries across token refresh still hit.
 */
export function callerDedupComponent(identity: RequestContext['identity'] | null): string {
  if (identity === null || identity === undefined) return '\u0000anon';
  const sortedOrEmpty = (xs: string[] | undefined): string[] =>
    Array.isArray(xs) ? [...xs].sort() : [];
  const sortedGrant = (g: unknown): Array<[string, string[]]> => {
    if (g === null || g === undefined || typeof g !== 'object') return [];
    return Object.entries(g as Record<string, unknown>)
      .map(([ns, caps]): [string, string[]] => [
        ns,
        Array.isArray(caps) ? [...(caps as string[])].sort() : []
      ])
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  };
  return JSON.stringify({
    id: identity.id,
    roles: sortedOrEmpty(identity.roles),
    scopes: sortedOrEmpty(identity.scopes),
    // Flat namespace lists are a lossy view of the grant, so they are left out.
    grantOnly: true,
    // The full per-namespace grant, not a flattened view: two identities can
    // flatten alike and still grant different capabilities per namespace.
    grants: sortedGrant(identity.grants)
  });
}

/**
 * Frame-scoped idempotency key. §5.13 design call: dedup is per-frame (one
 * frame = one tx = one dedup record), not per-key. The sorted-keys prefix
 * ensures two frames with different operation sets but the same user-supplied
 * key don't collide. `caller` (see {@link callerDedupComponent}) scopes the key
 * to the requester so a cache hit never crosses authorization boundaries.
 */
export function makeDedupKey(keys: string[], idempotencyKey: string, caller: string): string {
  const sorted = [...keys].sort();
  return JSON.stringify({ keys: sorted, idempotencyKey, caller });
}

/**
 * Per-frame dedup key for batched-array mutate (§5.13). The slot index is
 * included so two frames at different indices in the same array don't
 * collide even when their idempotencyKey values happen to match (as they
 * might under a naïve "retry the same batch" pattern). The op-key prefix
 * keeps arrays under different op-keys in different cache buckets, and `caller`
 * scopes the key to the requester.
 */
export function makeArrayDedupKey(
  key: string,
  index: number,
  idempotencyKey: string,
  caller: string
): string {
  return JSON.stringify({ batched: true, key, index, idempotencyKey, caller });
}

/**
 * In-flight join key for a mutate made only of array op-keys whose every slot
 * carries an idempotencyKey: the op-keys, each slot's key, and the caller.
 * Undefined when any op is not covered by a key, since two requests could then
 * share this key and differ in what they write.
 */
export function batchedInFlightKey(frame: QualifiedFrame, caller: string): string | undefined {
  const slots: Array<[string, string[]]> = [];
  for (const [key, entry] of Object.entries(frame)) {
    if (!Array.isArray(entry) || entry.length === 0) return undefined;
    const ids: string[] = [];
    for (const f of entry) {
      if (f.idempotencyKey === undefined) return undefined;
      ids.push(f.idempotencyKey);
    }
    slots.push([key, ids]);
  }
  if (slots.length === 0) return undefined;
  slots.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify({ batched: slots, caller });
}

/**
 * Narrow a `QualifiedFrame` bucket to a `BridgeFrame`. Bridges don't support
 * batched-array forwarding (§5.13); the mutate path filters array op-keys out
 * of bridge buckets before this runs, so any remaining entry is structurally
 * a single `FrameEntry`; the array skip only narrows the type.
 */
export function toBridgeFrame(bucket: QualifiedFrame): BridgeFrame {
  const out: BridgeFrame = {};
  for (const [key, entry] of Object.entries(bucket)) {
    if (Array.isArray(entry)) continue;
    out[key] = entry;
  }
  return out;
}

/**
 * Scope each forwarded `idempotencyKey` to the local caller. The peer sees
 * every forwarded write under the bridge's one credential, so a key passed
 * verbatim lets two callers who pick the same key share one cached reply
 * there. The same caller retrying still forwards the same key.
 */
export function scopeBridgeIdempotency(bucket: QualifiedFrame, caller: string): QualifiedFrame {
  const out: QualifiedFrame = {};
  for (const [key, entry] of Object.entries(bucket)) {
    out[key] =
      !Array.isArray(entry) && typeof entry.idempotencyKey === 'string'
        ? {
            ...entry,
            idempotencyKey: createHash('sha256')
              .update(JSON.stringify([caller, entry.idempotencyKey]))
              .digest('hex')
          }
        : entry;
  }
  return out;
}

/**
 * Snapshot obligation gate. Mirrors `applyRowFilters` from the SDK but on a
 * single row — we can't wrap every live push in an allocation when the vast
 * majority of rows pass the filter.
 */
export function obligationsPermitRow(
  obligations: RowFilterObligation[],
  ctx: RequestContext,
  row: Row
): boolean {
  for (const ob of obligations) {
    try {
      if (!ob.predicate(ctx, row)) return false;
    } catch {
      // Throwing predicates silently drop the row (spec §4.4), as in applyRowFilters.
      return false;
    }
  }
  return true;
}

export function normaliseToRows(result: Row | Row[] | ReadResult | null): Row[] {
  if (result === null) return [];
  if (Array.isArray(result)) return result;
  if (typeof result === 'object' && 'rows' in result && Array.isArray(result.rows)) {
    return result.rows;
  }
  return [result as Row];
}
