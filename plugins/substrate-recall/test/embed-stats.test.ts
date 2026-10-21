import { describe, expect, it } from 'vitest';
import { createEmbedStats } from '../src/embed-stats.js';

describe('createEmbedStats', () => {
  it('initial snapshot: zeroed counts, null lastFailure, frozen since', () => {
    const stats = createEmbedStats(() => new Date('2026-04-24T00:00:00Z'));
    const snap = stats.snapshot();
    expect(snap.writes).toBe(0);
    expect(snap.successes).toBe(0);
    expect(snap.failures).toBe(0);
    expect(snap.lastFailure).toBe(null);
    expect(snap.since).toBe('2026-04-24T00:00:00.000Z');
  });

  it('recordSuccess increments writes + successes, leaves lastFailure null', () => {
    const stats = createEmbedStats();
    stats.recordSuccess();
    stats.recordSuccess();
    const snap = stats.snapshot();
    expect(snap.writes).toBe(2);
    expect(snap.successes).toBe(2);
    expect(snap.failures).toBe(0);
    expect(snap.lastFailure).toBe(null);
  });

  it('recordFailure increments writes + failures, captures lastFailure', () => {
    let t = 0;
    const stats = createEmbedStats(() => new Date(`2026-04-24T00:00:0${t++}Z`));
    stats.recordFailure('d1', 'ollama down');
    const snap = stats.snapshot();
    expect(snap.writes).toBe(1);
    expect(snap.failures).toBe(1);
    expect(snap.successes).toBe(0);
    expect(snap.lastFailure).toEqual({
      rowId: 'd1',
      error: 'ollama down',
      at: '2026-04-24T00:00:01.000Z'
    });
  });

  it('lastFailure tracks the most recent failure only', () => {
    let t = 0;
    const stats = createEmbedStats(() => new Date(`2026-04-24T00:00:0${t++}Z`));
    stats.recordFailure('d1', 'first error');
    stats.recordFailure('d2', 'second error');
    const snap = stats.snapshot();
    expect(snap.failures).toBe(2);
    expect(snap.lastFailure?.rowId).toBe('d2');
    expect(snap.lastFailure?.error).toBe('second error');
  });

  it('mixed success + failure: counts align, lastFailure survives later successes', () => {
    const stats = createEmbedStats();
    stats.recordSuccess();
    stats.recordFailure('d1', 'boom');
    stats.recordSuccess();
    stats.recordSuccess();
    const snap = stats.snapshot();
    expect(snap.writes).toBe(4);
    expect(snap.successes).toBe(3);
    expect(snap.failures).toBe(1);
    expect(snap.lastFailure?.rowId).toBe('d1');
  });

  it('snapshot returns a fresh object — caller mutation does not affect internal state', () => {
    const stats = createEmbedStats();
    stats.recordSuccess();
    const snap1 = stats.snapshot();
    (snap1 as { writes: number }).writes = 999;
    const snap2 = stats.snapshot();
    expect(snap2.writes).toBe(1);
  });
});
