// `@mnmal-ai/substrate/testing`: an in-process server for plugin tests, and the
// guards a Postgres-backed suite runs before touching its database.
export {
  type AuthConfig,
  type ComposeResult,
  compose,
  signHs256
} from '@mnmal-ai/substrate-compose';
export { loadPlugins, MemoryEdgesStore } from '@mnmal-ai/substrate-core';
export { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
export * from '@mnmal-ai/substrate-dataset-pg/testing';
export { FakeEmbedder } from '@mnmal-ai/substrate-embedder/fake';
export * from '@mnmal-ai/substrate-server-memory';
