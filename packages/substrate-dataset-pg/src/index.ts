/**
 * @mnmal-ai/substrate-dataset-pg — Postgres-backed reference Dataset + EdgesStore.
 */

export type { IndexDecl } from '@mnmal-ai/substrate-types';
export { tryWithPgAdvisoryLock } from './advisory-lock.js';
export { type DiskGuard, makeDiskGuard } from './disk-guard.js';
export {
  type EnumCheckInput,
  type EnumCheckStatements,
  enumCheckStatements
} from './enum-check.js';
export { NamespaceMismatch, ReservedField } from './errors.js';
export {
  desiredIndexKeys,
  type HeldIndex,
  IndexDefinitionConflictError,
  IndexDropRefusedError,
  type IndexState,
  type ReconcileTypeIndexesArgs,
  reconcileTypeIndexes,
  typeIndexesOf,
  UniqueIndexDuplicatesError
} from './index-reconciler.js';
export { detectLayout, partitionName, type StorageLayout } from './layout.js';
export {
  assertNotMigrating,
  assertStoreSchema,
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
  StorageLayoutMismatchError,
  StoreMigrationInProgressError,
  UnsupportedSchemaNameError,
  UUID_CHECK_MIGRATION,
  UUID_REGEX
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
export type {
  PromotedBodyColumn,
  PromotedBodyColumnMap,
  PromotedColumnLookup
} from './pg-sql.js';
export {
  assertServerVersion,
  MIN_SERVER_VERSION_NUM,
  UnsupportedServerVersionError
} from './server-version.js';
export { type PgHandle, txScopeIdFor } from './tx-scope.js';
export { TypeStorageLockTimeoutError } from './type-storage.js';
