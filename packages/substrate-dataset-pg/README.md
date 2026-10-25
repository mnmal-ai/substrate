# @mnmal-ai/substrate-dataset-pg

Internal: bundled into `@mnmal-ai/substrate` and not published; it is not part of the public surface, except its test-database guards, which `@mnmal-ai/substrate/testing` exports.

PostgreSQL implementation of `Dataset` (spec §4.5), with the edges, idempotency and short-id stores.

Selected by the binary when `SUBSTRATE_DATABASE_URL` is a `postgres://` URL. Migrations in `src/migrations/` apply idempotently at boot.

## Schema

Rows of every type share one table. The dataset does not know a type's shape at migration time, so the row body is opaque JSONB:

```sql
CREATE TABLE rows (
  namespace        text        NOT NULL,
  type             text        NOT NULL,
  id               text        NOT NULL,
  body             jsonb       NOT NULL,
  deleted_at       timestamptz NULL,
  created_at       timestamptz NULL,
  updated_at       timestamptz NULL,
  created_by_kind  text        NULL,  -- 'agent' | 'user' | 'system'
  created_by_id    text        NULL,
  updated_by_kind  text        NULL,
  updated_by_id    text        NULL,
  PRIMARY KEY (namespace, type, id)
);
```

`0001_baseline` creates it, with `edges` (cross-ref edges), `idempotency` and `short_ids`. `0002_uuid_format_check` adds UUID-format CHECKs on row and edge ids, and runs only when `SUBSTRATE_ENFORCE_UUID_CHECK=true`. A plugin that promotes fields out of `body` into columns adds them in its own migration and declares them as `promotedColumns`. Kernel plugins add their own tables; `substrate-recall` owns `embeddings`.

## Layouts

`SUBSTRATE_STORAGE_LAYOUT` picks how `rows` is stored when the database has none yet: `partitioned` (the default) or `legacy`. A database keeps the layout it was created with; booting against a mismatched ledger throws `StorageLayoutMismatchError`.

- `legacy`: one plain `rows` table, as above (`0001_baseline`).
- `partitioned` (`0001p_partitioned_baseline`): `rows` is `LIST(namespace)`, each namespace partition is `LIST(type)`, and each level has a DEFAULT partition. Same columns and side tables. A type's partition is created, and its rows moved out of DEFAULT, by `ensureTypeStorage`; rows are readable from DEFAULT meanwhile. The move holds the parent lock briefly and retries on lock timeout, raising `TypeStorageLockTimeoutError` if it cannot get through.

**Plugin DDL on `rows`.** On the partitioned layout, `CREATE INDEX` (or any DDL) on the parent `rows` fans out to every partition of every namespace and type, and cannot be built concurrently. Index a type through `indexes` on its definition instead, which builds on that type's partition only. `storageReport` lists indexes on the parent as fan-out. A promoted text column compares under `COLLATE "C"`, so a hand-written index on it must key `(col COLLATE "C")` to serve `eq`.

## Indexes

The reconciler (`reconcileTypeIndexes`) builds each type's indexes at boot and keeps them matching what the namespace declares. On the partitioned layout that is every `indexed: true` field, the timestamp and tombstone indexes, and the declared `indexes`, all on the type's partition. On legacy it is only the declared ones, as partial indexes on `rows` scoped to the type. All are partial: live rows only (`deleted_at IS NULL`), except the tombstone index, which covers deleted rows (`deleted_at IS NOT NULL`). Filters, sorts and indexes use the same expression from the filter compiler.

- Each desired index is compared by name with the catalog. Identical is kept; same key fields and uniqueness with a different expression or predicate is swapped (built under a `__swap` name, old one dropped only once the new one is valid, then renamed, so uniqueness is enforced throughout); anything else is refused with `IndexDefinitionConflictError`. A unique index over existing duplicates is refused with `UniqueIndexDuplicatesError`.
- Every non-unique btree ends in `id` ascending, so a filter plus the default page order is one range scan. Unique indexes do not.
- Implicit date indexes are `DESC NULLS LAST`; an oldest-first date sort needs a declared ASC index. Promoted text columns compare and index under `COLLATE "C"`.
- Builds are `CONCURRENTLY` under the migration lock. The server builds unique indexes before it starts, and fails the boot if one cannot be built. It builds non-unique ones after it starts, in the background, one type at a time (`ensureTypeStorage(type, { indexes: 'unique' | 'nonUnique' })`). Until one is valid, filters it would serve scan, and `describeStorage` and `storageReport` report it `pending`, `building` or `failed`; a failed build is retried by the next reconcile, which first drops the INVALID index it left.
- The first boot after a release that changes an index's shape rebuilds each affected non-unique index that way, needing twice that index's disk while it runs (about 6.4 minutes for 25M rows across 19 indexes, measured on a test host).
- One `CREATE STATISTICS` per indexed body expression is owned by the reconciler, with an `ANALYZE` when it creates one: the planner ignores expression statistics on partial indexes, so without it body-field equality estimates collapse to a flat guess.
- Keyset paging is index-served for `id` and for a nullable leading sort key (range bound, then the null tail).

## Safe casts

`0003_safe_casts` adds `substrate_num(jsonb)` and `substrate_ts(jsonb)`, used by sorts and index expressions over untyped body fields. Both are `IMMUTABLE` and `PARALLEL SAFE`, return NULL for a wrong-shaped value instead of raising, and are schema-qualified throughout (`pg_catalog.` operators and types) so the caller's `search_path` cannot change what they do. `substrate_ts` accepts only ISO timestamps with an explicit offset, which is what makes it immutable regardless of `TimeZone` and `DateStyle`.

## Running tests

With `POSTGRES_URL` unset, the integration suite is skipped and the test command exits cleanly, so CI without Postgres can still run `pnpm test`.

The suites run destructive setup (TRUNCATE, DELETE, DDL), so three guards from `@mnmal-ai/substrate-dataset-pg/testing` run first and refuse to start unless:

1. the database name ends in `_test` or `_dev` (`assertTestDatabase`);
2. the role is not a superuser (`assertNotSuperuser`);
3. the role cannot write to any non-test database (`assertCannotWriteOutsideTestDatabases`).

Each pg-gated package then runs in a schema of its own inside that database, so packages can run concurrently.

A throwaway setup that satisfies the guards:

```bash
docker run --rm -d --name substrate-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 pgvector/pgvector:pg17

docker exec substrate-pg psql -U postgres \
  -c "CREATE ROLE substrate_test LOGIN PASSWORD 'substrate_test'" \
  -c "CREATE DATABASE substrate_test OWNER substrate_test"
docker exec substrate-pg psql -U postgres -d substrate_test -c "CREATE EXTENSION IF NOT EXISTS vector"

POSTGRES_URL=postgres://substrate_test:substrate_test@localhost:5432/substrate_test \
  pnpm --filter @mnmal-ai/substrate-dataset-pg test
```

The `vector` extension is only needed by suites that touch embeddings (for example `substrate-recall`'s), but creating it up front lets the same database serve every package.
