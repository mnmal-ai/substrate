# @mnmal-ai/substrate-sentinel

Coordinator plugin: a registry for dynamic bridge discovery.

Owns the `sentinel` namespace (`Coordinator`, `CoordinatorNamespace`, `CoordinatorBridge`), describing the Substrate instances in a federation and the namespaces each serves. Peers register over a long-lived `POST /register` frame stream, and stay online while it is open. The liveness loop sends each open stream a heartbeat frame, and closing the stream marks the peer `offline`. Other instances follow the registry over the `GET /watch` frame stream with the sentinel client built into `@mnmal-ai/substrate` (enabled by `SUBSTRATE_SENTINEL_URL`), which registers and unregisters bridges as peers come and go.

## Where it fits

Install it on the instance that acts as the federation's Sentinel. A single-instance deployment does not need it.

## Usage

```bash
cd <runtime-dir>        # the directory SUBSTRATE_PLUGIN_DIR points at
pnpm add @mnmal-ai/substrate-sentinel@next
```

Defaults in `default-config.json`: `namespace: "sentinel"`, `pingIntervalMs: 30000` (how often each open stream gets a heartbeat frame; at most 30000, since sentinel clients drop a watch stream silent for 95 s). `staleThresholdMs` is still accepted but ignored: a peer is online while its stream is open. Override them in `<SUBSTRATE_PLUGIN_DIR>/substrate-sentinel.config.json`.

Routes, under `/substrate/v1/plugins/substrate-sentinel`: `GET /status`; `POST /register` (needs `mutate`) and `GET /watch` (needs `read`), each a stream of length-prefixed JSON frames.

## More

- Spec: §5.8 (bridges), [`docs/substrate-from-first-principles.md`](../../docs/substrate-from-first-principles.md)
- Source: `plugins/substrate-sentinel/src/`
- Client: `packages/substrate-sentinel-client/`
