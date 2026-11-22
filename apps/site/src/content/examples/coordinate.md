---
order: 5
name: coordinate
promise: Two signed agents hand off work live, and every row names the key that wrote it.
shows:
  - Two agents signing their requests as two separate keys
  - A new task arriving on an open subscription, with no polling
  - createdBy and updatedBy naming the key behind each write
---

## Elsewhere

Handing work from one agent to another usually means a broker beside the database. The task row goes into Postgres, and a message announcing it goes onto a queue or a topic, in [RabbitMQ](https://www.rabbitmq.com/docs/queues) or [Kafka](https://kafka.apache.org/intro), say. The other agent consumes the message and reads the row back. Keeping the write and the message in step, so that neither is lost when the other fails, is glue the app writes.

Brokers do things a database doesn't. [Kafka stores streams of events](https://kafka.apache.org/intro) durably, for as long as you configure, and a consumer can read them again. Postgres's own [LISTEN/NOTIFY](https://www.postgresql.org/docs/current/sql-notify.html) avoids a second system, but a notification carries only a channel name, the sending session's process ID and a payload string.

Identity is the other gap. A broker can authenticate each connection, and [RabbitMQ can check a message's user-id](https://www.rabbitmq.com/docs/validated-user-id) against it, but that name lives in the broker. Tying it to the row the work is about, and to whoever changes that row next, is code you write.

## On substrate

The scenario is a small invoicing app: three customers and eight invoices, all invented, seeded from [`_scenario.ts`](https://github.com/mnmal-ai/substrate/blob/main/apps/site/examples/_scenario.ts), which most of the examples share. This run adds a `Task` type to it. The run below comes from a script that substrate's CI runs against substrate's engine, and the responses shown are that run's output, not typed in.

`collections-agent` subscribes to open tasks. `billing-agent` writes one, signed with its own key. The new row arrives on the open subscription with no polling, and its metadata names the key that wrote it. When `collections-agent` takes the task, `updatedBy` names its key in turn.

These are the primitives: typed rows, signed writes and live subscriptions, in the same store as the invoices the work is about.

## Where it stops

- **Agent mail isn't in substrate's core.** For inboxes, replies, acks and broadcasts built on these primitives, see [cortext, in synoptic](https://github.com/mnmal-ai/synoptic).
- **The keys show attribution, not isolation.** In this run both agents' keys are HS256 keys registered in process under their own ids, sharing one throwaway secret. On a deployment, give each agent a key of its own; a key stored in Postgres is EdDSA, RS256 or ES256.
- **A subscription is row state, not an event log.** Frames still queued when a connection drops are lost, and the snapshot a fresh subscription sends is the catch-up. For a durable log, keep the events as rows.
- **Subscriptions take `where` and `orderBy` only, and refuse walks.** So the subscription carries the invoice's id, and the agent reads the invoice with a query.
- **MCP has no subscription tool.** Live updates come over frame streams only, so an agent on MCP alone polls.
- **The walk to the invoice needs Postgres in a deployment.** This run is on the memory store with a test-only walk evaluator switched on. A server on the memory store refuses walks with `walks_unsupported_store`.
