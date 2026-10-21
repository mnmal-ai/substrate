/**
 * Row-scoped policies. Spec: §4.4.
 *
 * `row<T>(predicate)` returns a normal Policy that always allows at
 * collection-time, attaching the predicate as a `'row-filter'` obligation.
 * The engine (or test harness) calls `applyRowFilters` after the resolver
 * produces rows; predicates run in insertion order and silently drop any
 * row for which they return false OR throw.
 */

import type {
  Policy,
  PolicyDecision,
  RequestContext,
  RowFilterObligation
} from '@mnmal-ai/substrate-types';

/**
 * Build a collection-time allow decision carrying a single row-filter
 * obligation. Composes with `and`/`or` like any other policy.
 */
export function row<T>(predicate: (ctx: RequestContext, row: T) => boolean): Policy {
  return () => ({
    allow: true,
    obligations: [{ kind: 'row-filter', predicate } satisfies RowFilterObligation<T>]
  });
}

/**
 * Type guard for row-filter obligations. Narrows to a predicate over
 * `unknown` rows — callers supply the row array and are responsible for the
 * T↔row relationship (the engine only ever hands rows back as `Row[]`).
 */
function isRowFilter(obligation: { kind: string }): obligation is RowFilterObligation<unknown> {
  return obligation.kind === 'row-filter';
}

/**
 * Apply every row-filter obligation on `decision` to `rows`, in insertion
 * order. Per §4.4, row-scoped denies are silent — returning false OR throwing
 * drops the row without surfacing a reason. A decision without obligations
 * returns `rows` unchanged.
 */
export function applyRowFilters<T>(decision: PolicyDecision, rows: T[], ctx: RequestContext): T[] {
  const obligations = decision.obligations;
  if (!obligations || obligations.length === 0) {
    return rows;
  }

  let current = rows;
  for (const obligation of obligations) {
    if (!isRowFilter(obligation)) continue;
    const predicate = obligation.predicate as (ctx: RequestContext, row: T) => boolean;
    current = current.filter((item) => {
      try {
        return predicate(ctx, item);
      } catch {
        // Throwing predicates silently drop the row (spec §4.4).
        return false;
      }
    });
  }
  return current;
}
