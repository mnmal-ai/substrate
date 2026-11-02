/**
 * WHERE predicates against dedicated columns: the old layouts' body-promoted
 * columns, which read the column ONLY, with no body fallback (see
 * `PgDatasetOptions.promotedColumns`), and a type table's typed columns.
 */

import { UnsupportedFilterError } from '@mnmal-ai/substrate-types';
import type { Sql, TransactionSql } from 'postgres';
import { extraWins, RAW_KEY } from '../row-codec.js';
import type { TypedColumn, TypeTable } from '../type-table.js';
import {
  columnAs,
  columnOrderExpr,
  combineAnd,
  combineOr,
  escapeLike,
  type Fragment,
  fieldExpr,
  notNullAnd,
  type PromotedBodyColumn,
  promotedColumnSql,
  qualifier,
  sqlStringLiteral,
  tsArrayParam,
  tsParam
} from './primitives.js';

/**
 * Builds the WHERE predicate for a promoted column. Returns null for an empty
 * predicate; throws `UnsupportedFilterError` on an unknown operator or a
 * wrong-typed operand.
 *
 * Per value V: `col = V::T` (text under `COLLATE "C"`), or `col IS NULL` when V is null. `in` / `nin`
 * OR/AND the per-value predicates.
 */
export function buildPromotedBodyColumnPredicate(
  sql: Sql | TransactionSql,
  field: string,
  meta: PromotedBodyColumn,
  predicate: Record<string, unknown>,
  alias?: string
): Fragment | null {
  const col = sql.unsafe(promotedColumnSql(meta, alias));
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
      // Inlined, so a generic plan can still match a partial index's predicate.
      return sql`${col} = ${sql.unsafe(value ? 'TRUE' : 'FALSE')}`;
    }
    // Byte order, as ranges and sorts compare, so one `(col COLLATE "C")` index serves all.
    return sql`${col} COLLATE "C" = ${str('eq', value)}::text`;
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
      return sql`${col} IS DISTINCT FROM ${sql.unsafe(value ? 'TRUE' : 'FALSE')}`;
    }
    return sql`${col} COLLATE "C" IS DISTINCT FROM ${str('neq', value)}::text`;
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
        frag = sql`${col} COLLATE "C" > ${str(op, operand)}::text`;
        break;
      case 'gte':
        textOnly(op);
        frag = sql`${col} COLLATE "C" >= ${str(op, operand)}::text`;
        break;
      case 'lt':
        textOnly(op);
        frag = sql`${col} COLLATE "C" < ${str(op, operand)}::text`;
        break;
      case 'lte':
        textOnly(op);
        frag = sql`${col} COLLATE "C" <= ${str(op, operand)}::text`;
        break;
      case 'between': {
        textOnly(op);
        if (!Array.isArray(operand) || operand.length !== 2) {
          throw new UnsupportedFilterError(field, op, 'requires a two-element [low, high] array');
        }
        frag = sql`${col} COLLATE "C" BETWEEN ${str(op, operand[0])}::text AND ${str(op, operand[1])}::text`;
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

/**
 * Builds the WHERE predicate for `field`, a typed column of `table`, read
 * through `fieldExpr` (so a `promoting` or `orphaned` field's `extra` key wins
 * when present). As memory's evaluator: an operand of another type than the
 * column's never equals or orders (so `neq`/`nin` admit it), a null is the
 * is-null filter, and a compare on an absent value is FALSE, never NULL, so a
 * caller's NOT stays sound. Throws `UnsupportedFilterError` as the body path does.
 */
export function buildColumnPredicate(
  sql: Sql | TransactionSql,
  field: string,
  table: TypeTable,
  column: TypedColumn,
  predicate: Record<string, unknown>,
  alias?: string
): Fragment | null {
  const as = columnAs(column.kind);
  const expr = fieldExpr(sql, table, field, as, alias);
  // Ranges compare in byte order, as memory does (a crossRef column is not "C").
  const byOrder = columnOrderExpr(sql, table, column, alias);
  /** `v` bound as the column's type, or undefined when it is of another type. */
  const param = (v: unknown): Fragment | undefined => {
    switch (as) {
      case 'text':
        if (typeof v === 'string') return sql`${v}::text`;
        // A numeric crossRef id is held as its text, as the codec writes it.
        return column.kind === 'crossRef' && typeof v === 'number'
          ? sql`${String(v)}::text`
          : undefined;
      case 'number':
        return typeof v === 'number' ? sql`${v}` : undefined;
      case 'date':
        return typeof v === 'string' || v instanceof Date ? tsParam(sql, v) : undefined;
      case 'boolean':
        // Inlined, so a generic plan can still match a partial index's predicate.
        return typeof v === 'boolean' ? sql.unsafe(v ? 'TRUE' : 'FALSE') : undefined;
    }
  };
  const fits = (v: unknown): boolean => param(v) !== undefined;
  /**
   * Null as `decodeRow` reads it (amendment 4, operator ruling A): a value the
   * column cannot hold sits in `$raw` with the column NULL, so it is not null.
   * A `column`-state field keeps the bare `col IS NULL` its index serves, with
   * the `$raw` test as a filter on the rows it returns; a promoting or orphaned
   * field reads its JSON value, `$raw` overlaid. Never NULL itself, so a NOT
   * around it stays sound. An operand the column cannot hold (an enum value
   * outside the recorded vocabulary) is not looked up in `$raw`: it matches
   * nothing (ruling A, option 3).
   */
  const json = fieldExpr(sql, table, field, 'json', alias);
  const raw = sql.unsafe(
    `(${qualifier(alias)}extra -> ${sqlStringLiteral(RAW_KEY)} ? ${sqlStringLiteral(field)})`
  );
  const isNull = extraWins(column)
    ? sql`${json} IS NULL`
    : sql`(${expr} IS NULL AND ${raw} IS NOT TRUE)`;
  const isNotNull = extraWins(column)
    ? sql`${json} IS NOT NULL`
    : sql`(${expr} IS NOT NULL OR ${raw} IS TRUE)`;
  const guarded = (cond: Fragment): Fragment => notNullAnd(sql, expr, cond);
  /** `expr = ANY(...)` over the non-null members that fit; FALSE when none does. */
  const anyOf = (values: unknown[]): Fragment => {
    const fit = values.filter(fits);
    if (fit.length === 0) return sql`FALSE`;
    const list =
      as === 'date'
        ? tsArrayParam(sql, fit)
        : as === 'number'
          ? sql`${fit as number[]}::numeric[]`
          : as === 'boolean'
            ? sql`${fit as boolean[]}::boolean[]`
            : sql`${fit.map(String)}::text[]`;
    return guarded(sql`${expr} = ANY(${list})`);
  };
  const ordered = (op: string, v: unknown): Fragment | undefined => {
    if (typeof v !== 'number' && typeof v !== 'string' && !(v instanceof Date)) {
      throw new UnsupportedFilterError(
        field,
        op,
        `cannot compare against a ${v === null ? 'null' : typeof v} value`
      );
    }
    return param(v);
  };

  const fragments: Fragment[] = [];
  for (const [op, operand] of Object.entries(predicate)) {
    switch (op) {
      case 'eq': {
        const p = param(operand);
        fragments.push(
          operand === null ? isNull : p === undefined ? sql`FALSE` : guarded(sql`${expr} = ${p}`)
        );
        break;
      }
      case 'neq': {
        const p = param(operand);
        fragments.push(
          operand === null
            ? isNotNull
            : p === undefined
              ? sql`TRUE`
              : sql`${expr} IS DISTINCT FROM ${p}`
        );
        break;
      }
      case 'gt':
      case 'gte':
      case 'lt':
      case 'lte': {
        const p = ordered(op, operand);
        // Template slots are value slots, so the operator comes from this closed set.
        const cmp = sql.unsafe({ gt: '>', gte: '>=', lt: '<', lte: '<=' }[op]);
        fragments.push(p === undefined ? sql`FALSE` : guarded(sql`${byOrder} ${cmp} ${p}`));
        break;
      }
      case 'between': {
        if (!Array.isArray(operand) || operand.length !== 2) {
          throw new UnsupportedFilterError(field, op, 'requires a two-element [low, high] array');
        }
        const lo = ordered(op, operand[0]);
        const hi = ordered(op, operand[1]);
        fragments.push(
          lo === undefined || hi === undefined
            ? sql`FALSE`
            : guarded(sql`${byOrder} BETWEEN ${lo} AND ${hi}`)
        );
        break;
      }
      case 'in': {
        if (!Array.isArray(operand)) {
          throw new UnsupportedFilterError(field, op, 'requires an array value');
        }
        // A null member means "or absent", as in memory.
        const values = operand.filter((v) => v !== null && v !== undefined);
        const any = anyOf(values);
        fragments.push(values.length < operand.length ? sql`(${any} OR ${isNull})` : any);
        break;
      }
      case 'nin': {
        if (!Array.isArray(operand)) {
          throw new UnsupportedFilterError(field, op, 'requires an array value');
        }
        const values = operand.filter((v) => v !== null && v !== undefined);
        fragments.push(
          operand.length === 0
            ? sql`TRUE`
            : values.length < operand.length
              ? values.length === 0
                ? isNotNull
                : sql`(${isNotNull} AND NOT ${anyOf(values)})`
              : sql`(${expr} IS NULL OR NOT ${anyOf(values)})`
        );
        break;
      }
      case 'contains':
      case 'startsWith':
      case 'endsWith': {
        if (typeof operand !== 'string') {
          throw new UnsupportedFilterError(field, op, 'requires a string value');
        }
        // Memory matches only a string value: a number or boolean never does.
        if (as !== 'text' && as !== 'date') {
          fragments.push(sql`FALSE`);
          break;
        }
        const e = escapeLike(operand);
        const pattern = op === 'contains' ? `%${e}%` : op === 'startsWith' ? `${e}%` : `%${e}`;
        fragments.push(sql`${fieldExpr(sql, table, field, 'rawText', alias)} ILIKE ${pattern}`);
        break;
      }
      case 'has':
        // List membership: a scalar column is never a list.
        fragments.push(sql`FALSE`);
        break;
      default:
        throw new UnsupportedFilterError(field, op, 'is not a recognised filter operator');
    }
  }
  if (fragments.length === 0) return null;
  return combineAnd(sql, fragments);
}
