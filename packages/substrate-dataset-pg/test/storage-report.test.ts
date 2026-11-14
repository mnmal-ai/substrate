/**
 * `describeStorage` and `storageReport`: what an operator reads about where a
 * type lives and what needs attention. Both only read the catalog.
 */

import { randomBytes } from 'node:crypto';
import { field } from '@mnmal-ai/substrate-sdk';
import type { FieldDef, IndexDecl, StorageReport } from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgDataset } from '../src/index.js';
import { generatedIdentifier } from '../src/migrate.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const TYPE = 'T';
const BIG = 1_000_000;

let sql: Sql;

beforeAll(async () => {
  if (POSTGRES_URL) sql = postgres(POSTGRES_URL, { onnotice: () => {} });
});

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

const freshNs = () => `sr_${randomBytes(4).toString('hex')}`;

/** A dataset whose type `T` has one field, indexed or not as `defs` says. */
function dataset(ns: string, defs: { current: Record<string, FieldDef> }): PgDataset {
  return new PgDataset({
    namespace: ns,
    sql,
    typeDefLookup: (type, namespace) =>
      type === TYPE && namespace === ns ? { fields: defs.current } : undefined
  });
}

/** The undeclared indexes of `ns` a report names: in `info`, never in `warnings`. */
const undeclaredIn = (report: StorageReport, ns: string): string[] => {
  const named = (lines: string[]) =>
    lines.flatMap((w) => {
      const m = /^undeclared index (\S+) on (\S+)\/\S+: /.exec(w);
      return m?.[2] === ns ? [m[1] as string] : [];
    });
  expect(named(report.warnings)).toEqual([]);
  return named(report.info ?? []);
};

const indexed: Record<string, FieldDef> = {
  kid: { kind: 'scalar', type: 'string', indexed: true }
};

describe.skipIf(!POSTGRES_URL)('describeStorage', () => {
  it('reports the layout, the table and a valid declared index', async () => {
    const ns = freshNs();
    const ds = dataset(ns, { current: indexed });
    await ds.ensureTypeStorage(TYPE);
    const report = await ds.describeStorage(TYPE);
    expect(report.layout).toBe('tables');
    expect(report.table).toBeDefined();
    const name = generatedIdentifier(ns, TYPE, 'kid', 'idx');
    expect(report.indexes.find((i) => i.name === name)).toMatchObject({
      fields: ['kid'],
      state: 'valid'
    });
  });

  it('builds nothing: a type never ensured has no table and no indexes', async () => {
    const ns = freshNs();
    const report = await dataset(ns, { current: indexed }).describeStorage(TYPE);
    expect(report.table).toBeUndefined();
    expect(report.indexes).toEqual([]);
  });

  it('describeStorage lists pending and orphaned fields', async () => {
    const ns = freshNs();
    const defs: { current: Record<string, FieldDef> } = {
      current: { a: { kind: 'scalar', type: 'string' }, b: { kind: 'scalar', type: 'number' } }
    };
    const ds = dataset(ns, defs);
    await ds.ensureTypeStorage(TYPE);
    expect(await ds.describeStorage(TYPE)).toMatchObject({ pending: [], orphaned: [] });
    defs.current = { a: { kind: 'scalar', type: 'string' }, c: { kind: 'scalar', type: 'date' } };
    await ds.ensureTypeStorage(TYPE, { newFields: 'pending' });
    const report = await ds.describeStorage(TYPE);
    expect(report).toMatchObject({ layout: 'tables', pending: ['c'], orphaned: ['b'] });
    expect(report.table).toMatch(/^t__sr_/);
  });

  it('an index over a field not yet `column` is pending, not valid or failed, and serves no read', async () => {
    const ns = freshNs();
    const uniq = `rows_sr_u_${randomBytes(4).toString('hex')}`;
    const plain = `rows_sr_p_${randomBytes(4).toString('hex')}`;
    const late = `rows_sr_l_${randomBytes(4).toString('hex')}`;
    const defs: { current: Record<string, FieldDef> } = {
      current: { a: { kind: 'scalar', type: 'string' } }
    };
    let indexes: IndexDecl[] = [];
    const ds = new PgDataset({
      namespace: ns,
      sql,
      typeDefLookup: (type, namespace) =>
        type === TYPE && namespace === ns ? { fields: defs.current, indexes } : undefined
    });
    await ds.ensureTypeStorage(TYPE);
    // Added to an existing table, `b` gets its column `promoting`; `c` is recorded `pending`.
    defs.current = { ...defs.current, b: { kind: 'scalar', type: 'string' } };
    indexes = [
      { fields: ['b'], unique: true, name: uniq },
      { fields: ['b'], name: plain }
    ];
    await ds.ensureTypeStorage(TYPE);
    defs.current = { ...defs.current, c: { kind: 'scalar', type: 'string' } };
    indexes = [...indexes, { fields: ['c'], name: late }];
    await ds.ensureTypeStorage(TYPE, { newFields: 'pending' });
    // As another process sees it: no deferred-build record of its own.
    const other = postgres(POSTGRES_URL as string, { onnotice: () => {} });
    try {
      const fresh = new PgDataset({
        namespace: ns,
        sql: other,
        typeDefLookup: () => ({ fields: defs.current, indexes })
      });
      const states = async (d: PgDataset) =>
        Object.fromEntries((await d.describeStorage(TYPE)).indexes.map((i) => [i.name, i.state]));
      for (const d of [ds, fresh]) {
        expect(await states(d)).toMatchObject({
          [uniq]: 'pending',
          [plain]: 'pending',
          [late]: 'pending'
        });
      }
      const planned = async () =>
        ((await fresh.indexPlan(TYPE, ns))?.indexes ?? []).map((i) => i.name);
      expect(await planned()).not.toContain(plain);
      expect(await planned()).not.toContain(uniq);
      // The sweep settles `b` (Task 13): then its indexes are valid and serve reads.
      // As `moveFieldState` does: the state change and its catalog notification.
      await sql`UPDATE substrate_type_fields SET state = 'column' WHERE namespace = ${ns} AND field = 'b'`;
      await sql`SELECT pg_notify('substrate_catalog', ${`${ns}/${TYPE}`})`;
      expect(await states(fresh)).toMatchObject({
        [uniq]: 'valid',
        [plain]: 'valid',
        [late]: 'pending'
      });
      // indexPlan reads through the TableCache, which drops the table when the notification lands.
      await expect.poll(planned).toEqual(expect.arrayContaining([uniq, plain]));
    } finally {
      await other.end({ timeout: 5 });
    }
  });
});

describe.skipIf(!POSTGRES_URL)('storageReport', () => {
  it('notes an engine index that is no longer declared as info, and keeps it', async () => {
    const ns = freshNs();
    const defs = { current: indexed };
    const ds = dataset(ns, defs);
    await ds.ensureTypeStorage(TYPE);
    defs.current = { kid: { kind: 'scalar', type: 'string' } };
    await ds.ensureTypeStorage(TYPE);

    const name = generatedIdentifier(ns, TYPE, 'kid', 'idx');
    const [held] = await sql`SELECT 1 FROM pg_class WHERE relname = ${name}`;
    expect(held).toBeDefined();
    expect(undeclaredIn(await ds.storageReport({ partitionBudget: BIG }), ns)).toEqual([name]);
  });

  it('tells two types apart whose index names fold alike, and finds a truncated name', async () => {
    // `X_a`/`b_c` and `X_a_b`/`c` both fold to the prefix `rows_x_a_b_c_`.
    const tag = randomBytes(3).toString('hex');
    const long = `T${'x'.repeat(60)}`;
    const types = [
      { ns: `sr${tag}_a`, type: 'b_c' },
      { ns: `sr${tag}_a_b`, type: 'c' },
      { ns: `sr${tag}_l`, type: long }
    ];
    const current = new Map(types.map((t) => [`${t.ns}/${t.type}`, indexed]));
    const ds = (ns: string): PgDataset =>
      new PgDataset({
        namespace: ns,
        sql,
        typeDefLookup: (type, namespace) => {
          const fields = current.get(`${namespace}/${type}`);
          return fields === undefined ? undefined : { fields };
        }
      });
    for (const t of types) await ds(t.ns).ensureTypeStorage(t.type);
    const [kept, retracted, truncated] = types as [
      (typeof types)[0],
      (typeof types)[0],
      (typeof types)[0]
    ];
    current.set(`${retracted.ns}/${retracted.type}`, {});
    current.set(`${truncated.ns}/${truncated.type}`, {});

    const report = await ds(kept.ns).storageReport({ partitionBudget: BIG });
    const name = (t: { ns: string; type: string }): string =>
      generatedIdentifier(t.ns, t.type, 'kid', 'idx');
    expect(name(truncated).length).toBeLessThanOrEqual(63);
    expect(undeclaredIn(report, kept.ns)).toEqual([]);
    expect(undeclaredIn(report, retracted.ns)).toEqual([name(retracted)]);
    expect(undeclaredIn(report, truncated.ns)).toEqual([name(truncated)]);
  });

  it('counts open index recommendations as info, never as a warning', async () => {
    const ds = dataset(freshNs(), { current: {} });
    const system = new PgDataset({ namespace: '_system', sql });
    const id = `rec_${randomBytes(4).toString('hex')}`;
    const before = await ds.storageReport({ partitionBudget: BIG });
    const count = (info: string[] | undefined): number =>
      Number(/^(\d+) open index recommendation/.exec(info?.[0] ?? '')?.[1] ?? 0);
    await system.write('IndexRecommendation', [{ id, state: 'open' }]);
    try {
      const after = await ds.storageReport({ partitionBudget: BIG });
      expect(count(after.info)).toBe(count(before.info) + 1);
      expect(after.warnings.some((w) => w.includes('recommendation'))).toBe(false);
    } finally {
      await system.purge('IndexRecommendation', [id]);
    }
  });
});

describe.skipIf(!POSTGRES_URL)('storageReport (tables)', () => {
  it('counts type tables against the partition budget', async () => {
    const ds = dataset(freshNs(), { current: {} });
    await ds.ensureTypeStorage(TYPE);
    const [count] = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM substrate_type_tables`;
    const n = count?.n as number;
    const at = await ds.storageReport({ partitionBudget: n });
    expect(at.layout).toBe('tables');
    expect(at.warnings.some((w) => w.includes('exceed the budget'))).toBe(false);
    const over = await ds.storageReport({ partitionBudget: n - 1 });
    expect(over.warnings).toContain(
      `${n} type tables exceed the budget of ${n - 1}: move a namespace to its own instance behind a bridge`
    );
  });

  it('counts misfits per type and field as info, and /health counts them without names', async () => {
    const ns = freshNs();
    const ds = dataset(ns, { current: { status: field.enum(['a']) } });
    await ds.ensureTypeStorage(TYPE);
    await ds.write(TYPE, [
      { id: 'm1', status: 'zzz' },
      { id: 'm2', status: 'yyy' },
      { id: 'm3', status: 'a' },
      { id: 'm4', status: 'zzz' }
    ]);
    await ds.tombstone(TYPE, ['m4']);
    const line = `${ns}/${TYPE}.status has 2 misfits kept under $raw: the column holds NULL for them, so its index does not serve them; write the field again or widen its vocabulary`;
    const report = await ds.storageReport({ partitionBudget: BIG });
    expect(report.info).toContain(line);
    expect(report.warnings.join('\n')).not.toContain(ns);
    // The report's fresh count is what /health reuses.
    const [health] = await ds.fieldWarnings();
    expect(health).toMatch(/\b\d+ misfits? kept under \$raw\b.* — see the storage report$/);
    expect(health).not.toContain(ns);
  });
});
