/**
 * The scoped schema route carries `storage` when the dataset can describe it,
 * and `GET /substrate/v1/config` carries the storage report. Neither changes
 * `schemaVersion`.
 */

import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { defineNamespace, field } from '@mnmal-ai/substrate-sdk';
import { FastifySubstrateServer } from '@mnmal-ai/substrate-server-fastify';
import type { CoordinatorPlugin, TypeStorageReport } from '@mnmal-ai/substrate-types';
import { afterEach, describe, expect, it } from 'vitest';
import { compose } from '../src/compose.js';

const NS = 'stor';
const plugin: CoordinatorPlugin = {
  name: 'storage-fixture',
  contractVersion: '*',
  namespaces: [defineNamespace(NS, { Note: { fields: { text: field.string({ indexed: true }) } } })]
};

const REPORT: TypeStorageReport = {
  layout: 'partitioned',
  partition: 'rows__stor__note',
  indexes: [{ name: 'i', fields: ['text'], unique: false, state: 'valid', outcome: 'unchanged' }]
};

class DescribingDataset extends MemoryDataset {
  async describeStorage(): Promise<TypeStorageReport> {
    return REPORT;
  }
}

let server: FastifySubstrateServer;
afterEach(async () => {
  await server.stop({ grace: 0 });
});

async function boot(dataset: MemoryDataset, storageReport?: () => Promise<never>) {
  server = new FastifySubstrateServer();
  await compose({
    systemActor: 'test',
    server,
    dataset: new MemoryDataset({ namespace: 'default' }),
    datasets: { [NS]: dataset },
    coordinators: [plugin],
    configReport: {},
    ...(storageReport !== undefined ? { storageReport } : {})
  });
  const { address, port } = await server.start({ host: '127.0.0.1', port: 0 });
  return `http://${address}:${port}`;
}

const get = async (url: string) => (await fetch(url)).json() as Promise<Record<string, unknown>>;

describe('storage in the schema and config routes', () => {
  it('adds storage to the type schema without touching schemaVersion', async () => {
    const without = await get(
      `${await boot(new MemoryDataset({ namespace: NS }))}/substrate/v1/schema/${NS}/Note`
    );
    await server.stop({ grace: 0 });
    const withIt = await get(
      `${await boot(new DescribingDataset({ namespace: NS }))}/substrate/v1/schema/${NS}/Note`
    );
    expect(without).not.toHaveProperty('storage');
    expect(withIt.storage).toEqual(REPORT);
    expect(withIt.schemaVersion).toBe(without.schemaVersion);
  });

  it('reports storage in the config route when the binary supplies it', async () => {
    const url = await boot(
      new MemoryDataset({ namespace: NS }),
      async () =>
        ({
          layout: 'partitioned',
          warnings: ['rows__default holds 2 rows of a/b']
        }) as never
    );
    const body = await get(`${url}/substrate/v1/config`);
    expect(body.storage).toEqual({
      layout: 'partitioned',
      warnings: ['rows__default holds 2 rows of a/b']
    });
  });
});
