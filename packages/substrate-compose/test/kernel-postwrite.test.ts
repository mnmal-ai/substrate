/**
 * compose() threads substrates through to loadPlugins() so that
 * substrate-driven postWrite contributions actually fire on writes.
 *
 * Regression: if `compose()` does not forward `opts.substrates` to
 * `loadPlugins()`, `collectPostWriteContributions` walks an empty array
 * and no hooks are installed — the hook counter below would stay at 0.
 */

import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { defineNamespace, field } from '@mnmal-ai/substrate-sdk';
import { MemorySubstrateServer } from '@mnmal-ai/substrate-server-memory';
import type {
  CoordinatorPlugin,
  KernelPlugin,
  NamespaceDefinition,
  PostWriteHook,
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

function makeKernelWithHook(hookCalled: { count: number; rows: Row[] }): KernelPlugin {
  return {
    name: 'test-substrate',
    contractVersion: '*',
    contributePostWrites: (nsDef: NamespaceDefinition): Record<string, PostWriteHook> => {
      const hooks: Record<string, PostWriteHook> = {};
      for (const typeName of Object.keys(nsDef.types ?? {})) {
        hooks[typeName] = async (row: Row): Promise<void> => {
          hookCalled.count += 1;
          hookCalled.rows.push(row);
        };
      }
      return hooks;
    }
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('compose() threads kernel plugins into loadPlugins()', () => {
  it('fires kernel contributePostWrites hook after a write when kernel plugins are supplied', async () => {
    const server = new MemorySubstrateServer();
    const dataset = new MemoryDataset({ namespace: 'default' });

    const nsDef = defineNamespace('default', {
      Widget: {
        fields: { label: field.string() }
      }
    });

    const hookCalled = { count: 0, rows: [] as Row[] };
    const kernel = makeKernelWithHook(hookCalled);

    const coordinator = makeCoordinatorPlugin('widget-plugin', nsDef);

    const composed = await compose({
      // Auth is off in this harness, so the deployment declares who it writes as.
      systemActor: 'test',
      server,
      dataset,
      coordinators: [coordinator],
      kernelPlugins: [kernel]
    });

    await server.start();
    try {
      // Drive a create mutation through the in-process server.
      const res = await server.inject({
        method: 'POST',
        path: '/substrate/v1/mutate',
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(
          JSON.stringify({
            'default/createWidget': {
              params: { label: 'hello' },
              fields: { id: true, label: true }
            }
          })
        )
      });

      expect(res.status).toBe(200);

      // The substrate's postWrite hook must have fired exactly once for the
      // single create; without substrates threaded it stays at 0.
      expect(hookCalled.count).toBe(1);
      expect(hookCalled.rows[0]).toMatchObject({ label: 'hello' });
    } finally {
      await composed.stop();
    }
  });

  it('does NOT fire a kernel hook for a write its transaction rolled back', async () => {
    const server = new MemorySubstrateServer();
    const dataset = new MemoryDataset({ namespace: 'default' });
    const nsDef = defineNamespace('default', { Widget: { fields: { label: field.string() } } });
    const hookCalled = { count: 0, rows: [] as Row[] };
    const composed = await compose({
      systemActor: 'test',
      server,
      dataset,
      coordinators: [makeCoordinatorPlugin('widget-plugin', nsDef)],
      kernelPlugins: [makeKernelWithHook(hookCalled)]
    });

    await server.start();
    try {
      // One array op-key is one transaction: the second frame's refusal rolls
      // back the first frame's create.
      const res = await server.inject({
        method: 'POST',
        path: '/substrate/v1/mutate',
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(
          JSON.stringify({
            'default/createWidget': [
              { params: { label: 'kept?' }, fields: { id: true } },
              { params: { label: 'x', bogus: true }, fields: { id: true } }
            ]
          })
        )
      });

      expect(JSON.parse(String(res.body)).errors?.length ?? 0).toBeGreaterThan(0);
      expect(hookCalled.count).toBe(0);
    } finally {
      await composed.stop();
    }
  });

  it('does NOT fire kernel hooks when kernel plugins are omitted (binary still boots)', async () => {
    const server = new MemorySubstrateServer();
    const dataset = new MemoryDataset({ namespace: 'default' });

    const nsDef = defineNamespace('default', {
      Gadget: {
        fields: { name: field.string() }
      }
    });

    const coordinator = makeCoordinatorPlugin('gadget-plugin', nsDef);

    // No substrates supplied — binary must still boot and serve writes.
    const composed = await compose({
      // Auth is off in this harness, so the deployment declares who it writes as.
      systemActor: 'test',
      server,
      dataset,
      coordinators: [coordinator]
    });

    await server.start();
    try {
      const res = await server.inject({
        method: 'POST',
        path: '/substrate/v1/mutate',
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(
          JSON.stringify({
            'default/createGadget': {
              params: { name: 'doohickey' },
              fields: { id: true, name: true }
            }
          })
        )
      });

      expect(res.status).toBe(200);
    } finally {
      await composed.stop();
    }
  });

  it('fires hooks for every kernel in composition order when multiple kernel plugins are supplied', async () => {
    const server = new MemorySubstrateServer();
    const dataset = new MemoryDataset({ namespace: 'default' });

    const nsDef = defineNamespace('default', {
      Thing: {
        fields: { value: field.string() }
      }
    });

    const order: number[] = [];

    const subA: KernelPlugin = {
      name: 'substrate-a',
      contractVersion: '*',
      contributePostWrites: (): Record<string, PostWriteHook> => ({
        Thing: async (): Promise<void> => {
          order.push(1);
        }
      })
    };
    const subB: KernelPlugin = {
      name: 'substrate-b',
      contractVersion: '*',
      contributePostWrites: (): Record<string, PostWriteHook> => ({
        Thing: async (): Promise<void> => {
          order.push(2);
        }
      })
    };

    const coordinator = makeCoordinatorPlugin('thing-plugin', nsDef);

    const composed = await compose({
      // Auth is off in this harness, so the deployment declares who it writes as.
      systemActor: 'test',
      server,
      dataset,
      coordinators: [coordinator],
      kernelPlugins: [subA, subB]
    });

    await server.start();
    try {
      await server.inject({
        method: 'POST',
        path: '/substrate/v1/mutate',
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(
          JSON.stringify({
            'default/createThing': {
              params: { value: 'x' },
              fields: { id: true }
            }
          })
        )
      });

      // Both hooks must fire in substrate registration order.
      expect(order).toEqual([1, 2]);
    } finally {
      await composed.stop();
    }
  });
});
