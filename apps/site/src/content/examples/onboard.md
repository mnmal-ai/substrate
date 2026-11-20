---
order: 1
name: onboard
promise: Declare two types in code and get a typed API over HTTP, MCP and streams.
shows:
  - Query, mutate and subscribe from one declaration, with no handler code
  - One read frame that HTTP, MCP and a subscription all take
  - A server that describes its own schema to a fresh agent
extras: [three-ways]
---

## Elsewhere

The usual way to put an API on Postgres starts with migrations: SQL that creates the tables, checked in and run on every environment. Then an API layer reads those tables. [PostgREST](https://docs.postgrest.org/en/stable/) turns the database's schema into a REST API, and [Hasura](https://hasura.io/docs/2.0/schema/postgres/tables/) generates GraphQL queries and mutations for each table you track. Or you write the routes by hand.

Live updates may be another piece. [Hasura's subscriptions](https://hasura.io/docs/2.0/subscriptions/overview/) come with its GraphQL API. [Supabase's architecture](https://supabase.com/docs/guides/getting-started/architecture) pairs [PostgREST](https://docs.postgrest.org/en/stable/) for the REST API with a separate Realtime server that streams database changes.

For agents, there's one more. If they should call the API as MCP tools, that's an MCP server to write or adopt, and to keep in step with the schema as it changes.

## On substrate

The scenario is a small invoicing app: three customers and eight invoices, all invented, seeded from [`_scenario.ts`](https://github.com/mnmal-ai/substrate/blob/main/apps/site/examples/_scenario.ts), which most of the examples share. The script below runs against substrate's engine in the site's CI, and the responses shown are that run's output, not typed in.

`defineNamespace` declares `app/Customer` and `app/Invoice`. Composed into a server, both can be written, read and subscribed to at once, with no handler code: `app/createInvoice`, `app/updateInvoice` and the rest are generated. A read can walk the reference from an invoice to its customer, and a fresh agent learns all of it from `GET /substrate/v1/onboard` and the schema route.

The onboard and schema replies are trimmed here. The full onboard reply also carries per-operation instructions and every plugin's surface, and the full schema reply describes each mutation, where this one keeps only their names.

## Where it stops

- **Subscriptions take `where` and `orderBy` only, and refuse walks.** A subscription or stream that walks is refused with `walks_in_subscription`. That's why the frame shown three ways is the walk-free read, not the one that walks to the customer.
- **The output shown is the HTTP run's.** The MCP and subscription panes show the frame each surface takes, not a response from it. The coordinate example shows a live subscription.
- **MCP has no subscription tool.** Live updates come over frame streams only, so an agent on MCP alone polls.
- **The walk needs Postgres in a deployment.** This run sends its requests to the HTTP routes in process, on the memory store with a test-only walk evaluator switched on. A server on the memory store refuses walks with `walks_unsupported_store`.
