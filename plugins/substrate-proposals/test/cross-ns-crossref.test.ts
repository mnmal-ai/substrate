/**
 * End-to-end test for cross-namespace crossRef proposals: two namespaces
 * owned by one plugin instance, and a crossRef field on a type in namespace A
 * pointing at a type in namespace B. Drives loadPlugins + Engine
 * directly, as plugin.test.ts does.
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
import type { CrossRefSpec } from '../src/field-spec-json.js';
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

  return { engine, datasets: memDatasets };
}

const proposeCtx = makeCtx({
  identity: {
    id: 'agent-1',
    tokenId: 'agent-1',
    grants: { '*': ['substrate.propose', 'read', 'mutate'] }
  }
});

const userCtx = makeCtx({
  // Read/mutate only — an empty grant would refuse at the engine gate. No
  // `substrate.propose`: this actor never proposes.
  identity: { id: 'user-1', tokenId: 'user-1', grants: { '*': ['read', 'mutate'] } }
});

describe('cross-NS crossRef propose', () => {
  it('proposes types in two namespaces, adds a crossRef field, creates rows, and reads back the ref', async () => {
    // Step 1 — boot engine owning both namespaces
    const { engine } = await bootEngine(['home', 'household']);

    // Step 2 — propose household/Person { name: string }
    const personTypeEnvelope = await engine.mutate({
      frame: {
        'household/propose_type': {
          params: {
            typeName: 'Person',
            fields: { name: { kind: 'scalar', type: 'string' } },
            proposedBy: 'test-agent',
            proposedReason: 'Need a Person type in household'
          },
          fields: { id: true, typeName: true, applied: true }
        }
      },
      ctx: proposeCtx
    });

    expect(personTypeEnvelope.errors).toBeUndefined();
    const personTypeResult = personTypeEnvelope.data['household/propose_type'] as Record<
      string,
      unknown
    >;
    expect(personTypeResult.applied).toBe(true);
    expect(personTypeResult.typeName).toBe('Person');

    // Step 3 — propose home/Wardrobe { name: string }
    const wardrobeTypeEnvelope = await engine.mutate({
      frame: {
        'home/propose_type': {
          params: {
            typeName: 'Wardrobe',
            fields: { name: { kind: 'scalar', type: 'string' } },
            proposedBy: 'test-agent',
            proposedReason: 'Need a Wardrobe type in home'
          },
          fields: { id: true, typeName: true, applied: true }
        }
      },
      ctx: proposeCtx
    });

    expect(wardrobeTypeEnvelope.errors).toBeUndefined();
    const wardrobeTypeResult = wardrobeTypeEnvelope.data['home/propose_type'] as Record<
      string,
      unknown
    >;
    expect(wardrobeTypeResult.applied).toBe(true);
    expect(wardrobeTypeResult.typeName).toBe('Wardrobe');

    // Step 4 — propose a crossRef field `owner` on home/Wardrobe pointing to household/Person
    const ownerFieldSpec: CrossRefSpec = {
      kind: 'crossRef',
      ns: 'household',
      type: 'Person',
      onDelete: 'set_null'
    };

    const ownerFieldEnvelope = await engine.mutate({
      frame: {
        'home/propose_field': {
          params: {
            targetType: 'Wardrobe',
            fieldName: 'owner',
            fieldSpec: ownerFieldSpec,
            proposedBy: 'test-agent',
            proposedReason: 'Wardrobe belongs to a Person'
          },
          fields: { id: true, targetType: true, fieldName: true, applied: true }
        }
      },
      ctx: proposeCtx
    });

    expect(ownerFieldEnvelope.errors).toBeUndefined();
    const ownerFieldResult = ownerFieldEnvelope.data['home/propose_field'] as Record<
      string,
      unknown
    >;
    expect(ownerFieldResult.applied).toBe(true);
    expect(ownerFieldResult.targetType).toBe('Wardrobe');
    expect(ownerFieldResult.fieldName).toBe('owner');

    // Verify: home/Wardrobe type now has the `owner` field by querying the empty list
    const wardrobeListEnvelope = await engine.query({
      frame: {
        'home/Wardrobe': {
          params: { where: {} },
          fields: { id: true, name: true, owner: true }
        }
      },
      ctx: userCtx
    });
    expect(wardrobeListEnvelope.errors).toBeUndefined();
    expect(Array.isArray(wardrobeListEnvelope.data['home/Wardrobe'])).toBe(true);

    // Step 5 — create a Person row via household/createPerson
    const createPersonEnvelope = await engine.mutate({
      frame: {
        'household/createPerson': {
          params: { name: 'Alice' },
          fields: { id: true, name: true }
        }
      },
      ctx: userCtx
    });

    expect(createPersonEnvelope.errors).toBeUndefined();
    const person = createPersonEnvelope.data['household/createPerson'] as Record<string, unknown>;
    expect(typeof person.id).toBe('string');
    expect(person.name).toBe('Alice');
    const personId = person.id as string;

    // Step 6 — create a Wardrobe row via home/createWardrobe, passing owner = personId
    const createWardrobeEnvelope = await engine.mutate({
      frame: {
        'home/createWardrobe': {
          params: { name: 'Main Wardrobe', owner: personId },
          fields: { id: true, name: true, owner: true }
        }
      },
      ctx: userCtx
    });

    expect(createWardrobeEnvelope.errors).toBeUndefined();
    const wardrobe = createWardrobeEnvelope.data['home/createWardrobe'] as Record<string, unknown>;
    expect(typeof wardrobe.id).toBe('string');
    expect(wardrobe.name).toBe('Main Wardrobe');

    // Step 7 — assert Wardrobe carries owner === personId
    expect(wardrobe.owner).toBe(personId);

    // Verify via a query round-trip too
    const queryEnvelope = await engine.query({
      frame: {
        'home/Wardrobe': {
          params: { where: {} },
          fields: { id: true, name: true, owner: true }
        }
      },
      ctx: userCtx
    });

    expect(queryEnvelope.errors).toBeUndefined();
    const rows = queryEnvelope.data['home/Wardrobe'] as Array<Record<string, unknown>>;
    expect(rows.length).toBe(1);
    expect(rows[0]!.owner).toBe(personId);
  });
});
