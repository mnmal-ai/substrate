/**
 * The index advisor pass over a memory `_system` dataset and a fake store
 * whose `typeStats` and `indexPlan` the test sets. The pg twin, with real
 * statistics and the reconciler's own desired indexes, is
 * apps/substrate/test/index-advisor.test.ts.
 */

import type { ReadShape } from '@mnmal-ai/substrate-core';
import { ShapeRecorder } from '@mnmal-ai/substrate-core';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { defineNamespace, field } from '@mnmal-ai/substrate-sdk';
import type {
  Dataset,
  FieldDef,
  IndexPlan,
  Registry,
  Row,
  TypeStats
} from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import {
  type AdvisorDeps,
  createAdvisorMemory,
  INDEX_RECOMMENDATION_TYPE,
  runAdvisorPass,
  STORE_PROFILE_TYPE
} from '../src/index.js';

const NOW = Date.parse('2026-10-01T00:00:00Z');
/** The database's statistics were last reset ten days before NOW. */
const RESET = '2026-09-21T00:00:00.000000Z';
/** Writes since RESET that average `perMin` a minute at NOW. */
const writesAt = (perMin: number): number => (perMin * (NOW - Date.parse(RESET))) / 60_000;
const FIELDS: Record<string, FieldDef> = {
  status: field.string(),
  owner: { kind: 'crossRef', ns: 'app', type: 'User' } as FieldDef,
  dueOn: field.date()
};
const NATURAL: Array<[string, 'asc' | 'desc']> = [['createdAt', 'desc']];

interface Store {
  stats: TypeStats[];
  plan: IndexPlan;
}

function world(store: Store, system = new MemoryDataset({ namespace: '_system' })) {
  const dataset = {
    typeStats: async () => store.stats,
    indexPlan: async (type: string, ns: string) =>
      ns === 'app' && type === 'Task' ? store.plan : undefined
  } as unknown as Dataset;
  const registry = { get: () => ({ kind: 'type', fields: FIELDS }) } as unknown as Registry;
  const recorder = new ShapeRecorder();
  const deps: AdvisorDeps = {
    dataset,
    system,
    recorder,
    registry: () => registry,
    now: () => NOW,
    memory: createAdvisorMemory()
  };
  return {
    deps,
    system,
    recorder,
    recs: async (): Promise<Row[]> => (await system.read(INDEX_RECOMMENDATION_TYPE, {})).rows,
    setProfile: (profile: string) =>
      system.write(STORE_PROFILE_TYPE, [{ id: 'store', profile, updatedReason: 'test' }])
  };
}

const shape = (filters: ReadShape['filters'], orderBy = NATURAL): ReadShape => ({
  namespace: 'app',
  type: 'Task',
  filters,
  orderBy
});
const stats = (
  liveRows: number,
  indexes: TypeStats['indexes'] = [],
  writesTotal = 0,
  statsSince: string | null = RESET
): TypeStats => ({
  namespace: 'app',
  type: 'Task',
  liveRows,
  insertsTotal: writesTotal,
  writesTotal,
  statsSince,
  indexes
});
const index = (name: string, over: Partial<TypeStats['indexes'][0]> = {}) => ({
  name,
  scans: 3,
  lastScanAt: null,
  sizeBytes: 8192,
  unique: false,
  engineOwned: true,
  ...over
});
const OLD = 'rows_app_task_old_0badf00d_idx';
const statusEq = shape([{ field: 'status', op: 'eq' }]);

describe('runAdvisorPass', () => {
  it('recommends add for a slow unserved shape on a big type', async () => {
    const w = world({ stats: [stats(30_000)], plan: { indexes: [] } });
    await w.setProfile('scale');
    w.recorder.observe(statusEq, 80);
    w.recorder.observe(shape([{ field: 'status', op: 'eq' }]), 90);
    expect(await runAdvisorPass(w.deps)).toEqual({ upserted: 1 });
    const [rec] = await w.recs();
    expect(rec).toMatchObject({
      namespace: 'app',
      type: 'Task',
      action: 'add',
      state: 'open',
      estimatedWriteCost: 'low'
    });
    expect(rec?.recKey).toBe(rec?.id);
    // The natural order's metadata column is a key too, so the index serves the order.
    expect(JSON.parse(String(rec?.declarationJson))).toEqual({
      fields: ['status', { field: 'createdAt', dir: 'desc' }]
    });
    expect(JSON.parse(String(rec?.evidenceJson))).toMatchObject({ count: 2, liveRows: 30_000 });
  });

  it('does not recommend for a small type, unless it declares itself large', async () => {
    const store: Store = { stats: [stats(5_000)], plan: { indexes: [] } };
    const w = world(store);
    await w.setProfile('scale');
    w.recorder.observe(statusEq, 80);
    expect(await runAdvisorPass(w.deps)).toEqual({ upserted: 0 });
    store.plan = { indexes: [], expectedSize: 'large' };
    w.recorder.observe(statusEq, 80);
    expect(await runAdvisorPass(w.deps)).toEqual({ upserted: 1 });
  });

  it('does not recommend for a fast shape, an unknown type, or an extension operator', async () => {
    const w = world({ stats: [], plan: { indexes: [] } });
    await w.setProfile('scale');
    // Unknown: absent from typeStats, never read as 0 rows.
    w.recorder.observe(statusEq, 900);
    expect(await runAdvisorPass(w.deps)).toEqual({ upserted: 0 });
    const v = world({ stats: [stats(1_000_000)], plan: { indexes: [] } });
    await v.setProfile('scale');
    v.recorder.observe(statusEq, 10);
    expect(await runAdvisorPass(v.deps)).toEqual({ upserted: 0 });
  });

  it('does not recommend when a derived index already serves the shape', async () => {
    const plan: IndexPlan = {
      indexes: [{ name: 'd', keys: [['status', 'asc'], ...NATURAL], unique: false }]
    };
    const w = world({ stats: [stats(1_000_000)], plan });
    await w.setProfile('scale');
    w.recorder.observe(statusEq, 500);
    expect(await runAdvisorPass(w.deps)).toEqual({ upserted: 0 });
    // The same index does not serve the reverse order, nor a second equality.
    w.recorder.observe(shape([{ field: 'status', op: 'eq' }], [['dueOn', 'asc']]), 500);
    w.recorder.observe(
      shape([
        { field: 'status', op: 'eq' },
        { field: 'owner', op: 'eq' }
      ]),
      500
    );
    expect(await runAdvisorPass(w.deps)).toEqual({ upserted: 2 });
    const decls = (await w.recs()).map((r) => JSON.parse(String(r.declarationJson)));
    expect(decls).toContainEqual({ fields: ['status', { field: 'dueOn', dir: 'asc' }] });
    expect(decls).toContainEqual({
      fields: ['status', 'owner', { field: 'createdAt', dir: 'desc' }]
    });
  });

  it('recommends remove for an unused engine-owned non-unique index under write load', async () => {
    const indexes = [
      index(OLD),
      index('rows_app_task_kept_0badf00d_idx'),
      index('rows_app_task_key_0badf00d_uniq', { unique: true }),
      index('rows_app_task_created_at_0badf00d_base'),
      index('hand_made', { engineOwned: false })
    ];
    const plan: IndexPlan = {
      indexes: [{ name: 'rows_app_task_kept_0badf00d_idx', keys: [], unique: false }]
    };
    const store: Store = { stats: [stats(10, indexes, writesAt(100))], plan };
    const w = world(store);
    await w.setProfile('scale');
    expect(await runAdvisorPass(w.deps)).toEqual({ upserted: 1 });
    const [rec] = await w.recs();
    expect(rec).toMatchObject({
      action: 'remove',
      indexName: OLD,
      state: 'open',
      estimatedWriteCost: 'medium'
    });
  });

  it('a restarted advisor still recommends remove: the evidence is the database statistics', async () => {
    const store: Store = { stats: [stats(10, [index(OLD)], writesAt(100))], plan: { indexes: [] } };
    const system = new MemoryDataset({ namespace: '_system' });
    const first = world(store, system);
    await first.setProfile('scale');
    // A fresh instance, with no memory of any earlier pass, stands in for a restart.
    expect(await runAdvisorPass(world(store, system).deps)).toEqual({ upserted: 1 });
    expect((await first.recs())[0]).toMatchObject({ action: 'remove', indexName: OLD });
  });

  it('does not recommend remove for a recent scan, light writes, or statistics never reset', async () => {
    const cases: TypeStats[] = [
      stats(10, [index(OLD, { lastScanAt: '2026-09-30T12:00:00.000000Z' })], writesAt(100)),
      stats(10, [index(OLD)], writesAt(5)),
      // No reset: no origin for the rate, and a fresh process has only just seen the index.
      stats(10, [index(OLD)], writesAt(100), null)
    ];
    for (const c of cases) {
      const w = world({ stats: [c], plan: { indexes: [] } });
      await w.setProfile('scale');
      expect(await runAdvisorPass(w.deps), JSON.stringify(c)).toEqual({ upserted: 0 });
    }
  });

  it('supersedes an open add once its shape is served, and an open remove once its index is wanted or gone', async () => {
    const store: Store = {
      stats: [stats(1_000_000, [index(OLD)], writesAt(100))],
      plan: { indexes: [] }
    };
    const w = world(store);
    await w.setProfile('scale');
    w.recorder.observe(statusEq, 500);
    expect(await runAdvisorPass(w.deps)).toEqual({ upserted: 2 });
    const state = async (action: string) =>
      (await w.recs()).find((r) => r.action === action)?.state;

    store.plan = {
      indexes: [{ name: 'decl', keys: [['status', 'asc'], ...NATURAL], unique: false }]
    };
    await runAdvisorPass(w.deps);
    expect(await state('add')).toBe('superseded');
    expect(await state('remove')).toBe('open');

    store.stats = [stats(1_000_000, [], writesAt(100))];
    await runAdvisorPass(w.deps);
    expect(await state('remove')).toBe('superseded');

    // The index is back and unused again: the same row reopens.
    store.stats = [stats(1_000_000, [index(OLD)], writesAt(100))];
    expect(await runAdvisorPass(w.deps)).toEqual({ upserted: 1 });
    expect(await state('remove')).toBe('open');
    expect(await w.recs()).toHaveLength(2);

    // Wanted again (declared once more): superseded, and not reopened while wanted.
    store.plan = { indexes: [{ name: OLD, keys: [], unique: false }] };
    expect(await runAdvisorPass(w.deps)).toEqual({ upserted: 0 });
    expect(await state('remove')).toBe('superseded');
  });

  it('two passes, and two advisor instances, leave one row per recKey', async () => {
    const system = new MemoryDataset({ namespace: '_system' });
    const store: Store = { stats: [stats(1_000_000)], plan: { indexes: [] } };
    const a = world(store, system);
    const b = world(store, system);
    await a.setProfile('scale');
    a.recorder.observe(statusEq, 100);
    b.recorder.observe(statusEq, 200);
    await Promise.all([runAdvisorPass(a.deps), runAdvisorPass(b.deps)]);
    a.recorder.observe(statusEq, 300);
    await runAdvisorPass(a.deps);
    const recs = await a.recs();
    expect(recs).toHaveLength(1);
    expect(JSON.parse(String(recs[0]?.evidenceJson)).p95Ms).toBeGreaterThanOrEqual(300);
  });

  it('does not reopen a dismissed recommendation', async () => {
    const w = world({ stats: [stats(1_000_000)], plan: { indexes: [] } });
    await w.setProfile('scale');
    w.recorder.observe(statusEq, 100);
    await runAdvisorPass(w.deps);
    const [rec] = await w.recs();
    await w.system.write(INDEX_RECOMMENDATION_TYPE, [
      { id: rec?.id as string, state: 'dismissed' }
    ]);
    w.recorder.observe(statusEq, 900);
    expect(await runAdvisorPass(w.deps)).toEqual({ upserted: 0 });
    const after = await w.recs();
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ state: 'dismissed', evidenceJson: rec?.evidenceJson });
  });

  it('reads its thresholds from the store profile, personal when none is set', async () => {
    const w = world({ stats: [stats(30_000)], plan: { indexes: [] } });
    w.recorder.observe(statusEq, 200);
    expect(await runAdvisorPass(w.deps)).toEqual({ upserted: 0 });
    await w.setProfile('scale');
    w.recorder.observe(statusEq, 200);
    expect(await runAdvisorPass(w.deps)).toEqual({ upserted: 1 });
  });
});

describe('expectedSize', () => {
  it('is validated by defineNamespace', () => {
    expect(() =>
      defineNamespace('app', { T: { fields: {}, expectedSize: 'large' } })
    ).not.toThrow();
    expect(() =>
      defineNamespace('app', { T: { fields: {}, expectedSize: 'huge' as 'large' } })
    ).toThrow(/expectedSize on T must be 'small' or 'large'/);
  });
});
