# Upgrading to per-type tables

This release stores each type in a Postgres table of its own and boots no other layout. This page lists what changes for operators, clients and plugin authors, in the order you will meet it.

> **Production warning.** A store on the `legacy` or `partitioned` layout is **refused at boot** by this release, before anything is changed. Run `substrate-admin migrate-store` first. It copies into a fresh store and never writes the source, so the untouched source is your rollback: point the previous release back at it.

## Operators

### 1. Layout-only boot; `migrate-store` is required

A `legacy` (one `rows` table) or `partitioned` store is refused with `UnsupportedStoreLayoutError`, which names `substrate-admin migrate-store`. The command copies the store (source on PostgreSQL 17 or 18) into a fresh, empty PostgreSQL 18 store on per-type tables, builds the indexes and verifies the copy. A value that its declared column cannot hold is kept under `$raw` and reported as a misfit, never dropped.

1. Rehearse with `substrate-admin migrate-store --dry-run`: plan, sizes, disk estimate and every refusal, writing nothing. Do this while the service is still running; it sizes your downtime.
2. Stop every substrate instance. Writes made after the copy's snapshot are not copied.
3. Run `substrate-admin migrate-store`. The source and target connection strings come from `SUBSTRATE_MIGRATE_FROM_URL` and `SUBSTRATE_MIGRATE_TO_URL`, never argv. Set `SUBSTRATE_INDEX_DISK_PATH`, and load the service's environment so plugins match what `serve` will use. The run verifies itself: exit 0 means it copied and verified.
4. If an index build or the verification fails, `--verify-only` builds indexes and verifies the finished copy again. `--full-checksum` hashes every row instead of a sample.
5. Point the new binary at the target store and boot it.

Downtime is the whole run: copy, then index builds, then verification. On a ~40 GB real-world-shaped benchmark store, in the first measured run, it took about 36.5 minutes (preflight 2 min, copy 33 min, index builds 8 s, verify 1.5 min), with no misfits. Time a rehearsal against a copy of your own store, and keep free disk at least the size of the source: free space on the benchmark target dipped by about 25 GiB during the run. The full procedure is in the [dataset-pg README](../packages/substrate-dataset-pg/README.md#upgrading).

`migrate-store` no longer needs `SUBSTRATE_SYSTEM_ACTOR`. It used to fail after preflight with ``compose: `systemActor` is required when auth is disabled``; it now supplies its own actor to a boot that serves no request, and copied rows keep their source metadata.

### 2. `SUBSTRATE_STORAGE_LAYOUT` is removed

It is no longer read. When it is set, the binary logs `SUBSTRATE_STORAGE_LAYOUT is no longer read; every store uses per-type tables` and boots on.

### 3. Pending fields and the promotion sweep

A field added at runtime with `propose_field` is not given a column on the request path. Its values live in the row's jsonb until the promotion sweep promotes it, and reads, filters and sorts behave as they will once it is promoted.

- `schema` marks the field `storage: "pending"`, and `/health` `warnings` carries counts only (for example `3 fields pending promotion`).
- `_system/AuditEvent` gains the kinds `field_pending`, `field_promoted` and `field_promotion_failed`.
- The sweep runs once after boot, then every `SUBSTRATE_PROMOTE_INTERVAL_MS` (default 21600000, 6 hours; `0` stops the timer). `substrate-admin promote-fields` runs it now and needs the store-wide admin grant.
- A unique index is never weakened to let a promotion through: a duplicate fails that field, which stays readable, and `/health` counts it until you resolve the duplicate.
- A field removed from code keeps its column and reads back as an extra (orphaned). **A kind change in code refuses boot** with `FieldKindChangedError`.

## Clients

### 4. An explicit `null` reads back as absent

A `null` written to a declared scalar or crossRef field comes back as an absent key, on every dataset. Read `row.field ?? null`, or test `'field' in row`. `json` and list fields keep an explicit `null`. Filters are unchanged: `{ field: { eq: null } }` matches both. `conditionalUpdate` matching `null` against an absent field is now documented; its behaviour is unchanged.

**Check your row policies.** A `row(predicate)` policy sees the row as it reads back, so `row.owner !== null` is now true for a row with no owner and fails open, and `row.ownerId === ctx.identity?.id` is `undefined === undefined` for an ownerless row and an anonymous caller. Use `row.owner == null` / `row.owner != null`, and guard equalities with `row.ownerId != null &&`.

### 5. New by-filter mutations

`<ns>/updateMany<Type>` (`{ where, set }`) and `<ns>/deleteMany<Type>` (`{ where }`) exist on every autoCRUD type. The result is `{ count, ids, idsTruncated }`.

- `SUBSTRATE_FILTER_WRITE_MAX_MATCH` (default 10000): a filter matching more rows is refused `filter_too_broad` and changes nothing.
- `SUBSTRATE_FILTER_WRITE_IDS_CAP` (default 1000): how many ids the result lists; `idsTruncated` says whether more changed.
- A type policy is evaluated per matched row with `{ id, ...set }`, and row policies apply: a row the caller cannot read is not written. Any deny refuses the whole frame.
- A namespace that declares both `X` and `ManyX` is refused at install with `AutoCrudNameCollisionError`.

### 6. Batched arrays of generated CRUD

An array under one generated `create`, `update` or `delete` key runs as one statement per type, so the statements sent do not grow with the batch. The error envelope is unchanged: the cause's own code, plus `batched_frame_rolled_back` at `[key, index]`. On pg, an update that hits a declared unique index is now `unique_violation`, as create already was.

### 7. Behaviour changes in reads

- **Walk order.** A nested walk list with no `orderBy` returns the far type's natural order (newest first unless `orderedBy`), ties by id. It used to be id ascending. Pass `orderBy: [{ id: 'asc' }]` to keep the old order.
- **Projection.** A projected read returns its top-level keys in request order; `id` leads unless the request places it elsewhere.
- **A projected key the row lacks** is absent for every field kind.

## Plugin authors

### 8. Hooks and migrations

- **`CoordinatorPlugin.onCommittedWrites(batch)`** is called once per batch per type after commit, with `{ namespace, type, operation, actor, ids }`. A failing hook never changes the write; its error appears in `/health` `warnings` as `post-write hook <plugin> failed at <time>`.
- **`KernelMigrationContext.layout` is `'tables'`.** There is no `rows` table: DDL on it fails the boot with `KernelMigrationLayoutError`, naming the plugin and migration. Index a type through its definition's `indexes` instead.
- **`promotedColumns` is deprecated and ignored.** Every declared scalar or crossRef field is a typed column already. A plugin that sets it boots unchanged.
- **`enumCheckStatements` is removed**; an enum column carries its own CHECK.
- **synoptic / cortext:** a kernel migration that targets `rows` must be updated before a store running it upgrades. Until then the boot refuses with `KernelMigrationLayoutError`.

### 9. Removed public exports

From `@mnmal-ai/substrate-dataset-pg` (and from `@mnmal-ai/substrate/testing` where it re-exports): `TypeStorageLockTimeoutError`, `StorageLayoutMismatchError`, `partitionName`, `rowsTypeTable`, `enumCheckStatements` (with `EnumCheckInput` and `EnumCheckStatements`), the `PromotedBodyColumn`, `PromotedBodyColumnMap` and `PromotedColumnLookup` types, `PgDatasetOptions.promotedColumns` and `TypeTableRef.scope`. From `@mnmal-ai/substrate/testing`: `selectPgTestLayout`; a pg-gated suite's global setup calls `preparePgTestSchema` directly. `StorageLayout` is now `'tables'`; its `'legacy'` and `'partitioned'` values are gone (`DetectedLayout` is what `detectLayout` returns, old layouts included). `UUID_REGEX` and `UUID_CHECK_MIGRATION` stay exported.

Added: `UnsupportedStoreLayoutError`, `assertTablesLayout` and `DetectedLayout` (dataset-pg), `KernelMigrationLayoutError` (compose), `typeTableRef` and `TypeTableRef`.

## Performance

Measured against the previous layout on a ~40 GB real-world-shaped benchmark store, on a desktop Mac with PostgreSQL 18. Timings are medians of three runs.

- **Correct:** every benchmark card answer matches its SQLite reference (45 of 45 hashes), and the fuzz parity run found 0 mismatches.
- **Faster:** on the card workload, every card shape is faster than on the old layout. The dashboard shape, which timed out before, now completes with no errors. A large writer batch went from about 7.2 s to about 1.5 s at p50.
- **Targets not met.** The targets set for the two full-scan aggregate shapes (3 and 6) and for the writer batch were **not** met. Those two shapes scan the whole table, which storage layout alone cannot fix, and this release does not address them.
- **Reads on runtime-proposed types are slower.** In the first run, reads on types added with `propose_field` (the fuzz workload: filtered reads, counts, walks and aggregates) measured roughly 2 to 4 times slower than the old layout, because they paid extra catalog lookups. The fix round improved them by only 1 to 16%, and one catalog read in 47 warm reads remained, so a slowdown likely remains. There is no direct old-layout comparison for that workload after the fix round.
- **Known small regressions:** some point reads on the cortext workload went from about 0.7 ms to about 1.8 ms; one walk shape is about 18% slower, because the planner picks a serial plan by cost; lookups made while a heavy writer is running are slower than before. These were judged imperceptible and shipped. The new numbers are the yardstick for later work.
