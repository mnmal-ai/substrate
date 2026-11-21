/** Walk aggregates over integer fields in the memory reference: exact int64 sums, avg as a number. */

import type { FieldDef, WhereClause } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { MemoryDataset } from '../src/index.js';

const int = (type: 'int16' | 'int32' | 'int64'): FieldDef => ({ kind: 'scalar', type });
const SCHEMA: Record<string, Record<string, FieldDef>> = {
  Customer: { name: { kind: 'scalar', type: 'string' } },
  Payment: {
    customer: { kind: 'crossRef', ns: 'shop', type: 'Customer', onDelete: 'set_null' },
    amount: int('int64'),
    qty: int('int32'),
    small: int('int16')
  }
};
const fieldDefLookup = (type: string, field: string): FieldDef | undefined => SCHEMA[type]?.[field];

const IN = 'shop/Payment.customer';

async function dataset(): Promise<MemoryDataset> {
  const ds = new MemoryDataset({ namespace: 'shop', fieldDefLookup, walkReference: true });
  await ds.write('Customer', [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }] as never);
  await ds.write('Payment', [
    { id: 'p1', customer: 'c1', amount: 9007199254740993n, qty: 1, small: -4 },
    { id: 'p2', customer: 'c1', amount: 1n, qty: 2, small: 7 },
    { id: 'p3', customer: 'c2', amount: 50n, qty: 5, small: 1 }
  ] as never);
  return ds;
}

describe('walk aggregates over integer fields (memory)', () => {
  it('sums an int64 exactly, averages as a number, and keeps min/max kinds', async () => {
    const ds = await dataset();
    const res = await ds.read('Customer', {
      orderBy: [{ id: 'asc' }],
      agg: {
        total: { in: IN, sum: 'amount' },
        qtySum: { in: IN, sum: 'qty' },
        qtyAvg: { in: IN, avg: 'qty' },
        amountMax: { in: IN, max: 'amount' },
        smallMin: { in: IN, min: 'small' }
      }
    });
    expect(res.rows.map((r) => r._agg)).toEqual([
      {
        total: 9007199254740994n,
        qtySum: 3n,
        qtyAvg: 1.5,
        amountMax: 9007199254740993n,
        smallMin: -4
      },
      { total: 50n, qtySum: 5n, qtyAvg: 5, amountMax: 50n, smallMin: 1 },
      { total: null, qtySum: null, qtyAvg: null, amountMax: null, smallMin: null }
    ]);
  });

  it('filters on an int64 aggregate with an int64 operand', async () => {
    const ds = await dataset();
    const where = (gte: string) =>
      ({ _agg: { in: IN, sum: 'amount' }, gte }) as unknown as WhereClause;
    const ids = async (w: WhereClause) =>
      (await ds.read('Customer', { where: w })).rows.map((r) => r.id).sort();
    expect(await ids(where('100'))).toEqual(['c1']);
    expect(await ids(where('9007199254740994'))).toEqual(['c1']);
    expect(await ids(where('9007199254740995'))).toEqual([]);
    expect(await ids(where('50'))).toEqual(['c1', 'c2']);
  });
});
