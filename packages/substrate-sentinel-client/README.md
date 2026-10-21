# @mnmal-ai/substrate-sentinel-client

Internal: bundled into `@mnmal-ai/substrate` and not published; it is not part of the public surface.

Dynamic bridge discovery from a Sentinel instance.

`startSentinelClient` connects to a Sentinel's WebSocket topology stream and keeps a caller-owned bridge registry in step with it: when a peer comes online it creates an `HttpBridgeClient` for that peer's namespace, registers it and refreshes bridge schemas; when a peer goes offline it unregisters and disposes the client. It reconnects with exponential backoff.

`loadConfig` reads its settings from the environment:

| Variable | Meaning |
|---|---|
| `SUBSTRATE_SENTINEL_URL` | `ws://` or `wss://` URL of the Sentinel |
| `SUBSTRATE_SENTINEL_CREDENTIAL` | JSON `{ keyPath, kid }` the client signs with; required when the URL is set |
| `SUBSTRATE_SENTINEL_RECONNECT_BASE_MS` | Initial reconnect delay (default 500) |
| `SUBSTRATE_SENTINEL_RECONNECT_MAX_MS` | Backoff cap (default 30000) |

## Where it fits

A wiring library called from a host's composition root. Uses `@mnmal-ai/substrate-bridge-http` for the bridge clients. The registry it watches is served by the `@mnmal-ai/substrate-sentinel` plugin.

## More

- Source: `packages/substrate-sentinel-client/src/`
- Sentinel plugin: `plugins/substrate-sentinel/`
