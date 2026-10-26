/**
 * PgDataset — dropType + dropNamespace integration tests.
 *
 * Requires POSTGRES_URL in the environment — skips when absent.
 * Cleanup is scoped to the `test_pg_drop` namespace so these tests can
 * run safely against a shared dev database without touching other data.
 */

import { randomBytes } from 'node:crypto';
import type { FieldDef } from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PgDataset, runMigrations, type StorageLayout, typeIndexesOf } from '../src/index.js';
import { generatedIdentifier } from '../src/migrate.js';
import type { TypeDefLookup } from '../src/pg-dataset.js';

type TypeDef = NonNullable<ReturnType<TypeDefLookup>>;

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

describe.skipIf(!POSTGRES_URL)('engine indexes of a dropped namespace', () => {
  const LAYOUT = (process.env.SUBSTRATE_STORAGE_LAYOUT ?? 'legacy') as StorageLayout;
  const ref: FieldDef = { kind: 'crossRef', ns: 'other', type: 'X', onDelete: 'set_null' };
  let sql: Sql;

  beforeAll(async () => {
    sql = postgres(POSTGRES_URL as string, { onnotice: () => {} });
  });

  afterAll(async () => {
    await sql.end();
  });

  /**
   * A namespace whose types T (with a unique index) and U are built with their
   * engine indexes. `ds`'s lookup knows only the types `known` keeps.
   */
  async function namespaceWithIndexes(known: (type: string) => boolean = () => true) {
    const ns = `dropidx_${randomBytes(4).toString('hex')}`;
    const unique = generatedIdentifier(ns, 'T', 'kid', 'uniq');
    const defs: Record<string, TypeDef> = {
      T: {
        fields: { ref, kid: { kind: 'scalar', type: 'string' } },
        indexes: [{ fields: ['kid'], unique: true }]
      },
      U: { fields: { ref } }
    };
    const lookup = (only: (type: string) => boolean) => (type: string, namespace: string) =>
      namespace === ns && only(type) ? defs[type] : undefined;
    const builder = new PgDataset({ namespace: ns, sql, typeDefLookup: lookup(() => true) });
    for (const type of ['T', 'U']) {
      await builder.write(type, [{ kid: randomBytes(4).toString('hex') }]);
      await builder.ensureTypeStorage(type);
    }
    const ds = new PgDataset({ namespace: ns, sql, typeDefLookup: lookup(known) });
    const engineIndexes = async (type: string) =>
      (await typeIndexesOf(sql, ns, type, LAYOUT)).filter((i) => i.engineOwned).map((i) => i.name);
    return { ns, ds, unique, engineIndexes };
  }

  it('drops every engine index of the namespace, unique ones too, and no other namespace', async () => {
    const a = await namespaceWithIndexes();
    const b = await namespaceWithIndexes();
    const before = [...(await a.engineIndexes('T')), ...(await a.engineIndexes('U'))];
    expect(before).toContain(a.unique);
    const kept = await b.engineIndexes('T');

    await a.ds.withTransaction((tx) => tx.dropNamespace());
    expect((await a.ds.dropNamespaceIndexes()).sort()).toEqual(before.sort());

    expect(await a.engineIndexes('T')).toEqual([]);
    expect(await a.engineIndexes('U')).toEqual([]);
    expect(await b.engineIndexes('T')).toEqual(kept);
    expect(await a.ds.dropNamespaceIndexes()).toEqual([]);
    // Four types' concurrent builds on the shared legacy rows, then the drops.
  }, 120_000);

  it('refuses on a tx-bound instance', async () => {
    const { ds } = await namespaceWithIndexes();
    await expect(ds.withTransaction(async (tx) => tx.dropNamespaceIndexes?.())).rejects.toThrow(
      /tx-bound/
    );
  });

  it('lists an orphaned engine index in storageReport, and a signed remove drops it', async () => {
    // U is no longer registered: its indexes are orphans.
    const { ns, ds, engineIndexes } = await namespaceWithIndexes((type) => type !== 'U');
    const [orphan] = await engineIndexes('U');
    expect(orphan).toBeDefined();
    const { info, warnings } = await ds.storageReport({ partitionBudget: 1e6 });
    expect(info).toContain(
      `orphaned index ${orphan} on ${ns}/U: no registered type owns it; a signed propose_index remove drops it`
    );
    expect(warnings.filter((w) => w.includes(ns))).toEqual([]);

    await ds.dropEngineIndex('U', orphan as string);
    expect(await engineIndexes('U')).not.toContain(orphan);
    // A registered type's index is still refused.
    const [wanted] = (await engineIndexes('T')).filter((n) => n.endsWith('_idx'));
    await expect(ds.dropEngineIndex('T', wanted as string)).rejects.toMatchObject({
      code: 'still_desired'
    });
  });
});
