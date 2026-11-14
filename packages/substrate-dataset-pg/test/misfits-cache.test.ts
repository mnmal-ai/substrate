/**
 * The misfit count `/health` reads never scans on the request path, and a
 * failing scan cannot turn every probe into another scan (#1898).
 */

import { describe, expect, it } from 'vitest';
import {
  cachedMisfitCount,
  freshMisfitCount,
  MISFIT_COUNT_TTL_MS,
  type MisfitCount
} from '../src/misfits.js';

const ONE: MisfitCount[] = [{ namespace: 'n', type: 'T', field: 'f', count: 1 }];

describe('misfit count cache', () => {
  it('a failing scan, then repeated health reads: one scan per TTL, none awaited', async () => {
    const key = {};
    let scans = 0;
    const failing = () => {
      scans++;
      return Promise.reject(new Error('canceling statement due to statement timeout'));
    };
    const t0 = 1_000;
    expect(cachedMisfitCount(key, failing, t0)).toBeUndefined();
    await Promise.resolve();
    for (let i = 1; i <= 50; i++) {
      expect(cachedMisfitCount(key, failing, t0 + i * 1_000)).toBeUndefined();
      await Promise.resolve();
    }
    expect(scans).toBe(1);
    // Past the back-off, one more.
    cachedMisfitCount(key, failing, t0 + MISFIT_COUNT_TTL_MS);
    cachedMisfitCount(key, failing, t0 + MISFIT_COUNT_TTL_MS + 1);
    expect(scans).toBe(2);
  });

  it('health shows the last finished count; a scan in flight starts no other', async () => {
    const key = {};
    let scans = 0;
    let finish: (v: MisfitCount[]) => void = () => {};
    const slow = () => {
      scans++;
      return new Promise<MisfitCount[]>((r) => (finish = r));
    };
    expect(cachedMisfitCount(key, slow, 0)).toBeUndefined();
    expect(cachedMisfitCount(key, slow, 10)).toBeUndefined();
    expect(scans).toBe(1);
    finish(ONE);
    await Promise.resolve();
    await Promise.resolve();
    expect(cachedMisfitCount(key, slow, 20)).toEqual(ONE);
    // A stale count stays visible while its replacement runs.
    expect(cachedMisfitCount(key, slow, MISFIT_COUNT_TTL_MS)).toEqual(ONE);
    expect(scans).toBe(2);
  });

  it('a superseded scan does not overwrite the newer entry', async () => {
    const key = {};
    let finishOld: (v: MisfitCount[]) => void = () => {};
    cachedMisfitCount(key, () => new Promise((r) => (finishOld = r)), 0);
    await freshMisfitCount(key, () => Promise.resolve([]), 5);
    finishOld(ONE);
    await Promise.resolve();
    await Promise.resolve();
    expect(cachedMisfitCount(key, () => Promise.resolve(ONE), 10)).toEqual([]);
  });
});
