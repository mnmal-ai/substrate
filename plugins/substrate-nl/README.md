# @mnmal-ai/substrate-nl

Natural-language ask surface. A deterministic parser reads a question against a pack built from the live schema; an optional, constrained LLM judge handles only the ambiguous remainder. The model never writes a query.

## Contract

- `POST /substrate/v1/nl` with `{ namespace, question, project?, type?, asOf? }` returns one of `rows`, `recall`, `clarify` or `refuse`, plus a `trail` of how it got there. Send `accept: text/event-stream` for the same as SSE events (`parsed`, `judging`, `judged`, then the outcome, then `done`), otherwise it is one JSON body.
- `asOf` is "now" for relative dates ("yesterday", "last week") and for the year of a month-day ("on Oct 23"): an ISO-8601 date-time with an offset, such as `2026-10-02T12:00:00-05:00`. Day boundaries are in its offset. Anything else is `400 invalid_params`. Without it the server clock is used. The `parsed` event's `asOf` says which clock the question was read against.
- Aggregates: `average|avg|mean <field>`, `total|sum [of] <field>`, `min|minimum|max|maximum <field>`, each over the seed type with every filter, value and time range the question also names. The field must be a seed number field (min and max also take a date field). An unknown field, a wrong kind or a field on a walked type is dropped with a reason, and the answer is `unknown`. `highest|lowest <field>` is an aggregate only when `of` or `for` follows the field, a type is named after the field, and no type is named before the superlative ("the highest price of items"). Otherwise it orders ("items with the highest price", "items with the highest price for last week"). A recency or limit word inside a count or an aggregate ("the last sale", "the first 3 items") is dropped as a filter, so the answer is `unknown`. So is an aggregate inside a "how many" question. The outcome is `rows` with `answer: 'aggregate'`, the engine's `data`, and `aggregate: { fn, field, value }`. A store that answers no walks, or a seed under a row policy, refuses the frame: `aggregate` is then absent and `errors` says why. Unlike a count, there is no paged fallback.
- Grouping an aggregate: `by|per day|hour` buckets the type's time field (`timeField` ruling, else `createdAt`). `by|per <field>` groups by a seed enum or yes/no field, as one aggregate per value (at most 20) plus one for rows with no value. That last group is keyed `null` and is left out when its value is null. Either one gives `aggregate: { fn, field, by, groups: [{ key, value }], truncated? }`. `week`, `month` and `year` buckets, and grouping by any other field, are dropped with a reason, and the ungrouped value still answers.
- Ordering across one hop: `top|bottom [N] <type> by [pick] <field>` and `<type> with the highest|lowest <field>` may name a number field one crossRef hop away, as `<other type> <field>` ("top 10 items by supplier rating"), a `fieldPhrases` ruling, or a field name only one other type has. The seed's rows are ordered by an `_agg` over that hop, through `derive: { <name>: { value: '_agg.<name>' } }` and `orderBy: [{ $<name>: dir }]`, and each row carries the value under `_agg.<name>`. A hop out to one row reads its value. A direction word right after `by` (`lowest|smallest|least` or `highest|largest|most`) sets the direction, for a seed field too ("top 10 items by lowest price" is ascending). A hop in from many picks one value: `latest|current|most recent` after `by` picks the latest, else the phrase ruling's `pick`, else `max` for a descending order and `min` for an ascending one. Any other pick word after `by` (`cheapest`, or `latest` on a field with one value per row) drops the ordering with a reason. When the field is named as `<type> <field>` and a time range is asked, that type stays a competing reading. The evidence and the plan name it, for example `max(Item.price) per supplier`. Rows with no neighbour sort last. Two or more hops, a field on several types, an unknown field and a non-number field are dropped with a reason.
- `GET /substrate/v1/nl/pack/<ns>` returns the namespace pack (types, fields, values, rulings) with an `etag`; send `if-none-match` for a `304`.
- NL is read-only: a mutation-shaped question is `refuse`, never executed.

Both routes claim `capability: 'read'`. Row policy keeps data safe; the gate keeps an anonymous caller from spending the operator's judge compute. Packs are built and cached per caller grants, so a restricted caller never sees another principal's values.

## Where it fits

A **kernel-tier plugin**, installed separately: `pnpm add @mnmal-ai/substrate-nl@next` in the runtime directory. It owns no namespace and stores nothing. Without it installed, `/substrate/v1/nl` 404s and the `ask` MCP tool reports that.

## Config

`<SUBSTRATE_PLUGIN_DIR>/substrate-nl.config.json`:

```json
{
  "judge": { "baseUrl": "http://localhost:11434", "model": "qwen3:14b", "timeoutMs": 20000 },
  "rulings": { "tasks": { "liveStatus": { "Task": "open" } } },
  "packTtlMs": 300000
}
```

- `judge` optional: an [Ollama](https://ollama.com) server and model for the constrained judge (`timeoutMs` defaults to 20000). Absent means parser-only: every escalation is an honest hand-off. A slow or down judge hands off within `timeoutMs`.
- `rulings` optional; per-namespace overrides merged over rulings the namespace declares.
- `packTtlMs` how long a served pack is reused (default 300000).

An unknown config key fails at boot. There are no env fallbacks, and no LLM vendor SDK is bundled.

## More

- Spec: §5.6, [`docs/substrate-from-first-principles.md`](../../docs/substrate-from-first-principles.md)
- Source: `plugins/substrate-nl/src/`
