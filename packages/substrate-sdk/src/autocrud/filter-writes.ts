/**
 * autoCRUD `updateMany<T>` (`{ where, set }`) and `deleteMany<T>` (`{ where }`).
 *
 * The engine validates `where` as a query's on the target type before the
 * resolver runs (the entry's `filterTarget`). The resolver runs `update<T>`'s
 * checks on `set`, then writes:
 *
 * - With no policy on the type: one `updateWhere` / `deleteWhere` statement
 *   with the caller's `where`.
 * - With a policy: the matches are read first (refused past `maxMatch`), the
 *   policy runs once per matched row with `{ id, ...set }` (`{ id }` for a
 *   delete), as `update<T>` / `delete<T>` would run it. Any deny refuses the
 *   frame; a row filter drops the rows the caller cannot see. The write is
 *   then by those ids: one `patchRows` (constant text, locks in id order), or
 *   `deleteRows` (restrict gate, then one `tombstone`).
 *
 * Neither is served while a plugin has replaced the type's `update<T>` or
 * `delete<T>`: the custom logic there would be bypassed.
 *
 * Every changed row is announced with `onWrite`, so subscribers and post-write
 * hooks see each id. The result is `{ count, ids, idsTruncated }`, `ids` cut
 * at `idsCap`.
 */

import { applyRowFilters } from '@mnmal-ai/substrate-policy';
import type {
  Dataset,
  EdgesStore,
  FilterWriteResult,
  Id,
  Policy,
  RequestContext,
  ResolverArgs,
  Row,
  TypedResolver,
  WhereClause
} from '@mnmal-ai/substrate-types';
import {
  DEFAULT_FILTER_WRITE_LIMITS,
  filterTooBroad,
  isBatchElementError,
  ResolverFrameError
} from '@mnmal-ai/substrate-types';
import { assertNoRestrictEdges, deleteRows } from '../delete.js';
import { preparePatch } from './autocrud-update.js';
import { type BatchResolverOptions, runPostWrite } from './batch.js';
import { syncCrossRefEdges } from './crossref-edge-sync.js';
import { assertCrossRefTargetsExistMany, collectCrossRefFields } from './crossref-existence.js';
import { resolveIdentity } from './internal.js';

export interface FilterWriteMutationResult {
  count: number;
  ids: Id[];
  idsTruncated: boolean;
}

export interface FilterWriteResolverOptions extends BatchResolverOptions {
  /**
   * Whether the type's `update<T>` and `delete<T>` are still autoCRUD's own
   * entries. When a plugin replaced either with custom logic, writing by
   * filter would bypass it, so the resolver refuses. Absent: served.
   */
  ownsSingleRowWrites?: () => boolean;
}

/** `updateMany<T>`: `set` merged into every live row `where` matches. */
export function updateManyResolver(
  typeName: string,
  dataset: Dataset,
  edges: EdgesStore,
  opts: FilterWriteResolverOptions = {}
): TypedResolver<FilterWriteMutationResult> {
  const { fields, policy, postWrite } = opts;
  const crossRefs = collectCrossRefFields(fields);
  const op = `updateMany${typeName}`;
  return async (ctx, args) => {
    const ds = args.dataset ?? dataset;
    if (opts.ownsSingleRowWrites?.() === false) throw replaced(op, typeName);
    const where = whereOf(op, args.params);
    const raw = args.params?.set;
    if (!isPlainObject(raw) || Object.keys(raw).length === 0) {
      throw new ResolverFrameError('invalid_params', `${op}: params.set must name a field`, {
        param: 'set'
      });
    }
    if (Object.hasOwn(raw, 'id')) {
      throw new ResolverFrameError('invalid_params', `${op}: set cannot change id`, {
        field: 'id'
      });
    }
    const set = preparePatch(raw, fields);
    if (crossRefs.length > 0) {
      try {
        await assertCrossRefTargetsExistMany(args, crossRefs, [set], ds.namespace);
      } catch (err) {
        throw isBatchElementError(err) ? err.cause : err;
      }
    }
    const actor = resolveIdentity(ctx);
    const { maxMatch, idsCap } = args.filterWriteLimits ?? DEFAULT_FILTER_WRITE_LIMITS;
    let rows: Row[];
    if (policy === undefined) {
      const updateWhere = ds.updateWhere?.bind(ds);
      if (updateWhere === undefined) throw unsupported(op, ds);
      ({ rows } = await updateWhere(typeName, where, set, { maxMatch, actor, now: ctx.now }));
    } else {
      const kept = await policyKept(ctx, args, ds, typeName, where, policy, maxMatch, set);
      // shortcut: a row a concurrent writer moves out of the filter between
      // the read and this by-id write is still written, as sequential per-row
      // updates under READ COMMITTED would; lock in the read once `read`
      // grows a lock option.
      const patched = await ds.patchRows(
        typeName,
        kept.map((r) => ({ id: r.id, patch: set })),
        actor,
        ctx.now
      );
      rows = patched.filter((r): r is Row => r !== null);
    }

    await syncCrossRefEdges(
      args.edges ?? edges,
      { ns: ds.namespace, type: typeName },
      crossRefs,
      rows.map((r) => ({ id: r.id, params: set }))
    );
    for (const row of rows) {
      args.onWrite?.({ ns: ds.namespace, type: typeName, id: row.id, operation: 'update', row });
      if (postWrite !== undefined) {
        await runPostWrite(postWrite, typeName, dataset, row, ctx, args);
      }
    }
    return resultOf(rows, idsCap);
  };
}

/** `deleteMany<T>`: tombstones every live row `where` matches, behind the restrict gate. */
export function deleteManyResolver(
  typeName: string,
  dataset: Dataset,
  edges: EdgesStore,
  opts: Pick<FilterWriteResolverOptions, 'policy' | 'ownsSingleRowWrites'> = {}
): TypedResolver<FilterWriteMutationResult> {
  const { policy } = opts;
  const op = `deleteMany${typeName}`;
  return async (ctx, args) => {
    const ds = args.dataset ?? dataset;
    if (opts.ownsSingleRowWrites?.() === false) throw replaced(op, typeName);
    const edgeStore = args.edges ?? edges;
    const where = whereOf(op, args.params);
    const { maxMatch, idsCap } = args.filterWriteLimits ?? DEFAULT_FILTER_WRITE_LIMITS;
    let rows: Row[];
    if (policy === undefined) {
      const deleteWhere = ds.deleteWhere?.bind(ds);
      if (deleteWhere === undefined) throw unsupported(op, ds);
      ({ rows } = await deleteWhere(typeName, where, { maxMatch }));
      // The ids are known only once the statement ran, so the gate follows it.
      // Relies on the engine's transaction: a blocked row throws and rolls the tombstones back.
      await assertNoRestrictEdges(
        edgeStore,
        { ns: ds.namespace, type: typeName },
        rows.map((r) => r.id)
      );
    } else {
      const kept = await policyKept(ctx, args, ds, typeName, where, policy, maxMatch, {});
      // shortcut: as for updateMany's policy path, a row moved out of the
      // filter after the read is still deleted; lock in the read once `read`
      // grows a lock option.
      const done = new Set(
        (
          await deleteRows({
            dataset: ds,
            edges: edgeStore,
            type: typeName,
            ids: kept.map((r) => r.id)
          })
        ).map(String)
      );
      rows = kept.filter((r) => done.has(String(r.id)));
    }
    for (const row of rows) {
      // §5.4: the pre-tombstone snapshot, as delete<T> emits.
      args.onWrite?.({ ns: ds.namespace, type: typeName, id: row.id, operation: 'delete', row });
    }
    return resultOf(rows, idsCap);
  };
}

/**
 * The matched rows a policy lets the caller write: the matches are read
 * (refused past `maxMatch`), the policy runs per row with `{ id, ...set }`,
 * a deny on any row refuses the frame, and a row filter drops the rows the
 * caller cannot see.
 */
async function policyKept(
  ctx: RequestContext,
  args: ResolverArgs,
  ds: Dataset,
  typeName: string,
  where: WhereClause,
  policy: Policy,
  maxMatch: number,
  set: Record<string, unknown>
): Promise<Row[]> {
  const { rows } = await ds.read(typeName, { where, limit: maxMatch + 1 });
  if (rows.length > maxMatch) throw filterTooBroad(ds.namespace, typeName, maxMatch);
  const kept: Row[] = [];
  for (const row of rows) {
    let decision: ReturnType<Policy>;
    try {
      decision = policy(ctx, { ...args, params: { id: row.id, ...set } });
    } catch {
      // Fail closed, as the engine's evaluatePolicy does.
      decision = { allow: false, reason: 'policy error' };
    }
    if (!decision.allow) {
      throw new ResolverFrameError('policy_denied', decision.reason ?? 'policy denied');
    }
    if (applyRowFilters(decision, [row], ctx).length > 0) kept.push(row);
  }
  return kept;
}

function replaced(op: string, typeName: string): ResolverFrameError {
  return new ResolverFrameError(
    'capability_unsupported',
    `${op}: update${typeName} or delete${typeName} has custom logic that a write by filter would bypass; write by id`
  );
}

function whereOf(op: string, params: Record<string, unknown> | undefined): WhereClause {
  const where = params?.where;
  if (!isPlainObject(where)) {
    throw new ResolverFrameError('invalid_params', `${op}: params.where is required`, {
      param: 'where'
    });
  }
  return where as WhereClause;
}

function resultOf(rows: FilterWriteResult['rows'], idsCap: number): FilterWriteMutationResult {
  return {
    count: rows.length,
    ids: rows.slice(0, idsCap).map((r) => r.id),
    idsTruncated: rows.length > idsCap
  };
}

function unsupported(op: string, ds: Dataset): ResolverFrameError {
  return new ResolverFrameError(
    'capability_unsupported',
    `${op}: the '${ds.namespace}' store does not write by filter`
  );
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
