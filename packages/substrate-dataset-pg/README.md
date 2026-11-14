# @mnmal-ai/substrate-dataset-pg

Internal: bundled into `@mnmal-ai/substrate` and not published; it is not part of the public surface, except its test-database guards, which `@mnmal-ai/substrate/testing` exports.

PostgreSQL implementation of `Dataset` (spec §4.5), with the edges, idempotency and short-id stores.

Selected by the binary when `SUBSTRATE_DATABASE_URL` is a `postgres://` URL. Migrations in `src/migrations/` apply idempotently at boot. The server must be PostgreSQL 18 or newer: `runMigrations` refuses an older one with `UnsupportedServerVersionError` before touching the store.

## Schema

Each type has a table of its own, created on its first write or at boot (`ensureTypeTable`), named `t__<ns>__<type>` (folded, and hashed when folding changed it or it is too long). It has the row's metadata columns, a typed column `f_<field>` for each declared scalar or crossRef field, and `extra jsonb` for everything else:

```sql
CREATE TABLE t__cortext__todo (
  id               text        PRIMARY KEY,
  deleted_at       timestamptz NULL,
  created_at       timestamptz NULL,
  updated_at       timestamptz NULL,
  created_by_kind  text        NULL,  -- 'agent' | 'user' | 'system'
  created_by_id    text        NULL,
  updated_by_kind  text        NULL,
  updated_by_id    text        NULL,
  seq              bigint      NULL,
  extra            jsonb       NOT NULL DEFAULT '{}',
  f_title          text COLLATE "C"   -- one per declared column field
);
```

`0001t_tables_baseline` creates the shared tables: `row_ids` (every row's `(namespace, type, id)`, which `short_ids` reference), `edges` (cross-ref edges), `idempotency`, `visible_seqs`, and the type catalog `substrate_type_tables` and `substrate_type_fields`. `0002t_uuid_format_check` adds UUID-format CHECKs on row and edge ids, and runs only when `SUBSTRATE_ENFORCE_UUID_CHECK=true`. Kernel plugins add their own tables; `substrate-recall` owns `embeddings`.

A declared field is in one of four states in `substrate_type_fields`: `column`; `pending`, its values in `extra` until the promotion sweep gives it a column; `promoting`, the column exists and values are still moving out of `extra`; `orphaned`, no longer declared, its column kept and its values readable as extras. A kind change in code refuses boot with `FieldKindChangedError`. Every server process runs the sweep, but each field is swept by one at a time (an advisory try-lock; a held field is skipped). A `promoting` or `column` field that failed on a unique conflict is not swept again until its type's catalog changes, or until an operator runs `substrate-admin promote-fields` (`retryConflicts`) after fixing the data.

Every write checks its type table's catalog version in the same statement and is retried (up to 3 times) when a promotion moved the table on; every read checks the version of each table it decodes and reruns when stale. The write check is only sound under READ COMMITTED, so a write in a REPEATABLE READ or SERIALIZABLE transaction is refused and writes nothing.

## Layouts

`tables` is the only layout this release boots. A store in an old layout, `legacy` (one `rows` table) or `partitioned` (`rows` partitioned by namespace and type), is refused before anything changes, with `UnsupportedStoreLayoutError` naming `substrate-admin migrate-store`, which copies it into a fresh store and only reads it. `SUBSTRATE_STORAGE_LAYOUT` is no longer read.

**Plugin DDL.** There is no `rows` table to alter or index: a kernel migration that runs DDL on it fails, and the host names the plugin (`KernelMigrationLayoutError`). Index a type through `indexes` on its definition instead, which builds on that type's table only. `promotedColumns` is deprecated and ignored: every declared scalar is a column.

## Indexes

The reconciler (`reconcileTypeIndexes`) builds each type's indexes at boot and keeps them matching what the namespace declares: a derived btree per crossRef (unless `indexed: false`) and per `indexed: true` scalar, keyed `(field, natural order, id)`, GIN indexes for `indexed: true` list and json fields over `extra`, the timestamp and tombstone indexes, and the declared `indexes`, all on the type's table, where a column field keys on its column. A type's natural order (`orderedBy`, default `createdAt desc`) shapes the derived ones; on a visible-order type a `(seq, id)` index serves reads in commit order. A scalar with `indexed` unset gets none, so a filter or sort on it scans: nothing refuses it. An index over a field not yet `column` is reported `pending` and serves no read. All are partial: live rows only (`deleted_at IS NULL`), except the tombstone index, which covers deleted rows (`deleted_at IS NOT NULL`). Filters, sorts and indexes use the same expression from the filter compiler.

- Each desired index is compared by name with the catalog. Identical is kept; same key fields and uniqueness with a different expression or predicate is swapped (built under a `__swap` name, old one dropped only once the new one is valid, then renamed, so uniqueness is enforced throughout); anything else is refused with `IndexDefinitionConflictError`. A unique index over existing duplicates is refused with `UniqueIndexDuplicatesError`.
- Every non-unique btree ends in `id` ascending, so a filter plus the default page order is one range scan. Unique indexes do not.
- Natural order on a date or number field uses its column, `NULLS LAST` in either direction, as it does on a metadata column. Other date sorts the type's order does not match need a declared index. Text and enum columns compare and index under `COLLATE "C"`.
- Builds are `CONCURRENTLY`, each under its table's index-build lock (two concurrent builds on one table deadlock); a unique one is chosen under the migration lock, which is released before its duplicate check and build, so no build holds up another process's boot or migrations. An index already as declared takes no lock. The server builds unique indexes before it starts, and fails the boot if one cannot be built. It builds non-unique ones after it starts, in the background, one type at a time (`ensureTypeStorage(type, { indexes: 'unique' | 'nonUnique' })`). Until one is valid, filters it would serve scan, and `describeStorage` and `storageReport` report it `pending`, `building` or `failed`; a failed build is retried by the next reconcile, which first drops the INVALID index it left.
- The first boot after a release that changes an index's shape rebuilds each affected non-unique index that way, one at a time, needing twice that index's disk while it runs. When an earlier release moved every derived index from `(field, id)` to `(field, natural order, id)`, that took about 6.4 minutes for 25M rows across 19 indexes, measured on a test host. A store copied by `migrate-store` gets its indexes in their current shape.
- **Disk guard.** Before each non-unique build the dataset checks free space on the database volume against the build's estimate plus a margin. The estimate is the size of the index being replaced (a leftover `__swap` index counts as the old one), else 30% of the table; it excludes the temporary space the sort uses. When there is not room the build waits and is reported `pending` with `insufficient_disk`. The volume is `SUBSTRATE_INDEX_DISK_PATH` (`off` for a database with no local volume; unset also checks nothing and `storageReport` warns), the margin `SUBSTRATE_INDEX_DISK_MARGIN_MB` (default 2048; `0` requires only the estimate), and the binary retries pending and failed builds every `SUBSTRATE_INDEX_RETRY_INTERVAL_MS` (default 600000; `0` leaves them to the next boot).
- Keyset paging is index-served for `id` and for a nullable leading sort key (range bound, then the null tail). A cursor carries its order and is refused with `invalid_cursor` under any other.
- A range on one field sorted by another has no single serving btree; the planner scans one side. See the plugin author guide's Indexes section.
- Advisor and `propose_index`: the binary's advisor writes `_system/IndexRecommendation` rows from read shapes and `typeStats`/`indexPlan`; `dropEngineIndex` is what a signed `propose_index remove` calls, and drops only an engine-owned, non-unique index nothing wants (`DROP INDEX CONCURRENTLY`). `storageReport.info` lists open recommendations, which `substrate-admin doctor` shows but does not count as a fault.

## Safe casts

The baseline adds `substrate_num(jsonb)` and `substrate_ts(jsonb)`, used by filters, sorts and index expressions over values held in `extra`. Both are `IMMUTABLE` and `PARALLEL SAFE`, return NULL for a wrong-shaped value instead of raising, and are schema-qualified throughout (`pg_catalog.` operators and types) so the caller's `search_path` cannot change what they do. `substrate_ts` accepts every ISO date and date-time in the shared grammar, and rebuilds each with an explicit offset before the cast, which is what makes it immutable regardless of `TimeZone` and `DateStyle`. A stored date with no offset is read as UTC; writes and filter operands must carry a time and an offset, so only rows written before 1.0.0-beta.1 can lack one.

## Ids and visible order

New row ids come from the database's `uuidv7()`. A v7 id is not a happened-before signal, sorts in creation order only within one connection, and reveals its creation time; deciding who won uses transaction time or a per-row version. A batch that repeats a supplied id is refused on upsert (under `insertOnly`, skipped). `shortId` is a per-store handle, not portable between stores.

A type declared `ordering: 'visible'` gets its table's `seq` from `visible_seqs`, assigned under a per-type transaction lock held to commit, so writers of that type are serialised and `seq` order is commit order. Writing two visible types in opposite orders can deadlock (`40P01`). Rows that predate the option keep a null `seq` and sort after new ones. The counter never decreases, so a dropped and re-created type continues it.

## Upgrading

**PostgreSQL 18 is the minimum.** `runMigrations` refuses an older server. **A store in an old layout must be copied.** This release boots only per-type tables, so a `legacy` or `partitioned` store, on any PostgreSQL version, moves with `substrate-admin migrate-store`. Every instance that shares a store upgrades together.

The step-by-step procedure (stage, rehearse on a copy, window, verify, rollback) is in [Upgrading to per-type tables](../../docs/upgrading-to-type-tables.md), and the choices it involves are in [Operator decisions](../../docs/operator-decisions.md#upgrading). This section is the command's reference.

### `substrate-admin migrate-store`

`migrate-store` copies a store into a fresh, empty PostgreSQL 18 store on per-type tables, builds its indexes and verifies the copy against the source. It is the way to PG 18 and to the tables layout in one step, and the source is never written, so rolling back is pointing an older release at it again. The source may be PG 17 or later, on either old layout. A value its declared column cannot hold is kept under `$raw` and reported as a misfit, never dropped.

| Flag | Effect |
|---|---|
| `--from-env <VAR>` / `--to-env <VAR>` | Name the variables that hold the source and target connection strings (defaults `SUBSTRATE_MIGRATE_FROM_URL`, `SUBSTRATE_MIGRATE_TO_URL`). |
| `--from-schema <s>` / `--to-schema <s>` | Pin a side to schema `<s>`. The name must be plain lowercase (`[a-z_][a-z0-9_]*`). This allows a copy within one database; the source and target may not be the same cluster, database and schema. |
| `--dry-run` | Preflight only. Writes nothing. |
| `--verify-only` | Build the indexes (unless `--skip-index-build`), then verify an existing finished copy against its source. This finishes a run whose index builds or verification failed. Refused on a target with no completed copy. |
| `--skip-index-build` | Leave non-unique index builds to the first `serve` boot, which runs them under the disk guard. The pending builds are listed in the report. |
| `--full-checksum` | Hash every row's content. By default the content of 1000 rows per type is hashed; row counts, the id set and every row's `updated_at` and `deleted_at` are checked either way. |
| `--batch-rows <n>` | Rows between progress lines (default 10000). It does not change how the copy is chunked: a rerun restarts the copy from the beginning. |
| `--skip-table <t>` | Waive a source table that nothing declares. Repeatable. Naming a table the run copies (an engine table or one a loaded plugin declares) is refused at preflight. |
| `--json` | The final report as one JSON object on stdout; progress goes to stderr. |

Exit codes: `0` copied and verified, `2` refused or a usage error (nothing was written to the target), `3` verification failed, `1` any other failure.

What to know before a real run:

- A read-only role is enough for the source, and the command opens it read-only.
- A live source is refused: while the command sees other sessions on the source database it names them and stops (a dry run only warns), because writes after its snapshot are not copied.
- `SUBSTRATE_SYSTEM_ACTOR` is not needed; copied rows keep their source metadata.
- The `idempotency` table is not copied; neither are the migration ledgers, which the target builds for itself.
- Rerunning after an interruption restarts the copy cleanly: it empties the planned tables and copies again. Until a run has verified, the target keeps an in-progress marker, and `serve` and the key-management commands refuse it. After a failed verification (exit `3`) the marker stays.
- A source table that neither the engine nor a loaded kernel plugin declares is refused. Load the plugin that owns it, or pass `--skip-table`.
- Rows of a type that the target does not declare land in a table with no field columns, every field in `extra`. The report lists them under `defaulted`.
- If the target's own preparation seeds rows that the source lacks, they are kept and the report lists them. The one that matters is the `_system` `AuditEvent` of kind `bootstrap`, which `serve` records on a store's first boot with keys. A source without it fails the copy (exit 1, after the target has been written); boot the source once with `serve`, stop it, and rerun.
- Recall's embedding dimensions must match when the target already has the table.
- The report gives the time of each phase (preflight, prepare-and-copy, indexes, verify) and each table's copy time. The total of a rehearsal against a copy of the store is the downtime to plan for.

### In place: `pg_upgrade`

`pg_upgrade` moves a store to PG 18 but keeps its layout, so this release still refuses an old-layout store afterwards: use it only for a store already on per-type tables. Take a rollback copy (`pg_dumpall` or a volume snapshot) first, run `pg_upgrade --check`, then `--link` (or `--copy`/`--clone` to keep the old cluster usable), and run `vacuumdb --all --analyze-in-stages` afterwards. For a docker volume, the PG 18 images keep data in a major-version subdirectory (`/var/lib/postgresql/18/…`), so mount the volume at `/var/lib/postgresql`.

Before the first boot of a new release, set `SUBSTRATE_INDEX_DISK_PATH` to the mount of the PostgreSQL data directory, so the background index builds run under the disk guard above. Unset, the guard checks nothing, and the boot logs how many builds are pending and their estimated total. The [plugin author guide](../../docs/plugin-author-guide.md#upgrading-an-existing-store) covers the index side.

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
