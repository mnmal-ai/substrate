import { describe, expect, it } from 'vitest';
import { armRanks, fuseByRank, RRF_K } from '../src/rrf.js';

describe('fuseByRank', () => {
  /**
   * The case the whole arm exists for, stated as a fusion property: a row the
   * dense arm never returned must be able to reach the result set on the
   * strength of the other arm alone. Union, not intersection — an
   * intersection would make the lexical arm a re-ranker of dense results and
   * it would never surface the row dense missed.
   */
  it('admits a row that only one arm found', () => {
    const fused = fuseByRank([['a', 'b'], ['c']]);
    expect([...fused.keys()].sort()).toEqual(['a', 'b', 'c']);
  });

  /**
   * A row both arms found outranks one only a single arm found, even when the
   * single-arm row is that arm's top hit. This is RRF's whole contribution:
   * agreement between arms beats confidence within one.
   */
  it('ranks a row found by both arms above one found by only one', () => {
    const fused = fuseByRank([
      ['both', 'denseOnly'],
      ['both', 'lexOnly']
    ]);
    const order = [...fused.entries()].sort((x, y) => y[1] - x[1]).map(([id]) => id);
    expect(order[0]).toBe('both');
  });

  /**
   * A missing arm contributes NO TERM rather than a penalty term. A
   * penalty would make an absent arm worse than a bad one, so adding an arm
   * could demote rows it says nothing about.
   */
  it('treats an absent arm as no term, not as a bad rank', () => {
    const withOneArm = fuseByRank([['a']]);
    const withTwoArmsSecondSilent = fuseByRank([['a'], []]);
    expect(withTwoArmsSecondSilent.get('a')).toBe(withOneArm.get('a'));
  });

  it('scores by 1/(K + rank), summed across arms', () => {
    const fused = fuseByRank([['a'], ['a']]);
    expect(fused.get('a')).toBeCloseTo(2 / (RRF_K + 1), 12);
  });

  /**
   * Ranks are 1-based and per-arm. If the second arm's ranks restarted from
   * the first arm's length, a row leading the second arm would score as
   * though it were buried in it.
   */
  it('ranks each arm independently from 1', () => {
    const fused = fuseByRank([['x', 'y', 'z'], ['q']]);
    expect(fused.get('q')).toBeCloseTo(1 / (RRF_K + 1), 12);
  });

  it('ignores duplicate ids within one arm rather than double-counting', () => {
    const fused = fuseByRank([['a', 'a']]);
    expect(fused.get('a')).toBeCloseTo(1 / (RRF_K + 1), 12);
  });

  it('returns an empty map when every arm is empty', () => {
    expect(fuseByRank([[], []]).size).toBe(0);
  });
});

describe('armRanks', () => {
  it('reports 1-based ranks per arm and null for an arm that missed the row', () => {
    expect(armRanks('b', ['a', 'b'], ['b'])).toEqual({ dense: 2, lexical: 1 });
    expect(armRanks('c', ['a', 'b'], ['c'])).toEqual({ dense: null, lexical: 1 });
  });

  it('reports the same rank fuseByRank scored when an arm repeats an id', () => {
    const dense = ['a', 'a', 'b'];
    const lexical = ['x', 'x', 'x', 'b'];
    const fused = fuseByRank([dense, lexical]);
    const ranks = armRanks('b', dense, lexical);
    expect(ranks).toEqual({ dense: 2, lexical: 2 });
    expect(fused.get('b')).toBeCloseTo(
      1 / (RRF_K + (ranks.dense as number)) + 1 / (RRF_K + (ranks.lexical as number)),
      12
    );
  });
});
