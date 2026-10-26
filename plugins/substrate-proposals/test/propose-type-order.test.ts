/**
 * `propose_type` takes `orderedBy`, `indexes` and `expectedSize`: a new type is
 * declared with them under `substrate.propose` alone, they are stored on its
 * TypeProposal row and its registry entry, the type reads in that order, and
 * boot replays them.
 */

import { randomUUID } from 'node:crypto';
import { Engine, loadPlugins, MemoryEdgesStore } from '@mnmal-ai/substrate-core';
import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import { detectLayout, PgDataset, PgEdgesStore } from '@mnmal-ai/substrate-dataset-pg';
import { isReservedAutoCrudField } from '@mnmal-ai/substrate-sdk';
import type {
  Dataset,
  NamespaceTypeDef,
  PackEnvelope,
  RequestContext
} from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createNoopPubSub, createProposalsPlugin, storageSettled } from '../src/index.js';

const T0 = new Date('2026-10-25T00:00:00Z');
const PROPOSER: Partial<RequestContext> = {
  identity: {
    id: 'proposer',
    tokenId: 'proposer',
    grants: { '*': ['read', 'mutate', 'substrate.propose'] }
  },
  now: T0,
  headers: {},
  meta: {}
};

/** The latest engine booted per namespace, for the pg datasets' type lookup. */
const engines = new Map<string, Engine>();

async function boot(datasets: MemoryDatasetRegistry, owned: string) {
  const datasetFor = (ns: string): Dataset | undefined => datasets.get(ns);
  const plugin = createProposalsPlugin({
    ownedNamespaces: [owned],
    pubsub: createNoopPubSub(),
    datasetFor
  });
  const edges = new MemoryEdgesStore({ now: () => T0 });
  const loaded = await loadPlugins({ plugins: [plugin], datasetFor, edges });
  const engine = new Engine({ namespaces: loaded.namespaces, datasets, edges });
  engines.set(owned, engine);
  await loaded.runOnStart(engine);
  return engine;
}

/** Set to make applying a type's index options fail after validation passed. */
let failIndexApply = false;
vi.mock('../src/apply.js', async (orig) => {
  const real = await orig<typeof import('../src/apply.js')>();
  return {
    ...real,
    applyTypeIndexOptions: (...a: Parameters<typeof real.applyTypeIndexOptions>) => {
      if (failIndexApply) throw new Error('index build refused');
      return real.applyTypeIndexOptions(...a);
    }
  };
});

const code = (env: PackEnvelope): string | undefined => env.errors?.[0]?.code;

function suite(make: () => Promise<{ ns: string; datasets: MemoryDatasetRegistry }>) {
  const fields = {
    brand: { kind: 'scalar', type: 'string' },
    size: { kind: 'scalar', type: 'number' }
  };
  const propose = (engine: Engine, ns: string, typeName: string, extra: Record<string, unknown>) =>
    engine.mutate({
      frame: {
        [`${ns}/propose_type`]: {
          params: { typeName, fields, proposedReason: 'r', ...extra },
          fields: { id: true }
        }
      },
      ctx: PROPOSER
    });

  it('stores and applies orderedBy and indexes from propose_type', async () => {
    const { ns, datasets } = await make();
    const engine = await boot(datasets, ns);
    const indexes = [{ fields: ['brand', { field: 'size', dir: 'desc' }] }];
    const env = await propose(engine, ns, 'Sneaker', {
      orderedBy: { size: 'asc' },
      indexes,
      expectedSize: 'large'
    });
    expect(env.errors ?? []).toEqual([]);

    const row = (await (datasets.get(ns) as Dataset).read('TypeProposal', {})).rows[0];
    expect(row).toMatchObject({
      expectedSize: 'large',
      orderedByJson: '{"size":"asc"}',
      indexesJson: JSON.stringify(indexes)
    });
    expect(engine.registryFor(ns)?.get('Sneaker')).toMatchObject({
      indexes,
      orderedBy: { size: 'asc' },
      expectedSize: 'large'
    });

    for (const size of [3, 1, 2]) {
      const w = await engine.mutate({
        frame: { [`${ns}/createSneaker`]: { params: { brand: 'a', size }, fields: { id: true } } },
        ctx: PROPOSER
      });
      expect(w.errors ?? []).toEqual([]);
    }
    const read = await engine.query({
      frame: { [`${ns}/Sneaker`]: { params: {}, fields: { size: true } } },
      ctx: PROPOSER
    });
    const rows = (read.data?.[`${ns}/Sneaker`] ?? []) as Array<{ size: number }>;
    expect(rows.map((r) => r.size)).toEqual([1, 2, 3]);

    // A fresh engine over the same rows replays the order and indexes.
    const again = await boot(datasets, ns);
    expect(again.registryFor(ns)?.get('Sneaker')).toMatchObject({
      indexes,
      orderedBy: { size: 'asc' },
      expectedSize: 'large'
    });
    await storageSettled();
  });

  it('stores nothing extra when none is given', async () => {
    const { ns, datasets } = await make();
    const engine = await boot(datasets, ns);
    expect((await propose(engine, ns, 'Plain', {})).errors ?? []).toEqual([]);
    const row = (await (datasets.get(ns) as Dataset).read('TypeProposal', {})).rows[0];
    expect(row?.indexesJson ?? null).toBeNull();
    expect(row?.orderedByJson ?? null).toBeNull();
    expect(row?.expectedSize ?? null).toBeNull();
    await storageSettled();
  });

  it('leaves nothing behind when applying the options fails, and the name can be proposed again', async () => {
    const { ns, datasets } = await make();
    const engine = await boot(datasets, ns);
    failIndexApply = true;
    let env: PackEnvelope;
    try {
      env = await propose(engine, ns, 'Retry', { orderedBy: { size: 'asc' } });
    } finally {
      failIndexApply = false;
    }
    expect(code(env)).toBe('invalid_params');
    expect(env.errors?.[0]?.message).toContain('index build refused');
    expect(engine.registryFor(ns)?.get('Retry')).toBeUndefined();
    const left = await (datasets.get(ns) as Dataset).read('TypeProposal', {
      where: { typeName: { eq: 'Retry' } }
    });
    expect(left.rows).toEqual([]);

    const again = await propose(engine, ns, 'Retry', { orderedBy: { size: 'asc' } });
    expect(again.errors ?? []).toEqual([]);
    expect(engine.registryFor(ns)?.get('Retry')).toMatchObject({ orderedBy: { size: 'asc' } });
    await storageSettled();
  });

  it('refuses an invalid orderedBy with the SDK message', async () => {
    const { ns, datasets } = await make();
    const engine = await boot(datasets, ns);
    const env = await propose(engine, ns, 'Bad', { orderedBy: { brand: 'asc' } });
    expect(code(env)).toBe('invalid_params');
    expect(env.errors?.[0]?.message).toMatch(/orderedBy/);
    expect(engine.registryFor(ns)?.get('Bad')).toBeUndefined();
  });

  it('refuses an invalid index and an invalid expectedSize', async () => {
    const { ns, datasets } = await make();
    const engine = await boot(datasets, ns);
    expect(code(await propose(engine, ns, 'Bad', { indexes: [{ fields: ['nope'] }] }))).toBe(
      'invalid_params'
    );
    expect(code(await propose(engine, ns, 'Bad', { expectedSize: 'huge' }))).toBe('invalid_params');
    expect(engine.registryFor(ns)?.get('Bad')).toBeUndefined();
  });
}

describe('propose_type orderedBy and indexes (memory)', () => {
  suite(async () => {
    const ns = 'shopo';
    const datasets = new MemoryDatasetRegistry();
    for (const name of ['_system_proposals', '_system', ns]) {
      datasets.set(name, new MemoryDataset({ namespace: name }));
    }
    return { ns, datasets };
  });
});

const POSTGRES_URL = process.env.POSTGRES_URL;

describe.skipIf(!POSTGRES_URL)('propose_type orderedBy and indexes (pg)', () => {
  let sql: Sql;
  beforeAll(async () => {
    sql = postgres(POSTGRES_URL as string, { onnotice: () => {} });
    if ((await detectLayout(sql)) === 'absent') throw new Error('test schema is not migrated');
  });
  afterAll(async () => {
    await storageSettled();
    await sql.end();
  });

  // A fresh namespace per test, so a type proposed by one never reaches the next.
  suite(async () => {
    const ns = `ptord${randomUUID().slice(0, 8)}`;
    const edges = new PgEdgesStore({ sql });
    const datasets = new MemoryDatasetRegistry();
    // As the binary wires it: a proposed type's fields, order and indexes from its registry entry.
    const fromRegistry = (type: string): NamespaceTypeDef | undefined => {
      const e = engines.get(ns)?.registryFor(ns)?.get(type);
      if (e?.kind !== 'type') return undefined;
      return {
        fields: Object.fromEntries(
          Object.entries(e.fields).filter(([, d]) => !isReservedAutoCrudField(d))
        ),
        ...(e.orderedBy !== undefined ? { orderedBy: e.orderedBy } : {}),
        ...(e.indexes !== undefined ? { indexes: e.indexes } : {})
      };
    };
    datasets.set(
      ns,
      new PgDataset({ namespace: ns, sql, edgesStore: edges, typeDefLookup: fromRegistry })
    );
    for (const name of ['_system_proposals', '_system']) {
      datasets.set(name, new PgDataset({ namespace: name, sql, edgesStore: edges }));
    }
    return { ns, datasets };
  });
});
