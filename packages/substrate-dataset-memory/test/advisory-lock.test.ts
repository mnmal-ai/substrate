import { describe, expect, it } from 'vitest';
import { MemoryDataset } from '../src/index.js';

describe('MemoryDataset.withAdvisoryLock', () => {
  it('serialises holders of one key and frees it after a throw', async () => {
    const ds = new MemoryDataset({ namespace: 'ns' });
    const log: string[] = [];
    let open!: () => void;
    const g = new Promise<void>((resolve) => {
      open = resolve;
    });
    const first = ds.withAdvisoryLock('k', async () => {
      log.push('a:start');
      await g;
      log.push('a:end');
      throw new Error('boom');
    });
    const second = ds.withAdvisoryLock('k', async () => {
      log.push('b:start');
      return 'b';
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(log).toEqual(['a:start']);
    open();
    await expect(first).rejects.toThrow('boom');
    await expect(second).resolves.toBe('b');
    expect(log).toEqual(['a:start', 'a:end', 'b:start']);
  });

  it('does not block a different key', async () => {
    const ds = new MemoryDataset({ namespace: 'ns' });
    let open!: () => void;
    const held = ds.withAdvisoryLock('a', () => new Promise<void>((r) => (open = r)));
    await expect(ds.withAdvisoryLock('b', async () => 'ran')).resolves.toBe('ran');
    open();
    await held;
  });
});
