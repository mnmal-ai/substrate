/**
 * Tests for the propose_type mutation resolver.
 *
 * Wires dataset + edges + registry + resolver manually, bypassing
 * createProposalsPlugin, and invokes the resolver directly.
 *
 * The `substrate.propose` policy gate lives at engine dispatch, not in the
 * resolver, so it is covered in plugin.test.ts rather than here.
 */

import { MemoryEdgesStore, Registry } from '@mnmal-ai/substrate-core';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import type { RequestContext, ResolverArgs, Row } from '@mnmal-ai/substrate-types';
import { beforeEach, describe, expect, it } from 'vitest';
import { createNoopPubSub } from '../src/config.js';
import { ProposalError } from '../src/errors.js';
import type { FieldSpecJson } from '../src/field-spec-json.js';
import {
  makeProposeTypeResolver,
  type ProposeTypeResolverDeps
} from '../src/propose-type-resolver.js';
import { RegistryStore } from '../src/registry-store.js';

const NS = 'fashion';

/** Minimal RequestContext for direct resolver calls (no auth required at resolver level). */
function makeCtx(caps: string[] = ['substrate.propose']): RequestContext {
  return {
    identity: { id: 'test-agent', tokenId: 'test-agent', grants: { [NS]: caps } },
    namespace: NS,
    operation: 'mutate',
    now: new Date(),
    headers: {},
    meta: {}
  };
}

function makeArgs(params: Record<string, unknown>): ResolverArgs {
  return { params };
}

const dressFields: Record<string, FieldSpecJson> = {
  name: { kind: 'scalar', type: 'string' },
  size: { kind: 'scalar', type: 'string', nullable: true }
};

interface TestHarness {
  registry: Registry;
  dataset: MemoryDataset;
  edges: MemoryEdgesStore;
  registryStore: RegistryStore;
  deps: ProposeTypeResolverDeps;
  resolver: (ctx: RequestContext, args: ResolverArgs) => Promise<Row>;
}

function bootProposeType(
  ownedNamespaces: string[],
  options: { bindResolverNs?: boolean } = {}
): TestHarness {
  const { bindResolverNs = true } = options;
  const registry = new Registry();
  const dataset = new MemoryDataset({ namespace: NS });
  const edges = new MemoryEdgesStore({ now: () => new Date() });
  const registryStore = new RegistryStore();
  // Default-on: production install always seeds registryStore for the resolver's
  // own namespace. The "unowned" test below opts out so neither the static
  // ownedNamespaces gate NOR the hot-added registryStore gate matches.
  if (bindResolverNs) {
    registryStore.set(NS, { registry, dataset, edges });
  }

  const deps: ProposeTypeResolverDeps = {
    namespace: NS,
    ownedNamespaces: new Set(ownedNamespaces),
    registryStore,
    dataset,
    edges,
    pubsub: createNoopPubSub(),
    channelFor: (ns) => `substrate_proposals_${ns}`
  };

  const resolver = makeProposeTypeResolver(deps);

  return { registry, dataset, edges, registryStore, deps, resolver };
}

describe('propose_type resolver', () => {
  let harness: TestHarness;

  beforeEach(() => {
    harness = bootProposeType([NS]);
  });

  it('happy path — creates TypeProposal row with applied=true and registers the type', async () => {
    const { resolver, registry } = harness;
    const ctx = makeCtx();
    const args = makeArgs({
      typeName: 'Dress',
      fields: dressFields,
      // A caller-supplied proposer is ignored: the row records the signed identity.
      proposedBy: 'designer-agent',
      proposedReason: 'New garment type needed for catalogue'
    });

    const result = await resolver(ctx, args);

    // Row should be marked applied
    expect(result.applied).toBe(true);
    expect(result.appliedAt).toBeInstanceOf(Date);
    expect(result.typeName).toBe('Dress');
    expect(result.proposedBy).toBe('test-agent');
    expect(result.archived).toBe(false);

    // Type + autoCRUD mutations should now be registered
    expect(registry.has('Dress')).toBe(true);
    expect(registry.has('createDress')).toBe(true);
    expect(registry.has('getDress')).toBe(true);
    expect(registry.has('updateDress')).toBe(true);
    expect(registry.has('deleteDress')).toBe(true);
  });

  it('rejects an exact re-propose for the same typeName', async () => {
    const { resolver } = harness;
    const ctx = makeCtx();
    const args = makeArgs({
      typeName: 'Dress',
      fields: dressFields,
      proposedBy: 'designer-agent',
      proposedReason: 'First proposal'
    });

    // First call should succeed
    await resolver(ctx, args);

    // Second call with same typeName should throw
    const args2 = makeArgs({
      typeName: 'Dress',
      fields: dressFields,
      proposedBy: 'another-agent',
      proposedReason: 'Duplicate proposal'
    });

    await expect(resolver(ctx, args2)).rejects.toSatisfy((err: unknown) => {
      return (
        err instanceof ProposalError &&
        err.code === 'type_already_proposed' &&
        typeof (err.details as Record<string, unknown>).by === 'string'
      );
    });
  });

  it('rejects unowned namespace — plugin not configured for that namespace', async () => {
    // Boot with a different namespace set (does not include NS='fashion').
    // Also skip seeding registryStore for the resolver's own ns so the
    // hot-added gate doesn't admit it either —
    // pure unowned means neither static-config nor hot-added.
    const restrictedHarness = bootProposeType(['home'], { bindResolverNs: false });
    const { resolver } = restrictedHarness;
    const ctx = makeCtx();
    const args = makeArgs({
      typeName: 'Dress',
      fields: dressFields,
      proposedBy: 'designer-agent',
      proposedReason: 'Should fail'
    });

    await expect(resolver(ctx, args)).rejects.toSatisfy((err: unknown) => {
      return err instanceof ProposalError && err.code === 'unowned_namespace';
    });
  });

  it('rejects when the type name is already registered in the live registry', async () => {
    const { resolver, registry } = harness;
    const ctx = makeCtx();

    // Pre-register the type directly to simulate code-declared type
    registry.register('Dress', {
      resolver: async () => [],
      kind: 'type'
    });

    const args = makeArgs({
      typeName: 'Dress',
      fields: dressFields,
      proposedBy: 'designer-agent',
      proposedReason: 'Conflicts with code-declared type'
    });

    await expect(resolver(ctx, args)).rejects.toSatisfy((err: unknown) => {
      return err instanceof ProposalError && err.code === 'type_already_exists';
    });
    const rows = await harness.dataset.read('TypeProposal', {});
    expect(rows.rows).toHaveLength(0);
  });

  it.each(['getDress', 'createDress', 'updateDress', 'deleteDress'])(
    'rejects when autoCRUD operation %s is already registered, without writing a proposal row or registering the type',
    async (opName) => {
      const { resolver, registry, dataset } = harness;
      registry.register(opName, { resolver: async () => null, kind: 'mutation' });

      const args = makeArgs({
        typeName: 'Dress',
        fields: dressFields,
        proposedBy: 'designer-agent',
        proposedReason: 'Conflicts with a code-declared operation'
      });

      await expect(resolver(makeCtx(), args)).rejects.toSatisfy((err: unknown) => {
        return (
          err instanceof ProposalError &&
          err.code === 'type_already_exists' &&
          err.message.includes(opName)
        );
      });
      const rows = await dataset.read('TypeProposal', {});
      expect(rows.rows).toHaveLength(0);
      expect(registry.has('Dress')).toBe(false);
    }
  );

  it('a registered name autoCRUD would NOT install for a proposal does not block it', async () => {
    const { resolver, registry } = harness;
    // Proposed types are installed without the opt-in purge mutation.
    registry.register('purgeDress', { resolver: async () => null, kind: 'mutation' });

    const row = await resolver(
      makeCtx(),
      makeArgs({
        typeName: 'Dress',
        fields: dressFields,
        proposedBy: 'designer-agent',
        proposedReason: 'purge is not part of the proposal surface'
      })
    );
    expect(row.applied).toBe(true);
    expect(registry.has('createDress')).toBe(true);
  });

  it('rejects an invalid field spec without writing a proposal row', async () => {
    const { resolver, dataset } = harness;
    const args = makeArgs({
      typeName: 'Dress',
      fields: { name: { kind: 'scalar', type: 'not-a-type' } },
      proposedBy: 'designer-agent',
      proposedReason: 'bad spec'
    });

    await expect(resolver(makeCtx(), args)).rejects.toSatisfy((err: unknown) => {
      return err instanceof ProposalError && err.code === 'invalid_field_spec';
    });
    const rows = await dataset.read('TypeProposal', {});
    expect(rows.rows).toHaveLength(0);
  });

  it.each([
    ['an empty typeName', { typeName: '', fields: dressFields }],
    ['a typeName with a slash', { typeName: 'lower case/x', fields: dressFields }],
    ['missing fields', { typeName: 'Dress' }],
    ['empty fields', { typeName: 'Dress', fields: {} }],
    ['a field name with a slash', { typeName: 'Dress', fields: { 'a/b': dressFields.name } }]
  ])('refuses %s with invalid_params and registers nothing', async (_label, params) => {
    const { resolver, registry, dataset } = harness;
    await expect(resolver(makeCtx(), makeArgs(params))).rejects.toSatisfy(
      (err: unknown) => err instanceof ProposalError && err.code === 'invalid_params'
    );
    expect([...registry.all()]).toHaveLength(0);
    expect((await dataset.read('TypeProposal', {})).rows).toHaveLength(0);
  });

  it.each([
    ['a nonexistent namespace', { kind: 'crossRef', ns: 'nonexistent', type: 'Nope' }],
    ['an unregistered type', { kind: 'crossRef', ns: NS, type: 'Nope' }],
    ['the control plane', { kind: 'crossRef', ns: '_system_proposals', type: 'NamespaceProposal' }],
    ['a nested list target', { kind: 'list', of: { kind: 'crossRef', ns: 'other', type: 'X' } }]
  ])('refuses a crossRef into %s', async (_label, spec) => {
    const { resolver, dataset } = harness;
    await expect(
      resolver(makeCtx(), makeArgs({ typeName: 'Dress', fields: { ref: spec } }))
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof ProposalError && err.code === 'invalid_field_spec'
    );
    expect((await dataset.read('TypeProposal', {})).rows).toHaveLength(0);
  });

  it('accepts a crossRef to the type being proposed', async () => {
    const result = await harness.resolver(
      makeCtx(),
      makeArgs({
        typeName: 'Dress',
        fields: { parent: { kind: 'crossRef', ns: NS, type: 'Dress', nullable: true } }
      })
    );
    expect(result.applied).toBe(true);
  });
});
