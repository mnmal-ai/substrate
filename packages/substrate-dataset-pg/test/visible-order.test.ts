/**
 * Visible-order types: `ordering: 'visible'` gives each inserted row a per-type
 * `seq` in commit order. The order and parity scenarios run on memory always
 * and on pg when POSTGRES_URL is set; the blocking test is pg only.
 */

import { randomUUID } from 'node:crypto';
import { Engine, MemoryEdgesStore, type NamespaceConfig, Registry } from '@mnmal-ai/substrate-core';
import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import { defineNamespace, field, type TypeInput } from '@mnmal-ai/substrate-sdk';
import type { Dataset, Id, Row, RowMetadata, WriteResult } from '@mnmal-ai/substrate-types';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/migrate.js';
import { PgDataset } from '../src/pg-dataset.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const NS = 'test_visible_order';

const fields = { msg: field.string() };
const types = {
  Log: { fields, ordering: 'visible', orderedBy: { seq: 'asc' } },
  Note: { fields }
} satisfies Record<string, TypeInput>;
const typeDefLookup = (type: string) => (types as Record<string, TypeInput>)[type];

const seqOf = (r: Row | undefined): number | undefined =>
  (r?._metadata as RowMetadata | undefined)?.seq;
const msgs = (rows: Row[]): unknown[] => rows.map((r) => r.msg);

describe('ordering option', () => {
  const define = (def: TypeInput) => defineNamespace('shop', { Item: def });

  it("refuses orderedBy seq on a type not declared ordering: 'visible'", () => {
    expect(() => define({ fields, orderedBy: { seq: 'asc' } })).toThrow(
      /'seq' needs the type to declare ordering: 'visible'/
    );
  });

  it("accepts orderedBy seq on a type declared ordering: 'visible'", () => {
    expect(() => define({ fields, ordering: 'visible', orderedBy: { seq: 'desc' } })).not.toThrow();
  });

  it("refuses an ordering other than 'visible'", () => {
    expect(() => define({ fields, ordering: 'random' as 'visible' })).toThrow(
      /ordering on Item must be 'visible'/
    );
  });
});

/** Writes the same sequence on any dataset and reports what it observed. */
async function scenario(ds: Dataset) {
  const first = await ds.write('Log', [{ msg: 'a' }, { msg: 'b' }, { msg: 'c' }]);
  const [idA, idB] = first.ids as [Id, Id, Id];
  // An upsert of an existing row keeps its seq; a new row in the batch gets the next.
  const upsert = await ds.write('Log', [{ id: idB, msg: 'b2' }, { msg: 'd' }]);
  // insertOnly: the existing row is skipped and gets none; a repeated id lands once.
  const repeated = randomUUID();
  const insertOnly = await ds.write(
    'Log',
    [
      { id: idA, msg: 'x' },
      { id: repeated, msg: 'e' },
      { id: repeated, msg: 'e-again' }
    ],
    { insertOnly: true }
  );
  // A purged newest row's seq is never reused.
  await ds.purge('Log', [repeated]);
  const afterPurge = await ds.write('Log', [{ msg: 'f' }]);
  // A rolled-back insert consumes nothing.
  await expect(
    ds.withTransaction(async (tx) => {
      await tx.write('Log', [{ msg: 'rolled back' }]);
      throw new Error('rollback');
    })
  ).rejects.toThrow('rollback');
  const last = await ds.write('Log', [{ msg: 'g' }]);
  const note = await ds.write('Note', [{ msg: 'n' }]);

  const bySeq = await ds.read('Log', { orderBy: [{ seq: 'asc' }] });
  const filtered = await ds.read('Log', { where: { seq: { gt: 3 } }, orderBy: [{ seq: 'desc' }] });
  // Keyset paging on seq, two rows a page.
  const paged: unknown[] = [];
  let cursor: string | undefined;
  do {
    const page = await ds.read('Log', {
      orderBy: [{ seq: 'asc' }],
      limit: 2,
      ...(cursor !== undefined ? { cursor } : {})
    });
    paged.push(...msgs(page.rows));
    cursor = page.hasMore ? page.nextCursor : undefined;
  } while (cursor !== undefined);

  return {
    first: first.rows.map(seqOf),
    upsert: upsert.rows.map(seqOf),
    insertOnly: insertOnly.rows.map((r) => [r.msg, seqOf(r)]),
    afterPurge: seqOf(afterPurge.rows[0]),
    last: seqOf(last.rows[0]),
    note: seqOf(note.rows[0]),
    noteHasSeqKey: Object.hasOwn((note.rows[0]?._metadata ?? {}) as object, 'seq'),
    bySeq: bySeq.rows.map((r) => [r.msg, seqOf(r)]),
    filtered: msgs(filtered.rows),
    paged
  };
}

const EXPECTED = {
  first: [1, 2, 3],
  upsert: [2, 4],
  insertOnly: [['e', 5]],
  afterPurge: 6,
  last: 7,
  note: undefined,
  noteHasSeqKey: false,
  bySeq: [
    ['a', 1],
    ['b2', 2],
    ['c', 3],
    ['d', 4],
    ['f', 6],
    ['g', 7]
  ],
  filtered: ['g', 'f', 'd'],
  paged: ['a', 'b2', 'c', 'd', 'f', 'g']
};

/** Pages `Log` through the engine in its natural order (`seq` asc), following cursors. */
async function enginePages(ds: Dataset): Promise<unknown[]> {
  const registry = new Registry();
  const edges = new MemoryEdgesStore({ now: () => new Date() });
  defineNamespace(NS, types).install({ registry, dataset: ds, edges });
  const datasets = new MemoryDatasetRegistry();
  datasets.set(NS, ds);
  const engine = new Engine({
    namespaces: new Map<string, NamespaceConfig>([[NS, { registry }]]),
    datasets,
    edges
  });
  const out: unknown[] = [];
  let cursor: string | undefined;
  do {
    const env = await engine.query({
      frame: {
        [`${NS}/Log`]: {
          params: { limit: 2, ...(cursor !== undefined ? { cursor } : {}) },
          fields: { msg: true, _metadata: true }
        }
      },
      ctx: { identity: null }
    });
    expect(env.errors).toBeUndefined();
    out.push(...msgs(env.data[`${NS}/Log`] as Row[]));
    const pg = env._pagination?.[`${NS}/Log`];
    cursor = pg?.hasMore === true && typeof pg.nextCursor === 'string' ? pg.nextCursor : undefined;
  } while (cursor !== undefined);
  return out;
}

describe('visible order (memory)', () => {
  const memory = () => new MemoryDataset({ namespace: NS, typeDefLookup });

  it('assigns strictly increasing seq per type', async () => {
    expect(await scenario(memory())).toEqual(EXPECTED);
  });

  it('pages in seq order through the engine', async () => {
    const ds = memory();
    await scenario(ds);
    expect(await enginePages(ds)).toEqual(EXPECTED.paged);
  });
});

describe.skipIf(!POSTGRES_URL)('visible order (pg)', () => {
  let sql: ReturnType<typeof postgres>;
  let ds: PgDataset;

  const clean = async () => {
    await sql`DELETE FROM rows WHERE namespace = ${NS}`;
    await sql`DELETE FROM visible_seqs WHERE namespace = ${NS}`;
  };

  beforeAll(async () => {
    if (!POSTGRES_URL) return;
    // Writer A, writer B and a reader each need a connection at once.
    sql = postgres(POSTGRES_URL, { max: 4, onnotice: () => {} });
    await runMigrations(sql);
    ds = new PgDataset({ namespace: NS, sql, typeDefLookup });
  });

  beforeEach(clean);

  afterAll(async () => {
    if (!POSTGRES_URL) return;
    await clean();
    await sql.end();
  });

  it('assigns strictly increasing seq per type', async () => {
    expect(await scenario(ds)).toEqual(EXPECTED);
  });

  it('matches the memory dataset on order', async () => {
    const memory = new MemoryDataset({ namespace: NS, typeDefLookup });
    expect(await scenario(ds)).toEqual(await scenario(memory));
    expect(await enginePages(ds)).toEqual(await enginePages(memory));
  });

  it('no reader ever sees a higher seq before a lower one', async () => {
    const before = await ds.write('Log', [{ msg: 'before' }]);
    const n = (seqOf(before.rows[0]) ?? 0) + 1;

    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let written!: (r: WriteResult) => void;
    const aWritten = new Promise<WriteResult>((resolve) => {
      written = resolve;
    });
    // Writer A inserts, gets seq n, and holds its transaction open.
    const txA = ds.withTransaction(async (tx) => {
      written(await tx.write('Log', [{ msg: 'A' }]));
      await hold;
    });
    const a = await aWritten;
    expect(seqOf(a.rows[0])).toBe(n);

    // Writer B must block until A commits.
    let bDoneAt: number | undefined;
    const txB = ds.write('Log', [{ msg: 'B' }]).then((r) => {
      bDoneAt = performance.now();
      return r;
    });
    const deadline = performance.now() + 5_000;
    for (;;) {
      const [w] = await sql<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'
          AND wait_event = 'advisory' AND query LIKE '%substrate-visible-seq%'`;
      if ((w?.n ?? 0) > 0) break;
      expect(performance.now()).toBeLessThan(deadline);
      await new Promise((r) => setTimeout(r, 20));
    }
    await new Promise((r) => setTimeout(r, 300));
    expect(bDoneAt).toBeUndefined();

    // A reader on a third connection during the hold sees neither row.
    const seen = await ds.read('Log', {});
    expect(msgs(seen.rows)).toEqual(['before']);

    const releasedAt = performance.now();
    release();
    await txA;
    const b = await txB;
    expect(bDoneAt).toBeGreaterThanOrEqual(releasedAt);
    expect(seqOf(b.rows[0])).toBe(n + 1);
  });

  it('non-visible types leave seq null', async () => {
    await ds.write('Note', [{ msg: 'n1' }, { msg: 'n2' }]);
    const [held] = await sql<Array<{ withSeq: number; rows: number }>>`
      SELECT count(seq)::int AS "withSeq", count(*)::int AS rows FROM rows
      WHERE namespace = ${NS} AND type = 'Note'`;
    expect(held).toEqual({ withSeq: 0, rows: 2 });
    const counters =
      await sql`SELECT 1 FROM visible_seqs WHERE namespace = ${NS} AND type = 'Note'`;
    expect(counters).toHaveLength(0);
    const read = await ds.read('Note', {});
    expect(read.rows.map(seqOf)).toEqual([undefined, undefined]);
  });

  it('builds the seq index for a visible-order type only', async () => {
    await ds.write('Log', [{ msg: 'a' }]);
    await ds.write('Note', [{ msg: 'n' }]);
    await ds.ensureTypeStorage('Log');
    await ds.ensureTypeStorage('Note');
    const seqIndexes = async (type: string) =>
      (await ds.describeStorage(type)).indexes.filter((i) => /_seq_/.test(i.name));
    expect((await seqIndexes('Log')).map((i) => i.state)).toEqual(['valid']);
    expect(await seqIndexes('Note')).toEqual([]);
  });
});
