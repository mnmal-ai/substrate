/**
 * A proposed type that references a code-defined type, on Postgres: the same
 * write, filter and delete lifecycle as the memory suite, with the delete
 * rules enforced by the store.
 *
 * Skipped when POSTGRES_URL is absent.
 */

import { Engine, loadPlugins, MemoryBridgeRegistry, runSweep } from '@mnmal-ai/substrate-core';
import { MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import { PgDataset, PgEdgesStore } from '@mnmal-ai/substrate-dataset-pg';
import { defineNamespace, field } from '@mnmal-ai/substrate-sdk';
import type { CoordinatorPlugin, Dataset } from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { CONTROL_NAMESPACE } from '../src/control-plane.js';
import { createNoopPubSub, createProposalsPlugin, storageSettled } from '../src/index.js';
import { deleteNamespaces } from './_layout.js';
import { referenceLifecycle } from './_refs-lifecycle.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const EXT = 'krefsext';
const APP = 'krefsapp';

describe.skipIf(!POSTGRES_URL)('a reference to a code-defined type (pg)', () => {
  let sql: Sql;
  let engine: Engine;
  let sweep: () => Promise<unknown>;

  beforeAll(async () => {
    sql = postgres(POSTGRES_URL as string, { onnotice: () => {}, max: 10 });
    const edges = new PgEdgesStore({ sql });
    const datasets = new MemoryDatasetRegistry();
    for (const ns of [EXT, APP, CONTROL_NAMESPACE]) {
      datasets.set(ns, new PgDataset({ namespace: ns, sql, edgesStore: edges }));
    }
    const deps = {
      datasets,
      bridges: new MemoryBridgeRegistry(),
      edges,
      now: () => new Date(),
      metric() {}
    };
    sweep = () => runSweep(deps, { lastSweptCursor: null }, 10_000);
    const datasetFor = (ns: string): Dataset | undefined => datasets.get(ns);
    const app: CoordinatorPlugin = {
      name: 'app',
      contractVersion: '>=1.0.0-alpha.0 <2.0.0',
      namespaces: [defineNamespace(APP, { Invoice: { fields: { number: field.string() } } })]
    };
    const proposals = createProposalsPlugin({
      ownedNamespaces: [EXT],
      pubsub: createNoopPubSub(),
      datasetFor
    });
    const loaded = await loadPlugins({ plugins: [proposals, app], datasetFor, edges });
    engine = new Engine({ namespaces: loaded.namespaces, datasets, edges });
    await loaded.runOnStart(engine);
  }, 60_000);

  afterAll(async () => {
    await storageSettled();
    await deleteNamespaces(sql, EXT, APP, CONTROL_NAMESPACE);
    await sql.end({ timeout: 5 });
  });

  it('writes, filters and deletes across the reference', async () => {
    const grants = { '*': ['read', 'mutate', 'substrate.propose'] };
    const ctx = { identity: { id: 'agent', tokenId: 'agent', grants }, headers: {}, meta: {} };
    await referenceLifecycle(engine, EXT, APP, ctx, sweep);
  });
});
