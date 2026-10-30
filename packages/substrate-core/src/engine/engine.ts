/**
 * Engine. Spec: §3 (L2 contract), §4.2, §4.3, §4.4, §4.5, §4.7, §5.3 (G1),
 * §7.0.
 *
 * Facade a transport (`SubstrateServer`) drives. Per-namespace `Registry` + a
 * shared `DatasetRegistry` (§4.5). Frame keys are qualified names (§4.7):
 * `<ns>/<name>` where `<name>` is the type entry or mutation name. The engine
 * parses the qualified prefix per-entry to look up the namespace's registry
 * and dataset — `ctx.namespace` is engine-owned, not a transport origin.
 *
 * Behaviour:
 *   - `query` iterates the frame, evaluates each type's policy, invokes the
 *     resolver on allow, applies row-filter obligations, accumulates into the
 *     envelope under the ORIGINAL qualified key. Policy denies + lookup
 *     failures surface as `envelope.errors` entries — the whole call does not
 *     throw for a partial deny.
 *   - `mutate` is the same shape, run inside a single `dataset.withTransaction`
 *     (§5.3 / G1): if any resolver throws, every prior mutation in the frame
 *     rolls back and the promise rejects with that resolver's error. A
 *     resolver refusing with a `ResolverFrameError` rolls the frame back too:
 *     its error is kept and every other entry reports `frame_rolled_back`.
 *     Policy denials surface in `envelope.errors` without aborting — policy is
 *     an authz decision, not a substrate failure, so it does not trigger
 *     rollback.
 *   - G1 cross-substrate refusal: if a mutate's single-frame entries span more
 *     than one substrate, the engine returns `cross_tx_scope_refused` and
 *     calls NO resolvers. Namespaces sharing a substrate share one tx.
 *   - Shape is derived from the resolver's return: `Row[]` → `'list'`, single
 *     `Row` → `'single'`.
 */

import { getExtensionOperator, listExtensionOperators } from '@mnmal-ai/substrate-filter';
import type {
  AfterTxWork,
  AutoCrudVerb,
  BridgeRegistry,
  Dataset,
  DatasetRegistry,
  DropParticipant,
  EdgesStore,
  EngineInput,
  FrameEntry,
  IdempotencyStore,
  Identity,
  PackEnvelope,
  PolicyDecision,
  PolicyProbeContext,
  QualifiedFrame,
  ReadResult,
  Registry as RegistryInterface,
  RequestContext,
  ResolveObservation,
  Row,
  Schema,
  SweepDeps,
  WriteEvent
} from '@mnmal-ai/substrate-types';
import {
  isResolverFrameError,
  isRestrictViolation,
  WALKS_DISABLED
} from '@mnmal-ai/substrate-types';
import { readShapeOf } from '../advisor/shape-recorder.js';
import { applyLostNamespace } from '../apply-lost-namespace.js';

/** Local query keys dispatched at once; the rest wait for a free slot. */
const QUERY_KEY_CONCURRENCY = 16;

/** `#runEntry`'s parameters after `(envelope, key)`. */
type RunEntryRest = [
  entry: FrameEntry,
  ctxBase: Omit<RequestContext, 'namespace'>,
  operation: 'query' | 'mutate',
  tx: Dataset | null,
  txEdges: EdgesStore | null,
  parsed: ParsedKey | null,
  onWrite?: (event: WriteEvent) => void,
  signal?: AbortSignal,
  afterTx?: (fn: AfterTxWork) => void,
  txEntries?: number
];

/** Unwinds the shared single-frame tx; the refusing entry's error is already on the envelope. */
class SharedTxRefusal extends Error {
  override readonly name = 'SharedTxRefusal';
}

/**
 * Unwinds a batched-array transaction for a frame that refused via the
 * envelope rather than by throwing.
 *
 * `#runEntry` records a `ResolverFrameError` on the envelope and returns
 * normally, which inside `#runArrayEntry`'s transaction would otherwise read as
 * success and commit the earlier frames. Carries the original errors so their
 * client-branchable codes survive the rollback.
 */
class BatchedFrameRefusal extends Error {
  override readonly name = 'BatchedFrameRefusal';
  constructor(readonly frameErrors: Array<{ message: string; path?: string[]; code?: string }>) {
    super(frameErrors[0]?.message ?? 'batched frame refused');
  }
}

/**
 * Refusal prose. A missing namespace and a namespace narrowed to the wrong
 * capability are different operator problems, so they get different messages.
 */
function grantRefusal(
  ns: string,
  verdict: { reason: 'namespace' | 'capability'; required?: string }
): string {
  return verdict.reason === 'capability'
    ? `identity's grant for namespace '${ns}' does not include '${verdict.required ?? 'the required capability'}'`
    : `namespace '${ns}' not in identity's allowed namespaces`;
}

/** Error code for a grant refusal: `unauthorized_capability` or `unauthorized_namespace`. */
function grantRefusalCode(verdict: { reason: 'namespace' | 'capability' }): string {
  return verdict.reason === 'capability' ? 'unauthorized_capability' : 'unauthorized_namespace';
}

import { evaluatePolicy } from '../policy-evaluator.js';
import { Registry } from '../registry.js';
import { walkGrammarPath } from '../walk-gate.js';
import { BridgeSubsystem } from './bridge.js';
import { isSealedCursor, openCursor } from './cursor-seal.js';
import { runFilterGuard } from './filter-guard.js';
import {
  addError,
  addTopLevelError,
  batchedInFlightKey,
  callerDedupComponent,
  checkIdentityGrant,
  DEFAULT_IDEMPOTENCY_TTL_MS,
  DEFAULT_SUBSCRIPTION_QUEUE_LIMIT,
  type EngineOptions,
  type MetricFn,
  makeArrayDedupKey,
  makeDedupKey,
  type NamespaceConfig,
  NO_BRIDGES,
  type ParsedKey,
  parseQualifiedKey,
  type StreamHandle,
  type StreamInput,
  type SubscribeInput,
  type SubscriptionHandle,
  type SubscriptionStatsSnapshot,
  scopeBridgeIdempotency,
  toResolverArgs,
  withCanonicalMetadataFilters,
  withNaturalOrder
} from './internals.js';
import {
  type LocalTxScopePartition,
  partitionMutateByRoute,
  partitionMutateByShape,
  partitionMutateByTxScope
} from './mutate.js';
import { shapeResult } from './result-shape.js';
import { SchemaSubsystem } from './schema.js';
import { StreamSubsystem } from './stream.js';
import { SubscribeSubsystem } from './subscribe.js';

/**
 * Public engine types, re-exported through this module. `EngineInput`,
 * `FrameEntry` and `QualifiedFrame` live in substrate-types so plugin surfaces can
 * reference the engine's call shape without depending on substrate-core.
 */
export type { EngineInput, FrameEntry, QualifiedFrame } from '@mnmal-ai/substrate-types';
export type {
  EngineOptions,
  MetricFn,
  NamespaceConfig,
  StreamHandle,
  StreamInput,
  SubscribeInput,
  SubscriptionCancelReason,
  SubscriptionEntryStat,
  SubscriptionHandle,
  SubscriptionStatsSnapshot
} from './internals.js';

export class Engine {
  // Grown by addNamespace(). Taken out of service by tombstoneNamespace()
  // (name held until restart) or removeNamespace() (name freed). Either way
  // in-flight ops that already resolved a NamespaceConfig keep running.
  #namespaces: Map<string, NamespaceConfig>;
  /**
   * Tombstoned namespaces. Checked at the top of query / mutate / subscribe
   * dispatch (returns `namespace_tombstoned` per-key error) and at the
   * top of `schemaFor` / `federatedSchema` (omitted from published schema).
   */
  readonly #tombstoned: Set<string> = new Set();
  readonly #tombstoneListeners = new Set<(ns: string) => void>();
  readonly #dropParticipants = new Set<DropParticipant>();
  readonly #datasets: DatasetRegistry;
  readonly #edges: EdgesStore;
  readonly #metric: MetricFn;
  readonly #onResolve: ((o: ResolveObservation) => void) | undefined;
  readonly #shapeRecorder: EngineOptions['shapeRecorder'];
  readonly #idempotency: { store: IdempotencyStore; defaultTtlMs: number } | undefined;
  /**
   * Mutates under a dedup key that are still running. The store only sees a
   * key once the first call finishes, so a retry arriving meanwhile joins this
   * promise instead of writing again. Per process: a store shared across
   * processes still admits concurrent duplicates.
   */
  readonly #inFlightMutates = new Map<string, Promise<PackEnvelope>>();
  readonly #bridges: BridgeRegistry;
  /**
   * Disposer returned by `DatasetRegistry.onNamespaceLost`. Present iff the
   * registry implements the optional lifecycle surface (§6.4); `dispose()`
   * calls it to detach on shutdown. Engines over a persistent registry hold
   * `undefined` here and `dispose()` is a no-op.
   */
  #lifecycleDisposer: (() => void) | undefined;
  /** Schema-federation subsystem; the engine's public schema methods delegate here. */
  readonly #schema: SchemaSubsystem;
  /**
   * Live subscription subsystem (§5.4, §5.13). Owns the subscription bus, the
   * back-pressure queue, and the WriteEvent fanout. The mutate path calls
   * `this.#subscribe.dispatchWrite(event)` after each write event; everything
   * else lives behind the subsystem's surface.
   */
  readonly #subscribe: SubscribeSubsystem;
  /** Stream subsystem (§5.5); the public `stream()` delegates here. */
  readonly #stream: StreamSubsystem;
  /** Bridge-proxy subsystem (§5.8 / §6.5) for bridged query/mutate buckets. */
  readonly #bridgeProxy: BridgeSubsystem;

  readonly #walksEnabled: boolean;

  constructor(opts: EngineOptions) {
    this.#namespaces = opts.namespaces;
    this.#datasets = opts.datasets;
    this.#edges = opts.edges;
    this.#metric = opts.metric ?? ((): void => {});
    this.#onResolve = opts.onResolve;
    this.#walksEnabled = opts.walksEnabled === true;
    this.#shapeRecorder = opts.shapeRecorder;
    this.#idempotency =
      opts.idempotency !== undefined
        ? {
            store: opts.idempotency.store,
            defaultTtlMs: opts.idempotency.defaultTtlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS
          }
        : undefined;
    this.#bridges = opts.sweepHooks?.bridges ?? NO_BRIDGES;
    this.#schema = new SchemaSubsystem({
      namespaces: this.#namespaces,
      bridges: this.#bridges,
      isLive: (ns: string): boolean => this.#isLive(ns),
      isTombstoned: (ns: string): boolean => this.#tombstoned.has(ns)
    });
    this.#bridgeProxy = new BridgeSubsystem({ bridges: this.#bridges, metric: this.#metric });
    this.#subscribe = new SubscribeSubsystem({
      namespaces: this.#namespaces,
      datasets: this.#datasets,
      edges: this.#edges,
      metric: this.#metric,
      subscriptionQueueLimit: opts.subscriptions?.queueLimit ?? DEFAULT_SUBSCRIPTION_QUEUE_LIMIT,
      ...(opts.subscriptions?.snapshotLimit !== undefined
        ? { snapshotLimit: opts.subscriptions.snapshotLimit }
        : {}),
      schemaFor: (ns: string): Schema => this.schemaFor(ns),
      isTombstoned: (ns: string): boolean => this.#tombstoned.has(ns)
    });
    this.#stream = new StreamSubsystem({
      namespaces: this.#namespaces,
      datasets: this.#datasets,
      edges: this.#edges,
      metric: this.#metric,
      schemaFor: (ns: string): Schema => this.schemaFor(ns),
      isTombstoned: (ns: string): boolean => this.#tombstoned.has(ns)
    });

    // §6.4 subscribe. Feature-detected: a registry without `onNamespaceLost`
    // (pg, for example) gives us nothing to wire and the disposer stays
    // undefined. The listener itself is sync; reconciliation runs on a
    // detached promise so the registry's dispose() call returns immediately.
    const maybeOn = this.#datasets.onNamespaceLost;
    if (typeof maybeOn === 'function') {
      this.#lifecycleDisposer = maybeOn.call(this.#datasets, (ns: string): void => {
        this.#onNamespaceLost(ns);
      });
    }
  }

  /**
   * §6.4 handler. Kick off `applyLostNamespace` on a detached promise so the
   * registry's `dispose()` call is not blocked by edge-table paging. Failures
   * are reported via `metric('namespace_lost_error', ...)` — nothing here can
   * be rethrown without corrupting the caller's shutdown flow.
   */
  #onNamespaceLost(ns: string): void {
    const deps: SweepDeps = {
      datasets: this.#datasets,
      bridges: this.#bridges,
      edges: this.#edges,
      now: (): Date => new Date(),
      metric: this.#metric
    };
    void applyLostNamespace(ns, deps).catch((err: unknown) => {
      // A throwing metric sink (user-supplied) must not escape this catch —
      // we're in a detached background task and an unhandled rejection would
      // fail the process. Swallow silently; the lost-ns work itself is
      // already past the point where it could be retried here.
      try {
        this.#metric('namespace_lost_error', {
          ns,
          error: err instanceof Error ? err.message : String(err)
        });
      } catch {
        // no-op
      }
    });
  }

  /**
   * Best-effort cleanup. Detaches the engine's §6.4 lifecycle subscription
   * from the registry so subsequent registry disposals don't trigger work
   * against this engine. Safe to call more than once.
   *
   * Callers are NOT required to invoke `dispose` — engines over a process-
   * lifetime registry can skip it entirely. Apps that hot-swap engines (tests,
   * SIGHUP reload) should call it to avoid leaked listeners.
   */
  dispose(): void {
    const disposer = this.#lifecycleDisposer;
    if (disposer === undefined) return;
    this.#lifecycleDisposer = undefined;
    disposer();
  }

  /**
   * Append a new namespace to the engine at runtime, without a restart.
   * Throws on collision or on a tombstoned name; idempotent re-add is the
   * caller's responsibility.
   *
   * Side effect: invalidates federated schema cache so subsequent reads
   * surface the new namespace's types.
   */
  addNamespace(ns: string, config: NamespaceConfig): void {
    if (this.#tombstoned.has(ns)) {
      throw new Error(`namespace '${ns}' is tombstoned — restart required to reclaim the name`);
    }
    if (this.#namespaces.has(ns)) {
      throw new Error(`namespace '${ns}' already registered on this engine`);
    }
    this.#namespaces.set(ns, config);
    this.invalidateSchemaCaches(ns);
    this.#metric('engine_namespace_added', { namespace: ns });
  }

  /**
   * Mark a namespace as tombstoned. Hides it from `schemaFor` / `federatedSchema`,
   * causes new query / mutate / subscribe ops to fail per-key with
   * `namespace_tombstoned`, and closes any existing live subscriptions on the
   * ns with a `namespace_tombstoned` error frame. Idempotent.
   *
   * The underlying NamespaceConfig stays in `#namespaces` for in-flight safety
   * — concurrent ops that already resolved a config reference run to
   * completion. Full physical reclaim happens at engine restart, gated by
   * whatever persistence layer the host uses to decide which namespaces to
   * re-install at boot.
   */
  tombstoneNamespace(ns: string): void {
    if (this.#tombstoned.has(ns)) return;
    this.#tombstoned.add(ns);
    this.invalidateSchemaCaches(ns);
    this.#subscribe.closeForNamespace(ns, 'namespace_tombstoned');
    this.#metric('engine_namespace_tombstoned', { namespace: ns });
    for (const listener of this.#tombstoneListeners) {
      try {
        listener(ns);
      } catch (err) {
        this.#metric('engine_namespace_tombstone_listener_failed', {
          namespace: ns,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }
  }

  /** See `EngineHandle.addDropParticipant`. */
  addDropParticipant(participant: DropParticipant): () => void {
    this.#dropParticipants.add(participant);
    return () => this.#dropParticipants.delete(participant);
  }

  dropParticipants(): readonly DropParticipant[] {
    return [...this.#dropParticipants];
  }

  /** See `EngineHandle.onNamespaceTombstoned`. */
  onNamespaceTombstoned(listener: (ns: string) => void): () => void {
    this.#tombstoneListeners.add(listener);
    return () => this.#tombstoneListeners.delete(listener);
  }

  /**
   * Take a namespace off the engine and free its name, so `addNamespace` can
   * take it again: live subscriptions on it close, its schema disappears, and
   * new ops answer `unknown_namespace`. Ops that already resolved its config
   * run to completion. Undoes a runtime add (a rolled-back propose_namespace);
   * a namespace a plugin installs at boot comes back on restart. Idempotent.
   */
  removeNamespace(ns: string): void {
    if (!this.#namespaces.has(ns)) return;
    this.#subscribe.closeForNamespace(ns, 'namespace_removed');
    this.#namespaces.delete(ns);
    this.#tombstoned.delete(ns);
    this.invalidateSchemaCaches(ns);
    this.#metric('engine_namespace_removed', { namespace: ns });
  }

  /** Whether `ns` is on the engine, and if so whether it is still served. */
  namespaceState(ns: string): 'absent' | 'live' | 'tombstoned' {
    if (!this.#namespaces.has(ns)) return 'absent';
    return this.#tombstoned.has(ns) ? 'tombstoned' : 'live';
  }

  /** True iff the namespace is registered AND not tombstoned. */
  #isLive(ns: string): boolean {
    return this.#namespaces.has(ns) && !this.#tombstoned.has(ns);
  }

  /**
   * Internal accessor for the per-namespace registry. Consumers (notably the
   * substrate binary's mutate route, which needs per-mutation `returns` metadata
   * for positional encoding) should treat this as a package-internal API —
   * application code goes through `query`/`mutate` or `schemaFor`.
   */
  registryFor(ns: string): RegistryInterface | undefined {
    return this.#namespaces.get(ns)?.registry;
  }

  /**
   * Factory for a fresh empty Registry instance, so plugins can provision
   * namespaces via addNamespace without a runtime import on this package.
   */
  createRegistry(): Registry {
    return new Registry();
  }

  /**
   * True iff `name` is a registered substrate-plugin filter operator (e.g.
   * `embeddingSimilar` from substrate-recall). Thin pass-through to the shared
   * `@mnmal-ai/substrate-filter` registry. In-process consumers branch on this
   * instead of catching "unknown operator" errors; HTTP consumers should
   * read the sorted name list from `binary.filterOperators` in
   * `/substrate/v1/onboard` (same registry, exposed at the transport edge).
   */
  hasFilterOperator(name: string): boolean {
    return getExtensionOperator(name) !== undefined;
  }

  /**
   * Sorted list of registered extension-operator names. Surfaced via
   * `/substrate/v1/onboard.binary.filterOperators` for HTTP consumers.
   */
  listFilterOperators(): ReadonlyArray<string> {
    return listExtensionOperators();
  }

  /**
   * Look up the host-registered dataset for `ns`, or `undefined` if the host
   * has not provisioned one. Pass-through to the engine's `DatasetRegistry`,
   * surfaced on `EngineHandle` for plugins handling runtime-added
   * namespaces.
   */
  datasetFor(ns: string): Dataset | undefined {
    return this.#datasets.get(ns);
  }

  schemaFor(ns: string): Schema {
    return this.#schema.schemaFor(ns);
  }

  federatedSchema(): Record<string, Schema> {
    return this.#schema.federatedSchema();
  }

  /**
   * Invalidate the cached federated-schema map and version, plus the per-ns
   * schema cache entry when `ns` is supplied. For external mutators that
   * change a namespace's registered types after construction.
   */
  invalidateSchemaCaches(ns?: string): void {
    this.#schema.invalidateSchemaCaches(ns);
  }

  /**
   * Evaluate the write policy for a type entry WITHOUT dispatching it, for
   * kernel routes that mutate outside frame dispatch. Same checks as
   * `evaluateReadPolicy`, with `operation: 'mutate'`. Use this, not the read
   * probe, for writes: a namespace may gate writes more strictly than reads.
   */
  evaluateWritePolicy(
    ns: string,
    type: string,
    identity: Identity | null,
    probe?: PolicyProbeContext
  ): PolicyDecision {
    // `verb: 'update'` is load-bearing: verb-based primitives read `ctx.verb`,
    // not `ctx.operation`, and `denyVerbs` ALLOWS when the verb is undefined,
    // so a verb-less write probe would pass a write gate built from it.
    // The read probe deliberately sets no verb: `allowVerbs` DENIES verb-less
    // entries, so adding one there would change read posture.
    return this.#evaluateEntryPolicy(ns, type, identity, 'mutate', probe, 'update');
  }

  /**
   * Evaluate the read policy for a type entry WITHOUT dispatching it, so
   * out-of-band read routes are gated by the same composed policy as
   * `engine.query`. Fails closed on a tombstoned or unknown namespace, an
   * unknown type, a non-type entry, or a refused identity grant. Pass the
   * caller's `probe` context so policies reading headers, `clientIp`, `meta`
   * or `authEnabled` decide as they would in dispatch.
   */
  evaluateReadPolicy(
    ns: string,
    type: string,
    identity: Identity | null,
    probe?: PolicyProbeContext
  ): PolicyDecision {
    return this.#evaluateEntryPolicy(ns, type, identity, 'query', probe);
  }

  /**
   * Shared body of the two out-of-band policy probes. Mirrors #runEntry's
   * pre-dispatch checks (tombstone, registry lookup, identity-namespace claim)
   * with a synthetic ctx. Fails closed throughout: an out-of-band surface must
   * never be MORE permissive than dispatch.
   */
  #evaluateEntryPolicy(
    ns: string,
    type: string,
    identity: Identity | null,
    operation: 'query' | 'mutate',
    probe: PolicyProbeContext | undefined,
    verb?: AutoCrudVerb
  ): PolicyDecision {
    if (this.#tombstoned.has(ns)) {
      return { allow: false, reason: `namespace '${ns}' was deleted` };
    }
    const nsCfg = this.#namespaces.get(ns);
    if (!nsCfg) {
      return { allow: false, reason: `unknown namespace '${ns}'` };
    }
    const entry = nsCfg.registry.get(type);
    if (entry?.kind !== 'type') {
      return { allow: false, reason: `unknown type '${type}' in namespace '${ns}'` };
    }
    const nsGate = checkIdentityGrant(identity, ns, operation);
    if (!nsGate.ok) {
      return { allow: false, reason: grantRefusal(ns, nsGate) };
    }
    const ctx: RequestContext = {
      now: probe?.now ?? new Date(),
      headers: probe?.headers ?? {},
      meta: probe?.meta ?? {},
      ...(probe?.clientIp !== undefined ? { clientIp: probe.clientIp } : {}),
      ...(probe?.authEnabled !== undefined ? { authEnabled: probe.authEnabled } : {}),
      identity,
      namespace: ns,
      operation,
      entry: type,
      ...(verb !== undefined ? { verb } : {})
    };
    return evaluatePolicy(entry.policy, ctx, {});
  }

  /**
   * Refresh the cached schemas for every registered bridge. Callers invoke
   * this at composition-root wire-up time to populate `federatedSchema()`'s
   * bridge merge; subsequent drift (schemaVersion change) triggers an auto-
   * refetch via the envelope decoder (§7.1), not this API.
   *
   * Unreachable bridges are skipped silently — reachability is owed to the
   * per-bridge probe, not this surface.
   */
  async refreshBridgeSchemas(): Promise<void> {
    return this.#schema.refreshBridgeSchemas();
  }

  federatedSchemaVersion(): string {
    return this.#schema.federatedSchemaVersion();
  }

  /**
   * Run a query frame. §5.13: callers control timeout by aborting `input.signal`
   * — the engine ships no server-side timer. Pre-aborted input short-circuits
   * with an `aborted` error per remaining entry; a signal that fires mid-flight
   * causes subsequent entries to be skipped with the same error code.
   *
   * Bridge routing (§5.8): keys whose namespace is not local but IS registered
   * with the bridge registry are proxied to the bridge in parallel with the
   * local path. Unreachable bridges surface `{ __orphan: true, reason:
   * 'bridge_unreachable' }` per-key (§6.5 "Reads never fail").
   */
  async query(input: EngineInput): Promise<PackEnvelope> {
    const keys = Object.keys(input.frame);
    // Pre-parse every key once; everything downstream reads from this map.
    const parsedByKey = this.#buildParsedKeyCache(keys);
    const envelope = this.#makeEnvelope(keys, parsedByKey);
    if (keys.length === 0) return envelope;

    const ctx = this.#buildContext(input.ctx, 'query');
    const signal = input.signal;

    // Partition keys into local vs per-bridge buckets.
    //
    // Array (batched) frame values are a mutate-only surface (§5.13). Reject
    // them on the query path with a dedicated error code so the transport
    // layer surfaces a clear message rather than an opaque shape error.
    const bridgeBuckets = new Map<string, QualifiedFrame>();
    const localEntries: Array<[string, FrameEntry]> = [];
    for (const [key, entry] of Object.entries(input.frame)) {
      if (Array.isArray(entry)) {
        addError(
          envelope,
          [key],
          `batched frame arrays are not supported on query (op-key '${key}')`,
          'batched_not_supported'
        );
        this.#metric('engine_batched_not_supported', { op: 'query', key });
        continue;
      }
      const parsed = parsedByKey.get(key) ?? null;
      // Locally-registered namespaces win over bridges. Virtual namespaces have
      // no dataset, so without the local-namespace check a bridge registered at
      // runtime (after boot-time collision checks) under the same alias would
      // silently shadow the local virtual surface.
      if (
        parsed &&
        !this.#datasets.has(parsed.ns) &&
        !this.#namespaces.has(parsed.ns) &&
        this.#bridges.has(parsed.ns)
      ) {
        if (this.#refuseUngranted(envelope, key, parsed.ns, ctx.identity, 'query')) continue;
        let bucket = bridgeBuckets.get(parsed.ns);
        if (bucket === undefined) {
          bucket = {};
          bridgeBuckets.set(parsed.ns, bucket);
        }
        bucket[key] = entry;
        continue;
      }
      const paged = this.#applyPageLimits(envelope, key, entry, parsed, input.pageLimits);
      if (paged !== null) localEntries.push([key, paged]);
    }

    // Kick off bridged buckets in parallel with the local loop.
    const bridgePromises: Array<Promise<void>> = [];
    for (const [ns, bucket] of bridgeBuckets) {
      bridgePromises.push(this.#bridgeProxy.runQuery(ns, bucket, envelope));
    }

    // Queries don't need atomicity — read-only. No cross-substrate refusal
    // check; reads across substrates are safe. Frame entries dispatch
    // concurrently so a multi-type frame's per-entry pg round-trips can
    // overlap rather than serialise. The envelope is per-key isolated for
    // `data`/`shapes`/`_pagination` writes; `errors` may land in resolver-
    // completion order rather than declared-frame order, accepted for latency.
    // At most QUERY_KEY_CONCURRENCY at once: a frame with thousands of keys
    // must not open thousands of dataset reads together.
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < localEntries.length) {
        const [key, entry] = localEntries[next++] as [string, FrameEntry];
        if (signal?.aborted === true) {
          addError(envelope, [key], 'query aborted before dispatch', 'aborted');
          this.#metric('engine_query_aborted', { key });
          continue;
        }
        await this.#runEntry(
          envelope,
          key,
          entry,
          ctx,
          'query',
          null,
          null,
          parsedByKey.get(key) ?? null,
          undefined,
          signal
        );
      }
    };
    const localPromises = Array.from(
      { length: Math.min(QUERY_KEY_CONCURRENCY, localEntries.length) },
      worker
    );

    await Promise.all([...localPromises, ...bridgePromises]);
    return envelope;
  }

  /**
   * Run a mutate frame atomically. §5.13: callers control timeout via
   * `input.signal` (AbortController). Cancellation is cooperative — a resolver
   * that throws on `args.signal.aborted` triggers the enclosing tx's rollback
   * through the existing throw-rolls-back contract. A signal that fires AFTER
   * a resolver returns does NOT undo a committed write.
   *
   * Idempotency (§5.13): when any entry carries `idempotencyKey`, the engine
   * computes a per-frame dedup key and consults the configured store before
   * dispatch. A hit returns the cached envelope verbatim; a miss proceeds
   * normally and caches the envelope on success.
   *
   * Bridge routing (§5.8): keys whose namespace is bridged are proxied to the
   * remote via `BridgeClient.mutate` — one call per bridge, in parallel with
   * the local tx. G1 atomicity (§5.3) does NOT extend across bridges: each
   * bridge commits independently and the local tx commits independently,
   * best-effort with orphan markers on partial failure. Unreachable
   * bridges surface per-key `bridge_unreachable` errors in `envelope.errors`
   * (§6.5 "Deletes never proceed silently across a network").
   */
  async mutate(input: EngineInput): Promise<PackEnvelope> {
    const keys = Object.keys(input.frame);
    // Pre-parse every key once; everything downstream reads from this map.
    const parsedByKey = this.#buildParsedKeyCache(keys);
    const envelope = this.#makeEnvelope(keys, parsedByKey);
    if (keys.length === 0) return envelope;

    // §5.13 idempotency. Frame-scoped dedup key resolution + cache hit short-
    // circuit happen before any partitioning so a conflict / hit never touches
    // a resolver.
    const idempotencyResolution = this.#resolveFrameIdempotencyKey(input.frame);
    if (idempotencyResolution.kind === 'conflict') {
      addTopLevelError(
        envelope,
        `conflicting idempotencyKey values in mutate frame: ${idempotencyResolution.values.join(', ')}`,
        'idempotency_key_conflict'
      );
      this.#metric('engine_idempotency_key_conflict', {
        values: idempotencyResolution.values
      });
      return envelope;
    }
    // Caller-scope the dedup key: a cache hit short-circuits
    // dispatch before policy/obligations run, so the key must not cross
    // authorization boundaries. Computed once and reused for the post-commit
    // `.put()` so read + write address the same slot.
    const callerKey = callerDedupComponent(input.ctx.identity ?? null);
    const idempotency = this.#idempotency;
    const dedupKey =
      idempotencyResolution.kind === 'present'
        ? makeDedupKey(keys, idempotencyResolution.value, callerKey)
        : undefined;
    // Batched slots are cached per frame after commit; a concurrent retry of
    // the same batch joins the running one rather than missing that cache.
    const inFlightKey = dedupKey ?? batchedInFlightKey(input.frame, callerKey);
    if (inFlightKey !== undefined && idempotency !== undefined) {
      const running = this.#inFlightMutates.get(inFlightKey);
      if (running !== undefined) {
        this.#metric('engine_idempotency_joined', { dedupKey: inFlightKey });
        return running;
      }
      const run = (async (): Promise<PackEnvelope> => {
        const cached = dedupKey === undefined ? undefined : await idempotency.store.get(dedupKey);
        if (cached !== undefined) {
          this.#metric('engine_idempotency_hit', { dedupKey });
          return cached;
        }
        return this.#mutateDispatch(
          input,
          keys,
          parsedByKey,
          envelope,
          idempotencyResolution,
          callerKey
        );
      })();
      this.#inFlightMutates.set(inFlightKey, run);
      try {
        return await run;
      } finally {
        this.#inFlightMutates.delete(inFlightKey);
      }
    }
    return this.#mutateDispatch(
      input,
      keys,
      parsedByKey,
      envelope,
      idempotencyResolution,
      callerKey
    );
  }

  async #mutateDispatch(
    input: EngineInput,
    keys: string[],
    parsedByKey: Map<string, ParsedKey | null>,
    envelope: PackEnvelope,
    idempotencyResolution: { kind: 'absent' } | { kind: 'present'; value: string },
    callerKey: string
  ): Promise<PackEnvelope> {
    // Partition by routing target (local vs bridged) and by frame shape (single
    // vs array). Empty-array op-keys are rejected here so the local-dispatch
    // pass only sees well-formed batches.
    const { bridgeBuckets, localKeys } = partitionMutateByRoute(
      input.frame,
      parsedByKey,
      envelope,
      {
        datasets: this.#datasets,
        bridges: this.#bridges,
        hasLocalNamespace: (ns: string): boolean => this.#namespaces.has(ns),
        refuseUngranted: (key: string, ns: string): boolean =>
          this.#refuseUngranted(envelope, key, ns, input.ctx.identity ?? null, 'mutate'),
        metric: this.#metric
      }
    );
    const { singleFrameKeys, nonEmptyArrayKeys } = partitionMutateByShape(
      input.frame,
      localKeys,
      envelope,
      this.#metric
    );

    // §5.3 G1 cross-substrate refusal + substrate coalescing. The single-frame
    // bucket shares ONE tx, so resolving every entry's dataset and refusing
    // mixed substrates must happen before any resolver runs. Array buckets are
    // each single-key — cross-substrate within an array is structurally
    // impossible — and run their own tx, so they're not part of this check.
    // Keys outside the caller's mutate grant stay out of the scope check: they
    // fail their own gate at dispatch, and a refusal must not describe
    // namespaces the caller cannot reach.
    const identity = input.ctx.identity ?? null;
    const grantedKeys = singleFrameKeys.filter((key) => {
      const parsed = parsedByKey.get(key);
      return !parsed || checkIdentityGrant(identity, parsed.ns, 'mutate').ok;
    });
    const partition = partitionMutateByTxScope(grantedKeys, parsedByKey, this.#datasets);
    if (partition.kind === 'cross_tx_scope_refused') {
      addTopLevelError(envelope, partition.message, 'cross_tx_scope_refused');
      this.#metric('engine_cross_tx_scope_refused', { namespaces: partition.namespaces });
      return envelope;
    }

    const ctx = this.#buildContext(input.ctx, 'mutate');
    const signal = input.signal;

    // Fire bridge proxies in parallel with the local tx (§5.8). Each bridge's
    // call is independent and populates envelope.errors on failure rather than
    // throwing — bridge atomicity is per-bridge best-effort, NOT G1.
    const bridgePromises: Array<Promise<void>> = [];
    for (const [ns, bucket] of bridgeBuckets) {
      bridgePromises.push(
        this.#bridgeProxy.runMutate(ns, scopeBridgeIdempotency(bucket, callerKey), envelope)
      );
    }

    // §5.4 write-event batch. Resolvers emit into this collector via
    // `args.onWrite`; the fanout to the subscription bus runs AFTER all
    // transactions resolve so rolled-back txs produce no pushes.
    const writeBatch: WriteEvent[] = [];
    const onWrite = (event: WriteEvent): void => {
      writeBatch.push(event);
    };

    await this.#dispatchSingleFrameLocal(
      envelope,
      input.frame,
      singleFrameKeys,
      parsedByKey,
      partition,
      ctx,
      onWrite,
      signal
    );

    // Batched op-keys: one isolated tx per array (§5.13). Each array commits
    // or rolls back independently of every other op-key and of the single-
    // frame bucket. A throw in array[i] rolls back that array's tx only;
    // prior array op-keys keep their commits, the single-frame bucket keeps
    // its commit (if it already resolved), and later array op-keys still run.
    for (const key of nonEmptyArrayKeys) {
      const frames = input.frame[key] as Array<FrameEntry>;
      await this.#runArrayEntry(
        envelope,
        key,
        parsedByKey.get(key) ?? null,
        frames,
        ctx,
        onWrite,
        signal
      );
    }

    await Promise.all(bridgePromises);

    // Post-commit fanout. A throw inside `withTransaction` propagates out of
    // this function before we get here, which is the point — no pushes for
    // rolled-back writes. Dispatch is synchronous (enqueue-only); each
    // subscription's per-entry drain task serialises the async `onFrame`
    // calls so a slow consumer cannot stall this call.
    for (const event of writeBatch) {
      this.#subscribe.dispatchWrite(event);
    }

    return this.#finaliseMutateEnvelope(envelope, keys, idempotencyResolution, callerKey);
  }

  /**
   * Dispatch the single-frame G1 bucket (§5.3). Branches on the substrate
   * partition shape:
   *
   *   - `zero_datasets`: no singleFrame key resolved to a dataset. Run each
   *     through `#runEntry` with no tx. Two legitimate populations land here:
   *     unresolvable keys (unqualified / unknown ns) emit their own per-key
   *     error code, and virtual-namespace keys dispatch with `args.dataset`
   *     undefined — virtual mutations are non-transactional.
   *   - `single_dataset`: one shared tx across every entry. If the dataset
   *     implements `withScopedTransaction` AND the substrate's edges handle
   *     is non-null, row and edge mutations run in ONE substrate tx; otherwise
   *     they use nested dataset + edges txs.
   *   - `coalesced_tx_scope`: N datasets, one substrate. Requires
   *     `withScopedTransaction`; if missing, surface
   *     `cross_tx_scope_refused` rather than silently breaking G1.
   */
  async #dispatchSingleFrameLocal(
    envelope: PackEnvelope,
    frame: QualifiedFrame,
    singleFrameKeys: string[],
    parsedByKey: Map<string, ParsedKey | null>,
    partition: LocalTxScopePartition,
    ctx: Omit<RequestContext, 'namespace'>,
    onWrite: (event: WriteEvent) => void,
    signal: AbortSignal | undefined
  ): Promise<void> {
    if (partition.kind === 'zero_datasets') {
      if (singleFrameKeys.length === 0) return;
      for (const key of singleFrameKeys) {
        const entry = frame[key] as FrameEntry | undefined;
        if (entry === undefined) continue;
        await this.#runEntry(
          envelope,
          key,
          entry,
          ctx,
          'mutate',
          null,
          null,
          parsedByKey.get(key) ?? null,
          undefined,
          signal
        );
      }
      return;
    }

    // One tx for the bucket: a resolver refusing through the envelope must
    // unwind it like a throw, or the entries before it commit. Write events
    // wait for the commit for the same reason.
    const pending: WriteEvent[] = [];
    const settled: AfterTxWork[] = [];
    let committed = false;
    let refusedKey: string | undefined;
    const runBody = async (
      txFor: (ns: string) => Dataset | null,
      txEdges: EdgesStore
    ): Promise<void> => {
      // Every key, not just the ones that resolved to a dataset: virtual,
      // unknown and unqualified keys still dispatch (or report their error).
      for (const key of singleFrameKeys) {
        const entry = frame[key] as FrameEntry | undefined;
        if (entry === undefined) continue;
        const parsed = parsedByKey.get(key) ?? null;
        const errorsBefore = envelope.errors?.length ?? 0;
        const thrown = await this.#runEntry(
          envelope,
          key,
          entry,
          ctx,
          'mutate',
          parsed === null ? null : txFor(parsed.ns),
          txEdges,
          parsed,
          (event) => pending.push(event),
          signal,
          (fn) => settled.push(fn),
          singleFrameKeys.length
        );
        // Any refusal of this key (grant, policy, validation, a resolver's
        // frame error) unwinds the bucket: the entries commit together or not at all.
        const refused =
          thrown || (envelope.errors ?? []).slice(errorsBefore).some((e) => e.path?.[0] === key);
        if (refused) {
          refusedKey = key;
          throw new SharedTxRefusal();
        }
      }
    };

    try {
      if (partition.kind === 'single_dataset') {
        // Virtual keys receive txDs too; #runEntry discards it by contract.
        await this.#withRowsAndEdgesTx(
          partition.dataset,
          partition.entries[0]?.ns,
          (txDs, txEdges) => runBody(() => txDs, txEdges)
        );
      } else {
        const firstDataset = partition.firstDataset;
        const nsList = Array.from(new Set(partition.entries.map((e) => e.ns)));
        if (firstDataset.withScopedTransaction === undefined) {
          nsList.sort();
          addTopLevelError(
            envelope,
            `mutate cannot coalesce across [${nsList.join(', ')}]: tx scope '${firstDataset.txScopeId ?? 'unknown'}' does not support withScopedTransaction`,
            'cross_tx_scope_refused'
          );
          this.#metric('engine_cross_tx_scope_refused', { namespaces: nsList });
          return;
        }
        await firstDataset.withScopedTransaction(nsList, async ({ datasets, edges }) => {
          const txFor = (ns: string): Dataset | null => datasets.get(ns) ?? null;
          if (edges !== null) {
            await runBody(txFor, edges);
          } else {
            await this.#edges.withTransaction((txEdges) => runBody(txFor, txEdges));
          }
        });
      }
      committed = true;
    } catch (err) {
      if (!(err instanceof SharedTxRefusal)) throw err;
      for (const key of singleFrameKeys) {
        const ns = parsedByKey.get(key)?.ns;
        // Virtual mutations ran outside the tx, so their results stand.
        if (ns !== undefined && this.#namespaces.get(ns)?.virtual === true) continue;
        // A key with neither data nor an error never ran: the refusal came
        // first. It is marked too, so no key comes back empty.
        if (!(key in envelope.data) && envelope.errors?.some((e) => e.path?.[0] === key)) {
          continue;
        }
        delete envelope.data[key];
        delete envelope.shapes[key];
        addError(
          envelope,
          [key],
          `mutate rolled back: '${refusedKey}' refused`,
          'frame_rolled_back'
        );
      }
      this.#metric('engine_frame_rolled_back', { key: refusedKey });
      return;
    } finally {
      await this.#runSettled(settled, committed);
    }
    for (const event of pending) onWrite(event);
  }

  /**
   * A list read on a dataset-backed type gets the default page when it names
   * no `limit`, and is refused above the maximum. Virtual types own their
   * params, so they pass through untouched.
   */
  #applyPageLimits(
    envelope: PackEnvelope,
    key: string,
    entry: FrameEntry,
    parsed: ParsedKey | null,
    limits: EngineInput['pageLimits']
  ): FrameEntry | null {
    if (limits === undefined || parsed === null) return entry;
    const nsCfg = this.#namespaces.get(parsed.ns);
    if (nsCfg === undefined || nsCfg.virtual === true) return entry;
    if (nsCfg.registry.get(parsed.name)?.kind !== 'type') return entry;
    // A nested `{ _walk }` selection's limit has the same max; it has no cursor in v1.
    const nested = nestedOverLimit(entry.fields, ['fields'], limits.maxLimit);
    if (nested !== null) {
      addError(
        envelope,
        [key, ...nested],
        `nested limit exceeds the maximum page of ${limits.maxLimit}`,
        'limit_exceeds_max',
        { max: limits.maxLimit }
      );
      return null;
    }
    const limit = entry.params?.limit;
    if (limit === undefined || limit === null) {
      return { ...entry, params: { ...entry.params, limit: limits.defaultLimit } };
    }
    // Anything a reader might take as "no limit" is refused, not passed on.
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 0) {
      addError(envelope, [key, 'limit'], 'limit must be a non-negative integer', 'invalid_limit');
      return null;
    }
    if (limit > limits.maxLimit) {
      addError(
        envelope,
        [key, 'limit'],
        `limit ${limit} exceeds the maximum page of ${limits.maxLimit}; page with the returned cursor`,
        'limit_exceeds_max',
        { max: limits.maxLimit }
      );
      return null;
    }
    return entry;
  }

  /** Runs `afterTx` work; a failure is reported, never allowed to replace the frame's outcome. */
  async #runSettled(settled: AfterTxWork[], committed: boolean): Promise<void> {
    for (const fn of settled) {
      try {
        await fn({ committed });
      } catch (err) {
        this.#metric('engine_after_tx_failed', {
          message: err instanceof Error ? err.message : String(err)
        });
      }
    }
  }

  /**
   * Write the idempotency cache entry (when enabled + zero errors) and return
   * the envelope. Shared by the local-tx and bridge-only exit paths of
   * `mutate` so both honour the dedup contract.
   */
  async #finaliseMutateEnvelope(
    envelope: PackEnvelope,
    keys: string[],
    resolution:
      | { kind: 'absent' }
      | { kind: 'present'; value: string }
      | { kind: 'conflict'; values: string[] },
    callerKey: string
  ): Promise<PackEnvelope> {
    // Cache once any key has data, i.e. ran and was not rolled back: a reply
    // that is error-free is not the test, since a refused sibling leaves the
    // committed keys in place and a retry would run them again. A frame where
    // nothing ran stays uncached, so its retry runs.
    if (
      resolution.kind === 'present' &&
      this.#idempotency !== undefined &&
      keys.some((key) => key in envelope.data)
    ) {
      const dedupKey = makeDedupKey(keys, resolution.value, callerKey);
      // The write has committed: failing the call now would invite the retry
      // that duplicates it.
      try {
        await this.#idempotency.store.put(dedupKey, envelope, this.#idempotency.defaultTtlMs);
        this.#metric('engine_idempotency_put', { dedupKey });
      } catch (err) {
        this.#metric('engine_idempotency_put_failed', {
          dedupKey,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }
    return envelope;
  }

  /**
   * Inspect the frame for an `idempotencyKey`. Multiple entries carrying the
   * field must agree; a mismatch is a caller bug and we refuse the whole frame.
   *
   * Array (batched) op-keys are excluded from this frame-level check: each
   * array element carries its OWN idempotencyKey and is deduped per-frame
   * against a key that includes the array index (§5.13, batched mutate).
   * Frame-level dedup continues to apply only to single-frame op-keys.
   */
  #resolveFrameIdempotencyKey(
    frame: QualifiedFrame
  ):
    | { kind: 'absent' }
    | { kind: 'present'; value: string }
    | { kind: 'conflict'; values: string[] } {
    const seen = new Set<string>();
    for (const entry of Object.values(frame)) {
      if (Array.isArray(entry)) continue;
      if (entry.idempotencyKey !== undefined) seen.add(entry.idempotencyKey);
    }
    if (seen.size === 0) return { kind: 'absent' };
    if (seen.size === 1) {
      const [value] = seen;
      return { kind: 'present', value: value as string };
    }
    return { kind: 'conflict', values: Array.from(seen).sort() };
  }

  #buildParsedKeyCache(keys: string[]): Map<string, ParsedKey | null> {
    const parsedByKey = new Map<string, ParsedKey | null>();
    for (const key of keys) {
      parsedByKey.set(key, parseQualifiedKey(key));
    }
    return parsedByKey;
  }

  /**
   * §5.12 per-frame grant gate (namespace and capability). Records the refusal
   * under `key` and returns true when `identity` may not run `operation` in
   * `ns`. Bridged keys pass through here too, before they are proxied.
   */
  #refuseUngranted(
    envelope: PackEnvelope,
    key: string,
    ns: string,
    identity: RequestContext['identity'] | null | undefined,
    operation: 'query' | 'mutate'
  ): boolean {
    const nsGate = checkIdentityGrant(identity, ns, operation);
    if (nsGate.ok) return false;
    addError(envelope, [key], grantRefusal(ns, nsGate), grantRefusalCode(nsGate));
    this.#metric('engine_unauthorized_namespace', { key, ns, reason: nsGate.reason });
    return true;
  }

  #makeEnvelope(keys: string[], parsedByKey: Map<string, ParsedKey | null>): PackEnvelope {
    // Single-ns frames use the per-ns schemaVersion (the common case); multi-ns
    // frames use the federated version so the client can detect drift on any
    // of the referenced namespaces. Empty frames use the federated version —
    // matches the "I queried no types, tell me what you look like" shape.
    const nsSet = new Set<string>();
    for (const k of keys) {
      const parsed = parsedByKey.get(k);
      if (parsed) nsSet.add(parsed.ns);
    }
    let version: string;
    if (nsSet.size === 1) {
      const [ns] = nsSet;
      if (ns !== undefined && this.#isLive(ns)) {
        version = this.schemaFor(ns).schemaVersion;
      } else {
        version = this.federatedSchemaVersion();
      }
    } else {
      version = this.federatedSchemaVersion();
    }
    return { schemaVersion: version, data: {}, shapes: {} };
  }

  #buildContext(
    caller: Partial<RequestContext>,
    operation: 'query' | 'mutate'
  ): Omit<RequestContext, 'namespace'> {
    // namespace is filled per-entry in #runEntry. Caller-supplied namespace /
    // operation are ignored — the engine is authoritative for both.
    const base: Omit<RequestContext, 'namespace'> = {
      identity: caller.identity ?? null,
      operation,
      now: caller.now ?? new Date(),
      headers: caller.headers ?? {},
      meta: caller.meta ?? {}
    };
    if (caller.clientIp !== undefined) base.clientIp = caller.clientIp;
    return base;
  }

  /** Resolves true when the resolver refused with a `ResolverFrameError`. */
  async #runEntry(envelope: PackEnvelope, key: string, ...rest: RunEntryRest): Promise<boolean> {
    const hook = this.#onResolve;
    if (hook === undefined) return this.#runEntryInner(envelope, key, ...rest);
    const kind = rest[2];
    // Caller-controlled bytes must not reach the stats: a key that names no
    // live local entry is recorded under one sentinel (the error code says why).
    const parsedKey = rest[5];
    const obsKey =
      parsedKey !== null && this.#namespaces.get(parsedKey.ns)?.registry.get(parsedKey.name)
        ? key
        : '(unknown)';
    const callerId = rest[1].identity?.id;
    const caller = callerId !== undefined ? { caller: callerId } : {};
    const before = envelope.errors?.length ?? 0;
    const t0 = performance.now();
    const emit = (o: Omit<ResolveObservation, 'key' | 'kind' | 'durationMs' | 'caller'>): void => {
      try {
        const ret: unknown = hook({
          key: obsKey,
          kind,
          durationMs: performance.now() - t0,
          ...caller,
          ...o
        });
        // An async hook's rejection must not become an unhandled rejection.
        if (typeof (ret as PromiseLike<unknown> | undefined)?.then === 'function') {
          Promise.resolve(ret).catch(() => {});
        }
      } catch {
        // A metrics sink must never change what the caller gets.
      }
    };
    let refused: boolean;
    try {
      refused = await this.#runEntryInner(envelope, key, ...rest);
    } catch (err) {
      emit({
        ok: false,
        code: isResolverFrameError(err) ? err.code : 'exception',
        message: err instanceof Error ? err.message : String(err)
      });
      throw err;
    }
    // Query keys run concurrently over one shared envelope: attribute by path,
    // never by length.
    const mine = (envelope.errors ?? [])
      .slice(before)
      .find((e) => Array.isArray(e.path) && e.path[0] === key);
    emit(
      mine === undefined
        ? { ok: true }
        : {
            ok: false,
            ...(mine.code !== undefined ? { code: mine.code } : {}),
            message: mine.message
          }
    );
    return refused;
  }

  async #runEntryInner(
    envelope: PackEnvelope,
    key: string,
    entry: FrameEntry,
    ctxBase: Omit<RequestContext, 'namespace'>,
    operation: 'query' | 'mutate',
    tx: Dataset | null,
    txEdges: EdgesStore | null,
    parsed: ParsedKey | null,
    onWrite?: (event: WriteEvent) => void,
    signal?: AbortSignal,
    afterTx?: (fn: AfterTxWork) => void,
    txEntries?: number
  ): Promise<boolean> {
    if (!parsed) {
      addError(
        envelope,
        [key],
        `unqualified frame key '${key}' — expected '<ns>/<name>'`,
        'unqualified_key'
      );
      this.#metric('engine_unqualified_key', key);
      return false;
    }

    const { ns, name } = parsed;

    // §5.12 per-frame grant gate (namespace and capability). Per-key failure —
    // other keys in the same payload still resolve.
    if (this.#refuseUngranted(envelope, key, ns, ctxBase.identity, operation)) return false;

    if (this.#tombstoned.has(ns)) {
      addError(envelope, [key], `namespace '${ns}' was deleted`, 'namespace_tombstoned');
      this.#metric('engine_namespace_tombstoned_reject', { key, ns });
      return false;
    }

    const nsCfg = this.#namespaces.get(ns);
    if (!nsCfg) {
      addError(envelope, [key], `unknown namespace '${ns}'`, 'unknown_namespace');
      this.#metric('engine_unknown_namespace', ns);
      return false;
    }

    // Virtual namespaces own no storage: skip the dataset
    // requirement and leave args.dataset undefined. A tx from a mixed mutate
    // payload (a virtual key riding inside another ns's dataset tx) is
    // deliberately NOT threaded — virtual mutations are non-transactional with
    // dataset mutations by contract; the resolver computes from params/fields.
    const isVirtual = nsCfg.virtual === true;
    const dataset = isVirtual ? undefined : (tx ?? this.#datasets.get(ns));
    if (!isVirtual && !dataset) {
      // Query path: we didn't pre-resolve. A namespace registered in
      // `namespaces` but missing from `datasets` is a misconfiguration — same
      // error code as "ns not present at all" so callers have one thing to fix.
      addError(envelope, [key], `unknown namespace '${ns}'`, 'unknown_namespace');
      this.#metric('engine_unknown_namespace', ns);
      return false;
    }

    const registryEntry = nsCfg.registry.get(name);
    if (!registryEntry) {
      addError(envelope, [key], `unknown name '${name}' in namespace '${ns}'`, 'unknown_name');
      this.#metric('engine_unknown_name', { ns, name });
      return false;
    }

    // Metadata spellings the read path returns (`createdBy`, `_metadata`, …)
    // reach policy, validation and the resolver as the canonical columns.
    const frame =
      operation === 'query' && registryEntry.kind === 'type'
        ? withCanonicalMetadataFilters(entry, registryEntry.fields)
        : entry;

    // Thread the entry name + autoCRUD verb so policies can discriminate
    // resolvers (get<T> vs delete<T> otherwise look identical).
    const ctx: RequestContext = {
      ...ctxBase,
      namespace: ns,
      operation,
      entry: name,
      ...(registryEntry.verb !== undefined ? { verb: registryEntry.verb } : {})
    };
    const args = toResolverArgs(
      frame,
      dataset,
      txEdges ?? this.#edges,
      onWrite,
      signal,
      (ns) => this.#datasets.get(ns),
      afterTx,
      txEntries
    );
    const decision = evaluatePolicy(registryEntry.policy, ctx, args);

    if (!decision.allow) {
      addError(envelope, [key], decision.reason ?? 'policy denied', 'policy_denied');
      this.#metric('engine_policy_denied', { key, reason: decision.reason });
      return false;
    }
    // A row filter reads the whole row, so the substrate must not narrow it to
    // the caller's selection; the transport projects the response.
    if ((decision.obligations?.length ?? 0) > 0) delete args.fields;

    if (!this.#walksEnabled && operation === 'query' && registryEntry.kind === 'type') {
      const walkPath = walkGrammarPath(frame as Record<string, unknown>);
      if (walkPath) {
        addError(
          envelope,
          [key, ...walkPath],
          'the walk grammar is disabled on this server (SUBSTRATE_WALKS)',
          WALKS_DISABLED
        );
        return false;
      }
    }

    // Filter validation (§5.2) lives in `./filter-guard.js` — same contract:
    // `false` means an error was recorded and dispatch must not proceed.
    const guardDeps = {
      schemaFor: (ns: string) => this.schemaFor(ns),
      invalidateSchemaCaches: (ns: string) => this.invalidateSchemaCaches(ns),
      metric: (name: string, payload?: unknown) => this.#metric(name, payload)
    };
    const guardOk = runFilterGuard(guardDeps, {
      envelope,
      key,
      entry: frame,
      ns,
      name,
      operation,
      entryKind: registryEntry.kind,
      isVirtual,
      dataset
    });
    if (!guardOk) return false;

    // A query reads in the type's natural order unless it names one.
    if (operation === 'query' && !isVirtual) {
      const params = withNaturalOrder(args.params, registryEntry, dataset);
      if (params !== undefined) args.params = params;
    }

    // A throw here propagates out of the surrounding withTransaction (on
    // mutate) and rolls back every prior frame entry — the G1 contract.
    // Exception: `RestrictViolation` (§6.2) is a clean refusal, NOT a rollback
    // trigger. The target row was never tombstoned; other frame entries retain
    // their own work. We surface it in envelope.errors with a dedicated code so
    // callers can distinguish "your delete was blocked by an edge" from a
    // substrate failure.
    const cursor = args.params?.cursor;
    if (typeof cursor === 'string') {
      // Under a row filter only a sealed cursor is accepted: that is all this
      // entry ever hands out.
      const filtering = (decision.obligations?.length ?? 0) > 0;
      const opened = filtering && !isSealedCursor(cursor) ? null : openCursor(cursor);
      if (opened === null) {
        addError(envelope, [key], 'cursor is not one this server issued', 'invalid_cursor');
        return false;
      }
      args.params = { ...args.params, cursor: opened };
    }

    let result: Row | Row[] | ReadResult | AsyncIterable<Row> | null;
    const t0 = performance.now();
    try {
      result = await registryEntry.resolver(ctx, args);
    } catch (err) {
      if (isRestrictViolation(err)) {
        addError(envelope, [key], err.message, 'restrict_violation');
        this.#metric('engine_restrict_violation', {
          key,
          blockedBy: err.blockedBy.length
        });
        return false;
      }
      if (isResolverFrameError(err)) {
        // Caller-chosen envelope error code (spec: ResolverFrameError). Keeps
        // non-authz refusals (e.g. value-dependent schema constraints) out of
        // the generic `resolver_error` bucket so clients can branch on `code`;
        // `details` is projected verbatim.
        addError(envelope, [key], err.message, err.code, err.details);
        this.#metric('engine_resolver_frame_error', { key, code: err.code });
        return true;
      }
      throw err;
    } finally {
      // After natural order is injected, so the shape carries the effective
      // order; a read that throws (a timeout, a cancel) is recorded too, up to
      // the throw. A single-row `id` read is served by the key, so no index
      // could speed it.
      if (
        operation === 'query' &&
        registryEntry.kind === 'type' &&
        !isVirtual &&
        args.params?.id === undefined
      ) {
        this.#shapeRecorder?.observe(
          readShapeOf(ns, name, registryEntry.fields, args.params?.where, args.params?.orderBy),
          performance.now() - t0
        );
      }
    }

    shapeResult({
      envelope,
      key,
      entry: frame,
      ctx,
      decision,
      result,
      metric: (name: string, payload?: unknown) => this.#metric(name, payload)
    });
    return false;
  }

  /**
   * Run `fn` in one transaction over `dataset`'s rows and the edges. A dataset
   * with `withScopedTransaction` and an enlisted edges store shares one
   * substrate tx (one pg connection); otherwise the edges tx nests inside the
   * dataset tx.
   */
  async #withRowsAndEdgesTx(
    dataset: Dataset,
    ns: string | undefined,
    fn: (txDs: Dataset, txEdges: EdgesStore) => Promise<void>
  ): Promise<void> {
    if (dataset.withScopedTransaction !== undefined && ns !== undefined) {
      await dataset.withScopedTransaction([ns], async ({ datasets, edges }) => {
        const txDs = datasets.get(ns) ?? dataset;
        if (edges !== null) await fn(txDs, edges);
        else await this.#edges.withTransaction((txEdges) => fn(txDs, txEdges));
      });
      return;
    }
    await dataset.withTransaction(async (txDs) => {
      await this.#edges.withTransaction((txEdges) => fn(txDs, txEdges));
    });
  }

  /**
   * Dispatch a batched (array-valued) mutate op-key. §5.13.
   *
   * Contract:
   *   - All frames under `key` run serially inside ONE isolated transaction.
   *     A throw in frame[i] rolls back every frame[<=i] in this array; the
   *     array commits or rolls back as a unit (all-or-nothing per op-key).
   *   - Cross-op-key atomicity is NOT a goal for the batched path — this
   *     array's tx is INDEPENDENT of every other op-key's tx (the single-
   *     frame G1 bucket and every other batched array each commit
   *     separately). Callers that need cross-op-key atomicity must stick to
   *     the non-batched dispatch shape where G1 still applies.
   *   - Per-frame idempotency dedup (§5.13): each frame's `idempotencyKey`
   *     is keyed independently on `(qualifiedKey, index, idempotencyKey)`.
   *     A cached slot is reused verbatim (resolver NOT invoked); a miss
   *     runs the resolver inside the shared tx and caches the per-frame
   *     slot after the whole array commits.
   *   - Envelope shape: `envelope.data[key]` becomes `Array<unknown>` with
   *     one element per frame (the value `#runEntry` would have written
   *     under `key` for a single dispatch). `envelope.shapes[key]` becomes
   *     `Array<'single' | 'list'>` with the per-frame shape at each index
   *     (or omitted when a frame surfaced only errors — the transport
   *     decoder keys off that).
   *   - Per-frame errors bubble up to `envelope.errors` with a path prefix
   *     of `[key, String(index), ...]` so callers can locate the offending
   *     slot without reparsing the array.
   *
   * Structural failures (unqualified key, unknown ns, bridge array routing)
   * short-circuit with a per-key error and never open a tx. The caller
   * pre-checks bridge routing + empty-array before invoking this method.
   */
  async #runArrayEntry(
    envelope: PackEnvelope,
    key: string,
    parsed: ParsedKey | null,
    frames: Array<FrameEntry>,
    ctxBase: Omit<RequestContext, 'namespace'>,
    onWrite: (event: WriteEvent) => void,
    signal?: AbortSignal
  ): Promise<void> {
    if (!parsed) {
      addError(
        envelope,
        [key],
        `unqualified frame key '${key}' — expected '<ns>/<name>'`,
        'unqualified_key'
      );
      this.#metric('engine_unqualified_key', key);
      return;
    }
    const { ns } = parsed;

    // Array form is mutate-only by construction — `#runArrayEntry` is reached
    // solely from the mutate path.
    const nsGate = checkIdentityGrant(ctxBase.identity, ns, 'mutate');
    if (!nsGate.ok) {
      addError(envelope, [key], grantRefusal(ns, nsGate), grantRefusalCode(nsGate));
      this.#metric('engine_unauthorized_namespace', { key, ns, reason: nsGate.reason });
      return;
    }

    if (this.#tombstoned.has(ns)) {
      addError(envelope, [key], `namespace '${ns}' was deleted`, 'namespace_tombstoned');
      this.#metric('engine_namespace_tombstoned_reject', { key, ns });
      return;
    }

    const nsCfg = this.#namespaces.get(ns);
    if (!nsCfg) {
      addError(envelope, [key], `unknown namespace '${ns}'`, 'unknown_namespace');
      this.#metric('engine_unknown_namespace', ns);
      return;
    }

    // Batched arrays promise per-op-key atomicity inside one dataset tx.
    // Virtual namespaces own no storage and cannot honour that contract — refuse
    // honestly rather than dispatching or emitting a misleading unknown_namespace.
    if (nsCfg.virtual === true) {
      addError(
        envelope,
        [key],
        `batched frame arrays are not supported on virtual namespace '${ns}' — virtual mutations are non-transactional; send single frames`,
        'batched_virtual_unsupported'
      );
      this.#metric('engine_batched_virtual_unsupported', { key, ns });
      return;
    }

    const dataset = this.#datasets.get(ns);
    if (!dataset) {
      addError(envelope, [key], `unknown namespace '${ns}'`, 'unknown_namespace');
      this.#metric('engine_unknown_namespace', ns);
      return;
    }

    // Per-frame idempotency pre-check. A cache HIT fills its slot with the
    // cached mini-envelope verbatim and skips the resolver at that index.
    // A cache MISS records the dedupKey so we can `.put()` after the whole
    // array commits.
    interface Slot {
      cached: boolean;
      data?: unknown;
      shape?: 'single' | 'list';
      dedupKey?: string;
      errors?: Array<{ message: string; path?: string[]; code?: string }>;
    }
    // Fan out the pre-flight idempotency `.get()` lookups in one await; `get`
    // is read-only and per-key isolated, so ordering doesn't matter.
    const slots: Slot[] = new Array(frames.length);
    const dedupKeys: Array<string | undefined> = new Array(frames.length);
    // Caller-scope each per-slot dedup key so a batched replay
    // by a different requester re-dispatches instead of returning the first
    // caller's cached slot. Reused for the post-commit `.put()` below.
    const callerKey = callerDedupComponent(ctxBase.identity);
    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i] as FrameEntry;
      const idempotencyKey = frame.idempotencyKey;
      if (idempotencyKey !== undefined && this.#idempotency !== undefined) {
        dedupKeys[i] = makeArrayDedupKey(key, i, idempotencyKey, callerKey);
      }
    }
    const cacheHits = await Promise.all(
      dedupKeys.map((dedupKey) =>
        dedupKey === undefined || this.#idempotency === undefined
          ? Promise.resolve(undefined)
          : this.#idempotency.store.get(dedupKey)
      )
    );
    for (let i = 0; i < frames.length; i++) {
      const dedupKey = dedupKeys[i];
      const cached = cacheHits[i];
      if (dedupKey !== undefined && cached !== undefined) {
        this.#metric('engine_idempotency_hit', { dedupKey });
        const cachedShape = cached.shapes[key];
        const slot: Slot = { cached: true, data: cached.data[key] };
        if (cachedShape === 'single' || cachedShape === 'list') slot.shape = cachedShape;
        if (cached.errors !== undefined) slot.errors = cached.errors;
        slots[i] = slot;
      } else if (dedupKey !== undefined) {
        slots[i] = { cached: false, dedupKey };
      } else {
        slots[i] = { cached: false };
      }
    }

    // Write-event capture is per-array so a rolled-back array never emits
    // pushes. The outer call merges these into the parent writeBatch after
    // this call returns successfully.
    const arrayWriteBatch: WriteEvent[] = [];
    const arrayOnWrite = (event: WriteEvent): void => {
      arrayWriteBatch.push(event);
    };

    // Scratch envelope per frame: #runEntry writes data/shape/errors keyed
    // by the qualified key. Collecting them one-at-a-time lets us assemble
    // the Array<slot> at the end.
    const scratchResults: Array<{
      data?: unknown;
      shape?: 'single' | 'list';
      errors?: Array<{ message: string; path?: string[]; code?: string }>;
    }> = new Array(frames.length);

    let frameError: Error | undefined;
    let failedIndex: number | undefined;
    const settled: AfterTxWork[] = [];
    try {
      await this.#withRowsAndEdgesTx(dataset, ns, async (txDs, txEdges) => {
        for (let i = 0; i < frames.length; i++) {
          const slot = slots[i] as Slot;
          if (slot.cached) {
            scratchResults[i] = {
              ...(slot.data !== undefined ? { data: slot.data } : {}),
              ...(slot.shape !== undefined ? { shape: slot.shape } : {}),
              ...(slot.errors !== undefined ? { errors: slot.errors } : {})
            };
            continue;
          }
          const frame = frames[i] as FrameEntry;
          const scratch: PackEnvelope = {
            schemaVersion: envelope.schemaVersion,
            data: {},
            shapes: {}
          };
          failedIndex = i;
          await this.#runEntry(
            scratch,
            key,
            frame,
            ctxBase,
            'mutate',
            txDs,
            txEdges,
            parsed,
            arrayOnWrite,
            signal,
            (fn) => settled.push(fn),
            frames.length
          );
          failedIndex = undefined;
          const entry: {
            data?: unknown;
            shape?: 'single' | 'list';
            errors?: Array<{ message: string; path?: string[]; code?: string }>;
          } = {};
          if (key in scratch.data) entry.data = scratch.data[key];
          const shape = scratch.shapes[key];
          if (typeof shape === 'string') entry.shape = shape;
          if (scratch.errors !== undefined && scratch.errors.length > 0) {
            entry.errors = scratch.errors;
            // An array under one op-key is ONE transaction: a frame that
            // refused via the envelope must unwind it just like one that
            // threw, or the frames before it commit.
            scratchResults[i] = entry;
            failedIndex = i;
            throw new BatchedFrameRefusal(scratch.errors);
          }
          scratchResults[i] = entry;
        }
      });
    } catch (err) {
      frameError = err instanceof Error ? err : new Error(String(err));
    }
    await this.#runSettled(settled, frameError === undefined);

    if (frameError !== undefined) {
      // Whole-array rollback. `failedIndex` (set just before each `#runEntry`)
      // names the failing frame in the error path and the metric.
      const atSuffix = failedIndex !== undefined ? ` at frame[${failedIndex}]` : '';
      // Replay the refusing frame's own errors first, codes intact — a caller
      // branching on `not_found` must still find it after the rollback.
      if (frameError instanceof BatchedFrameRefusal) {
        for (const e of frameError.frameErrors) {
          addError(envelope, e.path ?? [key], e.message, e.code);
        }
      }
      addError(
        envelope,
        failedIndex !== undefined ? [key, String(failedIndex)] : [key],
        `batched mutate at '${key}'${atSuffix} rolled back: ${frameError instanceof BatchedFrameRefusal ? frameError.message : 'internal error'}`,
        'batched_frame_rolled_back'
      );
      this.#metric('engine_batched_frame_rolled_back', {
        key,
        frames: frames.length,
        ...(failedIndex !== undefined ? { failedIndex } : {}),
        message: frameError.message
      });
      return;
    }

    // Commit path — assemble the per-frame data/shape arrays and bubble the
    // per-frame errors with path = [key, index, ...].
    const dataArr: unknown[] = [];
    const shapeArr: Array<'single' | 'list'> = [];
    for (let i = 0; i < frames.length; i++) {
      const result = scratchResults[i];
      if (result === undefined) {
        dataArr.push(undefined);
        continue;
      }
      dataArr.push('data' in result ? result.data : undefined);
      // Fill sentinel 'single' when a slot errored without writing a shape.
      // Per-frame errors produce undefined data + no shape; decoder tolerates
      // the combo (null data + single-shape → decodes to null). Keeps the
      // `Array<'single' | 'list'>` type annotation honest — no sparse holes.
      shapeArr[i] = result.shape ?? 'single';
      if (result.errors !== undefined) {
        for (const e of result.errors) {
          const prefix: string[] = [key, String(i)];
          const extended = e.path !== undefined ? [...prefix, ...e.path.slice(1)] : prefix;
          addError(envelope, extended, e.message, e.code);
        }
      }
    }
    envelope.data[key] = dataArr;
    envelope.shapes[key] = shapeArr;

    // Post-commit: cache per-frame slots whose frame carried an
    // idempotencyKey + succeeded cleanly. Errors in that slot skip the cache
    // (mirrors the frame-level "errors → no cache" rule). Merge array's
    // writeBatch into the parent batch so the outer fanout still fires
    // post-commit. The puts run in parallel; the store is per-key isolated.
    if (this.#idempotency !== undefined) {
      const puts: Array<Promise<void>> = [];
      for (let i = 0; i < frames.length; i++) {
        const slot = slots[i] as Slot;
        if (slot.cached) continue;
        if (slot.dedupKey === undefined) continue;
        const result = scratchResults[i];
        if (result === undefined) continue;
        if (result.errors !== undefined && result.errors.length > 0) continue;
        const miniEnvelope: PackEnvelope = {
          schemaVersion: envelope.schemaVersion,
          data: { [key]: 'data' in result ? result.data : undefined },
          shapes: { [key]: result.shape ?? 'single' }
        };
        const dedupKey = slot.dedupKey;
        // The array has committed: a failed put must not fail the call.
        puts.push(
          this.#idempotency.store.put(dedupKey, miniEnvelope, this.#idempotency.defaultTtlMs).then(
            () => {
              this.#metric('engine_idempotency_put', { dedupKey });
            },
            (err: unknown) => {
              this.#metric('engine_idempotency_put_failed', {
                dedupKey,
                error: err instanceof Error ? err.message : String(err)
              });
            }
          )
        );
      }
      await Promise.all(puts);
    }

    // Publish writeEvents through the top-level dispatcher. The outer
    // writeBatch mechanism fires after the parent `mutate` returns; the
    // per-array tx already committed so firing pushes now matches the
    // non-batched semantics (pushes fire post-commit).
    for (const event of arrayWriteBatch) {
      onWrite(event);
    }
  }

  /**
   * Register a subscription (§5.4) by delegating to the SubscribeSubsystem.
   * The subsystem owns the bus, the back-pressure queue, and the WriteEvent
   * fanout — see subscribe.ts for the full contract.
   */
  async subscribe(input: SubscribeInput): Promise<SubscriptionHandle> {
    return this.#subscribe.subscribe(input);
  }

  /**
   * Live count of active subscription entries. Delegates to the
   * SubscribeSubsystem, which owns the authoritative map.
   */
  activeSubscriptionCount(): number {
    return this.#subscribe.subscriptionCount();
  }

  /**
   * Snapshot of per-entry queue depths for the GET /substrate/v1/metrics superset.
   * Delegates to the SubscribeSubsystem, which owns the authoritative map.
   * Returns an idle snapshot ({ count: 0, maxQueueDepth: 0, entries: [] })
   * when no subscriptions are registered.
   */
  subscriptionStats(): SubscriptionStatsSnapshot {
    return this.#subscribe.subscriptionStats();
  }

  /**
   * Register a stream dispatch (§5.5) by delegating to the StreamSubsystem —
   * see stream.ts for the full contract. Completion is observed via the
   * terminal `end` / `error` frame on `onFrame`; `cancel` is synchronous.
   */
  stream(input: StreamInput): StreamHandle {
    return this.#stream.stream(input);
  }
}

/** Path to the first nested `{ _walk }` selection whose numeric `limit` exceeds `max`, at any depth. */
function nestedOverLimit(fields: unknown, path: string[], max: number): string[] | null {
  if (typeof fields !== 'object' || fields === null) return null;
  for (const [name, sel] of Object.entries(fields)) {
    if (typeof sel !== 'object' || sel === null) continue;
    const s = sel as Record<string, unknown>;
    const walk = '_walk' in s;
    if (walk && typeof s.limit === 'number' && s.limit > max) return [...path, name, 'limit'];
    const deeper = walk
      ? nestedOverLimit(s.fields, [...path, name, 'fields'], max)
      : nestedOverLimit(s, [...path, name], max);
    if (deeper !== null) return deeper;
  }
  return null;
}
