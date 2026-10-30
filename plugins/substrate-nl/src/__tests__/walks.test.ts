import type { Schema } from '@mnmal-ai/substrate/sdk';
import { describe, expect, it } from 'vitest';
import { type Judge, parseWithJudge } from '../judge/judge.js';
import { buildNamespacePack } from '../pack/build.js';
import type { NamespaceRulings } from '../pack/rulings.js';
import { parseComparison } from '../parse/compare.js';
import { parseQuestion } from '../parse/parse.js';
import { findPaths } from '../parse/walks.js';
import { ctx as nsCtx, pack as nsPack, OPERATORS } from './_fixture.js';

const num = { kind: 'scalar' as const, type: 'number' as const, indexed: true };
const str = { kind: 'scalar' as const, type: 'string' as const, indexed: true };
const date = { kind: 'scalar' as const, type: 'date' as const, indexed: true };
const bool = { kind: 'scalar' as const, type: 'boolean' as const, indexed: true };
const ref = (ns: string, type: string) => ({
  kind: 'crossRef' as const,
  ns,
  type,
  onDelete: 'restrict' as const
});

function packOf(namespace: string, types: Schema['types'], profile = {}) {
  return buildNamespacePack({
    namespace,
    schema: { schemaVersion: 'v', mutations: {}, types },
    operators: OPERATORS,
    profile: { types: profile }
  });
}

/** "now" is pinned: every relative window is computed from it. */
const asOf = '2026-10-30T12:00:00Z';
const PAST_2_DAYS = { gte: '2026-10-28T00:00:00Z', lt: '2026-10-31T00:00:00Z' };

// --- the card domain (example names and values only) ---
const cards = packOf('cards', {
  Cert: { fields: { grade: num, gradeLabel: str, psaOffer: num, ask: num } },
  Listing: {
    fields: { cert: ref('cards', 'Cert'), price: num, placeholderPrice: bool, firstSeen: date }
  },
  Observation: { fields: { cert: ref('cards', 'Cert'), price: num, observedAt: date } }
});
const cardRulings: NamespaceRulings = {
  typeAliases: { cards: 'Cert', card: 'Cert' },
  timeField: { Listing: 'firstSeen', Observation: 'observedAt' },
  fieldPhrases: {
    'asking price': { field: 'Listing.price', exclude: { placeholderPrice: { eq: true } } },
    'selling for': { field: 'Observation.price' },
    offer: { field: 'Observation.price' },
    'psa offer': { field: 'Observation.price', pick: 'latest' },
    'valued psa 9': { field: 'Cert.grade', value: 9 },
    margin: { derive: { diff: ['Cert.psaOffer', 'Cert.ask'] } }
  }
};
const card = (q: string) => parseQuestion(q, cards, { asOf, rulings: cardRulings });
const cardWhere = (q: string) =>
  (card(q).candidates[0]?.frame['cards/Cert']?.params as { where?: unknown } | undefined)?.where;

// --- the test-run domain ---
const runs = packOf(
  'runs',
  {
    Test: { fields: { name: str, suite: str } },
    CiRun: { fields: { test: ref('runs', 'Test'), durationMs: num, status: str, at: date } },
    LocalRun: { fields: { test: ref('runs', 'Test'), durationMs: num, status: str, at: date } }
  },
  { Test: { suite: { values: ['pg-gated', 'unit'], truncated: false } } }
);
const skipped = { status: { eq: 'skipped' } };
const runRulings: NamespaceRulings = {
  typeAliases: { locally: 'LocalRun' },
  timeField: { CiRun: 'at', LocalRun: 'at' },
  fieldPhrases: {
    slower: { field: 'LocalRun.durationMs', exclude: skipped },
    faster: { field: 'LocalRun.durationMs', exclude: skipped },
    'on ci': { field: 'CiRun.durationMs', exclude: skipped }
  }
};

// --- a domain with two edges between one pair of types, and an island ---
const market = packOf('m', {
  Person: { fields: { name: str } },
  Trade: { fields: { buyer: ref('m', 'Person'), seller: ref('m', 'Person'), price: num } },
  Island: { fields: { size: num } }
});
const marketRulings: NamespaceRulings = {
  typeAliases: { people: 'Person' },
  fieldPhrases: {
    'trade price': { field: 'Trade.price' },
    'island size': { field: 'Island.size' }
  }
};
const marketParse = (q: string) => parseQuestion(q, market, { asOf, rulings: marketRulings });

describe('the yardsticks', () => {
  it('card yardstick parses to the spec §1 frame', () => {
    const r = card(
      'How many cards that are valued PSA 9 are selling for 25% over asking price in the past 2 days?'
    );
    expect(r.status).toBe('resolved');
    const c = r.candidates[0];
    expect(c?.answer).toBe('count');
    expect(c?.frame).toEqual({
      'cards/Cert': {
        params: {
          where: {
            AND: [
              { grade: { eq: 9 } },
              {
                _walk: {
                  as: 'L',
                  in: 'cards/Listing.cert',
                  where: {
                    AND: [{ firstSeen: PAST_2_DAYS }, { NOT: { placeholderPrice: { eq: true } } }]
                  }
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
          },
          count: true
        }
      }
    });
    // The exclusion is its own plan clause, named for the ruling; the walk says "any".
    expect(c?.plan).toContainEqual({
      path: ['where', 'AND', '1', '_walk', 'where', 'AND', '1', 'NOT', 'ruling:asking price'],
      kind: 'filter',
      served: false
    });
    expect(c?.plan).toContainEqual({
      path: ['where', 'AND', '2', '_walk', 'cards/Observation.cert', 'any'],
      kind: 'hop',
      served: true
    });
    expect(c?.plan).toContainEqual({
      path: ['where', 'AND', '2', '_walk', 'where', 'price', 'gte'],
      kind: 'ref',
      served: true
    });
    expect(c?.dropped).toEqual([]);
  });

  it('test-run yardstick parses to the equivalent frame', () => {
    const r = parseQuestion(
      'How many pg-gated tests ran locally 25% slower than on CI in the past 2 days?',
      runs,
      { asOf, rulings: runRulings }
    );
    expect(r.status).toBe('resolved');
    expect(r.candidates[0]?.frame).toEqual({
      'runs/Test': {
        params: {
          where: {
            AND: [
              { suite: { eq: 'pg-gated' } },
              {
                _walk: {
                  as: 'CR',
                  in: 'runs/CiRun.test',
                  where: { AND: [{ at: PAST_2_DAYS }, { NOT: skipped }] }
                }
              },
              {
                _walk: {
                  as: 'LR',
                  in: 'runs/LocalRun.test',
                  where: {
                    AND: [
                      { durationMs: { gte: { $ref: 'CR.durationMs', times: 1.25 } } },
                      { NOT: skipped }
                    ]
                  }
                }
              }
            ]
          },
          count: true
        }
      }
    });
  });

  it('"N% faster" is times 1 - N/100, at most', () => {
    const r = parseQuestion('how many tests ran locally 20% faster than on ci', runs, {
      asOf,
      rulings: runRulings
    });
    expect(JSON.stringify(r.candidates[0]?.frame)).toContain(
      '"durationMs":{"lte":{"$ref":"CR.durationMs","times":0.8}}'
    );
  });
});

describe('paths', () => {
  it('finds shortest paths both ways', () => {
    expect(findPaths(cards, 'Cert', 'Listing')).toEqual([
      [{ dir: 'in', from: 'Cert', owner: 'Listing', field: 'cert', to: 'Listing' }]
    ]);
    expect(findPaths(cards, 'Listing', 'Observation')).toHaveLength(1);
    expect(findPaths(cards, 'Listing', 'Observation')[0]?.map((h) => h.dir)).toEqual(['out', 'in']);
  });

  it('two equally short paths → clarify with both', () => {
    const r = marketParse('how many people with a trade price over 50');
    expect(r.status).toBe('clarify');
    expect(r.reason).toContain('in m/Trade.buyer');
    expect(r.reason).toContain('in m/Trade.seller');
  });

  it('no path → that part dropped', () => {
    const r = marketParse('how many people with an island size over 5');
    expect(r.status).toBe('partial');
    const c = r.candidates[0];
    expect(c?.frame).toEqual({ 'm/Person': { params: {} } });
    expect(c?.dropped).toEqual([
      { span: 'island size', reason: 'no crossRef path from Person to Island within 3 hops' },
      { span: 'over 5', reason: 'its field "island size" was dropped' }
    ]);
  });

  it('a two-hop walk nests', () => {
    expect(findPaths(cards, 'Listing', 'Observation')[0]?.map((h) => h.to)).toEqual([
      'Cert',
      'Observation'
    ]);
  });
});

describe('comparisons', () => {
  it('"25% over" → times 1.25, "at least 2x" → times 2, "over $50" → gt 50', () => {
    expect(parseComparison(['25%', 'over'])).toEqual({ op: 'gte', times: 1.25, length: 2 });
    expect(parseComparison(['at', 'least', '2x'])).toEqual({ op: 'gte', times: 2, length: 3 });
    expect(parseComparison(['at', 'least', '3', 'times'])).toEqual({
      op: 'gte',
      times: 3,
      length: 4
    });
    expect(parseComparison(['over', '$50'])).toEqual({ op: 'gt', value: 50, length: 2 });
    expect(parseComparison(['less', 'than', '10'])).toEqual({ op: 'lt', value: 10, length: 3 });
    expect(parseComparison(['$10', 'over'])).toEqual({ op: 'gte', plus: 10, length: 2 });
    expect(parseComparison(['cheaper', 'than'])).toBeNull();
  });

  it('in a question: a literal goes on the walked field, a factor on a $ref', () => {
    expect(cardWhere('how many cards with an offer over $50')).toEqual({
      _walk: { as: 'O', in: 'cards/Observation.cert', where: { price: { gt: 50 } } }
    });
    const w = JSON.stringify(cardWhere('cards selling for at least 2x asking price'));
    expect(w).toContain('"price":{"gte":{"$ref":"L.price","times":2}}');
  });

  it('a comparative outside the lexicon is dropped, never approximated', () => {
    const r = card('cards with an offer cheaper than asking price');
    expect(r.status).toBe('partial');
    expect(r.candidates[0]?.dropped).toContainEqual({
      span: 'cheaper than',
      reason: 'this comparison is not in the comparison lexicon'
    });
  });
});

describe('time windows', () => {
  it('"past 2 days" binds to the walked type nearest the phrase', () => {
    expect(cardWhere('how many cards with an offer in the past 2 days')).toEqual({
      _walk: { as: 'O', in: 'cards/Observation.cert', where: { observedAt: PAST_2_DAYS } }
    });
  });

  it('ambiguous → clarify', () => {
    const r = card('how many cards with an offer in the past 2 days or an asking price');
    expect(r.status).toBe('clarify');
    expect(r.reason).toBe('"past 2 days" could window Listing or Observation');
  });
});

describe('pick one', () => {
  const walkOf = (q: string) => (cardWhere(q) as { _walk: Record<string, unknown> })._walk;

  it('latest / highest / lowest → pick', () => {
    expect(walkOf('cards whose latest offer is over 50')).toEqual({
      in: 'cards/Observation.cert',
      pick: { latest: 'observedAt' },
      where: { price: { gt: 50 } }
    });
    expect(walkOf('cards whose highest offer is over 50').pick).toEqual({ max: 'price' });
    expect(walkOf('cards whose most recent offer is over 50').pick).toEqual({
      latest: 'observedAt'
    });
    const low = walkOf('cards with the lowest asking price under 20');
    expect(low.pick).toEqual({ min: 'price' });
    expect(low.as).toBeUndefined();
  });

  it('no word → any, and the plan says any; a ruling default overrides', () => {
    const any = card('cards with an offer over 50').candidates[0]?.plan;
    expect(any).toContainEqual({
      path: ['where', '_walk', 'cards/Observation.cert', 'any'],
      kind: 'hop',
      served: true
    });
    const ruled = card('cards with a psa offer over 50').candidates[0];
    expect(JSON.stringify(ruled?.frame)).toContain('"pick":{"latest":"observedAt"}');
    expect(ruled?.plan[0]?.path).toEqual([
      'where',
      '_walk',
      'cards/Observation.cert',
      'pick:latest(observedAt) from ruling'
    ]);
  });

  it('a picked neighbour is never a comparison operand', () => {
    const r = card('cards selling for 25% over the lowest asking price');
    expect(r.status).toBe('partial');
    expect(r.candidates[0]?.dropped).toContainEqual({
      span: '25% over asking price',
      reason: 'a picked Listing cannot be referenced'
    });
  });
});

describe('derived ordering', () => {
  it('"by margin" binds a declared derive, undeclared → dropped', () => {
    const r = card('list cards by margin');
    expect(r.status).toBe('resolved');
    expect(r.candidates[0]?.frame['cards/Cert']?.params).toEqual({
      derive: { margin: { diff: ['$.psaOffer', '$.ask'] } },
      orderBy: [{ $margin: 'desc' }]
    });
    const u = card('list cards by spread');
    expect(u.status).toBe('partial');
    expect(u.candidates[0]?.dropped).toEqual([
      { span: 'by spread', reason: 'no derived value "spread" is declared for this namespace' }
    ]);
  });
});

describe('the judge stays closed', () => {
  it('chooses among parser readings; a reply adding a walk or comparison is ignored and recorded', async () => {
    const judge: Judge = {
      async decide() {
        return {
          action: 'pick',
          candidate: 1,
          walk: { in: 'ns/Todo.project' },
          comparison: { gt: 1 }
        };
      }
    };
    const r = await parseWithJudge('show me substrate', nsPack, nsCtx, judge);
    expect(r.status).toBe('resolved');
    if (r.status !== 'resolved') return;
    expect(r.candidate.type).toBe('Todo');
    expect(JSON.stringify(r.candidate.frame)).not.toContain('_walk');
    expect(r.trail[0]?.ignored).toEqual(['comparison', 'walk']);
  });

  it('a reply that is only a walk is not an option', async () => {
    const judge: Judge = { decide: async () => ({ action: 'walk', in: 'ns/Todo.project' }) };
    const r = await parseWithJudge('show me substrate', nsPack, nsCtx, judge);
    expect(r.status).toBe('escalated');
    expect(r.trail[0]?.rejected).toBe('action "walk" was not offered');
  });
});

describe('never resolved on a silent assumption', () => {
  const runsParse = (q: string, rulings = runRulings) => parseQuestion(q, runs, { asOf, rulings });

  it('a comparison binds only to the field phrase right before it', () => {
    const r = card('how many cards with an offer and listings over 50');
    expect(r.status).not.toBe('resolved');
    const cert = r.candidates.find((c) => c.type === 'Cert');
    expect(JSON.stringify(cert?.frame)).not.toContain('"gt":50');
    expect(cert?.dropped).toContainEqual({
      span: 'over 50',
      reason: 'no field phrase directly before it to compare'
    });
  });

  it('"or", "not", "no" and "every" are dropped while composing walks', () => {
    for (const [q, word] of [
      ['cards with an offer over 50 or an asking price under 20', 'or'],
      ['cards selling for 25% over asking price or offer', 'or'],
      ['cards with an offer not over 50', 'not'],
      ['cards with no offer over 50', 'no'],
      ['cards with every offer over 50', 'every']
    ] as const) {
      const r = card(q);
      expect(r.status, q).toBe('partial');
      expect(
        r.candidates[0]?.dropped.map((d) => d.span),
        q
      ).toContain(word);
    }
  });

  it('a judge pick of a reading with drops is not resolved', async () => {
    const q = 'how many cards with an offer and listings over 50';
    const parsed = card(q);
    const i = parsed.candidates.findIndex((c) => c.dropped.length > 0);
    expect(i).toBeGreaterThanOrEqual(0);
    const judge: Judge = { decide: async () => ({ action: 'pick', candidate: i }) };
    const r = await parseWithJudge(q, cards, { asOf, rulings: cardRulings }, judge);
    expect(r.status).toBe('escalated');
    if (r.status !== 'escalated') return;
    expect(r.result.status).toBe('partial');
    expect(r.result.candidates[0]?.dropped.length).toBeGreaterThan(0);
  });

  it('two types named together stay separate readings, with no invented walk', () => {
    const r = card('cards and listings with an offer over 50');
    expect(r.status).toBe('ambiguous');
    expect(r.candidates.map((c) => c.type)).toEqual(['Cert', 'Listing']);
    expect(JSON.stringify(r.candidates[0]?.frame)).not.toContain('Listing.cert');
  });

  it('a stray comparative alone does not compose', () => {
    expect(card('cards cheaper than ever').candidates[0]?.dropped ?? []).toEqual([]);
  });

  it('two different picks on one walk ask', () => {
    const r = card('cards whose latest offer and highest offer is over 50');
    expect(r.status).toBe('clarify');
    expect(r.reason).toBe('"latest" and "highest" pick different Observation rows');
  });

  it('a derive ordering drops a conflicting "latest", and its limit', () => {
    const r = card('latest cards by margin');
    expect(r.status).toBe('partial');
    expect(r.candidates[0]?.frame['cards/Cert']?.params).toEqual({
      derive: { margin: { diff: ['$.psaOffer', '$.ask'] } },
      orderBy: [{ $margin: 'desc' }]
    });
    expect(r.candidates[0]?.answer).toBe('rows');
    expect(r.candidates[0]?.dropped).toEqual([
      { span: 'latest', reason: 'it conflicts with the derived ordering, which is kept' }
    ]);
  });

  it('"N% faster" with N >= 100 is dropped', () => {
    const r = runsParse('how many tests ran locally 150% faster than on ci');
    expect(r.status).toBe('partial');
    expect(r.candidates[0]?.dropped).toEqual([
      { span: '150% faster than', reason: '150% faster leaves no time to compare against' }
    ]);
    expect(JSON.stringify(r.candidates[0]?.frame)).not.toContain('times');
  });

  it("a phrase said twice adds its ruling's exclude once", () => {
    const w = cardWhere('how many cards with an asking price and an asking price');
    expect(w).toEqual({
      _walk: {
        as: 'L',
        in: 'cards/Listing.cert',
        where: { NOT: { placeholderPrice: { eq: true } } }
      }
    });
  });

  it('a window with no timeField ruling says it used the default', () => {
    const { timeField: _t, ...noTime } = runRulings;
    const c = runsParse('how many tests 25% slower than on ci in the past 2 days', noTime)
      .candidates[0];
    expect(c?.plan.map((p) => p.path[p.path.length - 1])).toContain(
      'window:past 2 days on createdAt (default)'
    );
  });
});
