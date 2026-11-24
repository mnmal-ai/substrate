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
 *     rolls back and the promise rejects with that resolver's error. Any
 *     refusal of an entry (outside the grant, denied by policy, invalid, or a
 *     resolver's `ResolverFrameError`) rolls the frame back too: its error is
 *     kept and every other single-frame entry reports `frame_rolled_back`.
 *   - G1 cross-substrate refusal: if a mutate's single-frame entries span more
 *     than one substrate, the engine returns `cross_tx_scope_refused` and
 *     calls NO resolvers. Namespaces sharing a substrate share one tx.
 *   - Shape is derived from the resolver's return: `Row[]` → `'list'`, single
 *     `Row` → `'single'`.
 */

import { getExtensionOperator, listExtensionOperators } from '@mnmal-ai/substrate-filter';
import type {
  ActHandle,
  ActInput,
  ActionLayer,
  ActorIdentity,
  ActResponse,
  ActResultRecord,
  BridgeRegistry,
  Dataset,
  DatasetRegistry,
  DropParticipant,
  EdgesStore,
  EngineInput,
  FrameEntry,
  Identity,
  PackEnvelope,
  PolicyDecision,
  PolicyProbeContext,
  QualifiedFrame,
  RegistryEntry,
  Registry as RegistryInterface,
  ResolverArgs,
  Schema,
  SweepDeps,
  WriteEvent
} from '@mnmal-ai/substrate-types';
import { DEFAULT_FILTER_WRITE_LIMITS } from '@mnmal-ai/substrate-types';
import { applyLostNamespace } from '../apply-lost-namespace.js';
import { MemoryActResultStore } from '../memory-act-result-store.js';
import { Registry } from '../registry.js';
import { ActSubsystem } from './act.js';
import { ArrayDispatch } from './batch.js';
import { BridgeSubsystem } from './bridge.js';
import { CommittedWritesQueue } from './committed-writes.js';
import { EntryGate } from './entry-gate.js';
import { EntryRunner } from './entry-run.js';
import {
  addError,
  buildContext,
  buildParsedKeyCache,
  DEFAULT_IDEMPOTENCY_TTL_MS,
  DEFAULT_SUBSCRIPTION_QUEUE_LIMIT,
  type EngineOptions,
  type MetricFn,
  type NamespaceConfig,
  NO_BRIDGES,
  type ParsedKey,
  readsEveryNamespace,
  type StreamHandle,
  type StreamInput,
  type SubscribeInput,
  type SubscriptionHandle,
  type SubscriptionStatsSnapshot
} from './internals.js';
import { LocalTx } from './local-tx.js';
import { MutateDispatch } from './mutate-dispatch.js';
import { applyPageLimits } from './page-limits.js';
import { SchemaSubsystem } from './schema.js';
import { StreamSubsystem } from './stream.js';
import { SubscribeSubsystem } from './subscribe.js';
import { EngineWalks } from './walks.js';

/** Local query keys dispatched at once; the rest wait for a free slot. */
const QUERY_KEY_CONCURRENCY = 16;

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

export class Engine implements ActHandle {
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
  readonly #committed: CommittedWritesQueue;
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
  #actionLayer: ActionLayer | undefined;
  /**
   * Live subscription subsystem (§5.4, §5.13). Owns the subscription bus, the
   * back-pressure queue, and the WriteEvent fanout. The mutate path calls
   * `this.#subscribe.dispatchWrites(events)` after the write events; everything
   * else lives behind the subsystem's surface.
   */
  readonly #subscribe: SubscribeSubsystem;
  /** Stream subsystem (§5.5); the public `stream()` delegates here. */
  readonly #stream: StreamSubsystem;
  /** Bridge-proxy subsystem (§5.8 / §6.5) for bridged query/mutate buckets. */
  readonly #bridgeProxy: BridgeSubsystem;
  /** Grant, policy and walk decisions for every frame entry and policy probe. */
  readonly #gate: EntryGate;
  readonly #runner: EntryRunner;
  readonly #mutation: MutateDispatch;
  readonly #acts: ActSubsystem;

  constructor(opts: EngineOptions) {
    this.#namespaces = opts.namespaces;
    this.#datasets = opts.datasets;
    this.#edges = opts.edges;
    this.#metric = opts.metric ?? ((): void => {});
    this.#committed = new CommittedWritesQueue(opts.committedWritesHooks ?? [], this.#metric);
    const idempotency =
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
      isTombstoned: (ns: string): boolean => this.#tombstoned.has(ns),
      coinedFor: (ns) => this.#actionLayer?.published(ns)
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
    const walks = new EngineWalks({
      datasets: this.#datasets,
      metric: this.#metric,
      schemaFor: (ns: string): Schema => this.schemaFor(ns)
    });
    this.#gate = new EntryGate({
      namespaces: this.#namespaces,
      tombstoned: this.#tombstoned,
      datasets: this.#datasets,
      edges: this.#edges,
      bridges: this.#bridges,
      metric: this.#metric,
      schema: this.#schema,
      walks,
      filterWriteLimits: opts.filterWriteLimits ?? DEFAULT_FILTER_WRITE_LIMITS,
      isStoredEntry: opts.isStoredEntry ?? ((): boolean => false),
      isLive: (ns: string): boolean => this.#isLive(ns),
      typeEntry: (ns, type) => this.typeEntry(ns, type)
    });
    this.#runner = new EntryRunner({
      namespaces: this.#namespaces,
      metric: this.#metric,
      gate: this.#gate,
      walks,
      onResolve: opts.onResolve,
      shapeRecorder: opts.shapeRecorder
    });
    const tx = new LocalTx({ edges: this.#edges, metric: this.#metric });
    const makeEnvelope = (keys: string[], parsedByKey: Map<string, ParsedKey | null>) =>
      this.#makeEnvelope(keys, parsedByKey);
    this.#mutation = new MutateDispatch({
      namespaces: this.#namespaces,
      datasets: this.#datasets,
      bridges: this.#bridges,
      metric: this.#metric,
      gate: this.#gate,
      runner: this.#runner,
      arrays: new ArrayDispatch({
        namespaces: this.#namespaces,
        tombstoned: this.#tombstoned,
        datasets: this.#datasets,
        metric: this.#metric,
        gate: this.#gate,
        runner: this.#runner,
        tx,
        idempotency,
        onResolve: opts.onResolve
      }),
      tx,
      bridgeProxy: this.#bridgeProxy,
      committed: this.#committed,
      subscribe: this.#subscribe,
      idempotency,
      makeEnvelope
    });
    this.#acts = new ActSubsystem({
      namespaces: this.#namespaces,
      datasets: this.#datasets,
      metric: this.#metric,
      schema: this.#schema,
      runner: this.#runner,
      tx,
      committed: this.#committed,
      subscribe: this.#subscribe,
      act: {
        results: opts.act?.results ?? new MemoryActResultStore(),
        ttlMs: opts.act?.resultTtlMs ?? 86_400_000,
        maxWriteSteps: opts.act?.maxWriteSteps ?? 50
      },
      actionLayer: () => this.#actionLayer,
      makeEnvelope
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

  /** The entry of `type`, a type registered in the live namespace `ns`, else undefined. */
  typeEntry(ns: string, type: string): RegistryEntry | undefined {
    if (!this.#isLive(ns)) return undefined;
    const entry = this.#namespaces.get(ns)?.registry.get(type);
    return entry?.kind === 'type' ? entry : undefined;
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

  setActionLayer(layer: ActionLayer): void {
    if (this.#actionLayer !== undefined) throw new Error('an action layer is already installed');
    this.#actionLayer = layer;
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
    return this.#gate.evaluateEntryPolicy(ns, type, identity, 'mutate', probe, 'update');
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
    probe?: PolicyProbeContext,
    args?: ResolverArgs
  ): PolicyDecision {
    return this.#gate.evaluateEntryPolicy(ns, type, identity, 'query', probe, undefined, args);
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
    const parsedByKey = buildParsedKeyCache(keys);
    const envelope = this.#makeEnvelope(keys, parsedByKey);
    if (keys.length === 0) return envelope;

    const ctx = buildContext(input.ctx, 'query');
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
        if (this.#gate.refuseUngranted(envelope, key, parsed.ns, ctx.identity, 'query')) continue;
        // The peer answers under the bridge's credential, so a walk is forwarded
        // only when every namespace it reaches is one this caller may read.
        if (
          !readsEveryNamespace(ctx.identity) &&
          !this.#gate.bridgedWalksReadable(parsed.ns, parsed.name, entry, ctx.identity)
        ) {
          addError(
            envelope,
            [key],
            `a walk in a bridged query reaches a namespace this grant does not cover, or one that cannot be resolved (op-key '${key}')`,
            'bridge_walk_refused'
          );
          this.#metric('engine_bridge_walk_refused', { key });
          continue;
        }
        let bucket = bridgeBuckets.get(parsed.ns);
        if (bucket === undefined) {
          bucket = {};
          bridgeBuckets.set(parsed.ns, bucket);
        }
        bucket[key] = entry;
        continue;
      }
      const paged = applyPageLimits(
        this.#namespaces,
        envelope,
        key,
        entry,
        parsed,
        input.pageLimits
      );
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
        await this.#runner.runEntry(
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
    return this.#mutation.mutate(input);
  }

  /**
   * Runs a sketch as the caller: compiled against the schema the caller can
   * read, every step through `runEntry` in one transaction, write hooks on
   * commit only, and a result record only the caller can read.
   */
  async act(input: ActInput): Promise<ActResponse> {
    return this.#acts.act(input);
  }

  async actResult(id: string, identity: Identity | null): Promise<ActResultRecord | undefined> {
    return this.#acts.actResult(id, identity);
  }

  #makeEnvelope(keys: string[], parsedByKey: Map<string, ParsedKey | null>): PackEnvelope {
    // Single-ns frames use the per-ns schemaVersion (the common case); multi-ns
    // frames use the federated version so the client can detect drift on any
    // of the referenced namespaces. Empty frames use the federated version —
    // matches the "I queried no types, tell me what you look like" shape.
    // A frame whose walk leaves its namespace moves to the federated version
    // once the walk passes its gate (`#refuseWalkPolicy`).
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

  /**
   * Register a subscription (§5.4) by delegating to the SubscribeSubsystem.
   * The subsystem owns the bus, the back-pressure queue, and the WriteEvent
   * fanout — see subscribe.ts for the full contract.
   */
  async subscribe(input: SubscribeInput): Promise<SubscriptionHandle> {
    return this.#subscribe.subscribe(input);
  }

  /**
   * Announce writes committed outside `mutate` (a server-internal writer): they
   * reach subscribers, then the coordinators' `onCommittedWrites` hooks, as a
   * commit through `mutate` would. This is not a transaction and checks
   * nothing: the caller guarantees `events` are already committed.
   */
  announceWrites(events: readonly WriteEvent[], actor: ActorIdentity | null): Promise<void> {
    this.#subscribe.dispatchWrites(events);
    this.#committed.queue(events, actor);
    return Promise.resolve();
  }

  /** Resolves once every post-write hook call queued so far has finished. */
  hooksSettled(): Promise<void> {
    return this.#committed.settled();
  }

  /** The last failure per plugin whose post-write hook has not succeeded since. */
  postWriteWarnings(): string[] {
    return this.#committed.warnings();
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
