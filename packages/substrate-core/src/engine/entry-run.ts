/**
 * Runs one frame entry once the gate has passed it: calls the resolver, pages
 * past rows a row filter hides, records the read's shape and plan, and shapes
 * the result into the envelope.
 */

import type {
  AfterTxWork,
  Dataset,
  EdgesStore,
  FrameEntry,
  PackEnvelope,
  ReadResult,
  RequestContext,
  ResolveObservation,
  Row,
  WriteEvent
} from '@mnmal-ai/substrate-types';
import { isResolverFrameError, isRestrictViolation } from '@mnmal-ai/substrate-types';
import { readShapeOf, walkShapesOf } from '../advisor/shape-recorder.js';
import { applyObligations } from '../policy-evaluator.js';
import type { EntryGate } from './entry-gate.js';
import {
  addError,
  type EngineOptions,
  isReadResult,
  type MetricFn,
  type NamespaceConfig,
  type ParsedKey
} from './internals.js';
import { resolverFiltered, shapeResult } from './result-shape.js';
import type { EngineWalks } from './walks.js';

/** `runEntry`'s parameters after `(envelope, key)`. */
export type RunEntryRest = [
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

/** Rows a row-filtered page scans before it stops and hands back a cursor. */
const ROW_FILTER_SCAN_ROWS = 5000;
/** Rows it reads at a time while it looks past hidden ones. */
const ROW_FILTER_CHUNK = 200;

/** Hand `o` to the resolve hook; a metrics sink must never change what the caller gets. */
export function observe(hook: (o: ResolveObservation) => void, o: ResolveObservation): void {
  try {
    const ret: unknown = hook(o);
    // An async hook's rejection must not become an unhandled rejection.
    if (typeof (ret as PromiseLike<unknown> | undefined)?.then === 'function') {
      Promise.resolve(ret).catch(() => {});
    }
  } catch {
    // Swallowed: see above.
  }
}

export interface EntryRunnerDeps {
  namespaces: Map<string, NamespaceConfig>;
  metric: MetricFn;
  gate: EntryGate;
  walks: EngineWalks;
  onResolve: ((o: ResolveObservation) => void) | undefined;
  shapeRecorder: EngineOptions['shapeRecorder'];
}

export class EntryRunner {
  readonly #namespaces: Map<string, NamespaceConfig>;
  readonly #metric: MetricFn;
  readonly #gate: EntryGate;
  readonly #walks: EngineWalks;
  readonly #onResolve: ((o: ResolveObservation) => void) | undefined;
  readonly #shapeRecorder: EngineOptions['shapeRecorder'];

  constructor(deps: EntryRunnerDeps) {
    this.#namespaces = deps.namespaces;
    this.#metric = deps.metric;
    this.#gate = deps.gate;
    this.#walks = deps.walks;
    this.#onResolve = deps.onResolve;
    this.#shapeRecorder = deps.shapeRecorder;
  }

  /** Resolves true when the resolver refused with a `ResolverFrameError`. */
  async runEntry(envelope: PackEnvelope, key: string, ...rest: RunEntryRest): Promise<boolean> {
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
    const emit = (o: Omit<ResolveObservation, 'key' | 'kind' | 'durationMs' | 'caller'>): void =>
      observe(hook, {
        key: obsKey,
        kind,
        durationMs: performance.now() - t0,
        ...caller,
        ...o
      });
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
    const prepared = this.#gate.prepareEntry(
      envelope,
      key,
      entry,
      ctxBase,
      operation,
      tx,
      txEdges,
      parsed,
      onWrite,
      signal,
      afterTx,
      txEntries
    );
    if (prepared === null) return false;
    const { registryEntry, frame, ctx, args, decision, ns, name, isVirtual, dataset, walkScan } =
      prepared;
    // A throw here propagates out of the surrounding withTransaction (on
    // mutate) and rolls back every prior frame entry — the G1 contract.
    // Exception: `RestrictViolation` (§6.2) is a clean refusal, NOT a rollback
    // trigger. The target row was never tombstoned; other frame entries retain
    // their own work. We surface it in envelope.errors with a dedicated code so
    // callers can distinguish "your delete was blocked by an edge" from a
    // substrate failure.
    let result: Row | Row[] | ReadResult | AsyncIterable<Row> | null;
    const t0 = performance.now();
    try {
      result = await registryEntry.resolver(ctx, args);
      if (
        operation === 'query' &&
        (decision.obligations?.length ?? 0) > 0 &&
        isReadResult(result) &&
        result.count === undefined &&
        result.groups === undefined
      ) {
        result = await this.#fillFilteredPage(
          result,
          (cursor, limit) =>
            registryEntry.resolver(ctx, { ...args, params: { ...args.params, cursor, limit } }),
          (rows) => applyObligations(decision, rows, ctx),
          args.params?.limit
        );
      }
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
        const ms = performance.now() - t0;
        this.#shapeRecorder?.observe(
          readShapeOf(ns, name, registryEntry.fields, args.params?.where, args.params?.orderBy),
          ms
        );
        // Each walk is charged the whole read's time: the far reads run inside it.
        if (walkScan !== undefined && this.#shapeRecorder !== undefined) {
          for (const s of walkShapesOf(walkScan.sites, walkScan.fieldsOf)) {
            this.#shapeRecorder.observe(s, ms);
          }
        }
      }
    }

    if (walkScan !== undefined && dataset !== undefined) {
      const plan = await this.#walks.walkPlan(dataset, key, frame, ns, name, walkScan);
      if (plan !== undefined) {
        envelope._diagnostics ??= {};
        envelope._diagnostics[key] = { ...(envelope._diagnostics[key] ?? {}), plan };
      }
    }

    shapeResult({
      envelope,
      key,
      entry: frame,
      ctx,
      decision,
      result,
      metric: this.#metric,
      resolverFiltered: resolverFiltered(registryEntry)
    });
    return false;
  }

  /**
   * A row-filtered page, built so that what it says about the rows after it
   * depends only on rows the caller may see. Reads on past hidden rows, a
   * chunk at a time, until the page holds `limit` visible ones and one more
   * has been seen: that one is what `hasMore` reports, and the next page
   * starts just before it.
   */
  async #fillFilteredPage(
    first: ReadResult,
    read: (cursor: string, limit: number) => unknown,
    visible: (rows: Row[]) => Row[],
    limit: unknown
  ): Promise<ReadResult> {
    const want = typeof limit === 'number' && limit > 0 ? limit : Math.max(first.rows.length, 1);
    // shortcut: scans at most ROW_FILTER_SCAN_ROWS rows per read (ten pages' worth if that is more), then answers hasMore with a cursor so the caller pages on; a longer run of hidden rows still shows as empty pages, raise it if callers meet them.
    const budget = Math.max(ROW_FILTER_SCAN_ROWS, 10 * (want + 1));
    const after = (r: ReadResult) => (r.hasMore ? r.nextCursor : undefined);
    const page = async (cursor: string, n: number): Promise<ReadResult> => {
      const r = await read(cursor, n);
      return isReadResult(r) ? r : { rows: [], hasMore: false };
    };
    const rows = visible(first.rows);
    let scanned = first.rows.length;
    // Where the unread rows start; undefined at the end of the data.
    let cursor = after(first);

    while (cursor !== undefined && scanned < budget) {
      const from = cursor;
      const need = want - rows.length;
      const chunk = await page(from, Math.max(need, ROW_FILTER_CHUNK));
      scanned += chunk.rows.length;
      const seen = visible(chunk.rows);
      if (seen.length <= need && need > 0) {
        rows.push(...seen);
        cursor = after(chunk);
        continue;
      }
      if (seen.length === 0) {
        cursor = after(chunk);
        continue;
      }
      // A visible row past the page: the next page starts before it.
      if (need === 0) return { rows, hasMore: true, nextCursor: from };
      // The chunk holds more visible rows than the page lacks. Keep those it
      // lacks, and re-read up to the last one kept for the cursor that ends there.
      const kept = new Set(seen.slice(0, need));
      const last = chunk.rows.findLastIndex((r) => kept.has(r));
      rows.push(...seen.slice(0, need));
      const end = after(await page(from, last + 1));
      return {
        rows,
        hasMore: end !== undefined,
        ...(end !== undefined ? { nextCursor: end } : {})
      };
    }
    // Out of budget with rows unread: the caller pages on from where the scan stopped.
    return cursor === undefined
      ? { rows, hasMore: false }
      : { rows, hasMore: true, nextCursor: cursor };
  }
}
