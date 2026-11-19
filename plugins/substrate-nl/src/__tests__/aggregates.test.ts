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
  Category: {
    fields: { name: str, rank: num, archived: { kind: 'scalar', type: 'boolean', indexed: true } }
  },
  Sale: { fields: { item: ref('Item'), price: num, soldAt: date } },
  Subscription: {
    fields: {
      cycle: { ...str, enum: ['monthly', 'yearly'] },
      price: num,
      fee: num,
      annualFee: num,
      startedAt: date
    }
  },
  Bin: {
    fields: { size: num, code: { ...str, enum: Array.from({ length: 21 }, (_, i) => `c${i}`) } }
  }
};
const pack = buildNamespacePack({
  namespace: 'shop',
  schema: { schemaVersion: 'v', mutations: {}, types },
  operators: OPERATORS,
  profile: { types: { Item: { name: { values: ['lamp', 'chair'], truncated: false } } } }
});
const asOf = '2026-10-30T12:00:00Z';
const base: NamespaceRulings = {
  timeField: { Item: 'listedAt', Sale: 'soldAt', Subscription: 'startedAt' }
};
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

describe('archived phrasing on a count', () => {
  it.each([
    'How many categories are there in total (archived or not)?',
    'how many categories including archived',
    'how many categories in total'
  ])('%s counts every row with no leftovers', (q) => {
    const c = parse(q).candidates[0];
    expect(Object.values(c?.frame ?? {})[0]?.params).toEqual({});
    expect(c?.dropped).toEqual([]);
    expect(c?.residual).toEqual([]);
  });

  it('a total over a number field is still an aggregate', () => {
    expect(params('total rank of categories')?.aggregate).toEqual({ value: { sum: 'rank' } });
  });
});

describe('a number with no cue is not a shortId', () => {
  it.each(['how many sales 2025', 'total price of sales per month 2025'])('%s', (q) => {
    const r = parse(q);
    expect(JSON.stringify(r.candidates)).not.toContain('shortId');
    expect(r.residual).toContain('2025');
  });
});

describe('a lone number nothing reads', () => {
  it('never drops an unread number', async () => {
    const statused = withTypes({
      Item: {
        fields: {
          ...(types.Item as { fields: object }).fields,
          status: { ...str, enum: ['open', 'sold'] }
        }
      }
    }).served;
    for (const [q, p, n] of [
      ['items 2025', served, '2025'],
      ['open items 7', statused, '7'],
      // The earliest mention is plural, so 5 is not an id; "category" later is no cue.
      ['categories 5 and the category', served, '5']
    ] as const) {
      const r = parseQuestion(q, p, { asOf, rulings: p.rulings });
      expect(r.status, q).toBe('partial');
      expect(r.residual, q).toEqual([n]);
      expect(JSON.stringify(r.candidates), q).not.toContain('shortId');
      const { e, query } = engine(() => ({ data: {} }));
      expect((await ask(q, e, p)).kind, q).toBe('unknown');
      expect(query, q).not.toHaveBeenCalled();
    }
    expect(parse('items in 2025')).toMatchObject({ status: 'resolved', residual: [] });
    expect(params('items in 2025')).toEqual({
      where: { listedAt: { gte: '2025-01-01T00:00:00Z', lt: '2026-01-01T00:00:00Z' } }
    });
    expect(parse('top 5 items by price')).toMatchObject({ status: 'resolved', residual: [] });
  });
});

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

  it('keeps the #1903 orderings when the type comes before the superlative', () => {
    for (const [q, orderBy] of [
      ['items with the highest price for last week', [{ price: 'desc' }]],
      ['sales with the lowest price for the last 3 days', [{ price: 'asc' }]],
      ['items with the highest price for featured', [{ price: 'desc' }]]
    ] as const) {
      const r = parse(q);
      expect(r.candidates[0]?.answer, q).toBe('rows');
      expect(params(q)?.orderBy, q).toEqual(orderBy);
      expect(params(q), q).not.toHaveProperty('aggregate');
    }
  });

  it('a recency pick inside an aggregate or a count is dropped as a filter', () => {
    for (const [q, reason] of [
      ['average price of the last sale', 'aggregating over the latest N rows is not supported'],
      ['total price of the last 5 sales', 'aggregating over the latest N rows is not supported'],
      ['max price of the newest items', 'aggregating over the latest N rows is not supported'],
      ['average price of the first 3 items', 'aggregating over the latest N rows is not supported'],
      ['how many of the latest sales', 'counting over the latest N rows is not supported'],
      ['how many of the first 3 items', 'counting over the latest N rows is not supported']
    ] as const) {
      const r = parse(q);
      expect(r.status, q).toBe('partial');
      expect(r.candidates[0]?.strict, q).toBe(true);
      expect(r.candidates[0]?.dropped, q).toContainEqual(
        expect.objectContaining({ reason, kind: 'filter' })
      );
      expect(params(q), q).not.toHaveProperty('orderBy');
      expect(params(q), q).not.toHaveProperty('limit');
    }
  });

  it('a count beside an aggregate keeps the count and drops the aggregate as a filter', () => {
    const r = parse('how many items with max price');
    expect(r.status).toBe('partial');
    expect(r.candidates[0]?.answer).toBe('count');
    expect(r.candidates[0]?.dropped).toEqual([
      { span: 'max price', reason: 'an aggregate does not apply to a count', kind: 'filter' }
    ]);
    expect(params('how many items with max price')).not.toHaveProperty('aggregate');
  });

  it('drops a grouping by a derived value beside an aggregate', () => {
    const rulings: NamespaceRulings = {
      ...base,
      fieldPhrases: { spread: { select: { sub: ['Item.price', 'Item.views'] } } }
    };
    const r = parse('average price of items by spread', rulings);
    expect(r.candidates[0]?.dropped).toContainEqual(
      expect.objectContaining({
        reason: 'grouping by a derived value is not supported',
        kind: 'order'
      })
    );
    expect(r.candidates[0]?.plan.some((c) => c.kind === 'select')).toBe(false);
    expect(params('average price of items by spread', rulings)).toEqual({
      aggregate: { value: { avg: 'price' } }
    });
  });

  it('drops a grouping over more than 20 values', () => {
    expect(parse('total size of bins by code').candidates[0]?.dropped).toEqual([
      {
        span: 'by code',
        reason: 'code has 21 values; grouping runs one frame per value, at most 20',
        kind: 'order'
      }
    ]);
  });

  it('grouping by archived drops the default live filter', () => {
    expect(params('total rank of categories by archived')).toEqual({
      aggregate: { value: { sum: 'rank' } }
    });
    expect(params('total rank of categories')).toEqual({
      where: { archived: { eq: false } },
      aggregate: { value: { sum: 'rank' } }
    });
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

  it('groups by an enum or yes/no field, or buckets by a time unit', () => {
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
    expect(r.candidates[0]?.plan).toContainEqual({
      path: ['aggregate', 'group:condition (one frame per value, and one for no value)'],
      kind: 'agg',
      served: false
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
      groupBy: { bucket: { dateTrunc: [{ lit: 'day' }, 'soldAt'] } }
    });
    expect(params('max price of items by hour')).toEqual({
      aggregate: { value: { max: 'price' } },
      groupBy: { bucket: { dateTrunc: [{ lit: 'hour' }, 'listedAt'] } }
    });
    for (const [q, unit] of [
      ['total price of sales per month', 'month'],
      ['total price of sales per week', 'week'],
      ['total price of sales by year', 'year']
    ] as const)
      expect(params(q), q).toEqual({
        aggregate: { value: { sum: 'price' } },
        groupBy: { bucket: { dateTrunc: [{ lit: unit }, 'soldAt'] } }
      });
  });

  it('drops a grouping it cannot express, keeping the whole aggregate', () => {
    for (const [q, span, reason] of [
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
      expect(r.candidates[0]?.frame, q).not.toHaveProperty('shop/Item.params.groupBy');
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
async function ask(question: string, e: NlEngineAccess, pack = served): Promise<NlOutcome> {
  const evs: NlEvent[] = [];
  for await (const ev of runAsk({ namespace: 'shop', question }, http, { pack, engine: e }))
    evs.push(ev);
  return (evs.find((x) => x.event === 'outcome') as Extract<NlEvent, { event: 'outcome' }>).outcome;
}
type Sent = Record<string, { params: Record<string, unknown>; fields: Record<string, unknown> }>;
/** The shop pack with `extra` types added or replaced; a Plan's time field is startedAt. */
function withTypes(extra: Schema['types']) {
  const p = buildNamespacePack({
    namespace: 'shop',
    schema: { schemaVersion: 'v', mutations: {}, types: { ...types, ...extra } },
    operators: OPERATORS
  });
  const rulings: NamespaceRulings = { timeField: { ...base.timeField, Plan: 'startedAt' } };
  const parsed = (q: string) => parseQuestion(q, p, { asOf, rulings });
  return {
    served: { ...p, rulings, warnings: [] } as ServedPack,
    parse: parsed,
    params: (q: string) => Object.values(parsed(q).candidates[0]?.frame ?? {})[0]?.params
  };
}

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
            { bucket: '2026-10-20T00:00:00.000000Z', value: 30 },
            { bucket: '2026-10-21T00:00:00.000000Z', value: 5 }
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

  it('labels each group by its unit', async () => {
    for (const [q, instants, keys] of [
      [
        'total price of sales per week',
        ['2026-10-19T00:00:00.000000Z', '2026-10-26T00:00:00.000000Z'],
        ['2026-10-19', '2026-10-26']
      ],
      ['total price of sales per month', ['2026-10-01T00:00:00.000000Z'], ['2026-10']],
      ['total price of sales per year', ['2026-01-01T00:00:00.000000Z'], ['2026']]
    ] as const) {
      const { e } = engine(() => ({
        data: { 'shop/Sale': { groups: instants.map((bucket) => ({ bucket, value: 1 })) } }
      }));
      const o = await ask(q, e);
      expect(
        (o as { aggregate: { groups: { key: string }[] } }).aggregate.groups.map((g) => g.key),
        q
      ).toEqual(keys);
    }
  });

  it('counts per time unit', async () => {
    const q = 'how many sales per month';
    expect(params(q)).toEqual({
      aggregate: { value: { count: true } },
      groupBy: { bucket: { dateTrunc: [{ lit: 'month' }, 'soldAt'] } }
    });
    expect(parse(q).candidates[0]?.aggregate).toEqual({ fn: 'count', field: '*' });
    const { e } = engine(() => ({
      data: {
        'shop/Sale': {
          groups: [
            { bucket: '2026-10-01T00:00:00.000000Z', value: 3 },
            { bucket: null, value: 1 }
          ]
        }
      }
    }));
    expect(await ask(q, e)).toMatchObject({
      aggregate: { fn: 'count', field: '*', by: 'month', groups: [{ key: '2026-10', value: 3 }] }
    });
  });

  it('keeps the unit when a count drops an aggregate', () => {
    const r = parse('how many sales max price per month');
    expect(r.candidates[0]?.dropped).toContainEqual(
      expect.objectContaining({ reason: 'an aggregate does not apply to a count' })
    );
    expect(params('how many sales max price per month')).toEqual({
      aggregate: { value: { count: true } },
      groupBy: { bucket: { dateTrunc: [{ lit: 'month' }, 'soldAt'] } }
    });
  });

  it('reads a unit before a field group in the same question', () => {
    const r = parse('average price of items by condition per month');
    expect(params('average price of items by condition per month')).toEqual({
      aggregate: { value: { avg: 'price' } },
      groupBy: { bucket: { dateTrunc: [{ lit: 'month' }, 'listedAt'] } }
    });
    expect(r.candidates[0]?.residual).toContain('condition');
    expect(r.status).toBe('partial');
  });

  it('reads unit adjectives beside an aggregate or a count', () => {
    const total = (unit: string) => ({
      aggregate: { value: { sum: 'price' } },
      groupBy: { bucket: { dateTrunc: [{ lit: unit }, 'soldAt'] } }
    });
    for (const [q, unit] of [
      ['monthly total price of sales', 'month'],
      ['total monthly price of sales', 'month'],
      ['annual total price of sales', 'year'],
      ['total price of sales annually', 'year']
    ] as const) {
      expect(parse(q).status, q).toBe('resolved');
      expect(params(q), q).toEqual(total(unit));
    }
    expect(parse('how many sales weekly').status).toBe('resolved');
    expect(params('how many sales weekly')).toEqual({
      aggregate: { value: { count: true } },
      groupBy: { bucket: { dateTrunc: [{ lit: 'week' }, 'soldAt'] } }
    });
    expect(parse('daily how many sales').candidates[0]?.aggregate).toEqual({
      fn: 'count',
      field: '*'
    });
    expect(params('daily how many sales')).toEqual({
      aggregate: { value: { count: true } },
      groupBy: { bucket: { dateTrunc: [{ lit: 'day' }, 'soldAt'] } }
    });
    // The same late claim takes "by|per <unit>" before "how many".
    expect(params('per month how many sales')).toEqual({
      aggregate: { value: { count: true } },
      groupBy: { bucket: { dateTrunc: [{ lit: 'month' }, 'soldAt'] } }
    });
  });

  // Every case below has one reading, so each resolves: none needs ambiguous or unknown.
  it('lets the data win over a unit adjective', () => {
    const r = parse('monthly subscriptions');
    expect(r.status).toBe('resolved');
    expect(params('monthly subscriptions')).toEqual({ where: { cycle: { eq: 'monthly' } } });
    // Not beside the aggregate word: the value claim wins.
    expect(parse('total price of monthly subscriptions').status).toBe('resolved');
    expect(params('total price of monthly subscriptions')).toEqual({
      where: { cycle: { eq: 'monthly' } },
      aggregate: { value: { sum: 'price' } }
    });
    // Beside the aggregate word: the unit wins, though "monthly" is a value of cycle.
    expect(parse('monthly total price of subscriptions').status).toBe('resolved');
    expect(params('monthly total price of subscriptions')).toEqual({
      aggregate: { value: { sum: 'price' } },
      groupBy: { bucket: { dateTrunc: [{ lit: 'month' }, 'startedAt'] } }
    });
    expect(parse('how many monthly subscriptions').status).toBe('resolved');
    expect(params('how many monthly subscriptions')).toEqual({
      where: { cycle: { eq: 'monthly' } }
    });
  });

  it('reads no value beside an aggregate word that claimed no field', async () => {
    const plans = withTypes({
      Plan: { fields: { cycle: { ...str, enum: ['annual', 'monthly'] }, price: num } }
    });
    for (const [q, pk] of [
      ['monthly total of subscriptions', served],
      ['yearly total of subscriptions', served],
      ['annual total of plans', plans.served],
      ['monthly total of plans', plans.served],
      // Nor is it a unit for a count or another aggregate in the question.
      ['how many monthly total subscriptions', served],
      ['average price of monthly total subscriptions', served]
    ] as const) {
      const { e, query } = engine(() => ({ data: {} }));
      expect((await ask(q, e, pk)).kind, q).toBe('unknown');
      expect(query, q).not.toHaveBeenCalled();
    }
    const r = parse('monthly total of subscriptions');
    expect(r.status).toBe('partial');
    expect(r.residual).toEqual(['monthly']);
  });

  // Each resolves or stays partial with the adjective unread: none needs ambiguous.
  it('lets a field name win over a unit adjective', () => {
    for (const [q, fn] of [
      ['total annual fee of subscriptions', 'sum'],
      ['highest annual fee of subscriptions', 'max']
    ] as const) {
      expect(parse(q).status, q).toBe('resolved');
      expect(params(q), q).toEqual({ aggregate: { value: { [fn]: 'annualFee' } } });
    }
    const yearlyFee: NamespaceRulings = {
      ...base,
      fieldPhrases: { 'yearly fee': { field: 'Subscription.fee' } }
    };
    expect(params('total yearly fee of subscriptions', yearlyFee)).toEqual({
      aggregate: { value: { sum: 'fee' } }
    });
    // No field name begins with "annual total" here, so the adjective is the unit.
    expect(params('annual total price of subscriptions')).toEqual({
      aggregate: { value: { sum: 'price' } },
      groupBy: { bucket: { dateTrunc: [{ lit: 'year' }, 'startedAt'] } }
    });
  });

  it('lets a field of the asked type win over a unit adjective', async () => {
    const plans = withTypes({
      Plan: {
        fields: {
          cycle: { ...str, enum: ['annual', 'monthly'] },
          annualTotal: num,
          price: num,
          startedAt: date
        }
      }
    });
    // Before the aggregate word, "annual" begins the field "annual total": neither a unit nor
    // a cycle value is assumed, so it is dropped and ask is unknown (not ambiguous).
    const before = plans.parse('annual total price of plans');
    expect(before.status).toBe('partial');
    expect(before.candidates[0]?.dropped).toEqual([
      {
        span: 'annual',
        reason:
          'beside "total" it could be the unit or part of another reading; neither is assumed',
        kind: 'filter'
      }
    ]);
    expect(plans.params('annual total price of plans')).toEqual({
      aggregate: { value: { sum: 'price' } }
    });
    const { e, query } = engine(() => ({ data: {} }));
    expect((await ask('annual total price of plans', e, plans.served)).kind).toBe('unknown');
    expect(query).not.toHaveBeenCalled();
    // After it, the field takes the adjective.
    expect(plans.parse('average annual total of plans').status).toBe('resolved');
    expect(plans.params('average annual total of plans')).toEqual({
      aggregate: { value: { avg: 'annualTotal' } }
    });
    expect(plans.params('monthly total price of plans')).toEqual({
      aggregate: { value: { sum: 'price' } },
      groupBy: { bucket: { dateTrunc: [{ lit: 'month' }, 'startedAt'] } }
    });
  });

  it('reads a field name only on the asked type and the types it references', () => {
    const other = withTypes({
      Plan: { fields: { monthlyTotal: num, annualTotal: num, monthlyPrice: num } }
    });
    for (const [q, unit] of [
      ['monthly total price of subscriptions', 'month'],
      ['total monthly price of subscriptions', 'month'],
      ['annual total price of subscriptions', 'year']
    ] as const) {
      expect(other.parse(q).status, q).toBe('resolved');
      expect(other.params(q), q).toEqual({
        aggregate: { value: { sum: 'price' } },
        groupBy: { bucket: { dateTrunc: [{ lit: unit }, 'startedAt'] } }
      });
    }
    // Sale references Item, so Item's "monthly price" is a field the question may mean.
    const walked = withTypes({
      Item: { fields: { ...(types.Item as { fields: object }).fields, monthlyPrice: num } }
    }).parse('total monthly price of sales');
    expect(walked.status).toBe('partial');
    expect(walked.candidates[0]?.dropped[0]?.reason).toBe(
      'aggregating across a walk is not supported'
    );
  });

  it('leaves a lone adjective unread', async () => {
    const r = parse('weekly sales');
    expect(r.status).toBe('partial');
    expect(r.residual).toEqual(['weekly']);
    expect(params('weekly sales')).toEqual({});
    const { e, query } = engine(() => ({ data: { 'shop/Sale': [] } }));
    expect((await ask('weekly sales', e)).kind).toBe('unknown');
    expect(query).not.toHaveBeenCalled();
    // "monthly" is a Subscription.cycle value: the value claim wins and rules out the Sale reading.
    for (const q of ['monthly sales', 'total price of sales monthly']) {
      const m = parse(q);
      expect(m.status, q).toBe('unparsed');
      expect(m.reason, q).toBe('Sale: "monthly" is not a Sale value');
      expect(m.candidates, q).toEqual([]);
    }
  });

  it('reads no value beside a superlative that orders', async () => {
    // "highest" orders here; beside it "monthly" is neither the cycle nor a unit.
    const q = 'subscriptions with the monthly highest price';
    const r = parse(q);
    expect(r.status).toBe('partial');
    expect(r.residual).toEqual(['monthly']);
    expect(params(q)).toEqual({ orderBy: [{ price: 'desc' }], limit: 10 });
    const { e, query } = engine(() => ({ data: {} }));
    expect((await ask(q, e)).kind).toBe('unknown');
    expect(query).not.toHaveBeenCalled();
    // Away from the superlative the value claim still filters.
    expect(params('monthly subscriptions with the highest price')).toEqual({
      where: { cycle: { eq: 'monthly' } },
      orderBy: [{ price: 'desc' }],
      limit: 10
    });
    // After it, the ordering takes "monthly" as its field and drops it: no cycle filter.
    const after = parse('subscriptions with the highest monthly price');
    expect(after.status).toBe('partial');
    expect(after.candidates[0]?.dropped).toEqual([
      { span: 'highest monthly', reason: 'Subscription has no field "monthly"', kind: 'order' }
    ]);
    expect(params('subscriptions with the highest monthly price')).toEqual({});
  });

  it('windows a count or aggregate to a named year, grouped where the question asks', () => {
    const window = { gte: '2025-01-01T00:00:00Z', lt: '2026-01-01T00:00:00Z' };
    const month = { bucket: { dateTrunc: [{ lit: 'month' }, 'soldAt'] } };
    for (const [q, grouped] of [
      ['how many sales per month in 2025', true],
      ['how many sales in 2025 per month', true],
      ['monthly total price of sales in 2025', true],
      ['how many sales in 2025', false]
    ] as const) {
      const r = parse(q);
      expect(r.status, q).toBe('resolved');
      expect(r.residual, q).toEqual([]);
      expect(params(q), q).toMatchObject({ where: { soldAt: window } });
      if (grouped) expect(params(q), q).toMatchObject({ groupBy: month });
      else expect(params(q), q).not.toHaveProperty('groupBy');
    }
  });

  it('answers unknown when a count or aggregate leaves a number unread', async () => {
    for (const q of [
      'how many sales 2025',
      'how many sales per month 2025',
      'total price of sales per month 2025'
    ]) {
      const r = parse(q);
      expect(r.status, q).toBe('partial');
      expect(r.residual, q).toEqual(['2025']);
      const { e, query } = engine(() => ({ data: {} }));
      expect((await ask(q, e)).kind, q).toBe('unknown');
      expect(query, q).not.toHaveBeenCalled();
    }
  });

  it('leaves a count without a unit unchanged', () => {
    expect(params('how many sales')).toEqual({});
    expect(parse('how many sales').candidates[0]?.answer).toBe('count');
  });

  it('drops the null-key group of a day grouping, a row with no time field', async () => {
    const { e } = engine(() => ({
      data: {
        'shop/Sale': {
          groups: [
            { bucket: '2026-10-20T00:00:00.000000Z', value: 30 },
            { bucket: null, value: 9 }
          ]
        }
      }
    }));
    const o = await ask('total price of sales per day', e);
    expect(o).toMatchObject({
      aggregate: { by: 'day', groups: [{ key: '2026-10-20', value: 30 }] }
    });
  });

  it('drops a computed ordering whose name is a field of the type', () => {
    const rulings: NamespaceRulings = {
      ...base,
      fieldPhrases: { views: { select: { sub: ['Item.price', 'Item.views'] } } }
    };
    const r = parse('items by views', rulings);
    expect(r.candidates[0]?.dropped).toContainEqual(
      expect.objectContaining({ reason: 'its name "views" is also a field of Item' })
    );
    expect(params('items by views', rulings)).not.toHaveProperty('select');
  });

  it('groups by an enum field with one aggregate per value', async () => {
    const { e, query } = engine((f) => {
      const where = JSON.stringify((f as Sent)['shop/Item']?.params.where);
      const value = where.includes('"new"') ? 20 : where.includes('"used"') ? 8 : 4;
      return { data: { 'shop/Item': { groups: [{ value }] } } };
    });
    const o = await ask('average price of lamp items by condition', e);
    expect(query).toHaveBeenCalledTimes(3);
    expect((query.mock.calls[2]?.[0] as Sent | undefined)?.['shop/Item']?.params.where).toEqual({
      AND: [{ name: { eq: 'lamp' } }, { condition: { eq: null } }]
    });
    expect((query.mock.calls[0]?.[0] as Sent | undefined)?.['shop/Item']?.params.where).toEqual({
      AND: [{ name: { eq: 'lamp' } }, { condition: { eq: 'new' } }]
    });
    expect(o).toMatchObject({
      kind: 'rows',
      answer: 'aggregate',
      data: {
        groups: [
          { key: 'new', value: 20 },
          { key: 'used', value: 8 },
          { key: null, value: 4 }
        ]
      },
      aggregate: {
        fn: 'avg',
        field: 'price',
        by: 'condition',
        groups: [
          { key: 'new', value: 20 },
          { key: 'used', value: 8 },
          { key: null, value: 4 }
        ]
      }
    });
  });

  it('leaves out the no-value group when it has no value', async () => {
    const { e } = engine((f) => {
      const where = JSON.stringify((f as Sent)['shop/Item']?.params.where);
      return { data: { 'shop/Item': { groups: [{ value: where.includes('null') ? null : 1 }] } } };
    });
    const o = await ask('average price of items by featured', e);
    expect(o).toMatchObject({
      aggregate: {
        groups: [
          { key: true, value: 1 },
          { key: false, value: 1 }
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
