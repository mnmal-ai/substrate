/**
 * autoCRUD `list<T>` resolver. Spec: §5.1, §5.2.
 *
 * Honours every documented field on `ReadParams`: `id` / `ids` (single-row
 * / multi-row shortcuts), `where`, `orderBy`, `limit`, `cursor`,
 * `includeDeleted`, `_allowTableScan` (deprecated, ignored). The engine validates the
 * where/orderBy shape BEFORE this resolver is invoked (via
 * FilterValidationError); we additionally reject any OTHER top-level params
 * key with `unknown_param` so typos (`order` for `orderBy`, etc.) fail loud
 * instead of being silently ignored.
 *
 * Returns a `ReadResult` so the engine can thread `nextCursor`/`hasMore` into
 * the response envelope's `_pagination` block.
 */

import type {
  Dataset,
  FieldDef,
  FieldInput,
  Id,
  OrderByClause,
  ReadParams,
  ReadResult,
  Row,
  TypedResolver,
  WhereClause
} from '@mnmal-ai/substrate-types';
import { normaliseVocabWhere } from '@mnmal-ai/substrate-types';
import { rejectUnknownParams } from './internal.js';

const KNOWN_LIST_PARAMS: ReadonlySet<string> = new Set([
  'id',
  'ids',
  'where',
  'orderBy',
  'limit',
  'cursor',
  'includeDeleted',
  '_allowTableScan'
]);

function extractLimit(params: Record<string, unknown> | undefined): number | undefined {
  if (!params) return undefined;
  const raw = params.limit;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) {
    return Math.floor(raw);
  }
  return undefined;
}

export interface ListResolverOptions {
  /** Field definitions; vocabulary aliases in `where` are normalised against them. */
  fields?: Record<string, FieldDef>;
}

export function listResolver<_T extends Row = Row>(
  typeName: string,
  dataset: Dataset,
  options: ListResolverOptions = {}
): TypedResolver<ReadResult> {
  return async (_ctx, args) => {
    rejectUnknownParams('list', typeName, args.params, KNOWN_LIST_PARAMS);
    // Prefer the engine-supplied handle so a list-inside-mutate (rare) sees
    // the active tx's writes; direct-call unit tests fall back to the closure.
    const ds = args.dataset ?? dataset;
    const limit = extractLimit(args.params);
    const readParams: ReadParams = {};
    if (limit !== undefined) readParams.limit = limit;
    const id = args.params?.id as Id | undefined;
    const ids = args.params?.ids as Id[] | undefined;
    const where = args.params?.where as WhereClause | undefined;
    const orderBy = args.params?.orderBy as OrderByClause[] | undefined;
    const cursor = args.params?.cursor;
    const includeDeleted = args.params?.includeDeleted;
    if (id !== undefined) readParams.id = id;
    if (ids !== undefined) readParams.ids = ids;
    if (where !== undefined) {
      readParams.where =
        options.fields !== undefined
          ? (normaliseVocabWhere(where, options.fields) as WhereClause)
          : where;
    }
    if (orderBy !== undefined) readParams.orderBy = orderBy;
    if (typeof cursor === 'string') readParams.cursor = cursor;
    if (includeDeleted === true) readParams.includeDeleted = true;
    // Forward the caller's field selection so substrates (PgDataset) can
    // narrow the body keys they materialise from storage. Substrates MAY
    // ignore the hint.
    const fields = args.fields as FieldInput | undefined;
    if (fields !== undefined) readParams.fields = fields;

    return ds.read(typeName, readParams);
  };
}
