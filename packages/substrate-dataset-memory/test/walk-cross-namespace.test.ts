/**
 * Walks across sibling namespaces of one memory registry root, called on the
 * dataset directly. `app/Invoice` and `ext/Payment` (→ app/Invoice) are the
 * cross-namespace pair; both namespaces also declare an `Invoice` type.
 */

import type { FieldDef, ReadParams, WhereClause } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { MemoryDataset } from '../src/index.js';

const num: FieldDef = { kind: 'scalar', type: 'number' };
const str: FieldDef = { kind: 'scalar', type: 'string' };

const SCHEMAS: Record<string, Record<string, Record<string, FieldDef>>> = {
  app: { Invoice: { number: str, total: num } },
  ext: {
    Payment: {
      amount: num,
      invoice: { kind: 'crossRef', ns: 'app', type: 'Invoice', onDelete: 'set_null' }
    },
    Invoice: { number: str, total: num }
  }
};
const lookupFor = (ns: string) => (type: string, field: string) => SCHEMAS[ns]?.[type]?.[field];

async function pair(): Promise<{ app: MemoryDataset; ext: MemoryDataset }> {
  const app = new MemoryDataset({
    namespace: 'app',
    walkReference: true,
    fieldDefLookup: lookupFor('app'),
    fieldDefLookupFor: lookupFor
  });
  const ext = app.forNamespace('ext') as MemoryDataset;
  await app.write('Invoice', [
    { id: 'i1', number: 'INV-1', total: 100 },
    { id: 'i2', number: 'INV-2', total: 50 }
  ] as never);
  await ext.write('Payment', [
    { id: 'p1', amount: 30, invoice: 'i1' },
    { id: 'p2', amount: 20, invoice: 'i1' }
  ] as never);
  return { app, ext };
}

const ids = (rows: Array<Record<string, unknown>>) => rows.map((r) => String(r.id)).sort();

describe('walks across sibling namespaces', () => {
  it('an out walk reads the crossRef target in another namespace', async () => {
    const { ext } = await pair();
    const where = {
      _walk: { out: 'invoice', quantifier: 'any', where: { number: { eq: 'INV-1' } } }
    } as WhereClause;
    expect(ids((await ext.read('Payment', { where })).rows)).toEqual(['p1', 'p2']);
  });

  it('an in walk reads the referencing type in another namespace', async () => {
    const { app } = await pair();
    const where = { _walk: { in: 'ext/Payment.invoice', quantifier: 'none' } } as WhereClause;
    expect(ids((await app.read('Invoice', { where })).rows)).toEqual(['i2']);
  });

  it('a nested selection crosses namespaces', async () => {
    const { ext } = await pair();
    const res = await ext.read('Payment', {
      orderBy: [{ id: 'asc' }],
      nested: {
        invoice: { _walk: { out: 'invoice' }, fields: { number: true } }
      } as NonNullable<ReadParams['nested']>
    });
    expect(res.rows.map((r) => r.invoice)).toEqual([
      [{ id: 'i1', number: 'INV-1' }],
      [{ id: 'i1', number: 'INV-1' }]
    ]);
  });

  it('an _agg sum over an in hop crosses namespaces', async () => {
    const { app } = await pair();
    const res = await app.read('Invoice', {
      orderBy: [{ id: 'asc' }],
      agg: { paid: { in: 'ext/Payment.invoice', sum: 'amount' } }
    } as ReadParams);
    expect(res.rows.map((r) => r._agg)).toEqual([{ paid: 50 }, { paid: null }]);
  });

  it('same-named types in two namespaces are not confused', async () => {
    const { app, ext } = await pair();
    await ext.write('Invoice', [{ id: 'x1', number: 'EXT-1', total: 1 }] as never);
    const where = { _walk: { out: 'invoice', where: { number: { eq: 'EXT-1' } } } } as WhereClause;
    expect((await ext.read('Payment', { where })).rows).toEqual([]);
    const inv = { _walk: { in: 'ext/Payment.invoice' } } as WhereClause;
    expect(ids((await app.read('Invoice', { where: inv })).rows)).toEqual(['i1']);
    expect(ids((await ext.read('Invoice', { where: inv })).rows)).toEqual([]);
  });

  it('a namespace with no member has no rows', async () => {
    const { app } = await pair();
    const where = { _walk: { in: 'gone/Thing.invoice', quantifier: 'none' } } as WhereClause;
    expect(ids((await app.read('Invoice', { where })).rows)).toEqual(['i1', 'i2']);
  });

  it('walkStoreId is equal across siblings and differs across roots', async () => {
    const { app, ext } = await pair();
    const other = new MemoryDataset({ namespace: 'app' });
    expect(ext.walkStoreId).toBe(app.walkStoreId);
    expect(other.walkStoreId).not.toBe(app.walkStoreId);
  });
});
