/**
 * WHERE predicates against body-promoted columns. These read the column
 * ONLY, with no body fallback — see `PgDatasetOptions.promotedColumns`.
 */

import { UnsupportedFilterError } from '@mnmal-ai/substrate-types';
import type { Sql, TransactionSql } from 'postgres';
import {
  combineAnd,
  combineOr,
  escapeLike,
  type Fragment,
  type PromotedBodyColumn,
  promotedColumnSql
} from './primitives.js';

/**
 * Builds the WHERE predicate for a promoted column. Returns null for an empty
 * predicate; throws `UnsupportedFilterError` on an unknown operator or a
 * wrong-typed operand.
 *
 * Per value V: `col = V::T`, or `col IS NULL` when V is null. `in` / `nin`
 * OR/AND the per-value predicates.
 */
export function buildPromotedBodyColumnPredicate(
  sql: Sql | TransactionSql,
  field: string,
  meta: PromotedBodyColumn,
  predicate: Record<string, unknown>
): Fragment | null {
  const col = sql.unsafe(promotedColumnSql(meta));
  const isBool = meta.kind === 'boolean';
  const fragments: Fragment[] = [];

  /** Operand-shape guard. A wrong-typed operand is a caller error, not a non-match. */
  const str = (op: string, v: unknown): string => {
    if (typeof v !== 'string') {
      throw new UnsupportedFilterError(
        field,
        op,
        `requires a string value on a ${meta.kind} column`
      );
    }
    return v;
  };

  const singleEq = (value: unknown): Fragment => {
    if (value === null) return sql`${col} IS NULL`;
    if (isBool) {
      if (typeof value !== 'boolean') {
        throw new UnsupportedFilterError(field, 'eq', 'requires a boolean value');
      }
      return sql`${col} = ${value}::boolean`;
    }
    return sql`${col} = ${str('eq', value)}::text`;
  };

  /**
   * `neq` ADMITS NULLs, matching the body path and the memory substrate, so
   * `eq` and `neq` partition the rows. `neq: null` is the is-not-null filter.
   */
  const singleNeq = (value: unknown): Fragment => {
    if (value === null) return sql`${col} IS NOT NULL`;
    if (isBool) {
      if (typeof value !== 'boolean') {
        throw new UnsupportedFilterError(field, 'neq', 'requires a boolean value');
      }
      return sql`${col} IS DISTINCT FROM ${value}::boolean`;
    }
    return sql`${col} IS DISTINCT FROM ${str('neq', value)}::text`;
  };

  /**
   * Range / pattern operators are text-column only; throws on a boolean column.
   */
  const textOnly = (op: string): void => {
    if (isBool) {
      throw new UnsupportedFilterError(field, op, `is not applicable to a boolean column`);
    }
  };

  for (const [op, operand] of Object.entries(predicate)) {
    let frag: Fragment;
    switch (op) {
      case 'eq':
        frag = singleEq(operand);
        break;
      case 'neq':
        frag = singleNeq(operand);
        break;
      case 'in': {
        if (!Array.isArray(operand)) {
          throw new UnsupportedFilterError(field, op, 'requires an array value');
        }
        // Empty IN matches nothing (not a dropped predicate, which matches all).
        if (operand.length === 0) {
          frag = sql`FALSE`;
          break;
        }
        frag = combineOr(sql, operand.map(singleEq));
        break;
      }
      case 'nin': {
        if (!Array.isArray(operand)) {
          throw new UnsupportedFilterError(field, op, 'requires an array value');
        }
        // "not in nothing" excludes nothing — a true match-all, not a drop.
        if (operand.length === 0) {
          frag = sql`TRUE`;
          break;
        }
        frag = combineAnd(sql, operand.map(singleNeq));
        break;
      }
      case 'gt':
        textOnly(op);
        frag = sql`${col} > ${str(op, operand)}::text`;
        break;
      case 'gte':
        textOnly(op);
        frag = sql`${col} >= ${str(op, operand)}::text`;
        break;
      case 'lt':
        textOnly(op);
        frag = sql`${col} < ${str(op, operand)}::text`;
        break;
      case 'lte':
        textOnly(op);
        frag = sql`${col} <= ${str(op, operand)}::text`;
        break;
      case 'between': {
        textOnly(op);
        if (!Array.isArray(operand) || operand.length !== 2) {
          throw new UnsupportedFilterError(field, op, 'requires a two-element [low, high] array');
        }
        frag = sql`${col} BETWEEN ${str(op, operand[0])}::text AND ${str(op, operand[1])}::text`;
        break;
      }
      // ILIKE for case-insensitive matching, mirroring the metadata text
      // columns and the memory substrate. escapeLike neutralises caller-supplied
      // `%` / `_` so an operand cannot smuggle wildcards.
      case 'contains':
        textOnly(op);
        frag = sql`${col} ILIKE ${`%${escapeLike(str(op, operand))}%`}`;
        break;
      case 'startsWith':
        textOnly(op);
        frag = sql`${col} ILIKE ${`${escapeLike(str(op, operand))}%`}`;
        break;
      case 'endsWith':
        textOnly(op);
        frag = sql`${col} ILIKE ${`%${escapeLike(str(op, operand))}`}`;
        break;
      default:
        throw new UnsupportedFilterError(field, op, 'is not a recognised filter operator');
    }
    fragments.push(frag);
  }

  if (fragments.length === 0) return null;
  return combineAnd(sql, fragments);
}
