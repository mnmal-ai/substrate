import { MemoryEdgesStore, Registry } from '@mnmal-ai/substrate-core';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { installAutoCrud, RESERVED_AUTOCRUD_FIELDS } from '@mnmal-ai/substrate-sdk';
import type { Policy, RequestContext } from '@mnmal-ai/substrate-types';
import { describe, expect, it, vi } from 'vitest';
import { applyFieldProposal, applyTypeProposal } from '../src/apply.js';
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

describe('applyFieldProposal', () => {
  it('adds a scalar field to an existing type', () => {
    const { registry, dataset, edges, registryStore } = makeTestDeps();

    // Register Dress with a single field first
    applyTypeProposal({
      namespace: NS,
      typeName: 'Dress',
      fields: { name: { kind: 'scalar', type: 'string' } } satisfies Record<string, FieldSpecJson>,
      registryStore,
      dataset,
      edges
    });

    // Now add a field via applyFieldProposal
    applyFieldProposal({
      namespace: NS,
      targetType: 'Dress',
      fieldName: 'color',
      fieldSpec: { kind: 'scalar', type: 'string' },
      registryStore,
      dataset,
      edges
    });

    const entry = registry.get('Dress');
    if (!entry) throw new Error('expected Dress entry to be registered');
    const keys = Object.keys(entry.fields).sort();
    expect(keys).toContain('name');
    expect(keys).toContain('color');
  });

  it('refuses a proposal type as the target', () => {
    const { registry, dataset, edges, registryStore } = makeTestDeps();
    installAutoCrud(registry, 'TypeProposal', dataset, edges, {
      fields: { typeName: { kind: 'scalar', type: 'string' }, ...RESERVED_AUTOCRUD_FIELDS }
    });
    expect(() =>
      applyFieldProposal({
        namespace: NS,
        targetType: 'TypeProposal',
        fieldName: 'color',
        fieldSpec: { kind: 'scalar', type: 'string' },
        registryStore,
        dataset,
        edges
      })
    ).toThrow(/proposal type/);
  });

  it('keeps the type policy and postWrite through the reinstall', async () => {
    const { registry, dataset, edges, registryStore } = makeTestDeps();
    const policy: Policy = () => ({ allow: true });
    const postWrite = vi.fn().mockResolvedValue(undefined);
    installAutoCrud(registry, 'Dress', dataset, edges, {
      fields: { name: { kind: 'scalar', type: 'string' }, ...RESERVED_AUTOCRUD_FIELDS },
      policy,
      postWrite
    });
    applyFieldProposal({
      namespace: NS,
      targetType: 'Dress',
      fieldName: 'color',
      fieldSpec: { kind: 'scalar', type: 'string' },
      registryStore,
      dataset,
      edges
    });
    expect(registry.get('Dress')?.policy).toBe(policy);
    expect(registry.get('createDress')?.policy).toBe(policy);
    const ctx = {
      identity: { kind: 'system', id: 'test', grants: { '*': ['read', 'mutate'] } },
      namespace: NS,
      operation: 'mutate',
      now: new Date(),
      headers: {},
      meta: {}
    } as RequestContext;
    await registry.get('createDress')?.resolver(ctx, {
      params: { name: 'd', color: 'red' },
      fields: { id: true }
    } as never);
    expect(postWrite).toHaveBeenCalledTimes(1);
  });

  it('throws when target type not registered', () => {
    const { dataset, edges, registryStore } = makeTestDeps();

    expect(() =>
      applyFieldProposal({
        namespace: NS,
        targetType: 'Ghost',
        fieldName: 'color',
        fieldSpec: { kind: 'scalar', type: 'string' },
        registryStore,
        dataset,
        edges
      })
    ).toThrow(/not registered/);
  });

  it('invokes the binding invalidator post-replace', () => {
    const { dataset, edges, registryStore } = makeTestDeps();
    let invalidations = 0;
    registryStore.setInvalidator(NS, () => {
      invalidations += 1;
    });

    // applyTypeProposal also fires the invalidator: register the type via a
    // direct registry.register first to isolate the field-proposal call.
    applyTypeProposal({
      namespace: NS,
      typeName: 'Dress',
      fields: { name: { kind: 'scalar', type: 'string' } } satisfies Record<string, FieldSpecJson>,
      registryStore,
      dataset,
      edges
    });
    expect(invalidations).toBe(1);

    applyFieldProposal({
      namespace: NS,
      targetType: 'Dress',
      fieldName: 'color',
      fieldSpec: { kind: 'scalar', type: 'string' },
      registryStore,
      dataset,
      edges
    });
    expect(invalidations).toBe(2);
  });

  it('apply path is a no-op for invalidator when none is wired (back-compat)', () => {
    // The install-time reconcile path runs before onStart wires an
    // invalidator, so apply.ts must work without one.
    const { dataset, edges, registryStore } = makeTestDeps();

    applyTypeProposal({
      namespace: NS,
      typeName: 'Dress',
      fields: { name: { kind: 'scalar', type: 'string' } } satisfies Record<string, FieldSpecJson>,
      registryStore,
      dataset,
      edges
    });
    expect(() =>
      applyFieldProposal({
        namespace: NS,
        targetType: 'Dress',
        fieldName: 'color',
        fieldSpec: { kind: 'scalar', type: 'string' },
        registryStore,
        dataset,
        edges
      })
    ).not.toThrow();
  });
});
