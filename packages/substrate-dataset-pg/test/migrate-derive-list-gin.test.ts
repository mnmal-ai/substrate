/**
 * Auto-derived GIN migrations for `field.list({ indexed: true })`.
 *
 * The pure-derivation cases run always; the runner cases are skipped unless
 * POSTGRES_URL is set.
 */

/**
 * Index lookups here are scoped by schema and `tablename`, not matched on
 * `indexname` alone. `pg_indexes` spans every schema and index names are
 * unique only WITHIN a schema, so a bare name match can silently read
 * another schema's index and pass.
 */
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deriveListIndexMigration, runDerivedMigrations, runMigrations } from '../src/index.js';

const POSTGRES_URL = process.env.POSTGRES_URL;

describe('deriveListIndexMigration (pure)', () => {
  it('derives a scoped CONCURRENTLY GIN, keyed by the raw names', () => {
    const m = deriveListIndexMigration({ namespace: 'labs', type: 'Trace', field: 'subjects' });
    expect(m.version).toBe('list-gin:labs:Trace:subjects');
    const stmt = (m.concurrentStatements ?? []).join('\n');
    expect(stmt).toMatch(
      /CREATE INDEX CONCURRENTLY IF NOT EXISTS rows_labs_trace_subjects_[0-9a-f]{8}_gin\n/
    );
    expect(stmt).toContain("USING GIN ((body -> 'subjects') jsonb_path_ops)");
    expect(stmt).toContain("WHERE namespace = 'labs' AND type = 'Trace' AND deleted_at IS NULL");
    expect(m.txStatements ?? []).toEqual([]);
  });

  it('gives fields that sanitise or truncate alike distinct index names', () => {
    const name = (type: string, field: string): string =>
      /IF NOT EXISTS (\S+)/.exec(
        (deriveListIndexMigration({ namespace: 'labs', type, field }).concurrentStatements ??
          [])[0] as string
      )?.[1] as string;
    expect(name('Trace', 'my-tags')).not.toBe(name('Trace', 'my_tags'));
    const long = 'T'.repeat(70);
    expect(name(long, 'first')).not.toBe(name(long, 'second'));
    expect(Buffer.byteLength(name(long, 'first'))).toBeLessThanOrEqual(63);
  });
});

describe.skipIf(!POSTGRES_URL)('runDerivedMigrations', () => {
  let sql: Sql;

  beforeAll(async () => {
    sql = postgres(POSTGRES_URL as string);
    await runMigrations(sql);
  });

  afterAll(async () => {
    await sql.end();
  });

  it('creates the GIN, tracks it in migrations, and is idempotent', async () => {
    const m = deriveListIndexMigration({ namespace: 'kmeta', type: 'Metric', field: 'labels' });
    const indexName = /IF NOT EXISTS (\S+)/.exec(m.concurrentStatements?.[0] ?? '')?.[1] ?? '';
    // Clean slate for re-runnability.
    await sql`DROP INDEX IF EXISTS ${sql(indexName)}`;
    await sql`DELETE FROM migrations WHERE version = ${m.version}`;

    await runDerivedMigrations(sql, [m]);

    const idx = await sql<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = current_schema() AND tablename = 'rows' AND indexname = ${indexName}`;
    expect(idx).toHaveLength(1);
    expect(idx[0]?.indexdef).toMatch(/USING gin/i);

    const tracked = await sql<{ version: string }[]>`
      SELECT version FROM migrations WHERE version = ${m.version}`;
    expect(tracked).toHaveLength(1);

    // Re-run is a no-op (version already applied) — still exactly one index.
    await runDerivedMigrations(sql, [m]);
    const count = await sql<{ c: number }[]>`
      SELECT count(*)::int AS c FROM pg_indexes
      WHERE schemaname = current_schema() AND tablename = 'rows' AND indexname = ${indexName}`;
    expect(count[0]?.c).toBe(1);

    await sql`DROP INDEX IF EXISTS ${sql(indexName)}`;
    await sql`DELETE FROM migrations WHERE version = ${m.version}`;
  });
});
