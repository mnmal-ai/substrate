/**
 * PgDataset on the `tables` layout against MemoryDataset: every read and
 * write path through a type table answers as memory does. One type declares
 * every column kind plus json, list and crossRef. `tables` only.
 */

import { randomBytes } from 'node:crypto';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { field } from '@mnmal-ai/substrate-sdk';
import type {
  Dataset,
  FieldDef,
  ReadParams,
  Row,
  WhereClause,
  WriteRow
} from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PgDataset, UUID_CHECK_MIGRATION } from '../src/index.js';
import { applyPatch, encodeRow } from '../src/row-codec.js';
import { loadTypeTable, type TypeTable } from '../src/type-table.js';
import { inputCte, mergeAssignments, setList, writeRowsStatement } from '../src/write-rows.js';
import { clearNamespace, dropNamespace } from './_layout.js';
import { probes } from './_read-guard.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const NS = `tdp_${randomBytes(4).toString('hex')}`;

const ITEM: Record<string, FieldDef> = {
  title: field.string(),
  status: field.enum(['open', 'closed']),
  n: field.number(),
  due: field.date(),
  done: field.boolean(),
  owner: field.crossRef(NS, 'Person'),
  meta: field.json(),
  tags: field.list(field.string())
};

/** Each type's definition; a test may swap one, as a code change would. */
const defs: Record<string, { fields: Record<string, FieldDef>; ordering?: 'visible' }> = {};
function resetDefs(): void {
  for (const k of Object.keys(defs)) delete defs[k];
  Object.assign(defs, {
    Item: { fields: ITEM },
    Person: { fields: { name: field.string() } },
    Seq: { fields: { label: field.string() }, ordering: 'visible' },
    Big: { fields: { label: field.string(), n: field.number() } },
    Gone: { fields: { keep: field.string(), drop: field.number() } },
    Vocab: { fields: { status: field.enum(['a', 'b']), note: field.string() } },
    Uniq: { fields: { code: field.string() } }
  });
}
resetDefs();
const typeDefLookup = (type: string) => defs[type];
const fieldDefLookup = (type: string, f: string) => defs[type]?.fields[f];

const PEOPLE: WriteRow[] = [
  { id: 'p1', name: 'Ann' },
  { id: 'p2', name: 'Bob' },
  { id: 'p3', name: 'Cy' }
];
const ITEMS: WriteRow[] = [
  {
    id: 'i1',
    title: 'alpha',
    status: 'open',
    n: 3,
    due: '2026-01-02T03:04:05.123456Z',
    done: true,
    owner: 'p1',
    meta: { a: 1, k: 'x' },
    tags: ['x', 'y']
  },
  {
    id: 'i2',
    title: 'Beta',
    status: 'closed',
    n: -1.5,
    due: '2026-01-02',
    done: false,
    owner: 'p2',
    meta: { a: 2 },
    tags: []
  },
  {
    id: 'i3',
    title: 'gamma',
    status: 'open',
    n: 10,
    due: '2025-12-31T23:00:00+02:00',
    done: true,
    owner: 'p1'
  },
  { id: 'i4', title: 'delta' },
  {
    id: 'i5',
    title: '',
    status: 'closed',
    n: 0,
    due: '2026-06-01T00:00:00.000Z',
    done: false,
    owner: 'p3',
    meta: { a: 1, b: [1] },
    tags: ['y']
  },
  { id: 'i6', title: 'zeta', n: 1e-7, due: '2026-03-01T00:00:00Z', owner: 'nobody' }
];

/** A row without what only one dataset fills (`_metadata`, `shortId`). */
const strip = ({ _metadata: _m, shortId: _s, ...rest }: Row): Row =>
  // Each dataset stamps its own clock; that a row is tombstoned is what compares.
  (rest._deletedAt === undefined ? rest : { ...rest, _deletedAt: true }) as Row;
const byId = (a: Row, b: Row) => String(a.id).localeCompare(String(b.id));

describe.skipIf(!POSTGRES_URL)('PgDataset on type tables vs memory', () => {
  let sql: Sql;
  let statements: string[] = [];
  let pg: PgDataset;
  let mem: MemoryDataset;
  const both = (): Array<[string, PgDataset | MemoryDataset]> => [
    ['memory', mem],
    ['pg', pg]
  ];

  /** Asserts both answer `params` alike; returns memory's rows. */
  async function same(type: string, params: ReadParams, sorted = false): Promise<Row[]> {
    const read = async (ds: Dataset) => {
      const rows = (await ds.read(type, params)).rows.map(strip);
      return sorted ? rows.sort(byId) : rows;
    };
    const want = await read(mem);
    expect(await read(pg), JSON.stringify(params)).toEqual(want);
    return want;
  }

  /** Every page of `params`, following the cursor, on `ds`. */
  async function pages(ds: Dataset, type: string, params: ReadParams): Promise<unknown[]> {
    const out: unknown[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 20; i++) {
      const r = await ds.read(type, { ...params, ...(cursor ? { cursor } : {}) });
      out.push(r.rows.map((x) => x.id));
      if (!r.hasMore) return out;
      cursor = r.nextCursor;
    }
    throw new Error('did not end');
  }

  async function seed(): Promise<void> {
    for (const [, ds] of both()) {
      await ds.write('Person', PEOPLE);
      await ds.write('Item', ITEMS);
    }
  }

  async function table(type: string): Promise<TypeTable> {
    const t = await loadTypeTable(sql, NS, type);
    if (t === undefined) throw new Error(`no table for ${type}`);
    return t;
  }

  beforeAll(async () => {
    sql = postgres(POSTGRES_URL as string, {
      onnotice: () => {},
      debug: (_conn, query) => {
        statements.push(query);
      }
    });
  });

  afterAll(async () => {
    await dropNamespace(sql, NS);
    await sql.end({ timeout: 5 });
  });

  beforeEach(async () => {
    resetDefs();
    await clearNamespace(sql, NS);
    await sql`DELETE FROM visible_seqs WHERE namespace = ${NS}`;
    pg = new PgDataset({ namespace: NS, sql, fieldDefLookup, typeDefLookup });
    mem = new MemoryDataset({ namespace: NS, fieldDefLookup, typeDefLookup, walkReference: true });
  });

  it('write/read round-trip equals memory', async () => {
    await seed();
    await same('Item', {}, true);
    await same('Person', {}, true);
    // Memory returns whole rows; pg ships the requested fields only, `$raw` entries included.
    const projected = (await pg.read('Item', { fields: { title: true, due: true } })).rows;
    const whole = (await mem.read('Item', {})).rows;
    expect(projected.map(strip).sort(byId)).toEqual(
      whole
        .map(({ id, title, due }) => ({ id, title, due }))
        .sort(byId)
        .map((r) => Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined)))
    );
    await same('Item', { ids: ['i2', 'i4', 'missing'] }, true);
  });

  it('filters, sorts, cursor, count and _agg on every kind equal memory', async () => {
    await seed();
    const wheres: WhereClause[] = [
      { title: { eq: 'alpha' } },
      { title: { contains: 'a' } },
      { title: { startsWith: 'B' } },
      { title: { gt: 'b' } },
      { title: { eq: null } },
      { status: { eq: 'open' } },
      { status: { in: ['closed'] } },
      { status: { neq: 'open' } },
      { n: { gt: 0 } },
      { n: { lte: 0 } },
      { n: { between: [0, 5] } },
      { n: { eq: null } },
      { due: { gte: '2026-01-01' } },
      { due: { lt: '2026-01-02T03:04:05.123457Z' } },
      { due: { eq: '2026-01-02T03:04:05.123456Z' } },
      { done: { eq: true } },
      { done: { eq: false } },
      { owner: { eq: 'p1' } },
      { owner: { in: ['p2', 'p3'] } },
      { owner: { eq: null } },
      { tags: { has: 'y' } },
      { meta: { path: ['a'], eq: 1 } },
      { NOT: { status: { eq: 'open' } } },
      { OR: [{ n: { gt: 5 } }, { done: { eq: false } }] }
    ] as WhereClause[];
    for (const where of wheres) {
      await same('Item', { where }, true);
      await same('Item', { where, count: true });
      const counts = await Promise.all(
        both().map(([, ds]) => ds.read('Item', { where, count: true }))
      );
      expect(counts[1]?.count, JSON.stringify(where)).toBe(counts[0]?.count);
    }
    for (const f of ['title', 'status', 'n', 'due', 'done', 'owner']) {
      for (const dir of ['asc', 'desc'] as const) {
        const params: ReadParams = { orderBy: [{ [f]: dir }], limit: 2 };
        expect(await pages(pg, 'Item', params), `${f} ${dir}`).toEqual(
          await pages(mem, 'Item', params)
        );
      }
    }
    const aggregate = {
      c: { count: true },
      s: { sum: 'n' },
      lo: { min: 'n' },
      hi: { max: 'due' },
      av: { avg: 'n' }
    } as NonNullable<ReadParams['aggregate']>;
    const groups = await Promise.all(both().map(([, ds]) => ds.read('Item', { aggregate })));
    // pg averages in numeric, memory in float: the same to float noise.
    const [g0, g1] = [groups[0]?.groups?.[0], groups[1]?.groups?.[0]];
    expect(g1?.av).toBeCloseTo(g0?.av as number, 12);
    expect({ ...g1, av: 0 }).toEqual({ ...g0, av: 0 });
    const agg = {
      items: { in: `${NS}/Item.owner`, count: true },
      top: { in: `${NS}/Item.owner`, max: 'n' }
    } as unknown as NonNullable<ReadParams['agg']>;
    await same('Person', { agg, orderBy: [{ name: 'asc' }] });
  });

  it('walk out/in through a crossRef column equals memory', async () => {
    await seed();
    await same(
      'Item',
      { where: { _walk: { out: 'owner', where: { name: { eq: 'Ann' } } } } as WhereClause },
      true
    );
    await same(
      'Person',
      {
        where: { _walk: { in: `${NS}/Item.owner`, where: { done: { eq: true } } } } as WhereClause
      },
      true
    );
    await same(
      'Person',
      { where: { _walk: { in: `${NS}/Item.owner`, quantifier: 'none' } } as WhereClause },
      true
    );
  });

  it('update merge: absent keeps, null clears, $raw cleared by a canonical write', async () => {
    await seed();
    for (const [, ds] of both()) {
      // A non-canonical date goes to $raw; the canonical rewrite must clear it.
      await ds.write('Item', [{ id: 'i2', title: null, n: 7, due: '2026-01-03T00:00:00.000Z' }]);
      await ds.write('Item', [{ id: 'i1', meta: null, tags: null, status: 'zzz' }]);
    }
    await same('Item', {}, true);
    const [extra] = await sql.unsafe(
      `SELECT extra FROM ${(await table('Item')).from} WHERE id = 'i2'`
    );
    expect(extra?.extra).not.toHaveProperty('$raw');
  });

  it('tombstone hides; purge removes row_ids and short_ids', async () => {
    await seed();
    for (const [, ds] of both()) {
      const [sid] = await ds.allocateShortIds('Item', 1);
      await ds.bindShortId('Item', sid as number, 'i1');
      expect((await ds.tombstone('Item', ['i1', 'i1', 'nope'])).ids).toEqual(['i1']);
      expect((await ds.tombstone('Item', ['i1'])).deleted).toBe(0);
    }
    await same('Item', {}, true);
    await same('Item', { includeDeleted: true, ids: ['i1'] }, true);
    for (const [, ds] of both()) expect((await ds.purge('Item', ['i1', 'i2'])).deleted).toBe(2);
    await same('Item', { includeDeleted: true }, true);
    const left = await sql`
      SELECT (SELECT count(*)::int FROM row_ids WHERE namespace = ${NS} AND type = 'Item' AND id IN ('i1', 'i2')) AS r,
             (SELECT count(*)::int FROM short_ids WHERE namespace = ${NS} AND type = 'Item' AND row_id = 'i1') AS s`;
    expect(left[0]).toEqual({ r: 0, s: 0 });
  });

  it('visible order assigns seq in input order', async () => {
    const rows = ['c', 'a', 'b'].map((id) => ({ id, label: id }));
    const written = await pg.write('Seq', rows);
    expect(written.rows.map((r) => [r.id, r._metadata?.seq])).toEqual([
      ['c', 1],
      ['a', 2],
      ['b', 3]
    ]);
    // An existing row keeps its seq; a new one takes the next.
    const again = await pg.write('Seq', [
      { id: 'a', label: 'A' },
      { id: 'd', label: 'd' }
    ]);
    expect(again.rows.map((r) => [r.id, r._metadata?.seq])).toEqual([
      ['a', 2],
      ['d', 4]
    ]);
  });

  it('unique index conflict → unique_violation naming fields', async () => {
    defs.Uniq = {
      fields: { code: field.string() },
      indexes: [{ fields: ['code'], unique: true }]
    } as never;
    await pg.ensureTypeStorage('Uniq');
    await pg.write('Uniq', [{ id: 'u1', code: 'A' }]);
    const err = await pg.write('Uniq', [{ id: 'u2', code: 'A' }]).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'unique_violation', details: { fields: ['code'] } });
  });

  it('conditionalUpdate null matches absent', async () => {
    await seed();
    for (const [name, ds] of both()) {
      const absent = await ds.conditionalUpdate('Item', 'i4', { n: null }, { n: 1 });
      expect(absent.matched, name).toBe(true);
      const miss = await ds.conditionalUpdate('Item', 'i1', { n: null }, { n: 1 });
      expect(miss.matched, name).toBe(false);
      const typed = await ds.conditionalUpdate('Item', 'i1', { n: '3' }, { n: 1 });
      expect(typed.matched, name).toBe(false);
      const hit = await ds.conditionalUpdate(
        'Item',
        'i1',
        { n: 3, status: 'open' },
        { title: 'A' }
      );
      expect(hit.matched, name).toBe(true);
    }
    await same('Item', {}, true);
  });

  it('a 5,000-row write is one INSERT', async () => {
    await pg.write('Big', [{ id: 'warm', label: 'w', n: 0 }]);
    const rows = Array.from({ length: 5000 }, (_, i) => ({ id: `b${i}`, label: `L${i}`, n: i }));
    statements = [];
    const out = await pg.write('Big', rows);
    expect(out.written).toBe(5000);
    expect(statements.filter((s) => /\bINSERT\b/i.test(s))).toHaveLength(1);
    // And as many merges, in one statement too.
    statements = [];
    await pg.write(
      'Big',
      rows.map((r) => ({ id: r.id, n: r.n + 1 }))
    );
    expect(statements.filter((s) => /\b(INSERT|UPDATE)\b/i.test(s))).toHaveLength(1);
    expect((await pg.read('Big', { ids: ['b4999'] })).rows[0]).toMatchObject({
      label: 'L4999',
      n: 5000
    });
  });

  it('no declared key in extra after any write', async () => {
    await seed();
    await pg.write('Item', [
      { id: 'i1', title: 'x', status: 'zzz', n: 'many' as never, extraKey: 1 }
    ]);
    await pg.patchRows(
      'Item',
      [{ id: 'i2', patch: { done: null, due: 'garbage' } }],
      null,
      new Date()
    );
    await pg.updateWhere('Item', { owner: { eq: 'p1' } }, { owner: 'p2' }, { maxMatch: 10 });
    await pg.updateField({ type: 'Item', id: 'i5' }, 'n', 99);
    const t = await table('Item');
    const declared = t.columns().map((c) => c.field);
    const [row] = await sql`
      SELECT count(*)::int AS n FROM ${sql.unsafe(t.from)} WHERE extra ?| ${declared}::text[]`;
    expect(row?.n).toBe(0);
  });

  it('field removed from code → its stored values still read back (F35)', async () => {
    for (const [, ds] of both()) await ds.write('Gone', [{ id: 'g1', keep: 'k', drop: 5 }]);
    defs.Gone = { fields: { keep: field.string() } };
    await pg.ensureTypeStorage('Gone');
    expect((await table('Gone')).column('drop')?.state).toBe('orphaned');
    await same('Gone', {}, true);
    // Written while orphaned, it lands in extra, and wins over the column.
    for (const [, ds] of both()) await ds.write('Gone', [{ id: 'g1', drop: 6 }]);
    await same('Gone', {}, true);
    await same('Gone', { where: { drop: { eq: 6 } } }, true);
  });

  it('write to a promoting field sets the column and strips the extra key (F13)', async () => {
    for (const [, ds] of both()) await ds.write('Gone', [{ id: 'g1', keep: 'k', drop: 5 }]);
    defs.Gone = { fields: { keep: field.string() } };
    await pg.ensureTypeStorage('Gone');
    for (const [, ds] of both()) await ds.write('Gone', [{ id: 'g1', drop: 6 }]);
    defs.Gone = { fields: { keep: field.string(), drop: field.number() } };
    await pg.ensureTypeStorage('Gone');
    const t = await table('Gone');
    expect(t.column('drop')?.state).toBe('promoting');
    for (const [, ds] of both()) await ds.write('Gone', [{ id: 'g1', drop: 7 }]);
    const [row] = await sql.unsafe(`SELECT ${t.column('drop')?.column} AS c, extra FROM ${t.from}`);
    expect(row).toEqual({ c: 7, extra: { id: 'g1' } });
    await same('Gone', {}, true);
  });

  it('per-row clear lists of different lengths in one write clear the right keys (F21)', async () => {
    await seed();
    const clears: WriteRow[] = [
      { id: 'i1', title: null, n: null, due: null, done: null },
      { id: 'i2', status: null },
      { id: 'i3' },
      { id: 'i5', owner: null, meta: null, tags: null }
    ];
    for (const [, ds] of both()) await ds.write('Item', clears);
    await same('Item', {}, true);
  });

  it('rolled-back first write leaves no cached table; the next write creates it (F18)', async () => {
    defs.Fresh = { fields: { a: field.string() } };
    const boom = new Error('roll back');
    await expect(
      pg.withTransaction(async (tx) => {
        await tx.write('Fresh', [{ id: 'f1', a: 'x' }]);
        expect((await tx.read('Fresh', {})).rows).toHaveLength(1);
        throw boom;
      })
    ).rejects.toBe(boom);
    expect(await loadTypeTable(sql, NS, 'Fresh')).toBeUndefined();
    expect((await pg.read('Fresh', {})).rows).toEqual([]);
    await pg.write('Fresh', [{ id: 'f2', a: 'y' }]);
    expect((await pg.read('Fresh', {})).rows.map(strip)).toEqual([{ id: 'f2', a: 'y' }]);
  });

  it('a dataset without the type def never redeclares its table; a field declared over rows starts promoting', async () => {
    // As `substrate-admin bootstrap` then serve: a bare dataset writes first.
    const bare = new PgDataset({ namespace: NS, sql });
    await bare.ensureTypeStorage('Key');
    await bare.write('Key', [{ id: 'k1', kid: 'abc' }]);
    defs.Key = { fields: { kid: field.string() } };
    await pg.ensureTypeStorage('Key');
    expect((await table('Key')).column('kid')?.state).toBe('promoting');
    const ids = async (where?: WhereClause) =>
      (await pg.read('Key', where === undefined ? {} : { where })).rows.map(strip);
    expect(await ids()).toEqual([{ id: 'k1', kid: 'abc' }]);
    expect(await ids({ kid: { eq: 'abc' } })).toEqual([{ id: 'k1', kid: 'abc' }]);
    // The bare dataset again: it changes nothing, so nothing is orphaned.
    expect(await bare.ensureTypeStorage('Key')).toEqual({ pending: [] });
    await bare.write('Key', [{ id: 'k2', kid: 'def' }]);
    expect((await table('Key')).column('kid')?.state).toBe('promoting');
    expect(await ids({ kid: { in: ['abc', 'def'] } })).toEqual([
      { id: 'k1', kid: 'abc' },
      { id: 'k2', kid: 'def' }
    ]);
  });

  it('a writer whose cached table predates a column declared on the empty table writes nothing, and its rebuilt write lands a readable value', async () => {
    // Writer W cached Late's table before `late` was declared. Another process
    // declares it on the still-empty table; before W's notification lands, W
    // writes `late` through its stale table, as its write path does: encoded
    // against that table (so `late` would go to `extra`) by the shared statement.
    // The catalog version refuses it; W's write path rebuilds it on the current table.
    defs.Late = { fields: { a: field.string() } };
    await pg.ensureTypeStorage('Late');
    const stale = await table('Late');
    defs.Late = { fields: { a: field.string(), late: field.string() } };
    await pg.ensureTypeStorage('Late');
    const write = (t: TypeTable) =>
      sql`${writeRowsStatement(sql, t, [{ ...encodeRow(t, { id: 'w1', late: 'x' }), id: 'w1' }], {
        insertOnly: false,
        visibleOrder: false,
        metadata: 'stamp'
      })}`;
    expect((await write(stale)).map((r) => [r.ok, r.id])).toEqual([[false, null]]);
    expect((await pg.read('Late', {})).rows).toEqual([]);
    expect((await write(await table('Late'))).map((r) => [r.ok, r.id])).toEqual([[true, 'w1']]);
    expect((await pg.read('Late', {})).rows.map(strip)).toEqual([{ id: 'w1', late: 'x' }]);
    expect((await pg.read('Late', { where: { late: { eq: 'x' } } })).rows.map((r) => r.id)).toEqual(
      ['w1']
    );
  });

  it('storage reports describe type tables', async () => {
    await seed();
    await pg.ensureTypeStorage('Item');
    expect(await pg.describeStorage('Item')).toMatchObject({
      layout: 'tables',
      table: (await table('Item')).from.slice(1, -1),
      pending: [],
      orphaned: []
    });
    expect(await pg.pendingIndexBuilds('Item')).toEqual([]);
    expect((await pg.storageReport({ partitionBudget: 100_000 })).layout).toBe('tables');
  });

  it('a type with no table is looked up once, and its creation in this process is seen at once', async () => {
    const lookups = () =>
      statements.filter((q) => /FROM substrate_type_tables WHERE namespace/.test(q)).length;
    defs.Ghost = { fields: { a: field.string() } };
    await pg.read('Ghost', {});
    statements = [];
    expect((await pg.read('Ghost', {})).rows).toEqual([]);
    expect(lookups()).toBe(0);
    // Its read still probes the catalog: a cached miss is checked like a table (M3, M6).
    expect(statements.map(probes)).toEqual([1]);
    // Another dataset on the pool creates it: the cached miss must not hide it.
    await new PgDataset({ namespace: NS, sql, typeDefLookup }).write('Ghost', [
      { id: 'g1', a: 'x' }
    ]);
    expect((await pg.read('Ghost', {})).rows.map(strip)).toEqual([{ id: 'g1', a: 'x' }]);
    // Created inside a transaction (F18): seen once it commits.
    defs.Ghost2 = { fields: { a: field.string() } };
    expect((await pg.read('Ghost2', {})).rows).toEqual([]);
    await pg.withTransaction((tx) => tx.write('Ghost2', [{ id: 'h1', a: 'y' }]));
    expect((await pg.read('Ghost2', {})).rows.map(strip)).toEqual([{ id: 'h1', a: 'y' }]);
    // Created by another process: a transaction's write does not trust the cached
    // miss, so its check-then-write sees the table before the notification lands.
    defs.Ghost3 = { fields: { a: field.string() } };
    expect((await pg.read('Ghost3', {})).rows).toEqual([]);
    const other = postgres(POSTGRES_URL as string, { onnotice: () => {} });
    try {
      await new PgDataset({ namespace: NS, sql: other, typeDefLookup }).write('Ghost3', [
        { id: 'j1', a: 'z' }
      ]);
    } finally {
      await other.end({ timeout: 5 });
    }
    const inTx = await pg.withTransaction(async (tx) => {
      await tx.write('Ghost3', [{ id: 'j2', a: 'w' }]);
      return tx.read('Ghost3', {});
    });
    expect(inTx.rows.map(strip).sort(byId)).toEqual([
      { id: 'j1', a: 'z' },
      { id: 'j2', a: 'w' }
    ]);
  });

  it('a warm count inside a transaction on a type with no table issues no catalog statement (#1862)', async () => {
    const catalog = () =>
      // A catalog-version probe (`substrate_type_tables g`) is the read's guard, not a lookup.
      statements.filter((q) => /substrate_type_(tables|fields)(?! g\b)/.test(q));
    defs.Ghost4 = { fields: { a: field.string() } };
    await pg.read('Ghost4', { count: true });
    statements = [];
    // `count` reads in a transaction of its own; its miss is cached when it commits.
    await pg.read('Ghost4', { count: true });
    expect(catalog()).toEqual([]);
    statements = [];
    const r = await pg.withTransaction((tx) => tx.read('Ghost4', { count: true, limit: 0 }));
    expect(r).toMatchObject({ rows: [], count: 0 });
    expect(catalog()).toEqual([]);
    // A write in the transaction still re-checks a miss its own read recorded.
    const other = postgres(POSTGRES_URL as string, { onnotice: () => {} });
    try {
      const rows = await pg.withTransaction(async (tx) => {
        expect((await tx.read('Ghost4', { count: true })).count).toBe(0);
        await new PgDataset({ namespace: NS, sql: other, typeDefLookup }).write('Ghost4', [
          { id: 'k1', a: 'x' }
        ]);
        await tx.tombstone('Ghost4', ['k1']);
        return (await tx.read('Ghost4', { includeDeleted: true })).rows;
      });
      expect(rows.map((x) => [x.id, x._deletedAt !== undefined])).toEqual([['k1', true]]);
    } finally {
      await other.end({ timeout: 5 });
    }
  });

  it('a warm read that matches nothing returns [] in one guarded statement, never retried', async () => {
    await seed();
    await pg.read('Item', {});
    statements = [];
    expect((await pg.read('Item', { where: { title: { eq: 'no such' } } })).rows).toEqual([]);
    expect(statements.map(probes)).toEqual([1]);
  });

  it('a warm walk read and its index plan issue no catalog statement', async () => {
    await seed();
    const catalog = () =>
      // A catalog-version probe (`substrate_type_tables g`) is the read's guard, not a lookup.
      statements.filter((q) => /substrate_type_(tables|fields)(?! g\b)/.test(q));
    const walk = { where: { _walk: { out: 'owner', where: { name: { eq: 'Ann' } } } } };
    await pg.read('Item', walk);
    await pg.indexPlan('Item', NS);
    statements = [];
    await pg.read('Item', walk);
    // Its one statement probes both types' catalog versions (M3, M6).
    expect(statements.map(probes).filter((n) => n > 0)).toEqual([2]);
    expect(await pg.indexPlan('Person', NS)).toBeDefined();
    await pg.indexPlan('Item', NS);
    expect(catalog()).toEqual([]);
  });

  it('a projection returns its keys in request order, not column order (#1861)', async () => {
    await seed();
    // Columns sort by name (meta, n, status, title); `meta` and `tags` sit in `extra`'s place.
    const fields = { title: true, status: true, _metadata: true, n: true, meta: true, id: true };
    const [row] = (await pg.read('Item', { where: { id: { eq: 'i1' } }, fields })).rows;
    expect(Object.keys(row ?? {})).toEqual(['title', 'status', '_metadata', 'n', 'meta', 'id']);
    // Without `id` requested it still leads; unrequested extras (`_metadata`) trail.
    const [bare] = (
      await pg.read('Item', { where: { id: { eq: 'i1' } }, fields: { title: true, n: true } })
    ).rows;
    expect(Object.keys(bare ?? {})).toEqual(['id', 'title', 'n', '_metadata']);
  });

  it('a UUID-check migration applied while running reaches the tables created after it', async () => {
    // A pool of its own, so the check it caches never reaches this suite's tables.
    const own = postgres(POSTGRES_URL as string, { onnotice: () => {} });
    const ds = new PgDataset({ namespace: NS, sql: own, typeDefLookup });
    defs.Before = { fields: { a: field.string() } };
    defs.After = { fields: { a: field.string() } };
    const checked = async (type: string) =>
      (
        await sql`SELECT 1 FROM pg_constraint
                  WHERE conname = 'id_uuid_format' AND conrelid = to_regclass(${(await table(type)).from})`
      ).length === 1;
    try {
      await ds.ensureTypeStorage('Before');
      expect(await checked('Before')).toBe(false);
      await sql`INSERT INTO migrations (version, checksum) VALUES (${UUID_CHECK_MIGRATION}, 'test')`;
      await ds.ensureTypeStorage('After');
      expect(await checked('After')).toBe(true);
    } finally {
      await sql`DELETE FROM migrations WHERE version = ${UUID_CHECK_MIGRATION} AND checksum = 'test'`;
      await own.end({ timeout: 5 });
    }
  });

  it('ensureTypeStorage returns the fields that went pending; [] when none did (F12)', async () => {
    defs.Pend = { fields: { a: field.string() } };
    expect(await pg.ensureTypeStorage('Pend')).toEqual({ pending: [] });
    defs.Pend = { fields: { a: field.string(), b: field.number(), c: field.json() } };
    expect(await pg.ensureTypeStorage('Pend', { newFields: 'pending' })).toEqual({
      pending: ['b']
    });
    expect(await pg.ensureTypeStorage('Pend', { newFields: 'pending' })).toEqual({ pending: [] });
    // A pending field's values live in extra, and read back.
    for (const [, ds] of both())
      await ds.write('Pend', [
        { id: 'x', a: 'a', b: 2 },
        { id: 'y', b: null }
      ]);
    await same('Pend', {}, true);
    await same('Pend', { where: { b: { eq: 2 } } }, true);
  });

  it('updateMany on tables: filter_too_broad and the matched count, as on the old layouts', async () => {
    await seed();
    for (const [name, ds] of both()) {
      const broad = await ds
        .updateWhere('Item', { done: { eq: true } }, { title: 'x' }, { maxMatch: 1 })
        .catch((e: unknown) => e);
      expect(broad, name).toMatchObject({ code: 'filter_too_broad' });
      const ok = await ds.updateWhere(
        'Item',
        { done: { eq: true } },
        { title: 'x', n: null },
        { maxMatch: 2 }
      );
      expect(ok.count, name).toBe(2);
      const gone = await ds.deleteWhere('Item', { status: { eq: 'closed' } }, { maxMatch: 5 });
      expect(gone.ids.sort(), name).toEqual(['i2', 'i5']);
      expect(
        gone.rows.every((r) => r._deletedAt === undefined),
        name
      ).toBe(true);
    }
    await same('Item', {}, true);
  });

  it('patchRows on tables never revives a tombstoned row (F2)', async () => {
    await seed();
    for (const [name, ds] of both()) {
      await ds.tombstone('Item', ['i1']);
      const out = await ds.patchRows(
        'Item',
        [
          { id: 'i1', patch: { title: 'back' } },
          { id: 'i2', patch: { title: 'two', due: null } },
          { id: 'i2', patch: { n: 8 } }
        ],
        { kind: 'agent', id: 'a' },
        new Date('2026-11-01T00:00:00Z')
      );
      expect(
        out.map((r) => r?.id ?? null),
        name
      ).toEqual([null, 'i2', 'i2']);
    }
    await same('Item', { includeDeleted: true }, true);
  });

  /** A stored type-table row as the codec's oracle sees it: columns, dates as UTC text, and `extra`. */
  function storedRow(t: TypeTable) {
    const select = `SELECT id, extra, ${t
      .columns()
      .map((c) =>
        c.kind === 'date'
          ? `to_char(${c.column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${c.column}`
          : c.column
      )
      .join(', ')} FROM ${t.from}`;
    const stored = async (id: string) => {
      const [r] = await sql.unsafe(`${select} WHERE id = $1`, [id]);
      return r as Record<string, unknown>;
    };
    // Dates compare as the column's UTC text, as the oracle sees encodeRow's text.
    const norm = (r: Record<string, unknown>) =>
      Object.fromEntries(
        Object.entries(r).map(([k, v]) => {
          const c = t.columns().find((x) => x.column === k);
          return [k, c?.kind === 'date' && typeof v === 'string' ? new Date(v).toISOString() : v];
        })
      );
    return { stored, norm };
  }

  it('a write racing an uncommitted insert of its id merges over it (conflict arm)', async () => {
    await pg.write('Item', [{ id: 'warm' }]);
    const t = await table('Item');
    const b = { title: 'B', n: 1, meta: { x: 1 }, other: 'kept' };
    const a = { n: 2, status: 'zzz', done: null, more: 3 };
    const blocker = postgres(POSTGRES_URL as string, { max: 1, onnotice: () => {} });
    try {
      let inserted: (tx: postgres.TransactionSql) => void = () => {};
      const ready = new Promise<postgres.TransactionSql>((r) => (inserted = r));
      let release: () => void = () => {};
      const held = new Promise<void>((r) => (release = r));
      const txB = blocker.begin(async (tx) => {
        const dsB = new PgDataset({ namespace: NS, sql: tx, inTx: true, typeDefLookup } as never);
        await dsB.write('Item', [{ id: 'race', ...b }]);
        inserted(tx);
        await held;
      });
      const tx = await ready;
      // A's UPDATE finds no committed row; its INSERT waits on B's uncommitted one.
      const pending = pg.write('Item', [{ id: 'race', ...a }]);
      const deadline = Date.now() + 10_000;
      for (;;) {
        const [w] = await tx<Array<{ n: number }>>`
          SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE pg_backend_pid() = ANY(pg_blocking_pids(pid))`;
        if ((w?.n ?? 0) > 0) break;
        if (Date.now() > deadline) {
          release();
          throw new Error('A never blocked on B');
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      release();
      await txB;
      await pending;
    } finally {
      await blocker.end({ timeout: 5 });
    }
    const { stored, norm } = storedRow(t);
    const want = applyPatch(
      applyPatch({}, encodeRow(t, { id: 'race', ...b })),
      encodeRow(t, { id: 'race', ...a })
    );
    const got = await stored('race');
    expect(norm(got)).toMatchObject(norm(want));
    expect(got.extra).toEqual(want.extra);
  });

  it('the write SQL merges as applyPatch does (seeded random patches)', async () => {
    let seedN = 42;
    const rand = () => {
      seedN = (seedN * 1103515245 + 12345) % 2 ** 31;
      return seedN / 2 ** 31;
    };
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
    const values: Record<string, unknown[]> = {
      title: ['a', 'b', null, 3],
      status: ['open', 'zzz', null],
      n: [1, 2.5, null, 'x'],
      due: ['2026-01-01T00:00:00.000Z', '2026-01-01', null, 'nope'],
      done: [true, false, null],
      owner: ['p1', 7, null],
      meta: [{ a: 1 }, null],
      other: ['o', null],
      more: [1, null]
    };
    await pg.write('Item', [{ id: 'seed' }]);
    const t = await table('Item');
    const { stored, norm } = storedRow(t);
    for (let round = 0; round < 60; round++) {
      const before = await stored('seed');
      const patch: Record<string, unknown> = {};
      for (const [k, vs] of Object.entries(values)) if (rand() < 0.4) patch[k] = pick(vs);
      const encoded = encodeRow(t, patch);
      const want = applyPatch(before, encoded);
      await sql`
        WITH ${inputCte(sql, t, [{ ...encoded, id: 'seed' }])}
        UPDATE ${sql.unsafe(t.from)} t SET ${sql.unsafe(setList(mergeAssignments(t, 't', 'i')))}
        FROM input i WHERE t.id = i.rid`;
      expect(norm(await stored('seed')), JSON.stringify(patch)).toEqual(norm(want));
    }
  });

  describe('misfit values: filter parity (amendment 4, measured)', () => {
    const misfit = async (rows: WriteRow[], where: WhereClause) => {
      for (const [, ds] of both()) await ds.write('Item', rows);
      const ids = async (ds: Dataset) =>
        (await ds.read('Item', { where })).rows.map((r) => r.id).sort();
      return { memory: await ids(mem), pg: await ids(pg) };
    };

    it('an out-of-vocab enum value: eq, neq, in and nin on it', async () => {
      for (const [, ds] of both()) {
        await ds.write('Item', [
          { id: 'm1', status: 'zzz' },
          { id: 'm2', status: 'open' },
          { id: 'm3' }
        ]);
      }
      const cases: Array<[WhereClause, string[]]> = [
        [{ status: { eq: 'zzz' } }, ['m1']],
        [{ status: { in: ['zzz'] } }, ['m1']],
        [{ status: { in: ['zzz', 'open'] } }, ['m1', 'm2']],
        [{ status: { neq: 'zzz' } }, ['m2', 'm3']],
        [{ status: { nin: ['zzz'] } }, ['m2', 'm3']],
        [{ status: { nin: ['zzz', 'open'] } }, ['m3']],
        [{ status: { nin: ['zzz', null] } }, ['m2']],
        [{ NOT: { status: { eq: 'zzz' } } }, ['m2', 'm3']]
      ];
      for (const [where, want] of cases) {
        const rows = await same('Item', { where }, true);
        expect(
          rows.map((r) => r.id),
          JSON.stringify(where)
        ).toEqual(want);
      }
    });

    it("a misfit kind ('5' in a number field): eq, neq, in and nin on it", async () => {
      for (const [, ds] of both()) {
        await ds.write('Item', [{ id: 'm1', n: '5' as never }, { id: 'm2', n: 5 }, { id: 'm3' }]);
      }
      const cases: Array<[WhereClause, string[]]> = [
        [{ n: { eq: '5' } }, ['m1']],
        [{ n: { in: ['5', 5] } }, ['m1', 'm2']],
        [{ n: { neq: '5' } }, ['m2', 'm3']],
        [{ n: { nin: ['5'] } }, ['m2', 'm3']]
      ];
      for (const [where, want] of cases) {
        const rows = await same('Item', { where }, true);
        expect(
          rows.map((r) => r.id),
          JSON.stringify(where)
        ).toEqual(want);
      }
    });

    it('an out-of-vocab enum value: eq null', async () => {
      const r = await misfit([{ id: 'm1', status: 'zzz' }], { status: { eq: null } });
      expect(r.pg).toEqual(r.memory);
    });

    it("a misfit kind ('5' in a number field): eq null", async () => {
      const r = await misfit([{ id: 'm1', n: '5' as never }], { n: { eq: null } });
      expect(r.pg).toEqual(r.memory);
    });

    it('a misfit kind: every null form (neq, in and nin with null)', async () => {
      for (const [, ds] of both()) {
        await ds.write('Item', [{ id: 'm1', n: '5' as never }, { id: 'm2', n: 3 }, { id: 'm3' }]);
      }
      for (const where of [
        { n: { neq: null } },
        { n: { in: [null, 3] } },
        { n: { nin: [null] } },
        { n: { nin: [null, 3] } }
      ] as WhereClause[]) {
        await same('Item', { where }, true);
      }
    });

    it("a misfit kind ('5' in a number field): gt 1", async () => {
      const r = await misfit(
        [
          { id: 'm1', n: '5' as never },
          { id: 'm2', n: 5 }
        ],
        { n: { gt: 1 } }
      );
      expect(r.pg).toEqual(r.memory);
    });

    /** `Gone.drop` promoting, with g1's value a string left in `extra` and g2's a number. */
    const promotingMisfit = async () => {
      for (const [, ds] of both()) {
        await ds.write('Gone', [
          { id: 'g1', drop: 'five' as never },
          { id: 'g2', drop: 5 },
          { id: 'g3', keep: 'k' }
        ]);
      }
      defs.Gone = { fields: { keep: field.string() } };
      await pg.ensureTypeStorage('Gone');
      defs.Gone = { fields: { keep: field.string(), drop: field.number() } };
      await pg.ensureTypeStorage('Gone');
    };

    it('a promoting field whose extra holds another type: eq and gt on the column kind', async () => {
      await promotingMisfit();
      for (const where of [{ drop: { eq: 5 } }, { drop: { gt: 1 } }] as WhereClause[]) {
        await same('Gone', { where }, true);
      }
    });

    it('a promoting field whose extra holds another type: eq and neq on that value', async () => {
      await promotingMisfit();
      for (const where of [{ drop: { eq: 'five' } }, { drop: { neq: 'five' } }] as WhereClause[]) {
        await same('Gone', { where }, true);
      }
    });

    it('a promoting field whose extra holds another type: eq null', async () => {
      await promotingMisfit();
      await same('Gone', { where: { drop: { eq: null } } }, true);
    });
  });

  it('a narrowed enum vocabulary still lets a row holding a dropped value update (amendment 5)', async () => {
    for (const [, ds] of both()) await ds.write('Vocab', [{ id: 'v1', status: 'b', note: 'x' }]);
    defs.Vocab = { fields: { status: field.enum(['a']), note: field.string() } };
    await pg.ensureTypeStorage('Vocab');
    for (const [, ds] of both()) {
      await ds.write('Vocab', [{ id: 'v1', note: 'y' }]);
      await ds.write('Vocab', [{ id: 'v2', status: 'b' }]);
    }
    await same('Vocab', {}, true);
    await same('Vocab', { where: { status: { eq: 'b' } } }, true);
    // Widening again keeps 'b' admitted.
    defs.Vocab = { fields: { status: field.enum(['a', 'c']), note: field.string() } };
    await pg.ensureTypeStorage('Vocab');
    for (const [, ds] of both()) await ds.write('Vocab', [{ id: 'v1', note: 'z' }]);
    await same('Vocab', {}, true);
  });
});
