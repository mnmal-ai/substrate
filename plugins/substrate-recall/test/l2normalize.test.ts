import { describe, expect, it } from 'vitest';
import { l2normalize } from '../src/l2normalize.js';

describe('l2normalize', () => {
  it('scales each vector to unit length', () => {
    const [out] = l2normalize([new Float32Array([3, 4])]);
    expect(out?.[0]).toBeCloseTo(0.6, 6);
    expect(out?.[1]).toBeCloseTo(0.8, 6);
  });

  it('leaves an all-zero vector untouched rather than dividing by zero', () => {
    const [out] = l2normalize([new Float32Array([0, 0, 0])]);
    expect(Array.from(out ?? [])).toEqual([0, 0, 0]);
  });

  it('does not mutate its input', () => {
    const input = new Float32Array([3, 4]);
    l2normalize([input]);
    expect(Array.from(input)).toEqual([3, 4]);
  });

  /**
   * The load-bearing test. Accumulating `sum` in f64 over f32 values and
   * re-rounding only on store is the `normalised/f64` regime; accumulating
   * in f32 is a different regime that moves the cluster count. This asserts
   * the f64 accumulation is really happening, by constructing a vector where
   * the two disagree in the last bits.
   *
   * If someone "simplifies" the implementation to operate on pre-cast values,
   * this test is what fails.
   */
  it('accumulates the sum of squares in f64, not f32', () => {
    const v = new Float32Array(4096).fill(Math.fround(1e-4));
    const [out] = l2normalize([v]);

    let f64Sum = 0;
    for (const x of v) f64Sum += x * x;
    const expected = Math.fround(v[0]! / Math.sqrt(f64Sum));

    expect(out?.[0]).toBe(expected);
  });
});
