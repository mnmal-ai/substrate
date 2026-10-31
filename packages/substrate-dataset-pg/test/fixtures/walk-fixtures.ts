/**
 * The two walk parity fixtures (spec 2026-10-24-typed-edge-walks §1 and
 * Measurement "Synthetic domain"), with example values only. Ids are fixture
 * names; the suite maps them, and every crossRef value, to uuids.
 */

import type { FieldDef } from '@mnmal-ai/substrate-types';

/** The window both yardsticks ask about: the two days before 2026-10-30. */
export const RECENT = '2026-10-28T00:00:00Z';

/** The crossRef fields, whose values are fixture names like ids. */
export const REF_FIELDS = new Set(['id', 'cert', 'test']);

export function walkSchema(ns: string): Record<string, Record<string, FieldDef>> {
  const num: FieldDef = { kind: 'scalar', type: 'number' };
  const str: FieldDef = { kind: 'scalar', type: 'string' };
  const bool: FieldDef = { kind: 'scalar', type: 'boolean' };
  const date: FieldDef = { kind: 'scalar', type: 'date' };
  const ref = (type: string): FieldDef => ({ kind: 'crossRef', ns, type, onDelete: 'set_null' });
  const run = { test: ref('Test'), at: date, durationMs: num, setupMs: num, status: str };
  return {
    Cert: { grade: num, ask: num },
    Listing: { cert: ref('Cert'), price: num, firstSeen: date },
    Observation: { cert: ref('Cert'), price: num, observedAt: date, status: str },
    Test: { package: str, file: str, name: str, pgGated: bool },
    CiRun: run,
    LocalRun: { ...run, host: str, cores: num, concurrency: num }
  };
}

const day = (d: number, h = 0) =>
  `2026-10-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:00:00Z`;

/**
 * Cards: c1 is the only yardstick hit (a recent listing at 100 and an
 * observation at 130); c2's cheap listing is old; c3 is grade 8; c4's
 * observation and c6's listing have null prices; c5 has no listing; c7's one
 * observation is tombstoned.
 */
export const CARDS = {
  Cert: [
    { id: 'c1', grade: 9, ask: 100 },
    { id: 'c2', grade: 9, ask: 80 },
    { id: 'c3', grade: 8, ask: 20 },
    { id: 'c4', grade: 9, ask: 50 },
    { id: 'c5', grade: 9, ask: 300 },
    { id: 'c6', grade: 9, ask: 10 },
    { id: 'c7', grade: 9, ask: 5 }
  ],
  Listing: [
    { id: 'l1', cert: 'c1', price: 100, firstSeen: day(29) },
    { id: 'l2a', cert: 'c2', price: 100, firstSeen: day(29) },
    { id: 'l2b', cert: 'c2', price: 40, firstSeen: day(1) },
    { id: 'l3', cert: 'c3', price: 10, firstSeen: day(29) },
    { id: 'l4', cert: 'c4', price: 100, firstSeen: day(29) },
    { id: 'l6', cert: 'c6', price: null, firstSeen: day(29) },
    { id: 'l7', cert: 'c7', price: 10, firstSeen: day(29) }
  ],
  Observation: [
    { id: 'o1a', cert: 'c1', price: 130, observedAt: day(29, 10), status: 'sold' },
    { id: 'o1b', cert: 'c1', price: 90, observedAt: day(27), status: 'listed' },
    { id: 'o2', cert: 'c2', price: 70, observedAt: day(29), status: 'listed' },
    { id: 'o3', cert: 'c3', price: 100, observedAt: day(29, 12), status: 'sold' },
    { id: 'o4', cert: 'c4', price: null, observedAt: day(29), status: 'listed' },
    { id: 'o5', cert: 'c5', price: 500, observedAt: day(25), status: 'sold' },
    { id: 'o5b', cert: 'c5', price: 450, observedAt: day(29, 3), status: 'listed' },
    { id: 'o6', cert: 'c6', price: 1000, observedAt: day(29, 6), status: 'sold' },
    { id: 'o7', cert: 'c7', price: 999, observedAt: day(29), status: 'sold' }
  ]
};

/**
 * Test runs: t1 is the only yardstick hit (local 130 against CI 100). t2's
 * slow local runs are skipped or old; t3 is not pg-gated; t4's fast CI run is
 * old; t5's CI run is skipped; t6's CI duration is null.
 */
export const RUNS = {
  Test: [
    { id: 't1', package: 'pkg-a', file: 'reads.test.ts', name: 'reads rows', pgGated: true },
    { id: 't2', package: 'pkg-a', file: 'writes.test.ts', name: 'writes rows', pgGated: true },
    { id: 't3', package: 'pkg-b', file: 'parse.test.ts', name: 'parses input', pgGated: false },
    { id: 't4', package: 'pkg-b', file: 'index.test.ts', name: 'uses an index', pgGated: true },
    { id: 't5', package: 'pkg-c', file: 'drop.test.ts', name: 'drops a type', pgGated: true },
    { id: 't6', package: 'pkg-c', file: 'lock.test.ts', name: 'takes a lock', pgGated: true }
  ],
  CiRun: [
    { id: 'ci1', test: 't1', at: day(29, 1), durationMs: 100, setupMs: 10, status: 'passed' },
    { id: 'ci2', test: 't2', at: day(29, 1), durationMs: 100, setupMs: 10, status: 'passed' },
    { id: 'ci3', test: 't3', at: day(29, 1), durationMs: 100, setupMs: 5, status: 'passed' },
    { id: 'ci4a', test: 't4', at: day(29, 1), durationMs: 200, setupMs: 20, status: 'passed' },
    { id: 'ci4b', test: 't4', at: day(1), durationMs: 50, setupMs: 20, status: 'passed' },
    { id: 'ci5', test: 't5', at: day(29, 1), durationMs: 10, setupMs: 1, status: 'skipped' },
    { id: 'ci6', test: 't6', at: day(29, 1), durationMs: null, setupMs: 3, status: 'passed' }
  ],
  LocalRun: [
    { id: 'lr1', test: 't1', at: day(29, 2), durationMs: 130, setupMs: 12, status: 'passed' },
    { id: 'lr2a', test: 't2', at: day(29, 2), durationMs: 200, setupMs: 9, status: 'skipped' },
    { id: 'lr2b', test: 't2', at: day(20, 2), durationMs: 300, setupMs: 9, status: 'passed' },
    { id: 'lr3', test: 't3', at: day(29, 2), durationMs: 200, setupMs: 4, status: 'passed' },
    { id: 'lr4', test: 't4', at: day(29, 2), durationMs: 100, setupMs: 30, status: 'passed' },
    { id: 'lr5', test: 't5', at: day(29, 2), durationMs: 100, setupMs: 2, status: 'passed' },
    { id: 'lr6', test: 't6', at: day(29, 2), durationMs: 1000, setupMs: 3, status: 'passed' }
  ].map((r, i) => ({ ...r, host: i % 2 === 0 ? 'host-a' : 'host-b', cores: 8, concurrency: 4 }))
};

/** Rows tombstoned after loading, by type. */
export const TOMBSTONED: Record<string, string[]> = { Observation: ['o7'] };
