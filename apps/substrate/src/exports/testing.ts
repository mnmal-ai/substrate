// `@mnmal-ai/substrate/testing`: an in-process server for plugin tests, the
// Postgres dataset and migrations for composing over a real database, and the
// guards a Postgres-backed suite runs before touching its database.
export {
  type AuthConfig,
  type ComposeResult,
  compose,
  signHs256
} from '@mnmal-ai/substrate-compose';
export { loadPlugins, MemoryEdgesStore } from '@mnmal-ai/substrate-core';
export { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
export {
  deriveListIndexMigration,
  type FieldDefLookup,
  type IndexedListField,
  PgDataset,
  type PgDatasetOptions,
  PgEdgesStore,
  type PgEdgesStoreOptions,
  runDerivedMigrations,
  runMigrations
} from '@mnmal-ai/substrate-dataset-pg';
export * from '@mnmal-ai/substrate-dataset-pg/testing';
export { FakeEmbedder } from '@mnmal-ai/substrate-embedder/fake';
export * from '@mnmal-ai/substrate-server-memory';
