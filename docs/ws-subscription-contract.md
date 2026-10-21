# WebSocket subscription teardown contract

How a `subscribe` op ends, what each terminal sequence means, and what a
well-behaved client does about it. This is the consumer-facing contract for
the behavior implemented in `packages/substrate-core/src/engine/subscribe.ts`
(overload path) and `packages/substrate-compose/src/routes/ws.ts` (transport).
Pinned by `apps/substrate/test/ws-teardown-contract.test.ts` (wire) and
`packages/substrate-sdk/test/async-cancellation.test.ts` (engine).

## Terminal taxonomy

| # | Sequence | Trigger | Client obligation |
|---|---|---|---|
| 1 | `error { code: 'subscription_overloaded' }` → `end { final: true, reason: 'subscription_overloaded' }` | per-entry queue breached `queueLimit` (default 256) | **Retryable with backoff**, bounded |
| 2 | `end { final: true, reason: 'server_restart' }` → socket close `1012` | graceful server shutdown | **Retryable immediately** on the new socket, unbounded |
| 3 | `end { final: true }` (no `reason`) | cancel ack — client-initiated | Not retryable (you asked) |
| 4 | `error { code: <anything else> }` | policy deny, filter validation, unauthorized namespace, … | **Never auto-retry** — retrying a rejected frame yields an identical rejection, i.e. an infinite resubscribe loop |

## One vocabulary

The overload token `'subscription_overloaded'` is BOTH the `code` of the
terminal `error` frame and the `reason` of the following `end` frame — one
token per condition, on whichever frame kind carries it. Known tokens are
exported from `@mnmal-ai/substrate/sdk`:

- `WS_REASON_SUBSCRIPTION_OVERLOADED` = `'subscription_overloaded'`
- `WS_REASON_SERVER_RESTART` = `'server_restart'`

The wire field stays `string`; clients MUST tolerate unknown tokens (treat as
class 4: don't auto-retry what you don't recognise).

Raw WS close codes are a separate, numeric layer (RFC 6455: `1012` service
restart, `4001` unauthorized) and are unchanged by this contract.

## SSE carries the same tokens

The taxonomy above is transport-neutral; `packages/substrate-compose/src/routes/sse.ts`
emits the same terminal `end` with the same `reason` vocabulary, rendered as
`event: end` / `data: {"reason":"…"}`. Two transport-specific differences:

- There is no close code. The HTTP response simply ends — a graceful shutdown
  is `end { reason: 'server_restart' }` followed by end-of-body, where WS adds
  a `1012`. A body that ends with no preceding `end` frame is an abrupt drop,
  the SSE analogue of a 1006.
- There is no cancel ack (class 3): one response carries one session, so
  cancellation IS disconnection and there is nobody left to acknowledge it to.

Client obligations are otherwise identical. Pinned by
`apps/substrate/test/sse-teardown-contract.test.ts` (real socket) and the
`SSE graceful shutdown` block in `packages/substrate-compose/test/sse-routes.test.ts`.

## Guarantees

- The overload `error` frame precedes its `end` frame. Nothing follows the
  `end` frame for that subscription id.
- At most one data frame already in flight in the engine's drain loop may be
  delivered before the `error` frame; no data frame follows it.
- Frames queued but undelivered at teardown are **dropped**. The snapshot
  delivered on resubscribe is the recovery path: subscription state is
  row-state, not an event log — a fresh snapshot is complete catch-up. (For
  event-log semantics, model events as durable rows and dedup client-side.)
- Overload teardown is observable server-side via the
  `engine_subscription_overloaded` metric (id, ns, type, queueLimit).

## Configuration

`queueLimit` defaults to 256 frames per subscription entry
(`EngineOptions.subscriptions.queueLimit`; threaded through
`compose({ subscriptions: { queueLimit } })`). Breach tears the entry down —
there is no pause/resume: subscribe semantics assume the consumer keeps up,
and the durable recovery path is resubscribe + snapshot.

## Client guidance (normative for `@mnmal-ai/substrate/client`)

- Branch on the `error` frame's `code`, corroborated by `end.reason`, never on
  message text.
- Class 1: resubscribe with bounded backoff; reset the retry budget only
  after a sustained healthy period (reset-on-snapshot alone lets a thrashing
  consumer loop forever). Surface the error to the consumer when the budget
  exhausts.
- Class 2: keep the subscription alive across the socket close and
  resubscribe on the new socket.
- Classes 3 and 4: terminal. Full stop.
