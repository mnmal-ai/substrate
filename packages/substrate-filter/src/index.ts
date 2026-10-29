/**
 * @mnmal-ai/substrate-filter — cursor encoding + where-clause evaluation. Spec §5.2 / §5.4.
 *
 * Kept out of substrate-core so dataset packages can use these pure utilities
 * without depending on the engine.
 */

export {
  type ApplyExtensionMetaOpts,
  applyExtensionResultMeta,
  fieldRequested
} from './apply-extension-meta.js';
export {
  BOOLEAN_OPS,
  BUILTIN_OPERATORS,
  CROSSREF_OPS,
  fullBuiltinOperators,
  JSON_PATH_OPS,
  LIST_OPS,
  NUMBER_OPS,
  STRING_OPS
} from './builtin-operators.js';
export {
  CursorDecodeError,
  type CursorOrder,
  type CursorPayload,
  decodeCursor,
  encodeCursor
} from './cursor.js';
export {
  clearExtensionOperators,
  computedFieldOwner,
  getExtensionOperator,
  hasComputedFields,
  listExtensionOperators,
  registerExtensionOperator,
  unregisterExtensionOperator,
  whereContainsExtensionOperator,
  whereContainsOperator
} from './extension-operators.js';
export {
  assertJsonPathPredicate,
  evaluateJsonPathPredicate,
  isJsonPathPredicate,
  JSON_PATH_INDEXED_IN_MAX,
  JSON_PATH_MAX_DEPTH,
  JSON_PATH_MAX_IN,
  type JsonPathPredicate,
  jsonPathNeedsScan,
  jsonPathOperandProblem,
  jsonPathProblem,
  resolveJsonPath
} from './json-path.js';
export {
  type ExtensionOpContext,
  ExtensionOperatorResultError,
  type ExtensionOpResultMeta,
  preResolveExtensionOperatorsDetailed
} from './pre-resolve-extension-operators.js';
export {
  asSortValue,
  assertWhereHonourable,
  compareFilterValues,
  evaluateWhere,
  type FieldDefOf,
  getFieldValue,
  isDateField
} from './predicate.js';
