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
  Item: { fields: { name: str, price: num, listedAt: date, supplier: ref('Supplier') } },
  Supplier: { fields: { title: str, rating: num, foundedAt: date } },
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
  fieldPhrases: { 'vendor score': { field: 'Supplier.rating' } }
};
const parse = (q: string, rulings = base) => parseQuestion(q, pack, { asOf, rulings });
const frameOf = (q: string, rulings = base) =>
  Object.values(parse(q, rulings).candidates[0]?.frame ?? {})[0];

const outHop = (limit: number) => ({
  params: {
    select: { supplierRating: '_agg.supplierRating' },
    orderBy: [{ supplierRating: 'desc' }],
    limit
  },
  fields: { _agg: { supplierRating: { out: 'supplier', max: 'rating' } } }
});
const inHop = (name: string, agg: Record<string, unknown>, dir: 'asc' | 'desc', limit: number) => ({
  params: {
    select: { [name]: `_agg.${name}` },
    orderBy: [{ [name]: dir }],
    limit
  },
  fields: { _agg: { [name]: { in: 'shop/Item.supplier', ...agg } } }
});

describe('ordering by a field one crossRef hop away', () => {
  it('out-hop: "top N <seed> by <type> <field>" orders by the one neighbour', () => {
    const r = parse('top 10 items by supplier rating');
    expect(r.status).toBe('resolved');
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]?.type).toBe('Item');
    expect(r.candidates[0]?.answer).toBe('rows');
    expect(r.candidates[0]?.strict).toBe(true);
    expect(frameOf('top 10 items by supplier rating')).toEqual(outHop(10));
    expect(r.candidates[0]?.evidence).toContainEqual({
      span: 'top 10 by supplier rating',
      role: 'order',
      detail: 'Supplier.rating via supplier desc, limit 10'
    });
    expect(r.candidates[0]?.plan).toEqual([
      {
        path: ['fields', '_agg', 'supplierRating', 'Supplier.rating via supplier'],
        kind: 'hop',
        served: true
      },
      { path: ['orderBy', '0', 'supplierRating', 'desc'], kind: 'order', served: false }
    ]);
  });

  it('in-hop: max for top/highest, min for bottom/lowest, named in plan and evidence', () => {
    const top = parse('top 10 suppliers by item price');
    expect(top.status).toBe('resolved');
    expect(top.candidates[0]?.type).toBe('Supplier');
    expect(frameOf('top 10 suppliers by item price')).toEqual(
      inHop('maxItemPrice', { max: 'price' }, 'desc', 10)
    );
    expect(top.candidates[0]?.evidence).toContainEqual({
      span: 'top 10 by item price',
      role: 'order',
      detail: 'max(Item.price) per supplier desc, limit 10'
    });
    expect(top.candidates[0]?.plan[0]?.path).toEqual([
      'fields',
      '_agg',
      'maxItemPrice',
      'max(Item.price) per supplier'
    ]);
    expect(frameOf('bottom 3 suppliers by item price')).toEqual(
      inHop('minItemPrice', { min: 'price' }, 'asc', 3)
    );
    const one = parse('the supplier with the highest item price');
    expect(one.status).toBe('resolved');
    expect(one.candidates[0]?.answer).toBe('single');
    expect(frameOf('the supplier with the highest item price')).toEqual(
      inHop('maxItemPrice', { max: 'price' }, 'desc', 1)
    );
    expect(frameOf('suppliers with the lowest item price')).toEqual(
      inHop('minItemPrice', { min: 'price' }, 'asc', 10)
    );
  });

  it('in-hop: an explicit pick word overrides the default', () => {
    expect(parse('top suppliers by latest item price').status).toBe('resolved');
    expect(frameOf('top suppliers by latest item price')).toEqual(
      inHop('latestItemPrice', { latest: { by: 'listedAt', value: 'price' } }, 'desc', 10)
    );
    // A direction word after "by" sets the pick and the direction together.
    expect(frameOf('top suppliers by lowest item price')).toEqual(
      inHop('minItemPrice', { min: 'price' }, 'asc', 10)
    );
    expect(parse('top suppliers by lowest item price').candidates[0]?.evidence).toContainEqual({
      span: 'top by lowest item price',
      role: 'order',
      detail: 'min(Item.price) per supplier asc, limit 10'
    });
    expect(frameOf('bottom 3 suppliers by highest item price')).toEqual(
      inHop('maxItemPrice', { max: 'price' }, 'desc', 3)
    );
  });

  it('a direction word after "by" orders a seed or out-hop field that way (review I1)', () => {
    expect(parse('top 10 items by lowest price').status).toBe('resolved');
    expect(frameOf('top 10 items by lowest price')).toEqual({
      params: { orderBy: [{ price: 'asc' }], limit: 10 }
    });
    expect(frameOf('bottom 3 items by highest price')).toEqual({
      params: { orderBy: [{ price: 'desc' }], limit: 3 }
    });
    expect(frameOf('top 3 items by smallest price')?.params.orderBy).toEqual([{ price: 'asc' }]);
    const out = parse('top 10 items by lowest supplier rating');
    expect(out.status).toBe('resolved');
    expect(frameOf('top 10 items by lowest supplier rating')).toEqual({
      ...outHop(10),
      params: { ...outHop(10).params, orderBy: [{ supplierRating: 'asc' }] }
    });
  });

  it('any other pick word after "by" drops the ordering with a reason (review I1)', () => {
    for (const [q, reason] of [
      [
        'top 10 items by cheapest price',
        '"cheapest" is not an ordering direction; say lowest or highest'
      ],
      [
        'top 5 items by latest price',
        '"latest" picks one of many rows; Item.price is one value per item'
      ],
      [
        'top 5 items by latest supplier rating',
        '"latest" picks one of many rows; Supplier.rating is one value per item'
      ],
      [
        'top suppliers by cheapest item price',
        '"cheapest" is not an ordering direction; say lowest or highest'
      ]
    ] as const) {
      const r = parse(q);
      expect(r.status, q).toBe('partial');
      expect(r.candidates[0]?.dropped, q).toEqual([
        expect.objectContaining({ reason, kind: 'order' })
      ]);
      expect(JSON.stringify(r.candidates[0]?.frame), q).not.toContain('orderBy');
    }
  });

  it("honours a ruling's default pick on an in-hop (review I2)", () => {
    const current: NamespaceRulings = {
      ...base,
      fieldPhrases: { 'current cost': { field: 'Item.price', pick: 'latest' } }
    };
    expect(parse('top 5 suppliers by current cost', current).status).toBe('resolved');
    expect(frameOf('top 5 suppliers by current cost', current)).toEqual(
      inHop('latestItemPrice', { latest: { by: 'listedAt', value: 'price' } }, 'desc', 5)
    );
  });

  it('a time range keeps the hop type as a competing reading (review I3)', () => {
    const r = parse('top 5 suppliers by item price last week');
    expect(r.status).not.toBe('resolved');
    expect(r.candidates.map((c) => c.type).sort()).toEqual(['Item', 'Supplier']);
  });

  it("a <seed type> <field> pair keeps the seed's mention (review I4)", () => {
    expect(parse('items with the highest item price').status).not.toBe('unparsed');
    for (const [q, type, field] of [
      ['top 5 items by item price', 'shop/Item', 'price'],
      ['top 5 suppliers by supplier rating', 'shop/Supplier', 'rating']
    ] as const) {
      const r = parse(q);
      expect(r.status, q).toBe('resolved');
      expect(r.candidates[0]?.frame[type]?.params, q).toEqual({
        orderBy: [{ [field]: 'desc' }],
        limit: 5
      });
    }
  });

  it('resolves the field through a fieldPhrases ruling, and a bare field name on one type', () => {
    expect(frameOf('top 5 items by vendor score', phrased)).toEqual(outHop(5));
    const one = parse('the item with the highest vendor score', phrased);
    expect(one.status).toBe('resolved');
    expect(frameOf('the item with the highest vendor score', phrased)).toEqual(outHop(1));
    expect(parse('top items by rating').status).toBe('resolved');
    expect(frameOf('top items by rating')).toEqual(outHop(10));
    // In-hop through a phrase: the walk's own pick word is the ordering's pick.
    const costed: NamespaceRulings = {
      ...base,
      fieldPhrases: { 'item cost': { field: 'Item.price', exclude: { name: { eq: 'lamp' } } } }
    };
    expect(parse('top suppliers by latest item cost', costed).status).toBe('resolved');
    expect(frameOf('top suppliers by latest item cost', costed)).toEqual(
      inHop(
        'latestItemPrice',
        { where: { NOT: { name: { eq: 'lamp' } } }, latest: { by: 'listedAt', value: 'price' } },
        'desc',
        10
      )
    );
    expect(frameOf('suppliers with the lowest item cost', costed)).toEqual(
      inHop('minItemPrice', { where: { NOT: { name: { eq: 'lamp' } } }, min: 'price' }, 'asc', 10)
    );
  });

  it('drops two hops, an unknown field, a field on several types and a non-number field', () => {
    for (const [q, reason] of [
      ['top suppliers by sale price', 'ordering across 2 hops is not supported; one hop only'],
      ['top 5 items by supplier zorbness', 'Supplier has no field "zorbness"'],
      ['top suppliers by price', '"price" names a field on several types: Item, Sale'],
      [
        'top items by supplier founded at',
        'ordering across a hop needs a number field; Supplier.foundedAt is a date field'
      ]
    ] as const) {
      const r = parse(q);
      expect(r.status, q).toBe('partial');
      expect(r.candidates[0]?.dropped, q).toEqual([
        expect.objectContaining({ reason, kind: 'order' })
      ]);
      expect(JSON.stringify(r.candidates[0]?.frame), q).not.toContain('orderBy');
      expect(JSON.stringify(r.candidates[0]?.frame), q).not.toContain('_agg');
    }
  });

  it('combines with a value filter and a time range', () => {
    expect(frameOf('top 5 lamp items by vendor score last week', phrased)).toEqual({
      params: {
        where: {
          AND: [
            { name: { eq: 'lamp' } },
            { listedAt: { gte: '2026-10-19T00:00:00Z', lt: '2026-10-26T00:00:00Z' } }
          ]
        },
        ...outHop(5).params
      },
      fields: outHop(5).fields
    });
  });

  it('a count over the ordering stays unknown, with no walk ordering emitted', () => {
    const r = parse('how many of the top 5 items by supplier rating');
    expect(r.candidates[0]?.answer).toBe('count');
    expect(r.candidates[0]?.strict).toBe(true);
    expect(r.candidates[0]?.dropped).toEqual([
      expect.objectContaining({ reason: 'ordering does not apply to a count', kind: 'filter' })
    ]);
    expect(JSON.stringify(r.candidates[0]?.frame)).not.toContain('_agg');
  });
});
