/**
 * Types no namespace definition declares still get their storage, wired as
 * `runServe` wires it:
 * - after compose, every registered type in every local namespace (`_system`,
 *   and install-time types such as the proposals plugin's) gets a partition,
 *   so no DEFAULT partition holds their rows;
 * - a type proposed at runtime resolves its fields from the live registry, so
 *   its `indexed` fields get indexes on its partition.
 *
 * Skipped unless POSTGRES_URL is set.
 */

import { randomUUID } from 'node:crypto';
import { compose, SYSTEM_NAMESPACE } from '@mnmal-ai/substrate-compose';
import type { Engine } from '@mnmal-ai/substrate-core';
import {
  detectLayout,
  PgDataset,
  PgEdgesStore,
  partitionName,
  runMigrations
} from '@mnmal-ai/substrate-dataset-pg';
import {
  createNoopPubSub,
  createProposalsPlugin,
  storageSettled
} from '@mnmal-ai/substrate-proposals';
import { defineNamespace } from '@mnmal-ai/substrate-sdk';
import { MemorySubstrateServer } from '@mnmal-ai/substrate-server-memory';
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
const CONTROL = '_system_proposals';

describe('reconcileDeclaredStorage', () => {
  it('refuses a declared namespace that has no dataset, naming it', async () => {
    const def = defineNamespace('kmissing', { T: { fields: {} } });
    await expect(
      reconcileDeclaredStorage(() => undefined, new Map([['kmissing', def]]))
    ).rejects.toThrow(/'kmissing'/);
  });
});

describe.skipIf(!POSTGRES_URL)('storage for registered types (pg)', () => {
  let sql: Sql;
  let partitioned: boolean;
  let ns: string;
  let engine: Engine;
  let stop: () => Promise<void>;

  beforeAll(async () => {
    sql = postgres(POSTGRES_URL as string, { onnotice: () => {} });
    await runMigrations(sql);
    partitioned = (await detectLayout(sql)) === 'partitioned';
    ns = `ksweep_${randomUUID().slice(0, 8)}`;

    const plugin = createProposalsPlugin({ ownedNamespaces: [ns], pubsub: createNoopPubSub() });
    const nsDefs = new Map(plugin.namespaces.map((d) => [d.namespace, d]));
    const engineRef: { current: Engine | null } = { current: null };
    const typeDefLookup = makeTypeDefLookupFactory(nsDefs, (n) =>
      engineRef.current?.registryFor(n)
    )(ns);
    const fieldDefLookupFor = makeFieldDefLookupFactory(nsDefs);
    const edges = new PgEdgesStore({ sql });
    const dataset = new PgDataset({ namespace: 'default', sql, edgesStore: edges, typeDefLookup });
    const datasets = buildPluginDatasetMap(
      [plugin],
      dataset,
      sql,
      edges,
      fieldDefLookupFor,
      typeDefLookup
    );
    datasets[SYSTEM_NAMESPACE] = new PgDataset({
      namespace: SYSTEM_NAMESPACE,
      sql,
      edgesStore: edges,
      typeDefLookup
    });
    // Written before boot, so it starts in the DEFAULT partition.
    await datasets[ns]?.write('TypeProposal', [{ id: randomUUID(), applied: false }]);

    const server = new MemorySubstrateServer();
    const composed = await compose({
      server,
      dataset,
      edges,
      datasets,
      coordinators: [plugin],
      systemActor: 'local-dev'
    });
    engine = composed.engine;
    engineRef.current = engine;
    await reconcileRegisteredStorage(engine, composed.datasets);
    stop = () => composed.stop();
  }, 60_000);

  afterAll(async () => {
    await storageSettled();
    await stop?.();
    await sql`DELETE FROM rows WHERE namespace IN (${ns}, ${CONTROL})`;
    await sql.end();
  });

  async function hasPartition(namespace: string, type: string): Promise<boolean> {
    const [row] = await sql<Array<{ present: boolean }>>`
      SELECT to_regclass(${partitionName(namespace, type)}) IS NOT NULL AS present`;
    return row?.present === true;
  }

  it('gives install-time and _system types partitions, leaving none of their rows in DEFAULT', async () => {
    const expected = [
      [ns, 'TypeProposal'],
      [ns, 'FieldProposal'],
      [CONTROL, 'NamespaceProposal'],
      [SYSTEM_NAMESPACE, 'Key']
    ] as const;
    for (const [n, t] of expected) {
      expect(await hasPartition(n, t), `${n}/${t}`).toBe(partitioned);
    }
    const warnings = await new PgDataset({ namespace: ns, sql }).storageWarnings();
    expect(warnings.filter((w) => w.includes(ns) || w.includes(CONTROL))).toEqual([]);
  });

  it('builds the indexed fields of a proposed type on its partition', async () => {
    const type = `Sku${randomUUID().slice(0, 8)}`;
    const env = await engine.mutate({
      frame: {
        [`${ns}/propose_type`]: {
          params: {
            typeName: type,
            fields: { sku: { kind: 'scalar', type: 'string', indexed: true } }
          },
          fields: { id: true }
        }
      },
      ctx: {
        identity: {
          id: 'agent-1',
          tokenId: 'agent-1',
          grants: { '*': ['substrate.propose', 'read', 'mutate'] }
        }
      }
    });
    expect(env.errors ?? []).toEqual([]);
    await storageSettled();
    const indexes = await sql<Array<{ indexdef: string }>>`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = current_schema() AND tablename = ${partitionName(ns, type)}`;
    expect(indexes.some((i) => i.indexdef.includes(`'sku'`))).toBe(partitioned);
  }, 20_000);
});
