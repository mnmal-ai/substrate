/**
 * The index advisor end to end on pg: reads through the engine are recorded,
 * one pass reads the store's own statistics and the reconciler's desired
 * indexes, writes one `_system/IndexRecommendation`, and the storage report
 * (what doctor reads) counts it as info, not as a warning.
 *
 * Skipped unless POSTGRES_URL is set.
 */

import { randomUUID } from 'node:crypto';
import { type ComposeResult, compose } from '@mnmal-ai/substrate-compose';
import { PgDataset, PgEdgesStore, runMigrations } from '@mnmal-ai/substrate-dataset-pg';
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
    await sql`DELETE FROM rows WHERE namespace = '_system' AND type = 'StoreProfile'`;
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
        { id: 'store', profile: 'scale', updatedReason: 'test' }
      ]);
      await sql`INSERT INTO rows (namespace, type, id, body)
        SELECT ${ns}, 'Task', gen_random_uuid()::text, jsonb_build_object('status', 'open')
        FROM generate_series(1, ${ROWS})`;
      await sql`VACUUM (ANALYZE) rows`;

      const count = (info: string[] | undefined): number =>
        Number(/^(\d+) open index recommendation/.exec(info?.[0] ?? '')?.[1] ?? 0);
      const before = count((await dataset.storageReport({ partitionBudget: 1e6 })).info);

      for (let i = 0; i < 3; i++) {
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
      expect(JSON.parse(String(rows[0]?.declarationJson))).toEqual({ fields: ['status'] });
      const evidence = JSON.parse(String(rows[0]?.evidenceJson));
      expect(evidence.count).toBe(3);
      expect(evidence.liveRows).toBeGreaterThanOrEqual(1_000);

      const report = await dataset.storageReport({ partitionBudget: 1e6 });
      expect(count(report.info)).toBe(before + 1);
      expect(report.info?.[0]).toMatch(/open index recommendations?:/);
      expect(report.warnings.filter((w) => w.includes('open index recommendation'))).toEqual([]);

      // A read the owner's derived index serves (owner, then natural order) is not recommended.
      await composed.engine.query({
        frame: {
          [`${ns}/Task`]: {
            params: { where: { owner: { eq: randomUUID() } } },
            fields: { id: true }
          }
        },
        ctx
      });
      expect(await composed.runAdvisorNow?.()).toEqual({ upserted: 0 });
    } finally {
      await composed.stop();
    }
  }, 60_000);
});
