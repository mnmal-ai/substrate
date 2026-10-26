/**
 * The index advisor end to end on pg: reads through the engine are recorded,
 * one pass reads the store's own statistics and the reconciler's desired
 * indexes, writes one `_system/IndexRecommendation`, and the storage report
 * (what doctor reads) counts it as info, not as a warning.
 *
 * Skipped unless POSTGRES_URL is set.
 */

import { randomUUID } from 'node:crypto';
import {
  type ComposeResult,
  compose,
  runAdvisorPass,
  STORE_PROFILE_ID
} from '@mnmal-ai/substrate-compose';
import { ShapeRecorder } from '@mnmal-ai/substrate-core';
import { PgDataset, PgEdgesStore, runMigrations } from '@mnmal-ai/substrate-dataset-pg';
import {
  createNoopPubSub,
  createProposalsPlugin,
  storageSettled
} from '@mnmal-ai/substrate-proposals';
import { defineNamespace } from '@mnmal-ai/substrate-sdk';
import { MemorySubstrateServer } from '@mnmal-ai/substrate-server-memory';
import type { FieldDef, RequestContext } from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildPluginDatasetMap,
  makeFieldDefLookupFactory,
  makeTypeDefLookupFactory,
  reconcileDeclaredStorage,
  reconcileRegisteredStorage
} from '../src/serve/wiring.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const ROWS = 3_000;
const ctx: Partial<RequestContext> = {
  identity: { kind: 'system', id: 'test', grants: { '*': ['read', 'mutate'] } }
};

describe.skipIf(!POSTGRES_URL)('index advisor (pg)', () => {
  let sql: Sql;
  const ns = `kadvisor_${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    sql = postgres(POSTGRES_URL as string, { onnotice: () => {} });
    await runMigrations(sql);
  });

  afterAll(async () => {
    await sql`DELETE FROM rows WHERE namespace = ${ns}`;
    await sql`DELETE FROM rows WHERE namespace = '_system' AND type = 'IndexRecommendation'
      AND body->>'namespace' = ${ns}`;
    await sql`DELETE FROM rows WHERE namespace = '_system' AND type IN ('StoreProfile', 'AdvisorState')`;
    await sql.end();
  });

  it('records a slow unserved read, recommends an index, and reports it as info', async () => {
    const def = defineNamespace(ns, {
      Task: {
        fields: {
          status: { kind: 'scalar', type: 'string' },
          owner: { kind: 'crossRef', ns, type: 'Task' } as FieldDef
        },
        expectedSize: 'large'
      }
    });
    const plugin = { name: ns, contractVersion: '*', namespaces: [def] };
    const nsDefs = new Map([[ns, def]]);
    let composed: ComposeResult | undefined;
    const typeDefLookup = makeTypeDefLookupFactory(nsDefs, (n) => composed?.engine.registryFor(n))(
      ns
    );
    const edges = new PgEdgesStore({ sql });
    const dataset = new PgDataset({ namespace: 'default', sql, edgesStore: edges, typeDefLookup });
    const datasets = buildPluginDatasetMap(
      [plugin],
      dataset,
      sql,
      edges,
      makeFieldDefLookupFactory(nsDefs),
      typeDefLookup
    );
    datasets._system = new PgDataset({
      namespace: '_system',
      sql,
      edgesStore: edges,
      typeDefLookup
    });
    await reconcileDeclaredStorage((n) => datasets[n], nsDefs);

    // Every read of the type takes at least 60 ms: slow for the `scale` profile (50 ms).
    const tasks = datasets[ns] as PgDataset;
    const read = tasks.read.bind(tasks);
    tasks.read = async (...args) => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return read(...args);
    };

    composed = await compose({
      server: new MemorySubstrateServer(),
      dataset,
      edges,
      datasets,
      coordinators: [plugin],
      systemActor: 'local-dev',
      advisor: { intervalMs: 3_600_000, storeProfile: 'scale' }
    });
    try {
      await reconcileRegisteredStorage(composed.engine, composed.datasets, nsDefs);
      // The seed is insert-only, and an earlier suite in this schema may have seeded the row.
      await (datasets._system as PgDataset).write('StoreProfile', [
        { id: STORE_PROFILE_ID, profile: 'scale', updatedReason: 'test' }
      ]);
      await sql`INSERT INTO rows (namespace, type, id, body)
        SELECT ${ns}, 'Task', gen_random_uuid()::text, jsonb_build_object('status', 'open')
        FROM generate_series(1, ${ROWS})`;
      await sql`VACUUM (ANALYZE) rows`;

      const count = (info: string[] | undefined): number =>
        Number(/^(\d+) open index recommendation/.exec(info?.[0] ?? '')?.[1] ?? 0);
      const before = count((await dataset.storageReport({ partitionBudget: 1e6 })).info);

      // The scale profile's minReads.
      for (let i = 0; i < 20; i++) {
        const env = await composed.engine.query({
          frame: {
            [`${ns}/Task`]: {
              params: { where: { status: { eq: 'open' } }, limit: 5 },
              fields: { id: true }
            }
          },
          ctx
        });
        expect(env.errors ?? []).toEqual([]);
      }
      expect(await composed.runAdvisorNow?.()).toEqual({ upserted: 1 });

      const { rows } = await (datasets._system as PgDataset).read('IndexRecommendation', {
        where: { namespace: { eq: ns } }
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ type: 'Task', action: 'add', state: 'open' });
      expect(JSON.parse(String(rows[0]?.declarationJson))).toEqual({
        fields: ['status', { field: 'createdAt', dir: 'desc' }]
      });
      const evidence = JSON.parse(String(rows[0]?.evidenceJson));
      expect(evidence.count).toBe(20);
      expect(evidence.liveRows).toBeGreaterThanOrEqual(1_000);

      const report = await dataset.storageReport({ partitionBudget: 1e6 });
      expect(count(report.info)).toBe(before + 1);
      expect(report.info?.[0]).toMatch(/open index recommendations?:/);
      expect(report.warnings.filter((w) => w.includes('open index recommendation'))).toEqual([]);

      // Served reads are not recommended: one the owner's derived index serves
      // (owner, then natural order), and one in natural order alone, which the
      // shared order index serves on legacy and the type's base index on partitioned.
      const reads = async (where: Record<string, unknown> | undefined) => {
        for (let i = 0; i < 20; i++) {
          await composed?.engine.query({
            frame: {
              [`${ns}/Task`]: {
                params: { ...(where ? { where } : {}), limit: 5 },
                fields: { id: true }
              }
            },
            ctx
          });
        }
      };
      await reads({ owner: { eq: randomUUID() } });
      await reads(undefined);
      expect(await composed.runAdvisorNow?.()).toEqual({ upserted: 0 });
    } finally {
      await composed.stop();
    }
  }, 60_000);

  it("advises on a proposed type declaring expectedSize 'large' at a size it would not otherwise", async () => {
    const pns = `${ns}_hint`;
    const plugin = createProposalsPlugin({ ownedNamespaces: [pns], pubsub: createNoopPubSub() });
    const nsDefs = new Map(plugin.namespaces.map((d) => [d.namespace, d]));
    let composed: ComposeResult | undefined;
    const typeDefLookup = makeTypeDefLookupFactory(nsDefs, (n) => composed?.engine.registryFor(n))(
      pns
    );
    const edges = new PgEdgesStore({ sql });
    const dataset = new PgDataset({ namespace: 'default', sql, edgesStore: edges, typeDefLookup });
    const datasets = buildPluginDatasetMap(
      [plugin],
      dataset,
      sql,
      edges,
      makeFieldDefLookupFactory(nsDefs),
      typeDefLookup
    );
    const system = new PgDataset({ namespace: '_system', sql, edgesStore: edges, typeDefLookup });
    datasets._system = system;
    composed = await compose({
      server: new MemorySubstrateServer(),
      dataset,
      edges,
      datasets,
      coordinators: [plugin],
      systemActor: 'local-dev'
    });
    try {
      await reconcileRegisteredStorage(composed.engine, composed.datasets, nsDefs);
      await system.write('StoreProfile', [
        { id: STORE_PROFILE_ID, profile: 'scale', updatedReason: 'test' }
      ]);
      const proposer: Partial<RequestContext> = {
        identity: {
          kind: 'system',
          id: 'test',
          grants: { '*': ['read', 'mutate', 'substrate.propose'] }
        }
      };
      for (const [typeName, extra] of [
        ['Big', { expectedSize: 'large' }],
        ['Plain', {}]
      ] as const) {
        const env = await composed.engine.mutate({
          frame: {
            [`${pns}/propose_type`]: {
              params: {
                typeName,
                fields: { status: { kind: 'scalar', type: 'string' } },
                proposedReason: 'r',
                ...extra
              },
              fields: { id: true }
            }
          },
          ctx: proposer
        });
        expect(env.errors ?? []).toEqual([]);
        await sql`INSERT INTO rows (namespace, type, id, body)
          SELECT ${pns}, ${typeName}, gen_random_uuid()::text, jsonb_build_object('status', 'open')
          FROM generate_series(1, ${ROWS})`;
      }
      await storageSettled();
      await sql`VACUUM (ANALYZE) rows`;

      // The same slow, unserved read on each, the scale profile's minReads times.
      const recorder = new ShapeRecorder();
      for (const type of ['Big', 'Plain']) {
        for (let i = 0; i < 20; i++) {
          recorder.observe(
            {
              namespace: pns,
              type,
              filters: [{ field: 'status', op: 'eq' }],
              orderBy: [['createdAt', 'desc']]
            },
            80
          );
        }
      }
      expect(
        await runAdvisorPass({
          dataset: datasets[pns] as PgDataset,
          system,
          recorder,
          registry: (n) => composed?.engine.registryFor(n),
          now: Date.now
        })
      ).toEqual({ upserted: 1 });
      const { rows } = await system.read('IndexRecommendation', {
        where: { namespace: { eq: pns } }
      });
      // 3,000 rows: over the scale profile's large-hint minimum (1,000), under its 20,000.
      expect(rows.map((r) => [r.type, r.action])).toEqual([['Big', 'add']]);
    } finally {
      await storageSettled();
      await composed.stop();
      await sql`DELETE FROM rows WHERE namespace IN (${pns}, '_system_proposals')`;
      await sql`DELETE FROM rows WHERE namespace = '_system' AND type = 'IndexRecommendation'
        AND body->>'namespace' = ${pns}`;
    }
  }, 60_000);

  it('recommends remove for a retracted index once its persisted first sighting is a window old', async () => {
    const DAY = 24 * 60 * 60 * 1000;
    const rns = `${ns}_rm`;
    const fields: { current: Record<string, FieldDef> } = {
      current: { status: { kind: 'scalar', type: 'string', indexed: true } }
    };
    const lookup = (type: string, namespace: string) =>
      namespace === rns && type === 'Task' ? { fields: fields.current } : undefined;
    const ds = new PgDataset({ namespace: rns, sql, typeDefLookup: lookup });
    const system = new PgDataset({ namespace: '_system', sql });
    await ds.ensureTypeStorage('Task');
    // A few rows, so the type is known from the first pass (an empty legacy type is not).
    await ds.write(
      'Task',
      Array.from({ length: 10 }, () => ({ id: randomUUID(), status: 'open' }))
    );
    await sql`ANALYZE rows`;
    // Retracted: no longer declared, so outside the desired set, and never scanned.
    fields.current = { status: { kind: 'scalar', type: 'string' } };
    // Scale, and no baseline left by an earlier suite.
    await system.write('StoreProfile', [
      { id: STORE_PROFILE_ID, profile: 'scale', updatedReason: 'test' }
    ]);
    await sql`DELETE FROM rows WHERE namespace = '_system' AND type = 'AdvisorState'`;
    // Meant for a database whose statistics were never reset, as the test database's.
    const [db] = await sql<Array<{ reset: Date | null }>>`
      SELECT stats_reset AS reset FROM pg_stat_database WHERE datname = current_database()`;
    expect(db).toBeDefined();

    let now = Date.now();
    const deps = {
      dataset: ds,
      system,
      recorder: new ShapeRecorder(),
      registry: () => undefined,
      now: () => now
    };
    const removes = async () =>
      (
        await system.read('IndexRecommendation', {
          where: { namespace: { eq: rns }, action: { eq: 'remove' } }
        })
      ).rows;
    expect(await runAdvisorPass(deps)).toEqual({ upserted: 0 });

    // 30,000 writes, flushed to the statistics; then half a window, then a whole one, by the injected clock.
    const conn = await sql.reserve();
    try {
      await conn`INSERT INTO rows (namespace, type, id, body)
        SELECT ${rns}, 'Task', gen_random_uuid()::text, jsonb_build_object('status', 'open')
        FROM generate_series(1, 30000)`;
      await conn`SELECT pg_stat_force_next_flush()`;
    } finally {
      conn.release();
    }
    await sql`ANALYZE rows`;
    now += DAY / 2;
    expect(await runAdvisorPass(deps)).toEqual({ upserted: 0 });
    expect(await removes()).toEqual([]);
    now += DAY / 2;
    expect(await runAdvisorPass(deps)).toEqual({ upserted: 1 });
    const [rec] = await removes();
    expect(rec).toMatchObject({ state: 'open', type: 'Task' });
    expect(String(rec?.indexName)).toMatch(/_status_[0-9a-f]{8}_idx$/);
    await sql`DELETE FROM rows WHERE namespace = ${rns}`;
    await sql`DELETE FROM rows WHERE namespace = '_system' AND type = 'IndexRecommendation'
      AND body->>'namespace' = ${rns}`;
  }, 60_000);
});
