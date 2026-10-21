# @mnmal-ai/substrate-dataset-pg

Internal: bundled into `@mnmal-ai/substrate` and not published; it is not part of the public surface, except its test-database guards, which `@mnmal-ai/substrate/testing` exports.

PostgreSQL implementation of `Dataset` (spec §4.5), with the edges, idempotency and short-id stores.

Selected by the binary when `SUBSTRATE_DATABASE_URL` is a `postgres://` URL. Migrations in `src/migrations/` apply idempotently at boot.

## Schema

Rows of every type share one table. The dataset does not know a type's shape at migration time, so the row body is opaque JSONB:

```sql
CREATE TABLE rows (
  namespace        text        NOT NULL,
  type             text        NOT NULL,
  id               text        NOT NULL,
  body             jsonb       NOT NULL,
  deleted_at       timestamptz NULL,
  created_at       timestamptz NULL,
  updated_at       timestamptz NULL,
  created_by_kind  text        NULL,  -- 'agent' | 'user' | 'system'
  created_by_id    text        NULL,
  updated_by_kind  text        NULL,
  updated_by_id    text        NULL,
  PRIMARY KEY (namespace, type, id)
);
```

`0001_baseline` creates it, with `edges` (cross-ref edges), `idempotency` and `short_ids`. `0002_uuid_format_check` adds UUID-format CHECKs on row and edge ids, and runs only when `SUBSTRATE_ENFORCE_UUID_CHECK=true`. A plugin that promotes fields out of `body` into columns adds them in its own migration and declares them as `promotedColumns`. Kernel plugins add their own tables; `substrate-recall` owns `embeddings`.

## Running tests

With `POSTGRES_URL` unset, the integration suite is skipped and the test command exits cleanly, so CI without Postgres can still run `pnpm test`.

The suites run destructive setup (TRUNCATE, DELETE, DDL), so three guards from `@mnmal-ai/substrate-dataset-pg/testing` run first and refuse to start unless:

1. the database name ends in `_test` or `_dev` (`assertTestDatabase`);
2. the role is not a superuser (`assertNotSuperuser`);
3. the role cannot write to any non-test database (`assertCannotWriteOutsideTestDatabases`).

Each pg-gated package then runs in a schema of its own inside that database, so packages can run concurrently.

A throwaway setup that satisfies the guards:

```bash
docker run --rm -d --name substrate-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 pgvector/pgvector:pg17

docker exec substrate-pg psql -U postgres \
  -c "CREATE ROLE substrate_test LOGIN PASSWORD 'substrate_test'" \
  -c "CREATE DATABASE substrate_test OWNER substrate_test"
docker exec substrate-pg psql -U postgres -d substrate_test -c "CREATE EXTENSION IF NOT EXISTS vector"

POSTGRES_URL=postgres://substrate_test:substrate_test@localhost:5432/substrate_test \
  pnpm --filter @mnmal-ai/substrate-dataset-pg test
```

The `vector` extension is only needed by suites that touch embeddings (for example `substrate-recall`'s), but creating it up front lets the same database serve every package.
