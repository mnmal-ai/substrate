/**
 * Which form a walk is evaluated in where a store has the choice (Todo
 * #1815). Both forms answer the same rows; the rules only choose the cheaper
 * plan. They are pure functions of the frame (and of which far fields are
 * indexed), so the pg compiler and the engine's `plan` report agree.
 *
 * - `per-seed`: the walk runs once for each seed row, as a correlated probe.
 *   Best when a page wants a few seeds: it costs one probe per seed read.
 * - `per-hub`: a `pick` reached through an outbound hop is computed once per
 *   distinct hub (the near row many seeds share), then joined back.
 * - `group-by`: a frame `_agg` over a date or number window is aggregated in
 *   one pass over the window, grouped by the crossRef, then joined back.
 *
 * Both shared forms do their work for every seed the read could match, so
 * they are chosen only when the read wants every matching seed anyway.
 */

import type { FieldDef, WalkAgg, WalkNode, WhereClause } from '@mnmal-ai/substrate-types';
import { isDateField } from './predicate.js';
import { groupConjuncts, refNames } from './walk.js';

export type WalkForm = 'per-seed' | 'per-hub' | 'group-by';

/**
 * A page larger than this (the default max page) wants every seed rather than a page of them.
 * Fixed rather than the configured `maxLimit`, which the datasets never see. So under default
 * page limits the shared forms apply to counts and whole-result aggregates, and to pages only
 * for callers with a raised `maxLimit` or in-process reads with no limit.
 */
export const EVERY_SEED_LIMIT = 1000;

/** True when a read evaluates its walks for every matching seed: a count, a whole-result aggregate, or a page with no limit or one over {@link EVERY_SEED_LIMIT}. */
export function readsEverySeed(params: {
  count?: boolean;
  aggregate?: unknown;
  limit?: number;
}): boolean {
  return (
    params.count === true ||
    params.aggregate !== undefined ||
    params.limit === undefined ||
    params.limit > EVERY_SEED_LIMIT
  );
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The `_walk` nodes among a where's top-level AND conjuncts, without `as`. */
const conjunctWalks = (where: unknown): WalkNode[] =>
  groupConjuncts(where).items.flatMap((i) => {
    const w = (i as Record<string, unknown>)._walk;
    return isObj(w) ? [w as WalkNode] : [];
  });

const isAny = (w: WalkNode) => w.pick === undefined && (w.quantifier ?? 'any') === 'any';

/**
 * The `per-hub` rule. A pick P is shared, mapped to its hub walk O, when the
 * read wants every seed and is a count or a page (not a whole-result
 * aggregate), O is a top-level AND conjunct `{ _walk: { out, where } }`
 * of the seed's where (an `any` walk, no `as`) that reads no top-level `as`
 * binding, P is an inbound pick among O's where's AND conjuncts, and P's
 * where reads no binding but `$` (or a frame `_agg`) and its `among` none. Picking depends only on
 * the hub, and `$` is read after the pick, so P's where is still tested per
 * seed. O reading a top-level binding would compile inside that binding's
 * EXISTS, where the shared CTE could not be hashed.
 */
export function sharedPicks(params: {
  where?: WhereClause;
  count?: boolean;
  aggregate?: unknown;
  limit?: number;
}): Map<WalkNode, WalkNode> {
  const out = new Map<WalkNode, WalkNode>();
  // A whole-result aggregate re-reads the where in its own subqueries, which
  // cannot carry the picks' join; it keeps the per-seed form.
  if (!readsEverySeed(params) || params.aggregate !== undefined) return out;
  const bound = new Set(groupConjuncts(params.where).binds.map((b) => b.as));
  for (const o of conjunctWalks(params.where)) {
    if (typeof o.out !== 'string' || !isAny(o)) continue;
    if ([...refNames(o.where)].some((n) => bound.has(n))) continue;
    for (const p of conjunctWalks(o.where)) {
      if (typeof p.in !== 'string' || p.pick === undefined) continue;
      // `among` decides which row is picked, so it may read only the far row: a `$` would make the pick per seed.
      if (refNames(p.among).size > 0) continue;
      if ([...refNames(p.where)].every((n) => n === '$' || n === '_agg')) out.set(p, o);
    }
  }
  return out;
}

const RANGE_OPS = new Set(['gt', 'gte', 'lt', 'lte', 'between']);

/** True when `where` holds no walk grammar (`_walk`, `_agg`, `$ref`): it reads only the far row. */
const farOnly = (where: unknown): boolean =>
  Array.isArray(where)
    ? where.every(farOnly)
    : !isObj(where) ||
      Object.entries(where).every(
        ([k, v]) => k !== '_walk' && k !== '_agg' && k !== '$ref' && farOnly(v)
      );

/** An `_agg` is a pick (a top-1, per seed): a latest, or a date min/max. */
export const isPickAgg = (spec: WalkAgg, fieldDef: (field: string) => FieldDef | undefined) =>
  'latest' in spec ||
  (['min', 'max'] as const).some((op) => {
    const f = (spec as Record<string, unknown>)[op];
    return typeof f === 'string' && isDateField(f, fieldDef);
  });

/**
 * The `group-by` rule, for one frame-level `_agg` entry. It is aggregated in
 * one pass over its window when:
 * - the read is a page (a count or aggregate projects no `_agg`) that wants
 *   every seed (see {@link readsEverySeed});
 * - its hop is inbound and it is a count, avg, sum or number min/max (a
 *   latest or date min/max is a top-1 probe per seed, already cheap);
 * - its `where` reads only the far row (no `_walk`, `_agg` or `$ref`) and
 *   holds, AND-ed at the top, a range on a field `indexed` on the far type
 *   (an index leads with it), so the window is one index range;
 * - the seed's where has, AND-ed at the top, an `any` walk over the same hop
 *   and the very same `where` (compared as JSON; a mismatch only misses the
 *   form): every seed is then one of the window's keys, so the window is
 *   read anyway. The seeds may be fewer than the keys; the pg compiler
 *   semi-joins the keys to the seeds' other conjuncts, so the pass covers
 *   only the keys that can match.
 */
export function windowGroupBy(
  spec: WalkAgg,
  params: { where?: WhereClause; count?: boolean; aggregate?: unknown; limit?: number },
  fieldDef: (field: string) => FieldDef | undefined,
  indexed: (field: string) => boolean
): boolean {
  if (params.count === true || params.aggregate !== undefined || !readsEverySeed(params)) {
    return false;
  }
  if (typeof spec.in !== 'string' || spec.where === undefined) {
    return false;
  }
  if (isPickAgg(spec, fieldDef) || !farOnly(spec.where)) return false;
  const ranged = groupConjuncts(spec.where).items.some((i) =>
    Object.entries(i).some(
      ([f, ops]) => isObj(ops) && Object.keys(ops).some((op) => RANGE_OPS.has(op)) && indexed(f)
    )
  );
  if (!ranged) return false;
  const key = JSON.stringify(spec.where);
  return conjunctWalks(params.where).some(
    (w) => isAny(w) && w.in === spec.in && JSON.stringify(w.where) === key
  );
}
