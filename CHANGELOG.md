# Changelog

Releases before 1.0.0-alpha.21 are recorded only in their GitHub release notes.

## 1.0.0-beta.13 (2026-11-23)

Changes since 1.0.0-beta.12. No schema version moves and there is no migration. Sketches, frames and replies keep their meaning, and the `lean` MCP preset is unchanged. On Postgres, a write inside a transaction now takes a shared per-type advisory lock, one extra statement per transactional write.

### Fixed

- **Proposal gates hold their stored-rows check (#303).** The TypeProposal, FieldProposal and NamespaceProposal gates, and `propose_type`'s storage check, let a caller without the drop capability change a type only while it has no stored rows. That check was an unlocked read, so a row committed meanwhile could slip past it, and the type or field was redefined at the next boot on a type that had rows. The check now holds its answer until the transaction ends. `Dataset` gains an optional `hasRowsLocked(type, namespace?)`. On Postgres, `hasRowsLocked` takes the type's lock exclusively, retrying with backoff for up to 2 s, and a type still being written is refused as `policy_denied` (`… is being written; retry`). Memory runs one transaction at a time and needs no lock.
- **Recall hit rows on Postgres carry `id` (#305).** A hit's row was the stored body plus `shortId`, and a body holds `id` only on rows written before the key column held it. So rows written by the current dataset came back without `id`, and a row that both arms found was listed twice, each copy with a one-arm RRF score. The row now takes `id` from the key column, and a body's own `id` still wins, as on read.

### Dependencies

- `postgres` (postgres.js) 4.1.0 to 4.1.1 (#301).

## 1.0.0-beta.12 (2026-11-22)

Changes since 1.0.0-beta.11. No schema version moves, there is no migration, and every sketch that compiled before compiles to the same plan. One kind of query that used to answer now refuses: a walk carrying an extension operator. It matched nothing before. The `lean` MCP preset's fixed cost is 2,051 bytes, up from 2,016.

### Changed

- **`define`, then use it, in one sketch (#298).** A sketch may open with one `define`, and its later steps compile against the word it coins: `define Todo.unblock unblocked status=open blockedBy=null; unblock Todo #6 #9`. The whole sketch compiles before anything runs. A proposal never shares a transaction, so the `define` commits on its own, and then the remaining steps run as one transaction. A run-time failure in those steps keeps the word, and the error ends `(step 1 committed: <ns>/<Type>.<name> is defined)`. That run counts as the word's first use. A `define` that is not first, or a second `define`, is refused (`define comes first`, `one define per sketch`). In a coining bench, every agent's first attempt at coining had this shape and was refused as `define stands alone`.
- **Reference lists (#298).** `close Todo #12,#13` and `close Todo [#12,#13]` now mean `close Todo #12 #13`, for every action. Before, they were refused as `unexpected token`.
- **Help shares a sketch (#299).** `?` steps may sit beside any other steps, as in `? Todo; find Todo #12 fields=status`. The reply carries `help` beside the ack and `found`, and `ActResponse`'s success shape gains an optional `help`. The 10-step cap counts only help steps, and a `define` must come first among the steps that are not help. `substrate act` prints the help, then the ack. Before, any help beside another step was refused with `help stands alone`.

### Fixed

- **Extension operators inside walks are refused (#299).** An extension operator such as `embeddingSimilar` is resolved only in the frame's own `where` (including under `AND`, `OR` and `NOT`). Inside a `_walk`, on a field within one, or in an `_agg`'s `where`, it never ran, and the walk silently matched nothing. The validator now refuses it there with `capability_unsupported`.

## 1.0.0-beta.11 (2026-11-22)

Changes since 1.0.0-beta.10. Existing sketches, frames and replies keep their meaning; `act` replies only gain fields. A server running substrate-proposals publishes a new schema version for each namespace it owns, because `TypeProposal` gains an `actionsJson` field, and for `_system_proposals`, which gains the `ActionProposal` type. On Postgres there is no numbered migration. The new field starts in `extra` and gets its column from the promotion sweep, as any new field does, and the new type's table is created at boot. The `lean` MCP preset's fixed cost is 2,016 bytes, up from 1,848.

### Added

- **Agents coin `act` words (#296).** `define Todo.start status=in_progress owner=$` proposes a new update action on a stored type. [`docs/act.md`](docs/act.md#coining-actions) is the guide.
  - **Grammar.** `field=value` fixes a value. `field=$`, or `$name`, makes a param typed by the field, and a trailing `?` makes it optional. `field=now` stamps a date. An optional bare word after the name is the past tense used in acks. One `define` per call. Version 1 covers update shortcuts only.
  - **Pending, then public.** A word is usable only by its proposer at first. `?`, `? Type` and the proposer's lean index show it marked `start*`. Five committed uses, each at least an hour after the last, publish it to every caller and move `schemaVersion`.
  - **Caps.** At most 10 published coined words per type, and 20 pending per proposer per namespace. A pending word lapses after 30 days without use.
  - **Names.** Proposals only add, so a declared, published or pending name is refused with `action_taken`. Vetoed and retired names stay closed, and a lapsed name stays reserved to its proposer. Code that declares the same name wins at boot.
  - **Opt-in.** `define` compiles to the control-plane mutation `_system_proposals/propose_action`, which needs `mutate` on `_system_proposals` and on the target namespace. A `'*'` grant includes the control plane. A word grants no new power: it runs as `update<Type>` under the caller's grants and type policies.
  - **Veto and retire.** An operator archives the word's `ActionProposal` record, which needs `admin` in the word's target namespace. Every other client write to those records is refused. A namespace drop retires its words.
  - **Coherence.** Words survive restarts and reach peer instances. Uses are counted under a row lock, and a promotion under a per-type lock.
- **Proposed types are born with actions (#296).** `propose_type` takes `actions` beside `fields`. They are published with the type at once and follow the same rules as declared actions, including create actions, `then` chains and defaults. A `then` may target only an action that is declared in code or born with a type. Removing or rewriting a type that another live action chains into is refused with `action_chained`.
- **`act` replies say more (#294).** `find` rows come back in `found` (up to 100 rows), holding `id`, `shortId` and the fields named by `fields=`. A dry run's reply carries `plan`, one line per compiled step with its values. Lists may be written `[a,b]`. `find Todo #12` filters by shortId. Up to 10 `?` steps can share one call.

### Changed

- `?` and the lean MCP index leave out `_system*` namespaces (#296).
- A step error from `act` no longer carries the resolver's shortId hint, which named a `where` shape no sketch writes (#294).
- `act` result records hold `find` rows projected to `fields=` (#294).

## 1.0.0-beta.10 (2026-11-21)

Changes since 1.0.0-beta.9. Nothing existing changes meaning. A server whose types declare no actions publishes the same schema hash and the same `core` MCP instructions as before. On Postgres, boot runs one new migration, `0009t_act_results`, which adds the `act_results` table. `SUBSTRATE_MCP_TOOLS=all` now registers 13 tools, because it includes `act`.

### Added

- **`act`: declared actions and sketches (#291).** An agent sends a short sketch, such as `close Todo #12 resolution=wont_do; log Entry summary="Shipped" closes=#14`, instead of hand-built frames. The reply is a one-line ack plus a short-lived result id. [`docs/act.md`](docs/act.md) is the guide.
  - **Declarations.** `defineNamespace` types take `actions`, as data: a kind (`update` or `create`), params with field types, `set` values (a literal, `{ param }` or `{ now: true }`), and optional `then` follow-ons that run once per element of a list param. Boot refuses a bad declaration with a named error. Actions are published in `TypeSchema.actions` and count toward the schema hash.
  - **Compiler.** A deterministic compiler turns sketch text, or its JSON form, into an explicit plan, or refuses with `sketch_unresolved` naming the step, the token, the choices and the nearest valid sketch. Nothing is guessed. Built-ins on every stored type: `create`, `update`, `find` and `count`. There is no delete. `?` and `? Type` give help. At most 50 write steps.
  - **Execution.** Every step goes through the same per-entry path as `mutate` (namespace grant, type policy, caller identity), and all steps share one transaction. `#N` in a reference field resolves inside that transaction through the caller's read path. A dry run executes, then rolls back. Bridged and virtual namespaces are refused, and `act` needs a signed caller.
  - **Result records**, in memory or Postgres, are readable only by the credential that created them. They expire after 24 hours by default (`SUBSTRATE_ACT_RESULT_TTL_MS`), and a sweep stage reaps them.
  - **Surfaces:** `POST /substrate/v1/act` and `GET /substrate/v1/act/results/:id`, `client.act` and `client.actResult`, `s.act` in `run` scripts, the `substrate act` CLI, and an MCP `act` tool. The schema overview names each type's actions.
- **The `lean` MCP preset (#291).** `SUBSTRATE_MCP_TOOLS=lean` registers `act` and `whoami`, plus `ask` when the server runs substrate-nl. The `act` tool is 701 bytes, and the lean tools plus instructions are 1703 bytes, against about 8.5 KB for `core`. `act` is also in `all`, and `core,act` adds it to core.

## 1.0.0-beta.9 (2026-11-21)

Changes since 1.0.0-beta.8. One behaviour change for Postgres consumers: an int64 field read inside a nested selection, or through a walk `latest`, now comes back as a bigint (a decimal string on the JSON wire), as top-level int64 fields and the memory store already did. Before, it was a JSON number that lost digits past 2^53. `ask` also answers some questions differently: "per month by due date" buckets on the named field, and ordering through a relation skips the rows the default exclusions skip.

### Added

- **Walk aggregates over integer fields (#287).** A walk `_agg` takes `sum`, `avg`, `min` and `max` over `int16`, `int32` and `int64` fields, not only `number` fields. The rules match frame aggregates:
  - `sum` of an integer field is an exact int64: a bigint in memory, a decimal string on the JSON wire. Postgres sums with native `bigint`.
  - `avg` is a number. `min` and `max` keep the field's kind.
  - A sum past the int64 range fails with `value_out_of_range` on both stores.
- **Group a frame aggregate by a field of a related row (#287, #289).** In `groupBy`, `"<crossRef>.<field>"` names a field on the row the out walk through that crossRef reaches, for example `groupBy: { region: "customer.region" }`. It also works inside a group expression, such as `dateTrunc` over a related row's date.
  - One hop, out walks only, and only in `groupBy`. `select`, aggregate arguments and `having` refuse it with `expr_invalid`.
  - A null, missing or deleted related row gives a `null` key, and the row still counts.
  - The walk rules apply unchanged: the read grant on the far namespace is checked first, and `walk_cross_store`, `walks_unsupported_store`, the far type's read policy and its row policy refuse as for any walk.
  - The index advisor counts a key through a related row as that walk's hop.
- **`ask` reads integer fields (#287).** Total, sum, average, min, max and ordering by a field of the type accept integer fields. Ordering through a relation still takes number fields only.

### Changed

- **`ask` "by <date field>" (#287).** "per month by due date" buckets on the named date field instead of the time-field ruling. Words that don't name a date field stay unread, and the answer says so.
- **substrate-tui `/keys` (#280).** One ruled band per machine with its key count, the bootstrap key by name, revoked keys in a struck-through band of their own, and colour from the theme's tones only. Editing is unchanged.

### Fixed

- **int64 precision on Postgres (#289).** An int64 field in a nested selection, or a walk `latest` over an int64 field, returned 9007199254740992 for 9007199254740993, and a number where memory returns a bigint. Both now come back exact. `where` comparisons are unchanged.
- **`ask` ordering through a relation (#289).** "top 2 tests by run duration" ranked tests by their skipped runs too. Ordering now applies the far type's default exclusions, as filters on the same question already did.
- **`ask` integer operands stay exact (#287).** An int64 filter operand past 2^53 is sent as its decimal string instead of a rounded number.
- **substrate-tui key names (#280).** A line break in a key's name, which an invite redeemer chooses, becomes a space, so a name can no longer forge rows in `/keys` or the dash and status panels.

### Docs

- **A landing site with worked examples (#277, #282, #283, #285, #286, #288).** https://mnmal-ai.github.io/substrate/ has a page per worked example. Every sample runs in CI against a composed substrate, and the page renders the recorded transcript.
- **`docs/walks.md` (#287)** covers integer walk aggregates and group keys through a related row.

## 1.0.0-beta.8 (2026-11-20)

Changes since 1.0.0-beta.7. Several behaviour changes. A walk into another namespace now runs, and the error code `walk_cross_namespace` is gone: clients that matched on it must handle `policy_denied` and the new `walk_cross_store`. A key with write but no read access can no longer write references. A reference value must be an id. `ask` answers `unknown` for more questions that hold a bare number or year, and a TypeScript consumer that switches on the aggregate `fn` needs a `count` case.

### Added

- **Walks can cross into another namespace on the same store (#275).** `in: 'ns/Type.field'` and `out` both work across namespaces, with any, none, all, picks, `as` bindings, counts and sums, nested selections and walks inside walks. The caller must be able to read every namespace the walk touches. A walk that stays in one namespace is unchanged.
- **A proposed type or field can reference a code-defined type (#273).** `propose_type` and `propose_field` accept a reference to a type in a namespace the proposals plugin does not own. The proposer must be able to read the target namespace, the target must be a registered, stored type, and `onDelete` must not be `restrict`. Each refusal is `invalid_field_spec` and names the field and the reason. At boot, a stored proposal whose target type is gone is skipped with a warning.
- **`ask` groups by week, month and year, and counts per unit (#271).** Before, only day and hour worked.
  - "total price of sales per month" gives one total per month. "how many sales per week" gives a count per week.
  - The adjectives hourly, daily, weekly, monthly, yearly, annual and annually also set the unit. A field name wins over the adjective, and a stored value wins over it too.
  - Labels are `2026-10-20T09` (hour), `2026-10-20` (day), the Monday of the week (week), `2026-10` (month) and `2026` (year).
  - A count per unit answers `aggregate: { fn: 'count', field: '*', by, groups }`. `NlAggregate.fn` gains `'count'`.
  - `substrate ask` now prints aggregate answers. It used to print "rejected" for every one.
- **`ask` reads years and months as time windows (#272).** "in 2025", "this year" and "last year" are calendar years. "in october" and "in october 2025" are calendar months. Years and months also work after since, after, before, until, between and from, so "between november and february 2026" reads as 2025-11-01 to 2026-03-01. A four-digit year operand is 1900 to 2199. A month or year that is also a stored value answers `unknown`.
- **Recall hits carry `shortId` (#265).** Hits from the Postgres backend now include `shortId` next to `id`, and the default handle projection keeps it. `ask` uses this to answer "which Decision number".

### Changed

- **Walk errors across namespaces (#275).** `walk_cross_namespace` is no longer returned. A crossing walk now runs or is refused with one of these:
  - `policy_denied`, message `this walk is not permitted`, when the caller cannot read a namespace the walk touches. This is checked before anything in that namespace is looked up, and the message is the same whether or not the namespace or type exists.
  - `walk_cross_store` (new), when the far namespace is on another store or is bridged.
  - `walk_unknown_ref`, when the far type is unknown or virtual. Outside the starting namespace, only stored types can be reached.
  - `row_policy_blocks_walk`, when the far type's row policy blocks the walk.
- **Stricter writes of references (#273).**
  - An API key with write but no read access can no longer write references. Writing a non-null reference needs read on the target namespace.
  - A reference value must be an id, a string or a number. An object or array is refused with `invalid_field_type`.
  - Sending `proposedBy` on update is refused with `client_supplied_server_field`. The server sets it from the signed caller.
  - Bulk update and bulk delete on `TypeProposal`, `FieldProposal` and `NamespaceProposal` are refused.
  - Changing or retiring a populated proposed type or field, retargeting a `FieldProposal`, and making a `NamespaceProposal` live or archiving it need the drop capability. A retired namespace stays retired.
  - A proposal spec that is not a string is refused.
  - `propose_index` can return `proposal_changed` when the recommendation changed while the call ran.
- **`ask` ids need a cue, and numbers are never dropped (#272).** A number is a shortId only after `#`, after an id word, or right after a singular type word. A bare number answers `unknown` where it used to run `shortId = 2025` or be ignored: "how many sales 2025", "items 2025", "todo 5 7", "categories 5 and the category". "todo 5 and todo 7" still gives `shortId in [5, 7]`. A judge's pick whose leftover words contain a digit escalates instead of running.
- **`ask` answers `unknown` where an adjective was ambiguous (#271).** "monthly total of subscriptions", where `monthly` could be a unit or a stored value, no longer silently filters. "the last 5 sales" no longer returns one row.
- **`ask` `asOf` must be within years 1000 to 9998 (#272),** otherwise the request fails with `400 invalid_params`.
- **Backfill re-embeds rows made by another model (#269).** After deploy, rows whose vector came from a different model id are re-embedded, at 50 rows per type per minute. Until then they are missing from dense recall.
- **A database migration adds nullable vectors (#270).** `0004_embeddings_nullable_vector` drops `NOT NULL` from `embeddings.embedding`. It changes metadata only and can run twice.

### Fixed

- **A dataset for a runtime-created namespace used the wrong field definitions (#274).** In a namespace made by `propose_namespace`, a field added with `propose_field` was treated by the default namespace's definitions. Sorting a proposed number field gave text order (`10, 9`) and now gives numeric order (`9, 10`). A walk over a proposed reference failed with "is not a crossRef" and now works. A mutate that spans namespaces had the same fault.
- **Auth and invites (#266, #267).**
  - A key created in a mutate that later rolled back could still sign in until the next cache reload. It now takes effect only on commit.
  - A token whose header or payload decodes to `null` gave a 500. It now gives 401.
  - An invite written through `/mutate` skipped the grant checks and the `_system:admin` opt-in, and could redeem into a key that failed every request. It now gets the same checks as `POST /_system/invites`. `updateManyInvite` is refused with `capability_unsupported`. A stored key row with an unparseable grant is skipped with one warning per key.
- **`run` scripts (#266, #267).**
  - The `maxWrites` cap could be bypassed by sending writes at once with `Promise.all`, and dry-run did not apply it. Both now count frames before sending, and a report waits for writes still in flight.
  - BigInt values in `run` output no longer fail. `s.log` prints them as digits.
  - Cancelling an MCP `run` call now stops the script.
  - Without an identity, the MCP `run` tool names the two environment variables to set.
- **Subscriptions reconnect with the right delay (#267).** A quiet subscription that dropped often climbed to the maximum delay. The delay now resets once a connection has stayed open long enough.
- **Concurrent writes (#266, #268).**
  - Creates of one type no longer wait on each other for a lock once its sequence exists. Two transactions creating the same two types in opposite orders no longer deadlock.
  - A `restrict` reference and a delete of its target could both commit, leaving a live reference to a deleted row. One of the two is now refused, with `restrict_violation` or `missing_referent`.
  - In the memory store, a second concurrent transaction shared the first's rollback. Transactions now run one at a time.
  - In the memory store, a purged and re-created row kept its old shortId. It now gets a new one, as on Postgres.
- **`ask` vocabulary failures are not cached (#266).** A cancelled request or a transient refusal (`aborted`, `query_timeout`, `store_busy`) during the vocabulary build left an empty profile that every caller with that principal got for five minutes. The build now fails and is not cached.
- **`ask` counts across archived rows (#265).** "How many SessionLog rows are there in total (archived or not)" answered `unknown`. "including archived" and "archived or not" now lift the default `archived = false` filter. "total rank of categories" is still a sum.
- **One bad row no longer blocks reindexing (#269).** A 4xx or 500 from Ollama's `/api/embed` is now an error for that row only, and reindex and backfill skip it. 401, 403, 404, 408, 429 and other 5xx still count as the embedder being unavailable. When backfill stops on an outage, the rest of the page is retried on the next pass.
- **Rows with no text are no longer retried forever (#270).** A row with null, empty or blank text keeps a marker, and backfill leaves it alone until the row changes. Before, it was re-read every pass, and real failures queued behind it waited hours. Markers never appear in recall results.
- **Recall and background jobs (#269).** Two recalls returning the same rows in opposite order could deadlock while boosting salience. The edge sweep no longer writes a column nothing reads. A formation pass inserts cluster members in one statement instead of up to 20,000.

## 1.0.0-beta.7 (2026-11-18)

Changes since 1.0.0-beta.6. One behaviour change in `ask`: a reading with words it could not read now answers `unknown` instead of running. The query API and error codes are unchanged.

### Changed

- **`ask` no longer runs a reading with words it could not read (#261).** When the parser's reading still has unexplained words and no judge settles them (no judge configured, or the judge timed out or escalated), the outcome is `unknown`, with `dropped` naming those words, and no query runs. Before, the reading ran without them and could return the whole type: one eval question returned all 97 open Todos with full bodies, 585 KB.

### Fixed

- **`ask` reads a number after an id word as a shortId (#261):** "the Todo with shortId 1752", "todo id 1752", "todo number 1752" and "todo with short id 1752" now resolve to `shortId eq 1752`, as `#1752` and `todo 1752` already did.
- **CI installs again (#262):** CI skips `onnxruntime-node`'s optional CUDA download, whose upstream GitHub release now returns 404. Dev-only; the published package does not depend on it.

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
