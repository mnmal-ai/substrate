/**
 * Walk and `$ref` validation (typed edge walks spec §1 Grammar, §2 Validation).
 */

import type { TypeRef } from '@mnmal-ai/substrate-filter';
import type { FilterCapabilities, TypeSchema, WhereClause } from '@mnmal-ai/substrate-types';
import { describe, expect, it, vi } from 'vitest';
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
      units: { kind: 'scalar', type: 'int32' },
      tiny: { kind: 'scalar', type: 'int16' },
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
    'scalar.int16': ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'in', 'nin'],
    'scalar.int32': ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'in', 'nin'],
    'scalar.int64': ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'in', 'nin'],
    'scalar.json': [],
    crossRef: ['eq', 'neq', 'in', 'nin'],
    list: ['has']
  },
  orderBy: true,
  cursor: true
} as FilterCapabilities;

/** The `other` namespace: a readable, stored neighbour of `cards` on the same store. */
const OTHER: Record<string, TypeSchema> = {
  Cert: { fields: { grade: { kind: 'scalar', type: 'number' } } },
  Listing: { fields: { cert: ref('Cert'), price: { kind: 'scalar', type: 'number' } } },
  Observation: { fields: { cert: ref('Cert'), price: { kind: 'scalar', type: 'number' } } }
};

const cardsOnly = (ns: string) => (ns === 'cards' ? SCHEMAS : undefined);

type WalkInput = Partial<Parameters<typeof validateFilter>[0]>;

/** `cards` and `other` both readable, stored and on one store. */
const CROSS: WalkInput = {
  schemaOf: (ns) => (ns === 'cards' ? SCHEMAS : ns === 'other' ? OTHER : undefined),
  canRead: () => true,
  isStoredType: () => true,
  walkable: () => true
};

function check(where: unknown, type = 'Cert', walk: WalkInput = {}): void {
  validateFilter({
    where: where as WhereClause,
    typeSchema: SCHEMAS[type] as TypeSchema,
    capabilities: CAPS,
    schemaOf: cardsOnly,
    namespace: 'cards',
    typeName: type,
    ...walk
  });
}

function refusal(
  where: unknown,
  type = 'Cert',
  walk: WalkInput = {}
): { code: string; path: string[] } {
  try {
    check(where, type, walk);
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

  it('names the refs a refused walk could have taken', () => {
    const run =
      (where: unknown, type = 'Cert') =>
      () =>
        validateFilter({
          where: where as WhereClause,
          typeSchema: SCHEMAS[type] as TypeSchema,
          capabilities: CAPS,
          schemaOf: cardsOnly,
          namespace: 'cards',
          typeName: type
        });
    // The seed's own type named in `in`: list the refs that point at it.
    const into =
      "'in' names a crossRef on another type that points at 'Cert': 'cards/Listing.cert', 'cards/Observation.cert'";
    expect(run({ _walk: { in: 'cards/Cert.grade' } })).toThrow(into);
    expect(run({ _walk: { in: 'cards/Cert.set' } })).toThrow(
      "'in' names a crossRef on another type that points at 'Cert': 'cards/Listing.cert', 'cards/Observation.cert'"
    );
    expect(run({ _walk: { in: 'cards/Listing.price' } }, 'Listing')).toThrow(
      "no crossRef in 'cards' points at 'Listing'"
    );
    expect(run({ _walk: { out: 'grade' } })).toThrow("'out' takes a crossRef of 'Cert': set");
  });

  it('lists the operators a crossRef takes when it refuses one', () => {
    expect(() => check({ set: { exists: true } })).toThrow(
      /\(kind=crossRef\); it takes .*eq.*\('eq: null' tests for no reference\)/
    );
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
          schemaOf: (ns) => (ns === 'cards' ? types : undefined),
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

  it('crosses into a readable, stored namespace on the same store, and only when told it may', () => {
    expect(() => check({ _walk: { in: 'other/Listing.cert' } }, 'Cert', CROSS)).not.toThrow();
    expect(() => check({ _walk: { out: 'elsewhere' } }, 'Observation', CROSS)).not.toThrow();
    // Without a grant callback a walk stays in the frame's namespace.
    expect(refusal({ _walk: { in: 'other/Listing.cert' } })).toEqual({
      code: 'policy_denied',
      path: ['where', '_walk']
    });
    expect(refusal({ _walk: { out: 'elsewhere' } }, 'Observation')).toEqual({
      code: 'policy_denied',
      path: ['where', '_walk']
    });
  });

  it('refuses a same-namespace in whose far field points into another namespace', () => {
    // `cards/Observation.elsewhere` points at `other/Cert`, not the seed's `cards/Cert`.
    const where = { _walk: { in: 'cards/Observation.elsewhere' } };
    for (const walk of [CROSS, {}]) {
      expect(refusal(where, 'Cert', walk)).toEqual({
        code: 'walk_unknown_ref',
        path: ['where', '_walk', 'in']
      });
      expect(() => check(where, 'Cert', walk)).toThrow(
        /^'cards\/Observation\.elsewhere' does not point at 'cards\/Cert'/
      );
    }
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
    expect(() =>
      check({ _agg: { in: 'other/Observation.cert', count: true }, gte: 3 }, 'Cert', CROSS)
    ).not.toThrow();
  });
});

type Frame = Omit<Parameters<typeof validateFilter>[0], 'typeSchema' | 'capabilities'>;

function checkFrame(frame: Frame, type = 'Cert'): void {
  validateFilter({
    ...frame,
    typeSchema: SCHEMAS[type] as TypeSchema,
    capabilities: CAPS,
    schemaOf: cardsOnly,
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

  describe('integer aggregates', () => {
    const OBS = 'cards/Observation.cert';
    const msg = (where: unknown): string => {
      try {
        check(where);
      } catch (err) {
        if (err instanceof FilterValidationError) return err.message;
        throw err;
      }
      throw new Error('expected a refusal');
    };

    it('accepts sum, avg, min and max over integer fields', () => {
      for (const field of ['qty', 'units', 'tiny']) {
        expect(() => check({ _agg: { in: OBS, sum: field }, gte: 1 })).not.toThrow();
        expect(() => check({ _agg: { in: OBS, avg: field }, gte: 1.5 })).not.toThrow();
        expect(() => check({ _agg: { in: OBS, min: field }, gte: 1 })).not.toThrow();
        expect(() => check({ _agg: { in: OBS, max: field }, gte: 1 })).not.toThrow();
      }
      expect(() =>
        checkFrame({
          fields: {
            id: true,
            _agg: { total: { in: OBS, sum: 'qty' }, mean: { in: OBS, avg: 'units' } }
          }
        })
      ).not.toThrow();
    });

    it('gives each aggregate the value kind its field decides', () => {
      // An integer sum is an int64: its operand is an int64, so a decimal string reads.
      expect(() =>
        check({ _agg: { in: OBS, sum: 'units' }, gte: '9007199254740993' })
      ).not.toThrow();
      expect(refusal({ _agg: { in: OBS, sum: 'units' }, gte: 'abc' })).toEqual({
        code: 'type_mismatch',
        path: ['where', 'gte']
      });
      expect(msg({ _agg: { in: OBS, sum: 'units' }, gte: 'abc' })).toContain('expected an int64');
      expect(msg({ _agg: { in: OBS, sum: 'qty' }, gte: 1.5 })).toContain('expected an int64');
      // avg is always a number.
      expect(msg({ _agg: { in: OBS, avg: 'qty' }, gte: 'abc' })).toContain('expected number');
      // min and max keep the field's own kind.
      expect(msg({ _agg: { in: OBS, max: 'tiny' }, gte: 70000 })).toContain('expected an int16');
      expect(msg({ _agg: { in: OBS, min: 'units' }, gte: 2 ** 40 })).toContain('expected an int32');
      expect(() => check({ _agg: { in: OBS, min: 'qty' }, gte: '5' })).not.toThrow();
    });

    it('still refuses sum over a non-numeric field, naming the accepted kinds', () => {
      const r = refusal({ _agg: { in: OBS, sum: 'flag' }, gte: 1 });
      expect(r.code).toBe('agg_invalid');
      expect(msg({ _agg: { in: OBS, sum: 'flag' }, gte: 1 })).toContain('number or integer field');
    });

    it('says an integer-valued aggregate cannot be used in an expression', () => {
      const aggs = {
        s: { in: OBS, sum: 'units' },
        m: { in: OBS, max: 'tiny' }
      };
      for (const n of ['s', 'm']) {
        expect(() =>
          checkFrame({ fields: { id: true, _agg: aggs }, select: { x: `_agg.${n}` } })
        ).toThrow(/cannot use/);
      }
      // The message names the value's type with the right article.
      for (const [n, want] of [
        ['s', 'has an int64 value'],
        ['m', 'has an int16 value'],
        ['b', 'has a boolean value']
      ] as const) {
        expect(() =>
          checkFrame({
            fields: {
              id: true,
              _agg: {
                ...aggs,
                b: { in: OBS, latest: { by: 'observedAt', value: 'flag' } }
              }
            },
            select: { x: `_agg.${n}` }
          })
        ).toThrow(want);
      }
    });
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

  it('an offset without aggregate points at the cursor and count', () => {
    expect(() => checkFrame({ offset: 100 } as Frame)).toThrow(
      /offset shapes an aggregate's groups; it needs aggregate\. To page rows, pass the previous page's _pagination nextCursor as params\.cursor; for a total, use count: true\./
    );
  });

  it('an empty groupBy expression names the accepted forms', () => {
    expect(() =>
      checkFrame({ aggregate: { n: { count: true } }, groupBy: { target: {} } } as Frame)
    ).toThrow(
      /an expression is a field name \("title"\), a number, or an object with exactly one function key .*got an object with no keys/
    );
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

  it('refuses a select nested far past the depth limit as expr_invalid', () => {
    let e: unknown = 'grade';
    for (let i = 0; i < 20_000; i++) e = { not: [e] };
    expect(frameRefusal({ select: { deep: e } }).code).toBe('expr_invalid');
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

  it('accepts among on a pick, validates it over the far type, and refuses it without one (#1810)', () => {
    expect(() =>
      check({
        _walk: {
          in: 'cards/Observation.cert',
          pick: { latest: 'observedAt' },
          among: { price: { gt: 0 } },
          where: { price: { gte: 100 } }
        }
      })
    ).not.toThrow();
    expect(
      refusal({ _walk: { in: 'cards/Observation.cert', among: { price: { gt: 0 } } } })
    ).toMatchObject({ code: 'walk_quantifier', path: ['where', '_walk', 'among'] });
    expect(
      refusal({
        _walk: {
          in: 'cards/Observation.cert',
          pick: { latest: 'observedAt' },
          among: { nope: { eq: 1 } }
        }
      })
    ).toMatchObject({ code: 'unknown_field', path: ['where', '_walk', 'among', 'nope'] });
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

/** The walks plan's deferred Task 4/5 test gaps (#1827). */
describe('walk validator negative cases', () => {
  it('refuses a $ref to a binding made in the same OR branch (Ruling 10)', () => {
    expect(
      refusal({
        OR: [
          { AND: [listing({ as: 'L' }), { ask: { gte: { $ref: 'L.price' } } }] },
          { grade: { eq: 9 } }
        ]
      })
    ).toEqual({ code: 'walk_binding', path: ['where', 'OR', '0', 'AND', '1', 'ask', 'gte'] });
  });

  it('refuses a duplicate or non-identifier as', () => {
    expect(
      refusal({ AND: [listing({ as: 'L' }), { _walk: { as: 'L', in: 'cards/Observation.cert' } }] })
    ).toEqual({ code: 'walk_binding', path: ['where', 'AND', '1', '_walk', 'as'] });
    expect(refusal(listing({ as: '1x' }))).toEqual({
      code: 'walk_binding',
      path: ['where', '_walk', 'as']
    });
  });

  it('refuses _walk beside AND or OR, as a field key there is', () => {
    expect(refusal({ ...listing(), AND: [{ grade: { eq: 9 } }] })).toEqual({
      code: 'invalid_logical',
      path: ['where']
    });
    expect(refusal({ ...listing(), OR: [{ grade: { eq: 9 } }, { ask: { gt: 1 } }] })).toEqual({
      code: 'invalid_logical',
      path: ['where']
    });
  });

  it('refuses _walk inside a struct', () => {
    expect(refusal({ dims: listing() }, 'Observation')).toEqual({
      code: 'walk_unsupported_ref',
      path: ['where', 'dims', '_walk']
    });
  });

  it('accepts an _agg latest ordered by createdAt', () => {
    expect(() =>
      checkFrame({
        fields: {
          _agg: { a: { in: 'cards/Observation.cert', latest: { by: 'createdAt', value: 'price' } } }
        }
      })
    ).not.toThrow();
  });

  it("refuses a $ref '_agg.x' whose kind differs from the compared field", () => {
    expect(
      frameRefusal({
        where: { gradedAt: { gt: { $ref: '_agg.n' } } },
        fields: { _agg: { n: { in: 'cards/Observation.cert', count: true } } }
      })
    ).toEqual({ code: 'ref_kind_mismatch', path: ['where', 'gradedAt', 'gt'] });
    expect(
      frameRefusal({
        where: { ask: { gt: { $ref: '_agg.d' } } },
        fields: { _agg: { d: { in: 'cards/Observation.cert', max: 'observedAt' } } }
      })
    ).toEqual({ code: 'ref_kind_mismatch', path: ['where', 'ask', 'gt'] });
  });

  it('refuses count with select, groupBy or cursor, and a non-boolean count', () => {
    expect(frameRefusal({ count: true, select: { m: 'ask' } })).toEqual({
      code: 'count_conflict',
      path: ['select']
    });
    expect(frameRefusal({ count: true, cursor: 'c' })).toEqual({
      code: 'count_conflict',
      path: ['cursor']
    });
    expect(frameRefusal({ count: true, groupBy: { b: 'grade' } })).toEqual({
      code: 'agg_invalid',
      path: ['groupBy']
    });
    expect(frameRefusal({ count: 'yes' as unknown as boolean })).toEqual({
      code: 'type_mismatch',
      path: ['count']
    });
  });

  it('refuses a groupBy name that is also an aggregate name', () => {
    expect(
      frameRefusal({ aggregate: { bucket: { count: true } }, groupBy: { bucket: 'grade' } })
    ).toEqual({ code: 'group_invalid', path: ['groupBy', 'bucket'] });
  });
});

describe('walks across namespaces', () => {
  const num = { kind: 'scalar', type: 'number' } as const;
  // Seed `ext/Payment`. `app` holds a stored type, a virtual one and refs back; `bridge` is on
  // another store; `vault` references the seed but is never readable in these tests.
  const SPACES: Record<string, Record<string, TypeSchema>> = {
    ext: {
      Payment: {
        fields: {
          amount: num,
          invoice: ref('Invoice', 'app'),
          ghost: ref('Nope', 'app'),
          hit: ref('Hit', 'app'),
          lost: ref('Thing', 'nowhere'),
          ledger: ref('Ledger', 'bridge'),
          secret: ref('Audit', 'vault')
        }
      },
      Refund: { fields: { payment: ref('Payment', 'ext') } }
    },
    app: {
      Invoice: {
        fields: {
          total: num,
          payment: ref('Payment', 'ext'),
          self: ref('Invoice', 'app'),
          hit: ref('Hit', 'app')
        }
      },
      Hit: {
        fields: { score: num, payment: ref('Payment', 'ext'), invoice: ref('Invoice', 'app') }
      }
    },
    bridge: {
      Ledger: { fields: { payment: ref('Payment', 'ext') } },
      Shadow: { fields: { payment: ref('Payment', 'ext') } }
    },
    vault: { Audit: { fields: { payment: ref('Payment', 'ext') } } }
  };
  const VIRTUAL = new Set(['app/Hit', 'bridge/Shadow']);
  const resolvers = (readable: (ns: string) => boolean) => ({
    schemaOf: vi.fn((ns: string) => (Object.hasOwn(SPACES, ns) ? SPACES[ns] : undefined)),
    canRead: vi.fn(readable),
    isStoredType: vi.fn((r: TypeRef) => !VIRTUAL.has(`${r.ns}/${r.type}`)),
    walkable: vi.fn((ns: string) => ns !== 'bridge'),
    namespaceNames: ['app', 'bridge', 'ext', 'vault']
  });
  const thrown = (frame: Frame, walk: WalkInput, type = 'Payment'): FilterValidationError => {
    try {
      validateFilter({
        ...frame,
        typeSchema: SPACES.ext?.[type] as TypeSchema,
        capabilities: CAPS,
        namespace: 'ext',
        typeName: type,
        ...walk
      });
    } catch (err) {
      if (err instanceof FilterValidationError) return err;
      throw err;
    }
    throw new Error('expected a refusal');
  };
  /** Everything a refusal carries but its stack trace. */
  const wire = (err: FilterValidationError) =>
    JSON.stringify([
      err.constructor.name,
      Object.getOwnPropertyNames(err)
        .filter((k) => k !== 'stack')
        .sort()
        .map((k) => [k, (err as unknown as Record<string, unknown>)[k]])
    ]);
  const DENIED = { code: 'policy_denied', message: 'this walk is not permitted' };

  it('denies an unreadable namespace before any lookup', () => {
    const forms: Array<[Frame, string[]]> = [
      [{ where: { _walk: { out: 'invoice' } } }, ['where', '_walk']],
      [{ where: { _walk: { in: 'app/Invoice.payment' } } }, ['where', '_walk']],
      [
        { fields: { inv: { _walk: { out: 'invoice' }, fields: { total: true } } } },
        ['fields', 'inv', '_walk']
      ],
      [{ where: { _agg: { in: 'app/Invoice.payment', count: true }, gte: 1 } }, ['where', '_agg']],
      [
        { fields: { _agg: { n: { in: 'app/Invoice.payment', count: true } } } },
        ['fields', '_agg', 'n']
      ],
      [
        {
          where: {
            AND: [{ _walk: { as: 'I', out: 'invoice' } }, { amount: { gte: { $ref: 'I.total' } } }]
          }
        },
        ['where', 'AND', '0', '_walk']
      ],
      [
        {
          where: {
            _walk: {
              in: 'ext/Refund.payment',
              where: { _walk: { out: 'payment', where: { _walk: { out: 'invoice' } } } }
            }
          }
        },
        ['where', '_walk', 'where', '_walk', 'where', '_walk']
      ]
    ];
    for (const [frame, path] of forms) {
      const r = resolvers((ns) => ns !== 'app');
      const err = thrown(frame, r);
      expect({ code: err.code, message: err.message, path: err.path }).toEqual({
        ...DENIED,
        path
      });
      expect(r.canRead).toHaveBeenCalledWith('app');
      expect(r.schemaOf).not.toHaveBeenCalledWith('app');
      expect(r.walkable).not.toHaveBeenCalledWith('app');
      expect(r.isStoredType.mock.calls.filter(([t]) => t.ns === 'app')).toEqual([]);
    }
  });

  it('gives the same denial for every target in an unreadable namespace', () => {
    const targets: Array<Record<string, unknown>> = [
      { in: 'app/Invoice.payment' }, // an existing type and field
      { in: 'app/Nope.payment' }, // a missing type
      { in: 'app/Invoice.nope' }, // a missing field
      { in: 'app/Hit.payment' }, // a virtual type
      { in: 'bridge/Ledger.payment' }, // a namespace on another store
      { in: 'nowhere/Thing.payment' }, // a namespace that does not exist
      { out: 'invoice' },
      { out: 'ghost' },
      { out: 'hit' },
      { out: 'ledger' },
      { out: 'lost' }
    ];
    const errs = targets.map((t) =>
      wire(
        thrown(
          { where: { _walk: t } },
          resolvers((ns) => ns === 'ext')
        )
      )
    );
    expect(new Set(errs).size).toBe(1);
    expect(JSON.parse(errs[0] as string)).toEqual([
      'FilterValidationError',
      [
        ['code', 'policy_denied'],
        ['message', 'this walk is not permitted'],
        ['name', 'FilterValidationError'],
        ['path', ['where', '_walk']]
      ]
    ]);
  });

  it('denies an out field the caller can see when its target namespace is unreadable', () => {
    // `ghost` targets a type `app` does not have: still the uniform denial, never walk_unknown_ref.
    for (const out of ['invoice', 'ghost']) {
      const err = thrown(
        { where: { _walk: { out } } },
        resolvers((ns) => ns !== 'app')
      );
      expect({ code: err.code, message: err.message }).toEqual(DENIED);
    }
  });

  it('refuses a virtual type with walk_unknown_ref and another store with walk_cross_store', () => {
    const r = resolvers(() => true);
    const refused = (walk: Record<string, unknown>) => {
      const err = thrown({ where: { _walk: walk } }, r);
      return { code: err.code, message: err.message, path: err.path };
    };
    expect(refused({ in: 'app/Hit.payment' })).toEqual({
      code: 'walk_unknown_ref',
      message: "unknown type 'app/Hit'",
      path: ['where', '_walk', 'in']
    });
    expect(refused({ out: 'hit' })).toEqual({
      code: 'walk_unknown_ref',
      message: "unknown type 'app/Hit'",
      path: ['where', '_walk', 'out']
    });
    expect(refused({ in: 'bridge/Ledger.payment' })).toMatchObject({
      code: 'walk_cross_store',
      path: ['where', '_walk', 'in']
    });
    expect(refused({ in: 'bridge/Ledger.payment' }).message).toContain("'bridge'");
    expect(refused({ out: 'ledger' })).toMatchObject({
      code: 'walk_cross_store',
      path: ['where', '_walk', 'out']
    });
    // The far type resolves before the store rule.
    expect(refused({ in: 'bridge/Shadow.payment' }).code).toBe('walk_unknown_ref');
    expect(refused({ in: 'nowhere/Thing.payment' })).toMatchObject({
      code: 'walk_unknown_ref',
      message: "unknown type 'nowhere/Thing'"
    });
    // A stored type on the same store validates, as does a walk back into the seed.
    for (const walk of [
      { in: 'app/Invoice.payment' },
      { out: 'invoice', where: { _walk: { out: 'payment' } } }
    ]) {
      expect(() =>
        validateFilter({
          where: { _walk: walk } as WhereClause,
          typeSchema: SPACES.ext?.Payment as TypeSchema,
          capabilities: CAPS,
          namespace: 'ext',
          typeName: 'Payment',
          ...r
        })
      ).not.toThrow();
    }
    // The far field must point at the near namespace's type.
    expect(refused({ in: 'app/Invoice.self' })).toMatchObject({
      code: 'walk_unknown_ref',
      path: ['where', '_walk', 'in']
    });
    expect(
      thrown({ where: { _walk: { in: 'app/Invoice.payment' } } }, r, 'Refund').message
    ).toMatch(/^'app\/Invoice\.payment' points at 'Payment', not 'Refund'/);
    expect(thrown({ where: { _walk: { in: 'app/Invoice.payment' } } }, r, 'Refund')).toMatchObject({
      code: 'walk_unknown_ref',
      path: ['where', '_walk', 'in']
    });
  });

  it('refuses a virtual type reached by a second hop inside another namespace', () => {
    const r = resolvers(() => true);
    for (const [walk, dir] of [
      [{ out: 'hit' }, 'out'],
      [{ in: 'app/Hit.invoice' }, 'in']
    ] as const) {
      const err = thrown({ where: { _walk: { out: 'invoice', where: { _walk: walk } } } }, r);
      expect({ code: err.code, message: err.message, path: err.path }).toEqual({
        code: 'walk_unknown_ref',
        message: "unknown type 'app/Hit'",
        path: ['where', '_walk', 'where', '_walk', dir]
      });
    }
    // A hop back into the seed namespace keeps the seed's path: no stored-ness question.
    r.isStoredType.mockClear();
    validateFilter({
      where: { _walk: { out: 'invoice', where: { _walk: { out: 'payment' } } } } as WhereClause,
      typeSchema: SPACES.ext?.Payment as TypeSchema,
      capabilities: CAPS,
      namespace: 'ext',
      typeName: 'Payment',
      ...r
    });
    expect(r.isStoredType.mock.calls).toEqual([[{ ns: 'app', type: 'Invoice' }]]);
  });

  it('lists only readable namespaces in refsHint', () => {
    const notVault = resolvers((ns) => ns !== 'vault');
    const inbound = thrown({ where: { _walk: { in: 'ext/Payment.amount' } } }, notVault);
    expect(inbound.message).toBe(
      "'ext/Payment.amount' is not a crossRef field; 'in' names a crossRef on another type that points at 'Payment': 'ext/Refund.payment', 'app/Invoice.payment', 'app/Hit.payment', 'bridge/Ledger.payment', 'bridge/Shadow.payment'"
    );
    const outbound = thrown({ where: { _walk: { out: 'amount' } } }, notVault);
    expect(outbound.message).toBe(
      "'amount' is not a crossRef field; 'out' takes a crossRef of 'Payment': invoice, ghost, hit, lost, ledger"
    );
    expect(notVault.schemaOf).not.toHaveBeenCalledWith('vault');
    // With only the seed readable, the hints are the single-namespace ones.
    const seedOnly = resolvers((ns) => ns === 'ext');
    expect(thrown({ where: { _walk: { in: 'ext/Payment.amount' } } }, seedOnly).message).toBe(
      "'ext/Payment.amount' is not a crossRef field; 'in' names a crossRef on another type that points at 'Payment': 'ext/Refund.payment'"
    );
    expect(thrown({ where: { _walk: { out: 'amount' } } }, seedOnly).message).toBe(
      "'amount' is not a crossRef field; 'Payment' has no crossRef to follow out"
    );
  });

  it('resolves a walked group key as an out walk: grant first, then the far type and the store', () => {
    const grouped = (key: string): Frame => ({
      aggregate: { n: { count: true } },
      groupBy: { g: key }
    });
    const r = resolvers((ns) => ns !== 'app');
    const err = thrown(grouped('invoice.total'), r);
    expect({ code: err.code, message: err.message, path: err.path }).toEqual({
      ...DENIED,
      path: ['groupBy', 'g']
    });
    expect(wire(err)).toBe(
      wire(
        thrown(
          { where: { _walk: { out: 'invoice' } } },
          resolvers((ns) => ns !== 'app')
        )
      ).replace('["where","_walk"]', '["groupBy","g"]')
    );
    expect(r.schemaOf).not.toHaveBeenCalledWith('app');
    const all = resolvers(() => true);
    expect(thrown(grouped('hit.score'), all)).toMatchObject({
      code: 'walk_unknown_ref',
      path: ['groupBy', 'g', 'out']
    });
    expect(thrown(grouped('ledger.payment'), all)).toMatchObject({
      code: 'walk_cross_store',
      path: ['groupBy', 'g', 'out']
    });
    expect(() =>
      validateFilter({
        ...grouped('invoice.total'),
        typeSchema: SPACES.ext?.Payment as TypeSchema,
        capabilities: CAPS,
        namespace: 'ext',
        typeName: 'Payment',
        ...all
      })
    ).not.toThrow();
  });
});

describe('walked group keys', () => {
  const APP: Record<string, TypeSchema> = {
    Customer: {
      fields: {
        region: { kind: 'scalar', type: 'string' },
        signedUpAt: { kind: 'scalar', type: 'date' },
        notes: { kind: 'scalar', type: 'json' },
        address: { kind: 'struct', fields: { city: { kind: 'scalar', type: 'string' } } }
      }
    },
    Invoice: {
      fields: {
        customer: ref('Customer', 'app'),
        amount: { kind: 'scalar', type: 'int64' },
        payers: { kind: 'list', of: ref('Customer', 'app') }
      }
    }
  };
  const run = (frame: Frame): void =>
    validateFilter({
      ...frame,
      typeSchema: APP.Invoice as TypeSchema,
      capabilities: CAPS,
      schemaOf: (ns) => (ns === 'app' ? APP : undefined),
      namespace: 'app',
      typeName: 'Invoice'
    });
  const refused = (frame: Frame): FilterValidationError => {
    try {
      run(frame);
    } catch (err) {
      if (err instanceof FilterValidationError) return err;
      throw err;
    }
    throw new Error('expected a refusal');
  };
  const n = { n: { count: true } };

  it('accepts the example, and a walked field anywhere inside a groupBy expression', () => {
    expect(() =>
      run({
        aggregate: { n: { count: true }, total: { sum: 'amount' } },
        groupBy: { region: 'customer.region' },
        orderBy: [{ total: 'desc' }]
      })
    ).not.toThrow();
    expect(() =>
      run({
        aggregate: n,
        groupBy: { month: { dateTrunc: [{ lit: 'month' }, 'customer.signedUpAt'] } }
      })
    ).not.toThrow();
    // `having` sees the group name, not the walked field.
    expect(() =>
      run({
        aggregate: n,
        groupBy: { region: 'customer.region' },
        having: { eq: ['region', { lit: 'north' }] }
      })
    ).not.toThrow();
  });

  it("types a walked field as the far field's expression type", () => {
    const err = refused({
      aggregate: n,
      groupBy: { month: { dateTrunc: [{ lit: 'month' }, 'customer.region'] } }
    });
    expect({ code: err.code, path: err.path }).toEqual({
      code: 'expr_invalid',
      path: ['groupBy', 'month', 'dateTrunc', '1']
    });
  });

  it('refuses an unknown or unreadable far field, a head that is no crossRef, and a second hop', () => {
    for (const key of [
      'customer.nope',
      'customer.notes',
      'customer.address',
      'amount.x',
      'nope.region',
      'customer.region.x'
    ]) {
      const err = refused({ aggregate: n, groupBy: { g: key } });
      expect({ code: err.code, path: err.path }, key).toEqual({
        code: 'expr_invalid',
        path: ['groupBy', 'g']
      });
      expect(err.message, key).toContain(`'${key}'`);
    }
  });

  it('refuses a list of crossRefs as a walk does', () => {
    const err = refused({ aggregate: n, groupBy: { g: 'payers.region' } });
    expect({ code: err.code, path: err.path }).toEqual({
      code: 'walk_unsupported_ref',
      path: ['groupBy', 'g', 'out']
    });
  });

  it('refuses a walked field outside groupBy, naming groupBy', () => {
    const forms: Array<[Frame, string[]]> = [
      [{ select: { r: 'customer.region' } }, ['select', 'r']],
      [{ aggregate: { m: { min: 'customer.region' } } }, ['aggregate', 'm', 'min']],
      [
        {
          aggregate: n,
          groupBy: { region: 'customer.region' },
          having: { eq: ['customer.region', { lit: 'north' }] }
        },
        ['having']
      ],
      [{ where: { $expr: { eq: ['customer.region', { lit: 'north' }] } } }, ['where', '$expr']]
    ];
    for (const [frame, path] of forms) {
      const err = refused(frame);
      expect({ code: err.code, path: err.path }, JSON.stringify(frame)).toEqual({
        code: 'expr_invalid',
        path
      });
      expect(err.message).toContain("'customer.region'");
      expect(err.message).toContain('groupBy');
    }
  });
});
