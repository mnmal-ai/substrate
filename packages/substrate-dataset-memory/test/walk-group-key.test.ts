/**
 * A frame aggregate grouped by a field of the row an out-walk reaches, in the
 * memory reference: a null, dangling or tombstoned crossRef keys its seed row
 * under null, and the row is still counted.
 */

import type { FieldDef, ReadParams } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { MemoryDataset } from '../src/index.js';

const SCHEMA: Record<string, Record<string, FieldDef>> = {
  Customer: {
    region: { kind: 'scalar', type: 'string' },
    signedUpAt: { kind: 'scalar', type: 'date' }
  },
  Invoice: {
    customer: { kind: 'crossRef', ns: 'shop', type: 'Customer', onDelete: 'set_null' },
    amount: { kind: 'scalar', type: 'int64' },
    status: { kind: 'scalar', type: 'string' }
  }
};
const fieldDefLookup = (type: string, field: string): FieldDef | undefined => SCHEMA[type]?.[field];

async function dataset(): Promise<MemoryDataset> {
  const ds = new MemoryDataset({ namespace: 'shop', fieldDefLookup, walkReference: true });
  await ds.write('Customer', [
    { id: 'c1', region: 'north', signedUpAt: '2026-01-15T10:00:00Z' },
    { id: 'c2', region: 'south', signedUpAt: '2026-02-03T00:00:00Z' },
    // Stored with an offset and a fraction: it groups and prints as the UTC instant.
    { id: 'c3', region: 'north', signedUpAt: '2026-01-21T01:59:59.5+02:00' },
    { id: 'c4', region: 'north', signedUpAt: '2026-01-01T00:00:00Z' }
  ] as never);
  await ds.tombstone('Customer', ['c4']);
  await ds.write('Invoice', [
    { id: 'i1', customer: 'c1', amount: 9007199254740993n, status: 'paid' },
    { id: 'i2', customer: 'c3', amount: 1n, status: 'open' },
    { id: 'i3', customer: 'c2', amount: 50n, status: 'paid' },
    { id: 'i4', customer: null, amount: 7n, status: 'open' },
    { id: 'i5', customer: 'c4', amount: 3n, status: 'void' },
    { id: 'i6', customer: 'gone', amount: 2n, status: 'open' }
  ] as never);
  return ds;
}

const groups = async (params: Omit<ReadParams, 'aggregate'>) =>
  (
    await (
      await dataset()
    ).read('Invoice', {
      aggregate: { n: { count: true }, total: { sum: 'amount' } },
      orderBy: [{ total: 'desc' }],
      ...params
    } as ReadParams)
  ).groups;

describe('a walked group key (memory)', () => {
  it('groups by the far row’s field; a null, tombstoned or missing far row keys null', async () => {
    expect(await groups({ groupBy: { region: 'customer.region' } })).toEqual([
      { region: 'north', n: 2, total: 9007199254740994n },
      { region: 'south', n: 1, total: 50n },
      { region: null, n: 3, total: 12n }
    ]);
  });

  it('reads a walked date inside a groupBy expression', async () => {
    expect(
      await groups({
        groupBy: { month: { dateTrunc: [{ lit: 'month' }, 'customer.signedUpAt'] } }
      })
    ).toEqual([
      { month: '2026-01-01T00:00:00.000000Z', n: 2, total: 9007199254740994n },
      { month: '2026-02-01T00:00:00.000000Z', n: 1, total: 50n },
      { month: null, n: 3, total: 12n }
    ]);
  });

  it('prints a bare walked date key as microsecond UTC text', async () => {
    expect(await groups({ groupBy: { signedUp: 'customer.signedUpAt' } })).toEqual([
      { signedUp: '2026-01-15T10:00:00.000000Z', n: 1, total: 9007199254740993n },
      { signedUp: '2026-02-03T00:00:00.000000Z', n: 1, total: 50n },
      { signedUp: null, n: 3, total: 12n },
      { signedUp: '2026-01-20T23:59:59.500000Z', n: 1, total: 1n }
    ]);
  });

  it("mixes a walked field with the seed's own in one key", async () => {
    expect(await groups({ groupBy: { who: { coalesce: ['customer.region', 'status'] } } })).toEqual(
      [
        { who: 'north', n: 2, total: 9007199254740994n },
        { who: 'south', n: 1, total: 50n },
        { who: 'open', n: 2, total: 9n },
        { who: 'void', n: 1, total: 3n }
      ]
    );
  });
});
