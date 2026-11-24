/**
 * Runs a mutate frame: the idempotency lookup, the split between bridged and
 * local keys, the shared transaction of the single-frame keys, each batched
 * array after it, and the write events each commit announces.
 */

import type {
  AfterTxWork,
  BridgeRegistry,
  Dataset,
  DatasetRegistry,
  EdgesStore,
  EngineInput,
  FrameEntry,
  IdempotencyStore,
  Identity,
  PackEnvelope,
  QualifiedFrame,
  RequestContext,
  WriteEvent
} from '@mnmal-ai/substrate-types';
import type { ArrayDispatch } from './batch.js';
import type { BridgeSubsystem } from './bridge.js';
import { actorOf, type CommittedWritesQueue } from './committed-writes.js';
import type { EntryGate } from './entry-gate.js';
import type { EntryRunner } from './entry-run.js';
import {
  addError,
  addTopLevelError,
  batchedInFlightKey,
  buildContext,
  buildParsedKeyCache,
  callerDedupComponent,
  checkIdentityGrant,
  type MetricFn,
  makeDedupKey,
  type NamespaceConfig,
  type ParsedKey,
  scopeBridgeIdempotency
} from './internals.js';
import type { LocalTx } from './local-tx.js';
import {
  type LocalTxScopePartition,
  partitionMutateByRoute,
  partitionMutateByShape,
  partitionMutateByTxScope
} from './mutate.js';
import type { SubscribeSubsystem } from './subscribe.js';

/** Unwinds the shared single-frame tx; the refusing entry's error is already on the envelope. */
class SharedTxRefusal extends Error {
  override readonly name = 'SharedTxRefusal';
}

export interface MutateDispatchDeps {
  namespaces: Map<string, NamespaceConfig>;
  datasets: DatasetRegistry;
  bridges: BridgeRegistry;
  metric: MetricFn;
  gate: EntryGate;
  runner: EntryRunner;
  arrays: ArrayDispatch;
  tx: LocalTx;
  bridgeProxy: BridgeSubsystem;
  committed: CommittedWritesQueue;
  subscribe: SubscribeSubsystem;
  idempotency: { store: IdempotencyStore; defaultTtlMs: number } | undefined;
  makeEnvelope: (
    keys: string[],
    parsedByKey: Map<string, ParsedKey | null>,
    identity?: Identity | null
  ) => PackEnvelope;
}

export class MutateDispatch {
  readonly #namespaces: Map<string, NamespaceConfig>;
  readonly #datasets: DatasetRegistry;
  readonly #bridges: BridgeRegistry;
  readonly #metric: MetricFn;
  readonly #gate: EntryGate;
  readonly #runner: EntryRunner;
  readonly #arrays: ArrayDispatch;
  readonly #tx: LocalTx;
  readonly #bridgeProxy: BridgeSubsystem;
  readonly #committed: CommittedWritesQueue;
  readonly #subscribe: SubscribeSubsystem;
  readonly #idempotency: { store: IdempotencyStore; defaultTtlMs: number } | undefined;
  readonly #makeEnvelope: MutateDispatchDeps['makeEnvelope'];
  /**
   * Mutates under a dedup key that are still running. The store only sees a
   * key once the first call finishes, so a retry arriving meanwhile joins this
   * promise instead of writing again. Per process: a store shared across
   * processes still admits concurrent duplicates.
   */
  readonly #inFlightMutates = new Map<string, Promise<PackEnvelope>>();

  constructor(deps: MutateDispatchDeps) {
    this.#namespaces = deps.namespaces;
    this.#datasets = deps.datasets;
    this.#bridges = deps.bridges;
    this.#metric = deps.metric;
    this.#gate = deps.gate;
    this.#runner = deps.runner;
    this.#arrays = deps.arrays;
    this.#tx = deps.tx;
    this.#bridgeProxy = deps.bridgeProxy;
    this.#committed = deps.committed;
    this.#subscribe = deps.subscribe;
    this.#idempotency = deps.idempotency;
    this.#makeEnvelope = deps.makeEnvelope;
  }

  /** Runs a mutate frame; `Engine.mutate` states the contract. */
  async mutate(input: EngineInput): Promise<PackEnvelope> {
    const keys = Object.keys(input.frame);
    // Pre-parse every key once; everything downstream reads from this map.
    const parsedByKey = buildParsedKeyCache(keys);
    const envelope = this.#makeEnvelope(keys, parsedByKey, input.ctx.identity);
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
          this.#gate.refuseUngranted(envelope, key, ns, input.ctx.identity ?? null, 'mutate'),
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

    const ctx = buildContext(input.ctx, 'mutate');
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
    // `args.onWrite`; a rolled-back tx's events never reach it.
    const writeBatch: WriteEvent[] = [];
    const onWrite = (event: WriteEvent): void => {
      writeBatch.push(event);
    };

    // Subscribers and hooks hear each commit (the single-frame bucket, then each
    // array key) as it lands: in commit order, and a later throw cannot lose an
    // earlier commit. Dispatch is enqueue-only, so a slow consumer cannot stall it.
    const hooked = this.#committed.active;
    const actor = hooked ? actorOf(identity) : null;
    let announced = 0;
    const commit = (): void => {
      const events = writeBatch.slice(announced);
      this.#subscribe.dispatchWrites(events);
      if (hooked) this.#committed.queue(events, actor);
      announced = writeBatch.length;
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
    commit();

    // Batched op-keys: one isolated tx per array (§5.13). Each array commits
    // or rolls back independently of every other op-key and of the single-
    // frame bucket. A throw in array[i] rolls back that array's tx only;
    // prior array op-keys keep their commits, the single-frame bucket keeps
    // its commit (if it already resolved), and later array op-keys still run.
    for (const key of nonEmptyArrayKeys) {
      const frames = input.frame[key] as Array<FrameEntry>;
      await this.#arrays.runArrayEntry(
        envelope,
        key,
        parsedByKey.get(key) ?? null,
        frames,
        ctx,
        onWrite,
        signal
      );
      commit();
    }

    await Promise.all(bridgePromises);

    return this.#finaliseMutateEnvelope(envelope, keys, idempotencyResolution, callerKey);
  }

  /**
   * Dispatch the single-frame G1 bucket (§5.3). Branches on the substrate
   * partition shape:
   *
   *   - `zero_datasets`: no singleFrame key resolved to a dataset. Run each
   *     through `runEntry` with no tx. Two legitimate populations land here:
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
        await this.#runner.runEntry(
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
        const thrown = await this.#runner.runEntry(
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
      const scopeRefusal = await this.#tx.inLocalTx(partition, runBody);
      if (scopeRefusal !== undefined) {
        addTopLevelError(envelope, scopeRefusal, 'cross_tx_scope_refused');
        return;
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
      await this.#tx.runSettled(settled, committed);
    }
    for (const event of pending) onWrite(event);
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
}
