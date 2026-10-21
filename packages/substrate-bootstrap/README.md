# @mnmal-ai/substrate-bootstrap

Internal: bundled into `@mnmal-ai/substrate` and not published; its public surface is `@mnmal-ai/substrate/sdk`.

The `defineBootstrap` helper every plugin's `bootstrap.ts` is written with.

A plugin's manifest entry exports a `bootstrap` function. The loader calls it with the operator's JSON config (the plugin's `default-config.json` merged with `<SUBSTRATE_PLUGIN_DIR>/<plugin>.config.json`). `defineBootstrap` turns that into a short declaration: validate the config against a schema, then build the plugin.

```ts
import { defineBootstrap } from '@mnmal-ai/substrate/sdk';

// Coordinator: operator JSON config only.
export const bootstrap = defineBootstrap.coordinator({
  schema: MyConfigSchema,
  build: (config) => createMyPlugin(config)
});

// Kernel: operator JSON config plus dependencies the host builds.
export const bootstrap = defineBootstrap.kernel<MyConfig, MyHostDeps>({
  schema: MyConfigSchema,
  build: (config, deps) => createMyKernelPlugin({ ...config, ...deps })
});
```

The schema is structural: any zod schema, or any validator with the same `safeParse` shape, works. An invalid config throws `BootstrapConfigError` listing each issue with its path, so the binary refuses to boot rather than running a misconfigured plugin.

## More

- [`docs/plugin-tier-decision.md`](../../docs/plugin-tier-decision.md): which of the two to use
- Source: `packages/substrate-bootstrap/src/`
