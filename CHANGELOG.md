# Changelog

Releases before 1.0.0-alpha.21 are recorded only in their GitHub release notes.

## 1.0.0-beta.1 (unreleased)

The first beta. From here on the frame grammar, the wire format and the HTTP and MCP surfaces change only by addition. A breaking change goes through a deprecation first. See *Stability* in the [README](README.md#stability). Upgrading from an alpha takes the steps in [Upgrading to 1.0.0-beta.1](docs/upgrading-to-beta.md).

Changes since 1.0.0-alpha.21.

### Breaking

- **Date values must be instants (#1781).** A `date` value written through a mutation, and a filter operand on a date field, must carry a time and an offset (`2026-11-14T10:00:00Z`). Bare days and offset-less date-times are refused with `invalid_field_type` on writes and `type_mismatch` on filters. Stored rows are unaffected.
- **`_allowTableScan` is refused (#1955).** It was accepted and ignored. Queries, subscribes and streams that send it now get `unknown_param`.
- **`SUBSTRATE_PARTITION_BUDGET` is renamed `SUBSTRATE_TYPE_TABLE_BUDGET` (#1955).** The old name is still read while the new one is unset, and logs a deprecation warning.
- **The per-type `schema` is compact by default (#1787).** `GET /substrate/v1/schema/<ns>/<Type>`, and the MCP `schema` tool with a type, now name the type in generated CRUD mutations instead of repeating every field. That is about 70% smaller for a typical type. `?shape=full` (MCP `shape: "full"`) returns the old long form.
- **Nested walk rows omit a declared field they lack (#1842),** as top-level rows already do. These fields used to read `null`.
- **Streams take only `where` and `orderBy` (#1952),** the subscribe allowlist. Any other param is refused with `unknown_param` before the resolver runs.
- **Subscribe refuses params named `count`, `aggregate`, `groupBy`, `having` or `offset`** with `unknown_param` (#1951). It used to refuse them as `walks_in_subscription`.

### Added

- **Code mode:** `s.byShortId(key, n | n[], fields?)` on `ScriptContext`, also in the MCP `run` sandbox (#1785), and a typed `RecallHit` for `s.recall` (#1786).
- **Storage and health:** the storage report counts misfits (values kept under `$raw`) per field, and `/health` shows the total. `/health` never scans on its own request; a background count runs at most once every 5 minutes (#1898).
- **TUI:**
  - `/keys` can list revoked keys, read-only (`r`). The keys route takes `?filter=all` (#1914).
  - `/admin mutate` sends a raw mutate frame as the admin identity, after a preview and a typed confirmation (#1915).
- **NL:** a `fieldPhrases` value that doesn't fit its field's kind is dropped with a warning when rulings load (#1830).

### Fixed

- **Security:**
  - Batched `_system` writes now run their interceptors. An array mutate used to skip audit events and the last-admin guards (#1953).
  - A proposal for a type that has rows can be deleted, archived, or edited in any field boot replays only with the drop capability. The same applies to creating an applied proposal for such a type (#1792, #1954, #1956).
- **Walks:** one shared walk-grammar check replaces five separate ones (#1825).
- **Stores:**
  - The memory store enforces declared unique indexes (#1832) and keeps a row's first short id (#1846), as pg does.
  - A missing `short_ids` → `row_ids` foreign key is restored by migration `0008t` (#1845).
  - Statement-timeout cancels in the edges store and in recall answer `query_timeout`; recall's routes return 503 (#1836).
- **Admin:** `migrate-store` refuses a bad serve env before its preflight, with exit 2 (#1868).

### Internal

- A golden-eval set records Postgres's answers to a fixed set of queries and checks every change against them, plus a pre-merge pg CI job behind the `ready-to-merge` label (#1859).
- New tests: the NL-over-pg suite, and late-declared field parity (#1852).
- Flaky-test fixes: #1807, #1900, #1909, and `abort-fan-out`.

## 1.0.0-alpha.21

- The walk grammar's `among` pre-pick filter (#1810), walk fixes (#1822, #1823, #1824, #1827, #1829), and the walk grammar reference (#1826).
- MCP `query` and `mutate` accept a bare frame (#1835).
- Proposals refuse a field named `shortId` (#1927).
- `stop({ grace })` closes the `::1` listener (#1945).
- MCP release smoke script (#1949).
