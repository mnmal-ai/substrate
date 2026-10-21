import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReconnectScheduler } from '../src/reconnect.js';

describe('ReconnectScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('delays grow exponentially, capped at maxDelayMs', () => {
    const s = new ReconnectScheduler({ baseDelayMs: 1000, maxDelayMs: 30000, jitter: 0 });
    expect(s.nextDelay()).toBe(1000);
    expect(s.nextDelay()).toBe(2000);
    expect(s.nextDelay()).toBe(4000);
    expect(s.nextDelay()).toBe(8000);
    expect(s.nextDelay()).toBe(16000);
    expect(s.nextDelay()).toBe(30000); // capped
    expect(s.nextDelay()).toBe(30000); // stays capped
  });

  it('reset() returns to base delay', () => {
    const s = new ReconnectScheduler({ baseDelayMs: 1000, maxDelayMs: 30000, jitter: 0 });
    s.nextDelay();
    s.nextDelay();
    s.nextDelay();
    s.reset();
    expect(s.nextDelay()).toBe(1000);
  });

  it('jitter adds +/- N% noise within bounds', () => {
    const s = new ReconnectScheduler({ baseDelayMs: 1000, maxDelayMs: 30000, jitter: 0.1 });
    const delays: number[] = [];
    for (let i = 0; i < 20; i++) {
      delays.push(s.nextDelay());
      s.reset();
    }
    for (const d of delays) {
      expect(d).toBeGreaterThanOrEqual(900);
      expect(d).toBeLessThanOrEqual(1100);
    }
    // Not all 20 should be identical (jitter should produce variance)
    expect(new Set(delays).size).toBeGreaterThan(1);
  });

  it('schedule() resolves after the computed delay', async () => {
    const s = new ReconnectScheduler({ baseDelayMs: 1000, maxDelayMs: 30000, jitter: 0 });
    let resolved = false;
    const p = s.schedule().then(() => {
      resolved = true;
    });
    vi.advanceTimersByTime(999);
    await Promise.resolve();
    expect(resolved).toBe(false);
    vi.advanceTimersByTime(1);
    await p;
    expect(resolved).toBe(true);
  });
});
