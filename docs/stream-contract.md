# Frame stream contract

How a live session on `POST /substrate/v1/subscribe` or `POST /substrate/v1/stream`
is carried, how it ends, what each terminal sequence means, and what a
well-behaved client does about it. Implemented in
`packages/substrate-compose/src/routes/stream-routes.ts` and `frames-transport.ts`
(transport) and `packages/substrate-core/src/engine/subscribe.ts` (overload path).
Pinned by `packages/substrate-compose/test/stream-routes.test.ts`,
`frames-stream.test.ts` and `packages/substrate-sdk/test/async-cancellation.test.ts`.

## The wire

The request body is the frame object, as for `POST /substrate/v1/query`. Auth is
the same too: the route needs `read`.

| `Accept` | Body |
|---|---|
| `application/vnd.substrate.frames+json` (default) | JSON frames |
| `application/vnd.substrate.frames+pack` | MessagePack frames, `data` positional against the field selection you sent |
| anything else | `406 not_acceptable` |

The response body is a sequence of frames: a 4-byte big-endian length, then that
many bytes of payload. A zero-length frame is a heartbeat; skip it. Each frame is
`{ id, kind, data?, shapes?, errors?, reason?, final? }`, with `kind` one of
`snapshot`, `add`, `update`, `remove`, `chunk`, `end` or `error`.

- `subscribe`: a `snapshot`, then `add` / `update` / `remove` (a `remove` carries
  `removedId` and no `data`). Several keys are allowed.
- `stream`: one `chunk` per entity, then `end { final: true }`. One key only;
  two are refused `stream_multi_key`.

One response carries one session. Closing the response cancels it, so there is
no cancel acknowledgement.

Failures before the stream opens are ordinary HTTP statuses. Once bytes are on
the wire the status is spent, and failures arrive in-band as `error` frames.
Read the frames, not the status.

## Terminal taxonomy

| # | Sequence | Trigger | Client obligation |
|---|---|---|---|
| 1 | `error { code: 'subscription_overloaded' }` → `end { final: true, reason: 'subscription_overloaded' }` | per-entry queue breached `queueLimit` (default 256) | **Retryable with backoff**, bounded |
| 2 | `end { final: true, reason: 'server_restart' }` → end of body | graceful server shutdown | **Retryable immediately**, unbounded |
| 3 | `end { final: true, reason: 'credential_expired' \| 'credential_changed' \| 'credential_revoked' }` | the caller's credential lapsed mid-session | Resubscribe with a current credential; a revoked one will be refused |
| 4 | `error { code: <anything else> }` | policy deny, filter validation, unauthorized namespace, … | **Never auto-retry**: retrying a rejected frame yields an identical rejection, i.e. an infinite resubscribe loop |

A body that ends with no preceding `end` frame is an abrupt drop. The session
is gone; subscribe again for a fresh snapshot.

## One vocabulary

The overload token `'subscription_overloaded'` is BOTH the `code` of the
terminal `error` frame and the `reason` of the following `end` frame: one
token per condition, on whichever frame kind carries it. Known tokens are
exported from `@mnmal-ai/substrate/sdk`:

- `WS_REASON_SUBSCRIPTION_OVERLOADED` = `'subscription_overloaded'`
- `WS_REASON_SERVER_RESTART` = `'server_restart'`

The wire field stays `string`; clients MUST tolerate unknown tokens (treat as
class 4: don't auto-retry what you don't recognise).

## Guarantees

- The overload `error` frame precedes its `end` frame. Nothing follows the
  `end` frame for that session.
- At most one data frame already in flight in the engine's drain loop may be
  delivered before the `error` frame; no data frame follows it.
- Frames queued but undelivered at teardown are **dropped**. The snapshot
  delivered on resubscribe is the recovery path: subscription state is
  row-state, not an event log, so a fresh snapshot is complete catch-up. (For
  event-log semantics, model events as durable rows and dedup client-side.)
- A frame too large to send is replaced by an `error` and an `end`, both
  carrying `frame_too_large`, and the session ends.
- Overload teardown is observable server-side via the
  `engine_subscription_overloaded` metric (id, ns, type, queueLimit).

## Configuration

`queueLimit` defaults to 256 frames per subscription entry
(`EngineOptions.subscriptions.queueLimit`; threaded through
`compose({ subscriptions: { queueLimit } })`). Breach tears the entry down.
There is no pause/resume: subscribe semantics assume the consumer keeps up,
and the durable recovery path is resubscribe + snapshot.

## Client guidance (normative for `@mnmal-ai/substrate/client`)

- Branch on the `error` frame's `code`, corroborated by `end.reason`, never on
  message text.
- Class 1: resubscribe with bounded backoff; reset the retry budget only
  after a sustained healthy period (reset-on-snapshot alone lets a thrashing
  consumer loop forever). Surface the error to the consumer when the budget
  exhausts.
- Class 2: keep the subscription alive and resubscribe on a new request.
- Class 3: resubscribe once the credential is current.
- Class 4: terminal. Full stop.
