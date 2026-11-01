/**
 * Holds MemoryDataset and PgDataset to the same batch primitives:
 * short-id ranges, set-wise short-id resolution and the multi-row patch.
 *
 * Each pg primitive is one statement whatever the batch size, so the pg half
 * also counts the statements a call sends, and checks an empty call sends none.
 */

import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import type { Dataset } from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PgDataset } from '../src/index.js';
import { addTestPromotedColumns, dropTestPromotedColumns, TEST_PROMOTED } from './_promoted.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const PARTITIONED = process.env.SUBSTRATE_TEST_LAYOUT === 'partitioned';
const NS = 'batch_prim';
const NOW = new Date('2026-11-01T12:00:00.000Z');
const ACTOR = { kind: 'agent', id: 'tester' } as const;

describe.skipIf(!POSTGRES_URL)('batch primitives (memory vs pg)', () => {
  let sql: Sql;
  let statements: string[];
  let datasets: Array<[string, Dataset]>;

  beforeAll(async () => {
    sql = postgres(POSTGRES_URL as string, {
      onnotice: () => {},
      debug: (_conn, query) => {
        statements.push(query);
      }
    });
    statements = [];
    await addTestPromotedColumns(sql);
  });

  afterAll(async () => {
    await dropTestPromotedColumns(sql);
    await sql.end();
  });

  beforeEach(async () => {
    await sql`DELETE FROM rows WHERE namespace = ${NS}`;
    const pg = new PgDataset({ namespace: NS, sql, promotedColumns: TEST_PROMOTED });
    if (PARTITIONED) await pg.ensureTypeStorage('Item');
    datasets = [
      ['memory', new MemoryDataset({ namespace: NS })],
      ['pg', pg]
    ];
  });

  const each = (fn: (name: string, ds: Dataset) => Promise<void>) => async () => {
    for (const [name, ds] of datasets) await fn(name, ds);
  };

  /** Statements `fn` sends on pg, excluding the transaction and savepoint plumbing. */
  async function sent(fn: () => Promise<unknown>): Promise<string[]> {
    statements = [];
    await fn();
    return statements.filter((s) => !/^(begin|commit|rollback|savepoint|release)/i.test(s.trim()));
  }

  it(
    'allocateShortIds returns count distinct ascending ids above the last single allocation',
    each(async (_n, ds) => {
      const first = await ds.allocateShortId('Item');
      const ids = await ds.allocateShortIds('Item', 5);
      expect(ids).toHaveLength(5);
      expect(new Set(ids).size).toBe(5);
      expect(ids).toEqual([...ids].sort((a, b) => a - b));
      expect(ids[0]).toBeGreaterThan(first);
      expect(await ds.allocateShortId('Item')).toBeGreaterThan(ids[4] as number);
    })
  );

  it(
    'bindShortIds then resolveShortId resolves each',
    each(async (_n, ds) => {
      await ds.write('Item', [{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
      const ids = await ds.allocateShortIds('Item', 3);
      await ds.bindShortIds(
        'Item',
        ['a', 'b', 'c'].map((rowId, i) => ({ shortId: ids[i] as number, rowId }))
      );
      for (const [i, rowId] of ['a', 'b', 'c'].entries()) {
        expect(await ds.resolveShortId('Item', ids[i] as number)).toBe(rowId);
        expect(await ds.getShortIdForRow('Item', rowId)).toBe(ids[i]);
      }
    })
  );

  it(
    'resolveShortIds equals resolveShortId per id; a tombstoned row is absent, repeats are deduped',
    each(async (_n, ds) => {
      await ds.write('Item', [{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
      const ids = await ds.allocateShortIds('Item', 3);
      await ds.bindShortIds(
        'Item',
        ['a', 'b', 'c'].map((rowId, i) => ({ shortId: ids[i] as number, rowId }))
      );
      await ds.tombstone('Item', ['b']);
      const unbound = 9999;
      const asked = [ids[0], ids[1], ids[2], ids[0], unbound] as number[];
      const got = await ds.resolveShortIds('Item', asked);
      expect([...got.entries()].sort((x, y) => x[0] - y[0])).toEqual([
        [ids[0], 'a'],
        [ids[2], 'c']
      ]);
      for (const id of [ids[0], ids[2], unbound] as number[]) {
        expect(got.get(id) ?? null).toBe(await ds.resolveShortId('Item', id));
      }
    })
  );

  it(
    'patchRows merges like update: absent keeps, null clears; one entry per patch in order',
    each(async (_n, ds) => {
      await ds.write('Item', [
        { id: 'a', t: 'one', f: 'x', keep: 1 },
        { id: 'b', t: 'two', f: 'y', keep: 2 }
      ]);
      const out = await ds.patchRows(
        'Item',
        [
          { id: 'b', patch: { t: 'TWO', f: null } },
          { id: 'a', patch: { t: 'ONE' } }
        ],
        ACTOR,
        NOW
      );
      expect(out.map((r) => r?.id)).toEqual(['b', 'a']);
      const [b, a] = out as unknown as [Record<string, unknown>, Record<string, unknown>];
      expect(a).toMatchObject({ t: 'ONE', f: 'x', keep: 1 });
      expect(b).toMatchObject({ t: 'TWO', keep: 2 });
      expect(b.f ?? null).toBeNull();
      // Stored, and stamped like conditionalUpdate.
      const { rows } = await ds.read('Item', { orderBy: [{ id: 'asc' }] });
      expect(rows.map((r) => [r.id, r.t])).toEqual([
        ['a', 'ONE'],
        ['b', 'TWO']
      ]);
      expect(rows[0]?._metadata).toMatchObject({ updatedBy: ACTOR });
      expect(new Date(rows[0]?._metadata?.updatedAt as string).getTime()).toBe(NOW.getTime());
    })
  );

  it(
    'patchRows with no actor stamps the anonymous system actor, and ignores id and _deletedAt keys',
    each(async (_n, ds) => {
      await ds.write('Item', [{ id: 'a', t: 'one' }]);
      const [row] = await ds.patchRows(
        'Item',
        [{ id: 'a', patch: { t: 'two', id: 'zzz', _deletedAt: NOW } }],
        null,
        NOW
      );
      expect(row).toMatchObject({ id: 'a', t: 'two' });
      expect(row?._deletedAt).toBeUndefined();
      expect(row?._metadata).toMatchObject({ updatedBy: { kind: 'system', id: 'anonymous' } });
    })
  );

  it(
    'patchRows on a tombstoned id returns null at its slot and leaves it tombstoned; on a purged id returns null and writes nothing',
    each(async (_n, ds) => {
      await ds.write('Item', [
        { id: 'live', t: 'l' },
        { id: 'dead', t: 'd' },
        { id: 'gone', t: 'g' }
      ]);
      await ds.tombstone('Item', ['dead', 'gone']);
      await ds.purge('Item', ['gone']);
      const out = await ds.patchRows(
        'Item',
        [
          { id: 'dead', patch: { t: 'D' } },
          { id: 'live', patch: { t: 'L' } },
          { id: 'gone', patch: { t: 'G' } },
          { id: 'never', patch: { t: 'N' } }
        ],
        ACTOR,
        NOW
      );
      expect(out.map((r) => r?.id ?? null)).toEqual([null, 'live', null, null]);
      const { rows } = await ds.read('Item', { includeDeleted: true, orderBy: [{ id: 'asc' }] });
      expect(rows.map((r) => [r.id, r.t, r._deletedAt != null])).toEqual([
        ['dead', 'd', true],
        ['live', 'L', false]
      ]);
    })
  );

  it(
    'patchRows with a repeated id applies the patches in order (last wins) and both slots hold the final row',
    each(async (_n, ds) => {
      await ds.write('Item', [{ id: 'a', t: 'one', u: 'keep' }]);
      const out = await ds.patchRows(
        'Item',
        [
          { id: 'a', patch: { t: 'first', u: 'mid' } },
          { id: 'a', patch: { t: 'second' } }
        ],
        ACTOR,
        NOW
      );
      expect(out.map((r) => [r?.t, r?.u])).toEqual([
        ['second', 'mid'],
        ['second', 'mid']
      ]);
    })
  );

  it('patchRows mirrors a promoted column from the patch, per row, and keeps it when absent', async () => {
    const pg = datasets[1]?.[1] as Dataset;
    await pg.write('Item', [
      { id: 'a', status: 'open', project: 'p', archived: false },
      { id: 'b', status: 'open', project: 'p', archived: false }
    ]);
    await pg.patchRows(
      'Item',
      [
        { id: 'a', patch: { status: 'closed', archived: true } },
        { id: 'b', patch: { project: null } }
      ],
      ACTOR,
      NOW
    );
    const cols = await sql`SELECT id, status, project, archived FROM rows
      WHERE namespace = ${NS} AND type = 'Item' ORDER BY id`;
    expect(cols.map((r) => [r.id, r.status, r.project, r.archived])).toEqual([
      ['a', 'closed', 'p', true],
      ['b', 'open', null, false]
    ]);
  });

  it(
    'empty input returns an empty result',
    each(async (_n, ds) => {
      expect(await ds.allocateShortIds('Item', 0)).toEqual([]);
      await ds.bindShortIds('Item', []);
      expect((await ds.resolveShortIds('Item', [])).size).toBe(0);
      expect(await ds.patchRows('Item', [], ACTOR, NOW)).toEqual([]);
    })
  );

  describe('pg statements', () => {
    let pg: Dataset;
    beforeEach(() => {
      pg = datasets[1]?.[1] as Dataset;
    });

    it('an empty call sends no SQL', async () => {
      await pg.allocateShortId('Item'); // creates the sequence
      const out = await sent(async () => {
        await pg.allocateShortIds('Item', 0);
        await pg.bindShortIds('Item', []);
        await pg.resolveShortIds('Item', []);
        await pg.patchRows('Item', [], ACTOR, NOW);
      });
      expect(out).toEqual([]);
    });

    it('each primitive is one statement whatever the batch size', async () => {
      const n = 50;
      const ids = Array.from({ length: n }, (_, i) => `r${i}`);
      await pg.write(
        'Item',
        ids.map((id) => ({ id }))
      );
      await pg.allocateShortId('Item'); // creates the sequence, once
      let shorts: number[] = [];
      expect(
        await sent(async () => {
          shorts = await pg.allocateShortIds('Item', n);
        })
      ).toHaveLength(1);
      expect(
        await sent(() =>
          pg.bindShortIds(
            'Item',
            ids.map((rowId, i) => ({ shortId: shorts[i] as number, rowId }))
          )
        )
      ).toHaveLength(1);
      expect(await sent(() => pg.resolveShortIds('Item', shorts))).toHaveLength(1);
      expect(
        await sent(() =>
          pg.patchRows(
            'Item',
            ids.map((id) => ({ id, patch: { t: id } })),
            ACTOR,
            NOW
          )
        )
      ).toHaveLength(1);
    });
  });
});
