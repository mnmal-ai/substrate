# Operator decisions

Every choice you make when you deploy or upgrade Substrate, one section each: what you choose, the default, what each side costs, and how to change it later. Environment variables are read once at boot, so "change it later" means set the variable and restart, unless a section says otherwise. `GET /substrate/v1/config` (admin) shows the value each one took and where it came from.

The step-by-step upgrade is in [Upgrading to per-type tables](upgrading-to-type-tables.md). This page says what you decide; that page says what to run.

## Upgrading

### All instances that share a store upgrade together

**What you choose:** how to take instances that share one database to this release.

**The default:** none. There is only one safe answer: stop every instance, then start the new release. No rolling deploy across this release.

**What it costs:** a window with no instance running. Rolling instead risks lost writes: an instance on an earlier build neither checks nor bumps the catalog version that protects writes while a field is promoted, so a write can be lost until every instance runs the new build. Earlier builds also do not take this release's per-field promotion locks, so their sweeps and this release's do not exclude each other.

**Later:** within this release, rolling restarts are fine. The rule applies again whenever release notes say so.

### Moving an old-layout store: `migrate-store`

**What you choose:** when and how to move a store on the `legacy` or `partitioned` layout. This release refuses such a store at boot with `UnsupportedStoreLayoutError`, before changing anything, so you cannot skip this step.

**The default:** `substrate-admin migrate-store` copies the store into a fresh, empty PostgreSQL 18 store on per-type tables, builds the indexes and verifies the copy. There is no in-place conversion.

**What it costs:**

- **Downtime for the whole run.** A live source is refused: the command names the sessions it sees. On a ~40 GB real-world-shaped benchmark store the first measured run took about 36.5 minutes. Rehearse against a copy of your own store to know yours.
- **Disk.** Keep free disk on the target of at least twice the size of the source's copied tables (table data without indexes); the dry run prints it as `estimated target need`. With `SUBSTRATE_INDEX_DISK_PATH` set to a path, a real run is refused below it; with `off`, nothing is checked, so check by hand.
- **Rehearsal first.** Run `--dry-run` against the live source (it writes nothing and only warns about other sessions), then a full run from a restored copy of the source into a scratch target. The rehearsal's report times each phase; that total is your window.
- **Verification depth.** By default the run checks per-type row counts, the id set, and every row's `updated_at` and `deleted_at`, and hashes the content of a sample of 1000 rows per type. `--full-checksum` hashes every row: stronger, and slower on a large store.
- **Undeclared tables.** A source table that neither the engine nor a loaded plugin declares is refused. Load the plugin that owns it. `--skip-table` waives only such undeclared tables; naming a table the run copies is refused.
- **Misfits.** A value its declared column cannot hold is kept under `$raw` and counted in the report, never dropped. See [Misfits](#misfits-values-kept-under-raw).

**Rollback:** the source is only read. Keep it untouched until you trust the new store, and roll back by pointing the previous release at it.

**Switching over:** set `SUBSTRATE_DATABASE_URL` to the target. Or, as one option, rename the databases after the run (the source to a backup name, the target to the old name) so the service environment and backup jobs keep working unchanged. Either way, keep the source until you are done with it.

## The store

### PostgreSQL 18, or memory

**What you choose:** `SUBSTRATE_DATABASE_URL`, a `postgres://` URL or `memory`.

**The default:** `memory` when unset, with a boot banner saying writes will not survive a restart.

**What it costs:**

- **PostgreSQL** needs version 18 or newer (`runMigrations` refuses an older server with `UnsupportedServerVersionError`) and the `pgvector` extension if recall stores vectors. Each type gets a table of its own.
- **Memory** needs nothing and keeps nothing. It is for tests, trying Substrate out, and embedding in a process. It does not support: typed edge walks (`walks_unsupported_store`), keys registered with `substrate-admin` (bootstrap needs Postgres, so auth needs a file registry), storage reports, index builds and the index advisor, the promotion sweep, `migrate-store`, the statement timeout, or the tombstone purge. Everything written is lost on restart.

**Later:** moving from memory to Postgres means writing the data again. Moving between Postgres stores of the current layout is ordinary PostgreSQL work (`pg_upgrade`, dump and restore, replication).

### Transaction isolation: READ COMMITTED

**What you choose:** the store role's or database's `default_transaction_isolation`.

**The default:** PostgreSQL's own, `read committed`, which is what Substrate needs.

**What it costs:** writes to type tables check the table's catalog version in the same statement, which is only sound under READ COMMITTED. A write under REPEATABLE READ or SERIALIZABLE is refused, and nothing is written. If you raised the default for other software sharing the database, give the Substrate role `read committed`.

**Later:** `ALTER ROLE <role> SET default_transaction_isolation = 'read committed'`, then restart.

### Statement timeout

**What you choose:** `SUBSTRATE_STATEMENT_TIMEOUT_MS`.

**The default:** 30000 (30 s), applied to typed edge walk reads only. It never raises a shorter timeout already in force.

**What it costs:** a walk read that runs longer is cancelled and refused with `query_timeout`, carrying `details.timeoutMs`. Raise it and a heavy walk can hold a connection longer. A role- or database-level `statement_timeout` you set yourself also turns into `query_timeout`, without `timeoutMs`, on any read, on the edges store and on recall's queries (its HTTP routes answer 503).

The same value bounds how long a request waits for a free database connection. A read or write that waits longer never starts and is refused with `store_busy`, which is safe to retry. `/health` reports the pool as `pool: { connections, opening, idle, leased, waiting }`; a `waiting` count that stays above zero means the pool is too small for the load.

**Later:** at most 2147483647; restart.

### Type-table budget

**What you choose:** `SUBSTRATE_PARTITION_BUDGET`, the number of type tables above which the storage report warns. The name is older than the layout.

**The default:** 500.

**What it costs:** nothing at runtime. It is a warning to move a namespace to its own instance behind a bridge.

**Later:** restart.

## Fields

### Declared and runtime fields

**What you choose:** whether a field is declared in a plugin's code or added at runtime with `propose_field`.

**The default:** both are allowed. Proposing needs the proposals plugin, auth on and the `substrate.propose` capability.

**What it costs:**

- **Declared in code.** Every declared scalar or crossRef field is a typed column. A field new to an existing table gets its column at boot (or, if its table's lock is held, stays pending until the sweep adds it); values already in the row's jsonb move into it on the promotion sweep that runs after boot.
- **Added at runtime.** No column is added on the request path. The field is **pending**: its values live in the row's jsonb, and reads, filters and sorts give the answers they will give once it is promoted. An index over a pending field is reported `pending` and serves no read, so filters and sorts on it scan the type's rows. `schema` marks the field `storage: "pending"`; `/health` `warnings` carries counts.
- **Removed from code.** The field keeps its column and reads back as an extra (`orphaned`). Declaring it again moves values back.
- **Kind changed in code.** The boot is refused with `FieldKindChangedError`.

### The promotion sweep

**What you choose:** `SUBSTRATE_PROMOTE_INTERVAL_MS`, how often pending fields get their columns.

**The default:** 21600000 (6 hours). The sweep also runs once after boot. `0` stops the timer.

**What it costs:** a shorter interval gives a proposed field its index sooner. Each promotion adds a column under a short lock timeout and moves values in batches; it never queues in front of writers, and a field it cannot lock is reported `busy` and retried. With the timer off, a field proposed after the boot sweep stays pending until you run the sweep.

**Later:** `substrate-admin promote-fields --url <base>` (or `SUBSTRATE_URL`) runs the sweep now on a running server. It needs an admin credential with the store-wide admin grant and prints one line per field. Each outcome is also an `_system/AuditEvent` (`field_pending`, `field_promoted`, `field_promotion_failed`).

### Unique conflicts block promotion

A unique index is never weakened to let a promotion through. A field whose values duplicate a declared unique key fails promotion; it stays readable, and the storage report names the duplicated key. The timed sweep does not retry it until its type's catalog changes. Fix the data, then run `substrate-admin promote-fields`, which retries it.

The same holds at boot for a newly declared unique index over existing duplicates: the boot fails with `UniqueIndexDuplicatesError`.

### Widening an enum vocabulary

Widening a declared enum is accepted at boot. Stored values the new vocabulary admits may be sitting under `$raw`: filters still find them (`eq`/`in` match a value the column could not hold), but they are not indexed until the promotion sweep moves them into the column. Run `substrate-admin promote-fields` to do that now. Narrowing an enum goes through `propose_field` with a `valueMap` that rewrites stored values first; see the [proposals plugin](../plugins/substrate-proposals/README.md).

### Misfits: values kept under `$raw`

A value its declared column cannot hold (an enum value outside the vocabulary, a string in a number field, date text the column would not reproduce exactly) is never dropped. It is kept under `$raw` in the row's `extra` and reads back as written, but the column holds NULL, so an index on the column does not serve it.

**Finding them:**

- `migrate-store` counts misfits per type and field in its report.
- `substrate check-enums` reports stored values outside a field's declared enum.
- On a running store, query the type's table directly: `substrate_type_tables` maps `<namespace>/<Type>` to its table, and `extra ? '$raw'` selects the rows that carry one.

**Repairing them:** write the field again with a value the column holds (an ordinary `update<Type>`, or `updateMany<Type>` for many rows), which clears its `$raw` entry. Or widen the vocabulary so the value fits, as above. The storage report (`substrate-admin doctor`, `GET /substrate/v1/config`) does not count misfits.

### Date operands are ISO 8601

A filter operand on a date field must be an ISO 8601 date (`2026-01-02`) or date-time, with or without an offset. A loose string such as `"yesterday"` or `"01/02/2026"` is refused with `type_mismatch`, naming the field. A date with no offset is read as UTC, so writers should send an offset or `Z`.

## Unique indexes and keys

**What you choose:** which unique keys your types declare in `indexes`.

**The default:** none for your types. `_system/Key` declares one: at most one live (unrevoked) key per kid, so a second live key for a kid is refused with `unique_violation`.

**What it costs:** a unique index refuses duplicates on create and on update (`unique_violation`, on Postgres), and blocks promotion and boot over existing duplicates, as above. It also costs write time like any index.

**Keys:** `createKey` and `updateKey` refuse a `revokedAt` in the future with `invalid_params`. Revoke at the moment it should take effect: now or in the past.

**Later:** add or remove a unique index in the namespace definition and restart. Adding one over duplicates fails the boot until the data is fixed.

## Auth and the network

### Auth mode

**What you choose:** `SUBSTRATE_AUTH_MODE` (`required` or `attribute`) and where keys come from (`SUBSTRATE_AUTH_KEY_REGISTRY`, a JSON file, or keys registered in Postgres with `substrate-admin`).

**The default:** auth off. Setting either variable turns it on, and the mode then defaults to `required`.

**What it costs:**

- **Off.** Every caller acts as `SUBSTRATE_SYSTEM_ACTOR`, admin routes included. The server refuses to boot without that actor, and binds `127.0.0.1` unless `HOST` says otherwise. A non-loopback `HOST` with auth off needs `SUBSTRATE_ALLOW_UNAUTHENTICATED_HOST=1` (or `true`).
- **`required`.** Every request but `/health`, `whoami` and invite registration needs a credential. The server binds `0.0.0.0` by default.
- **`attribute`.** Anonymous callers may read; writes and admin routes still need a token.
- Set `SUBSTRATE_CURSOR_SECRET` when more than one process serves the store, or sealed cursors must survive a restart. Unset, each process keys its own seal. When it is unset, the retired `SUBSTRATE_STREAM_TICKET_SECRET` is read instead. Rotating `SUBSTRATE_CURSOR_SECRET` ends every outstanding sealed pagination cursor (callers restart paging from the first page).

**Later:** restart with the new values. Run `substrate-admin doctor` to check the result.

### Public origin

**What you choose:** `SUBSTRATE_PUBLIC_ORIGIN`, the comma-separated origins callers reach the server by.

**The default:** on a loopback `HOST`, the loopback origins for the port. With auth on and a non-loopback `HOST` there is no default: the boot is refused until you set it.

**What it costs:** a token whose `aud` names none of these origins is refused. List every URL operators point the admin CLI or MCP at, or their tokens fail.

**Later:** restart. Adding an origin breaks nothing; removing one refuses tokens minted for it.

### TLS

**What you choose:** `SUBSTRATE_TLS_KEY_PATH` and `SUBSTRATE_TLS_CERT_PATH` (together), optionally `SUBSTRATE_TLS_CA_PATH`, or a reverse proxy in front.

**The default:** plain HTTP.

**What you get:** the server speaks HTTP/2 only. With TLS it is negotiated by ALPN; in plain HTTP clients use prior knowledge (h2c). An HTTP/1.1 client is refused. Each connection may have at most 128 open streams. A request must arrive in full within 30 seconds; a stream that misses it is reset.

**What it costs:** the files are read at boot, so renewing a certificate needs a restart. Behind a proxy, the proxy must reach the server over HTTP/2 (h2c or h2 over TLS), and its exact IP (no CIDR) goes in `SUBSTRATE_TRUSTED_PROXIES` so `X-Forwarded-For` is honoured for client addresses (request context, the `/register` rate limit and per-client stream limits).

**Later:** restart.

## Limits

### Page limits

**What you choose:** `SUBSTRATE_PAGE_LIMIT_DEFAULT` and `SUBSTRATE_PAGE_LIMIT_MAX`, and `SUBSTRATE_SNAPSHOT_LIMIT`.

**The default:** 100 rows when a remote query names no `limit`; the largest `limit` accepted is 1000. A subscription's first snapshot may return up to the max page.

**What it costs:** a larger max lets one request read more and hold the server longer. A `limit` above the max is refused with `limit_exceeds_max`; a larger snapshot is refused with `snapshot_too_large`. In-process callers are not bounded.

**Later:** restart. The default may not exceed the max.

### By-filter write caps

**What you choose:** `SUBSTRATE_FILTER_WRITE_MAX_MATCH` and `SUBSTRATE_FILTER_WRITE_IDS_CAP`, for `updateMany<Type>` and `deleteMany<Type>`.

**The default:** 10000 and 1000.

**What it costs:** a filter matching more than the max is refused with `filter_too_broad` and changes nothing. The ids cap only bounds how many ids the result lists; `idsTruncated` says whether more changed.

**Later:** restart.

### Index builds and free disk

**What you choose:** `SUBSTRATE_INDEX_DISK_PATH` (the database volume's mount, or `off`), `SUBSTRATE_INDEX_DISK_MARGIN_MB` and `SUBSTRATE_INDEX_RETRY_INTERVAL_MS`.

**The default:** unset, which checks nothing and makes the storage report warn; margin 2048 MB; retry every 600000 ms (10 minutes). `substrate init` writes `off`.

**What it costs:** with a path set, a background build waits as `pending` with `insufficient_disk` rather than filling the volume. Without it, builds run whatever the free space. `migrate-store` refuses a real run until the path (of the target's volume) or `off` is set.

**Later:** restart. Details in the [dataset-pg README](../packages/substrate-dataset-pg/README.md#indexes).

## Plugin authors

### Kernel migrations and indexes

**What you choose:** how a kernel plugin changes the store.

**The default:** declare indexes and enum vocabularies in the namespace definition. The engine builds them on each type's table, keeps them matching the declaration, and reports them.

**What it costs:**

- There is no `rows` table. A kernel migration that targets it fails the boot with `KernelMigrationLayoutError`, naming the plugin and migration. `KernelMigrationContext.layout` is `'tables'` on Postgres and `null` on the memory dataset.
- An index written by hand in raw DDL must match the form the engine's filters compare, or it serves nothing and nothing reports it. Move it into `indexes` with its existing `name`: the engine adopts it when the definitions match, and otherwise rebuilds it under that name.
- `promotedColumns` is deprecated and ignored; `enumCheckStatements` is removed. An enum column carries its own CHECK.

**Later:** a plugin migration that touched `rows` must be updated before a store running that plugin upgrades. See the [plugin author guide](plugin-author-guide.md#defining-a-namespace).
