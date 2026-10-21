/**
 * Exponential-backoff scheduler for WS reconnect attempts. Doubles the delay
 * each call up to `maxDelayMs`; `jitter` (0..1) adds symmetric noise so a fleet
 * of clients doesn't reconnect in lockstep after an outage.
 */

export interface ReconnectSchedulerOpts {
  baseDelayMs: number;
  maxDelayMs: number;
  /** Fraction 0..1. 0.1 means ±10%. */
  jitter: number;
}

export class ReconnectScheduler {
  readonly #base: number;
  readonly #max: number;
  readonly #jitter: number;
  #attempt = 0;

  constructor(opts: ReconnectSchedulerOpts) {
    this.#base = opts.baseDelayMs;
    this.#max = opts.maxDelayMs;
    this.#jitter = opts.jitter;
  }

  nextDelay(): number {
    const raw = Math.min(this.#base * 2 ** this.#attempt, this.#max);
    this.#attempt += 1;
    if (this.#jitter === 0) return raw;
    const spread = raw * this.#jitter;
    return raw + (Math.random() * 2 - 1) * spread;
  }

  reset(): void {
    this.#attempt = 0;
  }

  /**
   * Resolve after `nextDelay()` ms. Callers must use this serially — the
   * `#attempt` counter is shared across calls, so overlapping `schedule()`
   * invocations will produce incorrect delays. The WS reconnect loop awaits
   * each `schedule()` before firing the next attempt.
   */
  async schedule(): Promise<void> {
    const d = this.nextDelay();
    await new Promise<void>((resolve) => setTimeout(resolve, d));
  }
}
