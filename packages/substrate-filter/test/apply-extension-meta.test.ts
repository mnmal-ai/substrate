/**
 * Post-read application of extension-operator meta.
 *
 * `applyExtensionResultMeta` re-imposes relevance order on the structurally-
 * filtered page (when no explicit orderBy) and stitches `_score` / `_vector`
 * onto shallow row copies when the projection requests them.
 */

import type { Row } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { applyExtensionResultMeta, type ExtensionOpResultMeta } from '../src/index.js';

function row(id: string, extra: Record<string, unknown> = {}): Row {
  return { id, ...extra };
}

function meta(
  orderedIds: string[],
  computed: Array<[string, { score: number; vector?: number[] }]> = []
): ExtensionOpResultMeta {
  return { orderedIds, computed: new Map(computed) };
}

describe('applyExtensionResultMeta', () => {
  it('reorders rows to hit order when no explicit orderBy', () => {
    const rows = [row('a'), row('b'), row('c')];
    const result = applyExtensionResultMeta(rows, meta(['c', 'a', 'b']), {
      hasExplicitOrderBy: false,
      fields: undefined
    });
    expect(result.map((r) => r.id)).toEqual(['c', 'a', 'b']);
  });

  it('keeps dataset order when an explicit orderBy is present', () => {
    const rows = [row('a'), row('b'), row('c')];
    const result = applyExtensionResultMeta(rows, meta(['c', 'a', 'b']), {
      hasExplicitOrderBy: true,
      fields: undefined
    });
    expect(result.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('appends rows not in the hit list after, in dataset order', () => {
    // d + e matched structurally (e.g. via an OR branch) but are not hits.
    const rows = [row('a'), row('d'), row('b'), row('e'), row('c')];
    const result = applyExtensionResultMeta(rows, meta(['c', 'a', 'b']), {
      hasExplicitOrderBy: false,
      fields: undefined
    });
    expect(result.map((r) => r.id)).toEqual(['c', 'a', 'b', 'd', 'e']);
  });

  it('ranks duplicate orderedIds by first occurrence', () => {
    const rows = [row('a'), row('b')];
    // 'b' appears twice; first-occurrence rank (1) wins over the later one (2).
    const result = applyExtensionResultMeta(rows, meta(['b', 'a', 'b']), {
      hasExplicitOrderBy: false,
      fields: undefined
    });
    expect(result.map((r) => r.id)).toEqual(['b', 'a']);
  });

  it('stitches _score and _vector only when projected', () => {
    const rows = [row('a'), row('b')];
    const result = applyExtensionResultMeta(
      rows,
      meta(
        ['a', 'b'],
        [
          ['a', { score: 0.9, vector: [1, 2, 3] }],
          ['b', { score: 0.5, vector: [4, 5, 6] }]
        ]
      ),
      { hasExplicitOrderBy: false, fields: { _score: true, _vector: true } }
    );
    expect(result[0]).toMatchObject({ id: 'a', _score: 0.9, _vector: [1, 2, 3] });
    expect(result[1]).toMatchObject({ id: 'b', _score: 0.5, _vector: [4, 5, 6] });
  });

  it('omits _vector for a hit that has no vector', () => {
    const rows = [row('a')];
    const result = applyExtensionResultMeta(rows, meta(['a'], [['a', { score: 0.9 }]]), {
      hasExplicitOrderBy: false,
      fields: { _score: true, _vector: true }
    });
    expect(result[0]).toMatchObject({ id: 'a', _score: 0.9 });
    expect('_vector' in result[0]!).toBe(false);
  });

  it('does not stitch when fields omit _score / _vector', () => {
    const rows = [row('a')];
    const result = applyExtensionResultMeta(
      rows,
      meta(['a'], [['a', { score: 0.9, vector: [1] }]]),
      { hasExplicitOrderBy: false, fields: { id: true } }
    );
    expect('_score' in result[0]!).toBe(false);
    expect('_vector' in result[0]!).toBe(false);
  });

  it('does not mutate input rows', () => {
    const a = row('a', { title: 'A' });
    const rows = [a];
    const result = applyExtensionResultMeta(
      rows,
      meta(['a'], [['a', { score: 0.9, vector: [1] }]]),
      { hasExplicitOrderBy: false, fields: { _score: true, _vector: true } }
    );
    expect('_score' in a).toBe(false);
    expect('_vector' in a).toBe(false);
    expect(result[0]).not.toBe(a);
  });
});
