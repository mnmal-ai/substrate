/**
 * Value-map migration utility for class-3 (vocabulary) schema changes.
 *
 * Covers the utility (scan → plan → apply → verify against a memory
 * dataset) and the propose_field wiring (destructive path migrates first
 * with a map, still refuses without one).
 */

import {
  MigrationError,
  migrateFieldValues,
  planMigration,
  scanNonconforming,
  type ValueMap
} from '@mnmal-ai/substrate-compose';
import { MemoryEdgesStore, Registry } from '@mnmal-ai/substrate-core';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import type { RequestContext, ResolverArgs, Row } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { applyTypeProposal } from '../src/apply.js';
import { createNoopPubSub } from '../src/config.js';
import { ProposalError } from '../src/errors.js';
import type { FieldSpecJson } from '../src/field-spec-json.js';
import {
  makeProposeFieldResolver,
  type ProposeFieldResolverDeps
} from '../src/propose-field-resolver.js';
import { RegistryStore } from '../src/registry-store.js';

const NS = 'migration-test';

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

interface Seed {
  dataset: MemoryDataset;
  registry: Registry;
  registryStore: RegistryStore;
}

/** Dataset holding Gadget rows: 3×'old-a', 2×'keep', 1×'old-b'. */
async function seedGadgets(): Promise<Seed> {
  const registry = new Registry();
  const dataset = new MemoryDataset({ namespace: NS });
  const edges = new MemoryEdgesStore({ now: () => new Date() });
  const registryStore = new RegistryStore();
  registryStore.set(NS, { registry, dataset, edges });
  applyTypeProposal({
    namespace: NS,
    typeName: 'Gadget',
    fields: {
      status: { kind: 'scalar', type: 'string', enum: [...OLD_VOCAB] }
    },
    registryStore,
    dataset,
    edges
  });
  await dataset.write('Gadget', [
    { id: 'g1', status: 'old-a' },
    { id: 'g2', status: 'old-a' },
    { id: 'g3', status: 'old-a' },
    { id: 'g4', status: 'keep' },
    { id: 'g5', status: 'keep' },
    { id: 'g6', status: 'old-b' }
  ]);
  return { dataset, registry, registryStore };
}

function fieldResolver(seed: Seed): (ctx: RequestContext, args: ResolverArgs) => Promise<Row> {
  const edges = new MemoryEdgesStore({ now: () => new Date() });
  const deps: ProposeFieldResolverDeps = {
    namespace: NS,
    ownedNamespaces: new Set([NS]),
    registryStore: seed.registryStore,
    dataset: seed.dataset,
    edges,
    pubsub: createNoopPubSub(),
    channelFor: (ns) => `substrate_proposals_${ns}`
  };
  return makeProposeFieldResolver(deps);
}

const NEW_VOCAB = ['new-a', 'keep'] as const;
// 'new-a' is already declared but unused — the realistic consolidation:
// retiring synonyms onto an existing word, legal under both vocabularies.
const OLD_VOCAB = ['old-a', 'old-b', 'keep', 'new-a'] as const;

describe('scanNonconforming', () => {
  it('tallies offenders per value with counts across pages', async () => {
    const { dataset } = await seedGadgets();
    const scan = await scanNonconforming({
      dataset,
      namespace: NS,
      type: 'Gadget',
      field: 'status',
      vocabulary: [...NEW_VOCAB],
      rowsPerPage: 2
    });
    expect(scan.rowsScanned).toBe(6);
    expect(scan.truncated).toBe(false);
    expect(scan.offenders.map((o) => ({ value: o.value, count: o.count }))).toEqual([
      { value: 'old-a', count: 3 },
      { value: 'old-b', count: 1 }
    ]);
    expect(scan.offenders[0]?.ids).toEqual(['g1', 'g2', 'g3']);
  });

  it('reports a clean scan as zero offenders', async () => {
    const { dataset } = await seedGadgets();
    const scan = await scanNonconforming({
      dataset,
      namespace: NS,
      type: 'Gadget',
      field: 'status',
      vocabulary: [...OLD_VOCAB]
    });
    expect(scan.offenders).toEqual([]);
  });
});

describe('planMigration', () => {
  it('refuses unmapped offenders rather than silently stranding', async () => {
    const { dataset } = await seedGadgets();
    const scan = await scanNonconforming({
      dataset,
      namespace: NS,
      type: 'Gadget',
      field: 'status',
      vocabulary: [...NEW_VOCAB]
    });
    const map: ValueMap = { 'old-a': 'new-a' };
    expect(() =>
      planMigration(scan, map, { oldVocabulary: [...OLD_VOCAB], newVocabulary: [...NEW_VOCAB] })
    ).toThrowError(MigrationError);
    try {
      planMigration(scan, map, { oldVocabulary: [...OLD_VOCAB], newVocabulary: [...NEW_VOCAB] });
      expect.unreachable();
    } catch (err) {
      expect((err as MigrationError).code).toBe('unmapped_source_values');
    }
  });

  it('refuses targets outside the new vocabulary', async () => {
    const { dataset } = await seedGadgets();
    const scan = await scanNonconforming({
      dataset,
      namespace: NS,
      type: 'Gadget',
      field: 'status',
      vocabulary: [...NEW_VOCAB]
    });
    const map: ValueMap = { 'old-a': 'nope', 'old-b': 'new-a' };
    try {
      planMigration(scan, map, { oldVocabulary: [...OLD_VOCAB], newVocabulary: [...NEW_VOCAB] });
      expect.unreachable();
    } catch (err) {
      expect((err as MigrationError).code).toBe('target_outside_new_vocabulary');
    }
  });

  it('refuses targets the current gate would reject', async () => {
    const { dataset } = await seedGadgets();
    const scan = await scanNonconforming({
      dataset,
      namespace: NS,
      type: 'Gadget',
      field: 'status',
      vocabulary: [...NEW_VOCAB]
    });
    // 'keep' is in the new vocabulary but outside this narrowed old gate —
    // writing it pre-narrowing would trip the still-active gate.
    const map: ValueMap = { 'old-a': 'keep', 'old-b': 'new-a' };
    try {
      planMigration(scan, map, {
        oldVocabulary: ['old-a', 'old-b'],
        newVocabulary: [...NEW_VOCAB]
      });
      expect.unreachable();
    } catch (err) {
      expect((err as MigrationError).code).toBe('target_violates_current_gate');
    }
  });
});

describe('migrateFieldValues', () => {
  it('migrates and verifies clean', async () => {
    const { dataset } = await seedGadgets();
    const result = await migrateFieldValues(
      {
        dataset,
        namespace: NS,
        type: 'Gadget',
        field: 'status',
        vocabulary: [...NEW_VOCAB]
      },
      { 'old-a': 'new-a', 'old-b': 'new-a' },
      { oldVocabulary: [...OLD_VOCAB] }
    );
    expect(result.migrated).toEqual([
      { from: 'old-a', to: 'new-a', count: 3 },
      { from: 'old-b', to: 'new-a', count: 1 }
    ]);
    expect(result.stranded).toEqual([]);
    const readBack = await dataset.read('Gadget', { orderBy: [{ id: 'asc' }], limit: 10 });
    expect(readBack.rows.map((r) => (r as Record<string, unknown>).status)).toEqual([
      'new-a',
      'new-a',
      'new-a',
      'keep',
      'keep',
      'new-a'
    ]);
  });

  it('REJECT strands knowingly and verifies against the REJECT set', async () => {
    const { dataset } = await seedGadgets();
    const result = await migrateFieldValues(
      {
        dataset,
        namespace: NS,
        type: 'Gadget',
        field: 'status',
        vocabulary: [...NEW_VOCAB]
      },
      { 'old-a': 'new-a', 'old-b': null },
      { oldVocabulary: [...OLD_VOCAB] }
    );
    expect(result.stranded).toEqual([{ value: 'old-b', count: 1 }]);
    const readBack = await dataset.read('Gadget', { where: { id: { eq: 'g6' } } });
    expect((readBack.rows[0] as Record<string, unknown>).status).toBe('old-b');
  });
});

describe('propose_field destructive path with valueMap', () => {
  const narrowedSpec = {
    kind: 'scalar',
    type: 'string',
    enum: [...NEW_VOCAB]
  } as const;

  function proposeArgs(valueMap?: ValueMap): ResolverArgs {
    return {
      params: {
        targetType: 'Gadget',
        fieldName: 'status',
        fieldSpec: { ...narrowedSpec } as unknown as FieldSpecJson,
        proposedBy: 'test',
        proposedReason: 'narrow the status vocabulary',
        ...(valueMap !== undefined ? { valueMap } : {})
      }
    };
  }

  it('still refuses without a map — and names the migration', async () => {
    const seed = await seedGadgets();
    try {
      await fieldResolver(seed)(makeCtx(), proposeArgs());
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ProposalError);
      expect((err as ProposalError).code).toBe('destructive_change_required');
      expect((err as Error).message).toMatch(/valueMap/);
    }
  });

  it('migrates first, then narrows, and records the map on the row', async () => {
    const seed = await seedGadgets();
    const result = await fieldResolver(seed)(
      makeCtx(),
      proposeArgs({ 'old-a': 'new-a', 'old-b': 'new-a' })
    );
    expect(result.applied).toBe(true);
    expect(result.valueMapJson).toBe(JSON.stringify({ 'old-a': 'new-a', 'old-b': 'new-a' }));
    const migration = result.migration as {
      migrated: Array<{ from: string; to: string; count: number }>;
      stranded: unknown[];
    };
    expect(migration.migrated).toEqual([
      { from: 'old-a', to: 'new-a', count: 3 },
      { from: 'old-b', to: 'new-a', count: 1 }
    ]);
    expect(migration.stranded).toEqual([]);
    // Narrowing landed: the registry now declares the new vocabulary...
    const entry = seed.registry.get('Gadget');
    const def = entry?.fields.status;
    expect(def?.kind === 'scalar' && def.enum).toEqual([...NEW_VOCAB]);
    // ...and every stored row satisfies it.
    const readBack = await seed.dataset.read('Gadget', { limit: 10 });
    for (const row of readBack.rows) {
      expect([...NEW_VOCAB]).toContain((row as Record<string, unknown>).status);
    }
  });

  it('refuses a map when the proposed spec declares no vocabulary', async () => {
    const seed = await seedGadgets();
    try {
      await fieldResolver(seed)(makeCtx(), {
        params: {
          targetType: 'Gadget',
          fieldName: 'status',
          fieldSpec: { kind: 'scalar', type: 'string' } as unknown as FieldSpecJson,
          proposedBy: 'test',
          proposedReason: 'drop the enum',
          valueMap: { 'old-a': 'keep' }
        }
      });
      expect.unreachable();
    } catch (err) {
      expect((err as ProposalError).code).toBe('destructive_change_required');
    }
  });
});
