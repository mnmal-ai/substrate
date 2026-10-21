# @mnmal-ai/substrate-config

Workspace tooling, published so other repositories can extend it. It is not bundled into `@mnmal-ai/substrate` and is not part of its public surface.

Shared TypeScript, Biome and tsdown configs for the Substrate workspace, and a toolchain manifest with a checker.

Exports `tsconfig.base.json` (strict + `exactOptionalPropertyTypes`), the presets `tsconfig.lib.json` / `tsconfig.app.json` / `tsconfig.dts.json` that extend it, `biome.json` (formatter + lint rules), and the `defineLibTsdown` / `defineBinTsdown` helpers for `tsdown.config.ts`. Other repositories can extend these too.

## Usage

```jsonc
// In a package's tsconfig.json:
{
  "extends": "@mnmal-ai/substrate-config/tsconfig.lib.json",
  "include": ["src/**/*", "test/**/*"]
}
```

```ts
// In a package's tsdown.config.ts:
import { defineLibTsdown } from '@mnmal-ai/substrate-config/tsdown';
export default defineLibTsdown({ external: ['some-runtime-dep'] });
```

## Toolchain manifest

`toolchain.json` records the toolchain this workspace is built with: the Node engines floor, pnpm, the Biome schema, tracked catalog entries (TypeScript, tsdown, vitest, Biome, `@types/node`, zod, the MCP SDK) and GitHub Actions pins. A workspace package that depends on it can check the repository against it:

```bash
pnpm exec substrate-toolchain-check            # report drift, exit 0
pnpm exec substrate-toolchain-check --strict   # exit 1 on drift (for CI)
pnpm exec substrate-toolchain-check --fix      # align in place, then run pnpm install
```

It checks only what the repository uses: a catalog entry it lacks, or an action it never calls, is not drift. `--fix` edits in place and keeps formatting (catalog entries, `packageManager`, mise's pnpm, `engines.node`, the Biome schema, Actions pins), and never adds a field a repository does not have. The checker has no dependencies, so it runs on whatever toolchain the repository is on.

## More

- Source: `packages/substrate-config/src/tsdown.ts` (build helpers), `tsconfig.*.json` (presets), `bin/toolchain-check.mjs`
