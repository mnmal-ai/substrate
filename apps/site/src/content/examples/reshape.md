---
order: 2
name: reshape
promise: An agent adds a type to the running server and uses it on the next call.
shows:
  - A proposed type that references a type defined in code
  - Writes and a walking read against it on the next call, with no deploy
  - A proposal record naming the key that signed it
---

## Elsewhere

Adding a table to a running Postgres app is a migration: write the DDL, review it, run it, and deploy the code that uses it. The API layer has to catch up too. [PostgREST caches the schema](https://docs.postgrest.org/en/stable/references/schema_cache.html) and needs a reload after a change, and a table shows up in [Hasura's GraphQL API](https://hasura.io/docs/2.0/schema/postgres/tables/) only once it's tracked. Each can take care of that step: the first with an event trigger that reloads its cache, the second by tracking a table made in its own console by default.

The other route skips the migration: a JSON column, or a schemaless store that takes any shape. Then the database no longer knows the field types, or which fields point at other rows, and every reader has to know both.

## On substrate

The scenario is a small invoicing app: three customers and eight invoices, all invented, seeded from [`_scenario.ts`](https://github.com/mnmal-ai/substrate/blob/main/apps/site/examples/_scenario.ts), which most of the examples share. The script below runs against substrate's engine in substrate's CI, and the responses shown are that run's output, not typed in.

On the running server, an agent calls `propose_type` for `billing/Payment`, with a reference to the code-defined `app/Invoice`. On the next call it records a payment, then reads it back, walking out to the invoice it settles. Nothing is deployed in between.

The built-in proposals plugin owns the `billing` namespace in this run. Each proposal is kept as a record that names the key that signed it: the server stamps `proposedBy` from the caller's signed identity, never from a param. Proposals are replayed when the server boots, so on Postgres the type survives a restart.

## Where it stops

- **This run is on Postgres.** A server on the memory store refuses this walk from `billing` into `app`: that store answers no walks (`walks_unsupported_store`), and it keeps each namespace in a store of its own.
- **Proposing needs the `substrate.propose` capability.** Auth must be on, and the caller's key must be granted it; without it the call is refused with `policy_denied`. The agent's key carries it here. No one reviews a proposal before it applies: the grant is the gate, so give it only to keys you'd trust with the owned namespaces.
- **Types are proposed into namespaces the plugin owns.** Here that's `billing`. The proposed type points at `app`, but the run changes nothing in `app`.
