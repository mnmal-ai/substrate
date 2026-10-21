# Plugin tiers: kernel and coordinator

Every substrate plugin declares one tier in its `package.json`:

```json
{ "substrate": { "tier": "kernel", "entry": "./dist/bootstrap.js" } }
```

The tier is `"kernel"` or `"coordinator"`. It decides which contract the plugin implements, which hooks it gets, and what the loader passes to its `bootstrap()`. For the broader plugin contract (fields, autoCRUD, `onStart`), see [`plugin-author-guide.md`](plugin-author-guide.md).

## Why two tiers

Most plugins are applications: they own a namespace and expose types to agents. A few extend the engine itself: they add a filter operator, a storage table, a top-level route, or a hook that runs on every namespace's writes. The two jobs need different things.

- An application plugin should not touch the database handle or the grammar. It gets its operator config and nothing else, so it can be loaded, tested and swapped without knowing how the host is built.
- An engine extension needs dependencies the host builds (a SQL handle, an embeddings store) and must be live before any application composes, so applications can rely on it.

Splitting them keeps the large category (coordinators) simple and the small, privileged one (kernel) explicit.

## The short version

```
Does your plugin own a namespace and expose types to agents?
├── yes → coordinator
└── no, it extends the engine (operators / migrations / kernel routes / MCP tools)
    └── → kernel
```

If the answer is "both", ship two plugins. A plugin has exactly one tier.

## What each tier gets

| Capability | Coordinator | Kernel |
|---|:-:|:-:|
| Declare namespaces and types (`namespaces`) | ✓ | — |
| Routes under `/substrate/v1/plugins/<name>/` (`routes`) | ✓ | — |
| `onStart` / `onStop` lifecycle | ✓ | — |
| Onboard instructions (`onboardInstructions`) | ✓ | — |
| Schema migrations (`migrations`, idempotent at boot) | — | ✓ |
| Where-clause operators (`filterOperators`) | — | ✓ |
| Top-level routes under `/substrate/v1/<path>` (`kernelRoutes`) | — | ✓ |
| Top-level MCP tools (`mcpTools`) | — | ✓ |
| A virtual, resolver-backed namespace with no dataset (`kernelNamespace`) | — | ✓ |
| Post-write hooks on other plugins' types (`contributePostWrites`) | — | ✓ |
| `onKernelReady` lifecycle | — | ✓ |
| Host-built dependencies passed to `bootstrap()` | — | ✓ |

**Compose order:** kernel plugins compose first, then coordinators; alphabetical within each tier. Coordinators may rely on kernel registrations being live. Kernel plugins must not depend on any coordinator namespace existing.

## Deciding

Take the questions in order; the first "yes" picks the tier.

1. **Does the plugin own a namespace and expose types directly to agents?** Yes → **coordinator**. (If you also want embedding on your types, that comes from a kernel plugin such as `substrate-recall` reading your type metadata.)
2. **Does it extend the grammar or the storage?** A `where` operator like `embeddingSimilar`, a top-level route like `/substrate/v1/recall`, or its own table via a migration. Yes → **kernel**.
3. **Does it walk every loaded namespace's type metadata and chain post-writes?** Like `substrate-recall` reading each type's `embed.source`. Yes → **kernel**.
4. **Does it need dependencies the binary builds?** A postgres handle, an embeddings store, an edges store. Yes → **kernel**.
5. **Otherwise → coordinator.** It is the default and the larger category.

A plugin's name says nothing about its tier. Read the `substrate.tier` field.

## Examples in this repo

**`@mnmal-ai/substrate-sentinel` (coordinator).** Owns the `sentinel` namespace and its types. No host dependencies, no grammar extensions.

```ts
export const bootstrap = defineBootstrap.coordinator({
  schema: SentinelBootstrapConfigSchema,
  build: (config) => createSentinelPlugin({ namespace: config.namespace /* … */ })
});
```

**`substrate-recall` (kernel, built into `@mnmal-ai/substrate`).** Owns no data namespace. It contributes a migration for the embeddings table (pgvector + HNSW), the `embeddingSimilar` filter operator, the `POST /substrate/v1/recall` route, the `recall` MCP tool, and a `contributePostWrites` walker that adds an embedding post-write to every type declaring `embed.source`. The binary passes it its store as host dependencies.

```ts
export const bootstrap = defineBootstrap.kernel<RecallBootstrapConfig, RecallHostDeps>({
  schema: RecallBootstrapConfigSchema,
  build: (config, deps) => /* createRecallPlugin({ ...config, store: deps.store, … }) */
});
```

Both snippets are trimmed; see each plugin's `src/bootstrap.ts`.

## Changing tier later

Treat the choice as permanent.

- **Coordinator → kernel** loses namespace registration. Every type the plugin declared has to move to a separate coordinator plugin first. Rows stay where they are, but anything that refers to the plugin by name breaks.
- **Kernel → coordinator** loses host dependencies, `contributePostWrites`, `filterOperators`, `kernelRoutes`, `mcpTools` and `kernelNamespace`. Everything contributed through those needs a new home.

Either way the plugin moves to a different point in compose order, which can affect plugins that relied on the old order. If a plugin sits on the boundary, split it in two.

## See also

- `packages/substrate-bootstrap/src/index.ts`: `defineBootstrap.coordinator` and `defineBootstrap.kernel`
- `packages/substrate-types/src/plugin.ts`: the `CoordinatorPlugin` and `KernelPlugin` interfaces
- `apps/substrate/src/plugin-dir-loader.ts`: the manifest-driven loader and compose order
- [`plugin-author-guide.md`](plugin-author-guide.md)
