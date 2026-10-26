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

const DAY = 24 * 60 * 60 * 1000;
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
  let clock = Date.parse('2026-10-01T00:00:00Z');
  const recorder = new ShapeRecorder();
  const deps: AdvisorDeps = {
    dataset,
    system,
    recorder,
    registry: () => registry,
    now: () => clock,
    memory: createAdvisorMemory()
  };
  return {
    deps,
    system,
    recorder,
    tick: (ms: number) => {
      clock += ms;
    },
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
  insertsTotal = 0
): TypeStats => ({
  namespace: 'app',
  type: 'Task',
  liveRows,
  insertsTotal,
  indexes
});
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
    // createdAt is a metadata column, so the declaration stops before it.
    expect(JSON.parse(String(rec?.declarationJson))).toEqual({ fields: ['status'] });
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
    expect(decls).toContainEqual({ fields: ['status', 'owner'] });
  });

  it('recommends remove for an unused engine-owned non-unique index under write load', async () => {
    const index = (name: string, over: Partial<TypeStats['indexes'][0]> = {}) => ({
      name,
      scans: 3,
      sizeBytes: 8192,
      unique: false,
      engineOwned: true,
      ...over
    });
    const indexes = [
      index('rows_app_task_old_0badf00d_idx'),
      index('rows_app_task_kept_0badf00d_idx'),
      index('rows_app_task_key_0badf00d_uniq', { unique: true }),
      index('rows_app_task_created_at_0badf00d_base'),
      index('hand_made', { engineOwned: false })
    ];
    const plan: IndexPlan = {
      indexes: [{ name: 'rows_app_task_kept_0badf00d_idx', keys: [], unique: false }]
    };
    const store: Store = { stats: [stats(10, indexes, 0)], plan };
    const w = world(store);
    await w.setProfile('scale');
    expect(await runAdvisorPass(w.deps)).toEqual({ upserted: 0 });
    // A day on, scans unchanged, 100 inserts a minute.
    w.tick(DAY);
    store.stats = [stats(10, indexes, 100 * 24 * 60)];
    expect(await runAdvisorPass(w.deps)).toEqual({ upserted: 1 });
    const [rec] = await w.recs();
    expect(rec).toMatchObject({
      action: 'remove',
      indexName: 'rows_app_task_old_0badf00d_idx',
      state: 'open',
      estimatedWriteCost: 'medium'
    });
    // A scan restarts its window.
    store.stats = [stats(10, [index('rows_app_task_old_0badf00d_idx', { scans: 4 })], 1e9)];
    w.tick(DAY);
    expect(await runAdvisorPass(w.deps)).toEqual({ upserted: 0 });
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
