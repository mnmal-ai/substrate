/**
 * compose() installs substrate plugins' `kernelNamespace` claims as virtual
 * namespaces: registry-backed, dataset-less. This suite pins the happy path
 * (query + mutate a claimed virtual ns through the composed engine) plus all
 * three collision directions that must refuse boot: substrate-vs-substrate,
 * coordinator-vs-substrate, and the engine-reserved `_system` name (installed
 * AFTER the claims loop, so it's checked explicitly).
 */

import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { defineNamespace, field } from '@mnmal-ai/substrate-sdk';
import { MemorySubstrateServer } from '@mnmal-ai/substrate-server-memory';
import type {
  CoordinatorPlugin,
  KernelPlugin,
  NamespaceDefinition,
  Row
} from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { compose } from '../src/compose.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCoordinatorPlugin(name: string, nsDef: NamespaceDefinition): CoordinatorPlugin {
  return {
    name,
    contractVersion: '*',
    namespaces: [nsDef]
  };
}

/**
 * Substrate plugin that claims namespace `recall` with one virtual type (`Hit`)
 * and one virtual mutation (`boost`). Resolvers compute purely from params —
 * no dataset is touched.
 */
function virtualPlugin(name = 'recall-substrate'): KernelPlugin {
  return {
    name,
    contractVersion: '*',
    kernelNamespace: {
      namespace: 'recall',
      types: {
        Hit: {
          fields: { echo: field.string() },
          resolver: async (_ctx, args): Promise<Row[]> => [
            { id: 'h1', echo: (args.params?.to as string | undefined) ?? null }
          ]
        }
      },
      mutations: {
        boost: {
          resolver: async (): Promise<Row> => ({ id: 'ack', ok: true })
        }
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('compose() installs kernelNamespace claims as virtual namespaces', () => {
  it('happy path: query + mutate a claimed virtual namespace through the composed engine', async () => {
    const server = new MemorySubstrateServer();
    const dataset = new MemoryDataset({ namespace: 'default' });

    const composed = await compose({
      // Auth is off in this harness, so the deployment declares who it writes as.
      systemActor: 'test',
      server,
      dataset,
      kernelPlugins: [virtualPlugin()]
    });

    await server.start();
    try {
      const queryRes = await server.inject({
        method: 'POST',
        path: '/substrate/v1/query',
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(
          JSON.stringify({
            'recall/Hit': { params: { to: 'jazz' }, fields: { id: true, echo: true } }
          })
        )
      });
      expect(queryRes.status).toBe(200);
      const queryBody = JSON.parse(String(queryRes.body)) as {
        data: Record<string, unknown>;
        errors?: unknown;
      };
      expect(queryBody.errors).toBeUndefined();
      expect(queryBody.data['recall/Hit']).toEqual([{ id: 'h1', echo: 'jazz' }]);

      const mutateRes = await server.inject({
        method: 'POST',
        path: '/substrate/v1/mutate',
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(
          JSON.stringify({
            'recall/boost': { params: { targets: ['a'] }, fields: { id: true, ok: true } }
          })
        )
      });
      expect(mutateRes.status).toBe(200);
      const mutateBody = JSON.parse(String(mutateRes.body)) as {
        data: Record<string, unknown>;
        errors?: unknown;
      };
      expect(mutateBody.errors).toBeUndefined();
      expect(mutateBody.data['recall/boost']).toEqual({ id: 'ack', ok: true });
    } finally {
      await composed.stop();
    }
  });

  it('substrate-vs-substrate collision: two kernel plugins claiming the same namespace refuse boot', async () => {
    const server = new MemorySubstrateServer();
    const dataset = new MemoryDataset({ namespace: 'default' });

    const subA = virtualPlugin('substrate-a');
    const subB = virtualPlugin('substrate-b');

    await expect(
      compose({
        // Auth is off in this harness, so the deployment declares who it writes as.
        systemActor: 'test',
        server,
        dataset,
        kernelPlugins: [subA, subB]
      })
    ).rejects.toThrow(/virtual_namespace_collision/);

    // The error must name BOTH claimants and the namespace.
    await expect(
      compose({
        // Auth is off in this harness, so the deployment declares who it writes as.
        systemActor: 'test',
        server,
        dataset,
        kernelPlugins: [subA, subB]
      })
    ).rejects.toThrow(/substrate-a[\s\S]*substrate-b|substrate-b[\s\S]*substrate-a/);
    await expect(
      compose({
        // Auth is off in this harness, so the deployment declares who it writes as.
        systemActor: 'test',
        server,
        dataset,
        kernelPlugins: [subA, subB]
      })
    ).rejects.toThrow(/recall/);
  });

  it('coordinator-vs-virtual collision: a coordinator namespace blocks a kernel claim of the same name', async () => {
    const server = new MemorySubstrateServer();
    const dataset = new MemoryDataset({ namespace: 'recall' });

    const nsDef = defineNamespace('recall', {
      Note: { fields: { text: field.string() } }
    });
    const coordinator = makeCoordinatorPlugin('recall-coordinator', nsDef);

    await expect(
      compose({
        // Auth is off in this harness, so the deployment declares who it writes as.
        systemActor: 'test',
        server,
        dataset,
        coordinators: [coordinator],
        kernelPlugins: [virtualPlugin()]
      })
    ).rejects.toThrow(/virtual_namespace_collision/);
  });

  it('claiming the engine-reserved _system namespace refuses boot', async () => {
    const server = new MemorySubstrateServer();
    const dataset = new MemoryDataset({ namespace: 'default' });

    const sub: KernelPlugin = {
      name: 'reserved-claimant',
      contractVersion: '*',
      kernelNamespace: {
        namespace: '_system',
        types: {
          Sneaky: {
            fields: { x: field.string() },
            resolver: async (): Promise<Row[]> => []
          }
        }
      }
    };

    await expect(
      compose({
        // Auth is off in this harness, so the deployment declares who it writes as.
        systemActor: 'test',
        server,
        dataset,
        kernelPlugins: [sub]
      })
    ).rejects.toThrow(/virtual_namespace_collision/);
  });

  it('onboard payload surfaces virtual namespace names; absent kernel yields empty array', async () => {
    // With a virtual substrate: 'recall' should appear in virtualNamespaces.
    const serverWith = new MemorySubstrateServer();
    const datasetWith = new MemoryDataset({ namespace: 'default' });
    const composedWith = await compose({
      // Auth is off in this harness, so the deployment declares who it writes as.
      systemActor: 'test',
      server: serverWith,
      dataset: datasetWith,
      kernelPlugins: [virtualPlugin()]
    });
    await serverWith.start();
    try {
      const res = await serverWith.inject({ method: 'GET', path: '/substrate/v1/onboard' });
      expect(res.status).toBe(200);
      const body = JSON.parse(String(res.body)) as {
        binary: { virtualNamespaces: string[] };
      };
      expect(body.binary.virtualNamespaces).toEqual(['recall']);
    } finally {
      await composedWith.stop();
    }

    // Without any substrate: virtualNamespaces is an empty array.
    const serverWithout = new MemorySubstrateServer();
    const datasetWithout = new MemoryDataset({ namespace: 'default' });
    const composedWithout = await compose({
      // Auth is off in this harness, so the deployment declares who it writes as.
      systemActor: 'test',
      server: serverWithout,
      dataset: datasetWithout
    });
    await serverWithout.start();
    try {
      const res = await serverWithout.inject({ method: 'GET', path: '/substrate/v1/onboard' });
      expect(res.status).toBe(200);
      const body = JSON.parse(String(res.body)) as {
        binary: { virtualNamespaces: string[] };
      };
      expect(body.binary.virtualNamespaces).toEqual([]);
    } finally {
      await composedWithout.stop();
    }
  });
});
