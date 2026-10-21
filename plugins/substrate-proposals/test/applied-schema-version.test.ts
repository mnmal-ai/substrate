/**
 * Applied proposal rows stamp the schemaVersion that RESULTED from the apply.
 *
 * schemaVersion is a hash with no ordering, so the stamped rows are what let
 * a client map "the version I compiled against" to the changes since.
 */

import { MemoryEdgesStore, publishSchema, Registry } from '@mnmal-ai/substrate-core';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import type { RequestContext, ResolverArgs, Row } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { applyTypeProposal } from '../src/apply.js';
import { createNoopPubSub } from '../src/config.js';
import type { FieldSpecJson } from '../src/field-spec-json.js';
import {
  type ProposeFieldResolverDeps as FieldDeps,
  makeProposeFieldResolver
} from '../src/propose-field-resolver.js';
import {
  makeProposeTypeResolver,
  type ProposeTypeResolverDeps as TypeDeps
} from '../src/propose-type-resolver.js';
import { RegistryStore } from '../src/registry-store.js';

const NS = 'fashion';

function makeCtx(): RequestContext {
  return {
    identity: {
      id: 'test-agent',
      tokenId: 'test-agent',
      grants: { '*': ['substrate.propose', 'read', 'mutate'] }
    },
    namespace: NS,
    operation: 'mutate',
    now: new Date(),
    headers: {},
    meta: {}
  };
}

interface Harness {
  registry: Registry;
  dataset: MemoryDataset;
  edges: MemoryEdgesStore;
  registryStore: RegistryStore;
  typeResolver: (ctx: RequestContext, args: ResolverArgs) => Promise<Row>;
  fieldResolver: (ctx: RequestContext, args: ResolverArgs) => Promise<Row>;
}

function boot(): Harness {
  const registry = new Registry();
  const dataset = new MemoryDataset({ namespace: NS });
  const edges = new MemoryEdgesStore({ now: () => new Date() });
  const registryStore = new RegistryStore();
  registryStore.set(NS, { registry, dataset, edges });
  const channelFor = (ns: string): string => `substrate_proposals_${ns}`;

  const typeDeps: TypeDeps = {
    namespace: NS,
    ownedNamespaces: new Set([NS]),
    registryStore,
    dataset,
    edges,
    pubsub: createNoopPubSub(),
    channelFor
  };
  const fieldDeps: FieldDeps = { ...typeDeps };
  return {
    registry,
    dataset,
    edges,
    registryStore,
    typeResolver: makeProposeTypeResolver(typeDeps),
    fieldResolver: makeProposeFieldResolver(fieldDeps)
  };
}

const dressFields: Record<string, FieldSpecJson> = {
  name: { kind: 'scalar', type: 'string' }
};

describe('applied proposal rows stamp resultingSchemaVersion', () => {
  it('propose_type stamps the post-apply schema version', async () => {
    const h = boot();
    const result = await h.typeResolver(makeCtx(), {
      params: {
        typeName: 'Dress',
        fields: dressFields,
        proposedBy: 'test',
        proposedReason: 'r'
      }
    });

    expect(result.applied).toBe(true);
    expect(typeof result.resultingSchemaVersion).toBe('string');
    expect(result.resultingSchemaVersion).toBe(publishSchema(h.registry).schemaVersion);
  });

  it('propose_field stamps the post-apply schema version', async () => {
    const h = boot();
    applyTypeProposal({
      namespace: NS,
      typeName: 'Dress',
      fields: dressFields,
      registryStore: h.registryStore,
      dataset: h.dataset,
      edges: h.edges
    });

    const result = await h.fieldResolver(makeCtx(), {
      params: {
        targetType: 'Dress',
        fieldName: 'color',
        fieldSpec: { kind: 'scalar', type: 'string' } satisfies FieldSpecJson,
        proposedBy: 'test',
        proposedReason: 'r'
      }
    });

    expect(result.applied).toBe(true);
    expect(typeof result.resultingSchemaVersion).toBe('string');
    expect(result.resultingSchemaVersion).toBe(publishSchema(h.registry).schemaVersion);
  });

  it('sequential applies yield distinct stamps — the ordinal anchor', async () => {
    const h = boot();
    const ctx = makeCtx();
    const first = await h.typeResolver(ctx, {
      params: {
        typeName: 'Dress',
        fields: dressFields,
        proposedBy: 'test',
        proposedReason: 'r'
      }
    });
    const second = await h.fieldResolver(ctx, {
      params: {
        targetType: 'Dress',
        fieldName: 'color',
        fieldSpec: { kind: 'scalar', type: 'string' } satisfies FieldSpecJson,
        proposedBy: 'test',
        proposedReason: 'r'
      }
    });

    // A hash that never moves cannot anchor anything; two states, two hashes.
    expect(second.resultingSchemaVersion).not.toBe(first.resultingSchemaVersion);
    expect(second.resultingSchemaVersion).toBe(publishSchema(h.registry).schemaVersion);
  });
});
