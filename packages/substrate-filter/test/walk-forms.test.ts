/**
 * The walk-form rules (Todo #1815): pure functions of the frame, shared by
 * the pg compiler and the engine's plan, so both name the same form.
 */

import type { FieldDef, WalkAgg, WhereClause } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { readsEverySeed, sharedPicks, windowGroupBy } from '../src/index.js';

const pick = {
  in: 'ns/Sale.spec',
  pick: { latest: 'at' },
  where: { price: { gte: { $ref: '$.ask' } } }
};
const hub = { out: 'spec', where: { AND: [{ live: { eq: true } }, { _walk: pick }] } };

describe('readsEverySeed', () => {
  it('a count, an aggregate, or a page over 1,000 rows (or unlimited)', () => {
    expect(readsEverySeed({ count: true, limit: 5 })).toBe(true);
    expect(readsEverySeed({ aggregate: {}, limit: 5 })).toBe(true);
    expect(readsEverySeed({})).toBe(true);
    expect(readsEverySeed({ limit: 1001 })).toBe(true);
    expect(readsEverySeed({ limit: 1000 })).toBe(false);
  });
});

describe('sharedPicks', () => {
  const where = (w: unknown) => w as WhereClause;
  it('maps an inbound pick in a top-level outbound walk to that walk', () => {
    const w = where({ AND: [{ grade: { eq: 9 } }, { _walk: hub }] });
    const map = sharedPicks({ where: w, count: true });
    expect([...map.entries()]).toEqual([[pick, hub]]);
  });

  it('shares nothing on a page, under OR or NOT, or for a pick reading a binding', () => {
    expect(sharedPicks({ where: where({ _walk: hub }), limit: 20 }).size).toBe(0);
    expect(sharedPicks({ where: where({ OR: [{ _walk: hub }] }), count: true }).size).toBe(0);
    expect(sharedPicks({ where: where({ NOT: { _walk: hub } }), count: true }).size).toBe(0);
    const bound = { ...pick, where: { price: { gte: { $ref: 'x.ask' } } } };
    const w = where({ _walk: { out: 'spec', where: { _walk: bound } } });
    expect(sharedPicks({ where: w, count: true }).size).toBe(0);
    // A hub walk reading a top-level bind compiles inside the bind's EXISTS.
    const reads = {
      out: 'spec',
      where: { AND: [{ ask: { lte: { $ref: 'B.ask' } } }, { _walk: pick }] }
    };
    const withBind = where({ AND: [{ _walk: { in: 'ns/X.c', as: 'B' } }, { _walk: reads }] });
    expect(sharedPicks({ where: withBind, count: true }).size).toBe(0);
    // An inbound first hop reaches a hub only its seed does: nothing to share.
    const inbound = where({ _walk: { in: 'ns/Spec.x', where: { _walk: pick } } });
    expect(sharedPicks({ where: inbound, count: true }).size).toBe(0);
  });
});

describe('windowGroupBy', () => {
  const OBS = 'ns/Obs.cert';
  const w = { at: { gte: '2026-10-01T00:00:00Z' } };
  const defs: Record<string, FieldDef> = {
    at: { kind: 'scalar', type: 'date' },
    price: { kind: 'scalar', type: 'number' }
  };
  const def = (f: string) => defs[f];
  const indexed = (f: string) => f === 'at';
  const seedWhere = { _walk: { in: OBS, where: w } } as WhereClause;
  const g = (spec: unknown, params: Record<string, unknown> = { where: seedWhere }) =>
    windowGroupBy(spec as WalkAgg, params, def, indexed);

  it("groups a count, avg, sum or number min/max over the seeds' indexed window", () => {
    for (const fn of [{ count: true }, { avg: 'price' }, { sum: 'price' }, { max: 'price' }]) {
      expect(g({ in: OBS, where: w, ...fn })).toBe(true);
    }
  });

  it('keeps per-seed probes otherwise', () => {
    // A top-1 per seed.
    expect(g({ in: OBS, where: w, max: 'at' })).toBe(false);
    expect(g({ in: OBS, where: w, latest: { by: 'at', value: 'price' } })).toBe(false);
    // A page of seeds, a count, or no matching seed walk.
    expect(g({ in: OBS, where: w, count: true }, { where: seedWhere, limit: 20 })).toBe(false);
    expect(g({ in: OBS, where: w, count: true }, { where: seedWhere, count: true })).toBe(false);
    expect(g({ in: OBS, where: w, count: true }, {})).toBe(false);
    // Not a window on an index, or not seed-independent.
    expect(g({ in: OBS, where: { price: { gte: 1 } }, count: true })).toBe(false);
    const ref = { ...w, price: { gte: { $ref: '$.ask' } } };
    expect(
      g({ in: OBS, where: ref, count: true }, { where: { _walk: { in: OBS, where: ref } } })
    ).toBe(false);
    // An outbound hop has one neighbour.
    expect(g({ out: 'cert', where: w, count: true })).toBe(false);
  });
});
