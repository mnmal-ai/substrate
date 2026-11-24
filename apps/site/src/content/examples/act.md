---
order: 2
name: act
promise: An agent states what it wants in one line; deterministic code works out the frames.
shows:
  - A namespace that declares what paying an invoice means, once, as data
  - One sketch that pays an invoice and closes its task, answered in one line
  - A typo refused with the nearest valid sketch, before anything runs
---

## Elsewhere

An agent works a service through tools. An [MCP server](https://modelcontextprotocol.io/specification/2025-06-18/server/tools) usually lists a tool per operation, each with a JSON Schema for its input, and the agent's harness sends every definition with every request, before the agent has done anything. [Anthropic describes the cost](https://www.anthropic.com/engineering/code-execution-with-mcp): tool definitions overload the context window, and intermediate results consume more tokens. Their answer, and [Cloudflare's Code Mode](https://blog.cloudflare.com/code-mode/), is to give the model a typed API to write code against instead. Substrate offers that too, as `substrate run`.

Both still leave the model to learn an API, and to remember the conventions no schema states: that closing a task means a status of `done`, or that paying an invoice should close the tasks chasing it. The model learns them again each session, from instructions in its context, and every turn it spends on grammar is a turn it doesn't spend on the problem.

## On substrate

The namespace declares what an action means, once, as data. `Invoice.pay` sets `status` to `paid`, and its `then` closes every Task the sketch names in `closes`, in the same transaction. `Task.close` sets `status` to `done`. A declaration runs no code: the schema publishes it, and a deterministic compiler reads it.

The agent sends a sketch, `pay Invoice #2 closes=#1`, and gets one line back: `paid app/Invoice #2; closed app/Task #1`, plus a result id it fetches only if it needs the detail. Every step runs as the agent, through the same grants and policies as a `mutate`, so a sketch can't write anything its caller couldn't. `? Invoice` lists what the type can do. A sketch that doesn't resolve is refused before anything runs, with the token it couldn't read, the choices, and the nearest valid sketch.

An action need not be a field update. Where a type is written through its plugin's own mutations, as a mailbox is through `send` and `ack`, the declaration names the mutation instead: `ack: { mutation: 'ackMessage', past: 'acked' }` makes `ack Message #12` call `ackMessage` with that record's id, and each `field=value` in the sketch is one of the mutation's params. A sketch can also name a referenced record by one of its fields, and the caller as `@me`, so `find Message recipient=kid:@me status=unread` is the caller's inbox with no lookup beforehand.

The grammar the agent holds is one line: `<action> <Type> [#id …] [field=value …]`. Over MCP, the `lean` preset carries only the `act` tool and `whoami`. Before any types are listed, its tools and instructions come to 1,848 bytes, against about 8.5 KB for the `core` toolset. Both then add the server's types, and lean lists each type's actions beside it.

What that saves was measured on one housekeeping task: close a Todo as won't do, supersede a Decision, defer a Todo, write a SessionLog that closes another Todo in the same write, and list the open Todos in one area. A headless Opus session ran it three times on each toolset against a freshly seeded store. The medians:

| | `core` tools | `act` | change |
|---|---|---|---|
| Tool calls | 13 | 6 | −54% |
| Context the task added | 21.2k tokens | 7.1k | −67% |
| Context at the end | 29.5k tokens | 11.8k | −60% |
| Cost per run | $0.30 | $0.085 | −72% |
| Store correct afterwards | 3 of 3 | 3 of 3 | |

With the `core` tools the session spends its context on a `schema` lookup for each type's write contract, on `query` replies, and on `mutate` frames it builds by hand. With `act` it asks for help on three types in one call, dry-runs the sketch, and reads back only the rows it asked for. It is one task, one small store and one model, so the gap will vary, and a read-heavy task gains less because rows cost the same either way. [The method and the full table](https://github.com/mnmal-ai/substrate/blob/main/docs/act.md#measured) are in the repository.

The scenario is the invoicing app the other examples share, seeded from [`_scenario.ts`](https://github.com/mnmal-ai/substrate/blob/main/apps/site/examples/_scenario.ts), with a Task that chases an unpaid invoice. The run below comes from a script that substrate's CI runs against substrate's engine, and the responses shown are that run's output, not typed in.

## Where it stops

- **Sketches can't delete.** The built-ins are `create`, `update`, `find` and `count`. A delete goes through the generated delete mutation, unless the namespace declares an action on a mutation that deletes.
- **A sketch is one transaction, of at most 50 writes.** It commits whole or not at all. A step that fails while running rolls back the lot, and the reply names the step.
- **Only stored namespaces on this server.** A bridged or virtual namespace is refused, and `count` needs a store that answers aggregate reads, which is Postgres.
- **Result records are short-lived.** A record lives 24 hours by default and only its creator can read it. The rows the sketch touched are the durable record.
- **The run below is the HTTP route's.** The MCP `act` tool and `substrate act` send the same sketch to it.
