/**
 * NL-composed walk frames, end to end (#1831): the pack is built from a live
 * engine, the question runs through `runAsk`, and the frame through a real
 * engine over PgDataset and over the memory reference. Both stores must give
 * the same answer, and the engine's walk plan must merge into the parser's.
 *
 * The pg half is skipped unless POSTGRES_URL is set.
 */

import { randomBytes } from 'node:crypto';
import {
  defineNamespace,
  field,
  type NlOutcome,
  type Query,
  type SubstrateRequest
} from '@mnmal-ai/substrate/sdk';
import {
  type ComposeResult,
  compose,
  MemoryDataset,
  MemoryEdgesStore,
  MemorySubstrateServer,
  PgDataset,
  PgEdgesStore
} from '@mnmal-ai/substrate/testing';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NlEngineAccess } from '../access.js';
import type { NlEvent } from '../ask/events.js';
import { runAsk } from '../ask/run.js';
import { PackService } from '../pack/service.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const NS = `nlw_${randomBytes(4).toString('hex')}`;

const TYPES = {
  Test: { fields: { name: field.string(), pgGated: field.boolean() } },
  Run: {
    fields: {
      test: field.crossRef(NS, 'Test'),
      durationMs: field.number(),
      status: field.enum(['passed', 'failed', 'skipped']),
      at: field.date()
    }
  }
};
const RULINGS = {
  timeField: { Run: 'at' },
  // A skipped run never counts: on a picked walk this is the pick's `among` (#1810).
  typeExcludes: { Run: { status: { eq: 'skipped' } } },
  fieldPhrases: {
    'pg-gated': { field: 'Test.pgGated', value: true },
    'run duration': { field: 'Run.durationMs' }
  }
};

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const TESTS = [
  { id: id(1), name: 't1', pgGated: true },
  { id: id(2), name: 't2', pgGated: false },
  { id: id(3), name: 't3', pgGated: true },
  { id: id(4), name: 't4', pgGated: false }
];
const run = (n: number, test: number, durationMs: number, status: string, day: number) => ({
  id: id(100 + n),
  test: id(test),
  durationMs,
  status,
  at: `2026-10-${String(day).padStart(2, '0')}T12:00:00.000Z`
});
const RUNS = [
  // t1: its latest run is skipped and slow; the latest that counts is fast.
  run(1, 1, 3, 'passed', 20),
  run(2, 1, 50, 'skipped', 29),
  // t2: latest counted run is slow.
  run(3, 2, 2, 'passed', 20),
  run(4, 2, 40, 'failed', 28),
  // t3: only a slow skipped run, so no counted run at all.
  run(5, 3, 60, 'skipped', 29),
  // t4: slow then fast.
  run(6, 4, 30, 'passed', 20),
  run(7, 4, 1, 'passed', 28)
];

const http: SubstrateRequest = {
  method: 'POST',
  path: '/substrate/v1/nl',
  headers: {},
  query: {},
  params: {},
  body: null
};
const ctx = {
  identity: { kind: 'system' as const, id: 'test', grants: { '*': ['read', 'mutate'] } },
  now: new Date(),
  headers: {},
  meta: {}
};
const now = () => new Date('2026-10-30T12:00:00Z');

interface Store {
  composed: ComposeResult;
  ask(question: string): Promise<NlOutcome>;
}

async function store(kind: 'memory' | 'pg', sql?: Sql): Promise<Store> {
  const nsDef = defineNamespace(NS, TYPES, { annotations: { nl: RULINGS } });
  const fieldDefLookup = (type: string, f: string) => nsDef.types?.[type]?.fields[f];
  const typeDefLookup = (type: string) => nsDef.types?.[type];
  const edges =
    sql === undefined ? new MemoryEdgesStore({ now: () => new Date() }) : new PgEdgesStore({ sql });
  const dataset =
    sql === undefined
      ? new MemoryDataset({ namespace: NS, fieldDefLookup, typeDefLookup, walkReference: true })
      : new PgDataset({
          namespace: NS,
          sql,
          edgesStore: edges as PgEdgesStore,
          fieldDefLookup,
          typeDefLookup
        });
  if (dataset instanceof PgDataset)
    for (const t of Object.keys(TYPES)) await dataset.ensureTypeStorage(t);
  await dataset.write('Test', TESTS as never);
  await dataset.write('Run', RUNS as never);
  const composed = await compose({
    server: new MemorySubstrateServer(),
    dataset: new MemoryDataset({ namespace: 'default' }),
    datasets: { [NS]: dataset },
    edges,
    coordinators: [{ name: `${NS}-${kind}`, contractVersion: '*', namespaces: [nsDef] }] as never,
    systemActor: 'test'
  });
  const engine: NlEngineAccess = {
    federatedSchema: () => composed.engine.federatedSchema(),
    operators: (ns) => composed.engine.datasetFor(ns)?.capabilities.operators,
    query: (frame: Query) => composed.engine.query({ frame, ctx }) as never
  };
  const packs = new PackService({ engine });
  return {
    composed,
    async ask(question) {
      const served = await packs.get(NS, http);
      if (served === undefined) throw new Error('no pack');
      let outcome: NlOutcome | undefined;
      for await (const ev of runAsk({ namespace: NS, question }, http, {
        pack: served.pack,
        engine,
        now
      }) as AsyncGenerator<NlEvent>) {
        if (ev.event === 'outcome') outcome = ev.outcome;
      }
      if (outcome === undefined) throw new Error(`no outcome for ${question}`);
      return outcome;
    }
  };
}

/** The answer an outcome gives: a count, or the matched rows' names. */
function answer(o: NlOutcome): unknown {
  if (o.kind !== 'rows') return o.kind;
  if (o.errors !== undefined) return { errors: o.errors };
  if (o.count !== undefined) return { count: o.count };
  const name = (r: { id: string }) => TESTS.find((t) => t.id === r.id)?.name ?? r.id;
  return ((o.data as Array<{ id: string }>) ?? []).map(name).sort();
}

describe.skipIf(!POSTGRES_URL)('NL walk frames over pg agree with memory', () => {
  let sql: Sql;
  let mem: Store;
  let pg: Store;

  beforeAll(async () => {
    sql = postgres(POSTGRES_URL as string, { onnotice: () => {} });
    mem = await store('memory');
    pg = await store('pg', sql);
  });

  afterAll(async () => {
    await mem?.composed.stop();
    await pg?.composed.stop();
    await sql?.end({ timeout: 5 });
  });

  const cases: Array<[string, unknown, (o: NlOutcome & { kind: 'rows' }) => void]> = [
    [
      // A picked walk: `among` drops the skipped run before the pick, so t1's
      // slow skipped run does not make it the latest.
      'tests whose latest run duration is over 5',
      ['t2'],
      (o) => {
        const params = o.frame[`${NS}/Test`]?.params as
          | { where: { _walk: Record<string, unknown> } }
          | undefined;
        const w = params?.where._walk ?? {};
        expect(w.pick).toEqual({ latest: 'at' });
        expect(w.among).toEqual({ NOT: { status: { eq: 'skipped' } } });
        expect(o.plan.map((c) => c.path.join('.'))).toContain(
          'where._walk.among.NOT.ruling:Run default exclude'
        );
      }
    ],
    ['how many tests with a run duration over 5', { count: 2 }, () => {}],
    ['pg-gated tests with a run duration over 2', ['t1'], () => {}]
  ];

  for (const [question, expected, check] of cases) {
    it(question, async () => {
      const [m, p] = [await mem.ask(question), await pg.ask(question)];
      expect(m.kind).toBe('rows');
      expect(p.kind).toBe('rows');
      if (m.kind !== 'rows' || p.kind !== 'rows') return;
      expect(p.frame).toEqual(m.frame);
      expect(answer(m)).toEqual(expected);
      expect(answer(p)).toEqual(expected);
      expect(p.dropped).toEqual([]);
      check(p);
      // pg's plan merged INTO the parser's labelled clauses: its index advice
      // lands on them, and no engine filter clause is left over unmatched.
      const label = (c: { path: string[] }) => (c.path.at(-1) ?? '').includes(':');
      expect(p.plan.some((c) => label(c) && c.recommend !== undefined)).toBe(true);
      expect(p.plan.filter((c) => c.kind === 'filter').every(label)).toBe(true);
      expect(p.plan.some((c) => c.kind === 'hop' && c.served)).toBe(true);
    });
  }
});
