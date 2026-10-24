/**
 * Row-metadata schema migration tests.
 *
 * Requires POSTGRES_URL in the environment — skips when absent.
 * Verifies that `runMigrations` adds the 6 metadata columns + 2 indexes to
 * `rows`, that they are NULLABLE, and that the migration is idempotent.
 *
 * Uses beforeEach / afterEach with a DROP TABLE so each test starts from a
 * clean slate and proves the migration builds the schema from scratch.
 */

import postgres, { type Sql } from 'postgres';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/index.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const PARTITIONED = process.env.SUBSTRATE_STORAGE_LAYOUT === 'partitioned';

describe.skipIf(!POSTGRES_URL)('row-metadata schema migration', () => {
  let sql: Sql;

  beforeEach(async () => {
    sql = postgres(POSTGRES_URL as string, { onnotice: () => {} });
    // Drop rows + all dependents AND the migration-tracking table so
    // each test proves the migration framework rebuilds the schema from
    // scratch (versioned migrations skip already-applied versions).
    await sql`DROP TABLE IF EXISTS rows CASCADE`;
    await sql`DROP TABLE IF EXISTS migrations`;
  });

  afterEach(async () => {
    await sql.end();
  });

  it('adds 6 metadata columns to rows', async () => {
    await runMigrations(sql);
    const cols = await sql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'rows'
        AND column_name IN ('created_at','updated_at','created_by_kind','created_by_id','updated_by_kind','updated_by_id')
      ORDER BY column_name
    `;
    expect(cols.map((c) => c.column_name)).toEqual([
      'created_at',
      'created_by_id',
      'created_by_kind',
      'updated_at',
      'updated_by_id',
      'updated_by_kind'
    ]);
  });

  // Legacy only: a partitioned `rows` has no parent-level indexes; per-partition
  // engine indexes are not built yet.
  it.skipIf(PARTITIONED)(
    'adds composite partial indexes on (namespace, type, ts) — replaces single-col globals',
    async () => {
      await runMigrations(sql);
      const idxs = await sql<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = current_schema() AND tablename = 'rows'
        AND indexname IN (
          'rows_ns_type_created_at_idx',
          'rows_ns_type_updated_at_idx'
        )
      ORDER BY indexname
    `;
      expect(idxs.map((i) => i.indexname)).toEqual([
        'rows_ns_type_created_at_idx',
        'rows_ns_type_updated_at_idx'
      ]);
      // Composite (namespace, type, ts DESC NULLS LAST) — leading namespace+type
      // lets the planner seek the prefix and walk the timestamp in order.
      expect(idxs[0]?.indexdef).toMatch(/\(namespace, type, created_at DESC NULLS LAST\)/);
      expect(idxs[1]?.indexdef).toMatch(/\(namespace, type, updated_at DESC NULLS LAST\)/);
      // Partial — tombstoned rows stay out of the index entirely.
      for (const i of idxs) {
        expect(i.indexdef).toMatch(/WHERE \(deleted_at IS NULL\)/);
      }
    }
  );

  it('is idempotent — second run does not error', async () => {
    await runMigrations(sql);
    await runMigrations(sql); // should be a no-op
    const cols = await sql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'rows'
        AND column_name = 'created_at'
    `;
    expect(cols).toHaveLength(1);
  });

  it('columns are NULLABLE (no NOT NULL constraint)', async () => {
    await runMigrations(sql);
    const cols = await sql<{ column_name: string; is_nullable: string }[]>`
      SELECT column_name, is_nullable FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'rows'
        AND column_name IN ('created_at','created_by_kind','created_by_id')
    `;
    for (const c of cols) {
      expect(c.is_nullable).toBe('YES');
    }
  });

  it('CHECK constraints exist on *_by_kind columns', async () => {
    await runMigrations(sql);
    const constraints = await sql<{ conname: string }[]>`
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'rows'::regclass
        AND contype = 'c'
        AND conname IN ('rows_created_by_kind_check', 'rows_updated_by_kind_check')
      ORDER BY conname
    `;
    expect(constraints.map((c) => c.conname)).toEqual([
      'rows_created_by_kind_check',
      'rows_updated_by_kind_check'
    ]);
  });

  it('rejects INSERT with invalid created_by_kind value', async () => {
    await runMigrations(sql);
    await expect(
      sql`
        INSERT INTO rows (namespace, type, id, body, created_by_kind)
        VALUES ('test_check', 'T', 'bad-kind', '{}', 'invalid_kind')
      `
    ).rejects.toThrow();
    // Clean up in case something slipped through
    await sql`DELETE FROM rows WHERE namespace = 'test_check'`;
  });

  it('rejects INSERT with invalid updated_by_kind value', async () => {
    await runMigrations(sql);
    await expect(
      sql`
        INSERT INTO rows (namespace, type, id, body, updated_by_kind)
        VALUES ('test_check', 'T', 'bad-kind2', '{}', 'robot')
      `
    ).rejects.toThrow();
    await sql`DELETE FROM rows WHERE namespace = 'test_check'`;
  });

  it('accepts INSERT with valid *_by_kind values', async () => {
    await runMigrations(sql);
    for (const kind of ['agent', 'user', 'system'] as const) {
      await sql`
        INSERT INTO rows (namespace, type, id, body, created_by_kind, updated_by_kind)
        VALUES ('test_check', 'T', ${`valid-${kind}`}, '{}', ${kind}, ${kind})
      `;
    }
    const rows = await sql<{ id: string }[]>`
      SELECT id FROM rows WHERE namespace = 'test_check' ORDER BY id
    `;
    expect(rows).toHaveLength(3);
    await sql`DELETE FROM rows WHERE namespace = 'test_check'`;
  });

  it('accepts NULL for *_by_kind (legacy rows)', async () => {
    await runMigrations(sql);
    await sql`
      INSERT INTO rows (namespace, type, id, body)
      VALUES ('test_check', 'T', 'null-kind', '{}')
    `;
    const rows = await sql<{ created_by_kind: string | null }[]>`
      SELECT created_by_kind FROM rows WHERE namespace = 'test_check' AND id = 'null-kind'
    `;
    expect(rows[0]?.created_by_kind).toBeNull();
    await sql`DELETE FROM rows WHERE namespace = 'test_check'`;
  });

  it('CHECK constraints are idempotent — second runMigrations does not error', async () => {
    await runMigrations(sql);
    await runMigrations(sql); // should be a no-op
    const constraints = await sql<{ conname: string }[]>`
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'rows'::regclass
        AND contype = 'c'
        AND conname IN ('rows_created_by_kind_check', 'rows_updated_by_kind_check')
    `;
    expect(constraints).toHaveLength(2);
  });
});
