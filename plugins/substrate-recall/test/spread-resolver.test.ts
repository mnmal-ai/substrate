/**
 * SpreadResolver tests.
 *
 * Covers the forward + backward + opt-in + dedup paths in isolation. Uses
 * a stub EdgesStore that returns canned inbound edges per ref — the real
 * EdgesStore SQL is exercised by substrate-dataset-pg's own test suite.
 */

import type { Edge, EdgeRef, EdgesStore } from '@mnmal-ai/substrate-types';
import { describe, expect, it, vi } from 'vitest';
import { makeSpreadResolver, SpreadEdgeRegistry } from '../src/spread-resolver.js';

function makeEdge(
  from: EdgeRef,
  to: EdgeRef,
  fieldName: string,
  overrides: Partial<Edge> = {}
): Edge {
  return {
    id: `edge-${from.id}-${fieldName}-${to.id}`,
    from,
    to,
    fieldName,
    policy: 'set_null',
    createdAt: new Date(),
    ...overrides
  };
}

function makeEdgesStub(inboundByRef: Record<string, Edge[]>): EdgesStore {
  const key = (r: EdgeRef): string => `${r.ns}/${r.type}/${r.id}`;
  return {
    txScopeId: 'stub-edges',
    write: async () => {
      throw new Error('not implemented in stub');
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

describe('SpreadEdgeRegistry', () => {
  it('add() is idempotent on (ns, type, fieldName)', () => {
    const r = new SpreadEdgeRegistry();
    r.add('claude', 'Decision', {
      fieldName: 'establishesConcept',
      targetNs: 'claude',
      targetType: 'Concept'
    });
    r.add('claude', 'Decision', {
      fieldName: 'establishesConcept',
      targetNs: 'claude',
      targetType: 'Concept'
    });
    expect(r.size()).toBe(1);
    expect(r.forType('claude', 'Decision')).toHaveLength(1);
  });

  it('isolates entries per (ns, type)', () => {
    const r = new SpreadEdgeRegistry();
    r.add('claude', 'Decision', {
      fieldName: 'establishesConcept',
      targetNs: 'claude',
      targetType: 'Concept'
    });
    r.add('claude', 'AgentRule', {
      fieldName: 'expressesConcept',
      targetNs: 'claude',
      targetType: 'Concept'
    });
    expect(r.size()).toBe(2);
    expect(r.forType('claude', 'Decision')).toHaveLength(1);
    expect(r.forType('claude', 'AgentRule')).toHaveLength(1);
    expect(r.forType('claude', 'NotRegistered')).toHaveLength(0);
  });
});

describe('makeSpreadResolver forward direction', () => {
  it('emits a target per opt-in crossRef field value on each source row', async () => {
    const registry = new SpreadEdgeRegistry();
    registry.add('claude', 'Decision', {
      fieldName: 'establishesConcept',
      targetNs: 'claude',
      targetType: 'Concept'
    });
    const resolver = makeSpreadResolver(registry, makeEdgesStub({}));

    const targets = await resolver([
      {
        namespace: 'claude',
        type: 'Decision',
        id: 'd1',
        row: { id: 'd1', establishesConcept: 'c1' }
      },
      {
        namespace: 'claude',
        type: 'Decision',
        id: 'd2',
        row: { id: 'd2', establishesConcept: 'c2' }
      }
    ]);

    expect(targets).toEqual([
      { namespace: 'claude', type: 'Concept', id: 'c1' },
      { namespace: 'claude', type: 'Concept', id: 'c2' }
    ]);
  });

  it('skips fields with non-string or empty values', async () => {
    const registry = new SpreadEdgeRegistry();
    registry.add('claude', 'Decision', {
      fieldName: 'establishesConcept',
      targetNs: 'claude',
      targetType: 'Concept'
    });
    const resolver = makeSpreadResolver(registry, makeEdgesStub({}));

    const targets = await resolver([
      {
        namespace: 'claude',
        type: 'Decision',
        id: 'd1',
        row: { id: 'd1', establishesConcept: null }
      },
      {
        namespace: 'claude',
        type: 'Decision',
        id: 'd2',
        row: { id: 'd2', establishesConcept: '' }
      },
      {
        namespace: 'claude',
        type: 'Decision',
        id: 'd3',
        row: { id: 'd3' /* establishesConcept absent */ }
      }
    ]);
    expect(targets).toEqual([]);
  });

  it('omits non-opt-in crossRef fields even when present in the row body', async () => {
    const registry = new SpreadEdgeRegistry();
    // Only establishesConcept opts in; sessionId does not.
    registry.add('claude', 'Decision', {
      fieldName: 'establishesConcept',
      targetNs: 'claude',
      targetType: 'Concept'
    });
    const resolver = makeSpreadResolver(registry, makeEdgesStub({}));

    const targets = await resolver([
      {
        namespace: 'claude',
        type: 'Decision',
        id: 'd1',
        row: { id: 'd1', establishesConcept: 'c1', sessionId: 's1' }
      }
    ]);
    expect(targets).toEqual([{ namespace: 'claude', type: 'Concept', id: 'c1' }]);
  });
});

describe('makeSpreadResolver backward direction', () => {
  it('emits a target per opt-in inbound edge', async () => {
    const registry = new SpreadEdgeRegistry();
    // Decision.establishesConcept → Concept means inbound edges on a Concept
    // whose from-type is Decision with that field name are opt-in.
    registry.add('claude', 'Decision', {
      fieldName: 'establishesConcept',
      targetNs: 'claude',
      targetType: 'Concept'
    });
    const edges = makeEdgesStub({
      'claude/Concept/c1': [
        makeEdge(
          { ns: 'claude', type: 'Decision', id: 'd-a' },
          { ns: 'claude', type: 'Concept', id: 'c1' },
          'establishesConcept'
        ),
        makeEdge(
          { ns: 'claude', type: 'Decision', id: 'd-b' },
          { ns: 'claude', type: 'Concept', id: 'c1' },
          'establishesConcept'
        )
      ]
    });
    const resolver = makeSpreadResolver(registry, edges);

    const targets = await resolver([
      { namespace: 'claude', type: 'Concept', id: 'c1', row: { id: 'c1' } }
    ]);
    expect(targets).toEqual(
      expect.arrayContaining([
        { namespace: 'claude', type: 'Decision', id: 'd-a' },
        { namespace: 'claude', type: 'Decision', id: 'd-b' }
      ])
    );
    expect(targets).toHaveLength(2);
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
    const resolver = makeSpreadResolver(registry, edges);

    const targets = await resolver([
      { namespace: 'claude', type: 'Concept', id: 'c1', row: { id: 'c1' } },
      { namespace: 'claude', type: 'Concept', id: 'c2', row: { id: 'c2' } },
      { namespace: 'claude', type: 'Concept', id: 'c3', row: { id: 'c3' } }
    ]);

    // ONE round-trip regardless of seed count; the per-seed findEdgesTo is unused.
    expect(toManySpy).toHaveBeenCalledTimes(1);
    expect(toSpy).not.toHaveBeenCalled();
    expect(targets).toEqual(
      expect.arrayContaining([
        { namespace: 'claude', type: 'Decision', id: 'd-a' },
        { namespace: 'claude', type: 'Decision', id: 'd-b' }
      ])
    );
  });

  it('filters inbound edges whose from-type field is NOT opt-in', async () => {
    const registry = new SpreadEdgeRegistry();
    // Only establishesConcept is opt-in. sessionId edges into Concept (or
    // wherever) MUST be ignored.
    registry.add('claude', 'Decision', {
      fieldName: 'establishesConcept',
      targetNs: 'claude',
      targetType: 'Concept'
    });
    const edges = makeEdgesStub({
      'claude/Concept/c1': [
        makeEdge(
          { ns: 'claude', type: 'Decision', id: 'd-establishes' },
          { ns: 'claude', type: 'Concept', id: 'c1' },
          'establishesConcept'
        ),
        makeEdge(
          { ns: 'claude', type: 'Decision', id: 'd-sessionId' },
          { ns: 'claude', type: 'Concept', id: 'c1' },
          'sessionId' // not opt-in
        )
      ]
    });
    const resolver = makeSpreadResolver(registry, edges);

    const targets = await resolver([
      { namespace: 'claude', type: 'Concept', id: 'c1', row: { id: 'c1' } }
    ]);
    expect(targets).toEqual([{ namespace: 'claude', type: 'Decision', id: 'd-establishes' }]);
  });

  it('no-ops cleanly when edges store is null (memory deployments)', async () => {
    const registry = new SpreadEdgeRegistry();
    registry.add('claude', 'Decision', {
      fieldName: 'establishesConcept',
      targetNs: 'claude',
      targetType: 'Concept'
    });
    const resolver = makeSpreadResolver(registry, null);
    // Forward still works (reads row.field directly). Backward is skipped.
    const targets = await resolver([
      {
        namespace: 'claude',
        type: 'Decision',
        id: 'd1',
        row: { id: 'd1', establishesConcept: 'c1' }
      }
    ]);
    expect(targets).toEqual([{ namespace: 'claude', type: 'Concept', id: 'c1' }]);
  });
});

describe('makeSpreadResolver dedup + self-skip', () => {
  it('dedupes targets across multiple sources', async () => {
    const registry = new SpreadEdgeRegistry();
    registry.add('claude', 'Decision', {
      fieldName: 'establishesConcept',
      targetNs: 'claude',
      targetType: 'Concept'
    });
    const resolver = makeSpreadResolver(registry, makeEdgesStub({}));

    const targets = await resolver([
      {
        namespace: 'claude',
        type: 'Decision',
        id: 'd1',
        row: { id: 'd1', establishesConcept: 'c1' }
      },
      {
        namespace: 'claude',
        type: 'Decision',
        id: 'd2',
        row: { id: 'd2', establishesConcept: 'c1' }
      }
    ]);
    expect(targets).toEqual([{ namespace: 'claude', type: 'Concept', id: 'c1' }]);
  });

  it('skips targets that are themselves in the boosted set (cycle short-circuit)', async () => {
    const registry = new SpreadEdgeRegistry();
    // Decision.supersedes is a self-ref crossRef — Decision → Decision.
    registry.add('claude', 'Decision', {
      fieldName: 'supersedes',
      targetNs: 'claude',
      targetType: 'Decision'
    });
    const resolver = makeSpreadResolver(registry, makeEdgesStub({}));

    // d1 supersedes d2; both are in the boosted source set (both surfaced
    // by recall). Forward from d1 would target d2, but d2 is in sources
    // so it's skipped — would otherwise inflate d2's signal redundantly.
    const targets = await resolver([
      { namespace: 'claude', type: 'Decision', id: 'd1', row: { id: 'd1', supersedes: 'd2' } },
      { namespace: 'claude', type: 'Decision', id: 'd2', row: { id: 'd2' } }
    ]);
    expect(targets).toEqual([]);
  });

  it('returns empty for empty source list', async () => {
    const registry = new SpreadEdgeRegistry();
    registry.add('claude', 'Decision', {
      fieldName: 'establishesConcept',
      targetNs: 'claude',
      targetType: 'Concept'
    });
    const resolver = makeSpreadResolver(registry, makeEdgesStub({}));
    const targets = await resolver([]);
    expect(targets).toEqual([]);
  });
});
