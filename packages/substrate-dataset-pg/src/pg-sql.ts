/**
 * Barrel for the pure SQL-fragment builders in `./pg-sql/`:
 *
 *   `./pg-sql/primitives.js` — Fragment, idToText, metadata/promoted-column
 *     maps, BodyOrderByCast, scalar helpers
 *   `./pg-sql/projection.js` — buildBodyProjection, assembleRowMetadata
 *   `./pg-sql/where.js` — buildWhere, combineAnd, conditionalMatchFragment,
 *     whereReferencesField
 *   `./pg-sql/sorting.js` — normalizeOrderBy, resolveBodyOrderByCast,
 *     buildOrderBy, buildSortKeyProjection, buildProjectedOrderBy,
 *     buildCursorCompare, buildCursorNullTail
 *
 * These modules never import from pg-dataset.ts and hold no connection state.
 * Caller values always go through parameterised slots; `sql.unsafe(...)` is
 * used only for identifiers/casts drawn from closed constant maps, for field
 * names inlined as escaped literals, and for comparison operators from a closed
 * set. `PgDataset.read` also inlines its page LIMIT, which is safe because
 * `read()` validates and floors it and `BigInt()` throws on a non-integer.
 */

export {
  asJsonValue,
  type BodyOrderByCast,
  combineAnd,
  type Fragment,
  idToText,
  isMetadataField,
  type MetadataFieldName,
  type PromotedBodyColumn,
  type PromotedBodyColumnMap,
  type PromotedColumnLookup,
  resolvePromotedColumns,
  type SqlJsonValue
} from './pg-sql/primitives.js';
export { assembleRowMetadata, buildBodyProjection } from './pg-sql/projection.js';
export {
  buildCursorCompare,
  buildCursorNullTail,
  buildOrderBy,
  buildProjectedOrderBy,
  buildSortKeyProjection,
  normalizeOrderBy,
  resolveBodyOrderByCast
} from './pg-sql/sorting.js';
export { buildWhere, conditionalMatchFragment, whereReferencesField } from './pg-sql/where.js';
