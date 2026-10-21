/**
 * @mnmal-ai/substrate-sdk — runtime SDK.
 *
 * Exports the autoCRUD resolver factory (§5.1), the `field` DSL (§6.1),
 * and the `defineNamespace` helper (§5.11). Policy combinators (§4.4) live in
 * `@mnmal-ai/substrate-policy`.
 */

export * from './autocrud/index.js';
export {
  RESERVED_AUTOCRUD_FIELD_NAMES,
  RESERVED_AUTOCRUD_FIELDS
} from './autocrud/reserved.js';
export { resolveIdentity, UnattributedWriteError } from './autocrud/resolve-identity.js';
export {
  type DeleteRowArgs,
  type DeleteRowResult,
  deleteRow
} from './delete.js';
export { EngineQueryError, makeCtx, queryAll, queryOne, selectAll } from './engine-helpers.js';
export {
  type CrossRefFieldOptions,
  type DateFieldOptions,
  field,
  type JsonFieldOptions,
  type ListFieldOptions,
  type ScalarFieldOptions,
  type StructFieldOptions
} from './field.js';
export {
  type DefineNamespaceOptions,
  defineNamespace,
  type PostWriteHook,
  type TypeInput
} from './namespace.js';
export { resolveEntityId, resolveEntityRow } from './short-id-resolver.js';
