/**
 * Per-namespace grants (spec §5).
 *
 * A flat `(namespaces × caps)` grant must intersect exactly as the two
 * independent list intersections it replaces, so existing flat keys behave
 * unchanged. Asserted over a table of cases.
 */

import { describe, expect, it } from 'vitest';
import {
  capabilitiesFor,
  encodeGrant,
  expandFlat,
  flattenGrant,
  grantIsUniform,
  intersectGrants,
  parseGrantEntries
} from '../src/grant.js';

const caps = (g: ReturnType<typeof expandFlat>, ns: string): string[] =>
  [...capabilitiesFor(g, ns)].sort();

describe('parseGrantEntries — the wire form', () => {
  it('an entry with no colon takes the default capabilities', () => {
    const g = parseGrantEntries(['journal', 'recall'], ['read', 'mutate']);
    expect(caps(g, 'journal')).toEqual(['mutate', 'read']);
    expect(caps(g, 'recall')).toEqual(['mutate', 'read']);
  });

  it('an entry WITH a colon overrides them, and + separates capabilities', () => {
    const g = parseGrantEntries(['board:read', 'journal:read+mutate'], ['read', 'mutate']);
    expect(caps(g, 'board')).toEqual(['read']);
    expect(caps(g, 'journal')).toEqual(['mutate', 'read']);
  });

  it('mixes both in one list — the shape the CLI actually accepts', () => {
    const g = parseGrantEntries(['board:read', 'journal', 'recall'], ['read', 'mutate']);
    expect(caps(g, 'board')).toEqual(['read']);
    expect(caps(g, 'journal')).toEqual(['mutate', 'read']);
  });

  it('keeps the wildcard as a namespace key', () => {
    const g = parseGrantEntries(['*:read'], ['read', 'mutate']);
    expect(caps(g, '*')).toEqual(['read']);
  });

  it('refuses an entry naming no capabilities — silence is not a grant', () => {
    expect(() => parseGrantEntries(['board:'], ['read'])).toThrow(/board:/);
  });
});

describe('encodeGrant round-trips through the existing column', () => {
  it('emits a bare name when the entry carries the default capabilities', () => {
    const g = parseGrantEntries(['journal'], ['read', 'mutate']);
    expect(encodeGrant(g, ['read', 'mutate'])).toEqual(['journal']);
  });

  it('emits the colon form only where it differs from the default', () => {
    const g = parseGrantEntries(['board:read', 'journal'], ['read', 'mutate']);
    expect(encodeGrant(g, ['read', 'mutate']).sort()).toEqual(['board:read', 'journal']);
  });

  it('never emits a comma — encodeList would reject it', () => {
    const g = parseGrantEntries(['board:read+mutate'], ['read']);
    for (const entry of encodeGrant(g, ['read'])) expect(entry).not.toContain(',');
  });
});

describe('intersectGrants', () => {
  it('an explicit entry beats a wildcard for that namespace', () => {
    const row = parseGrantEntries(['*:read', 'journal:read+mutate'], ['read']);
    const claim = expandFlat(['*'], ['read', 'mutate']);
    const out = intersectGrants(claim, row);
    expect(caps(out, 'journal')).toEqual(['mutate', 'read']);
    expect(caps(out, 'board')).toEqual(['read']);
  });

  it('a wildcard CLAIM inherits the row verbatim — how every agent token works today', () => {
    const row = parseGrantEntries(['board:read', 'journal:read+mutate'], ['read', 'mutate']);
    const out = intersectGrants(expandFlat(['*'], ['read', 'mutate']), row);
    expect(flattenGrant(out).namespaces.sort()).toEqual(['board', 'journal']);
    expect(caps(out, 'board')).toEqual(['read']);
  });

  it('a claim can never widen the row', () => {
    const row = parseGrantEntries(['board:read'], ['read']);
    const out = intersectGrants(expandFlat(['board'], ['read', 'mutate', 'admin']), row);
    expect(caps(out, 'board')).toEqual(['read']);
  });

  it('drops a namespace the row does not grant at all', () => {
    const row = parseGrantEntries(['journal'], ['read']);
    const out = intersectGrants(expandFlat(['journal', 'board'], ['read']), row);
    expect(flattenGrant(out).namespaces).toEqual(['journal']);
  });

  // A claim the holder chooses must not turn a narrowed namespace's empty intersection
  // into the wildcard's reach.
  describe('an explicit entry that intersects to nothing still shadows the wildcard', () => {
    const row = parseGrantEntries(['*:read+mutate', 'board:read'], ['read']);

    it('a mutate-only claim gets mutate everywhere the wildcard reaches, and nothing on board', () => {
      const out = intersectGrants(expandFlat(['*'], ['mutate']), row);
      expect(caps(out, 'board')).toEqual([]);
      expect(caps(out, 'journal')).toEqual(['mutate']);
    });

    it('the default agent claim is unchanged: board stays read, elsewhere read+mutate', () => {
      const out = intersectGrants(expandFlat(['*'], ['read', 'mutate']), row);
      expect(caps(out, 'board')).toEqual(['read']);
      expect(caps(out, 'journal')).toEqual(['mutate', 'read']);
    });

    it('a claim naming the narrowed namespace explicitly is held to it too', () => {
      const out = intersectGrants(expandFlat(['*', 'board'], ['mutate']), row);
      expect(caps(out, 'board')).toEqual([]);
    });

    it('the empty entry is not advertised as reach by the flat view', () => {
      const out = intersectGrants(expandFlat(['*'], ['mutate']), row);
      expect(flattenGrant(out).namespaces).toEqual(['*']);
      expect(grantIsUniform(out)).toBe(false);
    });

    it('a narrowed entry that is NOT a subset of the wildcard is shadowed too', () => {
      // On main, `*:read, c:mutate` claimed as `read` handed c the wildcard's read.
      const disjoint = parseGrantEntries(['*:read', 'c:mutate'], ['read']);
      const out = intersectGrants(expandFlat(['*'], ['read']), disjoint);
      expect(caps(out, 'c')).toEqual([]);
      expect(caps(out, 'other')).toEqual(['read']);
    });

    it('several narrowed entries at once: each empties or keeps on its own', () => {
      const many = parseGrantEntries(
        ['*:read+mutate', 'board:read', 'recall:read', 'notes:mutate'],
        ['read']
      );
      const out = intersectGrants(expandFlat(['*'], ['mutate']), many);
      expect(caps(out, 'board')).toEqual([]);
      expect(caps(out, 'recall')).toEqual([]);
      expect(caps(out, 'notes')).toEqual(['mutate']);
      expect(caps(out, 'journal')).toEqual(['mutate']);
    });

    it('without a wildcard in the result, an empty namespace is still simply absent', () => {
      const narrow = parseGrantEntries(['journal:read+mutate', 'board:read'], ['read']);
      const out = intersectGrants(expandFlat(['*'], ['mutate']), narrow);
      expect([...out.keys()]).toEqual(['journal']);
    });
  });
});

/**
 * The equivalence, over the cases the replaced flat intersection exercised.
 *
 * The local `intersectList` below is deliberate: it copies the deleted
 * original so the equivalence stays checkable. Do not replace it with
 * `intersectGrants`, which would test the new implementation against itself.
 */
describe('EQUIVALENCE: a flat grant intersects exactly as the retired flat intersection did', () => {
  const intersectList = (claimed: string[], allowed: string[]): string[] => {
    const cw = claimed.includes('*');
    const aw = allowed.includes('*');
    if (cw && aw) return ['*'];
    if (cw) return [...allowed];
    if (aw) return [...claimed];
    const set = new Set(allowed);
    return claimed.filter((c) => set.has(c));
  };

  const cases: Array<[string[], string[], string[], string[]]> = [
    [['*'], ['read', 'mutate'], ['journal', 'recall'], ['read', 'mutate']],
    [['journal'], ['read'], ['journal', 'recall'], ['read', 'mutate']],
    [['journal', 'board'], ['read', 'mutate'], ['journal'], ['read']],
    [['*'], ['read'], ['*'], ['read', 'mutate']],
    [['journal'], ['read', 'mutate'], ['*'], ['read']],
    [['a', 'b'], ['read'], ['b', 'c'], ['read', 'mutate']]
  ];

  for (const [claimNs, claimCaps, rowNs, rowCaps] of cases) {
    it(`claim ${JSON.stringify(claimNs)}×${JSON.stringify(claimCaps)} vs row ${JSON.stringify(rowNs)}×${JSON.stringify(rowCaps)}`, () => {
      const flat = flattenGrant(
        intersectGrants(expandFlat(claimNs, claimCaps), expandFlat(rowNs, rowCaps))
      );
      expect(flat.namespaces.sort()).toEqual(intersectList(claimNs, rowNs).sort());
      expect(flat.capabilities.sort()).toEqual(intersectList(claimCaps, rowCaps).sort());
    });
  }
});

describe('grantIsUniform — what whoami keys its flat rendering off (§8.1)', () => {
  it('is uniform when every namespace carries the same capabilities', () => {
    expect(grantIsUniform(parseGrantEntries(['a', 'b'], ['read', 'mutate']))).toBe(true);
  });

  it('is NOT uniform when they differ — this is when `capabilities` renders null', () => {
    expect(grantIsUniform(parseGrantEntries(['a:read', 'b:read+mutate'], ['read']))).toBe(false);
  });

  it('an empty grant is uniform — there is nothing to disagree', () => {
    expect(grantIsUniform(expandFlat([], []))).toBe(true);
  });
});

/**
 * The definition, checked pointwise: for every namespace p, the intersected grant confers exactly
 * capabilitiesFor(claim, p) ∩ capabilitiesFor(row, p). Exhaustive over a small universe — this is
 * the property that once broke (an emptied explicit entry fell back to the wildcard).
 */
describe('PROPERTY: intersectGrants is the per-namespace intersection, for every shape', () => {
  const NS = ['*', 'a', 'b'];
  // Two capabilities already give every relation between an entry and the wildcard: equal,
  // subset, superset, disjoint, empty.
  const CAPS = ['read', 'mutate'];
  const PROBES = ['a', 'b', 'zzz'];
  const subsets = (xs: string[]): string[][] =>
    xs.reduce<string[][]>((acc, x) => acc.concat(acc.map((s) => [...s, x])), [[]]);
  const capSets = subsets(CAPS);
  // Every grant over NS: each namespace absent, or present with any capability subset.
  const grants: Map<string, ReadonlySet<string>>[] = [new Map()];
  for (const ns of NS) {
    const next: Map<string, ReadonlySet<string>>[] = [];
    for (const g of grants) {
      next.push(g);
      for (const cs of capSets) next.push(new Map([...g, [ns, new Set(cs)]]));
    }
    grants.splice(0, grants.length, ...next);
  }

  it(`holds for all ${grants.length}² claim × row pairs`, () => {
    let mismatches = 0;
    for (const claim of grants) {
      for (const row of grants) {
        const out = intersectGrants(claim, row);
        for (const p of PROBES) {
          const want = [...capabilitiesFor(claim, p)]
            .filter((c) => capabilitiesFor(row, p).has(c))
            .sort();
          const got = [...capabilitiesFor(out, p)].sort();
          if (want.join() !== got.join()) mismatches += 1;
        }
      }
    }
    expect(mismatches).toBe(0);
  }, 30_000);
});
