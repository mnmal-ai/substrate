/**
 * Edges enlist in the pg substrate transaction.
 *
 * When the engine opens a `withScopedTransaction` tx, a `PgEdgesStore`
 * wired in via the dataset's `edgesStore` constructor option joins the SAME
 * transaction, so rollback reverts row AND edge mutations together and no
 * "row-tombstoned, edge-live" state is visible.
 */

import { Engine, type NamespaceConfig, Registry, type Resolver } from '@mnmal-ai/substrate-core';
import type { RequestContext } from '@mnmal-ai/substrate-types';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/migrate.js';
import { PgDataset } from '../src/pg-dataset.js';
import { PgEdgesStore } from '../src/pg-edges-store.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const NS = 'test_edges_enlist';

function ctxFor(ns: string): Partial<RequestContext> {
  return { namespace: ns, identity: null, headers: {}, meta: {} };
}

class StaticDatasetRegistry {
  constructor(private readonly map: Map<string, PgDataset>) {}
  get(ns: string): PgDataset | undefined {
    return this.map.get(ns);
  }
  has(ns: string): boolean {
    return this.map.has(ns);
  }
  set(ns: string, dataset: PgDataset): void {
    this.map.set(ns, dataset);
  }
}

describe.skipIf(!POSTGRES_URL)('edges enlisted in pg tx scope tx', () => {
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    if (!POSTGRES_URL) return;
    sql = postgres(POSTGRES_URL, { onnotice: () => {} });
    await runMigrations(sql);
  });

  beforeEach(async () => {
    await sql`DELETE FROM rows WHERE namespace = ${NS}`;
    await sql`DELETE FROM edges WHERE from_ns = ${NS} OR to_ns = ${NS}`;
  });

  afterAll(async () => {
    if (POSTGRES_URL) await sql.end();
  });

  it('PgEdgesStore.txScopeId matches PgDataset.txScopeId on the same Sql', () => {
    const ds = new PgDataset({ namespace: NS, sql });
    const edges = new PgEdgesStore({ sql });
    expect(edges.txScopeId).toBe(ds.txScopeId);
  });

  it('constructor throws if edgesStore txScopeId differs (wrong Sql)', () => {
    const otherSql = postgres(POSTGRES_URL!, { onnotice: () => {} });
    const foreignEdges = new PgEdgesStore({ sql: otherSql });
    expect(() => new PgDataset({ namespace: NS, sql, edgesStore: foreignEdges })).toThrow(
      /txScopeId.*does not match/
    );
    void otherSql.end();
  });

  it('withScopedTransaction yields non-null edges when edgesStore is wired', async () => {
    const edges = new PgEdgesStore({ sql });
    const ds = new PgDataset({ namespace: NS, sql, edgesStore: edges });
    let yieldedEdges: unknown = 'unset';
    await ds.withScopedTransaction!([NS], async (handles) => {
      yieldedEdges = handles.edges;
    });
    expect(yieldedEdges).not.toBeNull();
    expect(yieldedEdges).toBeInstanceOf(PgEdgesStore);
  });

  it('withScopedTransaction yields null edges when no edgesStore is wired', async () => {
    const ds = new PgDataset({ namespace: NS, sql });
    let yieldedEdges: unknown = 'unset';
    await ds.withScopedTransaction!([NS], async (handles) => {
      yieldedEdges = handles.edges;
    });
    expect(yieldedEdges).toBeNull();
  });

  it('row write + edge write roll back together when the resolver throws', async () => {
    const edges = new PgEdgesStore({ sql });
    const ds = new PgDataset({ namespace: NS, sql, edgesStore: edges });
    const reg = new Registry();

    const writeThenThrow: Resolver = async (_ctx, args) => {
      // Row mutation on the tx-bound dataset.
      await args.dataset?.write('Parent', [{ id: 'p-1', name: 'parent' }]);
      // Edge mutation on the tx-bound edges store (same pg tx).
      await args.edges?.write({
        from: { ns: NS, type: 'Child', id: 'c-1' },
        to: { ns: NS, type: 'Parent', id: 'p-1' },
        fieldName: 'parentRef',
        policy: 'cascade'
      });
      // Force a rollback.
      throw new Error('intentional');
    };
    reg.register('boom', { resolver: writeThenThrow });

    const engine = new Engine({
      namespaces: new Map<string, NamespaceConfig>([[NS, { registry: reg }]]),
      datasets: new StaticDatasetRegistry(new Map([[NS, ds]])),
      edges
    });

    await expect(
      engine.mutate({
        frame: { [`${NS}/boom`]: { params: {}, fields: { id: true } } },
        ctx: ctxFor(NS)
      })
    ).rejects.toThrow('intentional');

    // Both the row and the edge should have rolled back together.
    const { rows } = await ds.read('Parent', { limit: 10, includeDeleted: true });
    expect(rows).toHaveLength(0);
    const edgesTo = await edges.findEdgesTo({ ns: NS, type: 'Parent', id: 'p-1' });
    expect(edgesTo).toHaveLength(0);
  });

  it('successful mutate commits both row and edge together', async () => {
    const edges = new PgEdgesStore({ sql });
    const ds = new PgDataset({ namespace: NS, sql, edgesStore: edges });
    const reg = new Registry();

    const writeBoth: Resolver = async (_ctx, args) => {
      await args.dataset?.write('Parent', [{ id: 'p-1', name: 'parent' }]);
      await args.edges?.write({
        from: { ns: NS, type: 'Child', id: 'c-1' },
        to: { ns: NS, type: 'Parent', id: 'p-1' },
        fieldName: 'parentRef',
        policy: 'cascade'
      });
      return { id: 'p-1' };
    };
    reg.register('createParent', { resolver: writeBoth });

    const engine = new Engine({
      namespaces: new Map<string, NamespaceConfig>([[NS, { registry: reg }]]),
      datasets: new StaticDatasetRegistry(new Map([[NS, ds]])),
      edges
    });

    const envelope = await engine.mutate({
      frame: { [`${NS}/createParent`]: { params: {}, fields: { id: true } } },
      ctx: ctxFor(NS)
    });
    expect(envelope.errors).toBeUndefined();

    const { rows } = await ds.read('Parent', { limit: 10 });
    expect(rows.map((r) => r.id)).toEqual(['p-1']);
    const edgesTo = await edges.findEdgesTo({ ns: NS, type: 'Parent', id: 'p-1' });
    expect(edgesTo).toHaveLength(1);
    expect(edgesTo[0]?.fieldName).toBe('parentRef');
  });
});
