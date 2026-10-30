/**
 * Compiles `{ field: { path: [...], <op> } }` on a json field.
 *
 * Must return exactly the rows `@mnmal-ai/substrate-filter`'s json-path.ts
 * evaluator does. Three compilation choices carry that:
 *
 *  - `eq` / `in` / `has` are containment, `(body -> field) @> doc`. Type-strict
 *    by construction (1995 does not contain "1995"). Written against the
 *    FIELD, not the body, so it matches the scoped GIN that
 *    `field.json({ indexed: true })` derives.
 *  - Everything typed is `COALESCE(CASE WHEN jsonb_typeof(x) = … THEN … END,
 *    FALSE)`. CASE because SQL does not promise AND short-circuits, so a
 *    guarded `::numeric` could still meet 'unknown' and fail the whole query;
 *    COALESCE because a bare CASE yields NULL on a mismatch and `NOT NULL` is
 *    NULL, which would silently drop rows from a caller's `NOT`.
 *  - The walk is the `->` chain, never `#>`: `#>` treats "0" as an array
 *    index, and the evaluator walks objects only. `->` with a text key on an
 *    array is NULL, which agrees.
 */

import { assertJsonPathPredicate, type JsonPathPredicate } from '@mnmal-ai/substrate-filter';
import type { Sql, TransactionSql } from 'postgres';
import {
  asJsonValue,
  bodyJson,
  combineAnd,
  combineOr,
  escapeLike,
  type Fragment
} from './primitives.js';

type Cmp = '>' | '>=' | '<' | '<=';

/** `{ p0: { … pN: leaf } }` — the document `(body -> field) @>` tests for. */
function nestPath(path: readonly string[], leaf: unknown): unknown {
  let doc: unknown = leaf;
  for (let i = path.length - 1; i >= 0; i--) doc = { [path[i] as string]: doc };
  return doc;
}

export function buildJsonPathPredicate(
  sql: Sql | TransactionSql,
  field: string,
  predicate: JsonPathPredicate,
  alias?: string
): Fragment {
  assertJsonPathPredicate(field, predicate);
  const path = predicate.path;

  const x = bodyJson(sql, [field, ...path], alias);
  const text = sql`(${x} #>> '{}')`;

  // `IS NOT NULL AND`, not COALESCE: a row with no such field makes the left
  // side SQL NULL, and `FALSE AND NULL` is FALSE, so this is never NULL under a
  // caller's NOT. COALESCE would say the same but hide `@>` from the planner —
  // the index only matches a bare `expr @> const` conjunct.
  const fieldExpr = bodyJson(sql, [field], alias);
  const containsDoc = (leaf: unknown): Fragment =>
    sql`${fieldExpr} @> ${sql.json(asJsonValue(nestPath(path, leaf)))}`;
  const contains = (leaf: unknown): Fragment =>
    sql`(${fieldExpr} IS NOT NULL AND ${containsDoc(leaf)})`;
  const isNull = sql`(${x} IS NULL OR jsonb_typeof(${x}) = 'null')`;
  const eq = (v: unknown): Fragment => (v === null ? isNull : contains(v));
  // One IS NOT NULL guard for the whole list, not one per member: members stay
  // bare `@>` disjuncts the GIN can BitmapOr, and each binds two params rather
  // than three (the member cap in substrate-filter keeps pg under its ceiling).
  const inList = (vs: unknown[]): Fragment => {
    const members = vs.filter((v) => v !== null);
    const parts: Fragment[] = [];
    if (members.length > 0) {
      parts.push(sql`(${fieldExpr} IS NOT NULL AND ${combineOr(sql, members.map(containsDoc))})`);
    }
    if (members.length < vs.length) parts.push(isNull);
    return parts.length === 0 ? sql`FALSE` : combineOr(sql, parts);
  };
  const guarded = (jsonType: 'number' | 'string', cond: Fragment): Fragment =>
    sql`COALESCE(CASE WHEN jsonb_typeof(${x}) = ${jsonType} THEN ${cond} END, FALSE)`;

  const cmp = (op: Cmp, operand: number | string): Fragment => {
    if (typeof operand === 'number') {
      const n = sql`${text}::numeric`;
      switch (op) {
        case '>':
          return guarded('number', sql`${n} > ${operand}`);
        case '>=':
          return guarded('number', sql`${n} >= ${operand}`);
        case '<':
          return guarded('number', sql`${n} < ${operand}`);
        case '<=':
          return guarded('number', sql`${n} <= ${operand}`);
      }
    }
    const s = sql`${text} COLLATE "C"`;
    switch (op) {
      case '>':
        return guarded('string', sql`${s} > ${operand}`);
      case '>=':
        return guarded('string', sql`${s} >= ${operand}`);
      case '<':
        return guarded('string', sql`${s} < ${operand}`);
      case '<=':
        return guarded('string', sql`${s} <= ${operand}`);
    }
  };

  const fragments: Fragment[] = [];
  for (const [op, operand] of Object.entries(predicate)) {
    switch (op) {
      case 'path':
        break;
      case 'eq':
        fragments.push(eq(operand));
        break;
      case 'neq':
        fragments.push(sql`NOT (${eq(operand)})`);
        break;
      case 'in':
        fragments.push(inList(operand as unknown[]));
        break;
      case 'nin':
        fragments.push(sql`NOT (${inList(operand as unknown[])})`);
        break;
      case 'gt':
        fragments.push(cmp('>', operand as number | string));
        break;
      case 'gte':
        fragments.push(cmp('>=', operand as number | string));
        break;
      case 'lt':
        fragments.push(cmp('<', operand as number | string));
        break;
      case 'lte':
        fragments.push(cmp('<=', operand as number | string));
        break;
      case 'between': {
        const [lo, hi] = operand as [number, number] | [string, string];
        fragments.push(
          typeof lo === 'number'
            ? guarded('number', sql`${text}::numeric BETWEEN ${lo} AND ${hi}`)
            : guarded('string', sql`${text} COLLATE "C" BETWEEN ${lo} AND ${hi}`)
        );
        break;
      }
      case 'contains':
        fragments.push(
          guarded('string', sql`${text} ILIKE ${`%${escapeLike(operand as string)}%`}`)
        );
        break;
      case 'startsWith':
        fragments.push(
          guarded('string', sql`${text} ILIKE ${`${escapeLike(operand as string)}%`}`)
        );
        break;
      case 'endsWith':
        fragments.push(
          guarded('string', sql`${text} ILIKE ${`%${escapeLike(operand as string)}`}`)
        );
        break;
      default: // 'has' — assertJsonPathPredicate refused anything else
        fragments.push(contains([operand]));
    }
  }
  return combineAnd(sql, fragments);
}
