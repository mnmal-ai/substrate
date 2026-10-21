import { describe, expect, it } from 'vitest';
import type { SubscriptionStatsSnapshot } from '../src/engine/internals.js';
import { createRuntimeStats } from '../src/runtime-stats.js';

describe('createRuntimeStats', () => {
  it('initialises with zeroed ops, zero events, and a since timestamp', () => {
    const stats = createRuntimeStats({
      now: () => new Date('2026-05-29T00:00:00.000Z'),
      activeSubscriptions: () => 0
    });
    const snap = stats.snapshot();
    expect(snap.since).toBe('2026-05-29T00:00:00.000Z');
    expect(snap.requests.query).toEqual({
      total: 0,
      ok: 0,
      error: 0,
      durationMsSum: 0,
      durationMsMax: 0
    });
    expect(snap.requests.mutate.total).toBe(0);
    expect(snap.subscriptions).toEqual({ active: 0 });
    expect(snap.events).toEqual({});
  });

  it('accumulates ok/error counts, summed + max duration per op', () => {
    const stats = createRuntimeStats({ activeSubscriptions: () => 0 });
    stats.recordRequest('query', true, 10);
    stats.recordRequest('query', false, 30);
    stats.recordRequest('mutate', true, 5);
    const snap = stats.snapshot();
    expect(snap.requests.query).toEqual({
      total: 2,
      ok: 1,
      error: 1,
      durationMsSum: 40,
      durationMsMax: 30
    });
    expect(snap.requests.mutate).toEqual({
      total: 1,
      ok: 1,
      error: 0,
      durationMsSum: 5,
      durationMsMax: 5
    });
  });

  it('tallies events lazily by name', () => {
    const stats = createRuntimeStats({ activeSubscriptions: () => 0 });
    stats.recordEvent('engine_policy_denied');
    stats.recordEvent('engine_policy_denied');
    stats.recordEvent('engine_idempotency_hit');
    expect(stats.snapshot().events).toEqual({
      engine_policy_denied: 2,
      engine_idempotency_hit: 1
    });
  });

  it('reads the live subscription gauge through the callback at snapshot time', () => {
    let live = 3;
    const stats = createRuntimeStats({ activeSubscriptions: () => live });
    expect(stats.snapshot().subscriptions.active).toBe(3);
    live = 7;
    expect(stats.snapshot().subscriptions.active).toBe(7);
  });

  it('guards a throwing subscription callback, reporting active: 0', () => {
    const stats = createRuntimeStats({
      activeSubscriptions: () => {
        throw new Error('boom');
      }
    });
    expect(stats.snapshot().subscriptions.active).toBe(0);
  });
});

describe('createRuntimeStats — subscriptionStats superset', () => {
  it('without subscriptionStats dep: snapshot subscriptions has only active (back-compat)', () => {
    const stats = createRuntimeStats({
      activeSubscriptions: () => 5
    });
    const snap = stats.snapshot();
    // active is present
    expect(snap.subscriptions.active).toBe(5);
    // superset fields must NOT be present when dep is absent
    expect((snap.subscriptions as Record<string, unknown>).maxQueueDepth).toBeUndefined();
    expect((snap.subscriptions as Record<string, unknown>).entries).toBeUndefined();
  });

  it('with subscriptionStats dep: snapshot subscriptions includes superset fields', () => {
    const mockStats: SubscriptionStatsSnapshot = {
      count: 2,
      maxQueueDepth: 3,
      entries: [
        { id: 'sub-1', ns: 'default', type: 'Todo', queueLength: 3 },
        { id: 'sub-1', ns: 'other', type: 'Item', queueLength: 0 }
      ]
    };
    const stats = createRuntimeStats({
      activeSubscriptions: () => 2,
      subscriptionStats: () => mockStats
    });
    const snap = stats.snapshot();
    expect(snap.subscriptions.active).toBe(2);
    expect(snap.subscriptions.maxQueueDepth).toBe(3);
    expect(snap.subscriptions.entries).toEqual(mockStats.entries);
  });

  it('guards a throwing subscriptionStats dep: superset fields absent, active is still live', () => {
    const stats = createRuntimeStats({
      activeSubscriptions: () => 1,
      subscriptionStats: () => {
        throw new Error('stats exploded');
      }
    });
    const snap = stats.snapshot();
    expect(snap.subscriptions.active).toBe(1);
    expect((snap.subscriptions as Record<string, unknown>).maxQueueDepth).toBeUndefined();
    expect((snap.subscriptions as Record<string, unknown>).entries).toBeUndefined();
  });
});

describe('runtime stats: resolve observations', () => {
  it('snapshot carries resolvers and a bounded slowest list; errors() a bounded, truncated ring', () => {
    const stats = createRuntimeStats({ activeSubscriptions: () => 0 });
    for (let i = 0; i < 30; i++)
      stats.recordResolve({ key: `ns/T`, kind: 'query', durationMs: i, ok: true });
    // newest first: the last ok observation heads the list until later ones push it down
    for (let i = 0; i < 60; i++) {
      stats.recordResolve({
        key: 'ns/T',
        kind: 'query',
        durationMs: 1,
        ok: false,
        code: 'policy_denied',
        message: `x${'y'.repeat(300)}\n    at stack`
      });
    }
    const snap = stats.snapshot();
    expect(snap.resolvers?.['ns/T']).toMatchObject({ calls: 90, errors: 60 });
    expect(snap.slowest?.length).toBeLessThanOrEqual(10);
    expect(snap.slowest?.[0]?.durationMs).toBe(1); // newest first
    const errs = stats.errors();
    expect(errs.errors).toHaveLength(50);
    expect(errs.errors[0]?.message.length).toBeLessThanOrEqual(200);
    expect(errs.errors[0]?.message).not.toContain('\n    at ');
    expect(errs.errors[0]).toMatchObject({ op: 'query', key: 'ns/T', code: 'policy_denied' });
  });
  it('process stats appear only when a sampler is supplied', () => {
    expect(createRuntimeStats({ activeSubscriptions: () => 0 }).snapshot().process).toBeUndefined();
    const p = {
      rssMB: 1,
      heapUsedMB: 1,
      cpuUserMs: 1,
      cpuSystemMs: 1,
      eventLoopLagP99Ms: 1,
      inFlight: 0
    };
    expect(
      createRuntimeStats({ activeSubscriptions: () => 0, processStats: () => p }).snapshot().process
    ).toEqual(p);
  });
});

describe('runtime stats: hygiene and slowest', () => {
  const mk = () => createRuntimeStats({ activeSubscriptions: () => 0 });
  const bad = (key: string, message: string, code = 'c') => ({
    key,
    kind: 'query' as const,
    durationMs: 1,
    ok: false,
    code,
    message
  });
  it('strips control characters from keys, codes and messages and caps keys at 200', () => {
    const s = mk();
    s.recordResolve(
      bad(`ns/\u001b[31mT${'k'.repeat(400)}`, 'a\u001b]0;pwn\u0007b\u0085c', 'c\u001bd')
    );
    const blob = JSON.stringify([s.snapshot(), s.errors()]);
    expect(blob).not.toContain('\\u001b');
    expect(blob).not.toContain('\\u0007');
    expect(blob).not.toContain('\\u0085');
    const key = Object.keys(s.snapshot().resolvers ?? {})[0] as string;
    expect(key.length).toBeLessThanOrEqual(200);
    expect(s.errors().errors[0]?.code).toBe('cd');
    expect(s.errors().errors[0]?.message).toBe('a]0;pwnbc');
  });
  it('keeps a message containing " at " intact, but only its first line', () => {
    const s = mk();
    s.recordResolve(bad('ns/T', 'failed at step 2\n    at frame (x.js:1)'));
    expect(s.errors().errors[0]?.message).toBe('failed at step 2');
  });
  it('rounds slowest durations to 0.01', () => {
    const s = mk();
    s.recordResolve({ key: 'ns/T', kind: 'query', durationMs: 12.345678, ok: true });
    expect(s.snapshot().slowest?.[0]?.durationMs).toBe(12.35);
  });
  it('slowest is the newest observations above the running p99, not all-time top-10', () => {
    const s = mk();
    const obs = (key: string, durationMs: number) =>
      s.recordResolve({ key, kind: 'query', durationMs, ok: true });
    for (let i = 0; i < 10; i++) obs('ns/Spike', 500);
    for (let i = 0; i < 2000; i++) obs('ns/Fast', 1);
    obs('ns/New1', 100);
    obs('ns/New2', 120);
    obs('ns/New3', 110);
    const keys = (s.snapshot().slowest ?? []).map((x) => x.key);
    expect(keys.slice(0, 3)).toEqual(['ns/New3', 'ns/New2', 'ns/New1']);
    expect(keys).not.toContain('ns/Spike');
    expect(keys.length).toBeLessThanOrEqual(10);
  });
  it('every observation is eligible until 100 have been seen, newest first', () => {
    const s = mk();
    for (let i = 0; i < 12; i++)
      s.recordResolve({ key: `ns/K${i}`, kind: 'query', durationMs: 12 - i, ok: true });
    const keys = (s.snapshot().slowest ?? []).map((x) => x.key);
    expect(keys).toEqual([
      'ns/K11',
      'ns/K10',
      'ns/K9',
      'ns/K8',
      'ns/K7',
      'ns/K6',
      'ns/K5',
      'ns/K4',
      'ns/K3',
      'ns/K2'
    ]);
  });

  it('slowest keeps tracking recent observations under steady latency', () => {
    let t = 0;
    const s = createRuntimeStats({
      activeSubscriptions: () => 0,
      now: () => new Date(1_000_000 + t++)
    });
    const obs = (ms: number) =>
      s.recordResolve({ key: 'ns/T', kind: 'query', durationMs: ms, ok: true });
    for (let i = 0; i < 99; i++) obs(1 + (i % 5));
    obs(6);
    for (let i = 0; i < 3000; i++) obs(i % 7 === 0 ? 1 : 5);
    const cutoff = new Date(1_000_000 + 1000).toISOString();
    const recent = (s.snapshot().slowest ?? []).filter((x) => x.at > cutoff);
    expect(recent.length).toBeGreaterThanOrEqual(5);
  });
  it('merges consecutive (unknown) errors with the same code and keeps them out of slowest', () => {
    const s = mk();
    for (let i = 0; i < 5; i++) s.recordResolve(bad('ns/Real', `r${i}`));
    for (let i = 0; i < 7; i++) s.recordResolve(bad('(unknown)', `u${i}`, 'unknown_namespace'));
    const errs = s.errors().errors;
    expect(errs).toHaveLength(6);
    expect(errs[0]).toMatchObject({ key: '(unknown)', count: 7, code: 'unknown_namespace' });
    expect(s.snapshot().slowest?.some((x) => x.key === '(unknown)')).toBe(false);
  });
  it('records the caller on each error, anonymous when the observation names none', () => {
    const s = mk();
    s.recordResolve({ ...bad('ns/A', 'm'), caller: 'labs-claude@host' });
    s.recordResolve(bad('ns/B', 'm'));
    const [b, a] = s.errors().errors;
    expect(a?.caller).toBe('labs-claude@host');
    expect(b?.caller).toBe('anonymous');
  });
  it('strips control characters from the caller', () => {
    const s = mk();
    s.recordResolve({ ...bad('ns/A', 'm'), caller: 'kid\x1b[2J@host' });
    expect(s.errors().errors[0]?.caller).toBe('kid[2J@host');
  });
  it('does not merge (unknown) errors from different callers', () => {
    const s = mk();
    s.recordResolve({ ...bad('(unknown)', 'u', 'unknown_namespace'), caller: 'a@h' });
    s.recordResolve({ ...bad('(unknown)', 'u', 'unknown_namespace'), caller: 'a@h' });
    s.recordResolve({ ...bad('(unknown)', 'u', 'unknown_namespace'), caller: 'b@h' });
    const errs = s.errors().errors;
    expect(errs).toHaveLength(2);
    expect(errs[0]).toMatchObject({ caller: 'b@h' });
    expect(errs[1]).toMatchObject({ caller: 'a@h', count: 2 });
  });
});
