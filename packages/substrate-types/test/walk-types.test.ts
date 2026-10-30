import { describe, expectTypeOf, it } from 'vitest';
import type { ReadParams, ReadResult, WalkAgg, WalkNode } from '../src/index.js';

type Where = NonNullable<ReadParams['where']>;

describe('walk grammar types', () => {
  it('accepts the yardstick frame', () => {
    const w = {
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
    } satisfies Where;
    expectTypeOf(w).toMatchTypeOf<Where>();
  });

  it('rejects malformed walks and aggregates', () => {
    // @ts-expect-error pick takes latest/max/min only
    const bad: Where = { _walk: { in: 'x/T.f', pick: { avg: 'p' } } };
    // @ts-expect-error _agg needs a numeric comparison
    const bad2: Where = { _agg: { count: true, in: 'x/T.f' } };
    void bad;
    void bad2;
  });

  it('types aggregates, derive ordering and results', () => {
    const agg: WalkAgg = { in: 'x/T.f', latest: { by: 'at', value: 'p' } };
    const ok: Where = { _agg: agg, gt: 3 };
    const p: ReadParams = {
      derive: { margin: { diff: ['a', 'b'] } },
      orderBy: [{ $margin: 'desc' }],
      aggregate: { n: { count: true } },
      bucket: { field: 'at', by: 'day' }
    };
    // @ts-expect-error latest is walk-only
    const q: ReadParams = { aggregate: { x: { latest: { by: 'a', value: 'b' } } } };
    void ok;
    void p;
    void q;
    expectTypeOf<ReadResult['count']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<WalkNode['quantifier']>().toEqualTypeOf<'any' | 'none' | 'all' | undefined>();
  });
});
