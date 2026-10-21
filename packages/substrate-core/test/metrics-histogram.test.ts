import { describe, expect, it } from 'vitest';
import { LogHistogram } from '../src/metrics/histogram.js';
import { ResolverTable } from '../src/metrics/resolver-table.js';

describe('LogHistogram', () => {
  it('p50/p99 land in the right bucket for a known distribution', () => {
    const h = new LogHistogram();
    for (let i = 0; i < 99; i++) h.observe(10);
    h.observe(1000);
    expect(h.percentile(0.5)).toBeGreaterThanOrEqual(10);
    expect(h.percentile(0.5)).toBeLessThan(15); // one √2 bucket of 10
    expect(h.percentile(0.99)).toBeLessThan(15);
    expect(h.percentile(1)).toBeGreaterThanOrEqual(1000);
    expect(h.max).toBe(1000);
    expect(h.count).toBe(100);
  });
  it('handles zero, sub-0.1ms and huge values without throwing', () => {
    const h = new LogHistogram();
    for (const v of [0, 0.01, 1e9, Number.NaN, -5]) h.observe(v);
    expect(h.count).toBe(3); // NaN and negatives are ignored
    expect(Number.isFinite(h.percentile(0.99))).toBe(true);
  });
  it('an empty histogram reports zeros', () => {
    const h = new LogHistogram();
    expect([h.percentile(0.5), h.max, h.count]).toEqual([0, 0, 0]);
  });
});

describe('ResolverTable', () => {
  const o = (key: string, ms = 5, ok = true) => ({
    key,
    kind: 'query' as const,
    durationMs: ms,
    ok
  });
  it('aggregates calls, errors and latency per key', () => {
    const t = new ResolverTable(512, () => new Date('2026-10-04T00:00:00Z'));
    t.observe(o('tasks/Todo', 4));
    t.observe(o('tasks/Todo', 8, false));
    const s = t.snapshot()['tasks/Todo'];
    expect(s).toMatchObject({
      kind: 'query',
      calls: 2,
      errors: 1,
      maxMs: 8,
      lastAt: '2026-10-04T00:00:00.000Z'
    });
  });
  it('caps keys at the limit, evicting the least recently observed', () => {
    const t = new ResolverTable(3);
    for (const k of ['a', 'b', 'c']) t.observe(o(k));
    t.observe(o('a')); // a is now most recent
    t.observe(o('d')); // evicts b
    expect(Object.keys(t.snapshot()).sort()).toEqual(['a', 'c', 'd']);
  });
  it('10,000 distinct keys stay at the cap', () => {
    const t = new ResolverTable(512);
    for (let i = 0; i < 10_000; i++) t.observe(o(`ns/T${i}`));
    expect(Object.keys(t.snapshot())).toHaveLength(512);
  });
});
