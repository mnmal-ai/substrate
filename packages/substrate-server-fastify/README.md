# @mnmal-ai/substrate-server-fastify

Internal: bundled into `@mnmal-ai/substrate` and not published; it is not part of the public surface.

Fastify-backed `SubstrateServer`: the production HTTP and WebSocket transport.

What `apps/substrate` runs to serve the routes `compose` mounts, plus the WebSocket upgrade at `/substrate/v1/ws`. Wraps Fastify 5 with per-request `AbortController` fan-out (graceful shutdown drains in-flight requests), the `application/vnd.substrate.pack` content-type parser, `@fastify/websocket` for subscribe and stream, optional CORS, optional TLS, and a plugin router that mounts each coordinator's routes under `/substrate/v1/plugins/<name>/`.

## Where it fits

The default transport for the `substrate` binary. `@mnmal-ai/substrate-server-memory` is the in-process counterpart for tests and embedding. Both implement the `SubstrateServer` interface from `@mnmal-ai/substrate-types`, so swapping one for the other is a one-line change in compose code.

## More

- Spec: §4.8 (server), [`docs/substrate-from-first-principles.md`](../../docs/substrate-from-first-principles.md)
- Source: `packages/substrate-server-fastify/src/`
