# `act`: declared actions and sketches

An agent in a harness pays every turn to carry substrate's grammar: tool definitions and instructions. `act` lets it send a terse sketch instead and get back a one-line acknowledgement plus a result id. A deterministic compiler turns the sketch into a plan and runs it. No model runs inside it, and nothing is guessed: anything ambiguous or unresolvable is refused and nothing runs.

```
close Todo #12 resolution=wont_do; create Note body="Follow up on #12"
```

```json
{ "ok": true, "ack": "closed work/Todo #12; created work/Note #7", "result": "r_7f3k2q" }
```

## Why

An agent in a harness carries every tool's definition and instructions in its context on every turn, and the replies it gets back pile up there too. The longer a session runs, the more of that context goes on the tool: re-reading a grammar, rebuilding frames, and recalling conventions no schema states, such as what closing a record means in this namespace. `act` moves that work out of the model.

- **Conventions live in the namespace.** An action declares what it means once, so every agent applies it the same way and none has to remember it.
- **The compiler is deterministic.** The same sketch against the same schema always compiles to the same plan. What doesn't resolve is refused, with the choices and the nearest valid sketch.
- **Replies are short.** The ack is one line, and a `find` answers with its rows cut to the fields it names. The full outcome waits in a result record the agent fetches only if it needs it.
- **The fixed cost is small.** The MCP `lean` preset carries `act` and `whoami`: 1,848 bytes of tools and instructions before any types are listed, against about 8.5 KB for `core`.

The model spends its turns on the problem, not on the tool. The [act worked example](https://mnmal-ai.github.io/substrate/examples/act/) shows one run, recorded by CI.

## Declaring actions

A namespace declares actions per type in `defineNamespace`. Declarations are data: they are published in the schema and never run code.

```ts
import { defineNamespace, field } from '@mnmal-ai/substrate/sdk';

defineNamespace('work', {
  Todo: {
    fields: {
      title: field.string(),
      status: field.enum(['open', 'closed', 'deferred']),
      resolution: field.enum(['completed', 'wont_do'], { nullable: true }),
      revisitWhen: field.string({ nullable: true }),
      archived: field.boolean()
    },
    actions: {
      close: {
        past: 'closed',
        params: { resolution: { type: field.enum(['completed', 'wont_do']), default: 'completed' } },
        set: { status: 'closed', resolution: { param: 'resolution' }, archived: true }
      },
      defer: {
        past: 'deferred',
        params: { revisitWhen: { type: field.string() } },
        set: { status: 'deferred', revisitWhen: { param: 'revisitWhen' } }
      }
    }
  },
  Entry: {
    fields: { summary: field.string() },
    actions: {
      log: {
        kind: 'create',
        past: 'logged',
        params: {
          summary: { type: field.string() },
          closes: { list: 'work/Todo', optional: true }
        },
        set: { summary: { param: 'summary' } },
        then: [{ action: 'work/Todo.close', each: { param: 'closes' } }]
      }
    }
  }
});
```

- `kind` is `update` (the default, acting on referenced records) or `create` (taking no reference).
- `set` values are a literal, `{ param: name }`, or `{ now: true }` for the transaction's timestamp.
- `params` use field types, so values are coerced and checked as fields are: enums, and int64 kept exact. A param with a `default` or `optional: true` may be left out. A `list` param takes record references.
- `then` runs follow-on actions in the same transaction, once per element of the list param its `each` names; `each` is required. The target is written `<namespace>/<Type>.<action>`, must be an update action on the list param's type whose params are all optional or defaulted, and may be in another namespace on the same store.
- `past` is the word the acknowledgement uses. Without it the ack says `<action> done`.

Boot refuses with a message when:

- an action name collides with a built-in, or the type has `autoCrud: false`;
- a param has no field type, or is never used;
- a `set` field does not exist or is server-set, a literal does not fit its field, `{ now: true }` sets a field that is not a date, or `{ param }` names a param that is undeclared or a `list`;
- a `then` entry has no `each`, its `each` names a param that is not a `list`, or its target's type is not the list's type;
- an update action sets nothing and has no `then`;
- a `create` action leaves a required field without a `set` value, a param that is always present, or a field default;
- once every namespace has installed, a `then` target does not exist, is a create action, or has a param with no default, or `then` chains form a cycle.

A composite action grants nothing. Every step goes through its target's normal grant and policy with the caller's identity, so an action cannot write what the caller could not write directly.

The schema publishes each declaration in `TypeSchema.actions` (`/substrate/v1/federated-schema`), and the action set is part of the schema hash.

## The sketch grammar

A sketch is text, or the same thing as JSON (`ActStep[]`). Steps are separated by `;` or a newline, outside quotes.

```
<action> <Type> [#id …] [field=value …] [as $name]
```

- **Actions.** A declared action, or a built-in on every stored type: `create` and `update` (the field-only fallback), `find` and `count`. Sketches cannot delete. Use the generated delete mutation for that.
- **Type.** `Todo` resolves to the one readable type of that name. `work/Todo` always works. A default namespace breaks ties: `namespace` in the request, filled from `SUBSTRATE_NAMESPACE` by the MCP tool and from `--ns` by the CLI. Remaining ambiguity is refused with the qualified choices.
- **References.** `#12` is a shortId; a full id also works. Several references apply the action to each: `close Todo #12 #13`. `find` and `count` take references as a filter, all shortIds or all full ids: `find Todo #12 #13 fields=status`.
- **Values.** Bare words, double-quoted strings, numbers, `true`, `false`, `null`, and lists, written `a,b` or in brackets (`[a,b]`, `[a]`, `[]`), coerced by the field or param type. A quoted value may contain `;`, a newline, `=`, `#` and `,`, and stays one value. Inside quotes, `\"`, `\\` and `\n` are escapes.
- **Extra fields.** A sketch may pass `field=value` beyond an action's params, for example `close Todo #12 title="Done early"`. Each must name a field of the type that the action's `set` does not fix. Naming a fixed field, such as `close Todo #12 archived=false`, is refused, so no sketch can undo what the action guarantees. No write takes an `id` arg: the id comes from the reference.
- **Bindings.** `create Todo title="x" as $t` names the record for later steps of the same sketch. `$t` resolves where a record reference goes: as a step's reference (`update Todo $t priority=high`), in a `list` param, and as the value of a crossRef field (`create Note todo=$t`). A crossRef field also takes `#12`. In any other field a binding is plain text: `title=$t` writes `$t`. A list of crossRefs takes full ids only.
- **`find` and `count`.** They filter on `field=value` pairs and add no hidden filters, so what you see is what runs. A `find` row holds `id`, `shortId` and the fields `fields=a,b` names, in the reply and in the result record. Each `find` reads at most the server's page maximum (1000 by default), the result record keeps at most 1000 rows across all its `find` steps, and the ack says when either truncated. `count` needs a store that answers aggregate reads (Postgres). A plain memory store refuses `count` exactly as `query` does.
- **Help.** `?` lists the readable types by namespace with their action names. `? Todo` shows that type's actions with their params, and its fields. Several help steps may share a sketch, `? Todo; ? Note`, and the help is then a list in step order. Help beside any other step is refused. Help writes no result record.

The same sketch against the same schema version always compiles to the same plan.

Limits: at most 50 write steps after expansion. Bridged and virtual namespaces are refused.

## The reply

| Outcome | Reply |
|---|---|
| Success | `{ "ok": true, "ack": "…", "result": "<id>", "found": [ … ] }` |
| Help | `{ "ok": true, "help": { … } }`, or a list of them |
| Refusal | `{ "ok": false, "refusal": { "code": "sketch_unresolved", "step", "token", "problem", "choices", "nearest" } }` |
| Failure | `{ "ok": false, "error": { "code", "message", "step" }, "result": "<id>" }` |

`found` is there when the sketch has `find` steps whose rows come to at most 100: one entry per `find`, with its `step`, `action`, `type`, `rows` and `truncated`. Above 100 rows, they are in the result record only.

A refusal means nothing ran and no result record exists. `nearest` is the closest valid sketch as text. A failure means a step failed while running: everything rolled back, and the result record holds the plan for diagnosis.

Acks name what happened: `closed work/Todo #12 #13`. A `find` acks as `12 work/Todo rows`, a `count` as `work/Todo count 108`.

## Dry runs and idempotency

`mode: "dry-run"` runs every step inside the transaction and rolls back, so it meets the refusals a real run would. The ack says it was a dry run. Hooks (`postWrite`, `onWrite`, `afterTx`, subscribers) fire only on commit.

One sketch is one transaction: it commits whole or not at all. A step that fails at execution, such as `close Todo #1; close Todo #999999`, aborts the lot and the reply names the failing step.

`idempotencyKey` in the request replays an earlier successful write by the same caller: its ack and result id, while its result record lives. A failed run is not replayed, so a retry runs again, and a dry run ignores the key. Two concurrent calls with the same caller and key run once and return the same result id.

## Result records

A result record holds the whole outcome of one sketch: id, owner, creation and expiry times, mode, ok, the sketch, the compiled plan, and per step the action, type, records touched (id and shortId), the rows (`find`) or the count (`count`), and the error if it failed.

- Only the caller that created a record can read it. Another caller's id and an unknown id answer the same 404.
- Records expire after 24 hours by default. Set `SUBSTRATE_ACT_RESULT_TTL_MS` (milliseconds) to change it. A sweep stage reaps expired records. The rows a sketch touched are the durable record.
- `act` requires a signed caller. An anonymous call is refused with the server's usual `unauthorized` error. A deployment with auth off acts as its configured system actor.

## Surfaces

- **HTTP.** `POST /substrate/v1/act` with `{ sketch, mode?, namespace?, idempotencyKey? }`, and `GET /substrate/v1/act/results/:id`.
  ```sh
  curl -s https://substrate.example.com:3100/substrate/v1/act \
    -H 'content-type: application/json' \
    -d '{ "sketch": "close Todo #12", "namespace": "work" }'
  ```
- **MCP.** The `act` tool takes `{ sketch?, mode?, result? }`. Pass `result` to fetch a record. It is in the `lean` and `all` presets, not `core`; add it to core with `SUBSTRATE_MCP_TOOLS=core,act`. `SUBSTRATE_MCP_TOOLS=lean` registers `act` and `whoami`, plus `ask` when the server runs substrate-nl. Its instructions are three lines of conventions and an index of every readable type with its actions and params, such as `work: Todo{close(resolution?), defer(revisitWhen)}, Entry{log(summary, closes?)}`, where `?` marks an optional or defaulted param. Each type line in the schema overview also names its actions.
- **CLI.**
  ```sh
  substrate act --ns work 'close Todo #12'
  substrate act --dry-run 'create Todo title="Try it"'
  substrate act --result r_7f3k2q
  ```
  `--ns` defaults to `SUBSTRATE_NAMESPACE`. Other flags: `--key <idempotencyKey>` and `--json`.
- **Client.** `client.act({ sketch, mode?, namespace?, idempotencyKey? })` and `client.actResult(id)` on `SubstrateClient` from `@mnmal-ai/substrate/client`.
- **`run` scripts.** `s.act(sketch, { namespace? })` runs one sketch. It sends `dry-run` in `read` and `dry-run` modes, and `write` in `write` mode, counting one toward `maxWrites`.
