import type { NlOutcome, Query, Schema, SubstrateRequest } from '@mnmal-ai/substrate/sdk';
import { describe, expect, it, vi } from 'vitest';
import type { NlEngineAccess, NlEnvelope } from '../access.js';
import type { NlEvent } from '../ask/events.js';
import { runAsk } from '../ask/run.js';
import { buildNamespacePack } from '../pack/build.js';
import type { NamespaceRulings } from '../pack/rulings.js';
import type { ServedPack } from '../pack/service.js';
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
    fields: {
      name: str,
      price: num,
      views: num,
      listedAt: date,
      condition: { ...str, enum: ['new', 'used'] },
      featured: { kind: 'scalar', type: 'boolean', indexed: true },
      category: ref('Category')
    }
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
    'asking price': { field: 'Item.price', exclude: { name: { eq: 'lamp' } } },
    'category rank': { field: 'Category.rank' }
  }
};
const parse = (q: string, rulings = base) => parseQuestion(q, pack, { asOf, rulings });
const params = (q: string, rulings = base) =>
  Object.values(parse(q, rulings).candidates[0]?.frame ?? {})[0]?.params;

describe('aggregates: parsing', () => {
  it('reads average, total, min and max of a number field', () => {
    for (const [q, fn] of [
      ['average price of items', 'avg'],
      ['avg price for items', 'avg'],
      ['mean views of items', 'avg'],
      ['total price of sales', 'sum'],
      ['sum of price for sales', 'sum'],
      ['min price of items', 'min'],
      ['minimum price of items', 'min'],
      ['max views of items', 'max'],
      ['maximum price of items', 'max']
    ] as const) {
      const r = parse(q);
      expect(r.status, q).toBe('resolved');
      expect(r.candidates[0]?.answer, q).toBe('aggregate');
      expect(r.candidates[0]?.strict, q).toBe(true);
      const field = q.includes('views') ? 'views' : 'price';
      expect(params(q), q).toEqual({ aggregate: { value: { [fn]: field } } });
    }
    expect(parse('average price of items').candidates[0]?.evidence).toContainEqual({
      span: 'average price',
      role: 'aggregate',
      detail: 'avg price'
    });
  });

  it('reads highest/lowest as a value only before "of" or "for"; otherwise it orders', () => {
    expect(params('what is the highest price of items')).toEqual({
      aggregate: { value: { max: 'price' } }
    });
    expect(params('lowest price for items')).toEqual({ aggregate: { value: { min: 'price' } } });
    const ordered = parse('items with the highest price');
    expect(ordered.candidates[0]?.answer).toBe('rows');
    expect(params('items with the highest price')).toEqual({
      orderBy: [{ price: 'desc' }],
      limit: 10
    });
    expect(parse('the item with the highest price').candidates[0]?.answer).toBe('single');
  });

  it('takes a date field for min and max only', () => {
    expect(params('max listed at of items')).toEqual({ aggregate: { value: { max: 'listedAt' } } });
    const r = parse('average listed at of items');
    expect(r.status).toBe('partial');
    expect(r.candidates[0]?.dropped).toEqual([
      {
        span: 'average listed at',
        reason: 'average needs a number field; listedAt is a date field',
        kind: 'filter'
      }
    ]);
    expect(params('average listed at of items')).toEqual({});
    expect(parse('max name of items').candidates[0]?.dropped[0]?.reason).toBe(
      'max needs a number or date field; name is a string field'
    );
  });

  it('drops an unknown field, and a field across a walk', () => {
    const r = parse('average zorbness of items');
    expect(r.status).toBe('partial');
    expect(r.candidates[0]?.answer).toBe('aggregate');
    expect(r.candidates[0]?.dropped).toEqual([
      { span: 'average zorbness', reason: 'Item has no field "zorbness"', kind: 'filter' }
    ]);
    for (const [q, rulings] of [
      ['average rank of items', base],
      ['average category rank of items', phrased]
    ] as const) {
      const w = parse(q, rulings);
      expect(w.candidates[0]?.dropped[0]?.reason, q).toBe(
        'aggregating across a walk is not supported'
      );
      expect(JSON.stringify(w.candidates[0]?.frame), q).not.toContain('_walk');
      expect(JSON.stringify(w.candidates[0]?.frame), q).not.toContain('aggregate');
    }
  });

  it('resolves the field through a fieldPhrases ruling, keeping its exclusion', () => {
    expect(params('average asking price of items', phrased)).toEqual({
      where: { NOT: { name: { eq: 'lamp' } } },
      aggregate: { value: { avg: 'price' } }
    });
    expect(params('highest asking price of items', phrased)).toEqual({
      where: { NOT: { name: { eq: 'lamp' } } },
      aggregate: { value: { max: 'price' } }
    });
  });

  it('combines with values and time windows', () => {
    expect(params('average price of lamp items')).toEqual({
      where: { name: { eq: 'lamp' } },
      aggregate: { value: { avg: 'price' } }
    });
    expect(params('total price of sales last week')).toEqual({
      where: { soldAt: { gte: '2026-10-19T00:00:00Z', lt: '2026-10-26T00:00:00Z' } },
      aggregate: { value: { sum: 'price' } }
    });
  });

  it('groups by an enum or yes/no field, or buckets by day or hour', () => {
    const r = parse('average price of items by condition');
    expect(r.status).toBe('resolved');
    expect(r.candidates[0]?.aggregate).toEqual({
      fn: 'avg',
      field: 'price',
      group: { field: 'condition', values: ['new', 'used'] }
    });
    expect(params('average price of items by condition')).toEqual({
      aggregate: { value: { avg: 'price' } }
    });
    expect(r.candidates[0]?.evidence).toContainEqual({
      span: 'by condition',
      role: 'field',
      detail: 'group by condition'
    });
    expect(parse('total views of items per featured').candidates[0]?.aggregate?.group).toEqual({
      field: 'featured',
      values: [true, false]
    });
    expect(params('total price of sales per day')).toEqual({
      aggregate: { value: { sum: 'price' } },
      bucket: { field: 'soldAt', by: 'day' }
    });
    expect(params('max price of items by hour')).toEqual({
      aggregate: { value: { max: 'price' } },
      bucket: { field: 'listedAt', by: 'hour' }
    });
  });

  it('drops a grouping it cannot express, keeping the whole aggregate', () => {
    for (const [q, span, reason] of [
      ['total price of sales per month', 'per month', 'the engine buckets by day or hour only'],
      [
        'average price of items by name',
        'by name',
        'only enum and yes/no fields group; name is a string field'
      ],
      ['average price of items by rank', 'by rank', 'grouping across a walk is not supported']
    ] as const) {
      const r = parse(q);
      expect(r.status, q).toBe('partial');
      expect(r.candidates[0]?.dropped, q).toEqual([{ span, reason, kind: 'order' }]);
      expect(r.candidates[0]?.frame, q).not.toHaveProperty('shop/Item.params.bucket');
      expect(r.candidates[0]?.aggregate?.group, q).toBeUndefined();
    }
  });

  it('leaves counts and orderings as they were', () => {
    expect(parse('how many items').candidates[0]?.answer).toBe('count');
    expect(params('top 5 items by price')).toEqual({ orderBy: [{ price: 'desc' }], limit: 5 });
  });
});

const served: ServedPack = { ...pack, rulings: base, warnings: [] };
const http: SubstrateRequest = {
  method: 'POST',
  path: '/substrate/v1/nl',
  headers: {},
  query: {},
  params: {},
  body: null
};
function engine(reply: (frame: Query) => NlEnvelope) {
  const query = vi.fn(async (frame: Query) => reply(frame));
  const e: NlEngineAccess = { federatedSchema: () => ({}), operators: () => ({}), query };
  return { e, query };
}
async function ask(question: string, e: NlEngineAccess): Promise<NlOutcome> {
  const evs: NlEvent[] = [];
  for await (const ev of runAsk({ namespace: 'shop', question }, http, {
    pack: served,
    engine: e
  }))
    evs.push(ev);
  return (evs.find((x) => x.event === 'outcome') as Extract<NlEvent, { event: 'outcome' }>).outcome;
}
type Sent = Record<string, { params: Record<string, unknown>; fields: Record<string, unknown> }>;

describe('aggregates: answering', () => {
  it('sends one aggregate frame selecting only id, and carries the value', async () => {
    const { e, query } = engine(() => ({ data: { 'shop/Item': { groups: [{ value: 12.5 }] } } }));
    const o = await ask('average price of items', e);
    expect(o).toMatchObject({
      kind: 'rows',
      answer: 'aggregate',
      data: { groups: [{ value: 12.5 }] },
      aggregate: { fn: 'avg', field: 'price', value: 12.5 }
    });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).toEqual({
      'shop/Item': { params: { aggregate: { value: { avg: 'price' } } }, fields: { id: true } }
    });
  });

  it('carries day buckets as groups keyed by the bucket', async () => {
    const { e } = engine(() => ({
      data: {
        'shop/Sale': {
          groups: [
            { bucket: '2026-10-20', value: 30 },
            { bucket: '2026-10-21', value: 5 }
          ],
          truncated: true
        }
      }
    }));
    const o = await ask('total price of sales per day', e);
    expect(o).toMatchObject({
      aggregate: {
        fn: 'sum',
        field: 'price',
        by: 'day',
        groups: [
          { key: '2026-10-20', value: 30 },
          { key: '2026-10-21', value: 5 }
        ],
        truncated: true
      }
    });
  });

  it('groups by an enum field with one aggregate per value', async () => {
    const { e, query } = engine((f) => {
      const where = JSON.stringify((f as Sent)['shop/Item']?.params.where);
      return { data: { 'shop/Item': { groups: [{ value: where.includes('"new"') ? 20 : 8 }] } } };
    });
    const o = await ask('average price of lamp items by condition', e);
    expect(query).toHaveBeenCalledTimes(2);
    expect((query.mock.calls[0]?.[0] as Sent | undefined)?.['shop/Item']?.params.where).toEqual({
      AND: [{ name: { eq: 'lamp' } }, { condition: { eq: 'new' } }]
    });
    expect(o).toMatchObject({
      kind: 'rows',
      answer: 'aggregate',
      data: {
        groups: [
          { key: 'new', value: 20 },
          { key: 'used', value: 8 }
        ]
      },
      aggregate: {
        fn: 'avg',
        field: 'price',
        by: 'condition',
        groups: [
          { key: 'new', value: 20 },
          { key: 'used', value: 8 }
        ]
      }
    });
  });

  it('a refused aggregate carries the errors and no value', async () => {
    const { e } = engine(() => ({
      data: {},
      errors: [{ code: 'walks_unsupported_store', message: 'no walks' }]
    }));
    const o = await ask('average price of items', e);
    expect(o).toMatchObject({
      kind: 'rows',
      answer: 'aggregate',
      errors: [{ code: 'walks_unsupported_store' }]
    });
    expect(o).not.toHaveProperty('aggregate');
  });

  it('an aggregate over an unknown field is unknown, and nothing runs', async () => {
    const { e, query } = engine(() => ({ data: {} }));
    const o = await ask('average zorbness of items', e);
    expect(o.kind).toBe('unknown');
    expect(query).not.toHaveBeenCalled();
  });
});
