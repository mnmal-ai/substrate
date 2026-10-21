/**
 * 0002_uuid_format_check — focused test that exercises the gated UUID-format
 * CHECK constraint migration. The migration is opt-in at runtime (registered
 * only when SUBSTRATE_ENFORCE_UUID_CHECK=true); other tests don't enable the gate
 * because their fixtures use synthetic non-UUID id literals.
 *
 * This test runs the gated migration explicitly via getMigrationList(true)
 * and verifies the constraints reject non-UUID inserts and accept UUID-shape
 * inserts.
 *
 * Pg-gated: skipped unless POSTGRES_URL is set.
 */
import postgres, { type Sql } from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { checksum, getMigrationList, runMigrations } from '../src/migrate.js';

const POSTGRES_URL = process.env.POSTGRES_URL;

describe.skipIf(!POSTGRES_URL)('0002_uuid_format_check — gated CHECK constraints', () => {
  let sql: Sql;

  beforeAll(async () => {
    sql = postgres(POSTGRES_URL as string, { onnotice: () => {} });
  });

  afterAll(async () => {
    // Drop the constraints so other test files (which don't enable the gate)
    // aren't surprised by leftover state.
    await sql`ALTER TABLE rows DROP CONSTRAINT IF EXISTS rows_id_uuid_format`;
    await sql`ALTER TABLE short_ids DROP CONSTRAINT IF EXISTS short_ids_row_id_uuid_format`;
    await sql`ALTER TABLE edges DROP CONSTRAINT IF EXISTS edges_from_id_uuid_format`;
    await sql`ALTER TABLE edges DROP CONSTRAINT IF EXISTS edges_to_id_uuid_format`;
    // Remove 0002's tracking row so it can be re-applied by future test runs.
    await sql`DELETE FROM migrations WHERE version = '0002_uuid_format_check'`;
    await sql.end();
  });

  beforeEach(async () => {
    // Force-clean migrations + truncate so each test starts from a known state.
    await runMigrations(sql, { force: true });
    await sql`TRUNCATE TABLE rows, short_ids RESTART IDENTITY CASCADE`;
    await sql`TRUNCATE TABLE edges`;
  });

  afterEach(async () => {
    // Drop the constraints between tests so test-order doesn't matter and a
    // failed test doesn't leak constraint state into the next.
    await sql`ALTER TABLE rows DROP CONSTRAINT IF EXISTS rows_id_uuid_format`;
    await sql`ALTER TABLE short_ids DROP CONSTRAINT IF EXISTS short_ids_row_id_uuid_format`;
    await sql`ALTER TABLE edges DROP CONSTRAINT IF EXISTS edges_from_id_uuid_format`;
    await sql`ALTER TABLE edges DROP CONSTRAINT IF EXISTS edges_to_id_uuid_format`;
    await sql`DELETE FROM migrations WHERE version = '0002_uuid_format_check'`;
  });

  /**
   * Apply 0002 by hand — runMigrations checks the env var at runtime, but
   * we don't want to mutate process.env from a test. Use the exported
   * getMigrationList(true) directly.
   */
  async function applyUuidCheck(): Promise<void> {
    const list = getMigrationList(true);
    const uuidCheck = list.find((m) => m.version === '0002_uuid_format_check');
    if (uuidCheck === undefined) throw new Error('0002 not in gated list — test setup bug');
    await sql.begin(async (tx) => {
      for (const stmt of uuidCheck.txStatements) {
        await tx.unsafe(stmt);
      }
      await tx`
        INSERT INTO migrations (version, checksum)
        VALUES (${uuidCheck.version}, ${checksum(uuidCheck)})
      `;
    });
  }

  it('rejects INSERT with non-UUID rows.id', async () => {
    await applyUuidCheck();
    await expect(
      sql`INSERT INTO rows (namespace, type, id, body) VALUES ('default', 'Todo', 'not-a-uuid', '{}'::jsonb)`
    ).rejects.toThrow(/rows_id_uuid_format/);
  });

  it('accepts INSERT with UUID-shape rows.id', async () => {
    await applyUuidCheck();
    const goodId = '12345678-1234-1234-1234-123456789012';
    await sql`INSERT INTO rows (namespace, type, id, body) VALUES ('default', 'Todo', ${goodId}, '{}'::jsonb)`;
    const [row] = await sql<Array<{ id: string }>>`
      SELECT id FROM rows WHERE namespace = 'default' AND type = 'Todo'
    `;
    expect(row?.id).toBe(goodId);
  });

  it('rejects INSERT with non-UUID short_ids.row_id', async () => {
    await applyUuidCheck();
    // First seed a row to satisfy the FK.
    const goodId = '12345678-1234-1234-1234-123456789012';
    await sql`INSERT INTO rows (namespace, type, id, body) VALUES ('default', 'Todo', ${goodId}, '{}'::jsonb)`;
    // Now try to insert a sidecar with a non-UUID row_id (FK would also reject,
    // but the CHECK fires first as a same-row constraint).
    await expect(
      sql`INSERT INTO short_ids (namespace, type, short_id, row_id) VALUES ('default', 'Todo', 1, 'not-a-uuid')`
    ).rejects.toThrow(/short_ids_row_id_uuid_format/);
  });

  it('rejects INSERT with non-UUID edges.from_id', async () => {
    await applyUuidCheck();
    const edgeId = '00000000-0000-0000-0000-000000000001';
    await expect(
      sql`
        INSERT INTO edges (id, from_ns, from_type, from_id, to_ns, to_type, to_id, field_name, policy, created_at)
        VALUES (${edgeId}, 'default', 'Todo', 'not-a-uuid',
                'default', 'Tag', '12345678-1234-1234-1234-123456789012',
                'todoId', 'set_null', now())
      `
    ).rejects.toThrow(/edges_from_id_uuid_format/);
  });

  it('rejects INSERT with non-UUID edges.to_id', async () => {
    await applyUuidCheck();
    const edgeId = '00000000-0000-0000-0000-000000000002';
    await expect(
      sql`
        INSERT INTO edges (id, from_ns, from_type, from_id, to_ns, to_type, to_id, field_name, policy, created_at)
        VALUES (${edgeId}, 'default', 'Todo', '12345678-1234-1234-1234-123456789012',
                'default', 'Tag', 'not-a-uuid',
                'todoId', 'set_null', now())
      `
    ).rejects.toThrow(/edges_to_id_uuid_format/);
  });

  it('is idempotent — applying twice does not error', async () => {
    await applyUuidCheck();
    // Reset tracking + reapply: constraints already exist, DO blocks swallow
    // duplicate_object so no error.
    await sql`DELETE FROM migrations WHERE version = '0002_uuid_format_check'`;
    await applyUuidCheck();

    // Constraints still in place — non-UUID id still rejected.
    await expect(
      sql`INSERT INTO rows (namespace, type, id, body) VALUES ('default', 'Tag', 'not-a-uuid', '{}'::jsonb)`
    ).rejects.toThrow(/rows_id_uuid_format/);
  });

  it('default getMigrationList() (gate off) does not include 0002', () => {
    const list = getMigrationList(false);
    const versions = list.map((m) => m.version);
    expect(versions).not.toContain('0002_uuid_format_check');
  });

  it('getMigrationList(true) includes 0002', () => {
    const list = getMigrationList(true);
    const versions = list.map((m) => m.version);
    expect(versions).toContain('0002_uuid_format_check');
  });
});
