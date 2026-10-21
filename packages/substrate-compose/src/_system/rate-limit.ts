/**
 * In-process sliding-window rate limiter (spec §5.12).
 *
 * Used to cap anonymous `/substrate/v1/_system/register` traffic per source IP
 * (default 10 requests / 60s). In-process by design: no external store for a
 * rarely-exercised admin surface.
 *
 * Algorithm: per-key array of request timestamps within the window. On each
 * `check(key)` the limiter prunes stamps older than `windowMs`, compares the
 * remaining length against `maxRequests`, and either records the new stamp
 * (allow) or computes `retryAfterMs` from the oldest surviving stamp (deny).
 *
 * A scavenger interval sweeps empty buckets so a one-off burst from an IP
 * doesn't leak memory. The timer is `.unref()`-ed so it never holds the
 * process open; tests that want to clean up deterministically call `dispose()`.
 */

export interface RateLimitResult {
  allowed: boolean;
  /**
   * Milliseconds the caller should wait before retrying. Present (and positive)
   * only when `allowed === false`; `0` on allow.
   */
  retryAfterMs: number;
}

export interface RateLimiter {
  check(key: string): RateLimitResult;
  /** Drop the scavenger interval. Tests call this to let the event loop settle. */
  dispose(): void;
}

export interface CreateRateLimiterOptions {
  maxRequests: number;
  windowMs: number;
  /**
   * Wall-clock source. Tests pass a controlled `() => number`; production uses
   * `Date.now`. Typed as `number` (not `Date`) because every comparison here
   * is milliseconds-since-epoch arithmetic.
   */
  now?: () => number;
}

export function createRateLimiter(opts: CreateRateLimiterOptions): RateLimiter {
  const maxRequests = opts.maxRequests;
  const windowMs = opts.windowMs;
  const now = opts.now ?? ((): number => Date.now());

  if (!Number.isFinite(maxRequests) || maxRequests <= 0) {
    throw new Error(
      `createRateLimiter: maxRequests must be a positive number (got ${maxRequests})`
    );
  }
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new Error(`createRateLimiter: windowMs must be a positive number (got ${windowMs})`);
  }

  const buckets: Map<string, Array<number>> = new Map();

  function prune(stamps: Array<number>, cutoff: number): Array<number> {
    // Stamps are non-decreasing and bounded by `maxRequests`, so a linear scan
    // suffices. Returns the slice from the first in-window stamp.
    let i = 0;
    while (i < stamps.length) {
      const stamp = stamps[i];
      if (stamp === undefined) break;
      if (stamp > cutoff) break;
      i++;
    }
    return i === 0 ? stamps : stamps.slice(i);
  }

  const scavenger = setInterval(() => {
    const cutoff = now() - windowMs;
    for (const [key, stamps] of buckets) {
      const pruned = prune(stamps, cutoff);
      if (pruned.length === 0) {
        buckets.delete(key);
      } else if (pruned !== stamps) {
        buckets.set(key, pruned);
      }
    }
  }, windowMs);
  // Don't pin the event loop — a deployment shutting down should not have to
  // wait for this timer. Tests that want a clean tear-down call `dispose()`.
  scavenger.unref?.();

  return {
    check(key: string): RateLimitResult {
      const t = now();
      const cutoff = t - windowMs;
      const existing = buckets.get(key) ?? [];
      const live = prune(existing, cutoff);
      if (live.length >= maxRequests) {
        // Oldest surviving stamp dictates when the first slot opens up.
        const oldest = live[0];
        const retryAfterMs = oldest !== undefined ? oldest + windowMs - t : windowMs;
        // Persist the pruned list so a later call doesn't re-include expired
        // stamps from the pre-prune snapshot.
        buckets.set(key, live);
        return { allowed: false, retryAfterMs: Math.max(1, retryAfterMs) };
      }
      live.push(t);
      buckets.set(key, live);
      return { allowed: true, retryAfterMs: 0 };
    },

    dispose(): void {
      clearInterval(scavenger);
    }
  };
}
