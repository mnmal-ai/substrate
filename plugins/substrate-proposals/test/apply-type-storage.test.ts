/**
 * An applied type proposal gets storage of its own: `ensureTypeStorage` runs
 * on the namespace's base dataset once the proposal's transaction has
 * committed, never inside it, in the background so the response does not
 * wait on it, and a failure there never fails the proposal.
 *
 * The pg tests have short timeouts: index builds run CONCURRENTLY, which waits
 * forever on a transaction this process holds open.
 */

import { randomUUID } from 'node:crypto';
import { Engine, loadPlugins, MemoryEdgesStore, Registry } from '@mnmal-ai/substrate-core';
import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import {
  detectLayout,
  PgDataset,
  PgEdgesStore,
  partitionName
} from '@mnmal-ai/substrate-dataset-pg';
import type {
  AfterTxWork,
  Dataset,
  NamespaceConfig,
  RequestContext,
  ResolverArgs
} from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createNoopPubSub } from '../src/config.js';
import { createProposalsPlugin, storageSettled } from '../src/index.js';
import { makeProposeTypeResolver } from '../src/propose-type-resolver.js';
import { RegistryStore } from '../src/registry-store.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const NS = 'kapplystorage';
const CTX: RequestContext = {
  identity: { id: 'agent-1', tokenId: 'agent-1', grants: { [NS]: ['substrate.propose'] } },
  namespace: NS,
  operation: 'mutate',
  now: new Date(),
  headers: {},
  meta: {}
};
function proposal(typeName = 'Dress'): Record<string, unknown> {
  return { typeName, fields: { name: { kind: 'scalar', type: 'string' } } };
}

/** A propose_type resolver over `dataset`, as the plugin wires it for a static namespace. */
function proposeType(dataset: Dataset) {
  const registry = new Registry();
  const edges = new MemoryEdgesStore({ now: () => new Date() });
  const registryStore = new RegistryStore();
  registryStore.set(NS, { registry, dataset, edges });
  return makeProposeTypeResolver({
    namespace: NS,
    ownedNamespaces: new Set([NS]),
    registryStore,
    dataset,
    edges,
    pubsub: createNoopPubSub(),
    channelFor: (ns) => `substrate_proposals_${ns}`
  });
}

/** Resolver args whose after-commit work is held until the test settles it. */
function heldTx(typeName?: string): {
  args: ResolverArgs;
  settle: (committed: boolean) => Promise<void>;
} {
  const work: AfterTxWork[] = [];
  return {
    args: { params: proposal(typeName), afterTx: (fn) => work.push(fn) },
    settle: async (committed) => {
      for (const fn of work) await fn({ committed });
    }
  };
}

describe('propose_type prepares the type storage after commit', () => {
  class Recording extends MemoryDataset {
    calls: string[] = [];
    fail: Error | undefined;
    hold: Promise<void> | undefined;
    async ensureTypeStorage(type: string): Promise<void> {
      this.calls.push(type);
      await this.hold;
      if (this.fail !== undefined) throw this.fail;
    }
  }

  it('runs only once the transaction commits', async () => {
    const dataset = new Recording({ namespace: NS });
    const { args, settle } = heldTx();
    await proposeType(dataset)(CTX, args);
    expect(dataset.calls).toEqual([]);
    await settle(true);
    await storageSettled();
    expect(dataset.calls).toEqual(['Dress']);
  });

  it('does not hold the response while storage is prepared', async () => {
    const dataset = new Recording({ namespace: NS });
    let release = (): void => {};
    dataset.hold = new Promise((resolve) => {
      release = resolve;
    });
    const { args, settle } = heldTx();
    const row = await proposeType(dataset)(CTX, args);
    await settle(true);
    expect(row.applied).toBe(true);
    expect(dataset.calls).toEqual(['Dress']);
    let settled = false;
    const done = storageSettled().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await done;
  });

  it('does not run when the transaction rolls back', async () => {
    const dataset = new Recording({ namespace: NS });
    const { args, settle } = heldTx();
    await proposeType(dataset)(CTX, args);
    await settle(false);
    expect(dataset.calls).toEqual([]);
  });

  it('a storage failure leaves the proposal applied', async () => {
    const dataset = new Recording({ namespace: NS });
    dataset.fail = new Error('locks stayed busy');
    const row = await proposeType(dataset)(CTX, { params: proposal() });
    await storageSettled();
    expect(row.applied).toBe(true);
    expect(dataset.calls).toEqual(['Dress']);
  });
});

describe.skipIf(!POSTGRES_URL)('propose_type storage (pg)', () => {
  let sql: Sql;
  let partitioned: boolean;
  let typeName: string;

  beforeAll(async () => {
    sql = postgres(POSTGRES_URL as string, { onnotice: () => {} });
    // Migrated once in _global-setup.ts.
    partitioned = (await detectLayout(sql)) === 'partitioned';
  });

  afterAll(async () => {
    await sql.end();
  });

  beforeEach(async () => {
    await sql`DELETE FROM rows WHERE namespace IN (${NS}, '_system_proposals')`;
    // Partitions cannot be dropped under the short_ids FK, so each test proposes a type of its own.
    typeName = `Dress${randomUUID().slice(0, 8)}`;
  });

  async function partitionCount(): Promise<number | null> {
    if (!partitioned) return null;
    const [row] = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM ${sql(partitionName(NS, typeName))}`;
    return row?.n ?? 0;
  }

  async function liveCount(): Promise<number> {
    const [row] = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM rows WHERE namespace = ${NS} AND type = ${typeName}`;
    return row?.n ?? 0;
  }

  it('moves a row written between apply and commit into the new partition', async () => {
    const dataset = new PgDataset({ namespace: NS, sql });
    const { args, settle } = heldTx(typeName);
    await proposeType(dataset)(CTX, args);
    await dataset.write(typeName, [{ id: 'd1', name: 'early' }]);
    await settle(true);
    await storageSettled();
    expect(await liveCount()).toBe(1);
    expect(await partitionCount()).toBe(partitioned ? 1 : null);
  }, 20_000);

  it('through the engine, a row written as the mutation returns ends in the new partition', async () => {
    const edges = new PgEdgesStore({ sql });
    const datasets = new MemoryDatasetRegistry();
    for (const ns of [NS, '_system_proposals']) {
      datasets.set(ns, new PgDataset({ namespace: ns, sql, edgesStore: edges }));
    }
    const datasetFor = (ns: string): Dataset | undefined => datasets.get(ns);
    const plugin = createProposalsPlugin({
      ownedNamespaces: [NS],
      pubsub: createNoopPubSub(),
      datasetFor
    });
    const loaded = await loadPlugins({ plugins: [plugin], edges, datasetFor });
    const engine = new Engine({
      namespaces: new Map<string, NamespaceConfig>(loaded.namespaces),
      datasets,
      edges
    });
    await loaded.runOnStart(engine);

    const env = await engine.mutate({
      frame: { [`${NS}/propose_type`]: { params: proposal(typeName), fields: { id: true } } },
      ctx: {
        identity: {
          id: 'agent-1',
          tokenId: 'agent-1',
          grants: { '*': ['substrate.propose', 'read', 'mutate'] }
        }
      }
    });
    expect(env.errors ?? []).toEqual([]);
    await datasets.get(NS)?.write(typeName, [{ id: 'd1', name: 'late' }]);
    await storageSettled();
    expect(await liveCount()).toBe(1);
    expect(await partitionCount()).toBe(partitioned ? 1 : null);
  }, 20_000);
});
