# Contributing

Work happens on a branch and lands on `main` through a pull request. `main` takes no direct pushes or force-pushes, and review threads must be resolved before merge.

## Before you open a PR

    pnpm install
    pnpm turbo run build check-types lint test

Postgres-gated suites run when `POSTGRES_URL` names a database ending `_test` or `_dev`, reached as a role that is not a superuser. CI runs them against a fresh database.

## Labels

The `PR hygiene` check requires every ready PR to carry:

| Kind | Rule | Labels |
|---|---|---|
| Area | at least one | the package the PR touches, named without the `@mnmal-ai/` scope (`substrate-core`, `substrate-dataset-pg`, ...), or `repo` for root-level changes |
| Type | exactly one | `feat`, `fix`, `refactor`, `docs`, `test`, `infra` |
| Priority | exactly one | `P0-critical`, `P1-high`, `P2-medium`, `P3-low` |

It also requires an assignee. Status labels (`blocked`, `needs-review`, `ready-to-merge`) are optional.

If you can't set labels or assignees on your PR, leave them: a maintainer will. The check fails until then, and that's expected.

Every workspace package needs an Area label. A PR that adds a package fails `Label catalog drift` until the label exists.

## Releases

Releases publish from `main` through `.github/workflows/publish.yml`, using npm trusted publishing behind a protected `release` environment. Don't tag or publish by hand.
