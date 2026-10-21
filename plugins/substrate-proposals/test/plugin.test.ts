/**
 * Integration tests for createProposalsPlugin.
 *
 * Uses Engine + loadPlugins directly (the "memory server" pattern in this
 * codebase) rather than going through HTTP — MemorySubstrateServer is a transport
 * layer with no plugin-loading seam, so engine-direct is the right harness.
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

function makeEdges(): MemoryEdgesStore {
  return new MemoryEdgesStore({ now: () => new Date('2026-04-22T00:00:00Z') });
}

function makeCtx(overrides: Partial<RequestContext> = {}): Partial<RequestContext> {
  return {
    identity: { kind: 'system', id: 'test', grants: { '*': ['read', 'mutate'] } },
    now: new Date('2026-04-22T00:00:00Z'),
    headers: {},
    meta: {},
    ...overrides
  };
}

/** Boot an engine with the proposals plugin owning the given namespaces. */
async function bootEngine(ownedNamespaces: string[]): Promise<{
  engine: Engine;
  datasets: MemoryDatasetRegistry;
}> {
  const plugin = createProposalsPlugin({
    ownedNamespaces,
    pubsub: createNoopPubSub()
  });

  const memDatasets = new MemoryDatasetRegistry();
  const edges = makeEdges();

  // Control-plane ns is auto-installed by the plugin; back
  // it with its own MemoryDataset so loadPlugins can resolve it.
  memDatasets.set(CONTROL_NAMESPACE, new MemoryDataset({ namespace: CONTROL_NAMESPACE }));
  for (const ns of ownedNamespaces) {
    memDatasets.set(ns, new MemoryDataset({ namespace: ns }));
  }

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

  // Run onStart so the proposals plugin wires its schema-cache invalidator —
  // without this, federatedSchema() would return a stale view
  // after every applyType / applyField.
  await loaded.runOnStart(engine);

  return { engine, datasets: memDatasets };
}

describe('createProposalsPlugin', () => {
  it('creates a plugin with multiple owned namespaces', () => {
    const plugin = createProposalsPlugin({
      ownedNamespaces: ['alpha', 'beta'],
      pubsub: createNoopPubSub()
    });

    expect(plugin.name).toBe('substrate-proposals');
    // Plugin auto-prepends the control-plane ns, so the
    // namespaces array is [substrate_proposals, ...ownedNamespaces].
    expect(plugin.namespaces.length).toBe(3);
    expect(plugin.namespaces.map((n) => n.namespace)).toEqual([CONTROL_NAMESPACE, 'alpha', 'beta']);
  });

  it('boots a server with the plugin and propose_type works end-to-end', async () => {
    const { engine } = await bootEngine(['home']);

    const envelope = await engine.mutate({
      frame: {
        'home/propose_type': {
          params: {
            typeName: 'Dress',
            fields: {
              name: { kind: 'scalar', type: 'string' }
            },
            proposedBy: 'test-agent',
            proposedReason: 'Need a Dress type'
          },
          fields: { id: true, typeName: true, applied: true }
        }
      },
      ctx: makeCtx({
        identity: {
          id: 'agent-1',
          tokenId: 'agent-1',
          grants: { '*': ['substrate.propose', 'read', 'mutate'] }
        }
      })
    });

    expect(envelope.errors).toBeUndefined();
    const result = envelope.data['home/propose_type'] as Record<string, unknown>;
    expect(result.applied).toBe(true);
    expect(result.typeName).toBe('Dress');

    // Dress type is now queryable
    const queryEnvelope = await engine.query({
      frame: {
        'home/Dress': {
          params: { where: {} },
          fields: { id: true, name: true }
        }
      },
      ctx: makeCtx({
        identity: {
          id: 'agent-1',
          tokenId: 'agent-1',
          grants: { '*': ['substrate.propose', 'read', 'mutate'] }
        }
      })
    });

    expect(queryEnvelope.errors).toBeUndefined();
    expect(Array.isArray(queryEnvelope.data['home/Dress'])).toBe(true);
    expect((queryEnvelope.data['home/Dress'] as unknown[]).length).toBe(0);
  });

  it('rejects propose_type without substrate.propose capability', async () => {
    const { engine } = await bootEngine(['home']);

    const envelope = await engine.mutate({
      frame: {
        'home/propose_type': {
          params: {
            typeName: 'Hat',
            fields: { color: { kind: 'scalar', type: 'string' } },
            proposedBy: 'unprivileged',
            proposedReason: 'should be denied'
          },
          fields: { id: true }
        }
      },
      ctx: makeCtx({
        // Engine-passing but propose-less: reaches the propose POLICY, which
        // is what this test proves fires. (An empty grant would refuse at the
        // engine gate first and prove nothing about the policy.)
        identity: { id: 'nobody', tokenId: 'nobody', grants: { home: ['read', 'mutate'] } }
      })
    });

    // Policy denial surfaces in envelope.errors, not as a throw
    expect(envelope.errors).toBeDefined();
    const err = envelope.errors?.find((e) => e.path?.includes('home/propose_type'));
    expect(err).toBeDefined();
    expect(err?.code).toBe('policy_denied');
  });

  it('dynamically-proposed types allocate shortId on create, at parity with code-declared types', async () => {
    const { engine } = await bootEngine(['home']);
    const proposeCtx = makeCtx({
      identity: {
        id: 'agent-1',
        tokenId: 'agent-1',
        grants: { '*': ['substrate.propose', 'read', 'mutate'] }
      }
    });

    // Propose Dress
    await engine.mutate({
      frame: {
        'home/propose_type': {
          params: {
            typeName: 'Dress',
            fields: { name: { kind: 'scalar', type: 'string' } },
            proposedBy: 'test-agent',
            proposedReason: 'shortId parity test'
          },
          fields: { id: true }
        }
      },
      ctx: proposeCtx
    });

    // Create a Dress — expect shortId in the returned row
    const createEnv = await engine.mutate({
      frame: {
        'home/createDress': {
          params: { name: 'test dress' },
          fields: { id: true, name: true, shortId: true }
        }
      },
      ctx: proposeCtx
    });

    expect(createEnv.errors).toBeUndefined();
    const row = createEnv.data['home/createDress'] as Record<string, unknown>;
    expect(row.name).toBe('test dress');
    expect(typeof row.shortId).toBe('number');
    expect(row.shortId).toBeGreaterThan(0);

    // A second create allocates a distinct shortId
    const createEnv2 = await engine.mutate({
      frame: {
        'home/createDress': {
          params: { name: 'another dress' },
          fields: { id: true, shortId: true }
        }
      },
      ctx: proposeCtx
    });
    const row2 = createEnv2.data['home/createDress'] as Record<string, unknown>;
    expect(typeof row2.shortId).toBe('number');
    expect(row2.shortId).not.toBe(row.shortId);
  });

  it('FieldProposal preserves the shortId field when extending a dynamic type', async () => {
    const { engine } = await bootEngine(['home']);
    const proposeCtx = makeCtx({
      identity: {
        id: 'agent-1',
        tokenId: 'agent-1',
        grants: { '*': ['substrate.propose', 'read', 'mutate'] }
      }
    });

    await engine.mutate({
      frame: {
        'home/propose_type': {
          params: {
            typeName: 'Dress',
            fields: { name: { kind: 'scalar', type: 'string' } },
            proposedBy: 'test-agent',
            proposedReason: 'setup'
          },
          fields: { id: true }
        }
      },
      ctx: proposeCtx
    });

    await engine.mutate({
      frame: {
        'home/propose_field': {
          params: {
            targetType: 'Dress',
            fieldName: 'color',
            fieldSpec: { kind: 'scalar', type: 'string' },
            proposedBy: 'test-agent',
            proposedReason: 'add color'
          },
          fields: { id: true }
        }
      },
      ctx: proposeCtx
    });

    const createEnv = await engine.mutate({
      frame: {
        'home/createDress': {
          params: { name: 'sage', color: 'green' },
          fields: { id: true, name: true, color: true, shortId: true }
        }
      },
      ctx: proposeCtx
    });

    expect(createEnv.errors).toBeUndefined();
    const row = createEnv.data['home/createDress'] as Record<string, unknown>;
    expect(row.color).toBe('green');
    expect(typeof row.shortId).toBe('number');
  });

  it('federatedSchema reflects new types + fields immediately after proposals', async () => {
    const { engine } = await bootEngine(['home']);
    const proposeCtx = makeCtx({
      identity: {
        id: 'agent-1',
        tokenId: 'agent-1',
        grants: { '*': ['substrate.propose', 'read', 'mutate'] }
      }
    });

    // Prime the federated schema cache pre-proposal: without invalidation,
    // this cached map would be returned stale until process restart.
    const schemaBefore = engine.federatedSchema();
    expect(Object.keys(schemaBefore.home?.types ?? {})).not.toContain('Dress');

    await engine.mutate({
      frame: {
        'home/propose_type': {
          params: {
            typeName: 'Dress',
            fields: { name: { kind: 'scalar', type: 'string' } },
            proposedBy: 'test-agent',
            proposedReason: 'cache-invalidation regression'
          },
          fields: { id: true }
        }
      },
      ctx: proposeCtx
    });

    const schemaAfterType = engine.federatedSchema();
    expect(Object.keys(schemaAfterType.home?.types ?? {})).toContain('Dress');

    await engine.mutate({
      frame: {
        'home/propose_field': {
          params: {
            targetType: 'Dress',
            fieldName: 'color',
            fieldSpec: { kind: 'scalar', type: 'string' },
            proposedBy: 'test-agent',
            proposedReason: 'cache-invalidation regression — field path'
          },
          fields: { id: true }
        }
      },
      ctx: proposeCtx
    });

    const schemaAfterField = engine.federatedSchema();
    const dressFields = schemaAfterField.home?.types.Dress?.fields ?? {};
    expect(Object.keys(dressFields)).toContain('color');
  });

  it('TypeProposal write routes through autoCRUD — _metadata + shortId populated', async () => {
    const { engine, datasets } = await bootEngine(['home']);
    const ctx = makeCtx({
      identity: {
        id: 'agent-1',
        tokenId: 'agent-1',
        grants: { '*': ['substrate.propose', 'read', 'mutate'] }
      }
    });

    await engine.mutate({
      frame: {
        'home/propose_type': {
          params: {
            typeName: 'Hat',
            fields: { color: { kind: 'scalar', type: 'string' } },
            proposedBy: 'test-agent',
            proposedReason: 'autoCRUD routing assertion'
          },
          fields: { id: true }
        }
      },
      ctx
    });

    // Read the TypeProposal row directly off the dataset and confirm autoCRUD
    // populated the surrounding metadata (a raw dataset.write would not).
    const dataset = datasets.get('home');
    if (!dataset) throw new Error('home dataset missing');
    const result = await dataset.read('TypeProposal', { limit: 1 });
    expect(result.rows.length).toBe(1);
    const row = result.rows[0] as Record<string, unknown>;
    expect(row.applied).toBe(true);
    // shortId is allocated by autoCRUD's create resolver — proves the engine
    // path was taken (raw dataset.write would leave shortId undefined).
    expect(typeof row.shortId).toBe('number');
    expect((row.shortId as number) > 0).toBe(true);
    // _metadata is filled by the engine's autoCRUD path.
    const meta = row._metadata as Record<string, unknown> | undefined;
    expect(meta).toBeDefined();
    // ctx.now travels into _metadata.createdAt + updatedAt via autoCRUD.
    expect(meta?.createdAt).toBe('2026-04-22T00:00:00.000Z');
    expect(meta?.updatedAt).toBe('2026-04-22T00:00:00.000Z');
    expect((meta?.createdBy as Record<string, unknown>)?.kind).toBeDefined();
    expect((meta?.updatedBy as Record<string, unknown>)?.kind).toBeDefined();
  });
});
