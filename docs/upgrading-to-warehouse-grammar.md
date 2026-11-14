# Upgrading to the warehouse grammar

This release adds expressions to the read grammar: computed `select` values, `groupBy`, `having`, `offset`, `countDistinct` and expression arguments to aggregates. It also **removes `bucket` and `derive`**, which `groupBy` and `select` replace. This page lists what changes for clients, plugin authors and the NL plugin, in the order you will meet it.

> **Breaking, pre-1.0.** A frame that sends `bucket` or `derive` is refused with `unknown_param`, so a stale client fails loudly rather than getting an ungrouped answer. Nothing in the store changes: there is no migration and no new index. Upgrade the clients that send these two params, and every other read keeps working. One thing to check before upgrading: no type may declare a field with a reserved metadata name (see [Reserved field names](#reserved-field-names)).

## Clients

### 1. `bucket` becomes `groupBy` with `dateTrunc`

`groupBy` is a map from an output name to an expression. A date bucket is a `dateTrunc` of the date field. The unit is a `lit`, and it may be `second`, `minute`, `hour`, `day`, `week` (ISO, Monday), `month` or `year`. `bucket` only ever took `day` and `hour`.

Before:

```json
{ "shop/Sale": { "params": {
  "aggregate": { "n": { "count": true }, "total": { "sum": "price" } },
  "bucket": { "field": "soldAt", "by": "day" } } } }
```

After:

```json
{ "shop/Sale": { "params": {
  "aggregate": { "n": { "count": true }, "total": { "sum": "price" } },
  "groupBy": { "bucket": { "dateTrunc": [{ "lit": "day" }, "soldAt"] } } } } }
```

The group name is yours: `bucket` keeps the output key the old param wrote, so a client that reads `group.bucket` needs no other change. Three things about the output differ, in section 5.

`createdAt`, `updatedAt` and `seq` work in expressions, so `dateTrunc` over `createdAt` is a day group as `bucket: { field: "createdAt", ... }` was.

### 2. `derive` becomes `select`

`select` is a map from an output name to an expression. Each row of a row read gains one key per entry, and `orderBy` may name it. The `$` prefix on `orderBy` keys is gone.

| Before | After |
|---|---|
| `derive: { m: { diff: ["$.a", "$.b"] } }` | `select: { m: { sub: ["a", "b"] } }` |
| `derive: { r: { ratio: ["$.a", "$.b"] } }` | `select: { r: { div: ["a", "b"] } }` |
| `derive: { v: { value: "_agg.n" } }` | `select: { v: "_agg.n" }` |
| `orderBy: [{ "$m": "desc" }]` | `orderBy: [{ "m": "desc" }]` |

Before:

```json
{ "cards/Cert": { "params": {
  "derive": { "margin": { "diff": ["$.psaOffer", "$.ask"] } },
  "orderBy": [{ "$margin": "desc" }], "limit": 20 } } }
```

After:

```json
{ "cards/Cert": { "params": {
  "select": { "margin": { "sub": ["psaOffer", "ask"] } },
  "orderBy": [{ "margin": "desc" }], "limit": 20 } } }
```

What else differs:

- **The value is returned.** A derived value only ordered the page. A `select` value is a key on each row, so `margin` above comes back beside the row's fields.
- **A name may not collide** with a field of the type, a row key or a nested selection. It is refused `select_invalid`. `derive` names had the `$` namespace to themselves, so a client that named one after a field must rename it.
- **`_agg.<name>` stays a bare string** that reads the frame's walk aggregate, as in the `value` row above. The aggregate must be one the frame selects.
- **The numeric guard is gone.** A derive treated a value outside ±1e300, or under 1e-300 in magnitude, as null. A `select` does not: it returns the value, and an overflow raises (section 6). `div` still returns null for a zero divisor, and a null or non-numeric operand still gives null.

### 3. Error codes and plan kinds

- `bucket_invalid` and `derive_invalid` no longer exist. Their cases are `group_invalid`, `select_invalid`, `agg_invalid` and `expr_invalid`.
- The `plan` a read returns, and the NL outcome's `plan`, name clauses by `kind`. `derive` is now `select`, and `bucket` is now `group` with the path `['groupBy', '<name>']`. A `group` clause appears for a key that truncates a date field.

### 4. New read params

All of these work on Postgres and memory with the same answers, and a grouped read is one SQL statement on Postgres.

| Param | What it does |
|---|---|
| `select` | Computed values on each row of a row read. See section 2. |
| `where.$expr` | A boolean expression, ANDed with the rest of `where`. It sits beside field filters and inside `AND`/`OR`. It is refused inside a `_walk`. |
| `like`, `notLike` | Where operators and expression functions: SQL `LIKE`, with `%` and `_` and a backslash escape. A pattern ending in a lone backslash is refused. |
| `groupBy` | One group per distinct key tuple of an aggregate read. Without `groupBy`, an aggregate is one group, as before. |
| `having` | A boolean expression over the group keys and aggregate names, applied before order and limit. |
| `offset` | Groups to skip on a grouped read. |
| `countDistinct` | `{ "countDistinct": <expr> }` as an aggregate. |
| `count: <expr>` | Counts non-null values. `count: true` still counts rows. |
| `sum`, `avg`, `min`, `max` of an expression | `{ "avg": { "add": ["width", 1] } }`. A bare string is still a field name. |

An expression is a field name, a number, a boolean, `null`, `{ "lit": "text" }`, `{ "int64": "9007199254740993" }`, or `{ "<fn>": [args] }`. The function catalogue is in the `schema` reply. Without `orderBy`, groups come back with their keys ascending, a null key last. `limit` caps the groups and `truncated` says when it cut some, on every grouped read.

### 5. Output changes

- **A date group key is an instant, not text.** A day bucket was the text `2026-10-12` and an hour bucket `2026-10-12T09`. A `dateTrunc` key is a date, and a computed date is one canonical form on both engines: UTC, to the microsecond, `2026-10-12T00:00:00.000000Z` and `2026-10-12T09:00:00.000000Z`. Parse it as a timestamp, or cut the text to the length you need.
- **Rows with no readable date now form a group.** A bucket dropped a row whose date was null or unreadable. A `dateTrunc` key is null for it, and the null group is returned last.
- **Dates in `select` and in aggregates use the same form.** A date `select` value, a date `min` or `max` with or without `groupBy`, and a date group key all come back as canonical microsecond text. A plain read of the stored field still returns the stored text, which may carry a different offset or precision.

### 6. Behaviour changes

- **`like` is case-sensitive.** `contains`, `startsWith` and `endsWith` are unchanged and case-insensitive. Use `like` when case matters.
- **`mod` takes int64 only.** A safe-integer literal counts as one. A zero divisor gives null.
- **`upper` and `lower` map ASCII letters only.** Every other character is unchanged, on both engines.
- **`regexpReplace` replaces the leftmost-longest match**, as Postgres does: `(a?)(ab)?` on `ab` matches all of `ab`. A `regexpReplace` pattern may use capturing groups or `|`, not both, because the engines pick different captures for that mix. `regexpMatch` takes either.
- **A regex on the memory engine has a step budget.** A call that would take more than about 200 ms, such as a long counted pattern over a value of many kilobytes, raises `regex_budget_exceeded`. This bounds `$expr` in subscriptions on every deployment. Postgres reads are not affected.
- **Arithmetic overflow raises.** A result outside its type raises `value_out_of_range`, in a `select` as in a group key, an aggregate argument or `having`. A `select` value is computed for the rows a read returns or orders by, so an overflow raises when the value is computed for such a row; an overflow on a row outside the page may or may not raise. A float product or quotient that underflows to zero from nonzero operands raises too.
- **An int64 `sum` that leaves the int64 range raises on every group**, including a group that `having` or `limit` would have dropped.
- **Date and number metadata work in expressions.** `createdAt`, `updatedAt` and `seq` read in `select`, `groupBy`, `where.$expr` and aggregate arguments on both engines. The string metadata names (`createdById` and the like) are not expression fields and are refused `expr_invalid`.
- **A number field that holds something else reads as null** in an expression, on memory as on Postgres.
- **Names.** A group name may not also be an aggregate name (`group_invalid`). With `groupBy`, `orderBy` names group and aggregate outputs only. An aggregate takes no `select` or `cursor`, and no `orderBy` unless it has `groupBy`.

### 7. The `int64` field kind

`field.int64()` declares a 64-bit integer, stored as a Postgres `bigint` and held as a `bigint` in memory. On the JSON wire it is a **decimal string**, such as `"9007199254740993"`, so no digit is lost to a double. A write accepts a bigint, a safe-integer number or a canonical decimal string within the int64 range, and a filter operand takes the same. A cursor carries an int64 as decimal text. In an expression, `{ "int64": "<decimal>" }` is the literal. `sum` of an int64 is exact, `avg` is the exact sum over the count as a float, and `add`, `sub`, `mul` and `neg` stay int64 when both sides are.

### The `int32` field kind

`field.int32()` declares a 32-bit integer, stored as a Postgres `integer` and held as a plain number in memory and on the JSON wire. A write and a filter operand must be an integer from -2147483648 to 2147483647; anything else is refused (`invalid_field_type` on a write, `type_mismatch` on a filter). In an expression an int32 field reads as an int64, so `add`, `sub`, `mul`, `neg` and `mod` over it stay exact integers and raise only past the int64 range, and `sum` is an exact int64 (a decimal string on the JSON wire). Use it for integer columns that fit, instead of `number`: sums are native and exact, and the column is half the width. A field cannot change kind in place, so moving a `number` field to `int32` means a new field and a backfill.

### The `int16` field kind, and choosing an integer width

`field.int16()` declares a 16-bit integer, stored as a Postgres `smallint`. It behaves exactly as `int32` does, with the range -32768 to 32767 and an `expected an int16` refusal outside it.

Pick the narrowest kind whose range holds every value the field will ever take, because the kind cannot change once rows exist:

| Kind | Range | Bytes | Fits |
|---|---|---|---|
| `int16` | -32768 to 32767 | 2 | small codes, flags, ages, percentages |
| `int32` | about ±2.1 billion | 4 | counts, durations, ids within one source |
| `int64` | about ±9.2e18 | 8 | totals, epoch milliseconds, external ids |

When unsure, take the next width up. Use `number` for fractional values. The width sets storage only: all three filter, sort and sum as exact integers.

### Reserved field names

These nine names are reserved for server metadata and can no longer be declared as body fields: `createdAt`, `updatedAt`, `seq`, `createdBy`, `updatedBy`, `createdById`, `createdByKind`, `updatedById` and `updatedByKind`. `defineNamespace` (on every type, autoCRUD or not), `propose_type` and `propose_field` refuse a field with one of these names, and the message names the field and says it is reserved for server metadata. `createdAt`, `updatedAt` and `seq` read as metadata in expressions, and `where` and `orderBy` read all nine as metadata, so none can collide with a body field. The six string names are refused in expressions (`expr_invalid`). Pre-1.0, so a type that declares one must rename it before upgrading.

- **A code-defined type declaring one fails at boot.** Rename it: a rename does not move values already stored under the old key, so existing rows need a backfill, which for a code-defined type means a new field plus a backfill.
- **The proposals plugin has no rename path.** For a proposed type, rename means proposing a new field and backfilling it.
- **A stored proposed type or field that uses a reserved name is skipped at boot**, with one warning line naming the namespace, type and field and a `_system_proposals.replay_skipped` metric. Boot goes on. The rows stay in the store, but the type is not registered, so it is unreachable until it is fixed. Each stored field proposal for a skipped type is skipped too, with its own line and metric. A peer instance's notification for such a row is skipped the same way.
- **To recover a skipped proposed type**, an identity with the propose grant archives its stored `TypeProposal` row (`<ns>/updateTypeProposal` with `archived: true`; the `admin` grant too once the type has rows, as `drop_type` needs) and proposes the type again with the field renamed, then re-proposes any fields the warning lines name. A skipped `FieldProposal` on a live type is archived the same way (`<ns>/updateFieldProposal`) and proposed again under a new name. Values stored under the old key are not moved; backfill them into the new field.

## Plugin authors

### 8. `autocrud` and `ReadParams`

- `ReadParams.bucket`, `ReadParams.derive`, `BucketSpec` and `DeriveSpec` are removed from `@mnmal-ai/substrate-types`. Use `groupBy`, `select` and `Expr`.
- The generated list query refuses `bucket` and `derive` with `unknown_param`, like any other unknown param.
- `PlanClause.kind` is `'hop' | 'filter' | 'order' | 'ref' | 'select' | 'group' | 'agg'`.

`FieldKind` gains `'scalar.int16'` and `'scalar.int32'`, so a dataset's `capabilities.operators` must list operators for it (`fullBuiltinOperators()` already does).

A dataset implementation that read `params.bucket` or `params.derive` must read `groupBy` and `select`. `groupRows` and `buildGroupedRead` are the shared grouped paths on memory and Postgres.

## The NL plugin and the MCP tool

- A question such as "total price of sales per day" now sends `groupBy: { bucket: { dateTrunc: [{ lit: "day" }, "<timeField>"] } }`, over `createdAt` when the type has no `timeField` ruling, as before. The outcome's `aggregate.groups[].key` is still the day (`2026-10-20`) or the hour (`2026-10-20T09`), cut from the instant the engine returns, and a null-key group (a row with no time field) is left out as the old bucket left those rows out, so a consumer of the outcome sees no change. Week, month and year are still dropped with a reason. A computed-ordering ruling whose name is also a field of the type is dropped with a reason, since a `select` name may not collide with a field.
- A `fieldPhrases` ruling that declared `derive: { diff: [...] }` or `derive: { ratio: [...] }` is now `select: { sub: [...] }` or `select: { div: [...] }`, with the same `'<Type>.<field>'` operands. A ruling file that still says `derive` is refused as an unknown key.
- Ordering across one hop sends `select: { <name>: "_agg.<name>" }` and `orderBy: [{ "<name>": dir }]`.
- The `query` tool's description names `groupBy`, `having`, `offset`, `select` and expressions in place of `bucket` and `derive`.
