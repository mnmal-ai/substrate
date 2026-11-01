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
 *   then by those ids, still one statement.
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
  TypedResolver,
  WhereClause
} from '@mnmal-ai/substrate-types';
import {
  DEFAULT_FILTER_WRITE_LIMITS,
  filterTooBroad,
  isBatchElementError,
  ResolverFrameError
} from '@mnmal-ai/substrate-types';
import { assertNoRestrictEdges } from '../delete.js';
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

const EMPTY: FilterWriteResult = { count: 0, ids: [], rows: [] };

/** `updateMany<T>`: `set` merged into every live row `where` matches. */
export function updateManyResolver(
  typeName: string,
  dataset: Dataset,
  edges: EdgesStore,
  opts: BatchResolverOptions = {}
): TypedResolver<FilterWriteMutationResult> {
  const { fields, policy, postWrite } = opts;
  const crossRefs = collectCrossRefFields(fields);
  const op = `updateMany${typeName}`;
  return async (ctx, args) => {
    const ds = args.dataset ?? dataset;
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
    const target = await policyScopedWhere(ctx, args, ds, typeName, where, policy, maxMatch, set);
    const updateWhere = ds.updateWhere?.bind(ds);
    if (updateWhere === undefined) throw unsupported(op, ds);
    const { rows } =
      target === null
        ? EMPTY
        : await updateWhere(typeName, target, set, { maxMatch, actor, now: ctx.now });

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
  opts: Pick<BatchResolverOptions, 'policy'> = {}
): TypedResolver<FilterWriteMutationResult> {
  const { policy } = opts;
  const op = `deleteMany${typeName}`;
  return async (ctx, args) => {
    const ds = args.dataset ?? dataset;
    const where = whereOf(op, args.params);
    const { maxMatch, idsCap } = args.filterWriteLimits ?? DEFAULT_FILTER_WRITE_LIMITS;
    const target = await policyScopedWhere(ctx, args, ds, typeName, where, policy, maxMatch, {});
    const deleteWhere = ds.deleteWhere?.bind(ds);
    if (deleteWhere === undefined) throw unsupported(op, ds);
    const { rows } = target === null ? EMPTY : await deleteWhere(typeName, target, { maxMatch });
    // The ids are known only once the statement ran, so the gate follows it:
    // a blocked row throws, and the engine rolls the tombstones back.
    await assertNoRestrictEdges(
      args.edges ?? edges,
      { ns: ds.namespace, type: typeName },
      rows.map((r) => r.id)
    );
    for (const row of rows) {
      // §5.4: the pre-tombstone snapshot, as delete<T> emits.
      args.onWrite?.({ ns: ds.namespace, type: typeName, id: row.id, operation: 'delete', row });
    }
    return resultOf(rows, idsCap);
  };
}

/**
 * The `where` to write by, or null when nothing may be written. No policy:
 * the caller's `where`. A policy: the ids of the matched rows it allows and
 * lets the caller see; a deny on any matched row refuses the frame.
 */
async function policyScopedWhere(
  ctx: RequestContext,
  args: ResolverArgs,
  ds: Dataset,
  typeName: string,
  where: WhereClause,
  policy: Policy | undefined,
  maxMatch: number,
  set: Record<string, unknown>
): Promise<WhereClause | null> {
  if (policy === undefined) return where;
  const { rows } = await ds.read(typeName, { where, limit: maxMatch + 1 });
  if (rows.length > maxMatch) throw filterTooBroad(ds.namespace, typeName, maxMatch);
  const kept: Id[] = [];
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
    if (applyRowFilters(decision, [row], ctx).length > 0) kept.push(row.id);
  }
  return kept.length === 0 ? null : { id: { in: kept } };
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
