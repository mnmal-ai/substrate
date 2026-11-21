/**
 * Walk aggregates over integer fields (sum, avg, min, max) through pg and the
 * memory reference, which must agree: an int64 sum is exact (never through
 * float8), avg is a number, an empty walk is null. Skipped without POSTGRES_URL.
 */

import { randomUUID } from 'node:crypto';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import type { FieldDef, ReadParams, WhereClause } from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgDataset } from '../src/index.js';
import { dropNamespace } from './_layout.js';
import { strip } from './_walk-helpers.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const NS = `wint_${randomUUID().slice(0, 8)}`;
const int = (type: 'int16' | 'int32' | 'int64'): FieldDef => ({ kind: 'scalar', type });
const defs: Record<string, Record<string, FieldDef>> = {
  Customer: { name: { kind: 'scalar', type: 'string' } },
  Payment: {
    customer: { kind: 'crossRef', ns: NS, type: 'Customer', onDelete: 'set_null' },
    amount: int('int64'),
    qty: int('int32'),
    small: int('int16')
  }
};
const lookup = {
  fieldDefLookup: (type: string, f: string) => defs[type]?.[f],
  typeDefLookup: (type: string) => (defs[type] ? { fields: defs[type] } : undefined)
};

const ids = new Map<string, string>();
const u = (name: string): string => {
  let id = ids.get(name);
  if (id === undefined) {
    id = randomUUID();
    ids.set(name, id);
  }
  return id;
};

const IN = `${NS}/Payment.customer`;
const agg = (a: Record<string, unknown>) => a as unknown as NonNullable<ReadParams['agg']>;

let sql: Sql;
let pg: PgDataset;
let mem: MemoryDataset;

beforeAll(async () => {
  if (!POSTGRES_URL) return;
  sql = postgres(POSTGRES_URL, { onnotice: () => {} });
  pg = new PgDataset({ namespace: NS, sql, ...lookup });
  mem = new MemoryDataset({ namespace: NS, ...lookup, walkReference: true });
  for (const type of Object.keys(defs)) await pg.ensureTypeStorage(type);
  const customers = ['c1', 'c2', 'c3'].map((id) => ({ id: u(id) }));
  const payments = [
    { id: 'p1', customer: 'c1', amount: 9007199254740993n, qty: 1, small: -4 },
    { id: 'p2', customer: 'c1', amount: 1n, qty: 2, small: 7 },
    { id: 'p3', customer: 'c2', amount: 50n, qty: 5, small: 1 }
  ].map((p) => ({ ...p, id: u(p.id), customer: u(p.customer) }));
  for (const ds of [pg, mem]) {
    await ds.write('Customer', customers);
    await ds.write('Payment', payments as never);
  }
});

afterAll(async () => {
  if (!POSTGRES_URL) return;
  await dropNamespace(sql, NS);
  await sql.end({ timeout: 5 });
});

/** Each customer's `_agg` by label, asserting pg and memory agree. */
async function aggs(a: Record<string, unknown>) {
  const params: ReadParams = { orderBy: [{ id: 'asc' }], agg: agg(a) };
  const read = async (ds: PgDataset | MemoryDataset) =>
    Object.fromEntries(
      (await ds.read('Customer', params)).rows.map((r) => [
        [...ids].find(([, id]) => id === r.id)?.[0],
        strip(r)._agg
      ])
    );
  const want = await read(mem);
  expect(await read(pg)).toEqual(want);
  return want;
}

describe.skipIf(!POSTGRES_URL)('walk aggregates over integers: pg and memory agree', () => {
  it('sums an int64 exactly past 2^53, none is null', async () => {
    expect(await aggs({ total: { in: IN, sum: 'amount' } })).toEqual({
      c1: { total: 9007199254740994n },
      c2: { total: 50n },
      c3: { total: null }
    });
  });

  it('averages an int32 as a number, an empty walk is null', async () => {
    expect(await aggs({ mean: { in: IN, avg: 'qty' } })).toEqual({
      c1: { mean: 1.5 },
      c2: { mean: 5 },
      c3: { mean: null }
    });
  });

  it('min and max keep the field kind; an int32 sum is an int64', async () => {
    expect(
      await aggs({
        hi: { in: IN, max: 'amount' },
        lo: { in: IN, min: 'small' },
        units: { in: IN, sum: 'qty' }
      })
    ).toEqual({
      c1: { hi: 9007199254740993n, lo: -4, units: 3n },
      c2: { hi: 50n, lo: 1, units: 5n },
      c3: { hi: null, lo: null, units: null }
    });
  });

  it('filters on an int64 aggregate with an int64 operand', async () => {
    const labelled = (rows: Array<{ id?: unknown }>) =>
      rows.map((r) => [...ids].find(([, id]) => id === r.id)?.[0]).sort();
    for (const [op, operand, want] of [
      ['gte', '100', ['c1']],
      ['gte', '9007199254740994', ['c1']],
      ['gt', '9007199254740994', []],
      ['lte', '50', ['c2']],
      ['eq', 50, ['c2']]
    ] as const) {
      const where = { _agg: { in: IN, sum: 'amount' }, [op]: operand } as unknown as WhereClause;
      const m = labelled((await mem.read('Customer', { where })).rows);
      expect(labelled((await pg.read('Customer', { where })).rows), `${op} ${operand}`).toEqual(m);
      expect(m).toEqual(want);
    }
  });
});
