/**
 * @mnmal-ai/substrate-dataset-pg — Postgres-backed reference Dataset + EdgesStore.
 */

export type { IndexDecl } from '@mnmal-ai/substrate-types';
export { tryWithPgAdvisoryLock } from './advisory-lock.js';
export { copyRows, type Misfit, parseSourceBody, type SourceRow } from './copy-rows.js';
export { type DiskGuard, makeDiskGuard } from './disk-guard.js';
export {
  NamespaceMismatch,
  queryTimeoutError,
  ReservedField,
  timeoutAware
} from './errors.js';
export {
  desiredIndexKeys,
  type HeldIndex,
  IndexDefinitionConflictError,
  type IndexState,
  type ReconcileTypeIndexesArgs,
  reconcileTypeIndexes,
  typeIndexesOf,
  UniqueIndexDuplicatesError
} from './index-reconciler.js';
export {
  columnName,
  type DetectedLayout,
  detectLayout,
  type StorageLayout,
  typeTableName
} from './layout.js';
export {
  assertNotMigrating,
  assertStoreSchema,
  assertTablesLayout,
  deriveListIndexMigration,
  getMigrationList,
  type IndexedListField,
  isDerivedMigration,
  MIGRATE_STORE_MARKER_TABLE,
  MigrationChecksumDriftError,
  type MigrationInput,
  NoCurrentSchemaError,
  PLAIN_SCHEMA_NAME,
  pendingMigrations,
  type RunMigrationsOptions,
  runDerivedMigrations,
  runMigrations,
  StoreMigrationInProgressError,
  UnsupportedSchemaNameError,
  UnsupportedStoreLayoutError
} from './migrate.js';
export {
  type FieldDefLookup,
  PgDataset,
  type PgDatasetOptions,
  type TypeDefLookup
} from './pg-dataset.js';
export { PgEdgesStore, type PgEdgesStoreOptions } from './pg-edges-store.js';
export {
  PgIdempotencyStore,
  type PgIdempotencyStoreOptions
} from './pg-idempotency-store.js';
export { PgShortIdStore, seqName } from './pg-short-id-store.js';
export {
  type PromotePendingFieldsOptions,
  promotePendingFields
} from './promote.js';
export {
  assertServerVersion,
  UnsupportedServerVersionError
} from './server-version.js';
export { type PgHandle, txScopeIdFor } from './tx-scope.js';
export {
  type ColumnKind,
  columnKindOf,
  ensureTypeTable,
  FieldKindChangedError,
  guardedRefRead,
  loadTypeTable,
  type TableCache,
  type TypedColumn,
  type TypeTable,
  type TypeTableChange,
  type TypeTableRef,
  typeTableRef,
  whileNoTypeTable
} from './type-table.js';
export { UUID_CHECK_MIGRATION, UUID_REGEX } from './uuid-check.js';
