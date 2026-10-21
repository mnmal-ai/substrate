import { describe, expect, it } from 'vitest';
import type { Candidate } from '../src/candidate-selection.js';
import { buildLabel, distinguishingTerms, medoidOf } from '../src/labelling.js';

const make = (id: string, vector: number[], row: Record<string, unknown>): Candidate => ({
  namespace: 'cortext',
  type: 'Decision',
  id,
  vector: new Float32Array(vector),
  row
});

describe('medoidOf', () => {
  it('returns the member nearest the centroid', () => {
    const members = [
      make('far', [0, 1], { title: 'far' }),
      make('near', [0.99, 0.14], { title: 'near' }),
      make('mid', [0.7, 0.7], { title: 'mid' })
    ];
    expect(medoidOf(members, new Float32Array([1, 0]))?.id).toBe('near');
  });

  it('breaks ties on the lexicographically smallest id, so the label is reproducible', () => {
    const members = [make('b', [1, 0], { title: 'b' }), make('a', [1, 0], { title: 'a' })];
    expect(medoidOf(members, new Float32Array([1, 0]))?.id).toBe('a');
  });

  it('returns null for an empty cluster', () => {
    expect(medoidOf([], new Float32Array([1, 0]))).toBeNull();
  });
});

describe('distinguishingTerms', () => {
  it('surfaces terms common in the cluster and rare in the corpus', () => {
    const members = [
      make('m1', [1, 0], { title: 'plugin loader manifest discovery' }),
      make('m2', [1, 0], { title: 'plugin loader tier ordering' }),
      make('m3', [1, 0], { title: 'plugin loader config merge' })
    ];
    const corpus = [
      ...members,
      make('o1', [0, 1], { title: 'recall salience decay' }),
      make('o2', [0, 1], { title: 'recall expansion bounds' }),
      make('o3', [0, 1], { title: 'bridge federation trust' })
    ];
    const terms = distinguishingTerms(members, corpus, 2);
    expect(terms).toEqual(['loader', 'plugin']);
  });

  it('is deterministic — equal scores break on the term, not on input order', () => {
    const a = [make('m1', [1, 0], { title: 'zebra apple' })];
    const corpus = [...a, make('o1', [0, 1], { title: 'unrelated' })];
    expect(distinguishingTerms(a, corpus, 2)).toEqual(['apple', 'zebra']);
  });

  it('ignores short tokens and stopwords', () => {
    const members = [make('m1', [1, 0], { title: 'the of and a plugin' })];
    const corpus = [...members, make('o1', [0, 1], { title: 'nothing here' })];
    expect(distinguishingTerms(members, corpus, 3)).toEqual(['plugin']);
  });

  it('reads every handle field, not just title', () => {
    const members = [
      make('m1', [1, 0], { synopsis: 'federation enrollment token' }),
      make('m2', [1, 0], { description: 'federation enrollment flow' })
    ];
    const corpus = [...members, make('o1', [0, 1], { title: 'unrelated matters' })];
    // Both 'enrollment' and 'federation' score 0.333; tied scores break on term ascending
    expect(distinguishingTerms(members, corpus, 1)).toEqual(['enrollment']);
  });

  it('returns an empty list when no member carries any handle text', () => {
    const members = [make('m1', [1, 0], { body: 'long-form prose is not a handle field' })];
    expect(distinguishingTerms(members, members, 3)).toEqual([]);
  });
});

describe('buildLabel', () => {
  it('joins distinguishing terms with the medoid exemplar', () => {
    const members = [
      make('m1', [1, 0], { title: 'plugin loader manifest discovery' }),
      make('m2', [0.9, 0.1], { title: 'plugin loader tier ordering' })
    ];
    const corpus = [...members, make('o1', [0, 1], { title: 'bridge federation trust' })];
    const label = buildLabel(members, corpus, new Float32Array([1, 0]));
    // Four terms tie at 0.167: discovery, manifest, ordering, tier; discovery sorts first
    expect(label).toBe('loader / plugin / discovery — plugin loader manifest discovery');
  });

  it('falls back to the exemplar alone when no terms distinguish', () => {
    const members = [make('m1', [1, 0], { title: 'solo' })];
    const label = buildLabel(members, members, new Float32Array([1, 0]));
    expect(label).toBe('solo');
  });

  it('is non-empty even for a cluster with no handle text at all', () => {
    const members = [make('m1', [1, 0], { body: 'no handle here' })];
    const label = buildLabel(members, members, new Float32Array([1, 0]));
    expect(label).toBe('cortext/Decision/m1');
  });

  it('bounds the label length', () => {
    const long = 'a'.repeat(500);
    const members = [make('m1', [1, 0], { title: long })];
    expect(buildLabel(members, members, new Float32Array([1, 0])).length).toBeLessThanOrEqual(120);
  });
});
