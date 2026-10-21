/**
 * PgShortIdStore integration tests.
 *
 * Requires POSTGRES_URL in the environment — skips the whole describe block
 * when absent (matches the pattern used by the rest of the pg suite).
 *
 * Cleanup is scoped to the test-only namespaces `tpgsi_a` and `tpgsi_b`.
 * `seqName` rejects leading/trailing/adjacent underscores, so test
 * namespaces must honour that too.
 */

import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/migrate.js';
import { PgShortIdStore } from '../src/pg-short-id-store.js';

const POSTGRES_URL = process.env.POSTGRES_URL;

const TEST_NS_A = 'tpgsi_a';
const TEST_NS_B = 'tpgsi_b';

describe.skipIf(!POSTGRES_URL)('PgShortIdStore', () => {
  let sql: Sql;
  let store: PgShortIdStore;

  beforeAll(async () => {
    sql = postgres(POSTGRES_URL as string, { onnotice: () => {} });
    await runMigrations(sql);
  });

  afterAll(async () => {
    await sql.end();
  });

  beforeEach(async () => {
    // Scope cleanup to test namespaces — don't touch real data. Migration
    // 0010 adds an FK from short_ids -> rows ON DELETE CASCADE,
    // so deleting rows here also clears the matching short-id rows.
    // short_ids is also cleared directly, for explicitness.
    await sql`
      DELETE FROM rows
      WHERE namespace IN (${TEST_NS_A}, ${TEST_NS_B})
    `;
    await sql`
      DELETE FROM short_ids
      WHERE namespace IN (${TEST_NS_A}, ${TEST_NS_B})
    `;
    // Drop test sequences so counters reset between tests.
    const seqs = await sql<Array<{ sequencename: string }>>`
      SELECT sequencename FROM pg_sequences
      WHERE sequencename LIKE 'tpgsi_%_short_id_seq'
    `;
    for (const { sequencename } of seqs) {
      await sql.unsafe(`DROP SEQUENCE IF EXISTS "${sequencename}"`);
    }
    store = new PgShortIdStore(sql);
  });

  /**
   * Seed a placeholder rows row so a subsequent short-id bind can
   * satisfy the composite FK installed by migration 0010. Body is a minimal
   * empty jsonb — these unit tests exercise the short-id store in isolation
   * and don't care about row contents.
   */
  async function seedRow(ns: string, type: string, id: string): Promise<void> {
    await sql`
      INSERT INTO rows (namespace, type, id, body)
      VALUES (${ns}, ${type}, ${id}, '{}'::jsonb)
      ON CONFLICT (namespace, type, id) DO NOTHING
    `;
  }

  it('allocates monotonic ids per (ns, type) via postgres sequence', async () => {
    expect(await store.allocateUnbound(TEST_NS_A, 'Todo')).toBe(1);
    expect(await store.allocateUnbound(TEST_NS_A, 'Todo')).toBe(2);
    expect(await store.allocateUnbound(TEST_NS_A, 'Decision')).toBe(1);
    expect(await store.allocateUnbound(TEST_NS_B, 'Observation')).toBe(1);
  });

  it('persists the mapping after bind()', async () => {
    await seedRow(TEST_NS_A, 'Todo', 'uuid-a');
    const short = await store.allocateUnbound(TEST_NS_A, 'Todo');
    await store.bind(TEST_NS_A, 'Todo', short, 'uuid-a');
    expect(await store.resolveShortId(TEST_NS_A, 'Todo', short)).toBe('uuid-a');
    expect(await store.getShortIdForRow(TEST_NS_A, 'Todo', 'uuid-a')).toBe(short);
  });

  it('returns null on unknown lookups', async () => {
    expect(await store.resolveShortId(TEST_NS_A, 'Todo', 999)).toBeNull();
    expect(await store.getShortIdForRow(TEST_NS_A, 'Todo', 'nope')).toBeNull();
  });

  it('allocate() composes allocateUnbound + bind', async () => {
    await seedRow(TEST_NS_A, 'Todo', 'uuid-a');
    const short = await store.allocate(TEST_NS_A, 'Todo', 'uuid-a');
    expect(await store.resolveShortId(TEST_NS_A, 'Todo', short)).toBe('uuid-a');
  });

  it('preload inserts rows and sets sequence start past the max', async () => {
    await seedRow(TEST_NS_A, 'Todo', '1052');
    await seedRow(TEST_NS_A, 'Todo', '828');
    await store.preload(TEST_NS_A, 'Todo', [
      { shortId: 1052, rowId: '1052' },
      { shortId: 828, rowId: '828' }
    ]);
    expect(await store.resolveShortId(TEST_NS_A, 'Todo', 1052)).toBe('1052');
    expect(await store.allocateUnbound(TEST_NS_A, 'Todo')).toBe(1053);
  });

  it('preload is idempotent (ON CONFLICT DO NOTHING)', async () => {
    await seedRow(TEST_NS_A, 'Todo', 'a');
    await store.preload(TEST_NS_A, 'Todo', [{ shortId: 1, rowId: 'a' }]);
    await store.preload(TEST_NS_A, 'Todo', [{ shortId: 1, rowId: 'a' }]);
    expect(await store.resolveShortId(TEST_NS_A, 'Todo', 1)).toBe('a');
  });
});
