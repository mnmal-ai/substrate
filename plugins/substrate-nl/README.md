# @mnmal-ai/substrate-nl

Natural-language ask surface. A deterministic parser reads a question against a pack built from the live schema; an optional, constrained LLM judge handles only the ambiguous remainder. The model never writes a query.

## Contract

- `POST /substrate/v1/nl` with `{ namespace, question, project?, type? }` returns one of `rows`, `recall`, `clarify` or `refuse`, plus a `trail` of how it got there. Send `accept: text/event-stream` for the same as SSE events (`parsed`, `judging`, `judged`, then the outcome, then `done`), otherwise it is one JSON body.
- `GET /substrate/v1/nl/pack/<ns>` returns the namespace pack (types, fields, values, rulings) with an `etag`; send `if-none-match` for a `304`.
- NL is read-only: a mutation-shaped question is `refuse`, never executed.

Both routes claim `capability: 'read'`. Row policy keeps data safe; the gate keeps an anonymous caller from spending the operator's judge compute. Packs are built and cached per caller grants, so a restricted caller never sees another principal's values.

## Where it fits

A **kernel-tier plugin**, installed separately: `pnpm add @mnmal-ai/substrate-nl` in the runtime directory. It owns no namespace and stores nothing. Without it installed, `/substrate/v1/nl` 404s and the `ask` MCP tool reports that.

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
