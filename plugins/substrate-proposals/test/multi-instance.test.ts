/**
 * Multi-instance LISTEN/NOTIFY invalidation + startup reconcile tests.
 *
 * Two "instances" are simulated by two RegistryStores that share the same
 * MemoryDataset (and MemoryEdgesStore). The LoopbackPubSub lets test
 * code trigger a NOTIFY synchronously.
 */

import { randomUUID } from 'node:crypto';
import { MemoryEdgesStore, Registry } from '@mnmal-ai/substrate-core';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { beforeEach, describe, expect, it } from 'vitest';
import type { PubSub } from '../src/config.js';
import {
  applyProposalFromNotification,
  reconcileNamespace,
  setupNamespaceListener
} from '../src/multi-instance.js';
import { RegistryStore } from '../src/registry-store.js';

const NS = 'fashion';

/** In-process PubSub: handlers are called synchronously in notify(). */
class LoopbackPubSub implements PubSub {
  private readonly handlers = new Map<string, Array<(payload: string) => void | Promise<void>>>();

  async listen(channel: string, handler: (payload: string) => void | Promise<void>): Promise<void> {
    const list = this.handlers.get(channel) ?? [];
    list.push(handler);
    this.handlers.set(channel, list);
  }

  async notify(channel: string, payload: string): Promise<void> {
    const list = this.handlers.get(channel) ?? [];
    for (const h of list) await h(payload);
  }
}

/** Shared dataset + edges (simulates a common Postgres substrate). */
function makeSharedTxScope() {
  const dataset = new MemoryDataset({ namespace: NS });
  const edges = new MemoryEdgesStore({ now: () => new Date() });
  return { dataset, edges };
}

/** Build a RegistryStore bound to the shared substrate. */
function makeStore(
  dataset: MemoryDataset,
  edges: MemoryEdgesStore
): { store: RegistryStore; registry: Registry } {
  const registry = new Registry();
  const store = new RegistryStore();
  store.set(NS, { registry, dataset, edges });
  return { store, registry };
}

describe('applyProposalFromNotification', () => {
  it('registers a TypeProposal on a second instance when notified', async () => {
    const { dataset, edges } = makeSharedTxScope();
    const { store: storeA, registry: registryA } = makeStore(dataset, edges);
    const { store: storeB, registry: registryB } = makeStore(dataset, edges);

    // Instance A: write an applied TypeProposal row to the shared dataset.
    const proposalId = randomUUID();
    await dataset.write('TypeProposal', [
      {
        id: proposalId,
        typeName: 'Dress',
        fieldsJson: JSON.stringify({ name: { kind: 'scalar', type: 'string' } }),
        proposedBy: 'agent-a',
        proposedAt: new Date(),
        proposedReason: 'New garment',
        applied: true,
        appliedAt: new Date(),
        supersededByCode: false,
        archived: false
      }
    ]);

    // Instance A: apply to its own registry (simulates what propose_type resolver does).
    const bindingA = storeA.getBinding(NS);
    const { applyTypeProposal } = await import('../src/apply.js');
    applyTypeProposal({
      namespace: NS,
      typeName: 'Dress',
      fields: { name: { kind: 'scalar', type: 'string' } },
      registryStore: storeA,
      dataset: bindingA.dataset,
      edges: bindingA.edges
    });
    expect(registryA.has('Dress')).toBe(true);

    // Instance B: does NOT have Dress yet.
    expect(registryB.has('Dress')).toBe(false);

    // Apply from notification on instance B.
    await applyProposalFromNotification({ namespace: NS, proposalId, registryStore: storeB });

    expect(registryB.has('Dress')).toBe(true);
    expect(registryB.has('createDress')).toBe(true);
  });
});

describe('reconcileNamespace', () => {
  let dataset: MemoryDataset;
  let edges: MemoryEdgesStore;

  beforeEach(() => {
    ({ dataset, edges } = makeSharedTxScope());
  });

  it('replays applied TypeProposals on cold boot', async () => {
    // Seed a TypeProposal row directly (simulates a row left by a previous instance).
    const proposalId = randomUUID();
    await dataset.write('TypeProposal', [
      {
        id: proposalId,
        typeName: 'Jacket',
        fieldsJson: JSON.stringify({ color: { kind: 'scalar', type: 'string' } }),
        proposedBy: 'designer',
        proposedAt: new Date(),
        proposedReason: 'New jacket type',
        applied: true,
        appliedAt: new Date(),
        supersededByCode: false,
        archived: false
      }
    ]);

    // Fresh instance — registry starts empty.
    const { store, registry } = makeStore(dataset, edges);
    expect(registry.has('Jacket')).toBe(false);

    await reconcileNamespace({ namespace: NS, registryStore: store });

    expect(registry.has('Jacket')).toBe(true);
    expect(registry.has('createJacket')).toBe(true);
  });

  it('replays FieldProposals after their parent TypeProposals', async () => {
    // Seed TypeProposal for Dress{name} and FieldProposal for Dress.color.
    const typeProposalId = randomUUID();
    await dataset.write('TypeProposal', [
      {
        id: typeProposalId,
        typeName: 'Dress',
        fieldsJson: JSON.stringify({ name: { kind: 'scalar', type: 'string' } }),
        proposedBy: 'designer',
        proposedAt: new Date(),
        proposedReason: 'Dress type',
        applied: true,
        appliedAt: new Date(),
        supersededByCode: false,
        archived: false
      }
    ]);

    const fieldProposalId = randomUUID();
    await dataset.write('FieldProposal', [
      {
        id: fieldProposalId,
        targetType: 'Dress',
        fieldName: 'color',
        fieldSpecJson: JSON.stringify({ kind: 'scalar', type: 'string' }),
        proposedBy: 'designer',
        proposedAt: new Date(),
        proposedReason: 'Add color field',
        applied: true,
        appliedAt: new Date(),
        supersededByCode: false,
        archived: false
      }
    ]);

    // Fresh instance.
    const { store, registry } = makeStore(dataset, edges);
    await reconcileNamespace({ namespace: NS, registryStore: store });

    expect(registry.has('Dress')).toBe(true);
    const entry = registry.get('Dress');
    expect(entry).toBeDefined();
    expect(entry?.fields).toHaveProperty('name');
    expect(entry?.fields).toHaveProperty('color');
  });

  it('wires listener so NOTIFY triggers registration on the instance', async () => {
    const pubsub = new LoopbackPubSub();
    const { store, registry } = makeStore(dataset, edges);

    // Set up listener on instance.
    await setupNamespaceListener({
      namespace: NS,
      channel: `_substrate_proposals_${NS}`,
      pubsub,
      registryStore: store
    });

    // Simulate another instance writing a row and emitting a NOTIFY.
    const proposalId = randomUUID();
    await dataset.write('TypeProposal', [
      {
        id: proposalId,
        typeName: 'Boot',
        fieldsJson: JSON.stringify({ size: { kind: 'scalar', type: 'string' } }),
        proposedBy: 'agent',
        proposedAt: new Date(),
        proposedReason: 'Boot type',
        applied: true,
        appliedAt: new Date(),
        supersededByCode: false,
        archived: false
      }
    ]);

    expect(registry.has('Boot')).toBe(false);

    // Fire the NOTIFY — listener should apply immediately.
    await pubsub.notify(`_substrate_proposals_${NS}`, proposalId);

    expect(registry.has('Boot')).toBe(true);
  });
});
