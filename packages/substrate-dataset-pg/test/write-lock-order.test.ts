/**
 * A batched upsert locks the stored rows it merges in id order, whatever the
 * batch's order, as patches, tombstones and the promotion backfill do. So two
 * batches over the same rows in opposite orders queue rather than deadlock.
 */

import { randomBytes } from 'node:crypto';
import { field } from '@mnmal-ai/substrate-sdk';
import type { FieldDef } from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgDataset } from '../src/index.js';
import { loadTypeTable } from '../src/type-table.js';
import { dropNamespace } from './_layout.js';

const POSTGRES_URL = process.env.POSTGRES_URL;

describe.skipIf(!POSTGRES_URL)('batched upsert lock order', () => {
  let sql: Sql;
  const ns = `wlo_${randomBytes(4).toString('hex')}`;
  const fields: Record<string, FieldDef> = { title: field.string() };

  beforeAll(() => {
    sql = postgres(POSTGRES_URL as string, { onnotice: () => {} });
  });
  afterAll(async () => {
    await dropNamespace(sql, ns);
    await sql.end({ timeout: 5 });
  });

  /** Resolves once a write statement is waiting on a lock. */
  async function batchWaits(): Promise<void> {
    const deadline = Date.now() + 10_000;
    for (;;) {
      // Scoped to this file's namespace, which the statement's literals carry.
      const [w] = await sql<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND query LIKE '%guard AS MATERIALIZED%'
          AND query LIKE ${`%${ns}%`} AND pid <> pg_backend_pid()`;
      if ((w?.n ?? 0) > 0) return;
      if (Date.now() > deadline) throw new Error('the batch never waited');
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  it('a batch [k2, k1] against a holder of k1 that then wants k2: both finish, no 40P01', async () => {
    const pg = new PgDataset({
      namespace: ns,
      sql,
      typeDefLookup: () => ({ fields }),
      fieldDefLookup: (_t, f) => fields[f]
    });
    // k2 first, so the heap order is k2, k1 as well as the batch's: input order
    // and a sequential scan would both lock k2 first.
    await pg.write('Note', [{ id: 'k2', title: 'b' }]);
    await pg.write('Note', [{ id: 'k1', title: 'a' }]);
    const table = (await loadTypeTable(sql, ns, 'Note'))?.from as string;
    const other = await sql.reserve();
    try {
      await other`BEGIN`;
      await other.unsafe(`SELECT 1 FROM ${table} WHERE id = 'k1' FOR NO KEY UPDATE`);
      const batch = pg.write('Note', [
        { id: 'k2', title: 'b2' },
        { id: 'k1', title: 'a2' }
      ]);
      batch.catch(() => undefined); // awaited below; a 40P01 would otherwise go unhandled first
      // Until the batch waits on k1: by then it holds k2 when it locks in input order.
      await batchWaits();
      // Locked in input order, the batch holds k2 and this deadlocks.
      await other.unsafe(`SELECT 1 FROM ${table} WHERE id = 'k2' FOR NO KEY UPDATE`);
      await other`COMMIT`;
      const done = await batch;
      expect(done.rows.map((r) => r.title)).toEqual(['b2', 'a2']);
    } finally {
      await other`ROLLBACK`.catch(() => undefined);
      other.release();
    }
  });

  it('two batches inserting the same new ids in opposite orders: both finish, no 40P01', async () => {
    const pg = new PgDataset({
      namespace: ns,
      sql,
      typeDefLookup: () => ({ fields }),
      fieldDefLookup: (_t, f) => fields[f]
    });
    let batch: Promise<unknown> | undefined;
    // A transaction's batches [n1] then [n2]; between them, the batch [n2, n1] starts.
    await pg.withTransaction(async (tx) => {
      await tx.write('Note', [{ id: 'n1', title: 'first' }]);
      batch = pg.write('Note', [
        { id: 'n2', title: 'b' },
        { id: 'n1', title: 'a' }
      ]);
      batch.catch(() => undefined); // awaited below; a 40P01 would otherwise go unhandled first
      // Inserting in input order, the batch has inserted n2 and waits on n1.
      await batchWaits();
      await tx.write('Note', [{ id: 'n2', title: 'second' }]);
    });
    await batch;
    const rows = await pg.read('Note', { ids: ['n1', 'n2'] });
    expect(rows.rows.map((r) => [r.id, r.title]).sort()).toEqual([
      ['n1', 'a'],
      ['n2', 'b']
    ]);
  });
});
