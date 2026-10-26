/**
 * `describeStorage` and `storageReport`: what an operator reads about where a
 * type lives and what needs attention. Both only read the catalog.
 */

import { randomBytes } from 'node:crypto';
import type { FieldDef, StorageReport } from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgDataset } from '../src/index.js';
import { heldIndexes, isEngineOwned } from '../src/index-reconciler.js';
import { generatedIdentifier } from '../src/migrate.js';
import { LEGACY_PARTIAL_INDEX_LIMIT } from '../src/pg-dataset.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const LAYOUT = process.env.SUBSTRATE_STORAGE_LAYOUT ?? 'legacy';
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

/** The legacy planning-cost warning, which depends on every type's indexes on the shared rows. */
const PLANNING = /engine-owned partial indexes on the shared rows table/;

const indexed: Record<string, FieldDef> = {
  kid: { kind: 'scalar', type: 'string', indexed: true }
};

describe.skipIf(!POSTGRES_URL)('describeStorage', () => {
  it('reports the layout, the partition and a valid declared index', async () => {
    const ns = freshNs();
    const ds = dataset(ns, { current: indexed });
    await ds.ensureTypeStorage(TYPE);
    const report = await ds.describeStorage(TYPE);
    expect(report.layout).toBe(LAYOUT);
    expect(report.partition !== undefined).toBe(LAYOUT === 'partitioned');
    // Spec rule (derived indexes, both layouts): legacy builds the derived
    // index too, as a partial index on `rows`, so both layouts report it.
    const name = generatedIdentifier(ns, TYPE, 'kid', 'idx');
    expect(report.indexes.find((i) => i.name === name)).toMatchObject({
      fields: ['kid'],
      state: 'valid'
    });
  });

  it('builds nothing: a type never ensured has no partition and no indexes', async () => {
    if (LAYOUT !== 'partitioned') return;
    const ns = freshNs();
    const report = await dataset(ns, { current: indexed }).describeStorage(TYPE);
    expect(report.partition).toBeUndefined();
    expect(report.indexes).toEqual([]);
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
    if (LAYOUT === 'partitioned') await system.ensureTypeStorage('IndexRecommendation');
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

describe.skipIf(!POSTGRES_URL || LAYOUT !== 'partitioned')('storageReport (partitioned)', () => {
  it('warns about an index on the rows parent', async () => {
    const ns = freshNs();
    const ds = dataset(ns, { current: {} });
    const idx = `rows_parent_probe_${randomBytes(4).toString('hex')}`;
    await sql.unsafe(`CREATE INDEX ${idx} ON rows (id)`);
    try {
      const { warnings } = await ds.storageReport({ partitionBudget: BIG });
      expect(warnings.some((w) => w.startsWith(`index ${idx} is on the rows parent`))).toBe(true);
    } finally {
      await sql.unsafe(`DROP INDEX ${idx}`);
    }
  });

  it("warns about a plugin CHECK on the rows parent, not the engine's own", async () => {
    const ds = dataset(freshNs(), { current: {} });
    const check = `rows_parent_check_${randomBytes(4).toString('hex')}`;
    await sql.unsafe(`ALTER TABLE rows ADD CONSTRAINT ${check} CHECK (type <> '') NOT VALID`);
    try {
      const { warnings } = await ds.storageReport({ partitionBudget: BIG });
      expect(warnings).toContain(
        `check ${check} is on the rows parent: every partition carries it, and every write evaluates it`
      );
      expect(warnings.some((w) => w.includes('rows_created_by_kind_check'))).toBe(false);
    } finally {
      await sql.unsafe(`ALTER TABLE rows DROP CONSTRAINT ${check}`);
    }
  });

  it('reads the catalog in a fixed number of queries however many partitions exist', async () => {
    let queries = 0;
    const counting = postgres(POSTGRES_URL as string, {
      onnotice: () => {},
      debug: () => {
        queries++;
      }
    });
    try {
      const measure = async (types: number): Promise<number> => {
        const ns = freshNs();
        const names = Array.from({ length: types }, (_, i) => `T${i}`);
        const ds = new PgDataset({
          namespace: ns,
          sql: counting,
          typeDefLookup: () => ({ fields: indexed })
        });
        for (const t of names) await ds.ensureTypeStorage(t);
        queries = 0;
        await ds.storageReport({ partitionBudget: BIG });
        return queries;
      };
      const few = await measure(2);
      const many = await measure(10);
      expect(many).toBe(few);
    } finally {
      await counting.end({ timeout: 5 });
    }
  });

  it('warns once the partition count exceeds the budget, and not at it', async () => {
    const ns = freshNs();
    const ds = dataset(ns, { current: {} });
    await ds.ensureTypeStorage(TYPE);
    const [count] = await sql<Array<{ n: number }>>`
      SELECT (count(*) - 1)::int AS n FROM pg_partition_tree('rows')`;
    const n = count?.n as number;
    const at = await ds.storageReport({ partitionBudget: n });
    expect(at.warnings.some((w) => w.includes('exceed the budget'))).toBe(false);
    const over = await ds.storageReport({ partitionBudget: n - 1 });
    expect(over.warnings).toContain(
      `${n} partitions exceed the budget of ${n - 1}: move a namespace to its own instance behind a bridge`
    );
  });
});

describe.skipIf(!POSTGRES_URL || LAYOUT !== 'legacy')('storageReport (legacy)', () => {
  it('has no partition or parent warnings', async () => {
    const ds = dataset(freshNs(), { current: {} });
    const report = await ds.storageReport({ partitionBudget: 0 });
    expect(report.layout).toBe('legacy');
    expect(report.warnings.filter((w) => !PLANNING.test(w))).toEqual([]);
  });

  it('warns once rows carries more engine-owned partial indexes than the planning limit', async () => {
    const ns = freshNs();
    const ds = dataset(ns, { current: {} });
    const count = async () =>
      (await heldIndexes(sql, ['rows'])).filter((i) => isEngineOwned(i) && i.predicate !== null)
        .length;
    const made: string[] = [];
    try {
      for (let i = await count(); i <= LEGACY_PARTIAL_INDEX_LIMIT; i++) {
        const name = generatedIdentifier(ns, `T${i}`, 'f', 'idx');
        await sql.unsafe(
          `CREATE INDEX ${name} ON rows (id) WHERE namespace = '${ns}' AND type = 'T${i}'`
        );
        await sql.unsafe(`COMMENT ON INDEX ${name} IS 'substrate: reconciled'`);
        made.push(name);
      }
      const n = await count();
      expect(n).toBeGreaterThan(LEGACY_PARTIAL_INDEX_LIMIT);
      const { warnings } = await ds.storageReport({ partitionBudget: BIG });
      expect(warnings.filter((w) => PLANNING.test(w))).toEqual([
        `${n} engine-owned partial indexes on the shared rows table, over ${LEGACY_PARTIAL_INDEX_LIMIT}: ` +
          'every query on rows pays planning time for each; the partitioned layout gives each type its own table and indexes'
      ]);
    } finally {
      for (const name of made) await sql.unsafe(`DROP INDEX IF EXISTS ${name}`);
    }
  });
});
