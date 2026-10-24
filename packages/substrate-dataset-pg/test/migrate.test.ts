/**
 * runMigrations — versioned migration framework + idempotency integration
 * tests.
 *
 * Requires POSTGRES_URL in the environment — skips when absent.
 * Verifies that:
 *   - The framework records applied migrations in `migrations`.
 *   - Re-runs skip already-applied migrations (tracking-table driven).
 *   - `force: true` clears tracking and re-applies.
 *   - Checksum mismatch on a previously-applied migration is rehashed with a
 *     warning.
 *   - Every migration's statements are safe to run more than once
 *     (CREATE-IF-NOT-EXISTS / DO-EXCEPTION-WHEN-duplicate-object).
 */

import postgres, { type Sql } from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MigrationChecksumDriftError, runMigrations } from '../src/index.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const BASELINE =
  process.env.SUBSTRATE_STORAGE_LAYOUT === 'partitioned'
    ? '0001p_partitioned_baseline'
    : '0001_baseline';

describe.skipIf(!POSTGRES_URL)('runMigrations idempotency', () => {
  let sql: Sql;

  beforeAll(async () => {
    sql = postgres(POSTGRES_URL as string, { onnotice: () => {} });
    await runMigrations(sql);
  });

  afterAll(async () => {
    await sql.end();
  });

  it('baseline is idempotent and creates only the engine tables', async () => {
    // Second call — must not throw.
    await runMigrations(sql);

    const tables = await sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = current_schema()
        AND table_name IN ('rows', 'edges', 'idempotency', 'short_ids')
    `;
    expect(tables.map((t) => t.table_name).sort()).toEqual([
      'edges',
      'idempotency',
      'rows',
      'short_ids'
    ]);
  });
});

describe.skipIf(!POSTGRES_URL)('edges.policy CHECK constraint', () => {
  let sql: Sql;

  beforeEach(async () => {
    sql = postgres(POSTGRES_URL as string, { onnotice: () => {} });
    await sql`DROP TABLE IF EXISTS edges CASCADE`;
    // `force: true` drops the migration-tracking table so the framework
    // re-applies every migration on this call, recreating edges.
    await runMigrations(sql, { force: true });
  });

  afterEach(async () => {
    await sql.end();
  });

  it('CHECK constraint exists with the four valid policy values', async () => {
    const constraints = await sql<{ conname: string; pg_get_constraintdef: string }[]>`
      SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
      WHERE conrelid = 'edges'::regclass
        AND contype = 'c'
        AND conname = 'edges_policy_check'
    `;
    expect(constraints).toHaveLength(1);
    const def = constraints[0]?.pg_get_constraintdef ?? '';
    for (const policy of ['set_null', 'cascade', 'restrict', 'orphan']) {
      expect(def).toContain(policy);
    }
  });

  it('rejects INSERT with invalid policy value', async () => {
    await expect(
      sql`
        INSERT INTO edges (id, from_ns, from_type, from_id,
          to_ns, to_type, to_id, field_name, policy, created_at)
        VALUES ('00000000-0000-0000-0000-0000000000bd', 'a', 'A', '1', 'b', 'B', '2',
          'fieldX', 'BOGUS_POLICY', now())
      `
    ).rejects.toThrow();
  });

  it('accepts INSERT with each valid policy value', async () => {
    // Hardcoded UUIDs per policy keep the ORDER BY assertion below stable
    // (edges.id is a native uuid).
    const POLICY_IDS = {
      set_null: '00000000-0000-0000-0000-000000000001',
      cascade: '00000000-0000-0000-0000-000000000002',
      restrict: '00000000-0000-0000-0000-000000000003',
      orphan: '00000000-0000-0000-0000-000000000004'
    } as const;
    // Use a distinct to_id per iteration so each row has a unique
    // logical-identity tuple (the baseline's partial-UNIQUE index would
    // otherwise reject the second row regardless of policy).
    let i = 0;
    for (const policy of ['set_null', 'cascade', 'restrict', 'orphan'] as const) {
      const toId = String(2 + i++);
      await sql`
        INSERT INTO edges (id, from_ns, from_type, from_id,
          to_ns, to_type, to_id, field_name, policy, created_at)
        VALUES (${POLICY_IDS[policy]}, 'a', 'A', '1', 'b', 'B', ${toId},
          'fieldX', ${policy}, now())
      `;
    }
    const rows = await sql<{ id: string }[]>`
      SELECT id FROM edges
      WHERE id IN (${POLICY_IDS.set_null}, ${POLICY_IDS.cascade},
                   ${POLICY_IDS.restrict}, ${POLICY_IDS.orphan})
      ORDER BY id
    `;
    expect(rows.map((r) => r.id)).toEqual([
      POLICY_IDS.set_null,
      POLICY_IDS.cascade,
      POLICY_IDS.restrict,
      POLICY_IDS.orphan
    ]);
  });

  it('CHECK is idempotent — runMigrations a second time does not duplicate it', async () => {
    await runMigrations(sql);
    const constraints = await sql<{ conname: string }[]>`
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'edges'::regclass
        AND contype = 'c'
        AND conname = 'edges_policy_check'
    `;
    expect(constraints).toHaveLength(1);
  });
});

describe.skipIf(!POSTGRES_URL)('migration framework — tracking + force', () => {
  let sql: Sql;

  beforeEach(async () => {
    sql = postgres(POSTGRES_URL as string, { onnotice: () => {} });
    // Start each test with a clean tracking state. Force the first run
    // so the framework re-applies regardless of prior test state.
    await runMigrations(sql, { force: true });
  });

  afterEach(async () => {
    // Restore clean checksum state — the drift tests below tamper with
    // migrations, and the table is shared across parallel vitest
    // files (force: true clears tracking and re-applies).
    await runMigrations(sql, { force: true });
    await sql.end();
  });

  it('records applied migrations in migrations with version + checksum', async () => {
    const rows = await sql<{ version: string; checksum: string }[]>`
      SELECT version, checksum FROM migrations ORDER BY version
    `;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const initial = rows.find((r) => r.version === BASELINE);
    expect(initial).toBeDefined();
    expect(initial?.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('re-run skips already-applied migrations (tracking timestamps unchanged)', async () => {
    const before = await sql<{ applied_at: Date }[]>`
      SELECT applied_at FROM migrations WHERE version = ${BASELINE}
    `;
    expect(before).toHaveLength(1);
    const beforeTs = before[0]?.applied_at.getTime();

    // Wait a tick so any re-application would produce a different timestamp.
    await new Promise((r) => setTimeout(r, 20));

    await runMigrations(sql); // no force — should be a no-op

    const after = await sql<{ applied_at: Date }[]>`
      SELECT applied_at FROM migrations WHERE version = ${BASELINE}
    `;
    expect(after).toHaveLength(1);
    expect(after[0]?.applied_at.getTime()).toBe(beforeTs);
  });

  it('force: true clears tracking and re-applies (timestamp advances)', async () => {
    const before = await sql<{ applied_at: Date }[]>`
      SELECT applied_at FROM migrations WHERE version = ${BASELINE}
    `;
    const beforeTs = before[0]?.applied_at.getTime() ?? 0;

    await new Promise((r) => setTimeout(r, 20));

    await runMigrations(sql, { force: true });

    const after = await sql<{ applied_at: Date }[]>`
      SELECT applied_at FROM migrations WHERE version = ${BASELINE}
    `;
    expect(after).toHaveLength(1);
    expect(after[0]?.applied_at.getTime()).toBeGreaterThan(beforeTs);
  });

  it('checksum mismatch (legacy / tampered) is silently rehashed by the runner', async () => {
    // A tampered checksum stands in for either a hash-format change or a
    // post-ship migration edit; the runner cannot tell them apart. It
    // rewrites the recorded value and emits a WARN on stderr, which is how
    // an operator spots an edited migration.
    await sql`
      UPDATE migrations
      SET checksum = 'legacy_checksum_value_94ae4a84'
      WHERE version = ${BASELINE}
    `;

    const stderrChunks: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    // biome-ignore lint/suspicious/noExplicitAny: capturing stderr writes
    process.stderr.write = ((chunk: any) => {
      stderrChunks.push(typeof chunk === 'string' ? chunk : String(chunk));
      return true;
    }) as typeof process.stderr.write;

    try {
      // Must NOT throw — rehash absorbs the mismatch.
      await runMigrations(sql);
    } finally {
      process.stderr.write = origWrite;
    }

    // The recorded row is now at the current (post-rehash) checksum.
    const after = await sql<{ checksum: string }[]>`
      SELECT checksum FROM migrations WHERE version = ${BASELINE}
    `;
    expect(after[0]?.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(after[0]?.checksum).not.toBe('legacy_checksum_value_94ae4a84');

    // WARN log fired on stderr naming version + both truncated checksums.
    const log = stderrChunks.join('');
    expect(log).toContain('rehash');
    expect(log).toContain(BASELINE);
    expect(log).toContain('legacy_check'); // first 12 chars of seeded legacy value
  });

  it('MigrationChecksumDriftError class is still exported for callers that detect drift outside the runner', () => {
    // The runner no longer throws it, but the class stays exported for
    // callers that detect drift through another channel.
    const err = new MigrationChecksumDriftError('0001_baseline', 'recorded_value', 'current_value');
    expect(err.name).toBe('MigrationChecksumDriftError');
    expect(err.version).toBe('0001_baseline');
    expect(err.recordedChecksum).toBe('recorded_value');
    expect(err.currentChecksum).toBe('current_value');
    expect(err.message).toContain('0001_baseline');
  });
});

describe('MigrationChecksumDriftError message', () => {
  it('names the supported remedy, not an env var nothing reads', () => {
    const err = new MigrationChecksumDriftError('0001_baseline', 'recorded', 'current');
    expect(err.message).not.toContain('SUBSTRATE_MIGRATIONS_ALLOW_DRIFT');
    expect(err.message).toContain('runMigrations');
    expect(err.message).toContain('migrations_audit');
  });
});
