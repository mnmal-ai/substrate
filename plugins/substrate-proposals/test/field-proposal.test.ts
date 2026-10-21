/**
 * Tests for the propose_field mutation resolver.
 *
 * Wires dataset + edges + registry + resolver manually, bypassing
 * createProposalsPlugin, and invokes the resolver directly.
 *
 * The harness pre-seeds a Dress type with { name: string } via applyTypeProposal
 * before each test that requires the type to exist.
 */

import { MemoryEdgesStore, Registry } from '@mnmal-ai/substrate-core';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import type { RequestContext, ResolverArgs, Row } from '@mnmal-ai/substrate-types';
import { beforeEach, describe, expect, it } from 'vitest';
import { applyTypeProposal } from '../src/apply.js';
import { createNoopPubSub } from '../src/config.js';
import { ProposalError } from '../src/errors.js';
import type { FieldSpecJson } from '../src/field-spec-json.js';
import {
  makeProposeFieldResolver,
  type ProposeFieldResolverDeps
} from '../src/propose-field-resolver.js';
import { RegistryStore } from '../src/registry-store.js';

const NS = 'fashion';

/** Minimal RequestContext for direct resolver calls. */
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

function makeArgs(params: Record<string, unknown>): ResolverArgs {
  return { params };
}

interface TestHarness {
  registry: Registry;
  dataset: MemoryDataset;
  edges: MemoryEdgesStore;
  registryStore: RegistryStore;
  deps: ProposeFieldResolverDeps;
  resolver: (ctx: RequestContext, args: ResolverArgs) => Promise<Row>;
}

function bootProposeField(ownedNamespaces: string[], bindResolverNs = true): TestHarness {
  const registry = new Registry();
  const dataset = new MemoryDataset({ namespace: NS });
  const edges = new MemoryEdgesStore({ now: () => new Date() });
  const registryStore = new RegistryStore();
  // Default-on: production install always seeds the binding. Opt out via
  // bindResolverNs=false to exercise the propose-field-resolver's
  // pure-unowned rejection path (where neither static ownedNamespaces nor
  // registryStore admit the resolver's namespace).
  if (bindResolverNs) {
    registryStore.set(NS, { registry, dataset, edges });
  }

  const deps: ProposeFieldResolverDeps = {
    namespace: NS,
    ownedNamespaces: new Set(ownedNamespaces),
    registryStore,
    dataset,
    edges,
    pubsub: createNoopPubSub(),
    channelFor: (ns) => `substrate_proposals_${ns}`
  };

  const resolver = makeProposeFieldResolver(deps);

  return { registry, dataset, edges, registryStore, deps, resolver };
}

/** Seed the Dress type with { name: string } via applyTypeProposal. */
function seedDress(harness: TestHarness): void {
  applyTypeProposal({
    namespace: NS,
    typeName: 'Dress',
    fields: { name: { kind: 'scalar', type: 'string' } },
    registryStore: harness.registryStore,
    dataset: harness.dataset,
    edges: harness.edges
  });
}

describe('propose_field resolver', () => {
  let harness: TestHarness;

  beforeEach(() => {
    harness = bootProposeField([NS]);
  });

  it('adds a new field to an existing type', async () => {
    seedDress(harness);

    const { resolver, registryStore } = harness;
    const ctx = makeCtx();
    const args = makeArgs({
      targetType: 'Dress',
      fieldName: 'color',
      fieldSpec: { kind: 'scalar', type: 'string' } satisfies FieldSpecJson,
      proposedBy: 'test',
      proposedReason: 'r'
    });

    const result = await resolver(ctx, args);

    // Row should be marked applied
    expect(result.applied).toBe(true);
    expect(result.targetType).toBe('Dress');
    expect(result.fieldName).toBe('color');

    // Dress entry should now have the color field
    const entry = registryStore.get(NS).get('Dress');
    expect(entry).toBeDefined();
    expect(entry?.fields).toHaveProperty('color');
  });

  it('idempotent noop on exact-match re-propose', async () => {
    seedDress(harness);

    const { resolver } = harness;
    const ctx = makeCtx();
    const args = makeArgs({
      targetType: 'Dress',
      fieldName: 'color',
      fieldSpec: { kind: 'scalar', type: 'string' } satisfies FieldSpecJson,
      proposedBy: 'test',
      proposedReason: 'r'
    });

    // First call — creates and applies the FieldProposal
    const first = await resolver(ctx, args);
    expect(first.applied).toBe(true);
    const firstId = first.id as string;

    // Second call with identical params — must return the same id (no new row)
    const second = await resolver(ctx, args);
    expect(second.id).toBe(firstId);
  });

  it('rejects destructive change (different spec, same field name)', async () => {
    seedDress(harness);

    const { resolver } = harness;
    const ctx = makeCtx();

    // First proposal: color as string
    await resolver(
      ctx,
      makeArgs({
        targetType: 'Dress',
        fieldName: 'color',
        fieldSpec: { kind: 'scalar', type: 'string' } satisfies FieldSpecJson,
        proposedBy: 'test',
        proposedReason: 'r'
      })
    );

    // Second proposal: color as number — destructive change
    await expect(
      resolver(
        ctx,
        makeArgs({
          targetType: 'Dress',
          fieldName: 'color',
          fieldSpec: { kind: 'scalar', type: 'number' } satisfies FieldSpecJson,
          proposedBy: 'test',
          proposedReason: 'changed my mind'
        })
      )
    ).rejects.toSatisfy((err: unknown) => {
      return err instanceof ProposalError && err.code === 'destructive_change_required';
    });
  });

  it('rejects an invalid field spec without writing a proposal row', async () => {
    seedDress(harness);
    const { resolver, dataset } = harness;
    const args = makeArgs({
      targetType: 'Dress',
      fieldName: 'color',
      fieldSpec: { kind: 'scalar', type: 'not-a-type' },
      proposedBy: 'test',
      proposedReason: 'bad spec'
    });

    await expect(resolver(makeCtx(), args)).rejects.toSatisfy((err: unknown) => {
      return err instanceof ProposalError && err.code === 'invalid_field_spec';
    });
    const rows = await dataset.read('FieldProposal', {});
    expect(rows.rows).toHaveLength(0);
  });

  it('rejects when target type unknown', async () => {
    // Empty registry — Dress was never seeded
    const { resolver } = harness;
    const ctx = makeCtx();
    const args = makeArgs({
      targetType: 'Hat',
      fieldName: 'brim',
      fieldSpec: { kind: 'scalar', type: 'string' } satisfies FieldSpecJson,
      proposedBy: 'test',
      proposedReason: 'r'
    });

    await expect(resolver(ctx, args)).rejects.toSatisfy((err: unknown) => {
      return err instanceof ProposalError && err.code === 'unknown_type';
    });
  });

  it('rejects pure-unowned namespace (not in static ownedNamespaces, not in registryStore)', async () => {
    // Mirrors the propose-type gate test in type-proposal.test.ts: rejection
    // needs BOTH `ownedNamespaces` and `registryStore` to miss.
    // bindResolverNs=false skips the registryStore seeding so the
    // deps.namespace is truly unowned.
    const unownedHarness = bootProposeField([], false);
    const { resolver } = unownedHarness;
    const ctx = makeCtx();
    const args = makeArgs({
      targetType: 'Dress',
      fieldName: 'color',
      fieldSpec: { kind: 'scalar', type: 'string' } satisfies FieldSpecJson,
      proposedBy: 'test',
      proposedReason: 'r'
    });

    await expect(resolver(ctx, args)).rejects.toSatisfy((err: unknown) => {
      return err instanceof ProposalError && err.code === 'unowned_namespace';
    });
  });
});
