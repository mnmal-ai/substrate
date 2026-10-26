/**
 * Row ids the database assigns with `uuidv7()` when a write omits `id`.
 * The memory twin is substrate-dataset-memory/test/uuidv7.test.ts.
 */
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PgDataset, runMigrations } from '../src/index.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const NS = 'test_uuidv7_ids';
const V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe.skipIf(!POSTGRES_URL)('uuidv7 ids (pg)', () => {
  let sql: Sql;
  let ds: PgDataset;

  beforeAll(async () => {
    // One connection, so the database's per-connection monotonicity applies.
    sql = postgres(POSTGRES_URL as string, { max: 1, onnotice: () => {} });
    await runMigrations(sql);
    ds = new PgDataset({ namespace: NS, sql });
  });

  afterAll(async () => {
    await sql.end();
  });

  beforeEach(async () => {
    await sql`DELETE FROM rows WHERE namespace = ${NS}`;
  });

  it('an id-less create gets a version-7 UUID from the database', async () => {
    const { ids, rows, written } = await ds.write('Todo', [{ title: 'a' }], { insertOnly: true });
    expect(written).toBe(1);
    expect(ids[0]).toMatch(V7);
    expect(rows[0]?.id).toBe(ids[0]);
    expect(rows[0]?.title).toBe('a');
    const { rows: read } = await ds.read('Todo', { id: String(ids[0]) });
    expect(read[0]?.title).toBe('a');
  });

  it('ids created in sequence on one connection sort in creation order', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 50; i++) {
      const { ids: one } = await ds.write('Todo', [{ n: i }]);
      ids.push(String(one[0]));
    }
    const { ids: batch } = await ds.write(
      'Todo',
      Array.from({ length: 50 }, (_, i) => ({ n: 50 + i }))
    );
    ids.push(...batch.map(String));
    for (const id of ids) expect(id).toMatch(V7);
    expect([...ids].sort()).toEqual(ids);
  });

  it('a client-supplied id is kept verbatim', async () => {
    const given = '00000000-0000-4000-8000-000000000001';
    const { ids } = await ds.write('Todo', [
      { id: given, title: 'g' },
      { id: 7, title: 'n' }
    ]);
    expect(ids).toEqual([given, 7]);
    const { rows } = await ds.read('Todo', { id: given });
    expect(rows[0]?.title).toBe('g');
  });

  it('a batch mixing supplied and omitted ids returns them in input order', async () => {
    const { ids, rows } = await ds.write('Todo', [
      { title: 'a' },
      { id: 'given', title: 'b' },
      { title: 'c' }
    ]);
    expect(ids).toHaveLength(3);
    expect(ids[0]).toMatch(V7);
    expect(ids[1]).toBe('given');
    expect(ids[2]).toMatch(V7);
    expect(rows.map((r) => r.title)).toEqual(['a', 'b', 'c']);
  });

  it('a supplied id repeated in one insertOnly batch lands once, first occurrence wins', async () => {
    const { ids, rows, written } = await ds.write(
      'Todo',
      [{ id: 'dup', title: 'first' }, { title: 'x' }, { id: 'dup', title: 'second' }],
      { insertOnly: true }
    );
    expect(written).toBe(2);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe('dup');
    expect(ids[1]).toMatch(V7);
    expect(rows[0]?.title).toBe('first');
  });

  it('a supplied id repeated in one upsert batch is refused and writes nothing', async () => {
    await expect(
      ds.write('Todo', [{ id: 'dup', title: 'a' }, { title: 'x' }, { id: 'dup', title: 'b' }])
    ).rejects.toThrow(/id 'dup' appears twice in one batch/);
    const { rows } = await ds.read('Todo', {});
    expect(rows).toHaveLength(0);
  });
});
