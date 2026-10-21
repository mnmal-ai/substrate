/**
 * A proposal applies to the live registry inside the caller's transaction, so
 * a rollback must take the apply back with the row.
 */

import { MemoryEdgesStore, Registry } from '@mnmal-ai/substrate-core';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import type { AfterTxWork, RequestContext, ResolverArgs } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { applyTypeProposal } from '../src/apply.js';
import { createNoopPubSub } from '../src/config.js';
import type { ProposalError } from '../src/errors.js';
import { makeProposeFieldResolver } from '../src/propose-field-resolver.js';
import { makeProposeTypeResolver } from '../src/propose-type-resolver.js';
import { RegistryStore } from '../src/registry-store.js';

const NS = 'fashion';

const ctx: RequestContext = {
  identity: { id: 'test-agent', tokenId: 'test-agent', grants: { [NS]: ['substrate.propose'] } },
  namespace: NS,
  operation: 'mutate',
  now: new Date(),
  headers: {},
  meta: {}
};

function boot() {
  const registry = new Registry();
  const dataset = new MemoryDataset({ namespace: NS });
  const edges = new MemoryEdgesStore({ now: () => new Date() });
  const registryStore = new RegistryStore();
  registryStore.set(NS, { registry, dataset, edges });
  const deps = {
    namespace: NS,
    ownedNamespaces: new Set([NS]),
    registryStore,
    dataset,
    edges,
    pubsub: createNoopPubSub(),
    channelFor: (ns: string) => `substrate_proposals_${ns}`
  };
  return { registry, dataset, edges, registryStore, deps };
}

/** Args whose afterTx work is held so the test can settle the "transaction". */
function txArgs(params: Record<string, unknown>): {
  args: ResolverArgs;
  settle: (committed: boolean) => Promise<void>;
} {
  const queued: AfterTxWork[] = [];
  return {
    args: { params, afterTx: (fn) => queued.push(fn) },
    settle: async (committed) => {
      for (const fn of queued) await fn({ committed });
    }
  };
}

describe('proposal rollback', () => {
  it('a rolled-back propose_type leaves no type or operation registered', async () => {
    const { registry, deps } = boot();
    const before = new Set([...registry.all()].map(([k]) => k));
    const { args, settle } = txArgs({
      typeName: 'Dress',
      fields: { name: { kind: 'scalar', type: 'string' } },
      proposedReason: 'r'
    });
    await makeProposeTypeResolver(deps)(ctx, args);
    expect(registry.has('Dress')).toBe(true);

    await settle(false);

    expect(new Set([...registry.all()].map(([k]) => k))).toEqual(before);
  });

  it('a committed propose_type keeps the type', async () => {
    const { registry, deps } = boot();
    const { args, settle } = txArgs({
      typeName: 'Dress',
      fields: { name: { kind: 'scalar', type: 'string' } },
      proposedReason: 'r'
    });
    await makeProposeTypeResolver(deps)(ctx, args);
    await settle(true);
    expect(registry.has('createDress')).toBe(true);
  });

  it('a rolled-back propose_field restores the type without the field', async () => {
    const { registry, dataset, edges, registryStore, deps } = boot();
    applyTypeProposal({
      namespace: NS,
      typeName: 'Dress',
      fields: { name: { kind: 'scalar', type: 'string' } },
      registryStore,
      dataset,
      edges
    });
    const { args, settle } = txArgs({
      targetType: 'Dress',
      fieldName: 'color',
      fieldSpec: { kind: 'scalar', type: 'string' },
      proposedReason: 'r'
    });
    await makeProposeFieldResolver(deps)(ctx, args);
    expect(registry.get('Dress')?.fields).toHaveProperty('color');

    await settle(false);

    expect(registry.get('Dress')?.fields).not.toHaveProperty('color');
    expect(registry.get('Dress')?.fields).toHaveProperty('name');
  });

  it('a failed apply keeps its underlying error out of the details the caller sees', async () => {
    const { registry, deps } = boot();
    const register = registry.register.bind(registry);
    registry.register = (key, input): void => {
      if ((typeof key === 'string' ? key : key.name) === 'deleteDress') {
        throw new Error('internal detail');
      }
      register(key, input);
    };
    const err = await makeProposeTypeResolver(deps)(ctx, {
      params: { typeName: 'Dress', fields: { name: { kind: 'scalar', type: 'string' } } }
    }).catch((e: unknown) => e as ProposalError);

    expect(err.code).toBe('type_already_exists');
    expect(err.details).toEqual({});
    expect((err as Error & { cause?: unknown }).cause).toBeInstanceOf(Error);
    expect(registry.has('Dress')).toBe(false);
  });
});
