# @mnmal-ai/substrate-tui

A terminal UI for Substrate: ask questions in natural language, browse the federated schema, watch service status and metrics, and, with an unlocked admin identity, run admin operations. Install it with `pnpm add -g @mnmal-ai/substrate-tui`, then run `substrate-tui` in an interactive terminal with `SUBSTRATE_URL` set.

Without an admin identity it is read-only.

## Commands

- Free text is a natural-language question, answered by `substrate-nl` (streamed). Tab completes types, fields and values.
- `/ns <namespace>` switches the namespace that questions, completion and the status row use. The schema browser always lists every namespace.
- `/frame` shows the Substrate frame behind the last answer.
- `/schema [namespace] [type]` opens the schema browser: namespaces, then types, then fields.
- `/dash` shows service, traffic and engine metrics, live while open.
- `/doctor` runs live checks against this deployment.
- `/keys` shows the active key table.
- `/admin unlock|lock|status` unlocks or locks the admin identity. It relocks after `SUBSTRATE_TUI_ADMIN_IDLE_MINUTES` of idle time (default 15).
- With admin unlocked: `/drop-namespace` and `/drop-type` (preview first, then type the target to confirm), `/backfill` (write a field from a JSON file of row id → value), `/normalise` (migrate a field's aliases to canonical values), `/reindex` (re-embed the embedded types, page by page).

## Keys

- Tab completes the token under the cursor.
- `1`-`9` answer a clarify question.
- Esc cancels the newest in-flight question, or closes the open panel.
- ctrl+c twice exits.

## Status row

`● LIVE`, `● OFFLINE` or `● RECONNECTING` (polled from `/health` every 10 s), the service version, the agent kid (`anon` when unauthenticated, `anon?` when whoami fails) and the active namespace.

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
