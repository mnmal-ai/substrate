# Edge walks

A walk follows a crossRef field from one row to the rows it connects to, inside a query. With walks, one query frame can filter on related rows, aggregate over them, nest them in the result, and compare a row against its neighbours. This page is the reference for that grammar: every key, what it means, its limits, and the refusal codes.

Walks are query-only. A subscription or stream refuses them with `walks_in_subscription` and a mutation with `walks_in_mutation`; see [Surface parity](surface-parity.md). They run on Postgres. The in-memory store does not answer them and refuses with `walks_unsupported_store`.

## The example schema

Every example uses one namespace, `ci`:

| Type | Fields |
|---|---|
| `ci/Repo` | `name: string` |
| `ci/Job` | `repo: →Repo`, `name: string`, `required: boolean`, `timeoutMs: number` |
| `ci/Run` | `job: →Job`, `status: string` (`passed`, `failed` or `skipped`), `startedAt: date`, `finishedAt: date`, `durationMs: number` |
| `ci/Step` | `run: →Run`, `name: string`, `durationMs: number` |

A Run points at its Job, and a Job at its Repo. The schema overview marks the reverse direction as `←Run.job` on `Job`.

## `_walk` in `where`

`_walk` is a where-clause node. It names one edge and, optionally, a `where` that the rows at the far end are judged by:

```jsonc
{ "_walk": { "in" | "out": ..., "where"?: ..., "quantifier"?: ..., "pick"?: ..., "among"?: ..., "as"?: ... } }
```

It ANDs with its siblings, like any other key of a where object, and it can sit inside `AND`, `OR` and `NOT`.

### Direction: `in` and `out`

`out: "<field>"` follows a crossRef on the current type to the row it points at. Runs whose job is required:

```json
{ "ci/Run": { "params": { "where": {
  "_walk": { "out": "job", "where": { "required": { "eq": true } } }
} } } }
```

`in: "<ns>/<Type>.<field>"` follows a crossRef backwards: the rows of `<Type>` whose `<field>` points at the current row. Jobs with at least one failed run:

```json
{ "ci/Job": { "params": { "where": {
  "_walk": { "in": "ci/Run.job", "where": { "status": { "eq": "failed" } } }
} } } }
```

A walk names exactly one of `in` and `out`. The far side's `where` is validated as a top-level read of the far type would be, so its fields and operators are those of the far type.

Walks chain: a walk's `where` can hold another walk. Runs of any job in the `api` repo:

```json
{ "ci/Run": { "params": { "where": {
  "_walk": { "out": "job", "where": {
    "_walk": { "out": "repo", "where": { "name": { "eq": "api" } } }
  } }
} } } }
```

A walk follows the crossRef value stored in the row, the same value a read returns. Deleted rows are never walked.

What a walk can follow:

- A top-level crossRef with a single value. A list of crossRefs, or a crossRef nested in a struct, is refused with `walk_unsupported_ref`.
- An edge inside the frame's own namespace. A walk that would leave it is refused with `walk_cross_namespace`.
- With `in`, the named field must point at the current type, or the walk is refused with `walk_unknown_ref`.

`_walk`, `_agg` and `$ref` are not valid inside a struct field's predicate (`walk_unsupported_ref`).

### Quantifiers

`quantifier` says how many far rows must pass the walk's `where`:

| Quantifier | True when |
|---|---|
| `any` (the default) | at least one far row passes |
| `none` | no far row passes |
| `all` | every far row passes |

A row with no far rows at all passes `none` and `all`, and fails `any`. Jobs where no run has failed:

```json
{ "ci/Job": { "params": { "where": {
  "_walk": { "in": "ci/Run.job", "quantifier": "none", "where": { "status": { "eq": "failed" } } }
} } } }
```

Jobs whose runs all passed, including jobs that have never run:

```json
{ "ci/Job": { "params": { "where": {
  "_walk": { "in": "ci/Run.job", "quantifier": "all", "where": { "status": { "eq": "passed" } } }
} } } }
```

Any other quantifier value is refused with `walk_quantifier`.

### `pick`: judge one far row

`pick` chooses one far row, and the walk's `where` then judges that row alone:

| Pick | Chooses | Field kind |
|---|---|---|
| `{ "latest": "<field>" }` | the highest value | date |
| `{ "max": "<field>" }` | the highest value | number or date |
| `{ "min": "<field>" }` | the lowest value | number or date |

Rows whose field is null come last whichever way the pick orders, and ties go to the lowest `id`. When there are no far rows, nothing is picked and the walk is false.

Jobs whose latest run failed:

```json
{ "ci/Job": { "params": { "where": {
  "_walk": { "in": "ci/Run.job", "pick": { "latest": "startedAt" }, "where": { "status": { "eq": "failed" } } }
} } } }
```

A pick walk picks one row, so it takes no `none` or `all` quantifier (`walk_quantifier`). It may say `quantifier: "any"`, which changes nothing. A pick on an unknown field is refused with `unknown_field`, and a pick on a field of the wrong kind with `type_mismatch`.

### `among`: narrow the rows a pick chooses from

`among` is a where clause over the far type that runs before the pick. It narrows the candidates; `where` then judges the row that was picked. The two answer different questions:

- `among` decides which rows the pick can choose.
- `where` decides whether the chosen row passes.

Jobs whose latest run that was not skipped failed:

```json
{ "ci/Job": { "params": { "where": {
  "_walk": {
    "in": "ci/Run.job",
    "pick": { "latest": "startedAt" },
    "among": { "status": { "neq": "skipped" } },
    "where": { "status": { "eq": "failed" } }
  }
} } } }
```

Take a job whose runs, newest first, are `skipped`, `failed`, `passed`. With the `among` above, the skipped run is never a candidate, the failed run is picked, and the job matches. Move the same condition into `where` instead, as `{ "AND": [{ "status": { "neq": "skipped" } }, { "status": { "eq": "failed" } }] }`, and the skipped run is picked, fails `where`, and the job does not match.

When `among` leaves no candidates, nothing is picked and the walk is false. `among` is valid only on a pick walk; without a pick, put the condition in `where` (`walk_quantifier` otherwise).

### `as` and `$ref`: compare against another row

An `any` walk can bind its far row to a name with `as`. A comparison elsewhere then reads a field of that row as its operand with `$ref`. Jobs that failed after having passed:

```json
{ "ci/Job": { "params": { "where": { "AND": [
  { "_walk": { "as": "P", "in": "ci/Run.job", "where": { "status": { "eq": "passed" } } } },
  { "_walk": { "in": "ci/Run.job", "where": { "AND": [
    { "status": { "eq": "failed" } },
    { "startedAt": { "gt": { "$ref": "P.startedAt" } } }
  ] } } }
] } } } }
```

**Joint quantification.** Walks with `as` in the same AND group are quantified together: the group is true when there is some choice of one far row per name that makes every member of the group true. Two bound walks therefore mean "there is a pair of rows such that…", not two separate existence checks. Jobs with a passed run and a failed run where the failed one took more than twice as long:

```json
{ "ci/Job": { "params": { "where": { "AND": [
  { "_walk": { "as": "P", "in": "ci/Run.job", "where": { "status": { "eq": "passed" } } } },
  { "_walk": { "as": "F", "in": "ci/Run.job", "where": { "AND": [
    { "status": { "eq": "failed" } },
    { "durationMs": { "gt": { "$ref": "P.durationMs", "times": 2 } } }
  ] } } }
] } } } }
```

An AND group is one where object together with the members of its `AND` lists, recursively. `OR` and `NOT` start new groups, and so does a walk's own `where`.

The rules:

- Only an `any` walk binds `as`. A `none`, `all` or pick walk cannot be referenced, so it cannot carry `as` (`walk_quantifier`). It can still reference a binding from an enclosing or sibling `any` walk.
- A name is an identifier (a letter, then letters, digits or `_`) and is bound once per scope (`walk_binding`).
- A binding is visible to the members of its AND group and everything inside them.
- A binding cannot be referenced across or under an `OR` or `NOT` (`walk_binding`). Only `$` can.
- An AND group binds at most 3 walks with `as`, and a frame at most 6 (`walk_binding`).

### `$ref` operands

A `$ref` replaces the literal operand of a comparison:

| `$ref` | Reads |
|---|---|
| `"$.<field>"` | the seed row, the row the frame is reading |
| `"<as>.<field>"` | the row bound to `<as>` |
| `"_agg.<name>"` | the seed row's walk aggregate `<name>`, which the frame must select in `fields._agg` |

Rules:

- `$ref` is allowed on `eq`, `neq`, `gt`, `gte`, `lt` and `lte`, and only on number and date fields (`type_mismatch` for another operator, `ref_kind_mismatch` for another field kind).
- The referenced value must be the same kind as the field it is compared with (`ref_kind_mismatch`).
- A name or field that does not resolve is `ref_unresolved`.
- Beside `$ref`, a number takes `times` and `plus`: the operand is `value * times + plus`.
- A date takes `plus` only, in milliseconds, at most `1e13` either way. `times` on a date is refused with `ref_kind_mismatch`.
- A comparison with a `$ref` whose value is null is never true, for every operator including `eq` and `neq`. So a `none` walk over such rows is true. A literal `eq: null` keeps its is-null meaning.

`$.` compares fields of one row. Runs that finished more than an hour after they started:

```json
{ "ci/Run": { "params": { "where": {
  "finishedAt": { "gt": { "$ref": "$.startedAt", "plus": 3600000 } }
} } } }
```

Inside a walk, `$` is still the seed row. Jobs with a run that went over the job's own timeout:

```json
{ "ci/Job": { "params": { "where": {
  "_walk": { "in": "ci/Run.job", "where": { "durationMs": { "gt": { "$ref": "$.timeoutMs" } } } }
} } } }
```

## Walk aggregates: `_agg`

A walk aggregate is one value computed per seed row over the rows one walk reaches. It takes `in` or `out`, an optional `where` over the far rows, and exactly one function:

| Function | Value | Field |
|---|---|---|
| `"count": true` | number of far rows | none |
| `"avg": "<field>"` | number | number |
| `"sum": "<field>"` | number | number |
| `"min": "<field>"` | the field's kind | number or date |
| `"max": "<field>"` | the field's kind | number or date |
| `"latest": { "by": "<date field>", "value": "<field>" }` | `value` of the far row latest by `by` | `value` is any scalar except json |

`avg`, `sum`, `min` and `max` ignore nulls. Over no far rows, every function is null except `count`, which is 0. `latest` breaks ties as a pick does: nulls last, then the lowest `id`.

A walk aggregate takes `in`, `out` and `where`, and nothing else: no `quantifier`, `pick`, `among` or `as`.

### In `fields`

`fields._agg` maps names to aggregates. Each row comes back with an `_agg` object holding one value per name. Per job, its run count, its mean duration over passed runs, and the status of its latest run:

```json
{ "ci/Job": {
  "params": { "limit": 20 },
  "fields": { "id": true, "name": true, "_agg": {
    "runs": { "in": "ci/Run.job", "count": true },
    "meanMs": { "in": "ci/Run.job", "where": { "status": { "eq": "passed" } }, "avg": "durationMs" },
    "lastStatus": { "in": "ci/Run.job", "latest": { "by": "startedAt", "value": "status" } }
  } }
} }
```

```jsonc
[{ "id": "…", "name": "lint", "_agg": { "runs": 12, "meanMs": 41000, "lastStatus": "failed" } }, …]
```

Names are identifiers, and `_agg` needs at least one entry. One aggregate cannot reference another. `_agg` is valid only at the top level of a type's selection, or of a nested selection (`walk_unsupported_ref` elsewhere).

### In `where`

In a where clause, `_agg` is one comparison: the aggregate, plus one or more of `eq`, `neq`, `gt`, `gte`, `lt` and `lte` beside it. Jobs with at least three failed runs:

```json
{ "ci/Job": { "params": { "where": {
  "_agg": { "in": "ci/Run.job", "where": { "status": { "eq": "failed" } }, "count": true }, "gte": 3
} } } }
```

The operand is a number, a date or a string to match the aggregate's value, or a `$ref`. Nothing else may sit beside `_agg` in that object; put other conditions in their own clause under `AND` (`agg_invalid`). An `_agg` with no comparison is refused the same way.

To compare a field with an aggregate the frame selects, use `$ref: "_agg.<name>"`. Jobs whose timeout is below their mean run time:

```json
{ "ci/Job": {
  "params": { "where": { "timeoutMs": { "lt": { "$ref": "_agg.meanMs" } } } },
  "fields": { "id": true, "_agg": { "meanMs": { "in": "ci/Run.job", "avg": "durationMs" } } }
} }
```

## Nested selections

A `fields` entry whose value has a `_walk` returns the far rows as a list under that name on each row:

```jsonc
"<name>": { "_walk": { "in" | "out": ..., "where"?: ... }, "fields": { ... }, "where"?: ..., "orderBy"?: [...], "limit"?: n }
```

Each job with its five most recent failed runs:

```json
{ "ci/Job": { "fields": {
  "id": true,
  "name": true,
  "recentFailures": {
    "_walk": { "in": "ci/Run.job" },
    "where": { "status": { "eq": "failed" } },
    "fields": { "startedAt": true, "durationMs": true },
    "orderBy": [{ "startedAt": "desc" }],
    "limit": 5
  }
} } }
```

```jsonc
[{ "id": "…", "name": "lint",
   "recentFailures": [{ "id": "…", "startedAt": "…", "durationMs": 52000 }, …],
   "_truncated": { "recentFailures": true } }, …]
```

- The nested `_walk` takes only `in`, `out` and `where`. The selection's own `where` filters the far rows the same way.
- Without `orderBy`, the list comes in the far type's natural order. `id` ascending breaks ties.
- `limit` is a non-negative integer. Without one, the list gets the default page size. Above the maximum page it is refused with `limit_exceeds_max`. There is no cursor for a nested list.
- When a list was cut by its limit, the row carries `_truncated` naming that list. A list that was not cut is absent from `_truncated`.
- Nested rows carry `id` and the selected fields. `_metadata`, `shortId` and `_deletedAt` are not available in a nested selection (`unknown_field`), and `shortId` cannot order one.
- The name cannot be a declared field of the type (`walk_unsupported_ref`).
- A nested selection's `fields` can hold its own `_agg` and nested selections. Each level counts as a hop toward the depth limit.

## Frame counts and aggregates

These params shape the whole frame's answer rather than each row. They are documented in full, with the expression grammar, in [Upgrading to the warehouse grammar](upgrading-to-warehouse-grammar.md). The rules that matter alongside walks follow.

### `count`

`count: true` returns `{ "count": n }` and no rows. The frame's `where` may hold walks. Required jobs in the `api` repo whose latest run failed:

```json
{ "ci/Job": { "params": {
  "where": { "AND": [
    { "required": { "eq": true } },
    { "_walk": { "out": "repo", "where": { "name": { "eq": "api" } } } },
    { "_walk": { "in": "ci/Run.job", "pick": { "latest": "startedAt" }, "where": { "status": { "eq": "failed" } } } }
  ] },
  "count": true
} } }
```

`count` takes `true` or `false`. With `count: true` the frame takes no `aggregate`, `select`, `orderBy` or `cursor`, and selects only `id` (`count_conflict`).

### `aggregate`, `groupBy`, `having`

`aggregate` maps names to frame aggregates: `count` (`true` counts rows, an expression counts its non-null values), `countDistinct`, `avg`, `sum`, `min` and `max`, each over an expression. `latest` is a walk aggregate only and is refused here (`agg_invalid`). Without `groupBy` the answer is one group. With it, one group per distinct key:

```json
{ "ci/Run": { "params": {
  "where": { "_walk": { "out": "job", "where": { "required": { "eq": true } } } },
  "aggregate": { "n": { "count": true }, "meanMs": { "avg": "durationMs" } },
  "groupBy": { "day": { "dateTrunc": [{ "lit": "day" }, "startedAt"] }, "status": "status" },
  "having": { "gte": ["n", 10] },
  "orderBy": [{ "day": "desc" }],
  "limit": 30
} } }
```

```jsonc
{ "groups": [{ "day": "2026-11-12T00:00:00.000000Z", "status": "failed", "n": 14, "meanMs": 48100 }, …] }
```

- `groupBy`, `having` and `offset` need `aggregate` (`agg_invalid`).
- An aggregate frame takes no `select` or `cursor`, takes `orderBy` only with `groupBy`, and selects only `id` (`agg_invalid`).
- A `groupBy` name may not also be an aggregate name (`group_invalid`). With `groupBy`, `orderBy` names group and aggregate outputs only (`agg_invalid`).
- `having` is a boolean expression over the group and aggregate names, and sees nothing else.
- `limit` caps the groups and `offset` skips them.
- Frame aggregate expressions cannot read `_agg.<name>`.

### `select` and ordering by derived values

`select` maps names to expressions. Each row gains one key per entry, and `orderBy` may name it. A `select` expression can read the frame's walk aggregates as the bare string `"_agg.<name>"`. Jobs ordered by how far their timeout sits above their mean run time, tightest first:

```json
{ "ci/Job": {
  "params": {
    "select": { "headroomMs": { "sub": ["timeoutMs", "_agg.meanMs"] } },
    "orderBy": [{ "headroomMs": "asc" }],
    "limit": 20
  },
  "fields": { "id": true, "name": true, "_agg": { "meanMs": { "in": "ci/Run.job", "avg": "durationMs" } } }
} }
```

- A `select` name is an identifier. It may not collide with a field of the type, a row key such as `id` or `createdAt`, or a nested selection's name (`select_invalid`).
- An `_agg` used in an expression must be one the frame selects, and must have a number, date or string value. A boolean or int64 aggregate value is refused with `expr_invalid`.
- `select` replaces the old `derive` param, which is refused with `unknown_param`.

## Limits

| Limit | Value | Refusal |
|---|---|---|
| Hops in one chain, nested selections and aggregates included | 3 | `walk_too_deep` |
| Walks with `as` in one AND group | 3 | `walk_binding` |
| Walks with `as` in one frame | 6 | `walk_binding` |
| Date shift on a `$ref` | `1e13` ms either way | `type_mismatch` |
| Expression nodes per expression / per frame | 64 / 1024 | `expr_invalid` |
| Expression depth | 16 | `expr_invalid` |
| Nested selection `limit` | the server's maximum page | `limit_exceeds_max` |
| Running time of a walk read on Postgres | `SUBSTRATE_STATEMENT_TIMEOUT_MS`, 30 s by default | `query_timeout` |

The hop limit counts from the seed row. A walk inside a walk inside a walk is three hops, and a fourth is refused. That applies down every path: a walk's `where`, a walk aggregate, and a nested selection's `_walk` and `where`.

On Postgres, a walk read runs under a statement timeout. A read that runs longer is cancelled and refused with `query_timeout`, carrying `details.timeoutMs`; see [Operator decisions](operator-decisions.md#statement-timeout). The reference evaluator behind the in-memory store's test mode counts walk work instead: each far row a hop examines and each binding combination tried costs one, against a budget of 1,000,000 per read. Past it, the read is refused with `walk_budget_exceeded`. When either happens, narrow the walks, or bind fewer of them in one AND group.

## Refusal codes

A refused frame is absent from `data`, and its error carries the code and a path to the part of the frame that was refused. Read the message as well: it names the field, edge or binding.

Grammar refusals, before anything runs:

| Code | Meaning |
|---|---|
| `walk_unknown_ref` | The walk's edge does not resolve: it names both or neither of `in` and `out`; `in` is not `<ns>/<Type>.<field>`; the type is unknown; the field is not a crossRef; an `in` field does not point at the current type. Also returned when walks are not available on the read at all. |
| `walk_unsupported_ref` | A walk construct where it cannot be answered: a list of crossRefs or a crossRef nested in a struct; `_walk`, `_agg` or `$ref` inside a struct predicate; `_agg` or a nested selection below the top level of a selection; a nested selection reusing a declared field name; any walk on a virtual type. |
| `walk_cross_namespace` | The walk would leave the frame's namespace. |
| `walk_too_deep` | More than 3 hops. |
| `walk_binding` | A bad `as`: not an identifier, already bound, more than 3 in an AND group or 6 in a frame, or a `$ref` to a binding across or under `OR` / `NOT`. |
| `walk_quantifier` | A quantifier other than `any`, `none` or `all`; `as` on a `none`, `all` or pick walk; `none` or `all` with `pick`; `among` without `pick`. |
| `ref_unresolved` | A `$ref` that is not `$.<field>`, `<as>.<field>` or `_agg.<name>`, or that names no binding, field or selected aggregate. |
| `ref_kind_mismatch` | A `$ref` on a field that is not a number or date, a `$ref` whose value kind differs from the field's, or `times` on a date. |
| `agg_invalid` | A malformed `_agg` or `aggregate`: no function or more than one, an unknown key, a field of the wrong kind, a bad name, an empty map; a where-side `_agg` without a comparison or with another key beside it; `latest` as a frame aggregate; `groupBy`, `having` or `offset` without `aggregate`; `select`, `cursor`, `orderBy` or a field other than `id` on an aggregate frame. |
| `group_invalid` | An empty or malformed `groupBy`, a bad name, or a name shared with an aggregate. |
| `select_invalid` | A malformed `select`, a bad name, or a name that collides with a field, a row key or a nested selection. |
| `expr_invalid` | An expression that does not type-check, a non-boolean `having` or `$expr`, an unusable `_agg` value, `$expr` inside a walk, or an expression over its node or depth limit. |
| `count_conflict` | `count: true` with `aggregate`, `select`, `orderBy`, `cursor`, or a field other than `id`. |
| `type_mismatch` | A wrong shape: an unknown walk or nested selection key, a malformed `pick`, a pick field of the wrong kind, `$ref` on an operator it does not allow, a bad `times` / `plus`, a date shift past `1e13` ms, a bad nested `limit` or `offset`, a nested selection without `fields`. |
| `unknown_field` | A field the far type does not have, in a walk's `where` or `among`, a `pick`, or a nested selection; or `_metadata`, `shortId` or `_deletedAt` in a nested selection. |
| `limit_exceeds_max` | A nested selection's `limit` is above the maximum page. |

Refusals that depend on where the frame is sent or who sends it:

| Code | Meaning |
|---|---|
| `walks_in_subscription` | A walk construct in a subscription or stream. Walks are query-only. |
| `walks_in_mutation` | A walk construct in a mutation's returned-row selection or its by-filter `where`. |
| `walks_unsupported_store` | The namespace's store does not answer walks, such as the in-memory store. |
| `row_policy_blocks_walk` | The seed type, or a type the frame walks into, counts or aggregates over, is row-filtered for this caller. A row filter runs after the read, so it cannot be applied inside a walk. A plain read of a row-filtered seed type still works. |
| `policy_denied` | A read policy on a walked type denies this caller. |

Refusals while running:

| Code | Meaning |
|---|---|
| `query_timeout` | The walk read passed the statement timeout on Postgres. |
| `walk_budget_exceeded` | The reference evaluator ran out of walk budget. |
| `value_out_of_range` | An expression or aggregate value left its type's range. |
