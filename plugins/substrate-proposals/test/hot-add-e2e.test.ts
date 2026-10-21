/**
 * End-to-end exercise of the hot-add namespace flow on memory substrate.
 *
 * Boots the proposals plugin with `ownedNamespaces: []` (only the control-plane
 * is auto-installed) and walks the full caller-facing path:
 *   1. propose_namespace adds `user-frank` to the live engine
 *   2. propose_type within `user-frank` registers a PersonalNote autoCRUD type
 *   3. createPersonalNote writes a row through autoCRUD
 *   4. Reading it back returns what we wrote
 *
 * Hot-added namespaces must be valid `propose_type` targets — not just statically-configured ones. The same
 * test exercises propose_type's ownership gate (which must consult registryStore
 * post-install, not just the static `ownedNamespaces` set captured at construction)
 * AND verifies installHotAddedNamespace registers `propose_type` / `propose_field`
 * mutations on the new ns (without that, the engine would route the
 * `user-frank/propose_type` frame to a missing operation).
 */

import {
  Engine,
  loadPlugins,
  MemoryEdgesStore,
  type NamespaceConfig
} from '@mnmal-ai/substrate-core';
import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import type { Dataset, RequestContext } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { CONTROL_NAMESPACE } from '../src/control-plane.js';
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

describe('hot-add namespace e2e', () => {
  it('propose_namespace then propose_type within the new ns then write a row', async () => {
    const datasets = new MemoryDatasetRegistry();
    datasets.set(CONTROL_NAMESPACE, new MemoryDataset({ namespace: CONTROL_NAMESPACE }));

    const plugin = createProposalsPlugin({
      ownedNamespaces: [],
      pubsub: createNoopPubSub(),
      datasetFor: (ns: string): Dataset | undefined => datasets.get(ns)
    });

    const edges = new MemoryEdgesStore({ now: () => new Date('2026-05-03T00:00:00Z') });

    const loaded = await loadPlugins({
      plugins: [plugin],
      edges,
      datasetFor: (ns): Dataset | undefined => datasets.get(ns)
    });

    const namespaceMap = new Map<string, NamespaceConfig>();
    for (const [ns, cfg] of loaded.namespaces) {
      namespaceMap.set(ns, cfg);
    }

    const engine = new Engine({
      namespaces: namespaceMap,
      datasets,
      edges
    });

    await loaded.runOnStart(engine);

    // Sanity: user-frank is NOT yet installed.
    expect(engine.registryFor('user-frank')).toBeUndefined();

    // Step 1: propose_namespace — host pre-provisions the dataset first.
    datasets.set('user-frank', new MemoryDataset({ namespace: 'user-frank' }));
    const nsEnv = await engine.mutate({
      frame: {
        '_system_proposals/propose_namespace': {
          params: { ns: 'user-frank', proposedBy: 'home', proposedReason: 'e2e test' },
          fields: { id: true, ns: true, applied: true }
        }
      },
      ctx: makeCtx()
    });
    expect(nsEnv.errors).toBeUndefined();
    expect(engine.registryFor('user-frank')).toBeDefined();

    // Step 2: propose_type PersonalNote within the hot-added user-frank ns.
    const typeEnv = await engine.mutate({
      frame: {
        'user-frank/propose_type': {
          params: {
            typeName: 'PersonalNote',
            fields: { body: { kind: 'scalar', type: 'string' } },
            proposedBy: 'home',
            proposedReason: 'e2e test'
          },
          fields: { id: true, applied: true }
        }
      },
      ctx: makeCtx()
    });
    expect(typeEnv.errors).toBeUndefined();
    const typeResult = typeEnv.data['user-frank/propose_type'] as Record<string, unknown>;
    expect(typeResult.applied).toBe(true);

    // PersonalNote is registered on user-frank's registry (autoCRUD generated).
    const userFrankRegistry = engine.registryFor('user-frank');
    expect(userFrankRegistry?.has('PersonalNote')).toBe(true);
    expect(userFrankRegistry?.has('createPersonalNote')).toBe(true);

    // Step 3: create a PersonalNote row through autoCRUD.
    const createEnv = await engine.mutate({
      frame: {
        'user-frank/createPersonalNote': {
          params: { body: 'private thought' },
          fields: { id: true, body: true }
        }
      },
      ctx: makeCtx()
    });
    expect(createEnv.errors).toBeUndefined();
    const createdRow = createEnv.data['user-frank/createPersonalNote'] as Record<string, unknown>;
    expect(createdRow.body).toBe('private thought');

    // Step 4: query it back. autoCRUD list-shape returns Array<Row> at the
    // qualified key.
    const readEnv = await engine.query({
      frame: {
        'user-frank/PersonalNote': {
          params: { limit: 10 },
          fields: { id: true, body: true }
        }
      },
      ctx: makeCtx()
    });
    expect(readEnv.errors).toBeUndefined();
    const rows = readEnv.data['user-frank/PersonalNote'] as Array<{ id: string; body: string }>;
    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.body).toBe('private thought');
  });
});
