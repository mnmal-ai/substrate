/**
 * autoCRUD batch resolvers for `create<T>`, `update<T>` and `delete<T>` (#1814).
 *
 * A mutate array of one generated mutation calls its batch resolver once with
 * every element. The resolver does per-batch work, not per-row: validation in
 * JS, one resolution of the ids named, one existence read per crossRef target
 * type, then one statement per kind of write. The single-frame resolver is the
 * same batch resolver called with one element, so the per-element checks exist
 * once.
 *
 * Every slot answers as sequential dispatch would. Each element runs its checks
 * in the order the single resolver runs them, and a later check runs only on
 * the elements before the lowest refusal so far, so the refusal reported is the
 * one sequential dispatch meets first. It is thrown as
 * `BatchElementError(i, cause)`; the engine replays the cause's code at `[key]`
 * and reports `batched_frame_rolled_back` at `[key, i]`.
 *
 * An update or delete array that names one row twice runs each element alone,
 * in order, in the same transaction: the elements then depend on each other.
 */

import { applyRowFilters } from '@mnmal-ai/substrate-policy';
import type {
  ActorIdentity,
  BatchResolver,
  Dataset,
  EdgesStore,
  EdgeWriteInput,
  FieldDef,
  Id,
  Policy,
  RequestContext,
  ResolverArgs,
  Row,
  RowMetadata,
  TypedResolver,
  WriteRow
} from '@mnmal-ai/substrate-types';
import {
  BatchElementError,
  isBatchElementError,
  isRestrictViolation,
  ResolverFrameError
} from '@mnmal-ai/substrate-types';
import { deleteRows } from '../delete.js';
import type { PostWriteHook } from '../namespace.js';
import { resolveEntityRows } from '../short-id-resolver.js';
import { prepareCreateRow } from './autocrud-create.js';
import { type DeleteResolverResult, prepareDelete } from './autocrud-delete.js';
import { prepareUpdate, updateNotFound } from './autocrud-update.js';
import { syncCrossRefEdges } from './crossref-edge-sync.js';
import { assertCrossRefTargetsExistMany, collectCrossRefFields } from './crossref-existence.js';
import { coerceId, resolveIdentity } from './internal.js';

export interface BatchResolverOptions {
  /** The type's field definitions: validation, crossRefs and shortId allocation. */
  fields?: Record<string, FieldDef>;
  /** Update and delete: a row the policy's row filters hide answers as missing. */
  policy?: Policy;
  /** Create and update: runs per written row once the transaction commits. */
  postWrite?: PostWriteHook;
}

/** The single-frame resolver: `batch` with one element, its refusal unwrapped. */
export function singleFrame<T>(batch: BatchResolver): TypedResolver<T> {
  return async (ctx, args) => {
    try {
      return (await batch(ctx, [args]))[0] as T;
    } catch (err) {
      throw isBatchElementError(err) ? err.cause : err;
    }
  };
}

/**
 * The lowest refused element so far. Each phase runs only on the elements
 * before it, so a refusal found later at a lower index replaces it.
 */
class FirstRefusal {
  index: number;
  #cause: unknown;

  constructor(readonly size: number) {
    this.index = size;
  }

  live(i: number): boolean {
    return i < this.index;
  }

  refuse(i: number, cause: unknown): void {
    if (i >= this.index) return;
    this.index = i;
    this.#cause = cause;
  }

  /** Element `i`'s own check: whatever it throws refuses `i`. */
  check(i: number, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.refuse(i, err);
    }
  }

  /** A set-wise check names its element with `BatchElementError`; anything else fails the batch. */
  async capture(work: Promise<unknown>): Promise<void> {
    try {
      await work;
    } catch (err) {
      if (!isBatchElementError(err)) throw err;
      this.refuse(err.index, err.cause);
    }
  }

  throwIfRefused(): void {
    if (this.index < this.size) throw new BatchElementError(this.index, this.#cause);
  }
}

/** Each element alone, in order: the sequential answer, for elements that depend on each other. */
async function eachAlone(
  batch: BatchResolver,
  ctx: RequestContext,
  list: readonly ResolverArgs[]
): Promise<Array<Row | null>> {
  const out: Array<Row | null> = [];
  for (const [i, args] of list.entries()) {
    try {
      out.push((await batch(ctx, [args]))[0] ?? null);
    } catch (err) {
      throw new BatchElementError(i, isBatchElementError(err) ? err.cause : err);
    }
  }
  return out;
}

function namesARowTwice(rows: ReadonlyArray<Row | null>): boolean {
  // shortcut: keyed by String(id), so on memory a numeric 5 and a string '5'
  // count as one row, where sequential memory dispatch keeps them apart (pg
  // stores ids as text, so it agrees); key by type too if memory ever needs it.
  const seen = new Set<string>();
  for (const r of rows) {
    if (r === null) continue;
    const key = String(r.id);
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

/**
 * A row policy filters what a read returns, so on its own it would let an
 * update or delete reach a row the caller cannot read. Runs the policy's row
 * filters against each element's stored row (`stored[i]`, already read) and
 * returns which elements must answer as for a missing row.
 */
export function guardRowWrites(
  ctx: RequestContext,
  policy: Policy | undefined,
  list: readonly ResolverArgs[],
  stored: ReadonlyArray<Row | null>
): boolean[] {
  return list.map((args, i) => {
    if (policy === undefined || coerceId(args.params?.id) === undefined) return false;
    const decision = policy(ctx, args);
    if (decision.obligations === undefined || decision.obligations.length === 0) return false;
    const row = stored[i] ?? null;
    return row !== null && applyRowFilters(decision, [row], ctx).length === 0;
  });
}

/**
 * Runs `postWrite` once the engine transaction commits, on the row as
 * committed, so its side effects (embeddings, indexes) never describe a
 * rolled-back write or hold a connection across the transaction. A rolled-back
 * write skips it. Outside a transaction (no `afterTx`) it runs at once.
 */
export async function runPostWrite(
  postWrite: PostWriteHook,
  typeName: string,
  dataset: Dataset,
  row: Row,
  ctx: RequestContext,
  args: ResolverArgs
): Promise<void> {
  if (args.afterTx === undefined) {
    await postWrite(row, ctx);
    return;
  }
  args.afterTx(async (outcome) => {
    // shortcut: a commit whose reply was lost reads as a rollback, so its row
    // is never indexed until POST /substrate/v1/embed/reindex or
    // /substrate/v1/lexical/reindex runs; re-read by id after reconnect to
    // recover it automatically.
    if (!outcome.committed) return;
    const { rows } = await dataset.read(typeName, { id: row.id });
    const committed = rows[0];
    if (committed !== undefined) await postWrite(committed, ctx);
  });
}

/**
 * `create<T>` for many rows. Per element, as the single resolver: crossRef
 * targets exist (on the params as sent), validation, then the insert. Per
 * batch: one existence read per target type, one insert-only `write`, one
 * `allocateShortIds` + `bindShortIds`, one edges `writeMany`.
 *
 * `edges: null` writes rows only: no crossRef check and no edges.
 */
export function createBatchResolver(
  typeName: string,
  dataset: Dataset,
  edges: EdgesStore | null,
  opts: BatchResolverOptions = {}
): BatchResolver {
  const { fields, postWrite } = opts;
  const crossRefs = edges === null ? [] : collectCrossRefFields(fields);
  // Allocation is shortId-specific by name, as it has always been: other
  // engine-allocated fields would need their own strategy.
  const shortIdDef = fields?.shortId;
  const allocatesShortId = shortIdDef?.kind === 'scalar' && shortIdDef.readonly === true;

  return async (ctx, list) => {
    const n = list.length;
    if (n === 0) return [];
    const first = list[0] as ResolverArgs;
    // Prefer the engine-supplied handle (the tx view); the closed-over
    // dataset is a fallback for direct-resolver unit tests.
    const ds = first.dataset ?? dataset;
    const refusal = new FirstRefusal(n);

    if (crossRefs.length > 0) {
      // An element may reference a row an EARLIER element creates.
      // shortcut: String(id) keys conflate 5 and '5' on memory (see namesARowTwice).
      const pending = new Map<string, number>();
      for (const [i, args] of list.entries()) {
        const id = coerceId(args.params?.id);
        if (id !== undefined && !pending.has(String(id))) pending.set(String(id), i);
      }
      await refusal.capture(
        assertCrossRefTargetsExistMany(
          first,
          crossRefs,
          list.map((args) => args.params ?? {}),
          ds.namespace,
          { type: typeName, ids: pending }
        )
      );
    }

    const bodies: WriteRow[] = [];
    for (let i = 0; refusal.live(i); i++) {
      refusal.check(i, () => {
        bodies[i] = prepareCreateRow(list[i]?.params, fields);
      });
    }

    const stored: Row[] = [];
    const count = refusal.index;
    if (count > 0) {
      let actor: ActorIdentity | undefined;
      try {
        actor = resolveIdentity(ctx);
      } catch (err) {
        refusal.refuse(0, err);
      }
      if (actor !== undefined) {
        // Tier-1 row metadata — server-populated on every create.
        const at = ctx.now.toISOString();
        const meta: RowMetadata = {
          createdAt: at,
          updatedAt: at,
          createdBy: actor,
          updatedBy: actor
        };
        const input = bodies.slice(0, count).map((b) => ({ ...b, _metadata: { ...meta } }));
        // Insert-only: a row with a taken id (live, tombstoned, or earlier in
        // this batch) is never overwritten and drops out of the result, so the
        // first input missing from `ids` is the element refused.
        const written = await ds.write(typeName, input, { insertOnly: true });
        let p = 0;
        for (const [i, row] of input.entries()) {
          const landed = written.rows[p];
          if (
            landed !== undefined &&
            (row.id === undefined || String(written.ids[p]) === String(row.id))
          ) {
            stored.push(landed);
            p++;
            continue;
          }
          refusal.refuse(
            i,
            new ResolverFrameError(
              'id_exists',
              `create${typeName}: a row with id '${String(row.id)}' exists`,
              { field: 'id' }
            )
          );
          break;
        }
      }
    }
    refusal.throwIfRefused();

    let rows: Row[] = stored;
    if (allocatesShortId) {
      // Same transaction as the insert; ascending, so element order is
      // sequential allocation order.
      const shortIds = await ds.allocateShortIds(typeName, n);
      rows = stored.map((r, i) => ({ ...r, shortId: shortIds[i] }));
      await ds.bindShortIds(
        typeName,
        rows.map((r) => ({ shortId: r.shortId as number, rowId: String(r.id) }))
      );
    }

    const edgeStore = first.edges ?? edges;
    if (crossRefs.length > 0 && edgeStore !== null) {
      // Nested-struct crossRefs are deliberately not recursed — spec §5.2
      // will formalise their emission path.
      const inputs: EdgeWriteInput[] = [];
      for (const r of rows) {
        for (const { fieldName, def } of crossRefs) {
          const value = r[fieldName];
          if (typeof value !== 'string' && typeof value !== 'number') continue;
          inputs.push({
            from: { ns: ds.namespace, type: typeName, id: r.id },
            to: { ns: def.ns, type: def.type, id: value },
            fieldName,
            policy: def.onDelete
          });
        }
      }
      await edgeStore.writeMany(inputs);
    }

    for (const [i, row] of rows.entries()) {
      const args = list[i] as ResolverArgs;
      // §5.4 subscription hook: the engine fans these out on commit.
      args.onWrite?.({ ns: ds.namespace, type: typeName, id: row.id, operation: 'create', row });
      if (postWrite !== undefined) {
        await runPostWrite(postWrite, typeName, dataset, row, ctx, args);
      }
    }
    return rows;
  };
}

/**
 * `update<T>` for many rows. Per element, as the single resolver: the row
 * guard, validation, `not_found`, crossRef targets exist, then the patch. Per
 * batch: one resolution of the ids (shared with the guard), one existence read
 * per target type, one live-only `patchRows` (an update never revives or
 * re-creates a row), one `findEdgesFromMany`, `tombstoneMany` and `writeMany`.
 */
export function updateBatchResolver(
  typeName: string,
  dataset: Dataset,
  edges: EdgesStore,
  opts: BatchResolverOptions = {}
): BatchResolver {
  const { fields, policy, postWrite } = opts;
  const crossRefs = collectCrossRefFields(fields);

  const batch: BatchResolver = async (ctx, list) => {
    const n = list.length;
    if (n === 0) return [];
    const first = list[0] as ResolverArgs;
    const ds = first.dataset ?? dataset;
    const targets = await resolveEntityRows(
      ds,
      typeName,
      list.map((args) => coerceId(args.params?.id))
    );
    if (n > 1 && namesARowTwice(targets)) return eachAlone(batch, ctx, list);
    const hidden = guardRowWrites(ctx, policy, list, targets);
    const refusal = new FirstRefusal(n);

    interface Patch {
      i: number;
      id: Id;
      params: Record<string, unknown>;
      target: Row;
    }
    const patches: Array<Patch | undefined> = [];
    for (let i = 0; refusal.live(i); i++) {
      if (hidden[i]) continue;
      refusal.check(i, () => {
        const { id, params } = prepareUpdate(typeName, list[i]?.params, fields);
        const target = targets[i] ?? null;
        if (target === null) throw updateNotFound(typeName, id);
        patches[i] = { i, id, params, target };
      });
    }

    if (crossRefs.length > 0) {
      await refusal.capture(
        assertCrossRefTargetsExistMany(
          first,
          crossRefs,
          list.map((_, i) => (refusal.live(i) ? patches[i]?.params : undefined) ?? {}),
          ds.namespace
        )
      );
    }

    const writers = patches.filter((p): p is Patch => p !== undefined && refusal.live(p.i));
    const merged: Array<Row | null> = list.map(() => null);
    const firstWriter = writers[0];
    if (firstWriter !== undefined) {
      let actor: ActorIdentity | undefined;
      try {
        actor = resolveIdentity(ctx);
      } catch (err) {
        refusal.refuse(firstWriter.i, err);
      }
      if (actor !== undefined) {
        const out = await ds.patchRows(
          typeName,
          writers.map((w) => ({ id: w.target.id, patch: withoutId(w.params) })),
          actor,
          ctx.now
        );
        for (const [k, w] of writers.entries()) {
          const row = out[k] ?? null;
          // Tombstoned or purged since it was resolved.
          if (row === null) refusal.refuse(w.i, updateNotFound(typeName, w.id));
          merged[w.i] = row;
        }
      }
    }
    refusal.throwIfRefused();

    await syncCrossRefEdges(
      first.edges ?? edges,
      { ns: ds.namespace, type: typeName },
      crossRefs,
      writers.map((w) => ({ id: w.target.id, params: w.params }))
    );

    for (const [i, row] of merged.entries()) {
      if (row === null) continue;
      const args = list[i] as ResolverArgs;
      args.onWrite?.({ ns: ds.namespace, type: typeName, id: row.id, operation: 'update', row });
      if (postWrite !== undefined) {
        await runPostWrite(postWrite, typeName, dataset, row, ctx, args);
      }
    }
    return merged;
  };
  return batch;
}

function withoutId(params: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(params)) {
    if (field !== 'id') patch[field] = value;
  }
  return patch;
}

/**
 * `delete<T>` for many rows. Per element, as the single resolver: the row
 * guard, validation, then the restrict gate and the tombstone. A row that is
 * missing, tombstoned or hidden answers `{ id, deleted: false }`. Per batch:
 * one resolution of the ids (shared with the guard) and one `deleteRows`
 * (one `findEdgesToMany`, one `tombstone`).
 */
export function deleteBatchResolver(
  typeName: string,
  dataset: Dataset,
  edges: EdgesStore,
  opts: BatchResolverOptions = {}
): BatchResolver {
  const { policy } = opts;

  const batch: BatchResolver = async (ctx, list) => {
    const n = list.length;
    if (n === 0) return [];
    const first = list[0] as ResolverArgs;
    // Prefer engine-supplied handles so the tx view and the engine's edges
    // store take precedence. Closed-over values are a fallback for direct-call
    // tests.
    const ds = first.dataset ?? dataset;
    const edgeStore = first.edges ?? edges;
    const requested = list.map((args) => coerceId(args.params?.id));
    const targets = await resolveEntityRows(ds, typeName, requested);
    if (n > 1 && namesARowTwice(targets)) return eachAlone(batch, ctx, list);
    const hidden = guardRowWrites(ctx, policy, list, targets);
    const refusal = new FirstRefusal(n);

    for (let i = 0; refusal.live(i); i++) {
      if (!hidden[i]) refusal.check(i, () => prepareDelete(typeName, list[i]?.params));
    }
    const doomed: number[] = [];
    for (let i = 0; refusal.live(i); i++) {
      if (!hidden[i] && (targets[i] ?? null) !== null) doomed.push(i);
    }
    try {
      await deleteRows({
        dataset: ds,
        edges: edgeStore,
        type: typeName,
        ids: doomed.map((i) => (targets[i] as Row).id)
      });
    } catch (err) {
      if (!isRestrictViolation(err)) throw err;
      // Its blocking edges point at the refused row.
      const blocked = err.blockedBy[0]?.to.id;
      const at = doomed.find((i) => String(targets[i]?.id) === String(blocked));
      if (at === undefined) throw err;
      refusal.refuse(at, err);
    }
    refusal.throwIfRefused();

    const out: DeleteResolverResult[] = [];
    for (const [i, args] of list.entries()) {
      const target = targets[i] ?? null;
      if (hidden[i] || target === null) {
        out.push({ id: requested[i] as Id, deleted: false });
        continue;
      }
      // §5.4 subscription hook — the pre-tombstone snapshot, so the bus can
      // filter-test it and emit `remove` for matching subscriptions.
      args.onWrite?.({
        ns: ds.namespace,
        type: typeName,
        id: target.id,
        operation: 'delete',
        row: target
      });
      out.push({ id: target.id, deleted: true });
    }
    return out;
  };
  return batch;
}

/** `create<T>` without crossRef edges: the batch resolver with `edges: null`, one element. */
export function createResolver<T extends Row = Row>(
  typeName: string,
  dataset: Dataset,
  options: Pick<BatchResolverOptions, 'fields'> = {}
): TypedResolver<T> {
  return singleFrame<T>(createBatchResolver(typeName, dataset, null, options));
}

/** `update<T>`: the batch resolver with one element. */
export function updateResolver<T extends Row = Row>(
  typeName: string,
  dataset: Dataset,
  edges: EdgesStore,
  options: Pick<BatchResolverOptions, 'fields'> = {}
): TypedResolver<T | null> {
  return singleFrame<T | null>(updateBatchResolver(typeName, dataset, edges, options));
}

/** `delete<T>`: the batch resolver with one element. */
export function deleteResolver(
  typeName: string,
  dataset: Dataset,
  edges: EdgesStore,
  options: Pick<BatchResolverOptions, 'policy'> = {}
): TypedResolver<DeleteResolverResult> {
  return singleFrame<DeleteResolverResult>(deleteBatchResolver(typeName, dataset, edges, options));
}
