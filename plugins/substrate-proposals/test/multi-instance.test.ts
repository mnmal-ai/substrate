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
  reservedSkipLine,
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

  it('skips a stored type that carries a reserved metadata name, and says why', async () => {
    await dataset.write('TypeProposal', [
      {
        id: randomUUID(),
        typeName: 'Ledger',
        fieldsJson: JSON.stringify({ seq: { kind: 'scalar', type: 'number' } }),
        proposedBy: 'designer',
        proposedAt: new Date(),
        proposedReason: 'stored before the name was reserved',
        applied: true,
        appliedAt: new Date(),
        supersededByCode: false,
        archived: false
      }
    ]);
    const { store, registry } = makeStore(dataset, edges);
    const skipped: Array<{ typeName: unknown; message: string }> = [];
    await reconcileNamespace({
      namespace: NS,
      registryStore: store,
      onSkip: (row, err) =>
        skipped.push({ typeName: row.typeName, message: err instanceof Error ? err.message : '' })
    });
    // Boot goes on without the type; the skip names it and the reserved field.
    expect(registry.has('Ledger')).toBe(false);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.typeName).toBe('Ledger');
    expect(skipped[0]?.message).toContain('`seq` is a reserved field name');
  });

  it('words one warning line for a reserved-name skip: namespace, type, field, the effect', async () => {
    const id = randomUUID();
    const row = {
      id,
      typeName: 'Ledger',
      fieldsJson: JSON.stringify({ seq: { kind: 'scalar', type: 'number' } }),
      proposedBy: 'designer',
      proposedAt: new Date(),
      proposedReason: 'stored before the name was reserved',
      applied: true,
      appliedAt: new Date(),
      supersededByCode: false,
      archived: false
    };
    await dataset.write('TypeProposal', [row]);
    const { store } = makeStore(dataset, edges);
    const lines: Array<string | undefined> = [];
    await reconcileNamespace({
      namespace: NS,
      registryStore: store,
      onSkip: (r, err) => lines.push(reservedSkipLine(NS, r, err))
    });
    expect(lines).toEqual([
      `substrate-proposals: ${NS}/Ledger: field 'seq' is reserved for server metadata; the type is not registered`
    ]);
    // Any other failure is not worded as a reserved name.
    expect(reservedSkipLine(NS, row, new Error('boom'))).toBeUndefined();
  });

  it('a peer notification for a reserved-name row skips it and does not throw', async () => {
    const id = randomUUID();
    await dataset.write('TypeProposal', [
      {
        id,
        typeName: 'Ledger',
        fieldsJson: JSON.stringify({ seq: { kind: 'scalar', type: 'number' } }),
        proposedBy: 'designer',
        proposedAt: new Date(),
        proposedReason: 'stored before the name was reserved',
        applied: true,
        appliedAt: new Date(),
        supersededByCode: false,
        archived: false
      }
    ]);
    const { store, registry } = makeStore(dataset, edges);
    const lines: Array<string | undefined> = [];
    await applyProposalFromNotification({
      namespace: NS,
      proposalId: id,
      registryStore: store,
      onSkip: (r, err) => lines.push(reservedSkipLine(NS, r, err))
    });
    expect(registry.has('Ledger')).toBe(false);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`${NS}/Ledger: field 'seq' is reserved for server metadata`);
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
