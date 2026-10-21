# @mnmal-ai/substrate-compose

Internal: bundled into `@mnmal-ai/substrate` and not published; it is not part of the public surface, except `compose`, `ComposeResult`, `AuthConfig` and `signHs256`, which `@mnmal-ai/substrate/testing` exports, and the route helpers `error400`, `JSON_HEADERS`, `jsonResponse` and `parseJsonBody`, which `@mnmal-ai/substrate/sdk` exports.

Compose plugins, a dataset and a server into a runnable Substrate.

The wiring layer between "I have plugins and a dataset" and "I have a server ready to take requests". `compose(...)` takes a plugin list, composes kernel plugins before coordinators, applies policy and sweep configuration, attaches post-write hooks contributed by kernel plugins (for example recall's embedding hook), mounts the kernel routes (`/health`, `/substrate/v1/query`, `/substrate/v1/mutate`, `/substrate/v1/onboard`, `/substrate/v1/ws`, the SSE routes, `_system` admin) and returns the loaded engine. `composeFromManifests(...)` does the same from discovered plugin manifests, checking each plugin's `contractVersion`.

## Where it fits

Above `@mnmal-ai/substrate-core` and below `apps/substrate`, which calls it at boot. Plugin authors rarely use it directly: write a plugin and let the binary compose it. Hosts embedding Substrate programmatically call `compose` themselves.

## More

- Spec: §3 and §5.11 (coordinator plugins), [`docs/substrate-from-first-principles.md`](../../docs/substrate-from-first-principles.md)
- Source: `packages/substrate-compose/src/`
