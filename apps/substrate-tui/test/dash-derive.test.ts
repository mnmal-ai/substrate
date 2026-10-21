import type { ResolverStat, RuntimeMetrics } from '@mnmal-ai/substrate/sdk';
import { describe, expect, it } from 'vitest';
import {
  classify,
  delta,
  HISTORY,
  initialDash,
  latencyTone,
  MAX_KEYS,
  push,
  type Sample,
  sortKeys,
  step
} from '../src/dash/derive.js';

const stat = (p99Ms: number, calls: number, errors: number, lastAt = '2026-10-05T00:00:00Z') =>
  ({ kind: 'query', calls, errors, p50Ms: 1, p99Ms, maxMs: p99Ms, lastAt }) as ResolverStat;

function metrics(q: number, m: number, qe = 0, me = 0, events: Record<string, number> = {}) {
  const op = (total: number, error: number) => ({
    total,
    ok: total - error,
    error,
    durationMsSum: 0,
    durationMsMax: 0
  });
  return {
    since: 'x',
    requests: { query: op(q, qe), mutate: op(m, me) },
    subscriptions: { active: 0 },
    events,
    resolvers: { 'journal/Todo': stat(12, q, qe) }
  } as RuntimeMetrics;
}
const sample = (m: RuntimeMetrics, over: Partial<Sample> = {}): Sample => ({
  health: { ok: true, value: { version: '7.4.0', uptimeSeconds: 5 } },
  metrics: { ok: true, value: m },
  embed: { ok: true, value: { enabled: true, failures: 0 } },
  errors: { ok: true, value: { since: 'x', errors: [] } },
  ...over
});

describe('dash derive', () => {
  it('delta clamps a counter reset to 0 and is 0 without a baseline', () => {
    expect(delta(10, 4)).toBe(0);
    expect(delta(4, 10)).toBe(6);
    expect(delta(undefined, 10)).toBe(0);
  });
  it('push keeps the last HISTORY values', () => {
    let h: number[] = [];
    for (let i = 0; i < 40; i++) h = push(h, i);
    expect(HISTORY).toBe(30);
    expect(h).toHaveLength(30);
    expect(h[0]).toBe(10);
    expect(h[29]).toBe(39);
  });
  it('latencyTone boundaries', () => {
    expect(latencyTone(19)).toBe('ok');
    expect(latencyTone(20)).toBe('warn');
    expect(latencyTone(99)).toBe('warn');
    expect(latencyTone(100)).toBe('error');
  });
  it('sortKeys orders by each mode, ties by key name', () => {
    const r = {
      'b/B': stat(50, 10, 1),
      'a/A': stat(50, 30, 0),
      'c/C': stat(5, 30, 3)
    };
    expect(sortKeys(r, 'p99').map(([k]) => k)).toEqual(['a/A', 'b/B', 'c/C']);
    expect(sortKeys(r, 'calls').map(([k]) => k)).toEqual(['a/A', 'c/C', 'b/B']);
    expect(sortKeys(r, 'errors').map(([k]) => k)).toEqual(['c/C', 'b/B', 'a/A']);
  });
  it('step over three samples computes per-second rates from total deltas', () => {
    let s = initialDash();
    s = step(s, sample(metrics(100, 10)), 0);
    expect(s.hist.queryRate).toEqual([]);
    s = step(s, sample(metrics(150, 20, 2, 0, { engine_policy_denied: 1 })), 5000);
    s = step(s, sample(metrics(250, 20, 2, 1, { engine_policy_denied: 4 })), 10_000);
    expect(s.hist.queryRate).toEqual([10, 20]);
    expect(s.hist.mutateRate).toEqual([2, 0]);
    expect(s.hist.queryErr).toEqual([2, 0]);
    expect(s.hist.mutateErr).toEqual([0, 1]);
    expect(s.hist.denials).toEqual([1, 3]);
    expect(s.eventDelta).toEqual({ engine_policy_denied: 3 });
    expect(s.hist.p99.get('journal/Todo')).toEqual([12, 12, 12]);
    expect(s.lastAt).toBe(10_000);
  });
  it('rates divide by the gap between metrics samples, not by when the poll settled', () => {
    let s = initialDash();
    s = step(s, { ...sample(metrics(100, 10)), metricsAt: 0 }, 0);
    // A slow sibling held this poll for 4 s past the metrics answer.
    s = step(s, { ...sample(metrics(150, 10)), metricsAt: 5000 }, 9000);
    expect(s.hist.queryRate).toEqual([10]);
  });
  it('a sample under MIN_RATE_INTERVAL_MS after the last adds no point and keeps the baseline', () => {
    let s = initialDash();
    s = step(s, { ...sample(metrics(100, 10)), metricsAt: 0 }, 0);
    s = step(s, { ...sample(metrics(150, 10)), metricsAt: 5000 }, 5000);
    s = step(s, { ...sample(metrics(170, 10)), metricsAt: 5100 }, 5100);
    expect(s.hist.queryRate).toEqual([10]);
    expect(s.prevTotals?.at).toBe(5000);
    expect(s.metrics?.ok && s.metrics.value.requests.query.total).toBe(170);
    s = step(s, { ...sample(metrics(200, 10)), metricsAt: 10_000 }, 10_000);
    expect(s.hist.queryRate).toEqual([10, 10]);
    // A clock that steps backwards is the same: no point.
    s = step(s, { ...sample(metrics(300, 10)), metricsAt: 4000 }, 4000);
    expect(s.hist.queryRate).toEqual([10, 10]);
  });
  it('keyErrRose names only keys whose error count rose', () => {
    const withErr = (e: number) => ({
      ...metrics(1, 1),
      resolvers: { 'a/A': stat(1, 1, e), 'b/B': stat(1, 1, 2) }
    });
    let s = step(initialDash(), sample(withErr(0)), 0);
    s = step(s, sample(withErr(3)), 5000);
    expect([...s.keyErrRose]).toEqual(['a/A']);
    s = step(s, sample(withErr(3)), 10_000);
    expect(s.keyErrRose.size).toBe(0);
  });
  it('a restart (totals drop) gives rate 0 and keeps the histories', () => {
    let s = initialDash();
    s = step(s, sample(metrics(100, 10)), 0);
    s = step(s, sample(metrics(200, 20)), 1000);
    s = step(s, sample(metrics(3, 1)), 2000);
    expect(s.hist.queryRate).toEqual([100, 0]);
    expect(s.hist.mutateRate).toEqual([10, 0]);
    s = step(s, sample(metrics(13, 1)), 3000);
    expect(s.hist.queryRate).toEqual([100, 0, 10]);
  });
  it('a failed metrics poll records why and leaves the histories alone', () => {
    let s = initialDash();
    s = step(s, sample(metrics(100, 10)), 0);
    s = step(s, sample(metrics(0, 0), { metrics: { ok: false, why: 'down' } }), 1000);
    expect(s.metrics).toEqual({ ok: false, why: 'down' });
    expect(s.hist.queryRate).toEqual([]);
    expect(s.prevTotals?.query).toBe(100);
  });
  it('a 403 on errors gives { ok: false, why: admin }', () => {
    expect(classify({ status: 401 })).toBe('auth');
    expect(classify({ status: 403 })).toBe('admin');
    expect(classify({ status: 404 })).toBe('absent');
    expect(classify({ status: 500 })).toBe('down');
    expect(classify(new Error('timeout'))).toBe('down');
    const s = step(
      initialDash(),
      sample(metrics(1, 1), { errors: { ok: false, why: classify({ status: 403 }) } }),
      0
    );
    expect(s.errors).toEqual({ ok: false, why: 'admin' });
  });
  it('per-key p99 keeps the 50 most recently seen keys', () => {
    const many = (n: number, prefix: string, at: string) =>
      Object.fromEntries(
        Array.from({ length: n }, (_, i) => [`${prefix}/${i}`, stat(i, 1, 0, at)])
      );
    const m1 = { ...metrics(1, 1), resolvers: many(40, 'old', '2026-01-01T00:00:00Z') };
    const m2 = { ...metrics(2, 1), resolvers: many(20, 'new', '2026-02-01T00:00:00Z') };
    let s = step(initialDash(), sample(m1), 0);
    s = step(s, sample(m2), 1000);
    expect(s.hist.p99.size).toBe(MAX_KEYS);
    const keys = [...s.hist.p99.keys()];
    expect(keys.slice(0, 20).every((k) => k.startsWith('new/'))).toBe(true);
    expect(keys.filter((k) => k.startsWith('old/'))).toHaveLength(30);
  });
  it("a server-sent '__proto__' event stays data", () => {
    const m = metrics(1, 1, 0, 0, JSON.parse('{"__proto__": 3}'));
    let s = step(initialDash(), sample(m), 0);
    s = step(s, sample(metrics(2, 1, 0, 0, JSON.parse('{"__proto__": 5}'))), 1000);
    expect(Object.hasOwn(s.eventDelta, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(s.eventDelta)).toBe(Object.prototype);
  });
});
