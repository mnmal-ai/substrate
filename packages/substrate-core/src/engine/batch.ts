/**
 * Batched mutate: an array of frames under one op-key, run in one transaction
 * of its own, through a batch resolver where the entry has one and element by
 * element otherwise.
 */

import type {
  AfterTxWork,
  BatchResolver,
  Dataset,
  DatasetRegistry,
  EdgesStore,
  FrameEntry,
  IdempotencyStore,
  PackEnvelope,
  RequestContext,
  ResolveObservation,
  Row,
  WriteEvent
} from '@mnmal-ai/substrate-types';
import {
  BatchElementError,
  isBatchElementError,
  isResolverFrameError,
  isRestrictViolation
} from '@mnmal-ai/substrate-types';
import type { EntryGate, PreparedEntry } from './entry-gate.js';
import { type EntryRunner, observe } from './entry-run.js';
import {
  addError,
  callerDedupComponent,
  type MetricFn,
  makeArrayDedupKey,
  type NamespaceConfig,
  type ParsedKey
} from './internals.js';
import type { LocalTx } from './local-tx.js';
import { resolverFiltered, shapeResult } from './result-shape.js';

/**
 * Unwinds a batched-array transaction for a frame that refused via the
 * envelope rather than by throwing.
 *
 * `runEntry` records a `ResolverFrameError` on the envelope and returns
 * normally, which inside `runArrayEntry`'s transaction would otherwise read as
 * success and commit the earlier frames. Carries the original errors so their
 * client-branchable codes survive the rollback.
 */
class BatchedFrameRefusal extends Error {
  override readonly name = 'BatchedFrameRefusal';
  constructor(readonly frameErrors: FrameErrors) {
    super(frameErrors[0]?.message ?? 'batched frame refused');
  }
}

type FrameErrors = Array<{ message: string; path?: string[]; code?: string }>;

/**
 * A batch resolver refused with a frame error that names no element (on pg, a
 * `unique_violation` from its set-wise write). `runArrayEntry` rolls the
 * attempt back and re-runs the array per element to find the element and the
 * envelope sequential dispatch gives.
 */
class BatchRefusalWithoutIndex extends Error {
  override readonly name = 'BatchRefusalWithoutIndex';
  constructor(override readonly cause: Error) {
    super(cause.message);
  }
}

/** One element of a mutate array before the tx: a cached replay, or a slot to run. */
interface ArraySlot {
  cached: boolean;
  data?: unknown;
  shape?: 'single' | 'list';
  dedupKey?: string;
  errors?: FrameErrors;
}

/** What one array element left under `key` in its scratch envelope. */
interface SlotResult {
  data?: unknown;
  shape?: 'single' | 'list';
  errors?: FrameErrors;
}

function slotResultOf(scratch: PackEnvelope, key: string): SlotResult {
  const entry: SlotResult = {};
  if (key in scratch.data) entry.data = scratch.data[key];
  const shape = scratch.shapes[key];
  // A mutate frame is rows; only a read is shaped `count` or `groups`.
  if (shape === 'single' || shape === 'list') entry.shape = shape;
  if (scratch.errors !== undefined && scratch.errors.length > 0) entry.errors = scratch.errors;
  return entry;
}

function cachedSlotResult(slot: ArraySlot): SlotResult {
  return {
    ...(slot.data !== undefined ? { data: slot.data } : {}),
    ...(slot.shape !== undefined ? { shape: slot.shape } : {}),
    ...(slot.errors !== undefined ? { errors: slot.errors } : {})
  };
}

export interface ArrayDispatchDeps {
  namespaces: Map<string, NamespaceConfig>;
  tombstoned: ReadonlySet<string>;
  datasets: DatasetRegistry;
  metric: MetricFn;
  gate: EntryGate;
  runner: EntryRunner;
  tx: LocalTx;
  idempotency: { store: IdempotencyStore; defaultTtlMs: number } | undefined;
  onResolve: ((o: ResolveObservation) => void) | undefined;
}

export class ArrayDispatch {
  readonly #namespaces: Map<string, NamespaceConfig>;
  readonly #tombstoned: ReadonlySet<string>;
  readonly #datasets: DatasetRegistry;
  readonly #metric: MetricFn;
  readonly #gate: EntryGate;
  readonly #runner: EntryRunner;
  readonly #tx: LocalTx;
  readonly #idempotency: { store: IdempotencyStore; defaultTtlMs: number } | undefined;
  readonly #onResolve: ((o: ResolveObservation) => void) | undefined;

  constructor(deps: ArrayDispatchDeps) {
    this.#namespaces = deps.namespaces;
    this.#tombstoned = deps.tombstoned;
    this.#datasets = deps.datasets;
    this.#metric = deps.metric;
    this.#gate = deps.gate;
    this.#runner = deps.runner;
    this.#tx = deps.tx;
    this.#idempotency = deps.idempotency;
    this.#onResolve = deps.onResolve;
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
   *     one element per frame (the value `runEntry` would have written
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
  async runArrayEntry(
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
        this.#gate.unqualifiedMessage(key, ctxBase.identity),
        'unqualified_key'
      );
      this.#metric('engine_unqualified_key', key);
      return;
    }
    const { ns } = parsed;

    // Array form is mutate-only by construction — `runArrayEntry` is reached
    // solely from the mutate path.
    if (this.#gate.refuseUngranted(envelope, key, ns, ctxBase.identity, 'mutate')) return;

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
    // Fan out the pre-flight idempotency `.get()` lookups in one await; `get`
    // is read-only and per-key isolated, so ordering doesn't matter.
    const slots: ArraySlot[] = new Array(frames.length);
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
        const slot: ArraySlot = { cached: true, data: cached.data[key] };
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
    let arrayWriteBatch: WriteEvent[] = [];
    const arrayOnWrite = (event: WriteEvent): void => {
      arrayWriteBatch.push(event);
    };

    // Scratch envelope per frame: runEntry writes data/shape/errors keyed
    // by the qualified key. Collecting them one-at-a-time lets us assemble
    // the Array<slot> at the end.
    let scratchResults: SlotResult[] = new Array(frames.length);
    // A batch resolver takes the uncached elements in one call (Task 4).
    const batch = nsCfg.registry.get(parsed.name)?.batch;

    /** One attempt in its own transaction: `batch` once, or the per-element loop. */
    const attempt = async (
      useBatch: boolean
    ): Promise<{ frameError: Error | undefined; failedIndex: number | undefined }> => {
      let failedIndex: number | undefined;
      let frameError: Error | undefined;
      const settled: AfterTxWork[] = [];
      try {
        await this.#tx.withRowsAndEdgesTx(dataset, ns, async (txDs, txEdges) => {
          if (useBatch && batch !== undefined) {
            await this.#runBatch(
              batch,
              key,
              parsed,
              frames,
              slots,
              scratchResults,
              ctxBase,
              txDs,
              txEdges,
              arrayOnWrite,
              signal,
              (fn) => settled.push(fn),
              envelope.schemaVersion
            );
            return;
          }
          for (let i = 0; i < frames.length; i++) {
            const slot = slots[i] as ArraySlot;
            if (slot.cached) {
              scratchResults[i] = cachedSlotResult(slot);
              continue;
            }
            const frame = frames[i] as FrameEntry;
            const scratch: PackEnvelope = {
              schemaVersion: envelope.schemaVersion,
              data: {},
              shapes: {}
            };
            failedIndex = i;
            await this.#runner.runEntry(
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
            const entry = slotResultOf(scratch, key);
            scratchResults[i] = entry;
            if (entry.errors !== undefined) {
              // An array under one op-key is ONE transaction: a frame that
              // refused via the envelope must unwind it just like one that
              // threw, or the frames before it commit.
              failedIndex = i;
              throw new BatchedFrameRefusal(entry.errors);
            }
          }
        });
      } catch (err) {
        let thrown: unknown = err;
        // #runBatch names the refusing slot this way; a per-element resolver never does.
        if (useBatch && isBatchElementError(err)) {
          failedIndex = err.index;
          thrown = err.cause;
        }
        frameError = thrown instanceof Error ? thrown : new Error(String(thrown));
      }
      await this.#tx.runSettled(settled, frameError === undefined);
      return { frameError, failedIndex };
    };

    let { frameError, failedIndex } = await attempt(batch !== undefined);
    if (frameError instanceof BatchRefusalWithoutIndex) {
      // The first attempt rolled back and its settled work ran uncommitted.
      // Its one failed observation stands, since that call really failed; the
      // re-run reports per element. At most one re-run: the loop never calls `batch`.
      arrayWriteBatch = [];
      scratchResults = new Array(frames.length);
      ({ frameError, failedIndex } = await attempt(false));
    }

    if (frameError !== undefined) {
      // Whole-array rollback. `failedIndex` (set just before each `runEntry`)
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
    // (mirrors the frame-level "errors → no cache" rule). The array's
    // events reach the parent batch below. The puts run in parallel; the store is per-key isolated.
    if (this.#idempotency !== undefined) {
      const puts: Array<Promise<void>> = [];
      for (let i = 0; i < frames.length; i++) {
        const slot = slots[i] as ArraySlot;
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

    // Hand the committed array's events to the parent batch; the mutate pushes
    // them as soon as this array returns.
    for (const event of arrayWriteBatch) {
      onWrite(event);
    }
  }

  /**
   * The batch branch of `runArrayEntry`, inside its transaction. Prepares
   * every uncached element as `#runEntryInner` would, calls `batch` once with
   * their args in slot order, then shapes each result under its own frame and
   * decision. A refusal at slot `i` throws `BatchElementError(i, …)` with a
   * `BatchedFrameRefusal` carrying the element's own errors, or the raw cause
   * when it is not a frame refusal; `runArrayEntry` unwraps it into today's
   * rollback envelope. Cached slots are filled and skipped; when every slot is
   * cached, `batch` is not called.
   */
  async #runBatch(
    batch: BatchResolver,
    key: string,
    parsed: ParsedKey,
    frames: Array<FrameEntry>,
    slots: readonly ArraySlot[],
    results: SlotResult[],
    ctxBase: Omit<RequestContext, 'namespace'>,
    txDs: Dataset,
    txEdges: EdgesStore,
    onWrite: (event: WriteEvent) => void,
    signal: AbortSignal | undefined,
    afterTx: (fn: AfterTxWork) => void,
    schemaVersion: string
  ): Promise<void> {
    const hook = this.#onResolve;
    const callerId = ctxBase.identity?.id;
    const t0 = performance.now();
    // Set once the batch is called; until then an observation is per element.
    let batchSize = 0;
    const report = (
      ok: boolean,
      durationMs: number,
      batchIndex: number | undefined,
      err?: { code?: string; message: string }
    ) => {
      if (hook === undefined) return;
      observe(hook, {
        key,
        kind: 'mutate',
        durationMs,
        ok,
        ...(batchIndex !== undefined ? { batchSize, batchIndex } : {}),
        ...(callerId !== undefined ? { caller: callerId } : {}),
        ...(err?.code !== undefined ? { code: err.code } : {}),
        ...(err !== undefined ? { message: err.message } : {})
      });
    };

    const at: number[] = [];
    const prepared: PreparedEntry[] = [];
    for (let i = 0; i < frames.length; i++) {
      const slot = slots[i] as ArraySlot;
      if (slot.cached) {
        results[i] = cachedSlotResult(slot);
        continue;
      }
      const scratch: PackEnvelope = { schemaVersion, data: {}, shapes: {} };
      let p: PreparedEntry | null;
      try {
        p = this.#gate.prepareEntry(
          scratch,
          key,
          frames[i] as FrameEntry,
          ctxBase,
          'mutate',
          txDs,
          txEdges,
          parsed,
          onWrite,
          signal,
          afterTx,
          frames.length
        );
      } catch (err) {
        report(false, performance.now() - t0, undefined, {
          code: 'exception',
          message: err instanceof Error ? err.message : String(err)
        });
        throw new BatchElementError(i, err);
      }
      if (p === null) {
        const refused = slotResultOf(scratch, key);
        results[i] = refused;
        const errors = refused.errors ?? [];
        report(false, performance.now() - t0, undefined, errors[0]);
        throw new BatchElementError(i, new BatchedFrameRefusal(errors));
      }
      at.push(i);
      prepared.push(p);
    }
    if (prepared.length === 0) return;

    // Every observation of one batch carries the batch call's real time and
    // its size, so a consumer can tell an amortised call from a single one.
    const n = prepared.length;
    batchSize = n;
    const tb = performance.now();
    let rows: Array<Row | null>;
    try {
      rows = await batch(
        (prepared[0] as PreparedEntry).ctx,
        prepared.map((p) => p.args)
      );
    } catch (err) {
      const ms = performance.now() - tb;
      const slot = isBatchElementError(err) ? at[err.index] : undefined;
      if (!isBatchElementError(err) && (isResolverFrameError(err) || isRestrictViolation(err))) {
        // A refusal that names no element: runArrayEntry re-runs the array per element.
        report(false, ms, 0, {
          code: isRestrictViolation(err) ? 'restrict_violation' : err.code,
          message: err.message
        });
        throw new BatchRefusalWithoutIndex(err);
      }
      if (!isBatchElementError(err) || slot === undefined) {
        // Not attributable to one element: one observation for the batch,
        // reported as today's "internal error" at [key]. An out-of-range index
        // is one too, and must not be read back as a slot by the caller.
        const cause = isBatchElementError(err)
          ? new Error(`batch resolver for '${key}' refused element ${err.index} of ${n}`)
          : err;
        report(false, ms, 0, {
          code: 'exception',
          message: cause instanceof Error ? cause.message : String(cause)
        });
        throw cause;
      }
      const cause = err.cause;
      const refusal = this.#batchFrameRefusal(key, cause);
      // As the per-element loop reports: the elements before it resolved, then it refused.
      for (let j = 0; j < err.index; j++) report(true, ms, j);
      report(false, ms, err.index, {
        code: refusal?.frameErrors[0]?.code ?? 'exception',
        message: cause instanceof Error ? cause.message : String(cause)
      });
      throw new BatchElementError(slot, refusal ?? cause);
    }
    const ms = performance.now() - tb;
    if (!Array.isArray(rows) || rows.length !== n) {
      const wrong = new Error(
        `batch resolver for '${key}' returned ${Array.isArray(rows) ? rows.length : typeof rows} results for ${n} elements`
      );
      report(false, ms, 0, { code: 'exception', message: wrong.message });
      throw wrong;
    }

    for (let j = 0; j < n; j++) {
      const p = prepared[j] as PreparedEntry;
      const i = at[j] as number;
      const scratch: PackEnvelope = { schemaVersion, data: {}, shapes: {} };
      shapeResult({
        envelope: scratch,
        key,
        entry: p.frame,
        ctx: p.ctx,
        decision: p.decision,
        result: rows[j] ?? null,
        metric: this.#metric,
        resolverFiltered: resolverFiltered(p.registryEntry)
      });
      const shaped = slotResultOf(scratch, key);
      results[i] = shaped;
      if (shaped.errors !== undefined) {
        report(false, ms, j, shaped.errors[0]);
        throw new BatchElementError(i, new BatchedFrameRefusal(shaped.errors));
      }
      report(true, ms, j);
    }
  }

  /**
   * A batch's `ResolverFrameError` or `RestrictViolation` as the per-element
   * resolver catch records it: its own code at `[key]`, with the same metric.
   * Undefined for any other error.
   */
  #batchFrameRefusal(key: string, cause: unknown): BatchedFrameRefusal | undefined {
    if (isRestrictViolation(cause)) {
      this.#metric('engine_restrict_violation', { key, blockedBy: cause.blockedBy.length });
      return new BatchedFrameRefusal([
        { message: cause.message, path: [key], code: 'restrict_violation' }
      ]);
    }
    if (isResolverFrameError(cause)) {
      this.#metric('engine_resolver_frame_error', { key, code: cause.code });
      return new BatchedFrameRefusal([{ message: cause.message, path: [key], code: cause.code }]);
    }
    return undefined;
  }
}
