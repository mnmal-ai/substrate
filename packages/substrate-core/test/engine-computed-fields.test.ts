/**
 * Computed-field projection gate. The engine rejects a query
 * that projects a computed field (`_score`/`_vector`) without the extension
 * operator that computes it present in the where-clause. The gate fires on the
 * query+type+dataset path, including when `where` is undefined entirely.
 *
 * This also keeps pg's body projection from materialising a stray
 * `_score: null` on a non-semantic read: a projection of `_score` without the
 * operator never dispatches.
 */

import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import { clearExtensionOperators, registerExtensionOperator } from '@mnmal-ai/substrate-filter';
import type { EdgesStore, FilterOperatorDef, RequestContext, Row } from '@mnmal-ai/substrate-types';
import { afterEach, describe, expect, it } from 'vitest';
import {
  Engine,
  MemoryEdgesStore,
  type NamespaceConfig,
  Registry,
  type Resolver
} from '../src/index.js';

function makeEdges(): MemoryEdgesStore {
  return new MemoryEdgesStore({ now: () => new Date('2026-04-18T00:00:00Z') });
}

function makeCtx(overrides: Partial<RequestContext> = {}): Partial<RequestContext> {
  return {
    identity: null,
    now: new Date('2026-04-18T00:00:00Z'),
    headers: {},
    meta: {},
    ...overrides
  };
}

function singleNs(
  registry: Registry,
  dataset: MemoryDataset = new MemoryDataset({ namespace: 'default' }),
  edges: EdgesStore = makeEdges()
): { engine: Engine } {
  const namespaces = new Map<string, NamespaceConfig>([['default', { registry }]]);
  const datasets = new MemoryDatasetRegistry();
  datasets.set('default', dataset);
  return { engine: new Engine({ namespaces, datasets, edges }) };
}

// A semantic operator that owns the `_score` + `_vector` computed projections,
// mirroring substrate-recall's embeddingSimilar.
const similarOp: FilterOperatorDef = {
  computedFields: ['_score', '_vector'],
  validate: (value) => ({ ok: true, value }),
  execute: async () => ({ hits: [] })
};

afterEach(() => {
  clearExtensionOperators();
});

describe('Engine — computed-field projection gate', () => {
  it('allows projecting _score WHEN the semantic operator is in where', async () => {
    registerExtensionOperator('embeddingSimilar', similarOp);
    const rows: Row[] = [{ id: 'r1' }];
    const registry = new Registry();
    const resolver: Resolver = async () => rows;
    registry.register('Track', { resolver });

    const { engine } = singleNs(registry);
    const envelope = await engine.query({
      frame: {
        'default/Track': {
          params: { where: { embeddingSimilar: { to: 'jazz' } } },
          fields: { id: true, _score: true }
        }
      },
      ctx: makeCtx()
    });

    // Resolver dispatches; rows may or may not carry _score (dataset stitching
    // is tested elsewhere). The contract here is simply: no envelope error.
    expect(envelope.errors).toBeUndefined();
  });

  it('rejects projecting _score with NO where at all', async () => {
    registerExtensionOperator('embeddingSimilar', similarOp);
    const registry = new Registry();
    registry.register('Track', { resolver: async () => [] });

    const { engine } = singleNs(registry);
    const envelope = await engine.query({
      frame: { 'default/Track': { fields: { id: true, _score: true } } },
      ctx: makeCtx()
    });

    expect(envelope.errors?.[0]?.code).toBe('computed_field_unavailable');
    expect(envelope.errors?.[0]?.path).toEqual(['default/Track', '_score']);
    expect(envelope.errors?.[0]?.message).toContain('_score');
    expect(envelope.errors?.[0]?.message).toContain('embeddingSimilar');
  });

  it('rejects projecting _score with a structural-only where (no extension op)', async () => {
    registerExtensionOperator('embeddingSimilar', similarOp);
    const registry = new Registry();
    registry.register('Track', { resolver: async () => [] });

    const { engine } = singleNs(registry);
    const envelope = await engine.query({
      frame: {
        'default/Track': {
          params: { where: { id: { eq: 'r1' } } },
          fields: { id: true, _score: true }
        }
      },
      ctx: makeCtx()
    });

    expect(envelope.errors?.[0]?.code).toBe('computed_field_unavailable');
    expect(envelope.errors?.[0]?.path).toEqual(['default/Track', '_score']);
  });

  it('rejects projecting _vector with NO where at all', async () => {
    registerExtensionOperator('embeddingSimilar', similarOp);
    const registry = new Registry();
    registry.register('Track', { resolver: async () => [] });

    const { engine } = singleNs(registry);
    const envelope = await engine.query({
      frame: { 'default/Track': { fields: { id: true, _vector: true } } },
      ctx: makeCtx()
    });

    expect(envelope.errors?.[0]?.code).toBe('computed_field_unavailable');
    expect(envelope.errors?.[0]?.path).toEqual(['default/Track', '_vector']);
    expect(envelope.errors?.[0]?.message).toContain('_vector');
    expect(envelope.errors?.[0]?.message).toContain('embeddingSimilar');
  });

  it('does not reject an unknown non-computed underscore field (fields are a hint)', async () => {
    registerExtensionOperator('embeddingSimilar', similarOp);
    const registry = new Registry();
    registry.register('Track', { resolver: async () => [] });

    const { engine } = singleNs(registry);
    const envelope = await engine.query({
      frame: { 'default/Track': { fields: { id: true, _whatever: true } } },
      ctx: makeCtx()
    });

    expect(envelope.errors).toBeUndefined();
  });
});
