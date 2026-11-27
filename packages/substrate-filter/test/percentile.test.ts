import { describe, expect, it } from 'vitest';
import { percentileOf } from '../src/percentile.js';

describe('percentileOf', () => {
  it('is null over no values and the value itself over one', () => {
    expect(percentileOf([], 0.5, false)).toBeNull();
    expect(percentileOf([], 0.5, true)).toBeNull();
    expect(percentileOf([7], 0.9, false)).toBe(7);
    expect(percentileOf([7], 0, true)).toBe(7);
  });

  it('interpolates between neighbours by default', () => {
    expect(percentileOf([4, 1, 3, 2], 0.5, false)).toBe(2.5);
    expect(percentileOf([10, 20, 30, 40, 50], 0.9, false)).toBe(46);
    expect(percentileOf([10, 20, 30], 0, false)).toBe(10);
    expect(percentileOf([10, 20, 30], 1, false)).toBe(30);
    expect(percentileOf([-5, 5], 0.25, false)).toBe(-2.5);
  });

  it('returns a value that occurs when nearest', () => {
    expect(percentileOf([4, 1, 3, 2], 0.5, true)).toBe(2);
    expect(percentileOf([10, 20, 30], 0, true)).toBe(10);
    expect(percentileOf([10, 20, 30], 1, true)).toBe(30);
    expect(percentileOf([10, 20, 30], 0.34, true)).toBe(20);
  });

  it('keeps an int64 exact when nearest and interpolates it as a float otherwise', () => {
    expect(percentileOf([9007199254740993n, 1n], 1, true)).toBe(9007199254740993n);
    expect(percentileOf([1n, 2n], 0.5, false)).toBe(1.5);
  });

  it('leaves its input in order', () => {
    const values = [3, 1, 2];
    percentileOf(values, 0.5, false);
    expect(values).toEqual([3, 1, 2]);
  });
});
