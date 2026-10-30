/**
 * The NL golden set over the synthetic test-run domain (typed edge walks spec,
 * Measurement "Targets"). The gate is ZERO fabrications: a question whose
 * expected outcome is `unknown`/`clarify`/`refuse`, or any outcome with a
 * dropped filter, answered with a number or a strict single/pick/`$ref` row.
 * Parse and `dropped` correctness are measured and printed, not asserted;
 * see them with `vitest run src/__tests__/golden-walks.test.ts --silent=false`.
 */
import { isDeepStrictEqual } from 'node:util';
import type { NlOutcome, Query, SubstrateRequest } from '@mnmal-ai/substrate/sdk';
import { afterAll, describe, expect, it } from 'vitest';
import type { NlEngineAccess } from '../access.js';
import type { NlEvent } from '../ask/events.js';
import { runAsk } from '../ask/run.js';
import type { Judge } from '../judge/judge.js';
import { buildNamespacePack } from '../pack/build.js';
import type { ServedPack } from '../pack/service.js';
import { OPERATORS } from './_fixture.js';
import golden from './fixtures/test-runs-golden.json' with { type: 'json' };

interface Entry {
  question: string;
  expect: { kind: string; answer?: string; frame?: Record<string, unknown>; dropped?: string[] };
}

// --- the synthetic domain: example values only ---
const num = { kind: 'scalar' as const, type: 'number' as const, indexed: true };
const str = { kind: 'scalar' as const, type: 'string' as const, indexed: true };
const date = { kind: 'scalar' as const, type: 'date' as const, indexed: true };
const bool = { kind: 'scalar' as const, type: 'boolean' as const, indexed: true };
const ref = (type: string) => ({
  kind: 'crossRef' as const,
  ns: 'runs',
  type,
  onDelete: 'restrict' as const
});
const status = { ...str, enum: ['passed', 'failed', 'skipped', 'killed'] };
const run = { test: ref('Test'), at: date, durationMs: num, setupMs: num, status };
// Ruling: a skipped or memory-killed run never counts toward "slower" or a duration.
const excluded = { status: { in: ['skipped', 'killed'] } };
const pack: ServedPack = {
  ...buildNamespacePack({
    namespace: 'runs',
    schema: {
      schemaVersion: 'v',
      mutations: {},
      types: {
        Test: { fields: { package: str, file: str, name: str, pgGated: bool } },
        CiRun: { fields: { ...run, job: ref('Job') } },
        LocalRun: { fields: { ...run, host: str, cores: num, concurrency: num } },
        // A CI chain deep enough that a Repo is four hops from a Test.
        Job: { fields: { name: str, workflow: ref('Workflow') } },
        Workflow: { fields: { name: str, timeoutMin: num, repo: ref('Repo') } },
        Repo: { fields: { name: str, sizeMb: num } }
      }
    },
    operators: OPERATORS,
    profile: {
      types: {
        Test: { package: { values: ['pkg-core', 'pkg-filter'], truncated: false } },
        LocalRun: { host: { values: ['host-a', 'host-b'], truncated: false } }
      }
    }
  }),
  rulings: {
    typeAliases: { locally: 'LocalRun' },
    timeField: { CiRun: 'at', LocalRun: 'at' },
    fieldPhrases: {
      'pg-gated': { field: 'Test.pgGated', value: true },
      slower: { field: 'LocalRun.durationMs', exclude: excluded },
      faster: { field: 'LocalRun.durationMs', exclude: excluded },
      'on ci': { field: 'CiRun.durationMs', exclude: excluded },
      'local duration': { field: 'LocalRun.durationMs', exclude: excluded },
      'ci duration': { field: 'CiRun.durationMs', exclude: excluded },
      'local setup': { field: 'LocalRun.setupMs', exclude: excluded },
      'workflow timeout': { field: 'Workflow.timeoutMin' },
      'repo size': { field: 'Repo.sizeMb' }
    }
  },
  warnings: []
};

const http: SubstrateRequest = {
  method: 'POST',
  path: '/substrate/v1/nl',
  headers: {},
  query: {},
  params: {},
  body: null
};
const now = () => new Date('2026-10-30T12:00:00Z');
const engine: NlEngineAccess = {
  federatedSchema: () => ({}),
  operators: () => ({}),
  query: async (frame: Query) => {
    const [key, value] = Object.entries(frame)[0] as [string, { params: { count?: boolean } }];
    return { data: { [key]: value.params.count === true ? { count: 7 } : [{ id: '1' }] } };
  }
};
/** Always picks the first reading when picking is offered; otherwise its reply is rejected. */
const firstPick: Judge = { decide: async () => ({ action: 'pick', candidate: 0 }) };

async function ask(question: string, judge?: Judge): Promise<NlOutcome> {
  let outcome: NlOutcome | undefined;
  const deps = { pack, engine, now, ...(judge !== undefined ? { judge } : {}) };
  for await (const ev of runAsk(
    { namespace: 'runs', question },
    http,
    deps
  ) as AsyncGenerator<NlEvent>) {
    if (ev.event === 'outcome') outcome = ev.outcome;
  }
  if (outcome === undefined) throw new Error(`no outcome for ${question}`);
  return outcome;
}

/** A number, or one row chosen by a pick-one or a correlated comparison. */
function strictAnswer(o: NlOutcome): boolean {
  if (o.kind !== 'rows') return false;
  return o.answer !== 'rows' || /"(\$ref|pick)":/.test(JSON.stringify(o.frame));
}
function fabricated(e: Entry, o: NlOutcome): boolean {
  if (!strictAnswer(o) || o.kind !== 'rows') return false;
  return e.expect.kind !== 'rows' || o.dropped.some((d) => d.kind === 'filter');
}
const paramsOf = (frame: Query) =>
  Object.fromEntries(Object.entries(frame).map(([k, v]) => [k, (v as { params: unknown }).params]));
function parseCorrect(e: Entry, o: NlOutcome): boolean {
  if (o.kind !== e.expect.kind) return false;
  if (o.kind !== 'rows') return true;
  if (e.expect.answer !== undefined && o.answer !== e.expect.answer) return false;
  return e.expect.frame === undefined || isDeepStrictEqual(paramsOf(o.frame), e.expect.frame);
}
function droppedCorrect(e: Entry, o: NlOutcome): boolean {
  const got = 'dropped' in o ? o.dropped.map((d) => d.span).sort() : [];
  return isDeepStrictEqual(got, [...(e.expect.dropped ?? [])].sort());
}

const entries = golden as Entry[];

describe('the golden set is well formed', () => {
  it('has at least 30 questions, 6 of them inexpressible', () => {
    expect(entries.length).toBeGreaterThanOrEqual(30);
    const inexpressible = entries.filter(
      (e) => e.expect.kind === 'unknown' || e.expect.kind === 'clarify'
    );
    expect(inexpressible.length).toBeGreaterThanOrEqual(6);
  });
});

for (const [label, judge] of [
  ['no judge', undefined],
  ['a judge that always picks the first reading', firstPick]
] as const) {
  describe(`golden set, ${label}`, () => {
    const score = { parse: 0, dropped: 0, fabrications: [] as string[], misses: [] as string[] };

    it.each(entries)('$question', async (e) => {
      const o = await ask(e.question, judge);
      if (fabricated(e, o)) score.fabrications.push(e.question);
      if (parseCorrect(e, o)) score.parse++;
      else score.misses.push(`parse: ${e.question}`);
      if (droppedCorrect(e, o)) score.dropped++;
      else score.misses.push(`dropped: ${e.question}`);
      expect(fabricated(e, o), JSON.stringify(o)).toBe(false);
      // The expected kind is the confidence rule's; a judge may only make a reading safer.
      if (judge === undefined) expect(o.kind).toBe(e.expect.kind);
    });

    it('fabricates nothing', () => {
      expect(score.fabrications).toEqual([]);
    });

    afterAll(() => {
      const rate = (n: number) =>
        `${n}/${entries.length} (${((100 * n) / entries.length).toFixed(1)}%)`;
      console.info(
        `[golden-walks, ${label}] parse ${rate(score.parse)}, dropped ${rate(score.dropped)}, fabrications ${score.fabrications.length}${score.misses.map((m) => `\n  miss ${m}`).join('')}`
      );
    });
  });
}
