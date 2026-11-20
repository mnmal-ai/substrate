---
order: 5
name: warehouse
promise: Monthly totals and per-customer rollups, asked in the same frames as every read.
shows:
  - Unpaid totals by the month they fall due, grouped with dateTrunc
  - Money summed exactly as int64, returned as a decimal string
  - Each customer's open invoices and next due date, through a walk
extras: [clickbench]
---

## Elsewhere

Reports over app data usually sit apart from the app's API. Monthly totals are hand-written SQL, a `GROUP BY` on `date_trunc('month', due_at)` with a `sum`, behind a report endpoint or a view. API layers cover part of it. [PostgREST's aggregate functions](https://docs.postgrest.org/en/stable/references/api/aggregate_functions.html) group by the other columns you select and work across embedded resources, once an operator turns them on. [Hasura's aggregation queries](https://hasura.io/docs/2.0/queries/postgres/aggregation-queries/) give `count`, `sum`, `avg`, `max` and `min`, nested over relationships, and for more advanced cases [its docs](https://hasura.io/docs/2.0/queries/postgres/aggregation-queries/) suggest views or custom SQL functions. All of these work over tables you already have, which substrate doesn't: it aggregates the types you declare.

As the data grows, analytics often move to a warehouse. [ClickHouse](https://clickhouse.com/docs/intro) is a column-oriented database built for analytic queries over billions of rows. Getting the data there is a pipeline: [ClickHouse Cloud's Postgres ClickPipe](https://clickhouse.com/docs/integrations/clickpipes/postgres) takes an initial snapshot, then replicates changes continuously. [DuckDB's postgres extension](https://duckdb.org/docs/2.0/core_extensions/postgres/overview.html) skips the copy and reads a running PostgreSQL database directly, at query time. Either way, it's a second engine and a second place to ask, beside the API the app and its agents read through.

## On substrate

The scenario is a small invoicing app: three customers and eight invoices, all invented, seeded from [`_scenario.ts`](https://github.com/mnmal-ai/substrate/blob/main/apps/site/examples/_scenario.ts), which most of the examples share. The script below runs against substrate's engine in substrate's CI, and the responses shown are that run's output, not typed in.

Analytics are frames like every other read, sent to the same route. They take `groupBy` with `dateTrunc`, sums and counts, and walks that aggregate across a reference. Over the same invoices, the run asks what is outstanding by the month it falls due, then each customer's open invoices with the next due date.

`amount` is an `int64` in integer minor units, cents here. Replies carry it as a decimal string so no digit is lost, and it sums exactly. A write may send it as a number while it is a safe integer, as this run's seed does. A month key is a computed date, so it comes back as UTC text to the microsecond.

Below the run, [ClickBench](https://github.com/ClickHouse/ClickBench), a public benchmark for analytical databases, puts the same grammar to its 43 queries, each written as a frame, with its answer checked against the benchmark's own SQL.

## Where it stops

- **Per-customer sums through a walk aren't supported yet.** A walk aggregate's `sum` takes a `number` field, and `amount` is an `int64`. So the per-customer read shows open invoices and the next due date, not totals. The monthly totals come from a frame aggregate, which sums `int64` exactly.
- **The walk needs Postgres in a deployment.** This run is on the memory store with a test-only walk evaluator switched on. A server on the memory store refuses walks with `walks_unsupported_store`.
- **ClickBench is 42 compared / 43, on one machine class.** The block above names the machine it was measured on, outside substrate's CI. A query that came back empty on both sides isn't counted as compared.
- **ClickBench here is frames against SQL, on the same Postgres.** The frames read substrate's own table and the SQL reads a plain Postgres table, in one database, each loaded with the same rows: about 10M, every 10th row of the benchmark's data. It isn't a comparison with a columnar warehouse, and says nothing about how substrate would fare against one.
