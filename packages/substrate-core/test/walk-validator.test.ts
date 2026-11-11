/**
 * Walk and `$ref` validation (typed edge walks spec §1 Grammar, §2 Validation).
 */

import type { FilterCapabilities, TypeSchema, WhereClause } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { FilterValidationError, validateFilter } from '../src/filter/validator.js';
import { MAX_DATE_SHIFT_MS } from '../src/filter/walk-validator.js';

const ref = (type: string, ns = 'cards') =>
  ({ kind: 'crossRef', ns, type, onDelete: 'set_null' }) as const;

const SCHEMAS: Record<string, TypeSchema> = {
  Cert: {
    fields: {
      grade: { kind: 'scalar', type: 'number' },
      ask: { kind: 'scalar', type: 'number' },
      psaOffer: { kind: 'scalar', type: 'number' },
      gradedAt: { kind: 'scalar', type: 'date' },
      set: ref('Set'),
      label: { kind: 'scalar', type: 'string' }
    }
  },
  Set: { fields: { name: { kind: 'scalar', type: 'string' }, series: ref('Series') } },
  Series: { fields: { era: ref('Era') } },
  Era: { fields: { name: { kind: 'scalar', type: 'string' } } },
  Listing: {
    fields: {
      cert: ref('Cert'),
      price: { kind: 'scalar', type: 'number' },
      firstSeen: { kind: 'scalar', type: 'date' },
      seller: { kind: 'scalar', type: 'string' },
      certs: { kind: 'list', of: ref('Cert') },
      meta: { kind: 'struct', fields: { cert: ref('Cert') } }
    }
  },
  Observation: {
    fields: {
      cert: ref('Cert'),
      price: { kind: 'scalar', type: 'number' },
      observedAt: { kind: 'scalar', type: 'date' },
      flag: { kind: 'scalar', type: 'boolean' },
      qty: { kind: 'scalar', type: 'int64' },
      elsewhere: ref('Cert', 'other'),
      dims: { kind: 'struct', fields: { w: { kind: 'scalar', type: 'number' } } }
    }
  }
};

const CAPS: FilterCapabilities = {
  operators: {
    'scalar.number': ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'in', 'nin'],
    'scalar.string': ['eq', 'neq', 'contains', 'in', 'nin'],
    'scalar.boolean': ['eq'],
    'scalar.date': ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'in', 'nin'],
    'scalar.int64': ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'in', 'nin'],
    'scalar.json': [],
    crossRef: ['eq', 'neq', 'in', 'nin'],
    list: ['has']
  },
  orderBy: true,
  cursor: true
} as FilterCapabilities;

function check(where: unknown, type = 'Cert'): void {
  validateFilter({
    where: where as WhereClause,
    typeSchema: SCHEMAS[type] as TypeSchema,
    capabilities: CAPS,
    schemaOf: (t) => SCHEMAS[t],
    namespace: 'cards',
    typeName: type
  });
}

function refusal(where: unknown, type = 'Cert'): { code: string; path: string[] } {
  try {
    check(where, type);
  } catch (err) {
    if (err instanceof FilterValidationError) return { code: err.code, path: err.path };
    throw err;
  }
  throw new Error('expected a refusal');
}

const listing = (extra: Record<string, unknown> = {}) => ({
  _walk: { in: 'cards/Listing.cert', ...extra }
});

describe('walk validation', () => {
  it('accepts the yardstick where', () => {
    expect(() =>
      check({
        AND: [
          { grade: { eq: 9 } },
          {
            _walk: {
              as: 'L',
              in: 'cards/Listing.cert',
              where: { firstSeen: { gte: '2026-10-22T00:00:00Z' } }
            }
          },
          {
            _walk: {
              as: 'O',
              in: 'cards/Observation.cert',
              where: { price: { gte: { $ref: 'L.price', times: 1.25 } } }
            }
          }
        ]
      })
    ).not.toThrow();
    // Walk beside a field key ANDs, and none/all/pick walks may reference an any binding.
    expect(() =>
      check({ grade: { eq: 9 }, _walk: { as: 'L', in: 'cards/Listing.cert' } })
    ).not.toThrow();
    expect(() =>
      check({
        AND: [
          { grade: { eq: 9 }, _walk: { as: 'L', in: 'cards/Listing.cert' } },
          {
            _walk: {
              in: 'cards/Observation.cert',
              pick: { latest: 'observedAt' },
              where: { price: { gte: { $ref: 'L.price' } } }
            }
          },
          {
            _walk: {
              in: 'cards/Observation.cert',
              quantifier: 'none',
              where: { price: { lt: { $ref: '$.ask', plus: 5 } } }
            }
          }
        ]
      })
    ).not.toThrow();
  });

  it('refuses in: naming a field that is not a crossRef to the seed type', () => {
    expect(refusal(listing({ in: 'cards/Listing.price' }))).toEqual({
      code: 'walk_unknown_ref',
      path: ['where', '_walk', 'in']
    });
    // A crossRef, but to another type.
    expect(refusal({ _walk: { in: 'cards/Set.series' } })).toMatchObject({
      code: 'walk_unknown_ref'
    });
    expect(refusal({ _walk: { out: 'grade' } })).toEqual({
      code: 'walk_unknown_ref',
      path: ['where', '_walk', 'out']
    });
  });

  it('refuses a prototype-key type name as an unknown type', () => {
    // A plain-object type map, as the published schema uses, so `constructor` resolves to Object.
    const types: Record<string, TypeSchema> = { ...SCHEMAS };
    for (const type of ['constructor', '__proto__', 'toString']) {
      try {
        validateFilter({
          where: { _walk: { in: `cards/${type}.x` } } as WhereClause,
          typeSchema: SCHEMAS.Cert as TypeSchema,
          capabilities: CAPS,
          schemaOf: (t) => types[t],
          namespace: 'cards',
          typeName: 'Cert'
        });
        throw new Error('expected a refusal');
      } catch (err) {
        expect(err).toBeInstanceOf(FilterValidationError);
        expect(err).toMatchObject({ code: 'walk_unknown_ref', path: ['where', '_walk', 'in'] });
      }
    }
  });

  it('refuses a $ref inside a struct sub-filter', () => {
    expect(
      refusal({
        _walk: { in: 'cards/Observation.cert', where: { dims: { w: { gt: { $ref: '$.ask' } } } } }
      })
    ).toEqual({
      code: 'walk_unsupported_ref',
      path: ['where', '_walk', 'where', 'dims', 'w', 'gt']
    });
    expect(refusal({ dims: { w: { gt: { $ref: '$.price' } } } }, 'Observation')).toEqual({
      code: 'walk_unsupported_ref',
      path: ['where', 'dims', 'w', 'gt']
    });
  });

  it('refuses a list crossRef and a struct-nested crossRef', () => {
    expect(refusal({ _walk: { in: 'cards/Listing.certs' } })).toEqual({
      code: 'walk_unsupported_ref',
      path: ['where', '_walk', 'in']
    });
    expect(refusal({ _walk: { in: 'cards/Listing.meta.cert' } })).toEqual({
      code: 'walk_unsupported_ref',
      path: ['where', '_walk', 'in']
    });
    expect(refusal({ _walk: { out: 'certs' } }, 'Listing')).toEqual({
      code: 'walk_unsupported_ref',
      path: ['where', '_walk', 'out']
    });
  });

  it('refuses another namespace', () => {
    expect(refusal({ _walk: { in: 'other/Listing.cert' } })).toEqual({
      code: 'walk_cross_namespace',
      path: ['where', '_walk', 'in']
    });
    expect(refusal({ _walk: { out: 'elsewhere' } }, 'Observation')).toEqual({
      code: 'walk_cross_namespace',
      path: ['where', '_walk', 'out']
    });
  });

  it('refuses a fourth hop', () => {
    const hops = (n: number) => ({
      _walk: {
        in: 'cards/Listing.cert',
        where: {
          _walk: {
            out: 'cert',
            where: { _walk: { out: 'set', where: n > 3 ? { _walk: { out: 'series' } } : {} } }
          }
        }
      }
    });
    expect(() => check(hops(3))).not.toThrow();
    expect(refusal(hops(4))).toEqual({
      code: 'walk_too_deep',
      path: ['where', '_walk', 'where', '_walk', 'where', '_walk', 'where', '_walk']
    });
  });

  it('refuses as on none, all and pick walks', () => {
    for (const extra of [
      { quantifier: 'none' },
      { quantifier: 'all' },
      { pick: { latest: 'firstSeen' } }
    ]) {
      expect(refusal(listing({ as: 'L', ...extra }))).toEqual({
        code: 'walk_quantifier',
        path: ['where', '_walk', 'as']
      });
    }
  });

  it('refuses a $ref to a binding under OR or NOT', () => {
    // Referenced from inside an OR.
    expect(
      refusal({
        AND: [
          listing({ as: 'L' }),
          { OR: [{ ask: { gte: { $ref: 'L.price' } } }, { grade: { eq: 9 } }] }
        ]
      })
    ).toEqual({ code: 'walk_binding', path: ['where', 'AND', '1', 'OR', '0', 'ask', 'gte'] });
    // Bound inside a NOT, referenced from outside.
    expect(
      refusal({ AND: [{ NOT: listing({ as: 'L' }) }, { ask: { gte: { $ref: 'L.price' } } }] })
    ).toEqual({ code: 'walk_binding', path: ['where', 'AND', '1', 'ask', 'gte'] });
  });

  it('caps jointly bound walks at 3 per AND group and 6 per frame', () => {
    const bound = (...names: string[]) => names.map((as) => listing({ as }));
    expect(() => check({ AND: bound('A', 'B', 'C') })).not.toThrow();
    expect(refusal({ AND: bound('A', 'B', 'C', 'D') })).toEqual({
      code: 'walk_binding',
      path: ['where']
    });
    // 7 across three groups: each group is under the cap, the frame is not.
    expect(
      refusal({
        OR: [{ AND: bound('A', 'B', 'C') }, { AND: bound('D', 'E', 'F') }, { AND: bound('G') }]
      })
    ).toEqual({ code: 'walk_binding', path: ['where', 'OR', '2'] });
    expect(() =>
      check({ OR: [{ AND: bound('A', 'B', 'C') }, { AND: bound('D', 'E', 'F') }] })
    ).not.toThrow();
  });

  it('refuses a $ref to an unknown binding or field', () => {
    expect(refusal({ ask: { gte: { $ref: 'X.price' } } })).toEqual({
      code: 'ref_unresolved',
      path: ['where', 'ask', 'gte']
    });
    expect(refusal({ AND: [listing({ as: 'L' }), { ask: { gte: { $ref: 'L.nope' } } }] })).toEqual({
      code: 'ref_unresolved',
      path: ['where', 'AND', '1', 'ask', 'gte']
    });
    expect(refusal({ ask: { gte: { $ref: '$.nope' } } })).toMatchObject({
      code: 'ref_unresolved'
    });
  });

  it('refuses $ref from a number field to a date field', () => {
    expect(refusal({ ask: { gte: { $ref: '$.gradedAt' } } })).toEqual({
      code: 'ref_kind_mismatch',
      path: ['where', 'ask', 'gte']
    });
    // Only number and date fields take a $ref.
    expect(refusal({ label: { eq: { $ref: '$.label' } } })).toMatchObject({
      code: 'ref_kind_mismatch'
    });
  });

  it('accepts same-row $.field compare (#1770 1a)', () => {
    expect(() => check({ psaOffer: { gt: { $ref: '$.ask', times: 1.1, plus: 2 } } })).not.toThrow();
    // No walk lookup is needed for a same-row compare.
    expect(() =>
      validateFilter({
        where: { psaOffer: { gt: { $ref: '$.ask' } } },
        typeSchema: SCHEMAS.Cert as TypeSchema,
        capabilities: CAPS
      })
    ).not.toThrow();
  });

  it("validates the far-side where against the far type's operators", () => {
    expect(refusal(listing({ where: { cert: { contains: 'x' } } }))).toEqual({
      code: 'unknown_operator',
      path: ['where', '_walk', 'where', 'cert', 'contains']
    });
    expect(refusal(listing({ where: { grade: { eq: 9 } } }))).toEqual({
      code: 'unknown_field',
      path: ['where', '_walk', 'where', 'grade']
    });
  });

  it('accepts _agg in where structurally, validating its walk like a _walk', () => {
    expect(() =>
      check({ _agg: { in: 'cards/Observation.cert', count: true }, gte: 3 })
    ).not.toThrow();
    expect(refusal({ _agg: { in: 'other/Observation.cert', count: true }, gte: 3 })).toEqual({
      code: 'walk_cross_namespace',
      path: ['where', '_agg', 'in']
    });
  });
});

type Frame = Omit<Parameters<typeof validateFilter>[0], 'typeSchema' | 'capabilities'>;

function checkFrame(frame: Frame, type = 'Cert'): void {
  validateFilter({
    ...frame,
    typeSchema: SCHEMAS[type] as TypeSchema,
    capabilities: CAPS,
    schemaOf: (t) => (Object.hasOwn(SCHEMAS, t) ? SCHEMAS[t] : undefined),
    namespace: 'cards',
    typeName: type
  });
}

function frameRefusal(frame: Frame, type = 'Cert'): { code: string; path: string[] } {
  try {
    checkFrame(frame, type);
  } catch (err) {
    if (err instanceof FilterValidationError) return { code: err.code, path: err.path };
    throw err;
  }
  throw new Error('expected a refusal');
}

const SPEC_AGG = {
  offers7d: {
    in: 'cards/Observation.cert',
    where: { observedAt: { gte: '2026-10-23T00:00:00Z' } },
    avg: 'price'
  },
  obsCount: { in: 'cards/Observation.cert', count: true },
  latestOffer: { in: 'cards/Observation.cert', latest: { by: 'observedAt', value: 'price' } }
};

describe('aggregate, select, groupBy, count and nested validation', () => {
  it("accepts the spec's _agg feature row", () => {
    expect(() => checkFrame({ fields: { id: true, grade: true, _agg: SPEC_AGG } })).not.toThrow();
  });

  it('refuses a malformed _agg', () => {
    expect(
      frameRefusal({ fields: { _agg: { a: { in: 'cards/Observation.cert', avg: 'observedAt' } } } })
    ).toEqual({ code: 'agg_invalid', path: ['fields', '_agg', 'a', 'avg'] });
    expect(
      frameRefusal({
        fields: { _agg: { a: { in: 'cards/Observation.cert', count: true, sum: 'price' } } }
      })
    ).toEqual({ code: 'agg_invalid', path: ['fields', '_agg', 'a'] });
    expect(
      frameRefusal({
        fields: { _agg: JSON.parse('{"__proto__":{"in":"cards/Observation.cert","count":true}}') }
      }).code
    ).toBe('agg_invalid');
    expect(frameRefusal({ fields: { id: true, _agg: {} } })).toEqual({
      code: 'agg_invalid',
      path: ['fields', '_agg']
    });
  });

  it('accepts _agg in where with a numeric comparison', () => {
    expect(() =>
      check({ _agg: { in: 'cards/Observation.cert', avg: 'price' }, gte: 120 })
    ).not.toThrow();
    expect(refusal({ _agg: { in: 'cards/Observation.cert', count: true } })).toEqual({
      code: 'agg_invalid',
      path: ['where', '_agg']
    });
    expect(refusal({ _agg: { in: 'cards/Observation.cert', count: true }, gte: 'x' }).code).toBe(
      'type_mismatch'
    );
    // Only comparisons sit beside _agg; a field or walk there is refused, not ANDed.
    expect(
      refusal({ _agg: { in: 'cards/Observation.cert', count: true }, gte: 2, grade: { eq: 9 } })
    ).toEqual({ code: 'agg_invalid', path: ['where', 'grade'] });
    expect(
      refusal({
        _agg: { in: 'cards/Observation.cert', count: true },
        gte: 2,
        _walk: { in: 'cards/Listing.cert' }
      }).code
    ).toBe('agg_invalid');
    expect(() =>
      check({ _agg: { in: 'cards/Observation.cert', avg: 'price' }, gt: 1, lt: 9 })
    ).not.toThrow();
  });

  it('refuses latest on a frame aggregate', () => {
    expect(
      frameRefusal({ aggregate: { last: { latest: { by: 'gradedAt', value: 'ask' } } } })
    ).toEqual({ code: 'agg_invalid', path: ['aggregate', 'last', 'latest'] });
  });

  it('accepts a whole-result aggregate grouped by a day', () => {
    expect(() =>
      checkFrame(
        {
          where: { observedAt: { gte: '2026-10-23T00:00:00Z' } },
          aggregate: { n: { count: true }, avgOffer: { avg: 'price' } },
          groupBy: { bucket: { dateTrunc: [{ lit: 'day' }, 'observedAt'] } }
        },
        'Observation'
      )
    ).not.toThrow();
    expect(() =>
      checkFrame({
        aggregate: { n: { count: true } },
        groupBy: { bucket: { dateTrunc: [{ lit: 'hour' }, 'gradedAt'] } }
      })
    ).not.toThrow();
  });

  it('date and number metadata read in expressions; string metadata does not', () => {
    expect(() =>
      checkFrame({
        aggregate: { n: { count: true } },
        groupBy: { bucket: { dateTrunc: [{ lit: 'day' }, 'createdAt'] } }
      })
    ).not.toThrow();
    expect(() =>
      checkFrame({
        select: { y: { extract: [{ lit: 'year' }, 'updatedAt'] }, s: { add: ['seq', 1] } }
      })
    ).not.toThrow();
    expect(() => checkFrame({ where: { $expr: { gt: ['createdAt', 'gradedAt'] } } })).not.toThrow();
    expect(frameRefusal({ select: { x: { length: ['createdById'] } } }).code).toBe('expr_invalid');
  });

  it('having sees only the outputs, not row metadata', () => {
    const grouped = (having: unknown) => ({
      aggregate: { n: { count: true } },
      groupBy: { g: 'grade' },
      having
    });
    expect(() => checkFrame(grouped({ gt: ['n', 1] }))).not.toThrow();
    for (const name of ['seq', 'createdAt', 'updatedAt']) {
      expect(frameRefusal(grouped({ eq: [name, name] })).code, name).toBe('expr_invalid');
    }
  });

  it('refuses an empty aggregate', () => {
    expect(frameRefusal({ aggregate: {} })).toEqual({ code: 'agg_invalid', path: ['aggregate'] });
    expect(() => checkFrame({ aggregate: {} })).toThrow('aggregate needs at least one entry');
  });

  it('refuses groupBy without aggregate, and dateTrunc on a non-date field', () => {
    expect(
      frameRefusal({ groupBy: { bucket: { dateTrunc: [{ lit: 'day' }, 'gradedAt'] } } })
    ).toEqual({ code: 'agg_invalid', path: ['groupBy'] });
    expect(
      frameRefusal({
        aggregate: { n: { count: true } },
        groupBy: { bucket: { dateTrunc: [{ lit: 'day' }, 'grade'] } }
      })
    ).toEqual({ code: 'expr_invalid', path: ['groupBy', 'bucket', 'dateTrunc', '1'] });
    expect(
      frameRefusal({
        aggregate: { n: { count: true } },
        groupBy: { bucket: { dateTrunc: [{ lit: 'fortnight' }, 'gradedAt'] } }
      })
    ).toEqual({ code: 'expr_invalid', path: ['groupBy', 'bucket', 'dateTrunc', '0'] });
  });

  it('refuses count with aggregate', () => {
    expect(frameRefusal({ count: true, aggregate: { n: { count: true } } })).toEqual({
      code: 'count_conflict',
      path: ['aggregate']
    });
    expect(frameRefusal({ count: true, fields: { id: true, grade: true } })).toEqual({
      code: 'count_conflict',
      path: ['fields', 'grade']
    });
    expect(frameRefusal({ count: true, orderBy: [{ grade: 'desc' }] })).toEqual({
      code: 'count_conflict',
      path: ['orderBy']
    });
    expect(() =>
      checkFrame({ count: true, where: { grade: { eq: 9 } }, fields: { id: true } })
    ).not.toThrow();
  });

  it('refuses aggregate with row-only params', () => {
    expect(frameRefusal({ aggregate: { n: { count: true } }, fields: { _agg: SPEC_AGG } })).toEqual(
      { code: 'agg_invalid', path: ['fields', '_agg'] }
    );
    expect(frameRefusal({ aggregate: { n: { count: true } }, cursor: 'c' })).toEqual({
      code: 'agg_invalid',
      path: ['cursor']
    });
    expect(
      frameRefusal({ aggregate: { n: { count: true } }, orderBy: [{ grade: 'desc' }] })
    ).toEqual({ code: 'agg_invalid', path: ['orderBy'] });
    expect(
      frameRefusal({ aggregate: { n: { count: true } }, fields: { id: true, grade: true } })
    ).toEqual({ code: 'agg_invalid', path: ['fields', 'grade'] });
  });

  it('orderBy margin requires select.margin', () => {
    expect(frameRefusal({ orderBy: [{ margin: 'desc' }] })).toEqual({
      code: 'unknown_field',
      path: ['orderBy', '0', 'margin']
    });
    // The `$<name>` form went with derive: it is an unknown field now.
    expect(frameRefusal({ orderBy: [{ $margin: 'desc' }] }).code).toBe('unknown_field');
    expect(() =>
      checkFrame({
        select: { margin: { sub: ['psaOffer', 'ask'] } },
        orderBy: [{ margin: 'desc' }]
      })
    ).not.toThrow();
    expect(frameRefusal({ select: { margin: { sub: ['label', 'ask'] } } })).toEqual({
      code: 'expr_invalid',
      path: ['select', 'margin', 'sub', '0']
    });
  });

  it('a select of one walked value orders by it', () => {
    expect(() =>
      checkFrame({
        fields: { id: true, _agg: SPEC_AGG },
        select: { v: '_agg.latestOffer' },
        orderBy: [{ v: 'desc' }]
      })
    ).not.toThrow();
    expect(() => checkFrame({ select: { v: 'ask' } })).not.toThrow();
    expect(frameRefusal({ select: { v: '_agg.nope' } })).toEqual({
      code: 'expr_invalid',
      path: ['select', 'v']
    });
  });

  it('a select over _agg.x needs a frame _agg', () => {
    expect(frameRefusal({ select: { r: { div: ['_agg.latestOffer', 'ask'] } } })).toEqual({
      code: 'expr_invalid',
      path: ['select', 'r', 'div', '0']
    });
    expect(() =>
      checkFrame({
        fields: { id: true, _agg: SPEC_AGG },
        select: { r: { div: ['_agg.latestOffer', 'ask'] } },
        orderBy: [{ r: 'asc' }]
      })
    ).not.toThrow();
  });

  it("resolves $ref '_agg.<name>' against the frame's _agg", () => {
    expect(() =>
      checkFrame({
        where: { ask: { lt: { $ref: '_agg.offers7d' } } },
        fields: { _agg: SPEC_AGG }
      })
    ).not.toThrow();
    expect(frameRefusal({ where: { ask: { lt: { $ref: '_agg.nope' } } } }).code).toBe(
      'ref_unresolved'
    );
  });

  it('on a date field a $ref takes plus and refuses times', () => {
    expect(() =>
      check({ gradedAt: { gt: { $ref: '$.gradedAt', plus: 86_400_000 } } })
    ).not.toThrow();
    expect(refusal({ gradedAt: { gt: { $ref: '$.gradedAt', times: 2 } } }).code).toBe(
      'ref_kind_mismatch'
    );
  });

  it('bounds a date $ref shift at MAX_DATE_SHIFT_MS either way', () => {
    for (const plus of [MAX_DATE_SHIFT_MS, -MAX_DATE_SHIFT_MS]) {
      expect(() => check({ gradedAt: { gt: { $ref: '$.gradedAt', plus } } })).not.toThrow();
    }
    for (const plus of [MAX_DATE_SHIFT_MS + 1, -MAX_DATE_SHIFT_MS - 1, 1e17, -1e15]) {
      expect(refusal({ gradedAt: { gt: { $ref: '$.gradedAt', plus } } })).toEqual({
        code: 'type_mismatch',
        path: ['where', 'gradedAt', 'gt', 'plus']
      });
    }
    // A number $ref is not a date shift and keeps any finite plus.
    expect(() => check({ ask: { gt: { $ref: '$.ask', plus: 1e17 } } })).not.toThrow();
  });

  it('refuses pick with a none or all quantifier, and resolves pick fields like $ref', () => {
    expect(
      refusal({
        _walk: { in: 'cards/Observation.cert', quantifier: 'none', pick: { latest: 'observedAt' } }
      }).code
    ).toBe('walk_quantifier');
    expect(() =>
      check({ _walk: { in: 'cards/Observation.cert', pick: { latest: 'createdAt' } } })
    ).not.toThrow();
  });

  it('validates nested selections', () => {
    expect(() =>
      checkFrame({
        fields: {
          id: true,
          listings: {
            _walk: { in: 'cards/Listing.cert' },
            fields: { price: true, seller: true },
            orderBy: [{ firstSeen: 'desc' }],
            limit: 5
          }
        }
      })
    ).not.toThrow();
    expect(
      frameRefusal({
        fields: {
          listings: { _walk: { in: 'cards/Listing.cert' }, fields: {}, orderBy: [{ grade: 'asc' }] }
        }
      })
    ).toEqual({ code: 'unknown_field', path: ['fields', 'listings', 'orderBy', '0', 'grade'] });
    expect(
      frameRefusal({ fields: { listings: { _walk: { in: 'cards/Nope.cert' }, fields: {} } } }).code
    ).toBe('walk_unknown_ref');
    expect(
      frameRefusal({
        fields: { listings: { _walk: { in: 'cards/Listing.cert' }, fields: {}, limit: -1 } }
      })
    ).toEqual({ code: 'type_mismatch', path: ['fields', 'listings', 'limit'] });
    const nested = (extra: Record<string, unknown>) => ({
      fields: { listings: { _walk: { in: 'cards/Listing.cert' }, fields: {}, ...extra } }
    });
    expect(frameRefusal(nested({ orderBy: [{ price: 'asc' }, { shortId: 'desc' }] }))).toEqual({
      code: 'unknown_field',
      path: ['fields', 'listings', 'orderBy', '1', 'shortId']
    });
    for (const k of ['_metadata', 'shortId', '_deletedAt']) {
      expect(frameRefusal(nested({ fields: { price: true, [k]: true } }))).toEqual({
        code: 'unknown_field',
        path: ['fields', 'listings', 'fields', k]
      });
    }
  });

  it('refuses a nested selection named after a declared field, at any depth', () => {
    expect(
      frameRefusal(
        { fields: { price: true, cert: { _walk: { out: 'cert' }, fields: { grade: true } } } },
        'Listing'
      )
    ).toEqual({ code: 'walk_unsupported_ref', path: ['fields', 'cert'] });
    expect(
      frameRefusal({
        fields: {
          listings: {
            _walk: { in: 'cards/Listing.cert' },
            fields: { cert: { _walk: { out: 'cert' }, fields: {} } }
          }
        }
      })
    ).toEqual({ code: 'walk_unsupported_ref', path: ['fields', 'listings', 'fields', 'cert'] });
  });
});

describe('select and $expr validation', () => {
  it('accepts a select over fields and a frame _agg, ordered by its names', () => {
    expect(() =>
      checkFrame({
        fields: { id: true, _agg: SPEC_AGG },
        select: { gap: { sub: ['psaOffer', 'ask'] }, n: '_agg.obsCount', up: { upper: ['label'] } },
        orderBy: [{ gap: 'desc' }, { n: 'asc' }]
      })
    ).not.toThrow();
  });

  it('refuses a select name that is a field, an unknown field and a bad expression', () => {
    expect(frameRefusal({ select: { label: { upper: ['label'] } } })).toEqual({
      code: 'select_invalid',
      path: ['select', 'label']
    });
    expect(frameRefusal({ select: { x: { add: ['nope', 1] } } }).code).toBe('expr_invalid');
    expect(frameRefusal({ select: { x: { add: ['label', 1] } } }).code).toBe('expr_invalid');
    expect(frameRefusal({ select: { x: '_agg.obsCount' } }).code).toBe('expr_invalid');
  });

  it('refuses a select beside count or aggregate', () => {
    expect(frameRefusal({ count: true, select: { x: 'ask' } }).code).toBe('count_conflict');
    expect(frameRefusal({ aggregate: { n: { count: true } }, select: { x: 'ask' } }).code).toBe(
      'agg_invalid'
    );
  });

  it('accepts exactly maxNodesPerFrame nodes and refuses one more, naming the limit', () => {
    // 64 nodes is the per-expression cap: 16 of them are exactly 1,024.
    const e = { coalesce: Array.from({ length: 63 }, () => 'ask') };
    const select: Record<string, unknown> = Object.fromEntries(
      Array.from({ length: 16 }, (_, i) => [`s${i}`, e])
    );
    expect(() => checkFrame({ select })).not.toThrow();
    select.extra = 'ask';
    try {
      checkFrame({ select });
      throw new Error('expected a refusal');
    } catch (err) {
      expect(err).toBeInstanceOf(FilterValidationError);
      expect((err as FilterValidationError).code).toBe('expr_invalid');
      expect((err as Error).message).toContain('maxNodesPerFrame');
    }
  });

  it('refuses a select name that is a row key, a metadata key or a nested selection', () => {
    for (const name of ['id', 'createdBy', 'updatedBy', '_metadata', 'shortId', 'createdAt']) {
      expect(frameRefusal({ select: { [name]: 'ask' } }), name).toEqual({
        code: 'select_invalid',
        path: ['select', name]
      });
    }
    expect(
      frameRefusal({
        fields: {
          id: true,
          obs: { _walk: { in: 'cards/Observation.cert' }, fields: { id: true } }
        },
        select: { obs: 'ask' }
      })
    ).toEqual({ code: 'select_invalid', path: ['select', 'obs'] });
    // Projecting a select name in `fields` is how it is read, so it is allowed.
    expect(() =>
      checkFrame({ fields: { id: true, gap: true }, select: { gap: 'ask' } })
    ).not.toThrow();
  });

  it('says a boolean or int64 _agg cannot be used in an expression', () => {
    const aggs = {
      b: { in: 'cards/Observation.cert', latest: { by: 'observedAt', value: 'flag' } },
      i: { in: 'cards/Observation.cert', latest: { by: 'observedAt', value: 'qty' } }
    };
    for (const n of ['b', 'i']) {
      const r = (() => {
        try {
          checkFrame({ fields: { id: true, _agg: aggs }, select: { x: `_agg.${n}` } });
        } catch (err) {
          return err as FilterValidationError;
        }
        throw new Error('expected a refusal');
      })();
      expect(r.code).toBe('expr_invalid');
      expect(r.message).toContain('cannot use');
    }
  });

  it('where.$expr must be boolean, and sits beside field filters and combinators', () => {
    expect(() =>
      checkFrame({ where: { grade: { eq: 9 }, $expr: { gt: ['psaOffer', 'ask'] } } })
    ).not.toThrow();
    expect(() =>
      checkFrame({ where: { OR: [{ $expr: { gt: ['psaOffer', 'ask'] } }, { grade: { eq: 1 } }] } })
    ).not.toThrow();
    expect(frameRefusal({ where: { $expr: { add: ['ask', 1] } } })).toEqual({
      code: 'expr_invalid',
      path: ['where', '$expr']
    });
  });

  it('refuses $expr inside a walk', () => {
    expect(
      frameRefusal({
        where: { _walk: { in: 'cards/Listing.cert', where: { $expr: { gt: ['price', 1] } } } }
      }).code
    ).toBe('expr_invalid');
  });
});
