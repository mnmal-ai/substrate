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
const PARTITIONED = process.env.SUBSTRATE_STORAGE_LAYOUT === 'partitioned';

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

// Legacy only: on the partitioned layout list/json GIN indexes are built per
// type partition by the index reconciler instead.
describe.skipIf(!POSTGRES_URL || PARTITIONED)('runDerivedMigrations', () => {
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

describe.skipIf(!POSTGRES_URL || !PARTITIONED)('runDerivedMigrations (partitioned)', () => {
  let sql: Sql;

  beforeAll(async () => {
    sql = postgres(POSTGRES_URL as string, { onnotice: () => {} });
    await runMigrations(sql);
  });

  afterAll(async () => {
    await sql.end();
  });

  // Postgres cannot CREATE INDEX CONCURRENTLY on a partitioned parent, so
  // running the derived GIN there would fail every boot with an indexed list.
  it('a fresh database with an indexed list field migrates cleanly and builds nothing on rows', async () => {
    const m = deriveListIndexMigration({ namespace: 'kmeta', type: 'Metric', field: 'labels' });
    await runDerivedMigrations(sql, [m]);
    await runDerivedMigrations(sql, [m]);
    const onRows = await sql`
      SELECT 1 FROM pg_indexes
      WHERE schemaname = current_schema() AND tablename = 'rows' AND indexdef ILIKE '%gin%'`;
    expect(onRows).toHaveLength(0);
  });
});
