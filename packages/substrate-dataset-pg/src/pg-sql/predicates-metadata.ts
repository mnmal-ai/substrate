/**
 * WHERE predicates against the native row-metadata columns on `rows`,
 * rather than `body ->> field` extraction.
 */

import { UnsupportedFilterError } from '@mnmal-ai/substrate-types';
import type { Sql, TransactionSql } from 'postgres';
import {
  combineAnd,
  combineOr,
  escapeLike,
  type Fragment,
  METADATA_COLUMNS,
  type MetadataFieldName,
  metaStr
} from './primitives.js';

/**
 * Builds WHERE predicates against a metadata column (e.g. `r.created_at`).
 * Returns null when no operator produced a predicate; throws
 * `UnsupportedFilterError` on an unknown operator.
 *
 * Timestamp columns take equality and range operators; the `*ByKind` /
 * `*ById` text columns take equality, range and pattern operators. The column
 * comes from the constant `METADATA_COLUMNS`, so `sql.unsafe` is safe here.
 */

export function buildMetadataColumnPredicate(
  sql: Sql | TransactionSql,
  field: MetadataFieldName,
  predicate: Record<string, unknown>
): Fragment | null {
  const colName = METADATA_COLUMNS[field];
  const isTimestamp = field === 'createdAt' || field === 'updatedAt';
  const fragments: Fragment[] = [];

  for (const [op, operand] of Object.entries(predicate)) {
    let frag: Fragment | null = null;
    const col = sql.unsafe(colName);

    if (isTimestamp) {
      // Timestamp columns — use ::timestamptz casts for ordering / range ops.
      // ISO-8601 strings come in from callers; pg can parse them natively.
      switch (op) {
        case 'eq':
          if (operand === null) frag = sql`${col} IS NULL`;
          else if (typeof operand === 'string') frag = sql`${col} = ${operand}::timestamptz`;
          else if (operand instanceof Date)
            frag = sql`${col} = ${operand.toISOString()}::timestamptz`;
          break;
        case 'neq':
          if (operand === null) frag = sql`${col} IS NOT NULL`;
          else if (typeof operand === 'string')
            frag = sql`${col} IS DISTINCT FROM ${operand}::timestamptz`;
          else if (operand instanceof Date)
            frag = sql`${col} IS DISTINCT FROM ${operand.toISOString()}::timestamptz`;
          break;
        case 'gt':
          if (typeof operand === 'string') frag = sql`${col} > ${operand}::timestamptz`;
          else if (operand instanceof Date)
            frag = sql`${col} > ${operand.toISOString()}::timestamptz`;
          break;
        case 'gte':
          if (typeof operand === 'string') frag = sql`${col} >= ${operand}::timestamptz`;
          else if (operand instanceof Date)
            frag = sql`${col} >= ${operand.toISOString()}::timestamptz`;
          break;
        case 'lt':
          if (typeof operand === 'string') frag = sql`${col} < ${operand}::timestamptz`;
          else if (operand instanceof Date)
            frag = sql`${col} < ${operand.toISOString()}::timestamptz`;
          break;
        case 'lte':
          if (typeof operand === 'string') frag = sql`${col} <= ${operand}::timestamptz`;
          else if (operand instanceof Date)
            frag = sql`${col} <= ${operand.toISOString()}::timestamptz`;
          break;
        case 'between':
          if (Array.isArray(operand) && operand.length === 2) {
            const low = operand[0] instanceof Date ? operand[0].toISOString() : String(operand[0]);
            const high = operand[1] instanceof Date ? operand[1].toISOString() : String(operand[1]);
            frag = sql`${col} BETWEEN ${low}::timestamptz AND ${high}::timestamptz`;
          }
          break;
        case 'in':
        case 'nin':
          if (Array.isArray(operand)) {
            const vals = operand
              .filter((v) => v !== null)
              .map((v) => (v instanceof Date ? v.toISOString() : String(v)));
            const member = memberOf(sql, col, sql`${vals}::timestamptz[]`, operand);
            frag = op === 'in' ? member : sql`NOT ${member}`;
          }
          break;
        default:
          throw new UnsupportedFilterError(field, op, 'is not a recognised filter operator');
      }
    } else {
      // Text columns (createdByKind, createdById, updatedByKind, updatedById).
      // The ILIKE patterns are not btree-indexable; a seq-scan within
      // (ns, type) is accepted. escapeLike() stops operands smuggling `%`/`_`.
      switch (op) {
        case 'eq':
          if (operand === null) frag = sql`${col} IS NULL`;
          else if (typeof operand === 'string') frag = sql`${col} = ${operand}`;
          break;
        case 'neq':
          if (operand === null) frag = sql`${col} IS NOT NULL`;
          else if (typeof operand === 'string') frag = sql`${col} IS DISTINCT FROM ${operand}`;
          break;
        case 'in':
        case 'nin':
          if (Array.isArray(operand)) {
            const strs = operand.filter((v) => typeof v === 'string') as string[];
            const member = memberOf(sql, col, sql`${strs}::text[]`, operand);
            frag = op === 'in' ? member : sql`NOT ${member}`;
          }
          break;
        case 'contains':
          if (typeof operand === 'string') frag = sql`${col} ILIKE ${`%${escapeLike(operand)}%`}`;
          break;
        case 'startsWith':
          if (typeof operand === 'string') frag = sql`${col} ILIKE ${`${escapeLike(operand)}%`}`;
          break;
        case 'endsWith':
          if (typeof operand === 'string') frag = sql`${col} ILIKE ${`%${escapeLike(operand)}`}`;
          break;
        // Lexicographic range on an actor id / kind.
        case 'gt':
          frag = sql`${col} > ${metaStr(field, op, operand)}`;
          break;
        case 'gte':
          frag = sql`${col} >= ${metaStr(field, op, operand)}`;
          break;
        case 'lt':
          frag = sql`${col} < ${metaStr(field, op, operand)}`;
          break;
        case 'lte':
          frag = sql`${col} <= ${metaStr(field, op, operand)}`;
          break;
        case 'between': {
          if (!Array.isArray(operand) || operand.length !== 2) {
            throw new UnsupportedFilterError(field, op, 'requires a two-element [low, high] array');
          }
          frag = sql`${col} BETWEEN ${metaStr(field, op, operand[0])} AND ${metaStr(field, op, operand[1])}`;
          break;
        }
        default:
          throw new UnsupportedFilterError(field, op, 'is not a recognised filter operator');
      }
    }

    if (frag !== null) fragments.push(frag);
  }

  if (fragments.length === 0) return null;
  return combineAnd(sql, fragments);
}

/**
 * Membership of `col` in `operand`, never NULL: an empty list matches nothing,
 * and a null element matches a null column, as the memory evaluator does.
 */
function memberOf(
  sql: Sql | TransactionSql,
  col: ReturnType<Sql['unsafe']>,
  values: Fragment,
  operand: unknown[]
): Fragment {
  const parts: Fragment[] = [sql`COALESCE(${col} = ANY(${values}), FALSE)`];
  if (operand.includes(null)) parts.push(sql`${col} IS NULL`);
  return combineOr(sql, parts);
}
