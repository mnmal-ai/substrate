/**
 * ExpansionResolver tests. Uses the same SpreadEdgeRegistry the spread
 * mechanism populates: the opt-in is shared.
 */

import type { Edge, EdgeRef, EdgesStore } from '@mnmal-ai/substrate-types';
import { describe, expect, it, vi } from 'vitest';
import { type ExpansionConfig, makeExpansionResolver } from '../src/expansion-resolver.js';
import { SpreadEdgeRegistry } from '../src/spread-resolver.js';

const DEFAULT_CFG: ExpansionConfig = { maxNeighboursPerSeed: 8, maxTotalNeighbours: 50 };

function makeEdgesStub(inboundByRef: Record<string, Edge[]>): EdgesStore {
  const key = (r: EdgeRef): string => `${r.ns}/${r.type}/${r.id}`;
  return {
    txScopeId: 'stub',
    write: async () => {
      throw new Error('not implemented');
    },
    tombstone: async () => undefined,
    update: async () => undefined,
    readNextBatch: async () => ({ edges: [], lastId: null }),
    findEdgesTo: async (ref) => inboundByRef[key(ref)] ?? [],
    findEdgesToMany: async (refs) => refs.flatMap((r) => inboundByRef[key(r)] ?? []),
    findEdgesFrom: async () => [],
    canDelete: async () => ({ ok: true }),
    findBlocked: async () => [],
    findEdgesTouchingNamespace: async () => [],
    findEdgesTouchingType: async () => [],
    dropEdgesByNamespace: async () => 0,
    namespacesLinkedTo: async () => [],
    dropEdgesByType: async () => 0,
    withTransaction: async (fn) => fn(makeEdgesStub({}))
  };
}

describe('ExpansionResolver — forward', () => {
  it('returns empty when no fields are opt-in', async () => {
    const registry = new SpreadEdgeRegistry();
    const resolve = makeExpansionResolver(registry, null, DEFAULT_CFG);
    const out = await resolve([
      { namespace: 'claude', type: 'Decision', id: 'dec-1', row: { id: 'dec-1' } }
    ]);
    expect(out).toEqual([]);
  });

  it('walks forward crossRef field values declared opt-in', async () => {
    const registry = new SpreadEdgeRegistry();
    registry.add('claude', 'Decision', {
      fieldName: 'establishesConcept',
      targetNs: 'claude',
      targetType: 'Concept'
    });
    const resolve = makeExpansionResolver(registry, null, DEFAULT_CFG);
    const out = await resolve([
      {
        namespace: 'claude',
        type: 'Decision',
        id: 'dec-1',
        row: { id: 'dec-1', establishesConcept: 'concept-xyz' }
      }
    ]);
    expect(out).toEqual([
      {
        namespace: 'claude',
        type: 'Concept',
        id: 'concept-xyz',
        seedId: 'dec-1',
        allowsCrossType: false
      }
    ]);
  });

  it('dedupes targets reached from multiple seeds (first seed wins)', async () => {
    const registry = new SpreadEdgeRegistry();
    registry.add('claude', 'Decision', {
      fieldName: 'establishesConcept',
      targetNs: 'claude',
      targetType: 'Concept'
    });
    const resolve = makeExpansionResolver(registry, null, DEFAULT_CFG);
    const out = await resolve([
      {
        namespace: 'claude',
        type: 'Decision',
        id: 'dec-A',
        row: { id: 'dec-A', establishesConcept: 'concept-shared' }
      },
      {
        namespace: 'claude',
        type: 'Decision',
        id: 'dec-B',
        row: { id: 'dec-B', establishesConcept: 'concept-shared' }
      }
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: 'concept-shared', seedId: 'dec-A' });
  });

  it('skips targets that are themselves in the seed set', async () => {
    const registry = new SpreadEdgeRegistry();
    registry.add('claude', 'Decision', {
      fieldName: 'supersedes',
      targetNs: 'claude',
      targetType: 'Decision'
    });
    const resolve = makeExpansionResolver(registry, null, DEFAULT_CFG);
    const out = await resolve([
      {
        namespace: 'claude',
        type: 'Decision',
        id: 'dec-1',
        row: { id: 'dec-1', supersedes: 'dec-2' }
      },
      { namespace: 'claude', type: 'Decision', id: 'dec-2', row: { id: 'dec-2' } }
    ]);
    expect(out).toEqual([]);
  });
});

function makeEdge(from: EdgeRef, to: EdgeRef, fieldName: string): Edge {
  return {
    id: `edge-${from.id}-${fieldName}-${to.id}`,
    from,
    to,
    fieldName,
    policy: 'set_null',
    createdAt: new Date()
  };
}

describe('ExpansionResolver — backward', () => {
  it('walks inbound edges whose from-type opted in', async () => {
    const registry = new SpreadEdgeRegistry();
    registry.add('claude', 'Decision', {
      fieldName: 'establishesConcept',
      targetNs: 'claude',
      targetType: 'Concept'
    });
    const edges = makeEdgesStub({
      'claude/Concept/concept-1': [
        makeEdge(
          { ns: 'claude', type: 'Decision', id: 'dec-99' },
          { ns: 'claude', type: 'Concept', id: 'concept-1' },
          'establishesConcept'
        )
      ]
    });
    const resolve = makeExpansionResolver(registry, edges, DEFAULT_CFG);
    const out = await resolve([
      { namespace: 'claude', type: 'Concept', id: 'concept-1', row: { id: 'concept-1' } }
    ]);
    expect(out).toEqual([
      {
        namespace: 'claude',
        type: 'Decision',
        id: 'dec-99',
        seedId: 'concept-1',
        allowsCrossType: false
      }
    ]);
  });

  it('issues exactly one batched findEdgesToMany for many seeds', async () => {
    const registry = new SpreadEdgeRegistry();
    registry.add('claude', 'Decision', {
      fieldName: 'establishesConcept',
      targetNs: 'claude',
      targetType: 'Concept'
    });
    const base = makeEdgesStub({
      'claude/Concept/c1': [
        makeEdge(
          { ns: 'claude', type: 'Decision', id: 'd-a' },
          { ns: 'claude', type: 'Concept', id: 'c1' },
          'establishesConcept'
        )
      ],
      'claude/Concept/c2': [
        makeEdge(
          { ns: 'claude', type: 'Decision', id: 'd-b' },
          { ns: 'claude', type: 'Concept', id: 'c2' },
          'establishesConcept'
        )
      ]
    });
    const toManySpy = vi.fn(base.findEdgesToMany);
    const toSpy = vi.fn(base.findEdgesTo);
    const edges: EdgesStore = { ...base, findEdgesToMany: toManySpy, findEdgesTo: toSpy };
    const resolve = makeExpansionResolver(registry, edges, DEFAULT_CFG);

    const out = await resolve([
      { namespace: 'claude', type: 'Concept', id: 'c1', row: { id: 'c1' } },
      { namespace: 'claude', type: 'Concept', id: 'c2', row: { id: 'c2' } },
      { namespace: 'claude', type: 'Concept', id: 'c3', row: { id: 'c3' } }
    ]);

    // ONE round-trip regardless of seed count; per-seed grouping happens in JS.
    expect(toManySpy).toHaveBeenCalledTimes(1);
    expect(toSpy).not.toHaveBeenCalled();
    // Each neighbour is attributed to the correct seed.
    expect(out).toEqual(
      expect.arrayContaining([
        { namespace: 'claude', type: 'Decision', id: 'd-a', seedId: 'c1', allowsCrossType: false },
        { namespace: 'claude', type: 'Decision', id: 'd-b', seedId: 'c2', allowsCrossType: false }
      ])
    );
  });

  it('skips inbound edges whose from-type did NOT opt in', async () => {
    const registry = new SpreadEdgeRegistry();
    // No registrations — Decision.establishesConcept is NOT opt-in here.
    const edges = makeEdgesStub({
      'claude/Concept/concept-1': [
        makeEdge(
          { ns: 'claude', type: 'Decision', id: 'dec-99' },
          { ns: 'claude', type: 'Concept', id: 'concept-1' },
          'establishesConcept'
        )
      ]
    });
    const resolve = makeExpansionResolver(registry, edges, DEFAULT_CFG);
    const out = await resolve([
      { namespace: 'claude', type: 'Concept', id: 'concept-1', row: { id: 'concept-1' } }
    ]);
    expect(out).toEqual([]);
  });

  it('memory-mode (edges=null) no-ops backward but forward still works', async () => {
    const registry = new SpreadEdgeRegistry();
    registry.add('claude', 'Decision', {
      fieldName: 'establishesConcept',
      targetNs: 'claude',
      targetType: 'Concept'
    });
    const resolve = makeExpansionResolver(registry, null, DEFAULT_CFG);
    const out = await resolve([
      {
        namespace: 'claude',
        type: 'Decision',
        id: 'dec-1',
        row: { id: 'dec-1', establishesConcept: 'concept-fwd' }
      }
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: 'concept-fwd', seedId: 'dec-1' });
  });

  it('marks allowsCrossType=true on backward neighbours from opt-in cross-type edges', async () => {
    const registry = new SpreadEdgeRegistry();
    registry.add('claude', 'Decision', {
      fieldName: 'establishesConcept',
      targetNs: 'claude',
      targetType: 'Concept',
      expandCrossType: true
    });
    const edges = makeEdgesStub({
      'claude/Concept/concept-1': [
        makeEdge(
          { ns: 'claude', type: 'Decision', id: 'dec-99' },
          { ns: 'claude', type: 'Concept', id: 'concept-1' },
          'establishesConcept'
        )
      ]
    });
    const resolve = makeExpansionResolver(registry, edges, DEFAULT_CFG);
    const out = await resolve([
      { namespace: 'claude', type: 'Concept', id: 'concept-1', row: { id: 'concept-1' } }
    ]);
    expect(out).toEqual([
      {
        namespace: 'claude',
        type: 'Decision',
        id: 'dec-99',
        seedId: 'concept-1',
        allowsCrossType: true
      }
    ]);
  });

  it('forward walks NEVER set allowsCrossType even when edge has expandCrossType=true', async () => {
    const registry = new SpreadEdgeRegistry();
    registry.add('claude', 'Decision', {
      fieldName: 'establishesConcept',
      targetNs: 'claude',
      targetType: 'Concept',
      expandCrossType: true
    });
    const resolve = makeExpansionResolver(registry, null, DEFAULT_CFG);
    const out = await resolve([
      {
        namespace: 'claude',
        type: 'Decision',
        id: 'dec-1',
        row: { id: 'dec-1', establishesConcept: 'concept-fwd' }
      }
    ]);
    expect(out).toEqual([
      {
        namespace: 'claude',
        type: 'Concept',
        id: 'concept-fwd',
        seedId: 'dec-1',
        allowsCrossType: false
      }
    ]);
  });

  it('skips inbound edges from rows already in the seed set', async () => {
    const registry = new SpreadEdgeRegistry();
    registry.add('claude', 'Decision', {
      fieldName: 'establishesConcept',
      targetNs: 'claude',
      targetType: 'Concept'
    });
    const edges = makeEdgesStub({
      'claude/Concept/concept-1': [
        makeEdge(
          { ns: 'claude', type: 'Decision', id: 'dec-self' },
          { ns: 'claude', type: 'Concept', id: 'concept-1' },
          'establishesConcept'
        )
      ]
    });
    const resolve = makeExpansionResolver(registry, edges, DEFAULT_CFG);
    const out = await resolve([
      // Both the Concept (target of backward walk) AND the Decision
      // (source of the inbound edge) are seeds. Backward must skip dec-self.
      { namespace: 'claude', type: 'Concept', id: 'concept-1', row: { id: 'concept-1' } },
      { namespace: 'claude', type: 'Decision', id: 'dec-self', row: { id: 'dec-self' } }
    ]);
    expect(out).toEqual([]);
  });
});

describe('ExpansionResolver — caps', () => {
  it('honours maxNeighboursPerSeed on forward', async () => {
    const registry = new SpreadEdgeRegistry();
    // Register two opt-in fields so one seed yields two neighbours.
    registry.add('claude', 'Decision', {
      fieldName: 'establishesConcept',
      targetNs: 'claude',
      targetType: 'Concept'
    });
    registry.add('claude', 'Decision', {
      fieldName: 'supersedes',
      targetNs: 'claude',
      targetType: 'Decision'
    });
    const resolve = makeExpansionResolver(registry, null, {
      maxNeighboursPerSeed: 1,
      maxTotalNeighbours: 50
    });
    const out = await resolve([
      {
        namespace: 'claude',
        type: 'Decision',
        id: 'dec-1',
        row: { id: 'dec-1', establishesConcept: 'c-1', supersedes: 'dec-prev' }
      }
    ]);
    expect(out).toHaveLength(1);
  });

  it('honours maxTotalNeighbours across seeds', async () => {
    const registry = new SpreadEdgeRegistry();
    registry.add('claude', 'Decision', {
      fieldName: 'establishesConcept',
      targetNs: 'claude',
      targetType: 'Concept'
    });
    const resolve = makeExpansionResolver(registry, null, {
      maxNeighboursPerSeed: 8,
      maxTotalNeighbours: 2
    });
    const out = await resolve([
      {
        namespace: 'claude',
        type: 'Decision',
        id: 'dec-1',
        row: { id: 'dec-1', establishesConcept: 'c-1' }
      },
      {
        namespace: 'claude',
        type: 'Decision',
        id: 'dec-2',
        row: { id: 'dec-2', establishesConcept: 'c-2' }
      },
      {
        namespace: 'claude',
        type: 'Decision',
        id: 'dec-3',
        row: { id: 'dec-3', establishesConcept: 'c-3' }
      }
    ]);
    expect(out).toHaveLength(2);
    expect(out.map((n) => n.id)).toEqual(['c-1', 'c-2']);
  });
});
