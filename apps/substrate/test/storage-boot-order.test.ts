/**
 * Declared storage (type partitions and declared indexes) is reconciled before
 * any kernel migration runs, so a migration can rely on it, and a unique index
 * that cannot be built fails the boot.
 *
 * Driven through `composeKernelPhase`, the step of `runServe` that runs kernel
 * migrations. Each test has a short timeout: index builds run CONCURRENTLY,
 * which waits forever on a transaction this process holds open.
 *
 * Skipped unless POSTGRES_URL is set.
 */

import { randomUUID } from 'node:crypto';
import {
  detectLayout,
  PgDataset,
  PgEdgesStore,
  partitionName,
  runMigrations
} from '@mnmal-ai/substrate-dataset-pg';
import { defineNamespace } from '@mnmal-ai/substrate-sdk';
import type {
  CoordinatorPlugin,
  KernelPlugin,
  NamespaceDefinition,
  SubstrateServer
} from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { composeKernelPhase } from '../src/serve/plugins.js';
import {
  buildPluginDatasetMap,
  ensureMigrationsTable,
  makeFieldDefLookupFactory
} from '../src/serve/wiring.js';

const POSTGRES_URL = process.env.POSTGRES_URL;

/** A fresh namespace per test, so its partition and index do not exist yet. */
function coordinator(): {
  ns: string;
  index: string;
  def: NamespaceDefinition;
  plugin: CoordinatorPlugin;
} {
  const ns = `kbootorder_${randomUUID().slice(0, 8)}`;
  const index = `${ns}_member_kid_uq`;
  const def = defineNamespace(ns, {
    Member: {
      fields: { kid: { kind: 'scalar', type: 'string' } },
      indexes: [{ fields: ['kid'], unique: true, where: 'live', name: index }]
    }
  });
  return { ns, index, def, plugin: { name: ns, contractVersion: '*', namespaces: [def] } };
}

describe.skipIf(!POSTGRES_URL)('declared storage at boot (pg)', () => {
  let sql: Sql;
  let partitioned: boolean;

  beforeAll(async () => {
    sql = postgres(POSTGRES_URL as string, { onnotice: () => {} });
    await runMigrations(sql);
    await ensureMigrationsTable(sql);
    partitioned = (await detectLayout(sql)) === 'partitioned';
  });

  afterAll(async () => {
    await sql`DELETE FROM rows WHERE namespace LIKE 'kbootorder\_%'`;
    await sql.end();
  });

  /** Runs the kernel phase with one kernel plugin whose migration records what it saw. */
  async function bootKernel(
    c: ReturnType<typeof coordinator>
  ): Promise<{ indexTable: string | null } | undefined> {
    let seen: { indexTable: string | null } | undefined;
    const probe: KernelPlugin = {
      name: `${c.ns}-probe`,
      contractVersion: '*',
      migrations: [
        {
          id: randomUUID(),
          async apply() {
            const [row] = await sql<Array<{ tablename: string }>>`
              SELECT tablename FROM pg_indexes
              WHERE schemaname = current_schema() AND indexname = ${c.index}`;
            seen = { indexTable: row?.tablename ?? null };
          }
        }
      ]
    };
    const nsDefs = new Map([[c.ns, c.def]]);
    const datasets = buildPluginDatasetMap(
      [c.plugin],
      new PgDataset({ namespace: 'default', sql }),
      sql,
      new PgEdgesStore({ sql }),
      makeFieldDefLookupFactory(nsDefs)
    );
    await composeKernelPhase({
      kernel: [probe],
      server: {} as SubstrateServer,
      storeSql: sql,
      coordinators: [c.plugin],
      kernelAuth: null,
      trustedProxies: new Set(),
      datasetFor: (ns) => datasets[ns],
      nsDefs
    });
    return seen;
  }

  it('builds the declared unique index before a kernel migration runs', async () => {
    const c = coordinator();
    const seen = await bootKernel(c);
    expect(seen).toEqual({
      indexTable: partitioned ? partitionName(c.ns, 'Member') : 'rows'
    });
  }, 20_000);

  it('fails the boot naming the duplicates when the unique index cannot be built', async () => {
    const c = coordinator();
    const ds = new PgDataset({ namespace: c.ns, sql });
    await ds.write('Member', [
      { id: 'a', kid: 'dup' },
      { id: 'b', kid: 'dup' }
    ]);
    await expect(bootKernel(c)).rejects.toMatchObject({
      code: 'unique_index_duplicates',
      namespace: c.ns,
      type: 'Member',
      fields: ['kid']
    });
  }, 20_000);
});
