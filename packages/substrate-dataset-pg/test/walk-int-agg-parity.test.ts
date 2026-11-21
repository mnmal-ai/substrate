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
    small: int('int16'),
    paidAt: { kind: 'scalar', type: 'date' }
  },
  Line: {
    payment: { kind: 'crossRef', ns: NS, type: 'Payment', onDelete: 'set_null' },
    cents: int('int64')
  },
  Safe: { name: { kind: 'scalar', type: 'string' } },
  Deposit: {
    safe: { kind: 'crossRef', ns: NS, type: 'Safe', onDelete: 'set_null' },
    amount: int('int64')
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
    {
      id: 'p1',
      customer: 'c1',
      amount: 9007199254740993n,
      qty: 1,
      small: -4,
      paidAt: '2026-02-01T00:00:00.000Z'
    },
    { id: 'p2', customer: 'c1', amount: 1n, qty: 2, small: 7, paidAt: '2026-01-01T00:00:00.000Z' },
    { id: 'p3', customer: 'c2', amount: 50n, qty: 5, small: 1, paidAt: '2026-03-01T00:00:00.000Z' }
  ].map((p) => ({ ...p, id: u(p.id), customer: u(p.customer) }));
  const lines = [
    { id: 'l1', payment: 'p1', cents: 9007199254740993n },
    { id: 'l2', payment: 'p1', cents: 1n },
    { id: 'l3', payment: 'p2', cents: 5n }
  ].map((l) => ({ ...l, id: u(l.id), payment: u(l.payment) }));
  // A safe whose deposits sum past the int64 range.
  const deposits = [
    { id: 'd1', safe: 's1', amount: 9223372036854775807n },
    { id: 'd2', safe: 's1', amount: 1n }
  ].map((d) => ({ ...d, id: u(d.id), safe: u(d.safe) }));
  for (const ds of [pg, mem]) {
    await ds.write('Customer', customers);
    await ds.write('Payment', payments as never);
    await ds.write('Line', lines as never);
    await ds.write('Safe', [{ id: u('s1') }] as never);
    await ds.write('Deposit', deposits as never);
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

  it('selects and orders by an integer avg, the integer _agg an expression can read', async () => {
    for (const [dir, want] of [
      [
        'asc',
        [
          ['c1', 1.5, 0.75],
          ['c2', 5, 2.5],
          ['c3', null, null]
        ]
      ],
      [
        'desc',
        [
          ['c2', 5, 2.5],
          ['c1', 1.5, 0.75],
          ['c3', null, null]
        ]
      ]
    ] as const) {
      const params: ReadParams = {
        agg: agg({ mean: { in: IN, avg: 'qty' } }),
        select: { m: '_agg.mean', half: { div: ['_agg.mean', 2] } },
        orderBy: [{ m: dir }]
      };
      const read = async (ds: PgDataset | MemoryDataset) =>
        (await ds.read('Customer', params)).rows.map((r) => [
          [...ids].find(([, id]) => id === r.id)?.[0],
          r.m,
          r.half
        ]);
      const m = await read(mem);
      expect(await read(pg), dir).toEqual(m);
      expect(m, dir).toEqual(want);
    }
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

  it('reads the int64 sum of a nested selection as the same bigint', async () => {
    const params: ReadParams = {
      orderBy: [{ id: 'asc' }],
      nested: {
        pays: {
          _walk: { in: IN },
          fields: { id: true, _agg: { cents: { in: `${NS}/Line.payment`, sum: 'cents' } } },
          orderBy: [{ id: 'asc' }]
        }
      } as unknown as NonNullable<ReadParams['nested']>
    };
    const read = async (ds: PgDataset | MemoryDataset) =>
      (await ds.read('Customer', params)).rows.map((r) =>
        ((r.pays ?? []) as Array<{ id: string; _agg: unknown }>).map((p) => p._agg)
      );
    const want = await read(mem);
    expect(await read(pg)).toEqual(want);
    expect(
      want
        .flat()
        .map((a) => (a as { cents: unknown }).cents)
        .sort()
    ).toEqual([5n, 9007199254740994n, null].sort());
  });

  it('reads an int64 field of a nested selection as the same bigint', async () => {
    const params: ReadParams = {
      orderBy: [{ id: 'asc' }],
      nested: {
        pays: {
          _walk: { in: IN },
          fields: { id: true, amount: true, qty: true },
          orderBy: [{ id: 'asc' }]
        }
      } as unknown as NonNullable<ReadParams['nested']>
    };
    const read = async (ds: PgDataset | MemoryDataset) =>
      (await ds.read('Customer', params)).rows.map((r) =>
        ((r.pays ?? []) as Array<{ amount: unknown; qty: unknown }>).map((p) => [p.amount, p.qty])
      );
    const want = await read(mem);
    expect(await read(pg)).toEqual(want);
    expect(want.flat().map(([a]) => a)).toContain(9007199254740993n);
  });

  it('a latest over an int64 field is the same bigint', async () => {
    expect(await aggs({ last: { in: IN, latest: { by: 'paidAt', value: 'amount' } } })).toEqual({
      c1: { last: 9007199254740993n },
      c2: { last: 50n },
      c3: { last: null }
    });
  });

  it('raises value_out_of_range for a sum past int64 on both stores', async () => {
    const params: ReadParams = {
      agg: agg({ total: { in: `${NS}/Deposit.safe`, sum: 'amount' } })
    };
    for (const ds of [mem, pg]) {
      await expect(ds.read('Safe', params)).rejects.toMatchObject({ code: 'value_out_of_range' });
    }
  });
});
