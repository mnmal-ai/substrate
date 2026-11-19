# @mnmal-ai/substrate-nl

Natural-language ask surface. A deterministic parser reads a question against a pack built from the live schema; an optional, constrained LLM judge handles only the ambiguous remainder. The model never writes a query.

## Contract

- `POST /substrate/v1/nl` with `{ namespace, question, project?, type?, asOf? }` returns one of `rows`, `recall`, `clarify` or `refuse`, plus a `trail` of how it got there. Send `accept: application/vnd.substrate.frames+json` for the same as a stream of length-prefixed JSON frames, each `{ event, data }` (`parsed`, `judging`, `judged`, then the outcome, then `done`; a failure mid-stream is an `error` event). Otherwise it is one JSON body. `+pack` is refused `406 not_acceptable`.
- `asOf` is "now" for relative dates ("yesterday", "last week"), for the year of a month-day ("on Oct 23") and for a month with no year ("in march"): an ISO-8601 date-time with an offset, such as `2026-10-02T12:00:00-05:00`, in years 1000 to 9998. Day boundaries are in its offset. Anything else is `400 invalid_params`. Without it the server clock is used. The `parsed` event's `asOf` says which clock the question was read against.
- Years and months: `in|during 2025` is that whole year. `this year` and `last year` are calendar years, while `last N years` is rolling. `in|during <month>` is the most recent such month that has begun, and `in <month> <year>` or `in <year> <month>` is that month. `since|after|before|until|between|from` take a year or a month as an operand ("since 2024", "before march 2025"). In `between <month> and <month> <year>` a month with no year takes the other's year, or the year before when it comes later in the calendar, so "between november and february 2026" is 2025-11 to 2026-03. `on` refuses a year or a month. A year is a four-digit number from 1900 to 2199. Any other number there is not a year, so the phrase is not a date, the number stays unread and the answer is `unknown` ("items between 1000 and 2000"). A rolling window too long for a date is not read, and is never an error. A whole month or year after a lead word that is also a stored value ("todos in may" when `may` is a value) is held and dropped with a reason, so the answer is `unknown`.
- shortId: a number is a shortId after `#`, after an id word (`shortid`, `id`, `number`, `short id`), or right after a singular type word when that type's first mention is singular ("todo 1752", "todo 5 and todo 7", but not "todos and todo 5"). A number after a plural type word or any other word is not an id. A number nothing claimed leaves the reading partial, so the answer is `unknown`, and a judge cannot pick it away as noise. Beside an id, a leftover entry that contains a number does the same, while leftover words stay commentary.
- Aggregates: `average|avg|mean <field>`, `total|sum [of] <field>`, `min|minimum|max|maximum <field>`, each over the seed type with every filter, value and time range the question also names. The field must be a seed number field (min and max also take a date field). An unknown field, a wrong kind or a field on a walked type is dropped with a reason, and the answer is `unknown`. `highest|lowest <field>` is an aggregate only when `of` or `for` follows the field, a type is named after the field, and no type is named before the superlative ("the highest price of items"). Otherwise it orders ("items with the highest price", "items with the highest price for last week"). A recency or limit word inside a count or an aggregate ("the last sale", "the first 3 items") is dropped as a filter, so the answer is `unknown`. So is an aggregate inside a "how many" question. The outcome is `rows` with `answer: 'aggregate'`, the engine's `data`, and `aggregate: { fn, field, value }`. A store that answers no walks, or a seed under a row policy, refuses the frame: `aggregate` is then absent and `errors` says why. Unlike a plain count, there is no paged fallback. A count per unit runs as an aggregate, so it has none either.
- Grouping an aggregate or a count: `by|per hour|day|week|month|year` groups by the type's time field (the `timeField` ruling, else `createdAt`), truncated through `groupBy` and `dateTrunc`. Labels are the hour `2026-10-20T09`, the day `2026-10-20`, the week's Monday `2026-10-19`, the month `2026-10` and the year `2026`. A count per unit answers `aggregate: { fn: 'count', field: '*', by, groups }`. A unit wins over a field group in the same question: "average price of items by condition per month" groups by month and leaves "condition" unread, so the parse is partial and `ask` answers `unknown`. `by|per <field>` groups by a seed enum or yes/no field, as one aggregate per value (at most 20) plus one for rows with no value. That last group is keyed `null` and is left out when its value is null. Either one gives `aggregate: { fn, field, by, groups: [{ key, value }], truncated? }`. Grouping by any other field is dropped with a reason, and the ungrouped value still answers. The adjectives `hourly|daily|weekly|monthly|yearly|annual|annually` also name a unit:
  - Immediately before or after the aggregate word of a claimed aggregate, an adjective is the unit, even when it is also a pack value.
  - Anywhere else, an adjective that no value claimed is the unit only in a question with a claimed aggregate or "how many" ("how many sales weekly").
  - A field name, or a field phrase, of the asked types (and the types their crossRefs reach) wins over the unit reading ("annual fee"), including right after the aggregate word.
  - A pack value of the namespace claims an adjective only when no aggregate word, claimed or not, is beside it. Beside an aggregate word with no field ("monthly total of subscriptions", "average daily sales") it is neither a value nor a unit, and the answer is `unknown`.
  - An adjective immediately before the aggregate word that is not read as its unit is held and dropped with a reason, and the answer is `unknown`. After the aggregate word, an adjective that names a field is read as the field.
- Ordering across one hop: `top|bottom [N] <type> by [pick] <field>` and `<type> with the highest|lowest <field>` may name a number field one crossRef hop away, as `<other type> <field>` ("top 10 items by supplier rating"), a `fieldPhrases` ruling, or a field name only one other type has. The seed's rows are ordered by an `_agg` over that hop, through `select: { <name>: '_agg.<name>' }` and `orderBy: [{ <name>: dir }]`, and each row carries the value under `_agg.<name>`. A hop out to one row reads its value. A direction word right after `by` (`lowest|smallest|least` or `highest|largest|most`) sets the direction, for a seed field too ("top 10 items by lowest price" is ascending). A hop in from many picks one value: `latest|current|most recent` after `by` picks the latest, else the phrase ruling's `pick`, else `max` for a descending order and `min` for an ascending one. Any other pick word after `by` (`cheapest`, or `latest` on a field with one value per row) drops the ordering with a reason. When the field is named as `<type> <field>` and a time range is asked, that type stays a competing reading. The evidence and the plan name it, for example `max(Item.price) per supplier`. Rows with no neighbour sort last. Two or more hops, a field on several types, an unknown field and a non-number field are dropped with a reason.
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

- `judge` optional: an [Ollama](https://ollama.com) server and model for the constrained judge (`timeoutMs` defaults to 20000). Absent means parser-only: every escalation is an honest hand-off. A slow or down judge hands off within `timeoutMs`. A hand-off with words the parser could not read answers `unknown` and runs nothing.
- `rulings` optional; per-namespace overrides merged over rulings the namespace declares.
- `packTtlMs` how long a served pack is reused (default 300000).

An unknown config key fails at boot. There are no env fallbacks, and no LLM vendor SDK is bundled.

## More

- Spec: §5.6, [`docs/substrate-from-first-principles.md`](../../docs/substrate-from-first-principles.md)
- Source: `plugins/substrate-nl/src/`
