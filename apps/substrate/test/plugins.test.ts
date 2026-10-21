import { type ComposeResult, compose } from '@mnmal-ai/substrate-compose';
import { PluginNamespaceCollision } from '@mnmal-ai/substrate-core';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { installAutoCrud } from '@mnmal-ai/substrate-sdk';
import { MemorySubstrateServer } from '@mnmal-ai/substrate-server-memory';
import type {
  CoordinatorPlugin,
  PackEnvelope,
  Schema,
  SubstrateResponse
} from '@mnmal-ai/substrate-types';
import { afterEach, describe, expect, it } from 'vitest';
import { fixturePlugin } from './_fixtures/fixture-plugin.js';

function bodyToString(res: SubstrateResponse): string {
  const b = res.body;
  if (b === undefined || b === null) return '';
  if (typeof b === 'string') return b;
  if (Buffer.isBuffer(b)) return b.toString('utf8');
  if (b instanceof Uint8Array) return Buffer.from(b).toString('utf8');
  return '';
}

function jsonBody<T>(res: SubstrateResponse): T {
  return JSON.parse(bodyToString(res)) as T;
}

function factsPlugin(): CoordinatorPlugin {
  return {
    name: 'facts',
    contractVersion: '*',
    namespaces: [
      {
        namespace: 'facts',
        install: (ctx): void => {
          installAutoCrud(ctx.registry, 'Fact', ctx.dataset, ctx.edges, {
            fields: {
              id: { kind: 'scalar', type: 'string', indexed: true },
              body: { kind: 'scalar', type: 'string', indexed: true }
            }
          });
        }
      }
    ]
  };
}

describe('coordinator plugin seam', () => {
  let composed: ComposeResult | null = null;

  afterEach(async () => {
    if (composed !== null) {
      await composed.stop();
      composed = null;
    }
  });

  it('fixturePlugin round-trips Todo + Tag through the same surface as the hard-coded path', async () => {
    const server = new MemorySubstrateServer();
    const dataset = new MemoryDataset({ namespace: 'default' });
    composed = await compose({
      // Auth is off, so the deployment must declare who it writes as.
      systemActor: 'test',
      server,
      dataset,
      coordinators: [fixturePlugin]
    });
    await server.start();

    const schemaRes = await server.inject({ method: 'GET', path: '/substrate/v1/schema' });
    expect(schemaRes.status).toBe(200);
    const schema = jsonBody<Schema>(schemaRes);
    expect(schema.types.Todo).toBeDefined();
    expect(schema.types.Tag).toBeDefined();
    expect(schema.mutations.createTodo).toBeDefined();
    expect(schema.mutations.createTag).toBeDefined();

    const createRes = await server.inject({
      method: 'POST',
      path: '/substrate/v1/mutate',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(
        JSON.stringify({
          'default/createTodo': {
            params: { title: 'from plugin', done: false },
            fields: { id: true, title: true }
          }
        })
      )
    });
    expect(createRes.status).toBe(200);
    const createEnv = jsonBody<PackEnvelope>(createRes);
    const created = createEnv.data['default/createTodo'] as { id: string; title: string };
    expect(created.title).toBe('from plugin');
    expect(typeof created.id).toBe('string');

    const listRes = await server.inject({
      method: 'POST',
      path: '/substrate/v1/query',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(
        JSON.stringify({
          'default/Todo': { params: {}, fields: { id: true, title: true } }
        })
      )
    });
    const listEnv = jsonBody<PackEnvelope>(listRes);
    expect(listEnv.data['default/Todo']).toHaveLength(1);
  });

  it('two plugins contribute distinct namespaces that a multi-key frame reads together', async () => {
    const server = new MemorySubstrateServer();
    const defaultDataset = new MemoryDataset({ namespace: 'default' });
    const factsDataset = new MemoryDataset({ namespace: 'facts' });

    composed = await compose({
      // Auth is off, so the deployment must declare who it writes as.
      systemActor: 'test',
      server,
      dataset: defaultDataset,
      datasets: { facts: factsDataset },
      coordinators: [fixturePlugin, factsPlugin()]
    });
    await server.start();

    const federatedRes = await server.inject({
      method: 'GET',
      path: '/substrate/v1/federated-schema'
    });
    const federated = jsonBody<Record<string, Schema>>(federatedRes);
    // `_system` is always mounted alongside coordinator-contributed namespaces.
    expect(Object.keys(federated).sort()).toEqual(['_system', 'default', 'facts']);
    expect(federated.default?.types.Todo).toBeDefined();
    expect(federated.facts?.types.Fact).toBeDefined();

    await server.inject({
      method: 'POST',
      path: '/substrate/v1/mutate',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(
        JSON.stringify({
          'default/createTodo': {
            params: { title: 'mixed', done: false },
            fields: { id: true }
          }
        })
      )
    });
    await server.inject({
      method: 'POST',
      path: '/substrate/v1/mutate',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(
        JSON.stringify({
          'facts/createFact': {
            params: { body: 'substrate is typed' },
            fields: { id: true }
          }
        })
      )
    });

    const mixed = await server.inject({
      method: 'POST',
      path: '/substrate/v1/query',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(
        JSON.stringify({
          'default/Todo': { params: {}, fields: { id: true, title: true } },
          'facts/Fact': { params: {}, fields: { id: true, body: true } }
        })
      )
    });
    const env = jsonBody<PackEnvelope>(mixed);
    expect(env.errors).toBeUndefined();
    expect(env.data['default/Todo']).toHaveLength(1);
    expect(env.data['facts/Fact']).toHaveLength(1);
  });

  it('two plugins claiming the same namespace throw PluginNamespaceCollision', async () => {
    const server = new MemorySubstrateServer();
    const dataset = new MemoryDataset({ namespace: 'default' });
    const shadow: CoordinatorPlugin = {
      name: 'shadow',
      contractVersion: '*',
      namespaces: [
        {
          namespace: 'default',
          install: (): void => undefined
        }
      ]
    };

    await expect(
      compose({
        // Auth is off, so the deployment must declare who it writes as.
        systemActor: 'test',
        server,
        dataset,
        coordinators: [fixturePlugin, shadow]
      })
    ).rejects.toBeInstanceOf(PluginNamespaceCollision);
    await server.stop();
  });

  it('auto-allocates a sibling dataset when a coordinator claims a namespace not in datasets[]', async () => {
    const server = new MemorySubstrateServer();
    const dataset = new MemoryDataset({ namespace: 'default' });
    const orphans: CoordinatorPlugin = {
      name: 'orphans',
      contractVersion: '*',
      namespaces: [
        {
          namespace: 'orphans',
          install: (): void => undefined
        }
      ]
    };

    composed = await compose({
      // Auth is off, so the deployment must declare who it writes as.
      systemActor: 'test',
      server,
      dataset,
      coordinators: [orphans]
    });
    expect(composed).toBeDefined();
    await server.stop();
  });

  it('onStart fires after install completes', async () => {
    const server = new MemorySubstrateServer();
    const dataset = new MemoryDataset({ namespace: 'default' });
    const state = { started: false };
    const plugin: CoordinatorPlugin = {
      name: 'lifecycle',
      contractVersion: '*',
      namespaces: [
        {
          namespace: 'default',
          install: (): void => undefined
        }
      ],
      onStart: (): void => {
        state.started = true;
      }
    };

    composed = await compose({
      // Auth is off, so the deployment must declare who it writes as.
      systemActor: 'test',
      server,
      dataset,
      coordinators: [plugin]
    });
    expect(state.started).toBe(true);
  });
});
