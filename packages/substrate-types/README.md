# @mnmal-ai/substrate-types

Internal: bundled into `@mnmal-ai/substrate` and not published; its public surface is `@mnmal-ai/substrate/sdk`.

Foundational types and zero-dependency runtime primitives for Substrate.

The lowest-level package in the workspace. It defines the core interfaces (`SubstrateServer`, `SubstrateRequest`, `SubstrateResponse`, `Dataset`, the plugin contracts `CoordinatorPlugin` and `KernelPlugin`, policy and WebSocket frame types) and a small set of runtime primitives: the error classes everything throws, qualified-frame-key parsing and formatting, canonicalization, the `assertNever` exhaustiveness helper, and the `SUBSTRATE_HARD_DELETE` gate. The primitives live here rather than in `substrate-core` so the authoring layer (`substrate-sdk`) can use them without depending on the engine.

It has no npm runtime dependencies, so importing it never pulls in a transitive payload.

## Where it fits

The foundation: every other `@mnmal-ai/substrate-*` package depends on it, and it is built first. A change to a public type here reaches every package and every client pinned to a Substrate version.

## More

- Spec: [`docs/substrate-from-first-principles.md`](../../docs/substrate-from-first-principles.md)
- Source: `packages/substrate-types/src/`
