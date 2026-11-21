/**
 * A frame aggregate grouped by a field of the row an out-walk reaches, through
 * pg and the memory reference, which must agree: a null, dangling or deleted
 * crossRef keys its seed row under null and the row still counts (a LEFT JOIN
 * on pg), int64 sums stay exact. Skipped without POSTGRES_URL.
 */

import { randomUUID } from 'node:crypto';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import type { FieldDef, ReadParams } from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgDataset } from '../src/index.js';
import { dropNamespace } from './_layout.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const NS = `wgk_${randomUUID().slice(0, 8)}`;
const defs: Record<string, Record<string, FieldDef>> = {
  Customer: {
    region: { kind: 'scalar', type: 'string' },
    signedUpAt: { kind: 'scalar', type: 'date' }
  },
  Invoice: {
    customer: { kind: 'crossRef', ns: NS, type: 'Customer', onDelete: 'set_null' },
    amount: { kind: 'scalar', type: 'int64' }
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

let sql: Sql;
let pg: PgDataset;
let mem: MemoryDataset;

beforeAll(async () => {
  if (!POSTGRES_URL) return;
  sql = postgres(POSTGRES_URL, { onnotice: () => {} });
  pg = new PgDataset({ namespace: NS, sql, ...lookup });
  mem = new MemoryDataset({ namespace: NS, ...lookup, walkReference: true });
  for (const type of Object.keys(defs)) await pg.ensureTypeStorage(type);
  const customers = [
    { id: 'c1', region: 'north', signedUpAt: '2026-01-15T10:00:00Z' },
    { id: 'c2', region: 'south', signedUpAt: '2026-02-03T00:00:00Z' },
    { id: 'c3', region: 'north', signedUpAt: '2026-01-20T23:59:59Z' },
    { id: 'c4', region: 'north', signedUpAt: '2026-01-01T00:00:00Z' }
  ].map((c) => ({ ...c, id: u(c.id) }));
  // c4 is deleted and `gone` was never written: both key null, as a null customer does.
  const invoices = [
    { id: 'i1', customer: u('c1'), amount: 9007199254740993n },
    { id: 'i2', customer: u('c3'), amount: 1n },
    { id: 'i3', customer: u('c2'), amount: 50n },
    { id: 'i4', customer: null, amount: 7n },
    { id: 'i5', customer: u('c4'), amount: 3n },
    { id: 'i6', customer: u('gone'), amount: 2n }
  ].map((i) => ({ ...i, id: u(i.id) }));
  for (const ds of [pg, mem]) {
    await ds.write('Customer', customers as never);
    await ds.tombstone('Customer', [u('c4')]);
    await ds.write('Invoice', invoices as never);
  }
});

afterAll(async () => {
  if (!POSTGRES_URL) return;
  await dropNamespace(sql, NS);
  await sql.end({ timeout: 5 });
});

/** The groups of `params` over Invoice, asserting pg and memory agree. */
async function groups(params: Omit<ReadParams, 'aggregate'>) {
  const read: ReadParams = {
    aggregate: { n: { count: true }, total: { sum: 'amount' } },
    orderBy: [{ total: 'desc' }],
    ...params
  } as ReadParams;
  const want = (await mem.read('Invoice', read)).groups;
  expect((await pg.read('Invoice', read)).groups).toEqual(want);
  return want;
}

describe.skipIf(!POSTGRES_URL)('a walked group key: pg and memory agree', () => {
  it('groups by the far row’s field; a null, deleted or missing far row keys null', async () => {
    expect(await groups({ groupBy: { region: 'customer.region' } })).toEqual([
      { region: 'north', n: 2, total: 9007199254740994n },
      { region: 'south', n: 1, total: 50n },
      { region: null, n: 3, total: 12n }
    ]);
  });

  it('reads a walked date inside dateTrunc, beside another key over the same crossRef', async () => {
    expect(
      await groups({
        groupBy: {
          month: { dateTrunc: [{ lit: 'month' }, 'customer.signedUpAt'] },
          region: 'customer.region'
        }
      })
    ).toEqual([
      { month: '2026-01-01T00:00:00.000000Z', region: 'north', n: 2, total: 9007199254740994n },
      { month: '2026-02-01T00:00:00.000000Z', region: 'south', n: 1, total: 50n },
      { month: null, region: null, n: 3, total: 12n }
    ]);
  });
});
