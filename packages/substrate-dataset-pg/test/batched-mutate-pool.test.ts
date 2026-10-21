/**
 * A batched (array) mutate holds one pg connection: rows and edges share the
 * substrate tx, so concurrent batches as many as the pool cannot deadlock it.
 */

import { Engine, type NamespaceConfig, Registry, type Resolver } from '@mnmal-ai/substrate-core';
import { MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/migrate.js';
import { PgDataset } from '../src/pg-dataset.js';
import { PgEdgesStore } from '../src/pg-edges-store.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const NS = 'test_batched_mutate_pool';

describe.skipIf(!POSTGRES_URL)('batched mutate on a small pool (pg)', () => {
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    if (!POSTGRES_URL) return;
    sql = postgres(POSTGRES_URL, { onnotice: () => {}, max: 2 });
    await runMigrations(sql);
    await sql`DELETE FROM rows WHERE namespace = ${NS}`;
    await sql`DELETE FROM edges WHERE from_ns = ${NS}`;
  });

  afterAll(async () => {
    if (!POSTGRES_URL) return;
    await sql`DELETE FROM rows WHERE namespace = ${NS}`;
    await sql`DELETE FROM edges WHERE from_ns = ${NS}`;
    await sql.end();
  });

  it('completes as many concurrent batches as the pool has connections', async () => {
    const edges = new PgEdgesStore({ sql });
    const ds = new PgDataset({ namespace: NS, sql, edgesStore: edges });
    const registry = new Registry();
    const write: Resolver = async (_ctx, args) => {
      const id = String(args.params?.id);
      await args.dataset?.write('Item', [{ id }]);
      // An edge in the same tx, so rows and edges must share the one connection.
      await args.edges?.write({
        from: { ns: NS, type: 'Item', id },
        to: { ns: NS, type: 'Item', id: 'root' },
        fieldName: 'parent',
        policy: 'cascade'
      });
      return { id };
    };
    registry.register('writeItem', { resolver: write });
    const datasets = new MemoryDatasetRegistry();
    datasets.set(NS, ds);
    const engine = new Engine({
      namespaces: new Map<string, NamespaceConfig>([[NS, { registry }]]),
      datasets,
      edges
    });

    const batch = (n: number) =>
      engine.mutate({
        frame: {
          [`${NS}/writeItem`]: [
            { params: { id: `${n}-a` }, fields: { id: true } },
            { params: { id: `${n}-b` }, fields: { id: true } }
          ]
        },
        ctx: { identity: null }
      });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), 5000);
    });
    const done = await Promise.race([Promise.all([batch(1), batch(2)]), timeout]);
    clearTimeout(timer);

    expect(done).not.toBe('timeout');
    for (const env of done as Awaited<ReturnType<typeof batch>>[]) {
      expect(env.errors).toBeUndefined();
    }
    const [{ n }] = await sql<[{ n: number }]>`
      SELECT count(*)::int AS n FROM edges WHERE from_ns = ${NS} AND deleted_at IS NULL`;
    expect(n).toBe(4);
  });
});
