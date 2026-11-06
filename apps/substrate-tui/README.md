# @mnmal-ai/substrate-tui

A terminal UI for Substrate: ask questions in natural language, browse the federated schema, watch service status and metrics, and, with an unlocked admin identity, run admin operations. Install it with `pnpm add -g @mnmal-ai/substrate-tui@next`, then run `substrate-tui` in an interactive terminal with `SUBSTRATE_URL` set.

Without an admin identity it is read-only.

## Commands

- Free text is a natural-language question, answered by `substrate-nl` (streamed). Tab completes types, fields and values.
- `/ns <namespace>` switches the namespace that questions, completion and the status row use. The schema browser always lists every namespace.
- `/frame` shows the Substrate frame behind the last answer.
- `/asof <date-time>` reads relative phrases ("yesterday", "past 2 days") as of that moment, for the questions that follow. It must be ISO-8601 with an offset, e.g. `2026-10-24T23:59:59-05:00`. `/asof off` returns to the server clock, and `/asof` alone shows which is in use. `/frame` shows the clock the server read the last question against.
- `/schema [namespace] [type]` opens the schema browser: namespaces, then types, then fields.
- `/dash` shows service, traffic and engine metrics, live while open.
- `/doctor` runs live checks against this deployment.
- `/keys` shows the active key table.
- `/admin unlock|lock|status` unlocks or locks the admin identity. It relocks after `SUBSTRATE_TUI_ADMIN_IDLE_MINUTES` of idle time (default 15).
- With admin unlocked: `/drop-namespace` and `/drop-type` (preview first, then type the target to confirm), `/backfill` (write a field from a JSON file of row id → value), `/normalise` (migrate a field's aliases to canonical values), `/reindex` (re-embed the embedded types, page by page).

## Shaping answer rows (for plugin authors)

A namespace can say how its rows look in an answer, with no TUI code. Put a `tui` key in its `defineNamespace` annotations:

```ts
annotations: { tui: {
  formats: { 'Item.price': 'money', 'Item.stock': 'int', 'Item.seenAt': 'date' },
  rows: { Item: { title: 'name', tags: [{ field: 'grade', template: 'G{}' }], value: 'price',
                  details: [{ field: 'ask', label: 'ask' }, 'supplier'] } }
} }
```

Each `Item` row then renders as a numbered line with the bold `title`, dim `tags` and the `value` right-aligned, followed by a dim `·`-joined `details` line (`ask $412.00 · Acme`). Empty values show as `—` or are left out.

- An entry is a field name or `{ field, template?, label? }`. `template` puts the formatted value where `{}` is. `label` comes before a detail, and a numeric detail is labelled with its field name by default.
- `formats` maps `'<Type>.<field>'` to `money` (in `currency`, default `USD`, with its usual decimal places), `int`, `number`, `pct` (the value is already a percent), `date` or `datetime` (local time). They apply wherever the value appears, including the generic `field=value` view and aggregates.
- Only the type's own fields can be used. An entry that follows a reference (`a.b`) is left out, as is one named `__proto__`, `constructor` or `prototype`. A long value is cut to a third of the line.
- A malformed block, or a malformed entry for a type, is ignored, and that type falls back to the generic view. `/frame` says what was ignored.

## Keys

- Tab completes the token under the cursor.
- `1`-`9` answer a clarify question.
- Esc cancels the newest in-flight question, or closes the open panel.
- ctrl+c twice exits.

## Status row

`● LIVE`, `● OFFLINE` or `● RECONNECTING` (polled from `/health` every 10 s), the service version, the agent kid (key id; `anon` when unauthenticated, `anon?` when whoami fails) and the active namespace.

## Environment

| Variable | Meaning |
|---|---|
| `SUBSTRATE_URL` | Service URL (required). |
| `SUBSTRATE_NAMESPACE` | The namespace to watch. Required. |
| `SUBSTRATE_AGENT_KEY_ID`, `SUBSTRATE_AGENT_KEY_PATH` | Agent identity; the key is a path. Anonymous without them. |
| `SUBSTRATE_AGENT_CAPABILITIES` | Comma-separated capabilities to claim. |
| `SUBSTRATE_ADMIN_KEY_PATH`, `SUBSTRATE_ADMIN_KEY_ID`, `SUBSTRATE_ADMIN_TOKEN` | Admin identity used by `/admin unlock`. |
| `SUBSTRATE_TUI_ADMIN_IDLE_MINUTES` | Minutes of idle before admin relocks (default 15). |
| `SUBSTRATE_TUI_BACKGROUND` | Background colour, `#rrggbb` or `none`. |
| `SUBSTRATE_TUI_CLEAR` | `0` keeps what was on screen at start. |
| `SUBSTRATE_TUI_COLOR` | `256` for terminals without 24-bit colour. |
