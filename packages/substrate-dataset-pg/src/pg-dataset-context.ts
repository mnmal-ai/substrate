/** The handle state and pure lookups `PgDataset` shares with its split-out modules. */

import type { FieldDef, IndexDecl, OrderedBy } from '@mnmal-ai/substrate-types';
import { naturalOrderOf, ResolverFrameError } from '@mnmal-ai/substrate-types';
import type { DiskGuard } from './disk-guard.js';
import { desiredIndexKeys, type ReconcileTypeIndexesArgs } from './index-reconciler.js';
import type { StorageLayout } from './layout.js';
import { type BodyOrderByCast, resolveBodyOrderByCast } from './pg-sql.js';
import type { PgHandle } from './tx-scope.js';
import type { TypeTable } from './type-table.js';

/**
 * Returns the declared FieldDef for a type's field, or undefined when unknown
 * (body-key sorts then fall back to text compare). Lets the SQL builders cast
 * body values by declared kind, so `count` sorts 2 before 10 — see
 * `resolveBodyOrderByCast`.
 */
export type FieldDefLookup = (type: string, field: string) => FieldDef | undefined;

/**
 * A type's declared fields and indexes, or undefined when the type is unknown.
 * Called with the asking dataset's namespace, so a `forNamespace` clone that
 * inherits the lookup resolves its own types.
 */
export type TypeDefLookup = (
  type: string,
  namespace: string
) =>
  | {
      fields: Record<string, FieldDef>;
      indexes?: IndexDecl[];
      orderedBy?: OrderedBy;
      ordering?: 'visible';
      expectedSize?: 'small' | 'large';
    }
  | undefined;

/** What the modules split out of `PgDataset` read of the handle that calls them. */
export interface PgContext {
  readonly namespace: string;
  /** The pool, or the transaction's connection when {@link inTx}. */
  readonly sql: PgHandle;
  readonly inTx: boolean;
  readonly fieldDefLookup: FieldDefLookup | null;
  readonly fieldDefLookupFor: ((namespace: string) => FieldDefLookup) | null;
  readonly typeDefLookup: TypeDefLookup | null;
  readonly diskGuard: DiskGuard | undefined;
  /** `tables` once the store is migrated, else `'absent'`. */
  layout(): Promise<StorageLayout | 'absent'>;
  /** `type`'s table, or undefined when it has none yet; `read` marks a read path. */
  tableFor(type: string, namespace?: string, read?: boolean): Promise<TypeTable | undefined>;
  /** Runs a guarded write, rebuilt and rerun while its table's descriptor is stale. */
  guarded<R extends { ok: boolean; iso: string; id: string | null }>(
    type: string,
    table: TypeTable,
    write: (table: TypeTable) => Promise<R[]>
  ): Promise<{ table: TypeTable; records: R[] }>;
}

/** A body field's declared kind as the cast its extraction takes; null when undeclared. */
export function castFor(ctx: PgContext, type: string): (field: string) => BodyOrderByCast | null {
  return (field) =>
    ctx.fieldDefLookup === null ? null : resolveBodyOrderByCast(ctx.fieldDefLookup(type, field));
}

export function indexArgs(
  ctx: PgContext,
  type: string,
  namespace: string
): ReconcileTypeIndexesArgs {
  const def = ctx.typeDefLookup?.(type, namespace);
  return {
    namespace,
    type,
    fields: def?.fields ?? {},
    indexes: def?.indexes ?? [],
    orderedBy: naturalOrderOf(def ?? {}),
    ...(def?.ordering !== undefined ? { ordering: def.ordering } : {})
  };
}

/**
 * A write's error as the caller should see it: a declared unique index's
 * conflict (23505) becomes `unique_violation` naming the index and its
 * fields; anything else is returned unchanged.
 */
export function uniqueViolation(ctx: PgContext, type: string, err: unknown): unknown {
  const pgErr = err as { code?: unknown; constraint_name?: unknown };
  if (pgErr?.code !== '23505' || typeof pgErr.constraint_name !== 'string') return err;
  const index = pgErr.constraint_name;
  // No query: the failed statement may have aborted this transaction.
  const declared = desiredIndexKeys(indexArgs(ctx, type, ctx.namespace)).find(
    (d) => d.name === index
  );
  const fields = declared?.keys.map(([field]) => field) ?? [];
  return new ResolverFrameError(
    'unique_violation',
    `${ctx.namespace}/${type}: a row already holds these values for unique index ${index}` +
      (fields.length > 0 ? ` (${fields.join(', ')})` : ''),
    { index, fields }
  );
}
