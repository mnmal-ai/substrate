/**
 * `describeStorage` and `storageReport`: what an operator reads about where a
 * type lives and what needs attention. Both only read the catalog.
 */

import { randomBytes } from 'node:crypto';
import type { FieldDef } from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgDataset } from '../src/index.js';
import { generatedIdentifier } from '../src/migrate.js';

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
    typeDefLookup: (type) => (type === TYPE ? { fields: defs.current } : undefined)
  });
}

const indexed: Record<string, FieldDef> = {
  kid: { kind: 'scalar', type: 'string', indexed: true }
};

describe.skipIf(!POSTGRES_URL)(`describeStorage (${LAYOUT})`, () => {
  it('reports the layout, the partition and a valid declared index', async () => {
    const ns = freshNs();
    const ds = dataset(ns, { current: indexed });
    await ds.ensureTypeStorage(TYPE);
    const report = await ds.describeStorage(TYPE);
    expect(report.layout).toBe(LAYOUT);
    expect(report.partition !== undefined).toBe(LAYOUT === 'partitioned');
    if (LAYOUT === 'partitioned') {
      const name = generatedIdentifier(ns, TYPE, 'kid', 'idx');
      expect(report.indexes.find((i) => i.name === name)).toMatchObject({
        fields: ['kid'],
        state: 'valid'
      });
    } else {
      expect(report.indexes).toEqual([]);
    }
  });

  it('builds nothing: a type never ensured has no partition and no indexes', async () => {
    if (LAYOUT !== 'partitioned') return;
    const ns = freshNs();
    const report = await dataset(ns, { current: indexed }).describeStorage(TYPE);
    expect(report.partition).toBeUndefined();
    expect(report.indexes).toEqual([]);
  });
});

describe.skipIf(!POSTGRES_URL || LAYOUT !== 'partitioned')('storageReport (partitioned)', () => {
  it('names an engine index that is no longer declared, and keeps it', async () => {
    const ns = freshNs();
    const defs = { current: indexed };
    const ds = dataset(ns, defs);
    await ds.ensureTypeStorage(TYPE);
    defs.current = { kid: { kind: 'scalar', type: 'string' } };
    await ds.ensureTypeStorage(TYPE);

    const name = generatedIdentifier(ns, TYPE, 'kid', 'idx');
    const [held] = await sql`SELECT 1 FROM pg_class WHERE relname = ${name}`;
    expect(held).toBeDefined();
    const { warnings } = await ds.storageReport({ partitionBudget: BIG });
    expect(warnings).toContain(`undeclared index ${name} on ${ns}/${TYPE}: drop it explicitly`);
  });

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
  it('never warns', async () => {
    const ds = dataset(freshNs(), { current: {} });
    expect(await ds.storageReport({ partitionBudget: 0 })).toEqual({
      layout: 'legacy',
      warnings: []
    });
  });
});
