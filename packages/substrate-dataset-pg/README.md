# @mnmal-ai/substrate-dataset-pg

Internal: bundled into `@mnmal-ai/substrate` and not published; it is not part of the public surface, except its test-database guards, which `@mnmal-ai/substrate/testing` exports.

PostgreSQL implementation of `Dataset` (spec §4.5), with the edges, idempotency and short-id stores.

Selected by the binary when `SUBSTRATE_DATABASE_URL` is a `postgres://` URL. Migrations in `src/migrations/` apply idempotently at boot. The server must be PostgreSQL 18 or newer: `runMigrations` refuses an older one with `UnsupportedServerVersionError` before touching the store.

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

**Plugin DDL on `rows`.** On the partitioned layout, `CREATE INDEX` (or any DDL) on the parent `rows` fans out to every partition of every namespace and type, and cannot be built concurrently. Index a type through `indexes` on its definition instead, which builds on that type's partition only. `storageReport` lists indexes and CHECK constraints on the parent as fan-out. A promoted text column compares under `COLLATE "C"`, so a hand-written index on it must key `(col COLLATE "C")` to serve `eq`.

## Indexes

The reconciler (`reconcileTypeIndexes`) builds each type's indexes at boot and keeps them matching what the namespace declares. On the partitioned layout that is a derived btree per crossRef (unless `indexed: false`) and per `indexed: true` scalar, keyed `(field, natural order, id)`, GIN indexes for `indexed: true` list and json fields, the timestamp and tombstone indexes, and the declared `indexes`, all on the type's partition. A type's natural order (`orderedBy`, default `createdAt desc`) shapes the derived ones; on a visible-order type a `(seq, id)` index serves reads in commit order. A scalar with `indexed` unset gets none, so a filter or sort on it scans: nothing refuses it. On legacy it is the derived and declared ones, as partial indexes on `rows` scoped to the type. All are partial: live rows only (`deleted_at IS NULL`), except the tombstone index, which covers deleted rows (`deleted_at IS NOT NULL`). Filters, sorts and indexes use the same expression from the filter compiler.

- Each desired index is compared by name with the catalog. Identical is kept; same key fields and uniqueness with a different expression or predicate is swapped (built under a `__swap` name, old one dropped only once the new one is valid, then renamed, so uniqueness is enforced throughout); anything else is refused with `IndexDefinitionConflictError`. A unique index over existing duplicates is refused with `UniqueIndexDuplicatesError`.
- Every non-unique btree ends in `id` ascending, so a filter plus the default page order is one range scan. Unique indexes do not.
- Natural order on a body date or number uses the filter compiler's expression, `NULLS LAST` in either direction; on a metadata column it uses the column. Other date sorts the type's order does not match need a declared index. Promoted text columns compare and index under `COLLATE "C"`.
- Builds are `CONCURRENTLY`, each under its table's index-build lock (two concurrent builds on one table deadlock); unique ones also hold the migration lock, non-unique ones never do. An index already as declared takes no lock. The server builds unique indexes before it starts, and fails the boot if one cannot be built. It builds non-unique ones after it starts, in the background, one type at a time (`ensureTypeStorage(type, { indexes: 'unique' | 'nonUnique' })`). Until one is valid, filters it would serve scan, and `describeStorage` and `storageReport` report it `pending`, `building` or `failed`; a failed build is retried by the next reconcile, which first drops the INVALID index it left.
- The first boot after a release that changes an index's shape (this one moves every derived index from `(field, id)` to `(field, natural order, id)`) rebuilds each affected non-unique index that way, one at a time, needing twice that index's disk while it runs (about 6.4 minutes for 25M rows across 19 indexes, measured on a test host).
- **Disk guard.** Before each non-unique build the dataset checks free space on the database volume against the build's estimate plus a margin. The estimate is the size of the index being replaced (a leftover `__swap` index counts as the old one), else 30% of the table; it excludes the temporary space the sort uses. When there is not room the build waits and is reported `pending` with `insufficient_disk`. The volume is `SUBSTRATE_INDEX_DISK_PATH` (`off` for a database with no local volume; unset also checks nothing and `storageReport` warns), the margin `SUBSTRATE_INDEX_DISK_MARGIN_MB` (default 2048; `0` requires only the estimate), and the binary retries pending and failed builds every `SUBSTRATE_INDEX_RETRY_INTERVAL_MS` (default 600000; `0` leaves them to the next boot).
- One `CREATE STATISTICS` per indexed body expression is owned by the reconciler, with an `ANALYZE` when it creates one: the planner ignores expression statistics on partial indexes, so without it body-field equality estimates collapse to a flat guess.
- Keyset paging is index-served for `id` and for a nullable leading sort key (range bound, then the null tail). A cursor carries its order and is refused with `invalid_cursor` under any other.
- A range on one field sorted by another has no single serving btree; the planner scans one side. See the plugin author guide's Indexes section.
- Advisor and `propose_index`: the binary's advisor writes `_system/IndexRecommendation` rows from read shapes and `typeStats`/`indexPlan`; `dropEngineIndex` is what a signed `propose_index remove` calls, and drops only an engine-owned, non-unique index nothing wants (`DROP INDEX CONCURRENTLY`). `storageReport.info` lists open recommendations, which `substrate-admin doctor` shows but does not count as a fault.

## Safe casts

`0003_safe_casts` adds `substrate_num(jsonb)` and `substrate_ts(jsonb)`, used by sorts and index expressions over untyped body fields. Both are `IMMUTABLE` and `PARALLEL SAFE`, return NULL for a wrong-shaped value instead of raising, and are schema-qualified throughout (`pg_catalog.` operators and types) so the caller's `search_path` cannot change what they do. `substrate_ts` accepts the ISO dates and date-times the write validator accepts, and rebuilds each with an explicit offset before the cast, which is what makes it immutable regardless of `TimeZone` and `DateStyle`. A date with no offset is read as UTC, so writers should send an offset or `Z`.

## Ids and visible order

New row ids come from the database's `uuidv7()`. A v7 id is not a happened-before signal, sorts in creation order only within one connection, and reveals its creation time; deciding who won uses transaction time or a per-row version. A batch that repeats a supplied id is refused on upsert (under `insertOnly`, skipped). `shortId` is a per-store handle, not portable between stores.

A type declared `ordering: 'visible'` gets `rows.seq` from `visible_seqs`, assigned under a per-type transaction lock held to commit, so writers of that type are serialised and `seq` order is commit order. Writing two visible types in opposite orders can deadlock (`40P01`). Rows that predate the option keep a null `seq` and sort after new ones. The counter never decreases, so a dropped and re-created type continues it.

## Upgrading

**PostgreSQL 18 is the minimum.** `runMigrations` refuses an older server. A store on 17 moves in one of two ways. Stop every substrate instance first.

- `pg_upgrade --link`, which needs no second copy of the data:
  1. Take a rollback copy first: `pg_dumpall` (or a filesystem or volume snapshot) to a disk with room.
  2. Stop the server, and the old cluster.
  3. Install the PG 18 binaries and pgvector for 18 beside the old ones, and `initdb` a new cluster. Check the old cluster with `pg_controldata`: if "Data page checksum version" is 0, use `initdb --no-data-checksums`, because PG 18 enables checksums by default and `pg_upgrade` refuses the mismatch.
  4. Run `pg_upgrade --check` with `--old-datadir`, `--new-datadir`, `--old-bindir` and `--new-bindir`, then the same command with `--link`.
  5. Start the new cluster and verify it. `pg_upgrade` carries planner statistics except extended statistics, so run `vacuumdb --all --analyze-in-stages` afterwards.
  6. Delete the old cluster and the dump only after that.

  Once the new cluster has started, the old one cannot be used, because linked files are shared. Rolling back from then on means restoring the dump.
- `--copy` or `--clone` instead of `--link` leave the old cluster usable, at the cost of disk (`--clone` only where the filesystem supports it).
- Dump and restore: `pg_dumpall` (or `pg_dump -Fc` per database) from the old server, restored into a new PG 18 server. The old server is untouched.

For a docker volume, the PG 18 images keep data in a major-version subdirectory (`/var/lib/postgresql/18/…`), so mount the volume at `/var/lib/postgresql`, not `/var/lib/postgresql/data` (the repository's compose file and `substrate init` do). An old volume cannot simply be re-pointed at the new image: dump from a PG 17 container, start an empty PG 18 volume, and restore into it (or run `pg_upgrade` with both versions' binaries in one container).

After upgrading, the first boot builds indexes in the background under the disk guard above. On the partitioned layout it swaps each derived index to its new shape. On the legacy layout it builds a new partial index on the shared `rows` for each crossRef (and each `indexed: true` field) of each type, each a full scan of `rows` estimated at 30% of its size, plus one `ANALYZE rows` per type that gains statistics. Two steps are required before that first boot on an existing store:

1. Stop every substrate instance on the store. Migration `0004` adds a column to `rows`, which waits behind any open query or index build and then blocks every reader and writer.
2. Set `SUBSTRATE_INDEX_DISK_PATH` to the mount of the PostgreSQL data directory. Unset, the guard checks nothing, and the boot logs how many builds are pending and their estimated total.

See the plugin author guide.

### Advisory locks

Advisory-lock keys (migration, index build, type storage, short-id sequences, `withAdvisoryLock`) are scoped to the current schema, so a process on an earlier release, which uses unscoped keys, does not exclude one on this release: stop every instance on a store before starting the new release.

## Running tests

With `POSTGRES_URL` unset, the integration suite is skipped and the test command exits cleanly, so CI without Postgres can still run `pnpm test`.

The suites run destructive setup (TRUNCATE, DELETE, DDL), so three guards from `@mnmal-ai/substrate-dataset-pg/testing` run first and refuse to start unless:

1. the database name ends in `_test` or `_dev` (`assertTestDatabase`);
2. the role is not a superuser (`assertNotSuperuser`);
3. the role cannot write to any non-test database (`assertCannotWriteOutsideTestDatabases`).

Each pg-gated package then runs in a schema of its own inside that database, so packages can run concurrently.

A throwaway setup that satisfies the guards:

```bash
docker run --rm -d --name substrate-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 pgvector/pgvector:pg18

docker exec substrate-pg psql -U postgres \
  -c "CREATE ROLE substrate_test LOGIN PASSWORD 'substrate_test'" \
  -c "CREATE DATABASE substrate_test OWNER substrate_test"
docker exec substrate-pg psql -U postgres -d substrate_test -c "CREATE EXTENSION IF NOT EXISTS vector"

POSTGRES_URL=postgres://substrate_test:substrate_test@localhost:5432/substrate_test \
  pnpm --filter @mnmal-ai/substrate-dataset-pg test
```

The `vector` extension is only needed by suites that touch embeddings (for example `substrate-recall`'s), but creating it up front lets the same database serve every package.
