# @mnmal-ai/substrate-core

Internal: bundled into `@mnmal-ai/substrate` and not published; it is not part of the public surface, except `loadPlugins` and `MemoryEdgesStore`, which `@mnmal-ai/substrate/testing` exports.

Substrate engine core: registry, resolver dispatch, plugin loading, subscriptions, sweep.

`Engine` owns the registry of qualified frame keys (`<ns>/<TypeName>`, `<ns>/<mutationName>`) and dispatches query, mutate, subscribe and stream frames to their resolvers. `loadPlugins` wires each contributed namespace into the registry from a caller-supplied plugin list (the `substrate` binary builds that list from the manifests under `SUBSTRATE_PLUGIN_DIR`). The sweep runtime runs scheduled tasks, such as TTL purges, on their declared cadences. Datasets and transports talk to it only through the interfaces in `@mnmal-ai/substrate-types`.

## Where it fits

Above `@mnmal-ai/substrate-types`, `@mnmal-ai/substrate-sdk` (what gets registered) and `@mnmal-ai/substrate-filter` (where-clause evaluation). Below the transports, `@mnmal-ai/substrate-server-fastify` and `@mnmal-ai/substrate-server-memory`. The engine imports no plugins; callers (the binary, embedding hosts, tests) hand `loadPlugins` an already-discovered list.

## More

- Spec: §3 (layered architecture) and §4 (core primitives), [`docs/substrate-from-first-principles.md`](../../docs/substrate-from-first-principles.md)
- Source: `packages/substrate-core/src/`
