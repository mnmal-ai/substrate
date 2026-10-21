# @mnmal-ai/substrate-sentinel

Coordinator plugin: a registry for dynamic bridge discovery.

Owns the `sentinel` namespace (`Coordinator`, `CoordinatorNamespace`, `CoordinatorBridge`), describing the Substrate instances in a federation and the namespaces each serves. Peers register over the plugin's WebSocket route; a liveness loop pings them and marks a peer `offline` once it has been silent longer than `staleThresholdMs`. Other instances follow the registry over the plugin's WebSocket route with the sentinel client built into `@mnmal-ai/substrate` (enabled by `SUBSTRATE_SENTINEL_URL`), which registers and unregisters bridges as peers come and go.

## Where it fits

Install it on the instance that acts as the federation's Sentinel. A single-instance deployment does not need it.

## Usage

```bash
cd <runtime-dir>        # the directory SUBSTRATE_PLUGIN_DIR points at
pnpm add @mnmal-ai/substrate-sentinel
```

Defaults in `default-config.json`: `namespace: "sentinel"`, `pingIntervalMs: 30000` (liveness tick), `staleThresholdMs: 90000` (age after which a peer is treated as stale). Override them in `<SUBSTRATE_PLUGIN_DIR>/substrate-sentinel.config.json`.

Routes: `GET /substrate/v1/plugins/substrate-sentinel/status` and the topology stream at `/substrate/v1/plugins/substrate-sentinel/ws`.

## More

- Spec: §5.8 (bridges), [`docs/substrate-from-first-principles.md`](../../docs/substrate-from-first-principles.md)
- Source: `plugins/substrate-sentinel/src/`
- Client: `packages/substrate-sentinel-client/`
