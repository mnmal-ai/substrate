# @mnmal-ai/substrate-client

Internal: bundled into `@mnmal-ai/substrate` and not published; its public surface is `@mnmal-ai/substrate/client`.

TypeScript client for Substrate: HTTP and WebSocket transports, JSON and `substrate-pack` wire formats, schema-drift refetch, WebSocket reconnect.

`@mnmal-ai/substrate/client` also exports the policy helpers, including `makeTokenProvider` for agent-JWT minting (see [Agent identity](#agent-identity)).

## Usage

```ts
import { SubstrateClient } from '@mnmal-ai/substrate/client';

const client = new SubstrateClient({ endpoint: 'http://localhost:3100' });
const env = await client.query({ 'tasks/Task': { params: {}, fields: { id: true, title: true } } });
```

`query()` and `mutate()` return the whole response envelope. Check `errors` before reading `data`: one frame can fail while its siblings succeed, and a rejected frame's key is absent from `data`.

## Natural-language questions (`client.nl`)

Needs a server with `@mnmal-ai/substrate-nl` installed. The types are the shared wire types from `@mnmal-ai/substrate/sdk`.

```ts
import { complete } from '@mnmal-ai/substrate-nl/complete';

// SSE: parsed, judging?, judged?, then rows | recall | clarify | refuse | unknown, then done.
for await (const ev of client.nl.ask({ namespace: 'tasks', question: 'open tasks' })) {
  if (ev.event === 'clarify') console.log(ev.data.options); // each option carries a `type`
}

// JSON: { outcome, trail }. Resubmit a clarify option by passing its `type`.
const { outcome } = await client.nl.askJson({ namespace: 'tasks', question: 'open', type: 'Task' });

// The namespace pack, ETag-cached per client; feeds browser-safe completion directly.
const pack = await client.nl.pack('tasks');
const suggestions = complete('tasks pri', 9, pack);
```

A rejected `rows` outcome has no `data` key and a rejected `recall` outcome no `hits` key on the wire: test for presence, not for `undefined`. An in-band `error` event throws a `NetworkError`. Non-2xx responses throw a `NetworkError` carrying the server's JSON error as `status`, `code` and `serverMessage` when it sent one.

## Live subscriptions

Two surfaces, both single-qualified-key:

- **`client.subscribe(frame)`** → `AsyncIterable<SubscribeEvent>`: the raw protocol stream. Use it when you need the event kinds themselves (snapshot vs add vs remove), are driving your own row-set or cursor logic, or want a multi-key frame.
- **`client.watch<T>(frame)`** → `AsyncIterable<T[]>`: a typed, maintained row-set. It folds snapshot/add/update/remove into the current list and yields the whole `T[]` after each change. `id` is force-selected so update and remove can correlate by row id. Completes on the subscription's `end`; throws on an error frame (same contract as `subscribe`); breaking the `for await` cancels the subscription.

```ts
interface Task { id: string; title: string; status: string }

for await (const tasks of client.watch<Task>({
  'tasks/Task': { params: { where: { status: { eq: 'open' } } }, fields: { title: true, status: true } }
})) {
  render(tasks); // the full current set, re-rendered on every change
}
```

### The subscribe `data` envelope

`SubscribeEvent.data` (for data-bearing kinds) is keyed by the qualified frame key:

| Kind | Shape | Meaning |
|---|---|---|
| `snapshot` | `data = { '<ns>/<Type>': Row[] }` | the full current set |
| `add` | `data = { '<ns>/<Type>': Row }` | one newly-matching row (appended) |
| `update` | `data = { '<ns>/<Type>': Row }` | one changed row, correlated by `id` |
| `remove` | `{ removedId: string }` (no `data`) | drop the row with that id |
| `end` / `error` / `chunk` | — | terminal / streaming; no row change |

If you own a subscription loop but still want the typed-row fold (for example a custom resubscribe wrapper), `reduceSubscribeRows(current, qualifiedKey, event)` and the `watchRows(events, qualifiedKey)` combinator behind `watch` are exported from the package root.

## Agent identity

On a server with auth enabled, requests carry a signed agent JWT. Those tokens are short-lived (1 hour), so a static `token` string expires mid-session. Pass `getToken` with the `makeTokenProvider` minting helper, which re-mints before expiry:

```ts
import { makeTokenProvider, SubstrateClient } from '@mnmal-ai/substrate/client';

const client = new SubstrateClient({
  endpoint: 'https://substrate.example.com:3100',
  getToken: makeTokenProvider({
    keyPath: process.env.SUBSTRATE_AGENT_KEY_PATH, // Ed25519 private-key PEM
    kid: process.env.SUBSTRATE_AGENT_KEY_ID // key id registered with the server
  })
});
```

`makeTokenProvider` returns the **bare** JWT; the transports add `Bearer `. Do not pass `makeAuthorizationProvider` here: it returns the full header value and you would send `Bearer Bearer <jwt>`, which 401s every request.

`getToken` accepts a sync or async provider. Passing both `token` and `getToken` throws at construction.

## Read diagnostics

The server reports non-fatal observations about **successful** reads on an `_diagnostics` envelope sidecar, chiefly projection keys the type does not declare.

That matters more than "non-fatal" suggests. An undeclared key in `fields` is not rejected: it comes back as `null` on **every** row, which is indistinguishable from a declared field that happens to be null everywhere. Once rows are cast to your interface, the `null` satisfies the type and the read looks correct indefinitely. (An undeclared key in `where` is rejected loudly with `unknown_field`.)

So the client sends each diagnostic to a sink, by default a deduped `console.warn`:

```ts
const client = new SubstrateClient({
  endpoint: 'http://localhost:3100',
  // Optional. Omit for the default warning; pass your own to route into a
  // logger or metrics pipeline, or to throw in development.
  onDiagnostics: ({ opKey, unknownProjectionFields }) => {
    logger.warn({ opKey, unknownProjectionFields }, 'unknown projection field');
  }
});
```

The default sink warns once per distinct (op-key, field-set) per client, so a different typo is still audible but a polling loop does not repeat the same warning. That matters during a rolling deploy, where a freshly built worker can legitimately project a field a not-yet-restarted server does not know yet.

- **Never surfaced as an error.** `errors` stays untouched and nothing rejects.
- **Absent means nothing to report.** No `_diagnostics`, no sink call.
- **`env._diagnostics`** is also on the returned envelope if you want to handle it yourself.
- **Query and mutate only.** Subscriptions do not carry diagnostics.

## Terminal-aware resubscribe

`WsTransport` classifies subscription terminals per the [WebSocket teardown contract](../../docs/ws-subscription-contract.md):

| Terminal | Behaviour |
|---|---|
| `error { code: 'subscription_overloaded' }` (+ trailing `end`) | Auto-resubscribe with exponential backoff, **on by default**, bounded (3 attempts). The terminal is suppressed; you see a fresh `snapshot` instead. After the budget is spent, the `SubscribeError` surfaces. A subscription healthy for 60s regains its full budget. |
| `end { reason: 'server_restart' }` | The `end` event is still delivered, but the subscription is not terminated: it resubscribes automatically on the new socket. |
| `end` with no `reason` (cancel ack) | Terminal. |
| `error` with any other code | Terminal, never auto-retried: retrying a rejected frame just rejects again. |

Tune or disable it with the `overloadResubscribe` option:

```ts
new SubstrateClient({
  endpoint,
  overloadResubscribe: {
    enabled: true,       // false makes overload terminal
    maxAttempts: 3,
    baseDelayMs: 1000,
    maxDelayMs: 30_000,
    jitter: 0.1,
    healthyResetMs: 60_000
  }
});
```
