# Changelog

Releases before 1.0.0-alpha.21 are recorded only in their GitHub release notes.

## Unreleased

### Changed

- **`ask` no longer runs a reading with words it could not read (#PR).** When the parser's reading still has unexplained words and no judge settles them (no judge configured, or the judge timed out or escalated), the outcome is `unknown`, with `dropped` naming those words, and no query runs. Before, the reading ran without them and could return the whole type: one eval question returned all 97 open Todos with full bodies, 585 KB.

### Fixed

- **`ask` reads a number after an id word as a shortId (#PR):** "the Todo with shortId 1752", "todo id 1752", "todo number 1752" and "todo with short id 1752" now resolve to `shortId eq 1752`, as `#1752` and `todo 1752` already did.

## 1.0.0-beta.6 (2026-11-17)

Changes since 1.0.0-beta.5. Nothing breaks: error codes are unchanged, and only message text is clearer.

### Fixed

- **Three more errors name the fix (#259):**
  - A refused operator on a field lists the operators that field takes, and for a crossRef adds that `eq: null` tests for no reference.
  - A refused walk lists the walks that would work: for `in`, the crossRefs on other types that point at the current type; for `out`, the current type's own crossRefs.
  - A damaged cursor (`invalid_cursor`) says to pass the previous page's `nextCursor` back unchanged, instead of quoting the JSON parser's position.

## 1.0.0-beta.5 (2026-11-17)

Changes since 1.0.0-beta.4. Nothing breaks: the new call form is additive, and error codes are unchanged.

### Added

- **`run` scripts: `s.query` and `s.mutate` also take `(key, entry)` (#255),** the form `queryAll` and `byShortId` already take. `s.mutate(key, entry[])` is a batch. The whole-frame form is unchanged. Any other call throws naming both forms before anything is sent. The MCP `run` sandbox forwards both.

### Fixed

- **More errors name the fix (#256):**
  - `fields` or `idempotencyKey` sent inside `params` says it sits beside them.
  - An array used as an expression names the accepted forms, and for a one-field array (`["shortId"]`) the field it meant.

## 1.0.0-beta.4 (2026-11-17)

Changes since 1.0.0-beta.3. Nothing breaks: error codes are unchanged, and only message text is clearer.

### Fixed

- **Errors name the fix (#252):**
  - A refused HTTP request's `NetworkError` message carries the server's code and reason (`400 from <url>: <code>: <message>`), so a `run` script that prints only `message` sees what to fix. `status`, `code`, `serverMessage` and `body` are unchanged.
  - The query and mutate routes name the key or batch element of a malformed frame and show the frame shape, including `idempotencyKey`.
  - A list `unknown_param` that is a field of the type says filters go in `where`, with an example. A paging token under another name points at `params.cursor`.
  - `offset` without `aggregate` points at `params.cursor` for paging and `count: true` for a total.
  - A malformed expression object names the accepted forms and the keys it got.

## 1.0.0-beta.3 (2026-11-16)

Changes since 1.0.0-beta.2. One breaking change, announced in beta.2: the MCP server's default tool set.

### Changed

- **The MCP server registers the `core` tool set by default.** With `SUBSTRATE_MCP_TOOLS` unset or blank, `substrate mcp` registers `query`, `mutate`, `schema`, `recall`, `run` and `whoami`, as announced in 1.0.0-beta.2, and no longer logs a deprecation warning. Set `SUBSTRATE_MCP_TOOLS=all` (or `core,<name>`) for `propose_type`, `propose_field`, `propose_index`, `drop_namespace`, `drop_type` and `ask`.

### Fixed

- **A frame key other than `params`, `fields` or `idempotencyKey` is refused with `unknown_frame_key`.** It used to be ignored, so a filter sent as `{ "ns/Type": { "where": … } }` instead of inside `params` was dropped and the read returned every row. The refusal names the key and, for `where`, `limit`, `orderBy`, `cursor`, `count` and `offset`, says it belongs in `params`. This applies to query, mutate (including each element of a batch), subscribe and stream, and to `run` scripts' `s.queryAll`, which now throws. A caller that relied on the ignored key now gets an error for that frame.

## 1.0.0-beta.2 (2026-11-16)

Changes since 1.0.0-beta.1. Nothing breaks; one default is deprecated.

### Deprecated

- **The MCP server's default tool set (#244, #247).** An unset `SUBSTRATE_MCP_TOOLS` still registers every tool, and `substrate mcp` now logs a warning about it. From 1.0.0-beta.3 the default is the `core` preset: `query`, `mutate`, `schema`, `recall`, `run` and `whoami`. Agents that use `propose_type`, `propose_field`, `propose_index`, `drop_namespace`, `drop_type` or `ask` should set `SUBSTRATE_MCP_TOOLS=all` (or `core,<name>`). Set `core` to opt in now.

### Added

- **MCP for small-context models (#244):**
  - `SUBSTRATE_MCP_TOOLS` takes the presets `core` and `all`, mixed with tool names (`core,propose_type`).
  - Shorter tool descriptions. With `core`, what a session receives before its first call (tool definitions plus instructions, type overview included) went from about 31 KB to about 17 KB on our store.
  - A `mutate` refused for its shape (`unknown_field`, `missing_required_field`, `invalid_enum_value`, `invalid_field_type`) returns the refused type's write contract under `contract`.
  - Errors that say the fix: `not_found` and `missing_referent` on an id that isn't a UUID point at resolving a shortId; `unqualified_key` says when `params`, `fields` or `where` was sent as a frame key, and suggests `<ns>/<key>` when exactly one namespace has that name; a malformed MCP payload names the parser's position and shows a valid one.

### Changed

- **Performance (pg):**
  - A projection of column-backed fields no longer has a subquery, so those plans can run in parallel. The window fence is only used under an early-stopping `LIMIT` (#239).
  - A new type table lays its columns out by alignment, so rows are 5–8% smaller. Existing tables are unchanged (#241).

### Fixed

- **NL:** "in project X" resolves to a field filter, and "since last week" to an open range (#238).
- **Server:** builds against fastify 5.12.8, whose `addresses()` can return a pipe path (#245).
- **Dependencies:** fastify 5.12.8 (security), msgpackr 2.1.4.

## 1.0.0-beta.1 (2026-11-14)

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
