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
  BucketSpec,
  Dataset,
  DeriveSpec,
  FieldDef,
  FrameAgg,
  Id,
  NestedSelection,
  OrderByClause,
  ReadParams,
  ReadResult,
  Row,
  TypedResolver,
  WalkAgg,
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
  '_allowTableScan',
  'count',
  'aggregate',
  'bucket',
  'derive'
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
    // Walk-grammar params; the engine validated them before this resolver runs.
    const p = args.params ?? {};
    if (p.count !== undefined) readParams.count = p.count as boolean;
    if (p.aggregate !== undefined) readParams.aggregate = p.aggregate as Record<string, FrameAgg>;
    if (p.bucket !== undefined) readParams.bucket = p.bucket as BucketSpec;
    if (p.derive !== undefined) readParams.derive = p.derive as Record<string, DeriveSpec>;
    // Forward the caller's field selection so substrates (PgDataset) can
    // narrow the body keys they materialise from storage. Substrates MAY
    // ignore the hint. `_agg` and nested `{ _walk }` selections are lifted out
    // into `agg` / `nested`; they are not body keys.
    const fields = args.fields as Record<string, unknown> | undefined;
    if (fields !== undefined) {
      const entries = Object.entries(fields);
      const isNested = (v: unknown) => typeof v === 'object' && v !== null && '_walk' in v;
      const agg = fields._agg;
      if (agg !== undefined) readParams.agg = agg as Record<string, WalkAgg>;
      const nested = entries.filter(([, v]) => isNested(v));
      if (nested.length > 0) {
        readParams.nested = Object.fromEntries(nested) as Record<string, NestedSelection>;
      }
      readParams.fields =
        agg !== undefined || nested.length > 0
          ? Object.fromEntries(entries.filter(([k, v]) => k !== '_agg' && !isNested(v)))
          : fields;
    }

    if (args.signal !== undefined) readParams.signal = args.signal;

    return ds.read(typeName, readParams);
  };
}
