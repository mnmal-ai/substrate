/**
 * Barrel for the pure SQL-fragment builders in `./pg-sql/`:
 *
 *   `./pg-sql/primitives.js` — Fragment, idToText, metadata/promoted-column
 *     maps, BodyOrderByCast, scalar helpers
 *   `./pg-sql/projection.js` — buildBodyProjection, assembleRowMetadata
 *   `./pg-sql/where.js` — buildWhere, combineAnd, conditionalMatchFragment
 *   `./pg-sql/sorting.js` — normalizeOrderBy, resolveBodyOrderByCast,
 *     buildOrderBy, buildSortKeyProjection, buildCursorCompare
 *
 * These modules never import from pg-dataset.ts and hold no connection state.
 * Caller values always go through parameterised slots; `sql.unsafe(...)` is
 * used only for identifiers/casts drawn from closed constant maps.
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
  buildOrderBy,
  buildSortKeyProjection,
  normalizeOrderBy,
  resolveBodyOrderByCast
} from './pg-sql/sorting.js';
export { buildWhere, conditionalMatchFragment } from './pg-sql/where.js';
