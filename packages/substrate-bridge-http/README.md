# @mnmal-ai/substrate-bridge-http

Internal: bundled into `@mnmal-ai/substrate` and not published; it is not part of the public surface.

`HttpBridgeClient`: the HTTP implementation of a federation bridge.

When a namespace lives on a peer Substrate instance, the engine dispatches frames for it through a bridge client. This package provides the HTTP one: an `auth` header provider for signed requests, periodic health checks that track reachability, and `BridgeUnreachableError` (declared in `@mnmal-ai/substrate-types`) when the peer cannot be reached. The receiving side is the peer's ordinary query and mutate routes.

## Where it fits

A separate package from `substrate-core` so deployment helpers such as `@mnmal-ai/substrate-sentinel-client` can create bridges without carrying the whole engine. Bridges are configured statically with `SUBSTRATE_BRIDGES` or discovered through Sentinel; a single-instance deployment configures none.

## More

- Spec: §5.8 (bridges), [`docs/substrate-from-first-principles.md`](../../docs/substrate-from-first-principles.md)
- Source: `packages/substrate-bridge-http/src/`
