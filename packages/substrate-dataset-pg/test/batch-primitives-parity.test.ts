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

// The memory half runs without POSTGRES_URL; the pg half and the pg-only
// tests (promoted columns, statement counts, locking) need it.
const HAS_PG = Boolean(POSTGRES_URL);

describe('batch primitives (memory vs pg)', () => {
  let sql: Sql | undefined;
  let statements: string[] = [];
  let datasets: Array<[string, Dataset]>;
  const pgSql = (): Sql => sql as Sql;

  beforeAll(async () => {
    if (!HAS_PG) return;
    sql = postgres(POSTGRES_URL as string, {
      onnotice: () => {},
      debug: (_conn, query) => {
        statements.push(query);
      }
    });
    await addTestPromotedColumns(sql);
  });

  afterAll(async () => {
    if (sql === undefined) return;
    await dropTestPromotedColumns(sql);
    await sql.end();
  });

  beforeEach(async () => {
    datasets = [['memory', new MemoryDataset({ namespace: NS })]];
    if (sql === undefined) return;
    // Both explicitly: short_ids only follows rows through an ON DELETE CASCADE
    // foreign key, which other test files drop (`DROP TABLE rows CASCADE`) and
    // later migrations do not restore. A stale binding to a reused row id would
    // make bindShortIds' ON CONFLICT DO NOTHING keep the old id.
    await sql`DELETE FROM short_ids WHERE namespace = ${NS}`;
    await sql`DELETE FROM rows WHERE namespace = ${NS}`;
    const pg = new PgDataset({ namespace: NS, sql, promotedColumns: TEST_PROMOTED });
    if (PARTITIONED) await pg.ensureTypeStorage('Item');
    datasets.push(['pg', pg]);
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
    'bindShortIds on a row that already has a short id behaves as bindShortId does, per dataset',
    each(async (name, ds) => {
      const rows = ['s1', 's2', 'b1', 'b2'];
      await ds.write(
        'Item',
        rows.map((id) => ({ id }))
      );
      // Each row gets one id, then rebinds: s1/b1 once, s2/b2 twice in a row.
      const ids = await ds.allocateShortIds('Item', 10);
      const plan: Record<string, number[]> = {
        s1: [ids[0], ids[4]],
        s2: [ids[1], ids[5], ids[6]],
        b1: [ids[2], ids[7]],
        b2: [ids[3], ids[8], ids[9]]
      } as Record<string, number[]>;
      for (const rowId of rows)
        await ds.bindShortId('Item', (plan[rowId] as number[])[0] as number, rowId);
      for (const rowId of ['s1', 's2']) {
        for (const id of (plan[rowId] as number[]).slice(1))
          await ds.bindShortId('Item', id, rowId);
      }
      await ds.bindShortIds(
        'Item',
        ['b1', 'b2'].flatMap((rowId) =>
          (plan[rowId] as number[]).slice(1).map((shortId) => ({ shortId, rowId }))
        )
      );
      // What each of a row's candidate ids resolves to, and which one the row reports.
      const observe = async (rowId: string) => {
        const candidates = plan[rowId] as number[];
        return {
          reported: candidates.indexOf((await ds.getShortIdForRow('Item', rowId)) as number),
          resolves: await Promise.all(
            candidates.map(async (id) => (await ds.resolveShortId('Item', id)) === rowId)
          )
        };
      };
      expect([await observe('b1'), await observe('b2')]).toEqual([
        await observe('s1'),
        await observe('s2')
      ]);
      if (name === 'pg') {
        // Postgres keeps the first binding and ignores the rest (ON CONFLICT DO NOTHING).
        expect(await observe('b2')).toEqual({ reported: 0, resolves: [true, false, false] });
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

  it.skipIf(!HAS_PG)(
    'patchRows mirrors a promoted column from the patch, per row, and keeps it when absent',
    async () => {
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
      const cols = await pgSql()`SELECT id, status, project, archived FROM rows
      WHERE namespace = ${NS} AND type = 'Item' ORDER BY id`;
      expect(cols.map((r) => [r.id, r.status, r.project, r.archived])).toEqual([
        ['a', 'closed', 'p', true],
        ['b', 'open', null, false]
      ]);
    }
  );

  it(
    'empty input returns an empty result',
    each(async (_n, ds) => {
      expect(await ds.allocateShortIds('Item', 0)).toEqual([]);
      await ds.bindShortIds('Item', []);
      expect((await ds.resolveShortIds('Item', [])).size).toBe(0);
      expect(await ds.patchRows('Item', [], ACTOR, NOW)).toEqual([]);
    })
  );

  it(
    'allocateShortIds refuses a count that is not a non-negative safe integer, and never rewinds',
    each(async (_n, ds) => {
      const before = await ds.allocateShortIds('Item', 5);
      for (const bad of [-3, 2.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
        await expect(ds.allocateShortIds('Item', bad), String(bad)).rejects.toThrow(
          /count must be a non-negative integer/
        );
      }
      const after = await ds.allocateShortIds('Item', 1);
      expect(after[0]).toBeGreaterThan(before[4] as number);
    })
  );

  it(
    'resolveShortIds skips ids that are not integers',
    each(async (_n, ds) => {
      await ds.write('Item', [{ id: 'a' }]);
      const [id] = await ds.allocateShortIds('Item', 1);
      await ds.bindShortIds('Item', [{ shortId: id as number, rowId: 'a' }]);
      const got = await ds.resolveShortIds('Item', [
        1.5,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        id as number
      ]);
      expect([...got]).toEqual([[id, 'a']]);
      expect((await ds.resolveShortIds('Item', [1.5, Number.NaN])).size).toBe(0);
    })
  );

  describe.skipIf(!HAS_PG)('pg statements', () => {
    let pg: Dataset;
    beforeEach(() => {
      pg = datasets[1]?.[1] as Dataset;
    });

    it('an empty call, or one with no valid id, sends no SQL', async () => {
      await pg.allocateShortId('Item'); // creates the sequence
      const out = await sent(async () => {
        await pg.allocateShortIds('Item', 0);
        await pg.bindShortIds('Item', []);
        await pg.resolveShortIds('Item', []);
        await pg.resolveShortIds('Item', [1.5, Number.NaN]);
        await pg.patchRows('Item', [], ACTOR, NOW);
      });
      expect(out).toEqual([]);
    });

    it('a fresh store sends the ensureSequence statement before its first allocation', async () => {
      // PgShortIdStore caches ensured sequences per instance, and every
      // transaction-bound PgDataset has its own, so the first allocation of a
      // type in a transaction costs one extra statement (it takes an advisory
      // xact lock too).
      const fresh = new PgDataset({ namespace: NS, sql: pgSql(), promotedColumns: TEST_PROMOTED });
      const first = await sent(() => fresh.allocateShortIds('Item', 3));
      expect(first).toHaveLength(2);
      expect(first[0]).toMatch(/CREATE SEQUENCE/);
      expect(await sent(() => fresh.allocateShortIds('Item', 3))).toHaveLength(1);
    });

    it('each primitive is one statement, and the same text, whatever the batch size', async () => {
      await pg.allocateShortId('Item'); // creates the sequence, once
      const run = async (n: number, tag: string) => {
        const ids = Array.from({ length: n }, (_, i) => `${tag}${i}`);
        await pg.write(
          'Item',
          ids.map((id) => ({ id }))
        );
        let shorts: number[] = [];
        const texts: Record<string, string[]> = {};
        texts.allocate = await sent(async () => {
          shorts = await pg.allocateShortIds('Item', n);
        });
        texts.bind = await sent(() =>
          pg.bindShortIds(
            'Item',
            ids.map((rowId, i) => ({ shortId: shorts[i] as number, rowId }))
          )
        );
        texts.resolve = await sent(() => pg.resolveShortIds('Item', shorts));
        texts.patch = await sent(() =>
          pg.patchRows(
            'Item',
            ids.map((id) => ({ id, patch: { t: id } })),
            ACTOR,
            NOW
          )
        );
        return texts;
      };
      const runs = [await run(1, 'a'), await run(3, 'b'), await run(50, 'c')];
      for (const name of ['allocate', 'bind', 'resolve', 'patch']) {
        for (const r of runs) expect(r[name], name).toHaveLength(1);
        expect(new Set(runs.map((r) => r[name]?.[0])).size, `${name} text varies`).toBe(1);
      }
    });
  });

  // Two transactions patching overlapping rows in opposite orders. The row
  // locks are taken in id order inside the one statement, so they queue
  // rather than deadlock (40P01).
  it.skipIf(!HAS_PG)(
    'overlapping concurrent patchRows in opposite orders do not deadlock',
    async () => {
      const pg = datasets[1]?.[1] as Dataset;
      const ids = Array.from({ length: 300 }, (_, i) => `r${String(i).padStart(3, '0')}`);
      await pg.write(
        'Item',
        ids.map((id) => ({ id, n: 0 }))
      );
      const asc = ids.map((id) => ({ id, patch: { n: 1 } }));
      const desc = [...asc].reverse();
      const patch = (list: typeof asc) =>
        pg.withTransaction((tx) => tx.patchRows('Item', list, ACTOR, NOW));
      for (let round = 0; round < 25; round++) {
        const results = await Promise.allSettled([
          patch(asc),
          patch(desc),
          patch(desc),
          patch(asc)
        ]);
        const failed = results.filter((r) => r.status === 'rejected');
        expect(
          failed.map((r) => String((r as PromiseRejectedResult).reason)),
          `round ${round}`
        ).toEqual([]);
      }
    }
  );
});
