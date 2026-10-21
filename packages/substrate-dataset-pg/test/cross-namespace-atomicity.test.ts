/**
 * Cross-NAMESPACE atomicity on one pg substrate: a failure in namespace B
 * reverts a write already made in namespace A.
 *
 * `POST /substrate/v1/_system/keys` relies on this to land a credential
 * (`_system/Key`) and its directory row in a PLUGIN namespace (e.g.
 * `cortext/AgentIdentity`) together or not at all. Single-frame entries are
 * bucketed by `dataset.txScopeId`, and on pg every namespace is a
 * `PgDataset` over the SAME `sql` handle, so they coalesce into one
 * transaction.
 *
 * The memory substrate cannot do this and refuses such a frame outright;
 * that is pinned in `apps/substrate/test/_system-keys-route.test.ts`.
 */

import { Engine, type NamespaceConfig, Registry, type Resolver } from '@mnmal-ai/substrate-core';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/migrate.js';
import { PgDataset } from '../src/pg-dataset.js';
import { PgEdgesStore } from '../src/pg-edges-store.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const NS_A = 'test_xns_credential';
const NS_B = 'test_xns_directory';

class StaticDatasetRegistry {
  constructor(private readonly map: Map<string, PgDataset>) {}
  get(ns: string): PgDataset | undefined {
    return this.map.get(ns);
  }
  has(ns: string): boolean {
    return this.map.has(ns);
  }
}

describe.skipIf(!POSTGRES_URL)('cross-namespace atomicity on one pg tx scope', () => {
  let sql: ReturnType<typeof postgres>;
  let edges: PgEdgesStore;
  let dsA: PgDataset;
  let dsB: PgDataset;

  beforeAll(async () => {
    if (!POSTGRES_URL) return;
    sql = postgres(POSTGRES_URL, { onnotice: () => {} });
    await runMigrations(sql);
    edges = new PgEdgesStore({ sql });
    dsA = new PgDataset({ namespace: NS_A, sql, edgesStore: edges });
    dsB = new PgDataset({ namespace: NS_B, sql, edgesStore: edges });
  });

  beforeEach(async () => {
    await sql`DELETE FROM rows WHERE namespace IN (${NS_A}, ${NS_B})`;
  });

  afterAll(async () => {
    if (POSTGRES_URL) await sql.end();
  });

  /** Engine over both namespaces; `dirResolver` decides how the directory behaves. */
  function mkEngine(dirResolver: Resolver): Engine {
    const regA = new Registry();
    const regB = new Registry();
    const writeCredential: Resolver = async (_ctx, args) => {
      await args.dataset?.write('Credential', [{ id: 'cred-1', kid: 'agent@Host' }]);
      return null;
    };
    regA.register('createCredential', { resolver: writeCredential });
    regB.register('createDirectory', { resolver: dirResolver });
    return new Engine({
      namespaces: new Map<string, NamespaceConfig>([
        [NS_A, { registry: regA }],
        [NS_B, { registry: regB }]
      ]),
      datasets: new StaticDatasetRegistry(
        new Map([
          [NS_A, dsA],
          [NS_B, dsB]
        ])
      ) as never,
      edges
    });
  }

  const bothFrame = {
    [`${NS_A}/createCredential`]: { params: {}, fields: { id: true } },
    [`${NS_B}/createDirectory`]: { params: {}, fields: { id: true } }
  };

  async function credentialRows(): Promise<number> {
    const { rows } = await dsA.read('Credential', { where: { kid: { eq: 'agent@Host' } } });
    return rows.length;
  }

  it('the two namespaces share one txScopeId — the precondition for coalescing', () => {
    expect(dsA.txScopeId).toBe(dsB.txScopeId);
    expect(dsA.withScopedTransaction).toBeTypeOf('function');
  });

  it('commits both namespaces from ONE frame', async () => {
    const engine = mkEngine(async (_ctx, args) => {
      await args.dataset?.write('Directory', [{ id: 'dir-1', kid: 'agent@Host' }]);
      return null;
    });
    const envelope = await engine.mutate({
      frame: bothFrame,
      ctx: { identity: null, headers: {}, meta: {} }
    });
    expect(envelope.errors ?? []).toEqual([]);
    expect(await credentialRows()).toBe(1);
    const { rows: dirRows } = await dsB.read('Directory', { where: { kid: { eq: 'agent@Host' } } });
    expect(dirRows).toHaveLength(1);
  });

  it('rolls the CREDENTIAL back when the DIRECTORY write throws', async () => {
    // THE guarantee the keys route sells: a throw in namespace B reverts the
    // already-written row in namespace A, so the route cannot leave a
    // credential without its directory entry.
    const engine = mkEngine(async (_ctx, args) => {
      await args.dataset?.write('Directory', [{ id: 'dir-2', kid: 'agent@Host' }]);
      throw new Error('directory write failed');
    });
    await expect(
      engine.mutate({ frame: bothFrame, ctx: { identity: null, headers: {}, meta: {} } })
    ).rejects.toThrow(/directory write failed/);

    // Not a half identity:
    expect(await credentialRows()).toBe(0);
    const { rows: dirRows } = await dsB.read('Directory', { where: { kid: { eq: 'agent@Host' } } });
    expect(dirRows).toHaveLength(0);
  });
});
