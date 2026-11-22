/**
 * `act` over proposed types: a type proposed at runtime takes sketches at
 * once, and a field proposed later is writable and readable by sketch in the
 * same process, because each sketch compiles against the live schema. On
 * Postgres the new field is still pending (its values in the row's jsonb).
 *
 * The Postgres suite is skipped when POSTGRES_URL is absent.
 */

import { Engine, loadPlugins, MemoryEdgesStore } from '@mnmal-ai/substrate-core';
import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import { PgDataset, PgEdgesStore } from '@mnmal-ai/substrate-dataset-pg';
import { autoCrudOptionsOf } from '@mnmal-ai/substrate-sdk';
import type { Dataset, EdgesStore, RequestContext } from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONTROL_NAMESPACE } from '../src/control-plane.js';
import { createNoopPubSub, createProposalsPlugin, storageSettled } from '../src/index.js';
import { deleteNamespaces } from './_layout.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const ctx: Partial<RequestContext> = {
  identity: {
    id: 'agent-1',
    tokenId: 'agent-1',
    grants: { '*': ['substrate.propose', 'read', 'mutate'] }
  },
  headers: {},
  meta: {}
};

async function boot(ns: string, datasets: MemoryDatasetRegistry, edges: EdgesStore) {
  const datasetFor = (n: string): Dataset | undefined => datasets.get(n);
  const plugin = createProposalsPlugin({
    ownedNamespaces: [ns],
    pubsub: createNoopPubSub(),
    datasetFor
  });
  const loaded = await loadPlugins({ plugins: [plugin], edges, datasetFor });
  const engine = new Engine({
    namespaces: loaded.namespaces,
    datasets,
    edges,
    isStoredEntry: (entry) => autoCrudOptionsOf(entry.resolver) !== undefined
  });
  await loaded.runOnStart(engine);
  return engine;
}

async function propose(engine: Engine, ns: string, key: string, params: Record<string, unknown>) {
  const env = await engine.mutate({
    frame: {
      [`${ns}/${key}`]: {
        params: { ...params, proposedBy: 'agent-1', proposedReason: 'act test' },
        fields: { id: true, applied: true }
      }
    },
    ctx
  });
  expect(env.errors).toBeUndefined();
  await storageSettled();
}

async function scenario(engine: Engine, ns: string): Promise<void> {
  const act = (sketch: string) => engine.act({ sketch, namespace: ns, ctx });
  await propose(engine, ns, 'propose_type', {
    typeName: 'Widget',
    fields: { name: { kind: 'scalar', type: 'string' } }
  });
  expect(await act('create Widget name=a as $w; update Widget $w name=b')).toMatchObject({
    ok: true,
    ack: `created ${ns}/Widget #1; updated ${ns}/Widget #1`
  });

  await propose(engine, ns, 'propose_field', {
    targetType: 'Widget',
    fieldName: 'color',
    fieldSpec: { kind: 'scalar', type: 'string', nullable: true }
  });
  expect(await act('update Widget #1 color=red')).toMatchObject({
    ok: true,
    ack: `updated ${ns}/Widget #1`
  });
  expect(await act('find Widget color=red fields=name,color')).toMatchObject({
    ok: true,
    found: [{ rows: [{ shortId: 1, name: 'b', color: 'red' }] }]
  });
  expect(await act('? Widget')).toMatchObject({
    ok: true,
    help: { type: `${ns}/Widget`, fields: { color: { type: 'string?' } } }
  });
}

describe('act on proposed types', () => {
  it('takes sketches on a proposed type and a later proposed field (memory)', async () => {
    const ns = 'sandbox';
    const datasets = new MemoryDatasetRegistry();
    for (const n of [ns, CONTROL_NAMESPACE]) datasets.set(n, new MemoryDataset({ namespace: n }));
    await scenario(await boot(ns, datasets, new MemoryEdgesStore({ now: () => new Date() })), ns);
  });
});

describe.skipIf(!POSTGRES_URL)('act on proposed types (pg)', () => {
  const ns = 'kactprop';
  let sql: Sql;

  beforeAll(async () => {
    sql = postgres(POSTGRES_URL as string, { onnotice: () => {}, max: 10 });
    await deleteNamespaces(sql, ns);
  });

  afterAll(async () => {
    await storageSettled();
    await deleteNamespaces(sql, ns);
    await sql.end({ timeout: 5 });
  });

  it('takes sketches on a proposed type and a later proposed field', async () => {
    const edges = new PgEdgesStore({ sql });
    const datasets = new MemoryDatasetRegistry();
    for (const n of [ns, CONTROL_NAMESPACE]) {
      datasets.set(n, new PgDataset({ namespace: n, sql, edgesStore: edges }));
    }
    await scenario(await boot(ns, datasets, edges), ns);
  }, 60_000);
});
