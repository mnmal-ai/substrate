# @mnmal-ai/substrate-server-memory

Internal: bundled into `@mnmal-ai/substrate` and not published; its public surface is `@mnmal-ai/substrate/testing`.

In-process `SubstrateServer` for tests and embedding.

The socket-free sibling of `@mnmal-ai/substrate-server-fastify`. `MemorySubstrateServer` implements the same `SubstrateServer` interface from `@mnmal-ai/substrate-types`, but requests are delivered with `server.inject(req)` and come back as a `SubstrateResponse`; `createMemoryWsPair` gives an in-process WebSocket pair. No port, no TCP.

## Where it fits

Instantiated directly by a host (there is no env-var path). The cross-server parity suite runs the same scenarios through this server and the Fastify one and expects identical results.

## More

- Source: `packages/substrate-server-memory/src/`
- Parity suite: `apps/substrate/test/cross-server-parity.test.ts`
