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
  metaStr,
  tsArrayParam,
  tsParam
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
      // ISO-8601 strings come in from callers; pg parses them, bound as text
      // so the driver cannot round them to milliseconds (see `tsParam`).
      const ts =
        typeof operand === 'string' || operand instanceof Date ? tsParam(sql, operand) : null;
      switch (op) {
        case 'eq':
          if (operand === null) frag = sql`${col} IS NULL`;
          else if (ts !== null) frag = sql`${col} = ${ts}`;
          break;
        case 'neq':
          if (operand === null) frag = sql`${col} IS NOT NULL`;
          else if (ts !== null) frag = sql`${col} IS DISTINCT FROM ${ts}`;
          break;
        case 'gt':
          if (ts !== null) frag = sql`${col} > ${ts}`;
          break;
        case 'gte':
          if (ts !== null) frag = sql`${col} >= ${ts}`;
          break;
        case 'lt':
          if (ts !== null) frag = sql`${col} < ${ts}`;
          break;
        case 'lte':
          if (ts !== null) frag = sql`${col} <= ${ts}`;
          break;
        case 'between':
          if (Array.isArray(operand) && operand.length === 2) {
            frag = sql`${col} BETWEEN ${tsParam(sql, operand[0])} AND ${tsParam(sql, operand[1])}`;
          }
          break;
        case 'in':
        case 'nin':
          if (Array.isArray(operand)) {
            const vals = operand.filter((v) => v !== null);
            const member = memberOf(sql, col, tsArrayParam(sql, vals), operand);
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
