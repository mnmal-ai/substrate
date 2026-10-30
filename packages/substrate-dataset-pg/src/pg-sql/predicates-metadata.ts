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
  qualifier,
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

/** `r.<column>`, or the same column of `alias`'s row. */
export function metadataColumnSql(field: MetadataFieldName, alias?: string): string {
  const col = METADATA_COLUMNS[field];
  return alias === undefined ? col : `${qualifier(alias)}${col.slice('r.'.length)}`;
}

export function buildMetadataColumnPredicate(
  sql: Sql | TransactionSql,
  field: MetadataFieldName,
  predicate: Record<string, unknown>,
  alias?: string
): Fragment | null {
  const colName = metadataColumnSql(field, alias);
  const col = sql.unsafe(colName);
  if (field === 'seq') {
    // The validator has already checked operands are numbers.
    const n = (v: unknown): Fragment => sql`${String(v)}::bigint`;
    return orderedColumnPredicate(sql, field, col, predicate, {
      one: n,
      bound: n,
      many: (vs) => sql`${vs.map(String)}::bigint[]`,
      strictBetween: true
    });
  }
  if (field === 'createdAt' || field === 'updatedAt') {
    // ISO-8601 strings come in from callers; pg parses them, bound as text so
    // the driver cannot round them to milliseconds (see `tsParam`).
    return orderedColumnPredicate(sql, field, col, predicate, {
      one: (v) => (typeof v === 'string' || v instanceof Date ? tsParam(sql, v) : null),
      bound: (v) => tsParam(sql, v),
      many: (vs) => tsArrayParam(sql, vs),
      strictBetween: false
    });
  }
  const fragments: Fragment[] = [];

  for (const [op, operand] of Object.entries(predicate)) {
    let frag: Fragment | null = null;
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
      // Lexicographic range on an actor id / kind, by byte order as body text is.
      case 'gt':
        frag = sql`${col} COLLATE "C" > ${metaStr(field, op, operand)}`;
        break;
      case 'gte':
        frag = sql`${col} COLLATE "C" >= ${metaStr(field, op, operand)}`;
        break;
      case 'lt':
        frag = sql`${col} COLLATE "C" < ${metaStr(field, op, operand)}`;
        break;
      case 'lte':
        frag = sql`${col} COLLATE "C" <= ${metaStr(field, op, operand)}`;
        break;
      case 'between': {
        if (!Array.isArray(operand) || operand.length !== 2) {
          throw new UnsupportedFilterError(field, op, 'requires a two-element [low, high] array');
        }
        frag = sql`${col} COLLATE "C" BETWEEN ${metaStr(field, op, operand[0])} AND ${metaStr(field, op, operand[1])}`;
        break;
      }
      default:
        throw new UnsupportedFilterError(field, op, 'is not a recognised filter operator');
    }

    if (frag !== null) fragments.push(frag);
  }

  if (fragments.length === 0) return null;
  return combineAnd(sql, fragments);
}

/** How an ordered column binds its operands. */
interface OrderedBinders {
  /** A comparison operand, or null when it yields no predicate. */
  one: (v: unknown) => Fragment | null;
  /** A `between` bound. */
  bound: (v: unknown) => Fragment;
  /** The non-null elements of an `in`/`nin` list. */
  many: (vs: unknown[]) => Fragment;
  /** A malformed `between` throws rather than yielding no predicate. */
  strictBetween: boolean;
}

/** Equality, range and membership predicates on one ordered column (`seq`, a timestamp). */
function orderedColumnPredicate(
  sql: Sql | TransactionSql,
  field: MetadataFieldName,
  col: ReturnType<Sql['unsafe']>,
  predicate: Record<string, unknown>,
  bind: OrderedBinders
): Fragment | null {
  const fragments: Fragment[] = [];
  for (const [op, operand] of Object.entries(predicate)) {
    let frag: Fragment | null = null;
    const v = bind.one(operand);
    switch (op) {
      case 'eq':
        if (operand === null) frag = sql`${col} IS NULL`;
        else if (v !== null) frag = sql`${col} = ${v}`;
        break;
      case 'neq':
        if (operand === null) frag = sql`${col} IS NOT NULL`;
        else if (v !== null) frag = sql`${col} IS DISTINCT FROM ${v}`;
        break;
      case 'gt':
        if (v !== null) frag = sql`${col} > ${v}`;
        break;
      case 'gte':
        if (v !== null) frag = sql`${col} >= ${v}`;
        break;
      case 'lt':
        if (v !== null) frag = sql`${col} < ${v}`;
        break;
      case 'lte':
        if (v !== null) frag = sql`${col} <= ${v}`;
        break;
      case 'between':
        if (Array.isArray(operand) && operand.length === 2) {
          frag = sql`${col} BETWEEN ${bind.bound(operand[0])} AND ${bind.bound(operand[1])}`;
        } else if (bind.strictBetween) {
          throw new UnsupportedFilterError(field, op, 'requires a two-element [low, high] array');
        }
        break;
      case 'in':
      case 'nin':
        if (Array.isArray(operand)) {
          const member = memberOf(sql, col, bind.many(operand.filter((e) => e !== null)), operand);
          frag = op === 'in' ? member : sql`NOT ${member}`;
        }
        break;
      default:
        throw new UnsupportedFilterError(field, op, 'is not a recognised filter operator');
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
