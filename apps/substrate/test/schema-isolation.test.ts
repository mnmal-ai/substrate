/**
 * This package's pg-gated suites must run in a schema of their own.
 *
 * The three pg-gated packages are run CONCURRENTLY by turbo against one
 * database. Each is internally serialised (`fileParallelism: false`) against a
 * hazard it shares with the other two — the suites isolate themselves by
 * dropping and re-migrating `rows` / `embeddings` /
 * `migrations`, which is correct within a package and catastrophic
 * across three.
 *
 * `test/_global-setup.ts` pins `search_path` to a per-package schema. This
 * asserts that it actually took effect; every other pg test in this package
 * passes whether it did or not, so this is the only test that would notice.
 */

import { pgTestSchemaName } from '@mnmal-ai/substrate-dataset-pg/testing';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';

const POSTGRES_URL = process.env.POSTGRES_URL;

describe.skipIf(!POSTGRES_URL)('pg schema isolation', () => {
  it("resolves unqualified DDL to this package's own schema, not public", async () => {
    const sql = postgres(POSTGRES_URL as string, { max: 1, onnotice: () => {} });
    try {
      const rows = await sql<Array<{ schema: string; path: string }>>`
        SELECT current_schema()::text AS schema, current_setting('search_path') AS path
      `;
      expect(rows[0]?.schema).toBe(
        pgTestSchemaName(`apps/substrate-${process.env.SUBSTRATE_STORAGE_LAYOUT}`)
      );
      // `public` has to stay reachable: the `vector` type and its `hnsw`
      // operator class live there and resolve by search_path.
      expect(rows[0]?.path).toContain('public');
    } finally {
      await sql.end();
    }
  });
});
