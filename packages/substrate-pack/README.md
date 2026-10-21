# @mnmal-ai/substrate-pack

Internal: bundled into `@mnmal-ai/substrate` and not published; its public surface is `@mnmal-ai/substrate/pack`.

MessagePack + positional encoder/decoder for Substrate wire frames.

Encodes query, mutate and subscribe envelopes to bytes and back. Used when a client opts in, with `Accept: application/vnd.substrate.pack` over HTTP or the `substrate-pack` WebSocket subprotocol. Positional encoding drops the field names repeated on every row (the shape is sent once); MessagePack carries binary values without base64.

## Where it fits

Below the transports (used by `@mnmal-ai/substrate-compose` routes and `@mnmal-ai/substrate-client`) and above the engine, which hands it resolved frame data. No knowledge of HTTP, WebSocket or storage: bytes in, bytes out.

## More

- Spec: §7 (wire format), [`docs/substrate-from-first-principles.md`](../../docs/substrate-from-first-principles.md)
- Source: `packages/substrate-pack/src/`
