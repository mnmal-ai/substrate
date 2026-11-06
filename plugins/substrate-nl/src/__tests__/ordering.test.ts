import type { Schema } from '@mnmal-ai/substrate/sdk';
import { describe, expect, it } from 'vitest';
import { buildNamespacePack } from '../pack/build.js';
import type { NamespaceRulings } from '../pack/rulings.js';
import { parseQuestion } from '../parse/parse.js';
import { OPERATORS } from './_fixture.js';

const num = { kind: 'scalar' as const, type: 'number' as const, indexed: true };
const str = { kind: 'scalar' as const, type: 'string' as const, indexed: true };
const date = { kind: 'scalar' as const, type: 'date' as const, indexed: true };
const ref = (type: string) => ({
  kind: 'crossRef' as const,
  ns: 'shop',
  type,
  onDelete: 'restrict' as const
});
const types: Schema['types'] = {
  Item: {
    fields: { name: str, price: num, views: num, listedAt: date, category: ref('Category') }
  },
  Category: { fields: { name: str, rank: num } },
  Sale: { fields: { item: ref('Item'), price: num, soldAt: date } }
};
const pack = buildNamespacePack({
  namespace: 'shop',
  schema: { schemaVersion: 'v', mutations: {}, types },
  operators: OPERATORS,
  profile: { types: { Item: { name: { values: ['lamp', 'chair'], truncated: false } } } }
});
const asOf = '2026-10-30T12:00:00Z';
const base: NamespaceRulings = { timeField: { Item: 'listedAt', Sale: 'soldAt' } };
const phrased: NamespaceRulings = {
  ...base,
  fieldPhrases: {
    'asking price': { field: 'Item.price' },
    'category rank': { field: 'Category.rank' },
    'sale price': { field: 'Sale.price' }
  }
};
const parse = (q: string, rulings = base) => parseQuestion(q, pack, { asOf, rulings });
const params = (q: string, rulings = base) =>
  Object.values(parse(q, rulings).candidates[0]?.frame ?? {})[0]?.params;

describe('ordering by a field', () => {
  it('reads "top N <type> by <field>" and "bottom N"', () => {
    const r = parse('top 5 items by price');
    expect(r.status).toBe('resolved');
    expect(r.candidates[0]?.answer).toBe('rows');
    expect(params('top 5 items by price')).toEqual({ orderBy: [{ price: 'desc' }], limit: 5 });
    expect(params('bottom 3 items by views')).toEqual({ orderBy: [{ views: 'asc' }], limit: 3 });
    expect(r.candidates[0]?.evidence).toContainEqual({
      span: 'top 5 by price',
      role: 'order',
      detail: 'price desc, limit 5'
    });
  });

  it('defaults the limit: 1 for a singular, 10 for a plural', () => {
    expect(params('top items by price')).toEqual({ orderBy: [{ price: 'desc' }], limit: 10 });
    const one = parse('the item with the highest price');
    expect(one.status).toBe('resolved');
    expect(one.candidates[0]?.answer).toBe('single');
    expect(params('the item with the highest price')).toEqual({
      orderBy: [{ price: 'desc' }],
      limit: 1
    });
    expect(params('highest price items')).toEqual({ orderBy: [{ price: 'desc' }], limit: 10 });
    expect(params('lowest price item')).toEqual({ orderBy: [{ price: 'asc' }], limit: 1 });
    expect(params('items with the most views')).toEqual({
      orderBy: [{ views: 'desc' }],
      limit: 10
    });
  });

  it('orders by a date field, and leaves "most" on a non-number field alone', () => {
    expect(params('top 2 items by listed at')).toEqual({
      orderBy: [{ listedAt: 'desc' }],
      limit: 2
    });
    expect(parse('items with the most name').candidates[0]?.frame).not.toHaveProperty(
      'shop/Item.params.orderBy'
    );
    expect(parse('items with the most name').status).toBe('partial');
  });

  it('resolves the field through a fieldPhrases ruling', () => {
    expect(params('top 5 items by asking price', phrased)).toEqual({
      orderBy: [{ price: 'desc' }],
      limit: 5
    });
    const r = parse('the item with the highest asking price', phrased);
    expect(r.status).toBe('resolved');
    expect(r.candidates[0]?.frame['shop/Item']?.params).toEqual({
      orderBy: [{ price: 'desc' }],
      limit: 1
    });
  });

  it("keeps an ordering phrase's ruled exclusion", () => {
    const rulings: NamespaceRulings = {
      ...base,
      fieldPhrases: { 'asking price': { field: 'Item.price', exclude: { name: { eq: 'lamp' } } } }
    };
    expect(params('top 2 items by asking price', rulings)).toEqual({
      where: { NOT: { name: { eq: 'lamp' } } },
      orderBy: [{ price: 'desc' }],
      limit: 2
    });
  });

  it('drops an unknown or unsortable field, with a reason', () => {
    const r = parse('top 5 items by zorbness');
    expect(r.status).toBe('partial');
    expect(r.candidates[0]?.dropped).toEqual([
      { span: 'top 5 by zorbness', reason: 'Item has no field "zorbness"', kind: 'order' }
    ]);
    expect(params('top 5 items by zorbness')).toEqual({});
    expect(parse('top items by name').candidates[0]?.dropped).toEqual([
      {
        span: 'top by name',
        reason: 'name is a string field; only number and date fields order',
        kind: 'order'
      }
    ]);
  });

  it('orders across one crossRef hop (walk-ordering.test.ts covers the forms)', () => {
    for (const [q, rulings] of [
      ['top 5 items by category rank', phrased],
      ['top 5 items by category rank', base],
      ['top 5 items by rank', base]
    ] as const) {
      expect(parse(q, rulings).status, q).toBe('resolved');
      expect(Object.values(parse(q, rulings).candidates[0]?.frame ?? {})[0], q).toEqual({
        params: {
          derive: { categoryRank: { value: '_agg.categoryRank' } },
          orderBy: [{ $categoryRank: 'desc' }],
          limit: 5
        },
        fields: { _agg: { categoryRank: { out: 'category', max: 'rank' } } }
      });
    }
  });

  it('combines with filters and time windows', () => {
    expect(params('top 5 sales by price last week')).toEqual({
      where: { soldAt: { gte: '2026-10-19T00:00:00Z', lt: '2026-10-26T00:00:00Z' } },
      orderBy: [{ price: 'desc' }],
      limit: 5
    });
    expect(params('top 3 lamp items by price')).toEqual({
      where: { name: { eq: 'lamp' } },
      orderBy: [{ price: 'desc' }],
      limit: 3
    });
  });

  it('never counts past an ordering: it is dropped, and the count is not resolved', () => {
    for (const q of [
      'how many items have the highest price',
      'how many of the top 5 items by price'
    ]) {
      const r = parse(q);
      expect(r.candidates[0]?.answer, q).toBe('count');
      expect(r.status, q).toBe('partial');
      expect(r.candidates[0]?.strict, q).toBe(true);
      expect(r.candidates[0]?.dropped, q).toEqual([
        expect.objectContaining({ reason: 'ordering does not apply to a count', kind: 'filter' })
      ]);
      expect(params(q), q).toEqual({});
    }
  });

  it('does not read a number after highest as a field', () => {
    expect(parse('highest 5 items').candidates[0]?.dropped ?? []).toEqual([]);
  });

  it('keeps the field ordering over a recency word, dropping the recency', () => {
    const r = parse('latest top 3 items by price');
    expect(params('latest top 3 items by price')).toEqual({
      orderBy: [{ price: 'desc' }],
      limit: 3
    });
    expect(r.candidates[0]?.dropped[0]?.kind).toBe('order');
    expect(params('the latest item')).toEqual({ orderBy: [{ listedAt: 'desc' }], limit: 1 });
  });

  it('marks an ordered reading strict', () => {
    expect(parse('top 5 items by price').candidates[0]?.strict).toBe(true);
  });
});
