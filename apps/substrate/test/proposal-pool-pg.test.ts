/**
 * Concurrent proposals for one name hold one pg connection each, so more of
 * them than the pool has connections still complete instead of deadlocking.
 *
 * Skipped unless POSTGRES_URL is set.
 */

import { Engine, loadPlugins, type NamespaceConfig } from '@mnmal-ai/substrate-core';
import { MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import { PgDataset, PgEdgesStore, runMigrations } from '@mnmal-ai/substrate-dataset-pg';
import { createNoopPubSub, createProposalsPlugin } from '@mnmal-ai/substrate-proposals';
import type { Dataset } from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const POSTGRES_URL = process.env.POSTGRES_URL;
const NS = 'kproposalpool';

describe.skipIf(!POSTGRES_URL)('concurrent proposals on a small pool (pg)', () => {
  let sql: Sql;

  beforeAll(async () => {
    sql = postgres(POSTGRES_URL as string, { onnotice: () => {}, max: 3 });
    await runMigrations(sql);
    await sql`DELETE FROM rows WHERE namespace IN (${NS}, '_system_proposals')`;
  });

  afterAll(async () => {
    await sql`DELETE FROM rows WHERE namespace IN (${NS}, '_system_proposals')`;
    await sql.end();
  });

  it('completes more same-name propose_type calls than the pool has connections', async () => {
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

    const propose = () =>
      engine
        .mutate({
          frame: {
            [`${NS}/propose_type`]: {
              params: { typeName: 'Note', fields: { body: { kind: 'scalar', type: 'string' } } },
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
        })
        .then(
          (env) => env.errors?.[0]?.code ?? 'ok',
          (err: { code?: string }) => err.code ?? 'error'
        );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), 10_000);
    });
    const done = await Promise.race([Promise.all(Array.from({ length: 5 }, propose)), timeout]);
    clearTimeout(timer);

    expect(done).not.toBe('timeout');
    expect([...(done as string[])].sort()).toEqual([
      'ok',
      'type_already_proposed',
      'type_already_proposed',
      'type_already_proposed',
      'type_already_proposed'
    ]);
  });
});
