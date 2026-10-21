import { DuplicateRegistration, MemoryEdgesStore, Registry } from '@mnmal-ai/substrate-core';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { describe, expect, it } from 'vitest';
import { applyTypeProposal } from '../src/apply.js';
import type { FieldSpecJson } from '../src/field-spec-json.js';
import { RegistryStore } from '../src/registry-store.js';

const NS = 'fashion';

function makeTestDeps() {
  const registry = new Registry();
  const dataset = new MemoryDataset({ namespace: NS });
  const edges = new MemoryEdgesStore({ now: () => new Date() });
  const registryStore = new RegistryStore();
  registryStore.set(NS, { registry, dataset, edges });
  return { registry, dataset, edges, registryStore };
}

const dressFields: Record<string, FieldSpecJson> = {
  name: { kind: 'scalar', type: 'string' },
  size: { kind: 'scalar', type: 'string', nullable: true }
};

describe('applyTypeProposal', () => {
  it('registers the type + create/get/update/delete mutations', () => {
    const { registry, dataset, edges, registryStore } = makeTestDeps();

    applyTypeProposal({
      namespace: NS,
      typeName: 'Dress',
      fields: dressFields,
      registryStore,
      dataset,
      edges
    });

    expect(registry.has('Dress')).toBe(true);
    expect(registry.has('createDress')).toBe(true);
    expect(registry.has('getDress')).toBe(true);
    expect(registry.has('updateDress')).toBe(true);
    expect(registry.has('deleteDress')).toBe(true);
  });

  it('throws DuplicateRegistration when type already registered', () => {
    const { registry, dataset, edges, registryStore } = makeTestDeps();

    // Pre-register the type directly to simulate an already-existing type.
    registry.register('Dress', {
      resolver: async () => [],
      kind: 'type'
    });

    expect(() =>
      applyTypeProposal({
        namespace: NS,
        typeName: 'Dress',
        fields: dressFields,
        registryStore,
        dataset,
        edges
      })
    ).toThrow(DuplicateRegistration);
  });

  it('injects readonly+indexed shortId so autoCRUD allocates it on create', () => {
    const { registry, registryStore, dataset, edges } = makeTestDeps();

    applyTypeProposal({
      namespace: NS,
      typeName: 'Dress',
      fields: dressFields,
      registryStore,
      dataset,
      edges
    });

    const entry = registry.get('Dress');
    if (!entry) throw new Error('expected Dress entry to be registered');
    const shortIdDef = entry.fields.shortId;
    expect(shortIdDef).toBeDefined();
    expect(shortIdDef?.kind).toBe('scalar');
    if (shortIdDef?.kind !== 'scalar') throw new Error('expected scalar shortId');
    expect(shortIdDef.type).toBe('number');
    expect(shortIdDef.readonly).toBe(true);
    expect(shortIdDef.indexed).toBe(true);
  });
});
