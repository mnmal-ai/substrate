---
order: 8
name: self-tending
promise: The engine spots its own slow reads, and an agent approves the index it recommends.
shows:
  - Every read's shape and duration, recorded by the engine itself
  - An index recommendation an agent approves with one signed call
  - The same read again, now served by the new index
---

## Elsewhere

Finding the index a slow read needs is usually DBA work. Turn on [pg_stat_statements](https://www.postgresql.org/docs/current/pgstatstatements.html), which tracks planning and execution statistics for every statement and needs a server restart to load, or log the slow ones. Read the worst, run [`EXPLAIN`](https://www.postgresql.org/docs/current/sql-explain.html) to see whether each scans the table or uses an index, and decide what to add. Then the index goes into a migration, built with [`CREATE INDEX CONCURRENTLY`](https://www.postgresql.org/docs/current/sql-createindex.html) so writes aren't locked out. That can't run inside a transaction block, and a failed build can leave an invalid index behind, to drop and build again.

Tools help with the middle step. [Supabase's index_advisor](https://supabase.com/docs/guides/database/extensions/index_advisor) takes a query and searches for `CREATE INDEX` statements that improve its execution time, and Supabase Studio offers it per query in its Query Performance Report. index_advisor takes any query you give it, over tables you already have; substrate's advisor sees only its own reads, by type, filter fields and order. Deciding is still someone's call, and rightly: an index adds cost to every write to its table.

## On substrate

This example doesn't use the invoicing scenario that the others share in [`_scenario.ts`](https://github.com/mnmal-ai/substrate/blob/main/apps/site/examples/_scenario.ts). An agent proposes one type of its own, `ops/Event`, for operational events read by status, and says it expects the type to grow large. The run below comes from a script that substrate's CI runs against substrate's engine on Postgres, and the responses shown are that run's output, not typed in.

The engine records the shape and duration of every read. An advisor turns shapes that are frequent and slow into `_system/IndexRecommendation` rows, and builds nothing itself. An agent holding the `substrate.index` grant approves one with `propose_index`. It takes effect on the call, the index builds in the background, and an audit event records why.

This run forces it. The steps marked "Demo" seed events straight into the store and slow every read of `ops` by 60 ms, so the advisor recommends within one run instead of after real traffic. The last read returns the same rows, and the example's test runs `EXPLAIN` on the statement the engine sent and checks that the plan uses the new index.

## Where it stops

- **The load is simulated, and labelled.** The steps marked "Demo" seed 3,000 closed and 3 open events straight into the store, and slow every read of `ops` by 60 ms. That puts the reads over the advisor's 50 ms slow threshold, under the `scale` profile this run uses. A table this small wouldn't get there on its own.
- **The run triggers the advisor.** One pass runs just before the recommendations are read. A served binary's advisor reads every ten minutes (`SUBSTRATE_ADVISOR_INTERVAL_MS`).
- **`propose_index add` works on proposed types.** `ops/Event` is one. On a type defined in code, the call is refused with `index_on_code_defined_type`, and the recommendation is advice to the type's author, who adds the index in `defineNamespace`.
- **The grant is the gate.** Approving needs `substrate.index` in that namespace, which is separate from `substrate.propose`, and there is no pending state. Give it only to keys you'd trust to change indexes.
- **It needs Postgres.** The memory store builds no indexes and runs no advisor.
