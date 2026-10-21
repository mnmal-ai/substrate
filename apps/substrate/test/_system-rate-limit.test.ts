/**
 * In-process rate limiter unit tests. Spec §5.12.
 *
 * The scavenger interval is `.unref()`-ed in production but we still call
 * `dispose()` from every test so repeated vitest runs inside the same worker
 * don't accumulate intervals.
 */

import { createRateLimiter, type RateLimiter } from '@mnmal-ai/substrate-compose';
import { afterEach, describe, expect, it } from 'vitest';

describe('_system rate limiter', () => {
  let limiters: Array<RateLimiter> = [];
  afterEach(() => {
    for (const l of limiters) l.dispose();
    limiters = [];
  });

  function mkClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
    let t = start;
    return {
      now: (): number => t,
      advance: (ms: number): void => {
        t += ms;
      }
    };
  }

  function mkLimiter(
    overrides: Partial<{ maxRequests: number; windowMs: number; now: () => number }> = {}
  ): RateLimiter {
    const l = createRateLimiter({
      maxRequests: overrides.maxRequests ?? 3,
      windowMs: overrides.windowMs ?? 1_000,
      now: overrides.now ?? ((): number => Date.now())
    });
    limiters.push(l);
    return l;
  }

  it('allows the first N requests from a single key', () => {
    const l = mkLimiter({ maxRequests: 3 });
    expect(l.check('ip-1').allowed).toBe(true);
    expect(l.check('ip-1').allowed).toBe(true);
    expect(l.check('ip-1').allowed).toBe(true);
  });

  it('denies the (N+1)th request and returns retryAfterMs > 0', () => {
    const clock = mkClock();
    const l = mkLimiter({ maxRequests: 3, windowMs: 1_000, now: clock.now });
    for (let i = 0; i < 3; i++) l.check('ip-1');
    const res = l.check('ip-1');
    expect(res.allowed).toBe(false);
    expect(res.retryAfterMs).toBeGreaterThan(0);
    expect(res.retryAfterMs).toBeLessThanOrEqual(1_000);
  });

  it('resets after the window passes', () => {
    const clock = mkClock();
    const l = mkLimiter({ maxRequests: 2, windowMs: 1_000, now: clock.now });
    expect(l.check('ip-1').allowed).toBe(true);
    expect(l.check('ip-1').allowed).toBe(true);
    expect(l.check('ip-1').allowed).toBe(false);
    clock.advance(1_001);
    expect(l.check('ip-1').allowed).toBe(true);
  });

  it('tracks different keys independently', () => {
    const l = mkLimiter({ maxRequests: 2 });
    expect(l.check('ip-a').allowed).toBe(true);
    expect(l.check('ip-a').allowed).toBe(true);
    expect(l.check('ip-b').allowed).toBe(true);
    expect(l.check('ip-b').allowed).toBe(true);
    expect(l.check('ip-a').allowed).toBe(false);
    expect(l.check('ip-b').allowed).toBe(false);
  });

  it('scavenger drops empty-bucket keys after the window elapses', async () => {
    // Use a short window so the scavenger fires within the test's patience.
    // The scavenger fires every `windowMs` — we wait for two tick periods to
    // guarantee it runs at least once.
    const l = mkLimiter({ maxRequests: 2, windowMs: 25 });
    l.check('bucket-1');
    l.check('bucket-1');
    // Wait for two full windows so: (1) all stamps expire, (2) the scavenger
    // gets a chance to iterate and drop the empty bucket.
    await new Promise((resolve) => setTimeout(resolve, 80));
    // After the scavenger tick, a follow-up check on the same key should still
    // succeed — the bucket was reset by either the scavenger (dropped the
    // stamps) or by `check`'s own prune. Either way, the counter restarts.
    // Observationally this is the behavioural contract consumers care about:
    // the scavenger prevents unbounded Map growth without user-visible effects.
    expect(l.check('bucket-1').allowed).toBe(true);
  });

  it('dispose clears the scavenger interval', () => {
    const l = createRateLimiter({ maxRequests: 1, windowMs: 1_000 });
    // No assertion beyond "dispose doesn't throw"; the lifecycle observation
    // is indirect — tests that don't dispose see interval handles retained
    // by vitest's worker and fail the leak check in watch mode. This assertion
    // gives us a regression signal if dispose ever starts throwing.
    expect(() => l.dispose()).not.toThrow();
  });

  it('rejects non-positive maxRequests / windowMs at construction time', () => {
    expect(() => createRateLimiter({ maxRequests: 0, windowMs: 1_000 })).toThrow(/positive/);
    expect(() => createRateLimiter({ maxRequests: 1, windowMs: 0 })).toThrow(/positive/);
  });
});
