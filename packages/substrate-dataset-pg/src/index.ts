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
  engineIndexesOf,
  type HeldIndex,
  IndexDefinitionConflictError,
  type IndexState,
  type ReconcileTypeIndexesArgs,
  reconcileTypeIndexes,
  typeIndexesOf,
  UniqueIndexDuplicatesError
} from './index-reconciler.js';
export { detectLayout, partitionName, type StorageLayout } from './layout.js';
export {
  deriveListIndexMigration,
  type IndexedListField,
  MigrationChecksumDriftError,
  type MigrationInput,
  pendingMigrations,
  type RunMigrationsOptions,
  runDerivedMigrations,
  runMigrations,
  StorageLayoutMismatchError
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
export { PgShortIdStore } from './pg-short-id-store.js';
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
