import type { Query, SubstrateRequest } from '@mnmal-ai/substrate/sdk';
import { expect, it, vi } from 'vitest';
import type { NlEngineAccess } from '../access.js';
import { runAsk } from '../ask/run.js';
import { parseWithJudge } from '../judge/judge.js';
import { buildNamespacePack } from '../pack/build.js';
import type { ServedPack } from '../pack/service.js';
import { parseQuestion } from '../parse/parse.js';
import { OPERATORS } from './_fixture.js';

// The judge's escalation is stubbed: no fixture question yields an ambiguous parse whose
// second reading alone has drops, and the point is which reading run.ts hands off.
vi.mock('../judge/judge.js', async (orig) => ({
  ...(await orig<typeof import('../judge/judge.js')>()),
  parseWithJudge: vi.fn()
}));

const num = { kind: 'scalar' as const, type: 'number' as const, indexed: true };
const ref = { kind: 'crossRef' as const, ns: 'cards', type: 'Cert', onDelete: 'restrict' as const };
const pack: ServedPack = {
  ...buildNamespacePack({
    namespace: 'cards',
    schema: {
      schemaVersion: 'v',
      mutations: {},
      types: {
        Cert: { fields: { grade: num } },
        Listing: { fields: { cert: ref, price: num } },
        Observation: { fields: { cert: ref, price: num } }
      }
    },
    operators: OPERATORS,
    profile: { types: {} }
  }),
  rulings: {
    typeAliases: { cards: 'Cert' },
    fieldPhrases: { 'selling for': { field: 'Observation.price' } }
  },
  warnings: []
};
const http = { method: 'POST', path: '/', headers: {}, query: {}, params: {}, body: null };

it("an escalated pick hands off the judge's reading: strict with drops is unknown, never candidate 0's number", async () => {
  const q = 'how many listings and cards selling for over 50';
  const parsed = parseQuestion(q, pack, { asOf: '2026-10-30T12:00:00Z', rulings: pack.rulings });
  expect(parsed.status).toBe('ambiguous');
  const [clean, other] = parsed.candidates;
  expect(clean?.dropped).toEqual([]);
  const chosen = {
    ...(other as NonNullable<typeof other>),
    dropped: [{ span: 'over 50', reason: 'stub', kind: 'filter' as const }]
  };
  vi.mocked(parseWithJudge).mockResolvedValue({
    status: 'escalated',
    result: { status: 'partial', candidates: [chosen], residual: [], reason: 'dropped' },
    trail: []
  });
  const query = vi.fn(async (f: Query) => ({
    data: { [Object.keys(f)[0] as string]: { count: 9 } }
  }));
  const engine: NlEngineAccess = { federatedSchema: () => ({}), operators: () => ({}), query };
  let outcome: unknown;
  for await (const ev of runAsk({ namespace: 'cards', question: q }, http as SubstrateRequest, {
    pack,
    engine,
    judge: { decide: vi.fn() },
    now: () => new Date('2026-10-30T12:00:00Z')
  }))
    if (ev.event === 'outcome') outcome = ev.outcome;
  expect(outcome).toMatchObject({ kind: 'unknown', dropped: [{ span: 'over 50' }] });
  expect(query).not.toHaveBeenCalled();
});

it("an escalated re-parse with no reading falls back to the parser's, under the same rule", async () => {
  const q = 'how many listings and cards selling for over 50';
  vi.mocked(parseWithJudge).mockResolvedValue({
    status: 'escalated',
    result: { status: 'unparsed', candidates: [], residual: [], reason: 'none' },
    trail: []
  });
  const query = vi.fn(async (f: Query) => ({
    data: { [Object.keys(f)[0] as string]: { count: 9 } }
  }));
  const engine: NlEngineAccess = { federatedSchema: () => ({}), operators: () => ({}), query };
  let outcome: unknown;
  for await (const ev of runAsk({ namespace: 'cards', question: q }, http as SubstrateRequest, {
    pack,
    engine,
    judge: { decide: vi.fn() },
    now: () => new Date('2026-10-30T12:00:00Z')
  }))
    if (ev.event === 'outcome') outcome = ev.outcome;
  expect(outcome).toMatchObject({ kind: 'rows', source: 'handoff', count: 9 });
});
