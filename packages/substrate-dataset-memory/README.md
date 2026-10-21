# @mnmal-ai/substrate-dataset-memory

Internal: bundled into `@mnmal-ai/substrate` and not published; its public surface is `@mnmal-ai/substrate/testing` (`MemoryDataset`).

In-memory `Dataset` for tests and ephemeral use.

Holds rows in process memory, evaluates filters in-process, and supports the same autoCRUD and edges surface as `@mnmal-ai/substrate-dataset-pg`, so a full Substrate can run without Postgres. Everything is lost on restart.

## Where it fits

Selected with `SUBSTRATE_DATABASE_URL=memory`, and also used when `SUBSTRATE_DATABASE_URL` is unset; the binary prints a banner at boot saying data will not persist. The cross-server parity suite runs the same scenarios against this dataset and the Postgres one to keep them behaviourally identical.

## More

- Spec: §4.5 (dataset), [`docs/substrate-from-first-principles.md`](../../docs/substrate-from-first-principles.md)
- Source: `packages/substrate-dataset-memory/src/`
