# Upgrading to per-type tables

This release stores each type in a Postgres table of its own and boots no other layout. This page lists what changes for operators, clients and plugin authors, in the order you will meet it.

> **Production warning.** A store on the `legacy` or `partitioned` layout is **refused at boot** by this release, before anything is changed. Run `substrate-admin migrate-store` first. It copies into a fresh store and never writes the source, so the untouched source is your rollback: point the previous release back at it.

## Operators

The choices behind each step below, and what each costs, are in [Operator decisions](operator-decisions.md#upgrading).

### 1. Layout-only boot; `migrate-store` is required

A `legacy` (one `rows` table) or `partitioned` store is refused with `UnsupportedStoreLayoutError`, which names `substrate-admin migrate-store`. The command copies the store (source on PostgreSQL 17 or later) into a fresh, empty PostgreSQL 18 store on per-type tables, builds the indexes and verifies the copy. A value that its declared column cannot hold is kept under `$raw` and reported as a misfit, never dropped. The source is only read. A store already on per-type tables needs none of this: stop every instance, then start the new release.

**Upgrade every instance that shares a store together.** Do not roll this release across instances: an instance on the previous build neither checks nor bumps the catalog version that protects writes during field promotion, so a write can be lost until every instance runs this build.

The procedure has five stages. The flags, exit codes and what the command copies are in the [dataset-pg README](../packages/substrate-dataset-pg/README.md#substrate-admin-migrate-store).

#### Stage

1. Provision an empty PostgreSQL 18 database for the target and prepare it as a superuser. The command never runs these steps itself:
   - If recall is used, run `CREATE EXTENSION vector;` in the target database, in `public` or the target schema, where the target's `search_path` finds it. A target where a copied table needs an extension that is not on that path is refused. Install the same pgvector version as the source's: a different version is only a warning, but verification of `embeddings` may then fail.
   - Make the target role the owner of the database, or of the schema it will use. Since PostgreSQL 15, `public` no longer grants `CREATE` to every role.
   - Never boot `serve` against the target before migrating. A target that already holds data is refused.
2. Keep free disk on the target of at least twice the size of the source's copied tables (table data without indexes); the dry run prints it as `estimated target need`. With `SUBSTRATE_INDEX_DISK_PATH` set to a path, a real run is refused below it; with `off`, nothing is checked, so check by hand. On the benchmark below, free space on the target dipped by about 25 GiB during the run.
3. Load the service's environment into the shell that runs the command, so the plugin directory (`SUBSTRATE_PLUGIN_DIR` and the plugins' own settings), `SUBSTRATE_ENFORCE_UUID_CHECK` and `SUBSTRATE_PARTITION_BUDGET` match what `serve` will use. The target is prepared with the same migrations and plugins, and a source with the UUID check is refused when the target would not enforce it.
4. Set `SUBSTRATE_INDEX_DISK_PATH` to the mount of the **target's** data volume, or to `off` when the database has no local volume. A real run refuses without it (a dry run only warns).
5. Put the connection strings in `SUBSTRATE_MIGRATE_FROM_URL` and `SUBSTRATE_MIGRATE_TO_URL`, or name other variables with `--from-env` / `--to-env`. A connection string on the command line is refused, and none is printed. A read-only role is enough for the source. `SUBSTRATE_SYSTEM_ACTOR` is not needed.

#### Rehearse on a copy

1. Run `substrate-admin migrate-store --dry-run` against the live source. It reports per-type row counts, table sizes, the estimated disk need on the target, every warning and every refusal, and writes nothing. Fix every refusal: a source table nothing declares needs its plugin loaded (or `--skip-table`, for a table nothing declares). The dry run does not detect a source that never recorded the `_system` `AuditEvent` of kind `bootstrap`: a copy fails with exit 1 in prepare-and-copy and names it. Boot the source once with the old release's `serve`, stop it, and rerun. This is one reason to always do step 2.
2. Restore a recent backup of the source to a scratch database and run the full command from it into a scratch target. Stage the scratch target as in Stage step 1 (and step 4's disk path for its volume). A copy can be checked while the service keeps running, and its report gives the time of each phase (preflight, prepare-and-copy, indexes, verify). That total is your downtime.
3. Check the report's misfits. See [Misfits](operator-decisions.md#misfits-values-kept-under-raw).

On a ~40 GB real-world-shaped benchmark store, in the first measured run, the whole run took about 36.5 minutes (preflight 2 min, copy 33 min, index builds 8 s, verify 1.5 min), with no misfits. Time your own.

#### Window

1. Stop every substrate instance on the source, and pause other jobs that read it, such as backups and dumps. The command refuses a live source and names the sessions it sees, because writes after its snapshot are not copied.
2. Run `substrate-admin migrate-store` (add `--full-checksum` to hash every row instead of a sample). The run verifies itself: exit `0` means it copied and verified.

#### Verify

1. On exit `0`, run `VACUUM (ANALYZE)` on the target.
2. Switch over: set `SUBSTRATE_DATABASE_URL` to the target (the report prints it as `switch over`), or rename the databases so the target takes the source's name and the service environment and backup jobs stay unchanged.
3. Start the new release and check `/health` and `substrate-admin doctor`.

If the run did not exit `0`:

- If the index builds or the verification failed (exit `3`), run the command again with `--verify-only`. It builds the indexes first, dropping and rebuilding any that a failed build left INVALID, then verifies. Each failed or INVALID index is named in the report as a `storage` mismatch until it builds. Only engine indexes are rebuilt: drop or `REINDEX` any other INVALID index in the target schema by hand.
- A full rerun, without `--verify-only`, restarts the copy from the beginning. Until a run has verified, the target keeps an in-progress marker, and `serve` and the admin commands refuse it.
- After a late crash on a large store, dropping and recreating the target database (then staging it again) is faster than a full rerun, which first empties every copied table.

#### Rollback

Nothing on the source changed. Run the previous release with `SUBSTRATE_DATABASE_URL` pointing at the source again (or undo the rename). Keep the source until you no longer need that option. Writes made to the target after switching over are not on the source.

### 2. `SUBSTRATE_STORAGE_LAYOUT` is removed

It is no longer read. When it is set, the binary logs `SUBSTRATE_STORAGE_LAYOUT is no longer read; every store uses per-type tables` and boots on.

### 3. Pending fields and the promotion sweep

A field added at runtime with `propose_field` is not given a column on the request path. Its values live in the row's jsonb until the promotion sweep promotes it, and reads, filters and sorts behave as they will once it is promoted.

- `schema` marks the field `storage: "pending"`, and `/health` `warnings` carries counts only (for example `3 fields pending promotion`).
- `_system/AuditEvent` gains the kinds `field_pending`, `field_promoted` and `field_promotion_failed`.
- The sweep runs once after boot, then every `SUBSTRATE_PROMOTE_INTERVAL_MS` (default 21600000, 6 hours; `0` stops the timer). `substrate-admin promote-fields --url <base>` (or `SUBSTRATE_URL`) runs it now on a running server and needs an admin credential with the store-wide admin grant.
- A unique index is never weakened to let a promotion through: a duplicate fails that field, which stays readable, and `/health` counts it. The timed sweep does not retry it until its type's catalog changes, so after fixing the data run `substrate-admin promote-fields`.
- Widening an enum's vocabulary moves stored values it now admits from `$raw` into the column, through the sweep.
- A field removed from code keeps its column and reads back as an extra (orphaned). **A kind change in code refuses boot** with `FieldKindChangedError`.

What pending means for filters, sorts and indexes, and how to find values kept under `$raw`, is in [Operator decisions](operator-decisions.md#fields).

### 4. Other operator-facing changes

- **Guarded writes need READ COMMITTED.** A write to a type table under REPEATABLE READ or SERIALIZABLE is refused, and nothing is written. Check `default_transaction_isolation` for the store's role and database.
- **A transaction that swallowed a database error now fails at commit** when it loaded a table descriptor itself.
- **Keys.** `_system/Key` declares a live-kid unique index, so a second live key for one kid is refused `unique_violation`. `createKey` / `updateKey` refuse a `revokedAt` in the future with `invalid_params`.
- **Admin commands refuse an unfinished `migrate-store`.** `bootstrap`, `register --direct`, `list`, `revoke`, `rotate` and `update`, and `substrate federate enroll`, refuse a store carrying the migrate-store marker, as `serve` does.
- **`migrate-store --dry-run` and `--verify-only` report `misfits: null`** in `--json` (not counted). A copy run still reports an object.

## Clients

### 5. An explicit `null` reads back as absent

A `null` written to a declared scalar or crossRef field comes back as an absent key, on every dataset. Read `row.field ?? null`, or test `'field' in row`. `json` and list fields keep an explicit `null`. Filters are unchanged: `{ field: { eq: null } }` matches both. `conditionalUpdate` matching `null` against an absent field is now documented; its behaviour is unchanged.

**Check your row policies.** A `row(predicate)` policy sees the row as it reads back, so `row.owner !== null` is now true for a row with no owner and fails open, and `row.ownerId === ctx.identity?.id` is `undefined === undefined` for an ownerless row and an anonymous caller. Use `row.owner == null` / `row.owner != null`, and guard equalities with `row.ownerId != null &&`.

### 6. New by-filter mutations

`<ns>/updateMany<Type>` (`{ where, set }`) and `<ns>/deleteMany<Type>` (`{ where }`) exist on every autoCRUD type. The result is `{ count, ids, idsTruncated }`.

- `SUBSTRATE_FILTER_WRITE_MAX_MATCH` (default 10000): a filter matching more rows is refused `filter_too_broad` and changes nothing.
- `SUBSTRATE_FILTER_WRITE_IDS_CAP` (default 1000): how many ids the result lists; `idsTruncated` says whether more changed.
- A type policy is evaluated per matched row with `{ id, ...set }`, and row policies apply: a row the caller cannot read is not written. Any deny refuses the whole frame.
- A namespace that declares both `X` and `ManyX` is refused at install with `AutoCrudNameCollisionError`.

### 7. Batched arrays of generated CRUD

An array under one generated `create`, `update` or `delete` key runs as one statement per type, so the statements sent do not grow with the batch. The error envelope is unchanged: the cause's own code, plus `batched_frame_rolled_back` at `[key, index]`. On pg, an update that hits a declared unique index is now `unique_violation`, as create already was.

### 8. Behaviour changes in reads

- **Walk order.** A nested walk list with no `orderBy` returns the far type's natural order (newest first unless `orderedBy`), ties by id. It used to be id ascending. Pass `orderBy: [{ id: 'asc' }]` to keep the old order.
- **Projection.** A projected read returns its top-level keys in request order; `id` leads unless the request places it elsewhere.
- **A projected key the row lacks** is absent for every field kind.
- **Date operands must be ISO 8601.** A loose string such as `"yesterday"` or `"01/02/2026"` on a date field is refused with `type_mismatch`, naming the field. `"2026-01-02"`, date-times and offsets are accepted as before.
- **Off-vocabulary operands.** `eq`/`in` now find, and `neq`/`nin` exclude, a value the column could not hold (an enum value outside the vocabulary, a string in a number field), on pg as on memory.

## Plugin authors

### 9. Hooks and migrations

- **`CoordinatorPlugin.onCommittedWrites(batch)`** is called once per batch per type after commit, with `{ namespace, type, operation, actor, ids }`. A failing hook never changes the write; its error appears in `/health` `warnings` as `post-write hook <plugin> failed at <time>`.
- **`KernelMigrationContext.layout` is `'tables' | null`** (`null` on the memory dataset). There is no `rows` table: DDL on it fails the boot with `KernelMigrationLayoutError`, naming the plugin and migration. Index a type through its definition's `indexes` instead.
- **`promotedColumns` is deprecated and ignored.** Every declared scalar or crossRef field is a typed column already. A plugin that sets it boots unchanged.
- **`enumCheckStatements` is removed**; an enum column carries its own CHECK.
- **synoptic / cortext:** a kernel migration that targets `rows` must be updated before a store running it upgrades. Until then the boot refuses with `KernelMigrationLayoutError`.

### 10. Removed public exports

From `@mnmal-ai/substrate-dataset-pg` (and from `@mnmal-ai/substrate/testing` where it re-exports): `TypeStorageLockTimeoutError`, `StorageLayoutMismatchError`, `partitionName`, `rowsTypeTable`, `enumCheckStatements` (with `EnumCheckInput` and `EnumCheckStatements`), the `PromotedBodyColumn`, `PromotedBodyColumnMap` and `PromotedColumnLookup` types, `PgDatasetOptions.promotedColumns` and `TypeTableRef.scope`. From `@mnmal-ai/substrate/testing`: `selectPgTestLayout`; a pg-gated suite's global setup calls `preparePgTestSchema` directly. `StorageLayout` is now `'tables'`; its `'legacy'` and `'partitioned'` values are gone (`DetectedLayout` is what `detectLayout` returns, old layouts included). `UUID_REGEX` and `UUID_CHECK_MIGRATION` stay exported.

Added: `UnsupportedStoreLayoutError`, `assertTablesLayout` and `DetectedLayout` (dataset-pg), `KernelMigrationLayoutError` (compose), `typeTableRef` and `TypeTableRef`.

## Performance

Measured against the previous layout on a ~40 GB real-world-shaped benchmark store, on a desktop Mac with PostgreSQL 18. Timings are medians of three runs.

- **Correct:** every benchmark card answer matches its SQLite reference (45 of 45 hashes), and the fuzz parity run found 0 mismatches.
- **Faster:** on the card workload, every card shape is faster than on the old layout. The dashboard shape, which timed out before, now completes with no errors. A large writer batch went from about 7.2 s to about 1.5 s at p50.
- **Targets not met.** The targets set for the two full-scan aggregate shapes (3 and 6) and for the writer batch were **not** met. Those two shapes scan the whole table, which storage layout alone cannot fix, and this release does not address them.
- **Reads on runtime-proposed types are slower.** In the first run, reads on types added with `propose_field` (the fuzz workload: filtered reads, counts, walks and aggregates) measured roughly 2 to 4 times slower than the old layout, because they paid extra catalog lookups. The fix round improved them by only 1 to 16%, and one catalog read in 47 warm reads remained, so a slowdown likely remains. There is no direct old-layout comparison for that workload after the fix round.
- **Known small regressions:** some point reads on the cortext workload went from about 0.7 ms to about 1.8 ms; one walk shape is about 18% slower, because the planner picks a serial plan by cost; lookups made while a heavy writer is running are slower than before. These were judged imperceptible and shipped. The new numbers are the yardstick for later work.
