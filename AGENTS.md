# substrate

An agent-first typed-data server. Plugins declare namespaces and types; the engine resolves qualified frames (`<namespace>/<Type>`) over Postgres or memory. The README's *Layout* section maps every package, and CONTRIBUTING.md covers PRs and labels.

## Layout

- `apps/substrate`: the published `@mnmal-ai/substrate`, which is the binary plus the public subpaths.
- `packages/*`: internal, bundled into `@mnmal-ai/substrate`.
- `plugins/*`: recall and proposals are built in; `substrate-nl` and `substrate-sentinel` publish on their own.

## Checks

```bash
pnpm install
pnpm turbo run build check-types lint test
node scripts/emit-toolchain.mjs --check
```

Postgres suites skip without `POSTGRES_URL`. When it is set, they refuse any database not ending `_test` or `_dev`, and any role that is a superuser or can write outside test databases. `packages/substrate-dataset-pg/README.md` explains the guards.

## Rules

- Shared dependency versions live in the `catalog:` of `pnpm-workspace.yaml`. Packages say `"catalog:"` or `"workspace:*"`, never a version.
- Types are registered at compose time with `defineNamespace`. There are no decorators and no build transforms.
- Every query, mutate and subscribe key is qualified as `<namespace>/<Type>`.
- `dist/` belongs to turbo. Don't hand-edit it, because the next cached build restores it.
- `!` is allowed only where control flow proves a value is present. Otherwise narrow the type.
- Toolchain versions (Node, pnpm, dev tools, action pins) come from `packages/substrate-config/toolchain.json`. Regenerate it with `node scripts/emit-toolchain.mjs`, never by hand.

## Releases

Bump versions on a `release/vX.Y.Z` branch. Merging it to `main` publishes through `publish.yml` behind the protected `release` environment, then tags. Never tag or publish by hand. Until 1.0.0, prereleases go to npm's `next` tag.
