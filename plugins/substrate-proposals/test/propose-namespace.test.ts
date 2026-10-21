/**
 * propose_namespace resolver — happy path + first-past-the-post collision
 * + reserved-ns rejection.
 *
 * Boots a Engine + the proposals plugin via `loadPlugins`, then drives
 * the `_system_proposals/propose_namespace` mutation through the engine — the
 * same wire-shape external clients use.
 */

import {
  Engine,
  loadPlugins,
  MemoryEdgesStore,
  type NamespaceConfig
} from '@mnmal-ai/substrate-core';
import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import type { Dataset, RequestContext } from '@mnmal-ai/substrate-types';
import { describe, expect, it, vi } from 'vitest';
import { CONTROL_NAMESPACE } from '../src/control-plane.js';
import { ProposalError } from '../src/errors.js';
import { createNoopPubSub, createProposalsPlugin } from '../src/index.js';

function makeCtx(overrides: Partial<RequestContext> = {}): Partial<RequestContext> {
  return {
    identity: {
      id: 'agent-1',
      tokenId: 'agent-1',
      grants: { '*': ['substrate.propose', 'read', 'mutate'] }
    },
    now: new Date('2026-05-03T00:00:00Z'),
    headers: {},
    meta: {},
    ...overrides
  };
}

async function bootEngine(ownedNamespaces: string[] = []): Promise<{
  engine: Engine;
  datasets: MemoryDatasetRegistry;
}> {
  const memDatasets = new MemoryDatasetRegistry();

  // Control-plane ns is auto-installed by the plugin; back it with a dataset
  // so loadPlugins can resolve.
  memDatasets.set(CONTROL_NAMESPACE, new MemoryDataset({ namespace: CONTROL_NAMESPACE }));
  for (const ns of ownedNamespaces) {
    memDatasets.set(ns, new MemoryDataset({ namespace: ns }));
  }

  const plugin = createProposalsPlugin({
    ownedNamespaces,
    pubsub: createNoopPubSub(),
    // The host wires this so the resolver can find a dataset for hot-added
    // namespaces. In tests the registry IS the host.
    datasetFor: (ns: string): Dataset | undefined => memDatasets.get(ns)
  });

  const edges = new MemoryEdgesStore({ now: () => new Date('2026-05-03T00:00:00Z') });

  const loaded = await loadPlugins({
    plugins: [plugin],
    edges,
    datasetFor: (ns): Dataset | undefined => memDatasets.get(ns)
  });

  const namespaceMap = new Map<string, NamespaceConfig>();
  for (const [ns, cfg] of loaded.namespaces) {
    namespaceMap.set(ns, cfg);
  }

  const engine = new Engine({
    namespaces: namespaceMap,
    datasets: memDatasets,
    edges
  });

  await loaded.runOnStart(engine);

  return { engine, datasets: memDatasets };
}

describe('propose_namespace resolver', () => {
  it('persists a NamespaceProposal row and adds the ns to the engine', async () => {
    const { engine, datasets } = await bootEngine();
    expect(engine.registryFor('user-alice')).toBeUndefined();

    // Host pre-provisions the dataset for the new namespace.
    datasets.set('user-alice', new MemoryDataset({ namespace: 'user-alice' }));

    const envelope = await engine.mutate({
      frame: {
        '_system_proposals/propose_namespace': {
          params: {
            ns: 'user-alice',
            proposedBy: 'home',
            proposedReason: 'invite onboarded'
          },
          fields: { id: true, ns: true, applied: true }
        }
      },
      ctx: makeCtx()
    });

    expect(envelope.errors).toBeUndefined();
    const result = envelope.data['_system_proposals/propose_namespace'] as Record<string, unknown>;
    expect(result.ns).toBe('user-alice');
    expect(result.applied).toBe(true);

    // The new namespace is now reachable.
    expect(engine.registryFor('user-alice')).toBeDefined();

    // The NamespaceProposal row is persisted with applied=true.
    const queryEnv = await engine.query({
      frame: {
        '_system_proposals/NamespaceProposal': {
          params: { where: { ns: { eq: 'user-alice' } }, limit: 1 },
          fields: { id: true, ns: true, applied: true }
        }
      },
      ctx: makeCtx()
    });
    expect(queryEnv.errors).toBeUndefined();
    const persisted = queryEnv.data['_system_proposals/NamespaceProposal'] as Array<
      Record<string, unknown>
    >;
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.applied).toBe(true);
  });

  it('rejects a duplicate namespace with namespace_already_proposed', async () => {
    const { engine, datasets } = await bootEngine();
    datasets.set('user-bob', new MemoryDataset({ namespace: 'user-bob' }));

    const first = await engine.mutate({
      frame: {
        '_system_proposals/propose_namespace': {
          params: { ns: 'user-bob', proposedBy: 'home', proposedReason: 'first' },
          fields: { id: true }
        }
      },
      ctx: makeCtx()
    });
    expect(first.errors).toBeUndefined();

    // The refusal comes back in envelope.errors with its code (ProposalError is
    // a ResolverFrameError), so an HTTP or MCP caller sees why, not internal_error.
    await expect(
      engine.mutate({
        frame: {
          '_system_proposals/propose_namespace': {
            params: { ns: 'user-bob', proposedBy: 'home', proposedReason: 'second' },
            fields: { id: true }
          }
        },
        ctx: makeCtx()
      })
    ).resolves.toMatchObject({
      errors: [expect.objectContaining({ code: 'namespace_already_proposed' })]
    });
  });

  it('rejects propose_namespace for the control-plane name', async () => {
    const { engine } = await bootEngine();
    await expect(
      engine.mutate({
        frame: {
          '_system_proposals/propose_namespace': {
            params: {
              ns: CONTROL_NAMESPACE,
              proposedBy: 'home',
              proposedReason: 'should be denied'
            },
            fields: { id: true }
          }
        },
        ctx: makeCtx()
      })
    ).resolves.toMatchObject({ errors: [expect.objectContaining({ code: 'invalid_namespace' })] });
  });

  it.each(['a/b', 'a:b', ''])('rejects the malformed namespace name %j', async (ns) => {
    const { engine } = await bootEngine();
    await expect(
      engine.mutate({
        frame: {
          '_system_proposals/propose_namespace': {
            params: { ns, proposedReason: 'malformed' },
            fields: { id: true }
          }
        },
        ctx: makeCtx()
      })
    ).resolves.toMatchObject({ errors: [expect.objectContaining({ code: 'invalid_namespace' })] });
  });

  it('refuses a name the engine already holds, and a failed attempt leaves it in place', async () => {
    const { engine, datasets } = await bootEngine();
    datasets.set('other', new MemoryDataset({ namespace: 'other' }));
    datasets.set('gone', new MemoryDataset({ namespace: 'gone' }));
    engine.addNamespace('other', { registry: engine.createRegistry() });
    engine.addNamespace('gone', { registry: engine.createRegistry() });
    engine.tombstoneNamespace('gone');

    for (const ns of ['other', 'gone']) {
      await expect(
        engine.mutate({
          frame: {
            '_system_proposals/propose_namespace': {
              params: { ns, proposedReason: 'takeover' },
              fields: { id: true }
            }
          },
          ctx: makeCtx()
        })
      ).resolves.toMatchObject({
        errors: [expect.objectContaining({ code: 'invalid_namespace' })]
      });
    }

    expect(engine.registryFor('other')).toBeDefined();
    expect(() => engine.addNamespace('gone', { registry: engine.createRegistry() })).toThrow(
      /tombstoned/
    );
  });

  it('a dropped hot-added namespace is retired: archived in the drop, off the engine, its name reserved', async () => {
    const { engine, datasets } = await bootEngine();
    datasets.set('tenant-z', new MemoryDataset({ namespace: 'tenant-z' }));
    const propose = () =>
      engine.mutate({
        frame: {
          '_system_proposals/propose_namespace': {
            params: { ns: 'tenant-z', proposedReason: 'r' },
            fields: { id: true }
          }
        },
        ctx: makeCtx()
      });
    expect((await propose()).errors).toBeUndefined();
    const control = datasets.get(CONTROL_NAMESPACE);
    if (control === undefined) throw new Error('no control dataset');

    // What the drop route does: participants inside its transaction, then the tombstone.
    const participants = engine.dropParticipants();
    expect(participants).toHaveLength(1);
    for (const p of participants) {
      await p.onDrop('tenant-z', (ns) => {
        const ds = datasets.get(ns);
        if (ds === undefined) throw new Error(`no dataset ${ns}`);
        return ds;
      });
    }
    engine.tombstoneNamespace('tenant-z');

    const rows = (await control.read('NamespaceProposal', { limit: 10 })).rows;
    expect(rows.map((r) => r.archived)).toEqual([true]);
    await vi.waitFor(() => expect(engine.namespaceState('tenant-z')).toBe('absent'));
    await expect(propose()).resolves.toMatchObject({
      errors: [expect.objectContaining({ code: 'namespace_retired' })]
    });
  });
});
