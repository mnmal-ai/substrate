import { describe, expect, it } from 'vitest';
import { ReconnectScheduler } from '../src/reconnect.js';

describe('ReconnectScheduler', () => {
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
});
