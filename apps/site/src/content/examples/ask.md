---
order: 3
name: ask
promise: A question in English becomes a frame, then rows; the model never writes a query.
shows:
  - A parser that turns the question into a frame you can read
  - Rows from that frame, with the evidence for each word it read
  - A question it can't read answered unknown, with nothing run
---

## Elsewhere

The common way to answer questions over a database is text-to-SQL: give a model the schema and the question, let it write a query, and run that query. [LangChain's SQL agent](https://docs.langchain.com/oss/python/langchain/sql-agent) works this way: the agent generates a SQL command, and its tools execute it.

It's flexible. A capable model can answer questions that no fixed grammar will read. The cost is that the query is model output. [The same LangChain docs](https://docs.langchain.com/oss/python/langchain/sql-agent) say there are inherent risks in running it, advise narrowly scoped database permissions and validation before executing model-generated SQL, and add a query-checking tool and a human approval step before a query runs. So the moving parts are a model, a prompt that carries the schema, a check on what it writes, and a role narrow enough to limit the damage.

## On substrate

The scenario is a small invoicing app: three customers and eight invoices, all invented, seeded from [`_scenario.ts`](https://github.com/mnmal-ai/substrate/blob/main/apps/site/examples/_scenario.ts), which most of the examples share. The run below comes from a script that substrate's CI runs against substrate's engine, and the responses shown are that run's output, not typed in.

A deterministic parser turns the question into a frame, and an optional, constrained judge handles only what the parser leaves ambiguous: the model never writes a query. The answer carries the frame it ran and the words that justified each part of it. A question it can't read answers `unknown` and runs nothing. `ask` comes from the `@mnmal-ai/substrate-nl` plugin, which is installed separately.

The run asks two questions: how many sent invoices there are per month, and which customers are happy.

This deployment tells `ask` that an invoice's time is its due date (the `timeField` setting), so "per month" groups by `dueAt`.

## Where it stops

- **There's no judge in this run, only the parser.** The second answer says so: "happy" is dropped as not understood, with the judge not configured.
- **A total groups by time, or by an enum or yes/no field of the invoice.** `ask` reads "total amount of sent invoices per month" and sums `amount`, an int64 field, exactly. "Per region" names a field of the customer, one reference away, so that grouping is dropped with a reason.
- **`timeField` is set to `dueAt` for this run.** Without that setting, "per month" groups by `createdAt`, the time each row was written. A question can name the date field instead: "per month by due date" groups by `dueAt`.
- **A question stays within one namespace.** Here that's `app`.
