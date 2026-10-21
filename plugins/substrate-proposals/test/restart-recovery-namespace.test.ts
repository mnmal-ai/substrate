/**
 * Restart-recovery tests for hot-added namespaces.
 *
 * Cold-boot of an instance must replay applied=true NamespaceProposal rows from
 * the control-plane dataset so previously hot-added namespaces survive across
 * process restarts. The per-namespace TypeProposal/FieldProposal reconcile pass
 * must then cover BOTH static ownedNamespaces AND those replayed namespaces, so
 * TypeProposals proposed inside a hot-added ns before restart land back into
 * the live registry.
 *
 * Mirrors the loadPlugins / runOnStart pattern from multi-instance-namespace.test.ts.
 */

import { Engine, loadPlugins, MemoryEdgesStore } from '@mnmal-ai/substrate-core';
import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import { describe, expect, it } from 'vitest';
import { createNoopPubSub, createProposalsPlugin } from '../src/index.js';

describe('restart recovery — NamespaceProposal replay', () => {
  it('replays applied=true NamespaceProposals on cold boot', async () => {
    const sharedControlDataset = new MemoryDataset({ namespace: '_system_proposals' });
    const datasets = new MemoryDatasetRegistry();
    datasets.set('_system_proposals', sharedControlDataset);

    // Pre-populate: a NamespaceProposal row for 'user-eve' applied=true
    await sharedControlDataset.write('NamespaceProposal', [
      {
        id: '11111111-1111-1111-1111-111111111111',
        ns: 'user-eve',
        proposedBy: 'home',
        proposedAt: new Date(),
        proposedReason: 'pre-existing',
        applied: true,
        appliedAt: new Date(),
        supersededByCode: false,
        archived: false
      }
    ]);
    datasets.set('user-eve', new MemoryDataset({ namespace: 'user-eve' }));

    const plugin = createProposalsPlugin({
      ownedNamespaces: [],
      pubsub: createNoopPubSub(),
      datasetFor: (ns) => datasets.get(ns)
    });
    const edges = new MemoryEdgesStore({ now: () => new Date() });
    const loaded = await loadPlugins({
      plugins: [plugin],
      datasetFor: (ns) => datasets.get(ns),
      edges
    });
    const engine = new Engine({
      namespaces: loaded.namespaces,
      datasets,
      edges
    });
    await loaded.runOnStart(engine);

    // user-eve should be reachable post-onStart even though it wasn't in ownedNamespaces.
    expect(engine.registryFor('user-eve')).toBeDefined();

    // Regression: `installHotAddedNamespace` must register the proposal
    // mutations, so propose_type works on cold-boot-replayed nses, not just
    // the static ownedNamespaces. Assert the wiring after onStart's reconcile.
    const typeEnv = await engine.mutate({
      frame: {
        'user-eve/propose_type': {
          params: {
            typeName: 'PersonalNote',
            fields: { body: { kind: 'scalar', type: 'string' } },
            proposedBy: 'home',
            proposedReason: 'cold-boot replay propose_type smoke'
          },
          fields: { id: true, applied: true }
        }
      },
      ctx: {
        identity: {
          id: 'agent-1',
          tokenId: 'agent-1',
          grants: { '*': ['substrate.propose', 'read', 'mutate'] }
        },
        now: new Date('2026-05-06T00:00:00Z'),
        headers: {},
        meta: {}
      }
    });
    expect(typeEnv.errors).toBeUndefined();
    const typeResult = typeEnv.data['user-eve/propose_type'] as Record<string, unknown>;
    expect(typeResult.applied).toBe(true);
    const userEveRegistry = engine.registryFor('user-eve');
    expect(userEveRegistry?.has('PersonalNote')).toBe(true);
    expect(userEveRegistry?.has('createPersonalNote')).toBe(true);
  });

  it('per-ns reconcile sees TypeProposals proposed on hot-added namespaces', async () => {
    const sharedControl = new MemoryDataset({ namespace: '_system_proposals' });
    const userEveDs = new MemoryDataset({ namespace: 'user-eve' });
    const datasets = new MemoryDatasetRegistry();
    datasets.set('_system_proposals', sharedControl);
    datasets.set('user-eve', userEveDs);

    // Pre-populate: NamespaceProposal applied=true for user-eve
    await sharedControl.write('NamespaceProposal', [
      {
        id: '22222222-2222-2222-2222-222222222222',
        ns: 'user-eve',
        proposedBy: 'home',
        proposedAt: new Date(),
        proposedReason: 'pre',
        applied: true,
        appliedAt: new Date(),
        supersededByCode: false,
        archived: false
      }
    ]);
    // Pre-populate: TypeProposal applied=true on user-eve namespace
    await userEveDs.write('TypeProposal', [
      {
        id: '33333333-3333-3333-3333-333333333333',
        typeName: 'PersonalNote',
        fieldsJson: JSON.stringify({ body: { kind: 'scalar', type: 'string' } }),
        proposedBy: 'home',
        proposedAt: new Date(),
        proposedReason: 'pre',
        applied: true,
        appliedAt: new Date(),
        supersededByCode: false,
        archived: false
      }
    ]);

    const plugin = createProposalsPlugin({
      ownedNamespaces: [],
      pubsub: createNoopPubSub(),
      datasetFor: (ns) => datasets.get(ns)
    });
    const edges = new MemoryEdgesStore({ now: () => new Date() });
    const loaded = await loadPlugins({
      plugins: [plugin],
      datasetFor: (ns) => datasets.get(ns),
      edges
    });
    const engine = new Engine({
      namespaces: loaded.namespaces,
      datasets,
      edges
    });
    await loaded.runOnStart(engine);

    // PersonalNote should be in user-eve's registry — both the namespace
    // (from cluster reconcile) and the type within it (from per-ns reconcile)
    // came back from the dataset.
    const userEveRegistry = engine.registryFor('user-eve');
    expect(userEveRegistry).toBeDefined();
    expect(userEveRegistry?.has('PersonalNote')).toBe(true);
  });

  it('skips archived NamespaceProposal rows on replay', async () => {
    const sharedControl = new MemoryDataset({ namespace: '_system_proposals' });
    const datasets = new MemoryDatasetRegistry();
    datasets.set('_system_proposals', sharedControl);

    // Pre-populate: applied=true BUT archived=true — must NOT replay.
    await sharedControl.write('NamespaceProposal', [
      {
        id: '44444444-4444-4444-4444-444444444444',
        ns: 'user-archived',
        proposedBy: 'home',
        proposedAt: new Date(),
        proposedReason: 'archived test',
        applied: true,
        appliedAt: new Date(),
        supersededByCode: false,
        archived: true
      }
    ]);
    // Even if a dataset is provisioned for the archived ns, it should NOT
    // be installed — the archived filter excludes the row.
    datasets.set('user-archived', new MemoryDataset({ namespace: 'user-archived' }));

    const plugin = createProposalsPlugin({
      ownedNamespaces: [],
      pubsub: createNoopPubSub(),
      datasetFor: (ns) => datasets.get(ns)
    });
    const edges = new MemoryEdgesStore({ now: () => new Date() });
    const loaded = await loadPlugins({
      plugins: [plugin],
      datasetFor: (ns) => datasets.get(ns),
      edges
    });
    const engine = new Engine({
      namespaces: loaded.namespaces,
      datasets,
      edges
    });
    await loaded.runOnStart(engine);

    expect(engine.registryFor('user-archived')).toBeUndefined();
  });
});
