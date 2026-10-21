/**
 * PgDataset — dropType + dropNamespace integration tests.
 *
 * Requires POSTGRES_URL in the environment — skips when absent.
 * Cleanup is scoped to the `test_pg_drop` namespace so these tests can
 * run safely against a shared dev database without touching other data.
 */

import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PgDataset, runMigrations } from '../src/index.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const TEST_NS = 'test_pg_drop';

describe.skipIf(!POSTGRES_URL)('PgDataset drop primitives', () => {
  let sql: Sql;
  let ds: PgDataset;

  beforeAll(async () => {
    sql = postgres(POSTGRES_URL as string, { onnotice: () => {} });
    await runMigrations(sql);
  });

  afterAll(async () => {
    await sql.end();
  });

  beforeEach(async () => {
    // Scope cleanup to the test namespace only.
    await sql`DELETE FROM rows      WHERE namespace = ${TEST_NS}`;
    await sql`DELETE FROM short_ids WHERE namespace = ${TEST_NS}`;
    ds = new PgDataset({ namespace: TEST_NS, sql });
  });

  // ---------------------------------------------------------------------------
  // 1. dropType removes rows of target type, leaves other types intact
  // ---------------------------------------------------------------------------
  it('dropType removes rows of target type and leaves other types intact', async () => {
    await ds.write('Alpha', [
      { id: 'a1', v: 1 },
      { id: 'a2', v: 2 }
    ]);
    await ds.write('Beta', [{ id: 'b1', v: 3 }]);

    const result = await ds.dropType('Alpha');

    expect(result.rowsDeleted).toBe(2);

    // Alpha rows are gone.
    const alphaRows = await sql<{ id: string }[]>`
      SELECT id FROM rows
      WHERE namespace = ${TEST_NS} AND type = 'Alpha'
    `;
    expect(alphaRows).toHaveLength(0);

    // Beta row is untouched.
    const betaRows = await sql<{ id: string }[]>`
      SELECT id FROM rows
      WHERE namespace = ${TEST_NS} AND type = 'Beta'
    `;
    expect(betaRows).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // 2. dropType removes short-id rows for that type
  // ---------------------------------------------------------------------------
  it('dropType removes short-id entries for the dropped type', async () => {
    await ds.write('Alpha', [{ id: 'a1', v: 1 }]);
    // Allocate and bind a short id so a row exists in short_ids.
    const shortId = await ds.allocateShortId('Alpha');
    await ds.bindShortId('Alpha', shortId, 'a1');

    // Confirm the short-id row exists before drop.
    const before = await sql<{ short_id: number }[]>`
      SELECT short_id FROM short_ids
      WHERE namespace = ${TEST_NS} AND type = 'Alpha'
    `;
    expect(before).toHaveLength(1);

    // The short-id FK's ON DELETE CASCADE removes the short-id row with its
    // source row, so dropType's explicit cleanup pass finds nothing
    // (shortIdsDeleted is 0). The contract is no orphan short-ids.
    const result = await ds.dropType('Alpha');
    expect(result.rowsDeleted).toBe(1);

    // Short-id row is gone (via FK cascade).
    const after = await sql<{ short_id: number }[]>`
      SELECT short_id FROM short_ids
      WHERE namespace = ${TEST_NS} AND type = 'Alpha'
    `;
    expect(after).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // 3. dropType returns zeros for an empty type
  // ---------------------------------------------------------------------------
  it('dropType returns { rowsDeleted: 0, shortIdsDeleted: 0 } for a type with no rows', async () => {
    const result = await ds.dropType('NonExistent');
    expect(result).toEqual({ rowsDeleted: 0, shortIdsDeleted: 0 });
  });

  // ---------------------------------------------------------------------------
  // 4. dropType removes tombstoned rows (deleted_at IS NOT NULL)
  // ---------------------------------------------------------------------------
  it('dropType hard-deletes tombstoned rows', async () => {
    await ds.write('Alpha', [{ id: 'a1', v: 1 }]);
    await ds.tombstone('Alpha', ['a1']);

    // Verify the tombstone is there (deleted_at IS NOT NULL) before drop.
    const tombstoned = await sql<{ id: string; deleted_at: Date | null }[]>`
      SELECT id, deleted_at FROM rows
      WHERE namespace = ${TEST_NS} AND type = 'Alpha' AND id = 'a1'
    `;
    expect(tombstoned).toHaveLength(1);
    expect(tombstoned[0]?.deleted_at).not.toBeNull();

    const result = await ds.dropType('Alpha');
    expect(result.rowsDeleted).toBe(1);

    // Row is gone from the table entirely.
    const after = await sql<{ id: string }[]>`
      SELECT id FROM rows
      WHERE namespace = ${TEST_NS} AND type = 'Alpha'
    `;
    expect(after).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // 5. dropNamespace removes all rows + short-ids across every type
  // ---------------------------------------------------------------------------
  it('dropNamespace removes all rows and short-ids across all types', async () => {
    await ds.write('Alpha', [
      { id: 'a1', v: 1 },
      { id: 'a2', v: 2 }
    ]);
    await ds.write('Beta', [{ id: 'b1', v: 3 }]);

    const sid = await ds.allocateShortId('Alpha');
    await ds.bindShortId('Alpha', sid, 'a1');

    // The short-id FK cascade removes short-ids with their rows, so
    // dropNamespace's explicit cleanup finds zero. The contract is the end
    // state: zero rows and zero short-ids in the namespace.
    const result = await ds.dropNamespace();
    expect(result.rowsDeleted).toBe(3);

    const rows = await sql<{ id: string }[]>`
      SELECT id FROM rows WHERE namespace = ${TEST_NS}
    `;
    expect(rows).toHaveLength(0);

    const shortIds = await sql<{ short_id: number }[]>`
      SELECT short_id FROM short_ids WHERE namespace = ${TEST_NS}
    `;
    expect(shortIds).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // 6. dropNamespace rollback inside withTransaction restores state
  // ---------------------------------------------------------------------------
  it('dropNamespace rolls back when the transaction throws', async () => {
    // Write a row BEFORE the transaction so it's committed.
    await ds.write('Alpha', [{ id: 'a1', v: 1 }]);

    // Drop inside a tx that then throws.
    await expect(
      ds.withTransaction(async (tx) => {
        await tx.dropNamespace();
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    // Row must still be present after the rolled-back transaction.
    const rows = await sql<{ id: string }[]>`
      SELECT id FROM rows
      WHERE namespace = ${TEST_NS} AND type = 'Alpha' AND id = 'a1'
    `;
    expect(rows).toHaveLength(1);
  });
});
